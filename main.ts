import {
	App,
	FileView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	setIcon,
	TFile,
	WorkspaceLeaf,
	Modal,
} from "obsidian";
import ePub, { Book, Rendition, Contents, EpubCFI } from "epubjs";

// epub.js ships its own .d.ts, but several shapes are mistyped (e.g. `views()`
// is declared `View[]` though it returns a `Views` collection with `.all()`,
// and `Themes` is missing `removeOverride`). These minimal interfaces describe
// the runtime shapes we actually use, so the rest of the code stays type-safe.
interface EpubViewLike {
	section?: { index: number };
	contents?: Contents;
}
interface EpubViewsLike {
	all(): EpubViewLike[];
}
interface EpubThemesExtra {
	removeOverride(name: string): void;
}
// A spine section, enough of it to run epub.js's per-section full-text search
// and the whole-book pagination scan.
interface EpubSectionLike {
	href: string;
	linear?: string;
	load(request: unknown): Promise<unknown>;
	find(query: string): { cfi: string; excerpt: string }[];
	unload(): void;
}

// Interface language. Four supported languages plus "auto" (follow Obsidian's
// own UI language). Traditional Chinese falls back to Simplified and Italian to
// English for any string that doesn't provide a specific translation.
type Lang = "zh" | "en" | "zh-TW" | "it";
const LANG_OPTIONS: { value: string; label: string }[] = [
	{ value: "auto", label: "Auto (跟随系统 / follow system)" },
	{ value: "zh", label: "简体中文" },
	{ value: "zh-TW", label: "繁體中文" },
	{ value: "en", label: "English" },
	{ value: "it", label: "Italiano" },
];

let currentLang: Lang = "en";
// System fonts read once via the Local Font Access API, cached module-wide so
// every (re)built font dropdown can list them without re-querying.
let loadedSystemFonts: string[] = [];
function resolveLang(setting: string): Lang {
	if (setting === "zh" || setting === "en" || setting === "zh-TW" || setting === "it") return setting;
	// "auto": follow Obsidian's own UI language.
	const l = (window.localStorage.getItem("language") ?? "").toLowerCase();
	if (l.startsWith("zh-tw") || l.startsWith("zh-hant") || l === "zh-hk") return "zh-TW";
	if (l.startsWith("zh")) return "zh";
	if (l.startsWith("it")) return "it";
	return "en";
}
function tr(zh: string, en: string, tw?: string, it?: string): string {
	switch (currentLang) {
		case "zh":
			return zh;
		case "zh-TW":
			return tw ?? zh;
		case "it":
			return it ?? en;
		default:
			return en;
	}
}

const VIEW_TYPE_EPUB = "epub-reader-view";

interface Highlight {
	id: string;
	cfiRange: string;
	text: string;
	color: string;
	note: string;
	created: number;
}

interface BookRecord {
	highlights: Highlight[];
	// Cached whole-book pre-pagination: the start CFI of every visual page,
	// pages per spine section, and the layout key ("WxH|size|font") it was
	// built for, so reopening at the same layout skips the offscreen scan.
	visualCfis?: string[];
	visualCounts?: number[];
	visualKey?: string;
	// Last reading position, so reopening the book (even after an Obsidian
	// restart) returns to the same passage. CFI-based → survives layout changes.
	lastCfi?: string;
}

// Global reading preferences, remembered across books and sessions.
interface ReadingPrefs {
	language: string;
	bgTheme: string;
	customColor: string;
	fontFamily: string;
	fontSize: number;
	// Default highlight color ("" = first preset; set after HIGHLIGHT_COLORS
	// exists, which is declared below DEFAULT_DATA).
	highlightColor: string;
}

interface PluginData {
	books: Record<string, BookRecord>;
	prefs: ReadingPrefs;
	// Whether the first-run icon guide has been shown (once ever).
	seenGuide?: boolean;
}

const DEFAULT_DATA: PluginData = {
	books: {},
	prefs: { language: "auto", bgTheme: "gray", customColor: "#ffffff", fontFamily: "", fontSize: 20, highlightColor: "" },
	seenGuide: false,
};

// Highlight colors, alpha ~0.55 for a soft marker look.
const HIGHLIGHT_COLORS: { name: string; en: string; tw: string; it: string; value: string }[] = [
	{ name: "青", en: "Cyan", tw: "青", it: "Ciano", value: "rgba(184, 245, 245, 0.55)" },
	{ name: "橙", en: "Orange", tw: "橙", it: "Arancione", value: "rgba(255, 169, 77, 0.55)" },
	{ name: "蓝", en: "Blue", tw: "藍", it: "Blu", value: "rgba(168, 216, 245, 0.55)" },
	{ name: "粉", en: "Pink", tw: "粉", it: "Rosa", value: "rgba(255, 201, 221, 0.55)" },
	{ name: "玫红", en: "Rose", tw: "玫紅", it: "Fucsia", value: "rgba(255, 122, 168, 0.55)" },
];

// Background themes, last one is the dark theme (gets light text + light link color).
const BG_THEMES: { id: string; name: string; en: string; tw: string; it: string; bg: string; color: string; link: string }[] = [
	{ id: "white", name: "白", en: "White", tw: "白", it: "Bianco", bg: "#ffffff", color: "#333333", link: "#1a73e8" },
	{ id: "gray", name: "灰", en: "Gray", tw: "灰", it: "Grigio", bg: "#e8e8e8", color: "#333333", link: "#1a73e8" },
	{ id: "beige", name: "米", en: "Beige", tw: "米", it: "Beige", bg: "#f4ecd8", color: "#4a4234", link: "#1a73e8" },
	{ id: "green", name: "护眼绿", en: "Green", tw: "護眼綠", it: "Verde", bg: "#d8e8d0", color: "#33402f", link: "#1a6b3a" },
	{ id: "dark", name: "黑", en: "Black", tw: "黑", it: "Nero", bg: "#262626", color: "#e6e6e6", link: "#7fb8ff" },
];

// Turn a "#rrggbb" from the picker into a soft, semi-transparent marker color
// matching the preset highlight look.
function hexToHighlightRgba(hex: string): string {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return `rgba(${r}, ${g}, ${b}, 0.5)`;
}

// "rgba(r, g, b, a)" → "#rrggbb" (alpha dropped), for seeding the inline
// picker with the currently selected highlight color.
function rgbaToHex(rgba: string): string {
	const m = rgba.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
	if (!m) return "#ffffff";
	const to = (x: string) => parseInt(x, 10).toString(16).padStart(2, "0");
	return `#${to(m[1])}${to(m[2])}${to(m[3])}`;
}

function hexToHsv(hex: string): { h: number; s: number; v: number } {
	const r = parseInt(hex.slice(1, 3), 16) / 255;
	const g = parseInt(hex.slice(3, 5), 16) / 255;
	const b = parseInt(hex.slice(5, 7), 16) / 255;
	const max = Math.max(r, g, b);
	const d = max - Math.min(r, g, b);
	let h = 0;
	if (d > 0) {
		if (max === r) h = 60 * (((g - b) / d) % 6);
		else if (max === g) h = 60 * ((b - r) / d + 2);
		else h = 60 * ((r - g) / d + 4);
	}
	if (h < 0) h += 360;
	return { h, s: max === 0 ? 0 : d / max, v: max };
}

function hsvToHex(h: number, s: number, v: number): string {
	const f = (n: number) => {
		const k = (n + h / 60) % 6;
		const c = v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
		return Math.round(c * 255)
			.toString(16)
			.padStart(2, "0");
	};
	return `#${f(5)}${f(3)}${f(1)}`;
}

// Inline HSV color picker that expands inside a dropdown menu (no native OS
// dialog, so no focus loss and no open delay): saturation/value square + hue
// bar + live preview. `onPick` fires continuously while dragging, `onCommit`
// once on release — mirroring the "input"/"change" events of the native
// <input type=color> it replaces. Caller animates it open via .is-open.
function buildInlineColorPicker(
	parent: HTMLElement,
	initialHex: string,
	onPick: (hex: string) => void,
	onCommit: (hex: string) => void
): HTMLElement {
	let { h, s, v } = hexToHsv(initialHex);
	const wrap = parent.createDiv({ cls: "epub-cp" });
	const sv = wrap.createDiv({ cls: "epub-cp-sv" });
	const dot = sv.createDiv({ cls: "epub-cp-dot" });
	const hue = wrap.createDiv({ cls: "epub-cp-hue" });
	const hthumb = hue.createDiv({ cls: "epub-cp-hthumb" });
	const row = wrap.createDiv({ cls: "epub-cp-row" });
	const preview = row.createDiv({ cls: "epub-cp-preview" });
	const hexLabel = row.createSpan({ cls: "epub-cp-hex" });

	const paint = (): string => {
		const hex = hsvToHex(h, s, v);
		sv.setCssStyles({ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${h}, 100%, 50%))` });
		dot.setCssStyles({ left: `${s * 100}%`, top: `${(1 - v) * 100}%` });
		hthumb.setCssStyles({ left: `${(h / 360) * 100}%` });
		preview.setCssStyles({ background: hex });
		hexLabel.setText(hex);
		return hex;
	};

	// Pointer-capture drag on an area; `move` gets 0–1 coordinates within it.
	const drag = (area: HTMLElement, move: (x: number, y: number) => void) => {
		area.addEventListener("pointerdown", (e: PointerEvent) => {
			e.preventDefault();
			area.setPointerCapture(e.pointerId);
			const apply = (ev: PointerEvent) => {
				const r = area.getBoundingClientRect();
				move(
					Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)),
					Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height))
				);
				onPick(paint());
			};
			const end = () => {
				area.removeEventListener("pointermove", apply);
				area.removeEventListener("pointerup", end);
				area.removeEventListener("pointercancel", end);
				onCommit(hsvToHex(h, s, v));
			};
			area.addEventListener("pointermove", apply);
			area.addEventListener("pointerup", end);
			area.addEventListener("pointercancel", end);
			apply(e);
		});
	};
	drag(sv, (x, y) => {
		s = x;
		v = 1 - y;
	});
	drag(hue, (x) => {
		h = x * 360;
	});
	paint();
	return wrap;
}

// Perceived luminance of a "#rrggbb" color, used to pick readable text for
// custom user-chosen backgrounds.
function isLightColor(hex: string): boolean {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return (r * 299 + g * 587 + b * 114) / 1000 > 150;
}

const FONTS: { name: string; en: string; tw: string; it: string; value: string }[] = [
	{ name: "系统默认", en: "System default", tw: "系統預設", it: "Predefinito di sistema", value: "" },
	{ name: "宋体", en: "SimSun", tw: "宋體", it: "SimSun", value: "SimSun, serif" },
	{ name: "黑体", en: "SimHei", tw: "黑體", it: "SimHei", value: "SimHei, sans-serif" },
	{ name: "楷体", en: "KaiTi", tw: "楷體", it: "KaiTi", value: "KaiTi, serif" },
	{ name: "微软雅黑", en: "Microsoft YaHei", tw: "微軟雅黑", it: "Microsoft YaHei", value: "Microsoft Yahei, sans-serif" },
	{ name: "Georgia", en: "Georgia", tw: "Georgia", it: "Georgia", value: "Georgia, serif" },
	{ name: "Times New Roman", en: "Times New Roman", tw: "Times New Roman", it: "Times New Roman", value: "Times New Roman, serif" },
	{ name: "Helvetica", en: "Helvetica", tw: "Helvetica", it: "Helvetica", value: "Helvetica, Arial, sans-serif" },
];

// Highlight-color popup swatches keep this inline style (they live inside the
// book iframe's document, which Obsidian's CSS classes don't reach).
const FLAT_BTN_STYLE =
	"border: none; box-shadow: none; padding: 0; cursor: pointer; font-weight: 300;";

export default class EpubReaderPlugin extends Plugin {
	data: PluginData = DEFAULT_DATA;

	async onload() {
		const loaded = (await this.loadData()) as Partial<PluginData> | null;
		this.data = Object.assign({}, DEFAULT_DATA, loaded);
		// prefs is a nested object, so merge it explicitly to keep defaults for any
		// field a previously-saved (older) prefs object is missing.
		this.data.prefs = Object.assign({}, DEFAULT_DATA.prefs, loaded?.prefs);
		currentLang = resolveLang(this.data.prefs.language);

		this.registerView(VIEW_TYPE_EPUB, (leaf) => new EpubView(leaf, this));
		this.registerExtensions(["epub"], VIEW_TYPE_EPUB);
		this.addSettingTab(new EpubSettingTab(this.app, this));

		this.addCommand({
			id: "export-current-book-highlights",
			name: tr("导出当前 EPUB 的高亮到 Markdown", "Export current EPUB highlights to Markdown", "匯出目前 EPUB 的高亮到 Markdown", "Esporta le evidenziazioni dell'EPUB in Markdown"),
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(EpubView);
				if (!view) return false;
				if (checking) return true;
				void view.waitForPagination().then(() =>
					this.exportHighlights(view.file?.path ?? "", (cfi) => view.getPageLabel(cfi))
				);
				return true;
			},
		});

		this.addCommand({
			id: "highlight-selection",
			name: tr("高亮选中文字", "Highlight selection", "高亮選取文字", "Evidenzia la selezione"),
			// No default hotkey: the reader handles Cmd/Ctrl+Shift+H directly inside
			// the book iframe (keydownHandler), because Obsidian's global hotkey
			// dispatch never receives key events from inside the iframe. Binding it
			// here too would double-fire when focus is on the main document.
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(EpubView);
				if (!view) return false;
				if (checking) return true;
				view.highlightCurrentSelection();
				return true;
			},
		});
	}

	async saveBookData() {
		await this.saveData(this.data);
	}

	// Rebuild any open reader views so a language change takes effect immediately.
	reloadOpenViews() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_EPUB)) {
			const view = leaf.view;
			if (view instanceof EpubView && view.file) void view.onLoadFile(view.file);
		}
	}

	getBookRecord(path: string): BookRecord {
		if (!this.data.books[path]) {
			this.data.books[path] = { highlights: [] };
		}
		return this.data.books[path];
	}

	// Builds a Markdown document from a book's highlights. `pageLabel` is
	// optional so the command palette (which has no open view) can still export
	// without page numbers, while the in-reader button can supply them.
	buildHighlightsMarkdown(path: string, pageLabel?: (cfiRange: string) => string, ids?: Set<string>): string | null {
		const record = this.data.books[path];
		if (!record || record.highlights.length === 0) return null;

		const sorted = [...record.highlights]
			.filter((h) => !ids || ids.has(h.id))
			.sort((a, b) => a.created - b.created);
		if (sorted.length === 0) return null;
		// The book name is already the file (note) title, so the H1 omits it to
		// avoid showing the name twice.
		const title = tr("高亮摘录", "Highlights", "高亮摘錄", "Evidenziazioni");
		const count = tr(`共 ${sorted.length} 条高亮`, `${sorted.length} highlights`, `共 ${sorted.length} 條高亮`, `${sorted.length} evidenziazioni`);
		const lines: string[] = [`# ${title}`, "", `> ${count}`, ""];
		for (const h of sorted) {
			const page = pageLabel?.(h.cfiRange);
			const heading =
				page && page !== "—"
					? tr(`第 ${page} 页`, `Page ${page}`, `第 ${page} 頁`, `Pagina ${page}`)
					: new Date(h.created).toLocaleDateString();
			lines.push(`## ${heading}`);
			lines.push("");
			lines.push(`> ${h.text.replace(/\n+/g, " ")}`);
			lines.push("");
			if (h.note) {
				lines.push(`**${tr("备注", "Note", "備註", "Nota")}：** ${h.note}`);
				lines.push("");
			}
			lines.push("---");
			lines.push("");
		}
		return lines.join("\n");
	}

	async exportHighlights(path: string, pageLabel?: (cfiRange: string) => string, ids?: Set<string>) {
		const markdown = this.buildHighlightsMarkdown(path, pageLabel, ids);
		if (markdown === null) {
			new Notice(tr("这本书还没有任何高亮记录", "This book has no highlights yet", "這本書還沒有任何高亮記錄", "Questo libro non ha ancora evidenziazioni"));
			return;
		}
		const bookName = path.split("/").pop()?.replace(/\.epub$/i, "") ?? "epub";
		const outPath = tr(`${bookName} - 高亮摘录.md`, `${bookName} - Highlights.md`, `${bookName} - 高亮摘錄.md`, `${bookName} - Evidenziazioni.md`);
		const existing = this.app.vault.getAbstractFileByPath(outPath);
		let file: TFile;
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, markdown);
			file = existing;
		} else {
			file = await this.app.vault.create(outPath, markdown);
		}
		new Notice(tr(`已导出到「${outPath}」`, `Exported to "${outPath}"`, `已匯出到「${outPath}」`, `Esportato in "${outPath}"`));
		await this.app.workspace.getLeaf(true).openFile(file);
	}

}

class EpubSettingTab extends PluginSettingTab {
	plugin: EpubReaderPlugin;

	constructor(app: App, plugin: EpubReaderPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl)
			.setName(tr("界面语言", "Interface language", "介面語言", "Lingua dell'interfaccia"))
			.setDesc(
				tr(
					"选择插件界面语言。Auto 会跟随 Obsidian 的语言设置。",
					"Choose the plugin's UI language. Auto follows Obsidian's language.",
					"選擇外掛介面語言。Auto 會跟隨 Obsidian 的語言設定。",
					"Scegli la lingua dell'interfaccia. Auto segue la lingua di Obsidian."
				)
			)
			.addDropdown((dd) => {
				for (const o of LANG_OPTIONS) dd.addOption(o.value, o.label);
				dd.setValue(this.plugin.data.prefs.language);
				dd.onChange(async (value) => {
					this.plugin.data.prefs.language = value;
					currentLang = resolveLang(value);
					await this.plugin.saveBookData();
					this.plugin.reloadOpenViews();
					this.display();
				});
			});

		// Icon guide — the same reference shown once on first open.
		new Setting(containerEl).setName(tr("图标说明", "Icon guide", "圖示說明", "Guida icone")).setHeading();
		for (const e of toolbarGuide()) {
			const s = new Setting(containerEl).setName(e.label).setDesc(e.desc);
			if (e.icon) {
				const iconEl = s.nameEl.createSpan({ attr: { style: "margin-left:8px; color:var(--text-muted); vertical-align:middle;" } });
				setIcon(iconEl, e.icon);
			}
		}
	}
}

class NoteModal extends Modal {
	private result: string;
	private onSubmit: (note: string) => void;

	constructor(app: App, initial: string, onSubmit: (note: string) => void) {
		super(app);
		this.result = initial;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: tr("添加笔记", "Add note", "新增筆記", "Aggiungi nota") });
		const textarea = contentEl.createEl("textarea", {
			attr: { rows: "5", style: "width: 100%;" },
		});
		textarea.value = this.result;
		const btnRow = contentEl.createDiv({ attr: { style: "margin-top: 8px; text-align: right;" } });
		const saveBtn = btnRow.createEl("button", { text: tr("保存", "Save", "儲存", "Salva") });
		saveBtn.onclick = () => {
			this.onSubmit(textarea.value);
			this.close();
		};
	}

	onClose() {
		this.contentEl.empty();
	}
}

class HighlightListModal extends Modal {
	private view: EpubView;

	constructor(app: App, view: EpubView) {
		super(app);
		this.view = view;
	}

	onOpen() {
		this.render();
		this.scope.register(["Mod"], "z", (evt: KeyboardEvent) => {
			evt.preventDefault();
			void this.view.undo().then(() => this.render());
		});
	}

	render() {
		const { contentEl } = this;
		contentEl.empty();

		const header = contentEl.createDiv({
			attr: { style: "display: flex; align-items: center; justify-content: space-between; gap: 8px;" },
		});
		header.createEl("h3", { text: tr("所有高亮", "All highlights", "所有高亮", "Tutte le evidenziazioni"), attr: { style: "margin: 0;" } });

		const record = this.view.plugin.getBookRecord(this.view.filePath);
		const sorted = [...record.highlights].sort((a, b) => a.created - b.created);

		if (sorted.length === 0) {
			contentEl.createEl("p", { text: tr("还没有任何高亮。", "No highlights yet.", "還沒有任何高亮。", "Ancora nessuna evidenziazione."), attr: { style: "color: var(--text-muted);" } });
			return;
		}

		for (const h of sorted) {
			const row = contentEl.createDiv({
				attr: {
					style: "display: flex; gap: 8px; padding: 8px 0; border-bottom: 1px solid var(--background-modifier-border);",
				},
			});

			row.createDiv({
				attr: {
					style: `width: 12px; height: 12px; border-radius: 3px; background: ${h.color}; margin-top: 3px; flex-shrink: 0;`,
				},
			});

			const body = row.createDiv({ attr: { style: "flex: 1; min-width: 0;" } });
			const pageLabel = this.view.getPageLabel(h.cfiRange);
			body.createDiv({
				text: tr(`第 ${pageLabel} 页`, `Page ${pageLabel}`, `第 ${pageLabel} 頁`, `Pagina ${pageLabel}`),
				attr: { style: "font-size: 11px; color: var(--text-muted); margin-bottom: 2px;" },
			});
			const textEl = body.createDiv({
				text: h.text,
				attr: { style: "cursor: pointer; line-height: 1.5;" },
			});
			textEl.title = tr("点击跳转到原文", "Click to jump to the passage", "點擊跳至原文", "Clicca per andare al passaggio");
			textEl.onclick = async () => {
				await this.view.rendition?.display(h.cfiRange);
				this.close();
			};
			if (h.note) {
				body.createDiv({
					text: `${tr("备注", "Note", "備註", "Nota")}：${h.note}`,
					attr: { style: "font-size: 12px; color: var(--text-accent); margin-top: 4px;" },
				});
			}

			const actions = row.createDiv({ attr: { style: "display: flex; align-items: flex-start; gap: 2px; flex-shrink: 0;" } });

			// One-click copy of the quote format (page · time + text + note).
			const copyBtn = actions.createEl("button", {
				cls: "epub-tb-btn",
				attr: { title: tr("复制引用", "Copy quote", "複製引用", "Copia citazione") },
			});
			setIcon(copyBtn, "copy");
			copyBtn.onclick = () => this.copy(formatQuote(pageLabel, h.created, h.text, h.note));

			const noteBtn = actions.createEl("button", {
				cls: "epub-tb-btn",
				attr: { title: h.note ? tr("编辑备注", "Edit note", "編輯備註", "Modifica nota") : tr("添加备注", "Add note", "新增備註", "Aggiungi nota") },
			});
			setIcon(noteBtn, h.note ? "pencil" : "message-square-plus");
			noteBtn.onclick = () => {
				new NoteModal(this.app, h.note, async (note) => {
					h.note = note;
					await this.view.plugin.saveBookData();
					this.render();
				}).open();
			};
			const delBtn = actions.createEl("button", {
				cls: "epub-tb-btn",
				attr: { title: tr("删除", "Delete", "刪除", "Elimina") },
			});
			setIcon(delBtn, "trash-2");
			delBtn.onclick = async () => {
				try {
					this.view.undoStack.push({ type: "delete", highlight: h });
					record.highlights = record.highlights.filter((x) => x.id !== h.id);
					await this.view.plugin.saveBookData();
					this.view.unhighlightInAllViews(h.id);
					this.render();
					new Notice(tr("已删除（⌘Z 可撤销）", "Deleted (⌘Z to undo)", "已刪除（⌘Z 可復原）", "Eliminato (⌘Z per annullare)"));
				} catch (err) {
					console.error("epub-reader-highlighter: failed to delete highlight", err);
					new Notice(tr(`删除失败：${(err as Error).message}`, `Delete failed: ${(err as Error).message}`, `刪除失敗：${(err as Error).message}`, `Eliminazione non riuscita: ${(err as Error).message}`));
				}
			};
		}
	}

	copy(text: string) {
		void navigator.clipboard.writeText(text).then(
			() => new Notice(tr("已复制", "Copied", "已複製", "Copiato")),
			() => new Notice(tr("复制失败", "Copy failed", "複製失敗", "Copia non riuscita"))
		);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// Toolbar icon guide — shown once on first open (LegendModal) and always
// available in the settings tab. `icon` is a Lucide name; entries without one
// (e.g. the shortcut summary) render with a bullet.
function toolbarGuide(): { icon?: string; label: string; desc: string }[] {
	return [
		{ icon: "menu", label: tr("目录", "Table of contents", "目錄", "Sommario"), desc: tr("查看章节目录，点击跳转", "Browse the chapters and jump to one", "檢視章節目錄，點擊跳轉", "Sfoglia i capitoli e salta a uno di essi") },
		{ icon: "message-square-quote", label: tr("复制引用", "Copy quote", "複製引用", "Copia citazione"), desc: tr("把选中的文字复制成「页码·时间 + 引用」格式", "Copy the selected text as a “page · time + quote” block", "把選取文字複製成「頁碼·時間 + 引用」格式", "Copia il testo selezionato come blocco “pagina · ora + citazione”") },
		{ icon: "highlighter", label: tr("高亮菜单", "Highlights menu", "高亮選單", "Menu evidenziazioni"), desc: tr("查看全部高亮、复制全部、导出，及设置默认高光颜色", "View, copy or export all highlights, and set the default highlight color", "檢視全部高亮、複製全部、匯出，及設定預設高光顏色", "Vedi, copia o esporta tutte le evidenziazioni e imposta il colore predefinito") },
		{ icon: "sliders-horizontal", label: tr("阅读设置", "Reading settings", "閱讀設定", "Impostazioni di lettura"), desc: tr("字体、字号、背景色；点色轮展开取色面板自定义颜色", "Font, text size and background; the color wheel expands an inline picker for any custom color", "字型、字級、背景色；點色輪展開取色面板自訂顏色", "Carattere, dimensione e sfondo; la ruota dei colori apre un selettore integrato") },
		{ label: tr("滚动 / 分页", "Scroll / Paged", "捲動 / 分頁", "Scorri / Pagine"), desc: tr("切换滚动阅读或分页阅读", "Switch between scrolling and paginated reading", "切換捲動或分頁閱讀", "Passa tra lettura a scorrimento o a pagine") },
		{ label: "‹  ›", desc: tr("上一页 / 下一页，也可用键盘方向键", "Previous / next page — the arrow keys work too", "上一頁 / 下一頁，也可用方向鍵", "Pagina precedente / successiva — anche con le frecce") },
		{ label: tr("页码", "Pages", "頁碼", "Pagine"), desc: tr("页码按当前窗口和字号预排全书得出：总数固定、翻页只 +1，打开或改字号后短暂显示「计算中」。在页码框输入数字回车可跳页；滚动模式下显示进度百分比", "Page numbers come from pre-paginating the whole book at your window size and font: the total is fixed and each turn advances by exactly 1; “Calculating” shows briefly after opening or changing the font. Type a number in the page box to jump; scroll mode shows a progress percent instead", "頁碼按目前視窗和字級預排全書得出：總數固定、翻頁只 +1，開啟或改字級後短暫顯示「計算中」。在頁碼框輸入數字按 Enter 可跳頁；捲動模式下顯示進度百分比", "I numeri di pagina derivano dall'impaginazione dell'intero libro alla finestra e al carattere attuali: il totale è fisso e ogni pagina avanza di 1; dopo l'apertura o un cambio di carattere appare brevemente «Calcolo». Digita un numero nella casella per saltare a una pagina; in modalità scorrimento mostra la percentuale di lettura") },
		{ icon: "search", label: tr("搜索", "Search", "搜尋", "Cerca"), desc: tr("全书搜索关键词，点击结果跳转", "Search the whole book and jump to a result", "全書搜尋關鍵詞，點擊結果跳轉", "Cerca in tutto il libro e salta a un risultato") },
		{ icon: "more-horizontal", label: tr("更多", "More", "更多", "Altro"), desc: tr("界面语言和使用说明", "Interface language and this quick guide", "介面語言和使用說明", "Lingua dell'interfaccia e questa guida") },
		{ label: tr("自动保存", "Auto-save", "自動儲存", "Salvataggio"), desc: tr("阅读位置、偏好和高亮都会自动保存，重新打开回到上次读到的地方", "Reading position, preferences and highlights are saved automatically; reopening returns to where you left off", "閱讀位置、偏好和高亮都會自動儲存，重新開啟回到上次讀到的地方", "Posizione di lettura, preferenze ed evidenziazioni si salvano da sole; alla riapertura torni dove avevi lasciato") },
		{ label: tr("快捷键", "Shortcuts", "快捷鍵", "Scorciatoie"), desc: tr("⌘⇧H 高亮选中文字；⌘Z 撤销高亮", "Cmd/Ctrl+Shift+H highlights the selection; Cmd/Ctrl+Z undoes it", "⌘⇧H 高亮選取文字；⌘Z 復原高亮", "Cmd/Ctrl+Maiusc+H evidenzia la selezione; Cmd/Ctrl+Z annulla") },
	];
}

// First-run guide: what the toolbar icons do. Shown once, then reachable any
// time from the plugin's settings tab.
class LegendModal extends Modal {
	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: tr("使用说明", "Quick guide", "使用說明", "Guida rapida"), attr: { style: "margin-top: 0;" } });
		contentEl.createEl("p", {
			text: tr("工具栏图标一览（之后可在设置里再看）：", "What the toolbar icons do (also in settings later):", "工具列圖示一覽（之後可在設定裡再看）：", "Cosa fanno le icone (anche nelle impostazioni):"),
			attr: { style: "color: var(--text-muted); margin-top: 0;" },
		});
		for (const e of toolbarGuide()) {
			const row = contentEl.createDiv({ attr: { style: "display:flex; gap:10px; align-items:flex-start; padding:6px 0;" } });
			const iconBox = row.createDiv({ attr: { style: "width:22px; flex-shrink:0; display:flex; justify-content:center; color:var(--text-normal);" } });
			if (e.icon) setIcon(iconBox, e.icon);
			else iconBox.setText(e.label.length <= 4 ? e.label : "•");
			const body = row.createDiv({ attr: { style: "flex:1; min-width:0;" } });
			body.createDiv({ text: e.label, attr: { style: "font-weight:600;" } });
			body.createDiv({ text: e.desc, attr: { style: "font-size:12px; color:var(--text-muted);" } });
		}
		const btnRow = contentEl.createDiv({ attr: { style: "margin-top:12px; text-align:right;" } });
		const ok = btnRow.createEl("button", { cls: "mod-cta", text: tr("知道了", "Got it", "知道了", "Ho capito") });
		ok.onclick = () => this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
}

// Pick which highlights to export to Markdown (all selected by default).
class ExportSelectModal extends Modal {
	private view: EpubView;
	private selected: Set<string>;

	constructor(app: App, view: EpubView) {
		super(app);
		this.view = view;
		const record = view.plugin.getBookRecord(view.filePath);
		this.selected = new Set(record.highlights.map((h) => h.id));
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: tr("选择要导出的高亮", "Choose highlights to export", "選擇要匯出的高亮", "Scegli le evidenziazioni da esportare"), attr: { style: "margin-top: 0;" } });

		const record = this.view.plugin.getBookRecord(this.view.filePath);
		const sorted = [...record.highlights].sort((a, b) => a.created - b.created);
		if (sorted.length === 0) {
			contentEl.createEl("p", { text: tr("还没有任何高亮。", "No highlights yet.", "還沒有任何高亮。", "Ancora nessuna evidenziazione."), attr: { style: "color: var(--text-muted);" } });
			return;
		}

		let exportBtn: HTMLButtonElement;
		const updateExportBtn = () => {
			exportBtn.textContent = tr(`导出所选 (${this.selected.size})`, `Export selected (${this.selected.size})`, `匯出所選 (${this.selected.size})`, `Esporta (${this.selected.size})`);
			exportBtn.disabled = this.selected.size === 0;
		};

		const allRow = contentEl.createDiv({ attr: { style: "display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--background-modifier-border);" } });
		const allCb = allRow.createEl("input", { attr: { type: "checkbox" } });
		allCb.checked = true;
		allRow.createSpan({ text: tr("全选", "Select all", "全選", "Seleziona tutto"), attr: { style: "font-weight:600;" } });

		const list = contentEl.createDiv({ attr: { style: "max-height:50vh; overflow:auto;" } });
		const rowCbs: HTMLInputElement[] = [];
		for (const h of sorted) {
			const row = list.createDiv({ attr: { style: "display:flex; gap:8px; padding:8px 0; border-bottom:1px solid var(--background-modifier-border);" } });
			const cb = row.createEl("input", { attr: { type: "checkbox", style: "margin-top:3px; flex-shrink:0;" } });
			cb.checked = true;
			rowCbs.push(cb);
			row.createDiv({ attr: { style: `width:12px;height:12px;border-radius:3px;background:${h.color};margin-top:3px;flex-shrink:0;` } });
			const body = row.createDiv({ attr: { style: "flex:1; min-width:0;" } });
			const page = this.view.getPageLabel(h.cfiRange);
			body.createDiv({ text: tr(`第 ${page} 页`, `Page ${page}`, `第 ${page} 頁`, `Pagina ${page}`), attr: { style: "font-size:11px; color:var(--text-muted); margin-bottom:2px;" } });
			body.createDiv({ text: h.text, attr: { style: "line-height:1.4;" } });
			cb.onchange = () => {
				if (cb.checked) this.selected.add(h.id);
				else this.selected.delete(h.id);
				allCb.checked = this.selected.size === sorted.length;
				updateExportBtn();
			};
		}

		allCb.onchange = () => {
			this.selected = new Set(allCb.checked ? sorted.map((h) => h.id) : []);
			rowCbs.forEach((cb) => (cb.checked = allCb.checked));
			updateExportBtn();
		};

		const footer = contentEl.createDiv({ attr: { style: "margin-top:12px; text-align:right;" } });
		exportBtn = footer.createEl("button", { cls: "mod-cta" });
		updateExportBtn();
		exportBtn.onclick = async () => {
			if (this.selected.size === 0) return;
			exportBtn.disabled = true;
			new Notice(tr("正在导出为 Markdown…", "Exporting to Markdown…", "正在匯出為 Markdown…", "Esportazione in Markdown…"));
			await this.view.waitForPagination();
			await this.view.plugin.exportHighlights(this.view.filePath, (cfi) => this.view.getPageLabel(cfi), this.selected);
			this.close();
		};
	}

	onClose() {
		this.contentEl.empty();
	}
}

// In-book keyword search. Type a term, Enter runs a whole-book search; each
// result shows an excerpt and jumps the reader there on click.
class SearchModal extends Modal {
	private view: EpubView;

	constructor(app: App, view: EpubView) {
		super(app);
		this.view = view;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: tr("搜索", "Search", "搜尋", "Cerca"), attr: { style: "margin-top: 0;" } });
		const input = contentEl.createEl("input", {
			attr: { type: "text", placeholder: tr("输入关键词后回车…", "Type a keyword, then Enter…", "輸入關鍵詞後按 Enter…", "Digita una parola, poi Invio…"), style: "width: 100%;" },
		});
		const status = contentEl.createDiv({ attr: { style: "color: var(--text-muted); font-size: 12px; margin: 8px 0;" } });
		const list = contentEl.createDiv({ attr: { style: "max-height: 55vh; overflow: auto;" } });

		let running = false;
		const run = async () => {
			const q = input.value.trim();
			list.empty();
			if (!q || running) {
				if (!q) status.setText("");
				return;
			}
			running = true;
			status.setText(tr("搜索中…", "Searching…", "搜尋中…", "Ricerca…"));
			try {
				// Search and (in parallel) make sure page positions are ready, so each
				// result can show its page number.
				const [results] = await Promise.all([this.view.searchBook(q), this.view.waitForPagination()]);
				if (results.length === 0) {
					status.setText(tr("没有找到结果。", "No results.", "沒有找到結果。", "Nessun risultato."));
					return;
				}
				status.setText(tr(`${results.length} 个结果`, `${results.length} results`, `${results.length} 個結果`, `${results.length} risultati`));
				for (const r of results) {
					const row = list.createDiv({ cls: "epub-search-item" });
					const pageLabel = this.view.getPageLabel(r.cfi);
					row.createSpan({ cls: "epub-search-page", text: pageLabel !== "—" ? pageLabel.split("/")[0] : "" });
					const ex = row.createSpan({ cls: "epub-search-ex" });
					// Bold the matched term inside the excerpt.
					const text = r.excerpt || q;
					const lower = text.toLowerCase();
					const needle = q.toLowerCase();
					let i = 0;
					for (let idx = lower.indexOf(needle); idx !== -1; idx = lower.indexOf(needle, i)) {
						if (idx > i) ex.createSpan({ text: text.slice(i, idx) });
						ex.createSpan({ cls: "epub-search-hit", text: text.slice(idx, idx + q.length) });
						i = idx + q.length;
					}
					if (i < text.length) ex.createSpan({ text: text.slice(i) });
					row.onclick = () => {
						void this.view.rendition?.display(r.cfi);
						this.close();
					};
				}
			} catch {
				status.setText(tr("搜索失败", "Search failed", "搜尋失敗", "Ricerca non riuscita"));
			} finally {
				running = false;
			}
		};
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") void run();
		});
		window.setTimeout(() => input.focus(), 0);
	}

	onClose() {
		this.contentEl.empty();
	}
}

// Quoted copy format shared by the toolbar (current selection), the per-highlight
// copy button, and "copy all": page + timestamp in italics, then the quote.
function formatQuote(pageLabel: string, timeMs: number, text: string, note: string): string {
	const time = new Date(timeMs).toLocaleString();
	const where = pageLabel && pageLabel !== "—" ? tr(`第 ${pageLabel} 页`, `Page ${pageLabel}`, `第 ${pageLabel} 頁`, `Pagina ${pageLabel}`) : "";
	const meta = [where, time].filter(Boolean).join(" · ");
	const noteLine = note ? `\n${tr("备注", "Note", "備註", "Nota")}：${note}` : "";
	return `*${meta}*\n> ${text.replace(/\n+/g, " ")}${noteLine}`;
}

// Wraps every text node intersecting `range` in its own <span>, since a Range
// can cross element boundaries (e.g. into <em>) and Range.surroundContents
// throws in that case. Per-text-node sub-ranges are always single-node-safe.
function wrapRangeWithSpans(
	doc: Document,
	range: Range,
	className: string,
	cssText: string,
	onClick: () => void
): HTMLElement[] {
	// If the whole selection sits inside one text node, commonAncestorContainer
	// IS that text node — which has no children, so a TreeWalker rooted there
	// finds nothing. Walk from its parent element instead.
	let root: Node = range.commonAncestorContainer;
	if (root.nodeType === Node.TEXT_NODE) {
		root = root.parentNode ?? root;
	}

	const textNodes: Node[] = [];
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		if (range.intersectsNode(node)) textNodes.push(node);
	}

	const spans: HTMLElement[] = [];
	for (const textNode of textNodes) {
		const nodeRange = doc.createRange();
		nodeRange.selectNodeContents(textNode);
		if (textNode === range.startContainer) nodeRange.setStart(textNode, range.startOffset);
		if (textNode === range.endContainer) nodeRange.setEnd(textNode, range.endOffset);
		if (nodeRange.collapsed) continue;

		const span = doc.createElement("span");
		span.className = className;
		span.setAttribute("style", cssText);
		nodeRange.surroundContents(span);
		spans.push(span);
	}
	spans.forEach((s) => s.addEventListener("click", onClick));
	return spans;
}

class EpubView extends FileView {
	plugin: EpubReaderPlugin;
	book: Book;
	rendition: Rendition;
	container: HTMLElement;
	toolbar: HTMLElement;
	pageBox: HTMLElement | null = null;
	pageInput: HTMLInputElement | null = null;
	pageTotal: HTMLElement | null = null;
	prevBtn: HTMLElement | null = null;
	nextBtn: HTMLElement | null = null;
	thumb: HTMLElement | null = null;
	bgBtns: { id: string; el: HTMLElement }[] = [];
	openMenuEl: HTMLElement | null = null;
	openMenuAnchor: HTMLElement | null = null;
	// Selection-time highlight-color popup (shown next to selected text).
	colorToolbar: HTMLElement | null = null;
	keydownHandler = (e: KeyboardEvent) => {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
			e.preventDefault();
			e.stopPropagation();
			void this.undo();
			return;
		}
		// Highlight the selection — handled here (not via an Obsidian command hotkey)
		// so it works while focus is inside the book iframe.
		if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "h") {
			e.preventDefault();
			e.stopPropagation();
			this.highlightCurrentSelection();
			return;
		}
		if (!this.paginated) return;
		if (e.key === "ArrowLeft") {
			e.preventDefault();
			void this.rendition?.prev();
		} else if (e.key === "ArrowRight") {
			e.preventDefault();
			void this.rendition?.next();
		}
	};
	// Document-level key handler so arrows / undo work even when nothing inside
	// the view has focus (e.g. right after opening, or after the page sits idle).
	// Runs only when this view is the active one and the user isn't typing.
	docKeyHandler = (e: KeyboardEvent) => {
		if (this.plugin.app.workspace.getActiveViewOfType(EpubView) !== this) return;
		// A modal (highlights list / note editor) is open — it owns the keyboard,
		// so don't also turn pages behind it or double-fire undo.
		if (this.contentEl.ownerDocument.querySelector(".modal-container")) return;
		const tag = (e.target as HTMLElement | null)?.tagName;
		if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
		this.keydownHandler(e);
	};
	colorToolbarTs = 0;
	// A click anywhere outside a popup/menu dismisses it (the popup and menu stop
	// propagation on their own clicks, so those don't reach here). The color popup
	// is skipped for a moment after opening, because the very mouse-up that
	// finished the selection also fires as a click and would kill it instantly.
	outsideClickHandler = () => {
		if (this.colorToolbar && Date.now() - this.colorToolbarTs > 300) this.dismissColorToolbar();
		this.closeMenus();
	};
	keysBound = false;
	resizeTimer: number | null = null;
	posSaveTimer: number | null = null;
	paginated = true;
	bgTheme = "gray";
	customColor = "#ffffff";
	fontFamily = "";
	fontSize = 20;
	filePath = "";
	fontsLoaded = false;
	// Fixed visual pagination (Apple Books style): the whole book is
	// pre-paginated offscreen at the current pane size + font, yielding a fixed
	// total and the start CFI of every page. Page turns then just advance by 1;
	// the scan reruns only when the pane size or font changes.
	pageCfis: string[] = [];
	// Cumulative pages before each spine section, indexed by spine index.
	sectionPageOffsets: number[] = [];
	visualTotal = 0;
	// Layout key ("WxH|size|font") the adopted pagination was built for.
	visualKeyBuilt = "";
	// Bumped to abort an in-flight scan whose layout is no longer current.
	visualGen = 0;
	visualPromise: Promise<void> | null = null;
	visualPromiseKey = "";
	// Whole-book scan progress (0–100) while computing, shown in the indicator.
	scanPct: number | null = null;
	// Color used by the Cmd+H shortcut; updated whenever a swatch is clicked.
	lastColor = HIGHLIGHT_COLORS[0].value;
	// Undo stack of reversible highlight actions (newest last).
	undoStack: { type: "create" | "delete"; highlight: Highlight }[] = [];

	constructor(leaf: WorkspaceLeaf, plugin: EpubReaderPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return VIEW_TYPE_EPUB;
	}

	getDisplayText() {
		return this.file?.basename ?? "EPUB";
	}

	canAcceptExtension(extension: string) {
		return extension === "epub";
	}

	async onLoadFile(file: TFile) {
		// Same file re-loading (e.g. a language switch rebuilding the UI): reuse
		// the already-parsed book instead of re-reading it and leaking the old one.
		const reusingBook = !!this.book && this.filePath === file.path;
		this.filePath = file.path;
		// Any in-flight pagination scan belongs to the old view/DOM — abort it.
		// renderBook re-adopts the result (instant from cache at the same layout).
		this.invalidateVisualPages();
		// Restore saved reading preferences (background, font, size).
		const prefs = this.plugin.data.prefs;
		this.bgTheme = prefs.bgTheme;
		this.customColor = prefs.customColor;
		this.fontFamily = prefs.fontFamily;
		this.fontSize = prefs.fontSize;
		this.lastColor = prefs.highlightColor || HIGHLIGHT_COLORS[0].value;
		this.contentEl.empty();
		// empty() removed any open popup/menu nodes; drop their stale references.
		this.colorToolbar = null;
		this.openMenuEl = null;
		// Flex column: the toolbar sits on top and may wrap to more rows on a narrow
		// pane; the reading area below flexes to fill whatever height is left.
		this.contentEl.setCssStyles({ position: "relative", overflow: "hidden", padding: "0", display: "flex", flexDirection: "column" });

		// ---- Top toolbar: one horizontal scroll row of icon tools ----
		this.toolbar = this.contentEl.createDiv({ cls: "epub-tb" });
		// A plain mouse wheel scrolls the row horizontally, so every tool stays
		// reachable even when the row overflows a narrow pane.
		this.registerDomEvent(this.toolbar, "wheel", (e: WheelEvent) => {
			if (e.deltaY === 0 || this.toolbar.scrollWidth <= this.toolbar.clientWidth) return;
			this.toolbar.scrollLeft += e.deltaY;
			e.preventDefault();
		}, { passive: false });

		// 1) Table of contents (dropdown).
		const tocBtn = this.toolbar.createEl("button", { cls: "epub-tb-btn", attr: { title: tr("目录", "Table of contents", "目錄", "Sommario") } });
		setIcon(tocBtn, "menu");
		tocBtn.onclick = (e) => {
			e.stopPropagation();
			this.toggleMenu(tocBtn, (menu) => {
				menu.setCssStyles({ maxHeight: "60vh", overflowY: "auto", minWidth: "240px" });
				const loading = menu.createDiv({ cls: "epub-menu-label", text: tr("加载中…", "Loading…", "載入中…", "Caricamento…") });
				void this.book.loaded.navigation
					.then((nav) => {
						loading.remove();
						const toc = ((nav as { toc?: unknown[] })?.toc ?? []) as { href: string; label: string; subitems?: unknown[] }[];
						if (toc.length === 0) {
							menu.createDiv({ cls: "epub-menu-label", text: tr("这本书没有目录", "No table of contents", "這本書沒有目錄", "Nessun sommario") });
							return;
						}
						const add = (items: { href: string; label: string; subitems?: unknown[] }[], depth: number) => {
							for (const it of items) {
								const row = menu.createDiv({ cls: "epub-toc-item", text: it.label.trim() });
								row.setCssStyles({ paddingLeft: `${8 + depth * 14}px` });
								row.onclick = () => {
									void this.rendition?.display(it.href);
									this.closeMenus();
								};
								const subs = it.subitems as typeof items | undefined;
								if (subs && subs.length) add(subs, depth + 1);
							}
						};
						add(toc, 0);
					})
					.catch(() => loading.setText(tr("目录加载失败", "Failed to load contents", "目錄載入失敗", "Caricamento non riuscito")));
			});
		};

		// 2) Copy the current selection as a quote (page · time + text).
		const quoteBtn = this.toolbar.createEl("button", { cls: "epub-tb-btn", attr: { title: tr("复制引用（选中文字）", "Copy quote (selection)", "複製引用（選取文字）", "Copia citazione (selezione)") } });
		setIcon(quoteBtn, "message-square-quote");
		quoteBtn.onclick = () => this.copyCurrentSelectionQuote();

		// 3) Highlights dropdown: list / copy all / export / default color.
		const hlBtn = this.toolbar.createEl("button", { cls: "epub-tb-btn", attr: { title: tr("高亮内容", "Highlights", "高亮內容", "Evidenziazioni") } });
		setIcon(hlBtn, "highlighter");
		hlBtn.onclick = (e) => {
			e.stopPropagation();
			this.toggleMenu(hlBtn, (menu) => {
				const openList = menu.createDiv({ cls: "epub-menu-item" });
				setIcon(openList.createSpan(), "list");
				openList.createSpan({ text: tr("高光标记内容", "All highlights", "高光標記內容", "Tutte le evidenziazioni") });
				openList.onclick = () => {
					this.closeMenus();
					void this.ensureVisualPages();
					new HighlightListModal(this.app, this).open();
				};

				const copyAll = menu.createDiv({ cls: "epub-menu-item" });
				setIcon(copyAll.createSpan(), "copy");
				copyAll.createSpan({ text: tr("复制所有高光", "Copy all highlights", "複製所有高亮", "Copia tutte le evidenziazioni") });
				copyAll.onclick = () => {
					this.closeMenus();
					this.copyAllHighlights();
				};

				const exportSel = menu.createDiv({ cls: "epub-menu-item" });
				setIcon(exportSel.createSpan(), "list-checks");
				exportSel.createSpan({ text: tr("选择导出…", "Export selected…", "選擇匯出…", "Esporta selezionate…") });
				exportSel.onclick = () => {
					this.closeMenus();
					void this.ensureVisualPages();
					new ExportSelectModal(this.app, this).open();
				};

				const exportAll = menu.createDiv({ cls: "epub-menu-item" });
				setIcon(exportAll.createSpan(), "upload");
				exportAll.createSpan({ text: tr("导出为 Markdown", "Export to Markdown", "匯出為 Markdown", "Esporta in Markdown") });
				exportAll.onclick = async () => {
					this.closeMenus();
					new Notice(tr("正在导出为 Markdown…", "Exporting to Markdown…", "正在匯出為 Markdown…", "Esportazione in Markdown…"));
					await this.waitForPagination();
					await this.plugin.exportHighlights(this.filePath, (cfi) => this.getPageLabel(cfi));
				};

				// Default highlight color for ⌘⇧H / drag-select. Selected one shows a
				// white center dot (same as the backgrounds); the last swatch is a
				// color wheel for a custom color.
				menu.createDiv({ cls: "epub-menu-label", text: tr("默认高光色", "Default highlight color", "預設高光色", "Colore predefinito") });
				const palette = menu.createDiv({ cls: "epub-menu-item" });
				palette.setCssStyles({ gap: "10px", flexWrap: "wrap", cursor: "default" });
				const presetSws: HTMLButtonElement[] = [];
				for (const c of HIGHLIGHT_COLORS) {
					const sw = palette.createEl("button", { cls: "epub-swatch-dot", attr: { title: tr(c.name, c.en, c.tw, c.it) } });
					sw.setCssStyles({ background: c.value });
					sw.toggleClass("is-active", c.value === this.lastColor);
					presetSws.push(sw);
					sw.onclick = (ev) => {
						ev.stopPropagation();
						this.lastColor = c.value;
						this.savePrefs();
						this.closeMenus();
						new Notice(tr(`默认高光色已设为「${c.name}」`, `Default highlight color: ${c.en}`, `預設高光色已設為「${c.tw}」`, `Colore predefinito: ${c.it}`));
					};
				}
				const rainbow = palette.createEl("button", { cls: "epub-swatch-dot", attr: { title: tr("自定义颜色…", "Custom color…", "自訂顏色…", "Colore personalizzato…") } });
				rainbow.setCssStyles({ background: "conic-gradient(#f43f5e, #f59e0b, #eab308, #22c55e, #3b82f6, #a855f7, #f43f5e)" });
				rainbow.toggleClass("is-active", !HIGHLIGHT_COLORS.some((c) => c.value === this.lastColor));
				// Clicking the color wheel expands an inline picker inside this menu
				// (toggles on repeat clicks). Picking updates the default color live;
				// the ring on the wheel is the selection feedback, no Notice spam.
				let hlPicker: HTMLElement | null = null;
				rainbow.onclick = (ev) => {
					ev.stopPropagation();
					if (hlPicker) {
						hlPicker.toggleClass("is-open", !hlPicker.hasClass("is-open"));
						return;
					}
					hlPicker = buildInlineColorPicker(
						menu,
						rgbaToHex(this.lastColor),
						(hex) => {
							this.lastColor = hexToHighlightRgba(hex);
							presetSws.forEach((s) => s.removeClass("is-active"));
							rainbow.addClass("is-active");
						},
						() => this.savePrefs()
					);
					window.requestAnimationFrame(() => hlPicker?.addClass("is-open"));
				};
			});
		};

		// 4) Reading panel: font, size, background (sliders icon). Left-right rows —
		// option name on the left, its control on the right; controls share one
		// column so their left and right edges line up across rows.
		const readBtn = this.toolbar.createEl("button", { cls: "epub-tb-btn", attr: { title: tr("字体 · 字号 · 背景", "Font · size · background", "字型 · 字級 · 背景", "Carattere · dimensione · sfondo") } });
		setIcon(readBtn, "sliders-horizontal");
		readBtn.onclick = (e) => {
			e.stopPropagation();
			this.toggleMenu(readBtn, (menu) => {
				menu.addClass("epub-panel");

				// Font — name left, select box right.
				const fontRow = menu.createDiv({ cls: "epub-panel-row" });
				fontRow.createSpan({ cls: "epub-panel-name", text: tr("字体", "Font", "字型", "Carattere") });
				const fontCtl = fontRow.createDiv({ cls: "epub-panel-ctl" });
				const fontSelect = fontCtl.createEl("select", { cls: "epub-panel-box" });
				for (const f of FONTS) fontSelect.createEl("option", { text: tr(f.name, f.en, f.tw, f.it), value: f.value });
				this.addSystemFontOptions(fontSelect);
				fontSelect.value = this.fontFamily;
				fontSelect.onchange = () => {
					this.fontFamily = fontSelect.value;
					this.applyFont();
					this.savePrefs();
					// A different font paginates differently → recompute the fixed
					// pagination once the reflow settles.
					this.invalidateVisualPages();
					this.refreshPageIndicator();
					window.setTimeout(() => void this.ensureVisualPages(), 200);
				};
				fontSelect.addEventListener("mousedown", () => void this.loadSystemFonts(fontSelect));

				// Font size — small A · slider (10–60) · big A.
				const sizeRow = menu.createDiv({ cls: "epub-panel-row" });
				sizeRow.createSpan({ cls: "epub-panel-name", text: tr("字号", "Size", "字級", "Dimensione") });
				const sizeCtl = sizeRow.createDiv({ cls: "epub-panel-ctl epub-size-ctl" });
				sizeCtl.createSpan({ text: "A", attr: { style: "font-size: 16px; line-height: 1;" } });
				const slider = sizeCtl.createEl("input", { attr: { type: "range", min: "10", max: "60", step: "1" } });
				slider.value = `${this.fontSize}`;
				sizeCtl.createSpan({ text: "A", attr: { style: "font-size: 22px; line-height: 1;" } });
				slider.addEventListener("input", () => {
					this.fontSize = Number(slider.value);
					this.rendition?.themes.fontSize(`${this.fontSize}px`);
				});
				slider.addEventListener("change", () => {
					this.savePrefs();
					// Font size changes the layout → recompute the fixed pagination once
					// the reflow settles; the indicator shows "计算中" meanwhile.
					this.invalidateVisualPages();
					this.refreshPageIndicator();
					window.setTimeout(() => void this.ensureVisualPages(), 200);
				});

				// Background — name left, color dots right (white center = selected),
				// spread so the first and last dots align with the other controls.
				const bgRow = menu.createDiv({ cls: "epub-panel-row" });
				bgRow.createSpan({ cls: "epub-panel-name", text: tr("背景", "Background", "背景", "Sfondo") });
				const bgCtl = bgRow.createDiv({ cls: "epub-panel-ctl epub-bg-ctl" });
				this.bgBtns = [];
				for (const t of BG_THEMES) {
					const btn = bgCtl.createEl("button", { cls: "epub-swatch", attr: { title: tr(t.name, t.en, t.tw, t.it) } });
					btn.setCssStyles({ background: t.bg });
					btn.onclick = () => {
						this.bgTheme = t.id;
						this.applyTheme();
						this.savePrefs();
						this.markBgActive();
					};
					this.bgBtns.push({ id: t.id, el: btn });
				}
				const customSw = bgCtl.createEl("button", { cls: "epub-swatch", attr: { title: tr("自定义颜色…", "Custom color…", "自訂顏色…", "Colore personalizzato…") } });
				customSw.setCssStyles({ background: "conic-gradient(#f43f5e, #f59e0b, #eab308, #22c55e, #3b82f6, #a855f7, #f43f5e)" });
				// Clicking the color wheel expands an inline picker at the bottom of
				// this panel (toggles on repeat clicks); the background updates live
				// while dragging, and the choice is saved on release.
				let bgPicker: HTMLElement | null = null;
				customSw.onclick = () => {
					if (bgPicker) {
						bgPicker.toggleClass("is-open", !bgPicker.hasClass("is-open"));
						return;
					}
					bgPicker = buildInlineColorPicker(
						menu,
						this.customColor,
						(hex) => {
							this.customColor = hex;
							this.bgTheme = "custom";
							this.applyTheme();
						},
						() => this.savePrefs()
					);
					window.requestAnimationFrame(() => bgPicker?.addClass("is-open"));
				};
				this.bgBtns.push({ id: "custom", el: customSw });
				this.markBgActive();
			});
		};

		// 5) Scroll / Paged pill toggle.
		const toggleTrack = this.toolbar.createDiv({ cls: "epub-tb-toggle" });
		this.thumb = toggleTrack.createDiv({ cls: "epub-tb-toggle-thumb" });
		this.thumb.setCssStyles({ left: this.paginated ? "50%" : "2px" });
		toggleTrack.createDiv({ cls: "epub-tb-toggle-label", text: tr("滚动", "Scroll", "捲動", "Scorri") }).setCssStyles({ left: "0" });
		toggleTrack.createDiv({ cls: "epub-tb-toggle-label", text: tr("分页", "Paged", "分頁", "Pagine") }).setCssStyles({ left: "50%" });
		toggleTrack.onclick = async () => {
			this.paginated = !this.paginated;
			this.thumb?.setCssStyles({ left: this.paginated ? "50%" : "2px" });
			await this.renderBook();
		};

		// 6) Page navigation: ← [editable page] / total → .
		const pageGroup = this.toolbar.createDiv({ cls: "epub-tb-group" });
		this.prevBtn = pageGroup.createEl("button", { cls: "epub-tb-btn", attr: { title: tr("上一页", "Previous page", "上一頁", "Pagina precedente") } });
		setIcon(this.prevBtn, "arrow-left");
		this.prevBtn.onclick = () => this.rendition?.prev();
		this.pageBox = pageGroup.createDiv({ cls: "epub-page" });
		this.pageInput = this.pageBox.createEl("input", {
			attr: { type: "text", title: tr("跳到页", "Go to page", "跳到頁", "Vai alla pagina") },
		});
		this.pageTotal = this.pageBox.createEl("span");
		this.pageInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") this.jumpToPage(this.pageInput?.value ?? "");
		});
		this.pageInput.addEventListener("blur", () => this.jumpToPage(this.pageInput?.value ?? ""));
		this.nextBtn = pageGroup.createEl("button", { cls: "epub-tb-btn", attr: { title: tr("下一页", "Next page", "下一頁", "Pagina successiva") } });
		setIcon(this.nextBtn, "arrow-right");
		this.nextBtn.onclick = () => this.rendition?.next();

		// 7) Search inside the book.
		const searchBtn = this.toolbar.createEl("button", { cls: "epub-tb-btn", attr: { title: tr("搜索", "Search", "搜尋", "Cerca") } });
		setIcon(searchBtn, "search");
		searchBtn.onclick = () => new SearchModal(this.app, this).open();

		// 8) More: interface language + quick guide.
		const moreBtn = this.toolbar.createEl("button", { cls: "epub-tb-btn", attr: { title: tr("更多", "More", "更多", "Altro") } });
		setIcon(moreBtn, "more-horizontal");
		moreBtn.onclick = (e) => {
			e.stopPropagation();
			this.toggleMenu(moreBtn, (menu) => {
				menu.createDiv({ cls: "epub-menu-label", text: tr("界面语言", "Interface language", "介面語言", "Lingua dell'interfaccia") });
				for (const o of LANG_OPTIONS) {
					const item = menu.createDiv({ cls: "epub-menu-item" });
					item.createSpan({ text: o.label });
					if (o.value === this.plugin.data.prefs.language) setIcon(item.createSpan({ attr: { style: "margin-left: auto;" } }), "check");
					item.onclick = () => {
						this.plugin.data.prefs.language = o.value;
						currentLang = resolveLang(o.value);
						void this.plugin.saveBookData();
						this.closeMenus();
						this.plugin.reloadOpenViews();
					};
				}
				const guide = menu.createDiv({ cls: "epub-menu-item" });
				guide.setCssStyles({ marginTop: "4px", borderTop: "1px solid var(--background-modifier-border)", paddingTop: "8px" });
				setIcon(guide.createSpan(), "help-circle");
				guide.createSpan({ text: tr("使用说明", "Quick guide", "使用說明", "Guida rapida") });
				guide.onclick = () => {
					this.closeMenus();
					new LegendModal(this.app).open();
				};
			});
		};

		// ---- Reading area, below the toolbar ----
		this.container = this.contentEl.createDiv({
			attr: { style: "flex: 1 1 auto; min-height: 0; width: 100%; overflow: auto;" },
		});

		// Register document-level listeners once (arrows / undo without focus, and
		// dismissing the color popup on an outside click). registerDomEvent
		// auto-cleans on view close.
		if (!this.keysBound) {
			this.keysBound = true;
			this.registerDomEvent(this.contentEl.ownerDocument, "keydown", this.docKeyHandler);
			this.registerDomEvent(this.contentEl.ownerDocument, "click", this.outsideClickHandler);
		}

		if (!reusingBook) {
			const arrayBuffer = await this.app.vault.readBinary(file);
			this.book = ePub(arrayBuffer);
		}
		await this.renderBook();

		// First ever open: show the icon guide once, then never automatically again
		// (it stays reachable from the settings tab).
		if (!this.plugin.data.seenGuide) {
			this.plugin.data.seenGuide = true;
			void this.plugin.saveBookData();
			new LegendModal(this.app).open();
		}
	}

	async loadSystemFonts(select: HTMLSelectElement) {
		if (this.fontsLoaded) return;
		this.fontsLoaded = true;
		try {
			// Local Font Access API: Chromium-only, needs a user gesture, not in lib.dom.
			const win = window as Window & { queryLocalFonts?: () => Promise<Array<{ family: string }>> };
			if (!win.queryLocalFonts) return;
			const fonts = await win.queryLocalFonts();
			loadedSystemFonts = Array.from(new Set(fonts.map((f) => f.family))).sort();
			this.addSystemFontOptions(select);
		} catch {
			// Permission denied or unsupported: keep the curated fallback list.
		}
	}

	// Full-text search across the whole book: load each spine section, run
	// epub.js's per-section find, then unload it. Returns matches as {cfi, excerpt}.
	async searchBook(query: string): Promise<{ cfi: string; excerpt: string }[]> {
		const spine = (this.book.spine as unknown as { spineItems?: EpubSectionLike[] }).spineItems ?? [];
		const request = this.book.load.bind(this.book);
		const out: { cfi: string; excerpt: string }[] = [];
		for (const item of spine) {
			try {
				await item.load(request);
				out.push(...item.find(query));
			} catch {
				// Skip a section that fails to load rather than aborting the search.
			} finally {
				item.unload();
			}
		}
		return out;
	}

	// Append cached system fonts to a font <select>, so a rebuilt dropdown (e.g.
	// after a language switch) still lists fonts loaded earlier this session.
	addSystemFontOptions(select: HTMLSelectElement) {
		if (loadedSystemFonts.length === 0) return;
		const current = select.value;
		for (const n of loadedSystemFonts) {
			select.createEl("option", { text: n, value: `"${n}"` });
		}
		select.value = current;
	}

	// Open a popover menu anchored under `anchor`; clicking the same anchor again
	// (or anywhere outside) closes it. The anchor gets an underline (.is-open)
	// while its menu is open, so selection state reads without a boxed background.
	toggleMenu(anchor: HTMLElement, build: (menu: HTMLElement) => void) {
		if (this.openMenuEl) {
			this.closeMenus();
			return;
		}
		const menu = this.contentEl.createDiv({ cls: "epub-menu" });
		menu.addEventListener("click", (e) => e.stopPropagation());
		build(menu);
		const a = anchor.getBoundingClientRect();
		const c = this.contentEl.getBoundingClientRect();
		menu.setCssStyles({
			top: `${a.bottom - c.top + 4}px`,
			left: `${Math.max(4, Math.min(a.left - c.left, c.width - menu.offsetWidth - 4))}px`,
		});
		this.openMenuEl = menu;
		this.openMenuAnchor = anchor;
		anchor.addClass("is-open");
	}

	closeMenus() {
		this.openMenuEl?.remove();
		this.openMenuEl = null;
		this.openMenuAnchor?.removeClass("is-open");
		this.openMenuAnchor = null;
	}

	// Jump to a 1-based fixed page number typed into the page box.
	jumpToPage(raw: string) {
		// Return focus to the reader so the arrow keys turn pages afterwards.
		this.pageInput?.blur();
		if (!this.hasVisualPages()) return;
		const n = parseInt(raw, 10);
		if (isNaN(n)) {
			this.refreshPageIndicator();
			return;
		}
		const idx = Math.min(Math.max(n, 1), this.visualTotal) - 1;
		const cfi = this.pageCfis[idx];
		if (cfi) void this.rendition?.display(cfi);
	}

	applyTheme() {
		if (!this.rendition) return;
		for (const t of BG_THEMES) {
			this.rendition.themes.register(t.id, {
				"html, body": {
					background: `${t.bg} !important`,
					color: `${t.color} !important`,
					margin: "0 !important",
					height: "100% !important",
					"line-height": "1.6 !important",
				},
				"a, a:link, a:visited": { color: `${t.link} !important` },
				// Scale images/covers to the page width and let height follow the
				// intrinsic aspect ratio — no stretching, no cropping, no pixel math.
				"img, image": {
					"max-width": "100% !important",
					"width": "auto !important",
					"height": "auto !important",
				},
				"svg": {
					"width": "100% !important",
					"height": "auto !important",
					"max-width": "100% !important",
				},
			});
		}

		const customTextColor = isLightColor(this.customColor) ? "#333333" : "#f5f5f5";
		const customLinkColor = isLightColor(this.customColor) ? "#1a73e8" : "#7fb8ff";
		this.rendition.themes.register("custom", {
			"html, body": {
				background: `${this.customColor} !important`,
				color: `${customTextColor} !important`,
				margin: "0 !important",
				height: "100% !important",
				"line-height": "1.6 !important",
			},
			"a, a:link, a:visited": { color: `${customLinkColor} !important` },
			"img, image": { "max-width": "100% !important", "width": "auto !important", "height": "auto !important" },
			"svg": { "width": "100% !important", "height": "auto !important", "max-width": "100% !important" },
		});

		this.rendition.themes.select(this.bgTheme);
		this.markBgActive();
		// Fill the reading area (and the view behind it) with the theme color so no
		// white rounded corners show between/around pages.
		const activeBg = this.bgTheme === "custom" ? this.customColor : BG_THEMES.find((t) => t.id === this.bgTheme)?.bg ?? "";
		this.container?.setCssStyles({ background: activeBg });
		this.contentEl.setCssStyles({ background: activeBg });
		this.applyFont();
	}

	// Mark the selected background swatch (.is-active shows a white center dot).
	markBgActive() {
		for (const { id, el } of this.bgBtns) {
			el.toggleClass("is-active", id === this.bgTheme);
		}
	}

	// Apply the saved font family + size to the current rendition. Called from
	// applyTheme, so it re-applies on every (re)render.
	applyFont() {
		if (!this.rendition) return;
		if (this.fontFamily) this.rendition.themes.font(this.fontFamily);
		else (this.rendition.themes as unknown as EpubThemesExtra).removeOverride("font-family");
		this.rendition.themes.fontSize(`${this.fontSize}px`);
	}

	savePrefs() {
		this.plugin.data.prefs = {
			language: this.plugin.data.prefs.language,
			bgTheme: this.bgTheme,
			customColor: this.customColor,
			fontFamily: this.fontFamily,
			fontSize: this.fontSize,
			highlightColor: this.lastColor,
		};
		void this.plugin.saveBookData();
	}

	// Debounced: persist the current reading position so reopening the book
	// (even after an Obsidian restart) returns to the same passage.
	schedulePositionSave() {
		if (this.posSaveTimer !== null) window.clearTimeout(this.posSaveTimer);
		this.posSaveTimer = window.setTimeout(() => {
			this.posSaveTimer = null;
			const cfi = this.rendition?.location?.start?.cfi;
			if (!cfi || !this.filePath) return;
			this.plugin.getBookRecord(this.filePath).lastCfi = cfi;
			void this.plugin.saveBookData();
		}, 600);
	}

	updatePageNav() {
		// Prev/next only make sense in paginated mode; the page box stays visible
		// in scroll mode too, showing the reading-progress percent.
		const disp = this.paginated ? "" : "none";
		this.prevBtn?.setCssStyles({ display: disp });
		this.nextBtn?.setCssStyles({ display: disp });
		this.pageBox?.setCssStyles({ display: "inline-flex" });
	}

	// The layout inputs the fixed pagination depends on: pane size, font size,
	// font family. If any of them changes, page counts must be recomputed.
	layoutKey(): string {
		const w = this.container?.clientWidth ?? 0;
		const h = this.container?.clientHeight ?? 0;
		return `${w}x${h}|${this.fontSize}|${this.fontFamily}`;
	}

	hasVisualPages(): boolean {
		return this.visualTotal > 0 && this.visualKeyBuilt === this.layoutKey();
	}

	// Forget the adopted pagination and abort any in-flight scan; the next
	// ensureVisualPages() rebuilds it (instant when the on-disk cache matches).
	invalidateVisualPages() {
		this.visualGen++;
		this.visualPromise = null;
		this.visualPromiseKey = "";
		this.pageCfis = [];
		this.sectionPageOffsets = [];
		this.visualTotal = 0;
		this.visualKeyBuilt = "";
		this.scanPct = null;
	}

	async ensureVisualPages(): Promise<void> {
		const key = this.layoutKey();
		if (this.hasVisualPages()) return;
		// Coalesce concurrent callers scanning for the same layout.
		if (this.visualPromise && this.visualPromiseKey === key) return this.visualPromise;
		this.visualPromiseKey = key;
		const p = this.computeVisualPages().finally(() => {
			if (this.visualPromise === p) this.visualPromise = null;
		});
		this.visualPromise = p;
		return p;
	}

	// Wait for the fixed pagination, but never block the UI for more than `ms`
	// on a huge book — the scan keeps running and is picked up later.
	async waitForPagination(ms = 20000): Promise<void> {
		await Promise.race([
			this.ensureVisualPages().catch(() => undefined),
			new Promise<void>((resolve) => window.setTimeout(resolve, ms)),
		]);
	}

	// Pre-paginate the whole book, Apple Books style: render every (linear)
	// chapter in a hidden rendition sized exactly like the reading area — same
	// width/height, spread, font, line-height and image fixes — and record how
	// many screens it fills plus the start CFI of every screen. This must stay
	// layout-identical to renderBook's real rendition, or page turns would
	// drift away from the fixed numbers.
	private async computeVisualPages(): Promise<void> {
		const gen = ++this.visualGen;
		await this.book.ready;
		if (gen !== this.visualGen) return;
		const key = this.layoutKey();
		const record = this.plugin.getBookRecord(this.filePath);
		// A cached scan for this exact layout → adopt it instantly.
		if (record.visualKey === key && record.visualCfis?.length && record.visualCounts?.length) {
			this.adoptVisualPages(record.visualCfis, record.visualCounts, key);
			return;
		}
		const w = this.container?.clientWidth ?? 0;
		const h = this.container?.clientHeight ?? 0;
		if (w <= 0 || h <= 0) return;

		// Hidden stage of the reading area's exact size, parked off-viewport with
		// opacity:0 — NOT visibility:hidden, which epub.js defeats by setting
		// visibility:visible on its own iframe, flashing every scanned page over
		// the real view. Off-viewport + opacity keeps the scan fully invisible
		// while the column layout is still computed.
		const off = this.contentEl.createDiv({
			attr: {
				style: `position: absolute; top: 0; left: -10000px; width: ${w}px; height: ${h}px; opacity: 0; overflow: hidden; pointer-events: none;`,
			},
		});
		const rend = this.book.renderTo(off, {
			width: w,
			height: h,
			flow: "paginated",
			manager: "default",
			spread: "none",
		});
		// Only layout-affecting styles matter offscreen: the same body metrics,
		// image constraints and font that applyTheme()/applyFont() set.
		rend.themes.register("scan", {
			"html, body": { margin: "0 !important", height: "100% !important", "line-height": "1.6 !important" },
			"img, image": { "max-width": "100% !important", "width": "auto !important", "height": "auto !important" },
			"svg": { "width": "100% !important", "height": "auto !important", "max-width": "100% !important" },
		});
		rend.themes.select("scan");
		if (this.fontFamily) rend.themes.font(this.fontFamily);
		rend.themes.fontSize(`${this.fontSize}px`);
		// Same image/cover fixes as the real view — they change pagination.
		rend.on("rendered", (_section: { index: number }, view: EpubViewLike) => {
			const doc = view?.contents?.document;
			if (doc) this.fixCoverSvgs(doc, true);
		});

		const spineItems = (this.book.spine as unknown as { spineItems?: EpubSectionLike[] }).spineItems ?? [];
		const cfis: string[] = [];
		const counts: number[] = [];
		try {
			for (let i = 0; i < spineItems.length; i++) {
				const item = spineItems[i];
				// Non-linear sections are skipped by page turns → zero pages.
				if (item.linear === "no") {
					counts.push(0);
					continue;
				}
				if (gen !== this.visualGen) return;
				await this.stepAndLocate(rend, item.href);
				const loc = rend.location?.start;
				const total = Math.max(1, loc?.displayed?.total ?? 1);
				counts.push(total);
				cfis.push(loc?.cfi ?? cfis[cfis.length - 1] ?? "");
				for (let p = 2; p <= total; p++) {
					if (gen !== this.visualGen) return;
					await this.stepAndLocate(rend);
					cfis.push(rend.location?.start?.cfi ?? cfis[cfis.length - 1]);
				}
				this.scanPct = Math.round(((i + 1) / spineItems.length) * 100);
				this.refreshPageIndicator();
			}
		} finally {
			try {
				rend.destroy();
			} catch {
				// The stage may already be gone (view rebuilt mid-scan).
			}
			off.remove();
		}
		if (gen !== this.visualGen || cfis.length === 0) return;
		record.visualCfis = cfis;
		record.visualCounts = counts;
		record.visualKey = key;
		void this.plugin.saveBookData();
		this.adoptVisualPages(cfis, counts, key);
	}

	// Display a target (or turn one page) on the scan rendition and wait for the
	// reported location to update, with a timeout so one broken chapter can't
	// hang the whole scan.
	private stepAndLocate(rend: Rendition, target?: string): Promise<void> {
		return new Promise<void>((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				rend.off("relocated", finish);
				window.clearTimeout(timer);
				resolve();
			};
			const timer = window.setTimeout(finish, 3000);
			rend.on("relocated", finish);
			void (target ? rend.display(target) : rend.next()).catch(finish);
		});
	}

	private adoptVisualPages(cfis: string[], counts: number[], key: string) {
		this.pageCfis = cfis;
		this.sectionPageOffsets = [];
		let acc = 0;
		for (const c of counts) {
			this.sectionPageOffsets.push(acc);
			acc += c;
		}
		this.visualTotal = acc;
		this.visualKeyBuilt = key;
		this.scanPct = null;
		this.refreshPageIndicator();
	}

	// Fixed page number of the screen currently shown: pages before this chapter
	// + the page within it. Advances by exactly 1 per page turn, never jumps.
	currentVisualPage(): number {
		const loc = this.rendition?.location?.start;
		if (!loc) return 0;
		const offset = this.sectionPageOffsets[loc.index] ?? 0;
		const page = loc.displayed?.page ?? 1;
		return Math.min(offset + page, this.visualTotal);
	}

	// 1-based visual page containing `cfi` (works for range CFIs too): the last
	// page whose start CFI is not after it, by binary search.
	visualPageFromCfi(cfi: string): number {
		if (this.pageCfis.length === 0) return 0;
		const comparator = new EpubCFI();
		let lo = 0;
		let hi = this.pageCfis.length - 1;
		let ans = 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			let c: number;
			try {
				c = comparator.compare(this.pageCfis[mid], cfi);
			} catch {
				return 0;
			}
			if (c <= 0) {
				ans = mid + 1;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}
		return ans;
	}

	getPageLabel(cfiRange: string): string {
		if (!this.hasVisualPages()) return "—";
		const n = this.visualPageFromCfi(cfiRange);
		return n > 0 ? `${n}/${this.visualTotal}` : "—";
	}

	async renderBook() {
		// A same-session re-render keeps the live position; a fresh open restores
		// the last saved reading position.
		const cfi = this.rendition?.location?.start?.cfi ?? this.plugin.getBookRecord(this.filePath).lastCfi;
		this.rendition?.destroy();

		this.rendition = this.book.renderTo(this.container, {
			width: "100%",
			height: "100%",
			flow: this.paginated ? "paginated" : "scrolled",
			manager: this.paginated ? "default" : "continuous",
			// Force single-page pagination. With the default "auto" spread, a wide
			// pane shows two pages side by side and doubles the reported page count
			// (pages = spreads × divisor, divisor = 2), so page numbers would jump
			// and grow when enlarging the pane — counter-intuitive.
			spread: "none",
		});

		this.applyTheme();
		this.updatePageNav();

		this.rendition.on("rendered", (section: { index: number }, view: EpubViewLike) => {
			this.applyStoredHighlightsToSection(section.index);
			const doc = view?.contents?.document;
			if (doc) {
				doc.addEventListener("keydown", this.keydownHandler);
				// Clicks inside the book live in a separate iframe document and
				// never bubble to our document's click listener.
				doc.addEventListener("click", this.outsideClickHandler);
				this.fixCoverSvgs(doc);
			}
		});

		this.rendition.on("relocated", () => {
			this.refreshPageIndicator();
			// A leftover color popup from the previous page is now misplaced.
			this.dismissColorToolbar();
			this.schedulePositionSave();
		});

		// Selecting text pops up the highlight-color palette next to the selection.
		this.rendition.on("selected", (cfiRange: string, contents: Contents) => {
			this.showColorToolbar(cfiRange, contents);
		});

		if (cfi) {
			try {
				await this.rendition.display(cfi);
			} catch {
				// Stale CFI (e.g. the epub file was replaced) — start from the top.
				await this.rendition.display();
			}
		} else {
			await this.rendition.display();
		}

		this.refreshPageIndicator();
		// Pre-paginate the whole book offscreen in the background (both modes:
		// paginated needs the fixed page numbers, scroll the exact percent). The
		// indicator shows "计算中" until it's ready (instant when cached).
		window.setTimeout(() => void this.ensureVisualPages(), 250);
	}

	refreshPageIndicator() {
		if (!this.pageInput || !this.pageTotal) return;
		const setBox = (value: string, total: string, editable: boolean) => {
			// Don't clobber the box while the user is typing a page number.
			if (this.pageInput!.ownerDocument.activeElement !== this.pageInput) this.pageInput!.value = value;
			this.pageTotal!.textContent = total;
			this.pageInput!.readOnly = !editable;
			this.pageInput!.setCssStyles({ cursor: editable ? "text" : "default" });
		};
		const loc = this.rendition?.location?.start;
		if (!loc) {
			setBox("", "", false);
			return;
		}
		// Scroll mode: no page numbers, just the reading-progress percent —
		// exact (from the fixed pagination) once the scan is done, spine-based
		// estimate before that.
		if (!this.paginated) {
			let pct: number | null = null;
			if (this.hasVisualPages() && loc.cfi) {
				const n = this.visualPageFromCfi(loc.cfi);
				if (n > 0) pct = Math.round((n / this.visualTotal) * 100);
			}
			if (pct === null) {
				const spineCount = (this.book.spine as unknown as { length?: number }).length ?? 0;
				if (spineCount > 0) {
					const within = loc.displayed?.total ? loc.displayed.page / loc.displayed.total : 0;
					pct = Math.min(100, Math.max(0, Math.round(((loc.index + within) / spineCount) * 100)));
				}
			}
			setBox(pct !== null ? `${pct}%` : "", "", false);
			return;
		}
		// Fixed whole-book page number + total from the offscreen pre-pagination,
		// unchanged while reading (a page turn only advances the number by 1).
		if (this.hasVisualPages()) {
			const current = Math.max(1, this.currentVisualPage());
			const total = this.visualTotal;
			const pct = total ? Math.min(100, Math.max(0, Math.round((current / total) * 100))) : 0;
			setBox(`${current}`, `/ ${total}  ·  ${pct}%`, true);
			return;
		}
		// Still computing: spine-based reading progress + a "calculating" note.
		const calc =
			this.scanPct !== null
				? tr(`· 计算中 ${this.scanPct}%`, `· Calculating ${this.scanPct}%`, `· 計算中 ${this.scanPct}%`, `· Calcolo ${this.scanPct}%`)
				: tr("· 计算中…", "· Calculating…", "· 計算中…", "· Calcolo…");
		const spineCount = (this.book.spine as unknown as { length?: number }).length ?? 0;
		if (spineCount > 0) {
			const within = loc.displayed?.total ? loc.displayed.page / loc.displayed.total : 0;
			const pct = Math.min(100, Math.max(0, Math.round(((loc.index + within) / spineCount) * 100)));
			setBox(`${pct}%`, calc, false);
		} else {
			setBox("", calc, false);
		}
	}

	// Some covers hardcode preserveAspectRatio="none", which forces the inner
	// <image> to stretch to the viewBox regardless of its real aspect ratio.
	// That's an SVG attribute, not a CSS property, so it can't be fixed with a
	// stylesheet — it has to be patched directly on the element.
	fixCoverSvgs(doc: Document, paginated = this.paginated) {
		// Cap the image height to the visible reading pane so it always fits on
		// screen; a portrait cover then becomes height-constrained and shows in
		// full, naturally centered and sized to its aspect ratio.
		const maxH = Math.round(this.container.clientHeight * 0.92);
		const XLINK = "http://www.w3.org/1999/xlink";

		// epub.js rewrites resource paths to blob: URLs in place, so an <image>
		// inside a cover <svg> already carries a usable href. SVG aspect-ratio
		// sizing is unreliable in Chromium, so swap the whole <svg> for a plain
		// <img>, whose max-width/max-height + auto sizing is rock-solid.
		doc.querySelectorAll("svg").forEach((svg) => {
			const image = svg.querySelector("image");
			const href = image?.getAttribute("href") || image?.getAttributeNS(XLINK, "href");
			if (!href) {
				if (svg.getAttribute("preserveAspectRatio") === "none") {
					svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
				}
				return;
			}
			const img = doc.createElement("img");
			img.src = href;
			// These elements live in the book's iframe document, where Obsidian's
			// setCssStyles helper isn't on the prototype, so set the attribute.
			img.setAttribute("style", `display:block; margin:0 auto; max-width:100%; max-height:${maxH}px; width:auto; height:auto;`);
			svg.replaceWith(img);
		});

		// Inline cover/content images: same contain treatment.
		doc.querySelectorAll("img").forEach((img) => {
			img.setAttribute("style", `max-width:100% !important; max-height:${maxH}px !important; width:auto !important; height:auto !important; display:block !important; margin:0 auto !important;`);
		});

		// In paginated mode epub.js lays the body out as CSS columns; force a
		// single column on a cover page (body with one child) so the image
		// isn't split across columns.
		const body = doc.body;
		// Idempotent: onResize re-runs this, so guard against appending repeatedly.
		if (paginated && body && body.children.length === 1 && body.dataset.epubCover !== "1") {
			body.dataset.epubCover = "1";
			body.setAttribute("style", `${body.getAttribute("style") ?? ""}; column-width:auto !important; columns:1 !important; overflow:hidden !important;`);
		}
	}

	onResize() {
		// onResize fires on every frame of a split-drag; debounce so we reflow
		// (a relatively heavy op) only once the drag settles.
		if (this.resizeTimer !== null) window.clearTimeout(this.resizeTimer);
		this.resizeTimer = window.setTimeout(() => {
			this.resizeTimer = null;
			this.doResize();
		}, 150);
	}

	doResize() {
		if (!this.rendition || !this.container) return;
		const w = this.container.clientWidth;
		const h = this.container.clientHeight;
		if (w <= 0 || h <= 0) return;
		// Reflow the columns to the new pane size (epub.js doesn't catch a split
		// resize on its own), then re-fit cover/inline images to the new height.
		this.rendition.resize(w, h);
		for (const view of this.mountedViews()) {
			const doc = view?.contents?.document;
			if (doc) this.fixCoverSvgs(doc);
		}
		// Pane size changed → the fixed pagination no longer matches; recompute
		// once the reflow settles (the indicator shows "计算中" meanwhile).
		this.invalidateVisualPages();
		this.refreshPageIndicator();
		window.setTimeout(() => void this.ensureVisualPages(), 200);
	}

	// Reverse the most recent highlight action: a create is undone by removing
	// it, a delete is undone by restoring it.
	async undo() {
		const action = this.undoStack.pop();
		if (!action) {
			new Notice(tr("没有可撤销的操作", "Nothing to undo", "沒有可復原的操作", "Niente da annullare"));
			return;
		}
		const record = this.plugin.getBookRecord(this.filePath);
		if (action.type === "create") {
			record.highlights = record.highlights.filter((x) => x.id !== action.highlight.id);
			this.unhighlightInAllViews(action.highlight.id);
			new Notice(tr("已撤销高亮", "Highlight undone", "已復原高亮", "Evidenziazione annullata"));
		} else {
			record.highlights.push(action.highlight);
			this.reapplyAllMountedHighlights();
			new Notice(tr("已恢复删除的高亮", "Deleted highlight restored", "已還原刪除的高亮", "Evidenziazione ripristinata"));
		}
		await this.plugin.saveBookData();
	}

	// `views()` returns a Views collection (with `.all()`) at runtime, though
	// epub.js types it as `View[]`; centralize the cast here.
	mountedViews(): EpubViewLike[] {
		if (!this.rendition) return [];
		return (this.rendition.views() as unknown as EpubViewsLike).all();
	}

	reapplyAllMountedHighlights() {
		for (const view of this.mountedViews()) {
			if (view?.section) this.applyStoredHighlightsToSection(view.section.index);
		}
	}

	unhighlightInAllViews(id: string) {
		for (const view of this.mountedViews()) {
			const doc = view?.contents?.document;
			doc?.querySelectorAll(`[data-hl-id="${id}"]`).forEach((span: Element) => {
				span.replaceWith(...Array.from(span.childNodes));
			});
		}
	}

	applyStoredHighlightsToSection(sectionIndex: number) {
		const record = this.plugin.getBookRecord(this.filePath);
		const view = this.mountedViews().find((v) => v.section?.index === sectionIndex);
		if (!view?.contents) return;

		for (const h of record.highlights) {
			let range: Range;
			try {
				range = view.contents.range(h.cfiRange);
			} catch {
				continue;
			}
			if (!range || range.commonAncestorContainer.ownerDocument !== view.contents.document) continue;
			// Skip if already applied (re-render of a section already on screen).
			const existing = view.contents.document.querySelector(`[data-hl-id="${h.id}"]`);
			if (existing) continue;

			const spans = wrapRangeWithSpans(
				view.contents.document,
				range,
				"epub-highlight",
				`background: ${h.color}; cursor: pointer;`,
				() => this.handleHighlightClick(h.id)
			);
			spans.forEach((s) => s.setAttribute("data-hl-id", h.id));
		}
	}

	// Pop up the highlight-color palette next to the current text selection.
	showColorToolbar(cfiRange: string, contents: Contents) {
		this.dismissColorToolbar();
		const selection = contents.window.getSelection();
		const text = selection?.toString() ?? "";
		if (!text.trim() || !selection) return;

		const range = selection.getRangeAt(0);
		const rect = range.getBoundingClientRect();
		const iframeRect = contents.document.defaultView?.frameElement?.getBoundingClientRect();
		// The popup is positioned relative to contentEl, so viewport coordinates
		// must be re-based against contentEl's own offset.
		const containerRect = this.contentEl.getBoundingClientRect();

		const toolbar = this.contentEl.createDiv({
			attr: { style: "position: absolute; z-index: 1000; background: var(--background-secondary); border-radius: 6px; padding: 4px; display: flex; gap: 4px; box-shadow: var(--shadow-s);" },
		});
		// Clicks on the popup must not reach the outside-click dismiss handler.
		toolbar.addEventListener("click", (e) => e.stopPropagation());
		const top = (iframeRect?.top ?? 0) + rect.top - containerRect.top - 34;
		const left = (iframeRect?.left ?? 0) + rect.left - containerRect.left;
		toolbar.setCssStyles({ top: `${Math.max(top, 0)}px`, left: `${left}px` });
		this.colorToolbar = toolbar;
		this.colorToolbarTs = Date.now();

		for (const c of HIGHLIGHT_COLORS) {
			const btn = toolbar.createEl("button", {
				attr: {
					style: `${FLAT_BTN_STYLE} width: 18px; height: 18px; border-radius: 50%; background: ${c.value};`,
					title: tr(c.name, c.en, c.tw, c.it),
				},
			});
			btn.onclick = () => {
				this.lastColor = c.value;
				this.savePrefs();
				this.createHighlight(cfiRange, text, c.value, range, contents.document);
				selection.removeAllRanges();
				this.dismissColorToolbar();
			};
		}
	}

	// The active text selection from whichever mounted section owns it, together
	// with its range/cfi/document. Shared by the highlight and copy-quote paths.
	private currentSelection(): { text: string; range: Range; cfiRange: string; doc: Document; selection: Selection } | null {
		for (const v of this.mountedViews()) {
			const c = v.contents;
			if (!c) continue;
			const selection = c.window.getSelection();
			const text = selection?.toString() ?? "";
			if (!text.trim() || !selection) continue;
			const range = selection.getRangeAt(0);
			return { text, range, cfiRange: c.cfiFromRange(range), doc: c.document, selection };
		}
		return null;
	}

	// Highlight the current selection (from any mounted section) with the last
	// used color — the Cmd+Shift+H shortcut path.
	highlightCurrentSelection() {
		const s = this.currentSelection();
		if (!s) {
			new Notice(tr("请先选择文字", "Select some text first", "請先選擇文字", "Seleziona prima del testo"));
			return;
		}
		this.createHighlight(s.cfiRange, s.text, this.lastColor, s.range, s.doc);
		s.selection.removeAllRanges();
		this.dismissColorToolbar();
	}

	// Copy the current selection as a quote (page · time + text) without creating
	// a highlight — the toolbar "copy quote" button.
	copyCurrentSelectionQuote() {
		const s = this.currentSelection();
		if (!s) {
			new Notice(tr("请先选择文字", "Select some text first", "請先選擇文字", "Seleziona prima del testo"));
			return;
		}
		const quote = formatQuote(this.getPageLabel(s.cfiRange), Date.now(), s.text, "");
		void navigator.clipboard.writeText(quote).then(
			() => new Notice(tr("已复制引用", "Quote copied", "已複製引用", "Citazione copiata")),
			() => new Notice(tr("复制失败", "Copy failed", "複製失敗", "Copia non riuscita"))
		);
	}

	// Copy every highlight in this book as stacked quotes (oldest first).
	copyAllHighlights() {
		const record = this.plugin.getBookRecord(this.filePath);
		const sorted = [...record.highlights].sort((a, b) => a.created - b.created);
		if (sorted.length === 0) {
			new Notice(tr("这本书还没有任何高亮记录", "This book has no highlights yet", "這本書還沒有任何高亮記錄", "Questo libro non ha ancora evidenziazioni"));
			return;
		}
		const text = sorted
			.map((h) => formatQuote(this.getPageLabel(h.cfiRange), h.created, h.text, h.note))
			.join("\n\n");
		void navigator.clipboard.writeText(text).then(
			() => new Notice(tr(`已复制 ${sorted.length} 条高亮`, `Copied ${sorted.length} highlights`, `已複製 ${sorted.length} 條高亮`, `Copiate ${sorted.length} evidenziazioni`)),
			() => new Notice(tr("复制失败", "Copy failed", "複製失敗", "Copia non riuscita"))
		);
	}

	dismissColorToolbar() {
		this.colorToolbar?.remove();
		this.colorToolbar = null;
	}

	createHighlight(cfiRange: string, text: string, color: string, domRange: Range, doc: Document) {
		const id = `hl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const highlight: Highlight = {
			id,
			cfiRange,
			text,
			color,
			note: "",
			created: Date.now(),
		};
		try {
			const spans = wrapRangeWithSpans(
				doc,
				domRange,
				"epub-highlight",
				`background: ${color}; cursor: pointer;`,
				() => this.handleHighlightClick(id)
			);
			if (spans.length === 0) {
				new Notice(tr("高亮失败：未找到可包裹的文本节点", "Highlight failed: no wrappable text node found", "高亮失敗：找不到可包裹的文字節點", "Evidenziazione non riuscita: nessun nodo di testo"));
				return;
			}
			spans.forEach((s) => s.setAttribute("data-hl-id", id));
			// Persist only after the span actually rendered, so a failed wrap never
			// leaves a phantom highlight in the data / list / export.
			const record = this.plugin.getBookRecord(this.filePath);
			record.highlights.push(highlight);
			void this.plugin.saveBookData();
			this.undoStack.push({ type: "create", highlight });
			new Notice(tr("已高亮（⌘Z 可撤销）", "Highlighted (⌘Z to undo)", "已高亮（⌘Z 可復原）", "Evidenziato (⌘Z per annullare)"));
		} catch (err) {
			console.error("epub-reader-highlighter: failed to apply highlight", err);
			new Notice(tr(`高亮失败：${(err as Error).message}`, `Highlight failed: ${(err as Error).message}`, `高亮失敗：${(err as Error).message}`, `Evidenziazione non riuscita: ${(err as Error).message}`));
		}
	}

	handleHighlightClick(id: string) {
		const record = this.plugin.getBookRecord(this.filePath);
		const highlight = record.highlights.find((h) => h.id === id);
		if (!highlight) return;

		new NoteModal(this.app, highlight.note, async (note) => {
			highlight.note = note;
			await this.plugin.saveBookData();
			new Notice(tr("笔记已保存", "Note saved", "筆記已儲存", "Nota salvata"));
		}).open();
	}

	async onUnloadFile(file: TFile) {
		this.dismissColorToolbar();
		this.closeMenus();
		// Abort any in-flight pagination scan (its offscreen stage is torn down
		// by the scan's own cleanup once it notices the generation bump).
		this.invalidateVisualPages();
		if (this.resizeTimer !== null) {
			window.clearTimeout(this.resizeTimer);
			this.resizeTimer = null;
		}
		// Flush the final reading position before the rendition is destroyed.
		if (this.posSaveTimer !== null) {
			window.clearTimeout(this.posSaveTimer);
			this.posSaveTimer = null;
		}
		const cfi = this.rendition?.location?.start?.cfi;
		if (cfi && this.filePath) {
			this.plugin.getBookRecord(this.filePath).lastCfi = cfi;
			await this.plugin.saveBookData();
		}
		this.rendition?.destroy();
		this.book?.destroy();
	}
}
