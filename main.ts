import {
	App,
	FileView,
	Notice,
	Plugin,
	Scope,
	TFile,
	WorkspaceLeaf,
	Modal,
} from "obsidian";
// eslint-disable-next-line @typescript-eslint/no-var-requires
const epubjsModule = require("epubjs");
const ePub = epubjsModule.default ?? epubjsModule;

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
}

interface PluginData {
	books: Record<string, BookRecord>;
}

const DEFAULT_DATA: PluginData = { books: {} };

// Highlight colors, alpha ~0.55 for a soft marker look.
const HIGHLIGHT_COLORS: { name: string; value: string }[] = [
	{ name: "青", value: "rgba(184, 245, 245, 0.55)" },
	{ name: "桃", value: "rgba(255, 217, 168, 0.55)" },
	{ name: "橙", value: "rgba(255, 169, 77, 0.55)" },
	{ name: "蓝", value: "rgba(168, 216, 245, 0.55)" },
	{ name: "粉", value: "rgba(255, 201, 221, 0.55)" },
	{ name: "玫红", value: "rgba(255, 122, 168, 0.55)" },
];

// Background themes, last one is the dark theme (gets light text + light link color).
const BG_THEMES: { id: string; name: string; bg: string; color: string; link: string }[] = [
	{ id: "white", name: "纯白", bg: "#ffffff", color: "#333333", link: "#1a73e8" },
	{ id: "blue-white", name: "淡蓝白", bg: "#dceefb", color: "#333333", link: "#1a73e8" },
	{ id: "gray", name: "浅灰", bg: "#e8e8e8", color: "#333333", link: "#1a73e8" },
	{ id: "dark", name: "深灰", bg: "#5c5c5c", color: "#f5f5f5", link: "#7fb8ff" },
];

// Perceived luminance of a "#rrggbb" color, used to pick readable text for
// custom user-chosen backgrounds.
function isLightColor(hex: string): boolean {
	const r = parseInt(hex.slice(1, 3), 16);
	const g = parseInt(hex.slice(3, 5), 16);
	const b = parseInt(hex.slice(5, 7), 16);
	return (r * 299 + g * 587 + b * 114) / 1000 > 150;
}

const FONTS: { name: string; value: string }[] = [
	{ name: "系统默认", value: "" },
	{ name: "宋体", value: "SimSun, serif" },
	{ name: "黑体", value: "SimHei, sans-serif" },
	{ name: "楷体", value: "KaiTi, serif" },
	{ name: "微软雅黑", value: "Microsoft Yahei, sans-serif" },
	{ name: "Georgia", value: "Georgia, serif" },
	{ name: "Times New Roman", value: "Times New Roman, serif" },
	{ name: "Helvetica", value: "Helvetica, Arial, sans-serif" },
];

const FONT_SIZES = [14, 16, 18, 20, 22, 24, 28];

const FLAT_BTN_STYLE =
	"border: none; box-shadow: none; padding: 0; cursor: pointer; font-weight: 300;";

// Shared "dark glass" pill look used by the page indicator, gear button, and page-turn buttons.
const GLASS_PILL =
	"position: absolute; background: rgba(0,0,0,0.35); color: #fff; border: none; box-shadow: none;";

export default class EpubReaderPlugin extends Plugin {
	data: PluginData = DEFAULT_DATA;

	async onload() {
		this.data = Object.assign({}, DEFAULT_DATA, await this.loadData());

		this.registerView(VIEW_TYPE_EPUB, (leaf) => new EpubView(leaf, this));
		this.registerExtensions(["epub"], VIEW_TYPE_EPUB);

		this.addCommand({
			id: "export-current-book-highlights",
			name: "导出当前 EPUB 的高亮到 Markdown",
			checkCallback: (checking) => {
				const view = this.app.workspace.getActiveViewOfType(EpubView);
				if (!view) return false;
				if (checking) return true;
				view.ensureLocations().then(() =>
					this.exportHighlights(view.file?.path ?? "", (cfi) => view.getPageLabel(cfi))
				);
				return true;
			},
		});
	}

	async saveBookData() {
		await this.saveData(this.data);
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
	buildHighlightsMarkdown(path: string, pageLabel?: (cfiRange: string) => string): string | null {
		const record = this.data.books[path];
		if (!record || record.highlights.length === 0) return null;

		const bookName = path.split("/").pop()?.replace(/\.epub$/i, "") ?? "epub";
		const sorted = [...record.highlights].sort((a, b) => a.created - b.created);
		const lines: string[] = [`# ${bookName} - 高亮摘录`, "", `> 共 ${sorted.length} 条高亮`, ""];
		for (const h of sorted) {
			const page = pageLabel?.(h.cfiRange);
			lines.push(`## ${page && page !== "—" ? `第 ${page} 页` : new Date(h.created).toLocaleDateString()}`);
			lines.push("");
			lines.push(`> ${h.text.replace(/\n+/g, " ")}`);
			lines.push("");
			if (h.note) {
				lines.push(`**备注：** ${h.note}`);
				lines.push("");
			}
			lines.push("---");
			lines.push("");
		}
		return lines.join("\n");
	}

	async exportHighlights(path: string, pageLabel?: (cfiRange: string) => string) {
		const markdown = this.buildHighlightsMarkdown(path, pageLabel);
		if (markdown === null) {
			new Notice("这本书还没有任何高亮记录");
			return;
		}
		const bookName = path.split("/").pop()?.replace(/\.epub$/i, "") ?? "epub";
		const outPath = `${bookName} - 高亮摘录.md`;
		const existing = this.app.vault.getAbstractFileByPath(outPath);
		let file: TFile;
		if (existing instanceof TFile) {
			await this.app.vault.modify(existing, markdown);
			file = existing;
		} else {
			file = await this.app.vault.create(outPath, markdown);
		}
		new Notice(`已导出到「${outPath}」`);
		await this.app.workspace.getLeaf(true).openFile(file);
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
		contentEl.createEl("h3", { text: "添加笔记" });
		const textarea = contentEl.createEl("textarea", {
			attr: { rows: "5", style: "width: 100%;" },
		});
		textarea.value = this.result;
		const btnRow = contentEl.createDiv({ attr: { style: "margin-top: 8px; text-align: right;" } });
		const saveBtn = btnRow.createEl("button", { text: "保存" });
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
			this.view.undo().then(() => this.render());
		});
	}

	render() {
		const { contentEl } = this;
		contentEl.empty();

		const header = contentEl.createDiv({
			attr: { style: "display: flex; align-items: center; justify-content: space-between; gap: 8px;" },
		});
		header.createEl("h3", { text: "所有高亮", attr: { style: "margin: 0;" } });

		const record = this.view.plugin.getBookRecord(this.view.filePath);
		const sorted = [...record.highlights].sort((a, b) => a.created - b.created);

		const exportBtn = header.createEl("button", { text: "导出 Markdown" });
		exportBtn.disabled = sorted.length === 0;
		exportBtn.onclick = async () => {
			await this.view.ensureLocations();
			await this.view.plugin.exportHighlights(this.view.filePath, (cfi) => this.view.getPageLabel(cfi));
			this.close();
		};

		if (sorted.length === 0) {
			contentEl.createEl("p", { text: "还没有任何高亮。", attr: { style: "color: var(--text-muted);" } });
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
			body.createDiv({
				text: `第 ${this.view.getPageLabel(h.cfiRange)} 页`,
				attr: { style: "font-size: 11px; color: var(--text-muted); margin-bottom: 2px;" },
			});
			const textEl = body.createDiv({
				text: h.text,
				attr: { style: "cursor: pointer; line-height: 1.5;" },
			});
			textEl.title = "点击跳转到原文";
			textEl.onclick = async () => {
				await this.view.rendition?.display(h.cfiRange);
				this.close();
			};
			if (h.note) {
				body.createDiv({
					text: `备注：${h.note}`,
					attr: { style: "font-size: 12px; color: var(--text-accent); margin-top: 4px;" },
				});
			}

			const actions = row.createDiv({ attr: { style: "display: flex; flex-direction: column; gap: 4px;" } });
			const noteBtn = actions.createEl("button", { text: h.note ? "编辑备注" : "添加备注" });
			noteBtn.onclick = () => {
				new NoteModal(this.app, h.note, async (note) => {
					h.note = note;
					await this.view.plugin.saveBookData();
					this.render();
				}).open();
			};
			const delBtn = actions.createEl("button", { text: "删除" });
			delBtn.onclick = async () => {
				try {
					this.view.undoStack.push({ type: "delete", highlight: h });
					record.highlights = record.highlights.filter((x) => x.id !== h.id);
					await this.view.plugin.saveBookData();
					this.view.unhighlightInAllViews(h.id);
					this.render();
					new Notice("已删除（⌘Z 可撤销）");
				} catch (err) {
					console.error("epub-reader-highlighter: failed to delete highlight", err);
					new Notice(`删除失败：${(err as Error).message}`);
				}
			};
		}
	}

	onClose() {
		this.contentEl.empty();
	}
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
	let node: Node | null;
	// eslint-disable-next-line no-cond-assign
	while ((node = walker.nextNode())) {
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
	book: any;
	rendition: any;
	container: HTMLElement;
	settingsPanel: HTMLElement;
	gearBtn: HTMLElement;
	colorToolbar: HTMLElement | null = null;
	pageIndicator: HTMLElement | null = null;
	bottomNav: HTMLElement | null = null;
	thumb: HTMLElement | null = null;
	bgBtns: { id: string; el: HTMLElement }[] = [];
	keydownHandler = (e: KeyboardEvent) => {
		if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
			e.preventDefault();
			e.stopPropagation();
			this.undo();
			return;
		}
		if (!this.paginated) return;
		if (e.key === "ArrowLeft") this.rendition?.prev();
		else if (e.key === "ArrowRight") this.rendition?.next();
	};
	outsideClickHandler = () => {
		if (this.settingsPanel) this.settingsPanel.style.display = "none";
	};
	paginated = false;
	bgTheme = "blue-white";
	customColor = "#ffffff";
	customSwatch: HTMLElement | null = null;
	filePath = "";
	fontsLoaded = false;
	// Undo stack of reversible highlight actions (newest last).
	undoStack: { type: "create" | "delete"; highlight: Highlight }[] = [];

	constructor(leaf: WorkspaceLeaf, plugin: EpubReaderPlugin) {
		super(leaf);
		this.plugin = plugin;
		// Obsidian activates this scope (taking priority over its own global
		// Mod+Z) whenever focus is in this view but outside the book iframe.
		this.scope = new Scope(this.app.scope);
		this.scope.register(["Mod"], "z", (evt: KeyboardEvent) => {
			evt.preventDefault();
			this.undo();
			return false;
		});
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
		this.filePath = file.path;
		this.contentEl.empty();
		this.contentEl.style.position = "relative";
		this.contentEl.style.overflow = "hidden";
		this.contentEl.style.padding = "0";

		// Reading area fills the whole view; the page is full-bleed.
		this.container = this.contentEl.createDiv({
			attr: { style: "position: absolute; inset: 0; overflow: auto;" },
		});

		// Floating page indicator, top-center, only visible while paginated.
		this.pageIndicator = this.contentEl.createDiv({
			attr: {
				style: "position: absolute; top: 8px; left: 50%; transform: translateX(-50%); font-size: 11px; font-weight: 300; padding: 2px 10px; border-radius: 10px; background: rgba(0,0,0,0.35); color: #fff; z-index: 20; display: none; pointer-events: none;",
			},
		});

		// Settings toggle, top-right corner — thin plus icon, same dark-glass language as the page indicator.
		this.gearBtn = this.contentEl.createDiv({
			attr: {
				style: `${GLASS_PILL} top: 8px; right: 8px; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 30; font-size: 16px; font-weight: 200;`,
				title: "阅读设置",
			},
			text: "+",
		});

		// View-all-highlights toggle, just left of the settings button.
		const listBtn = this.contentEl.createDiv({
			attr: {
				style: `${GLASS_PILL} top: 8px; right: 44px; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; z-index: 30; font-size: 13px; font-weight: 300;`,
				title: "查看所有高亮",
			},
			text: "▤",
		});
		listBtn.onclick = async () => {
			await this.ensureLocations();
			new HighlightListModal(this.app, this).open();
		};

		// Draggable, collapsible settings panel — semi-transparent dark glass.
		this.settingsPanel = this.contentEl.createDiv({
			attr: {
				style: "position: absolute; top: 42px; right: 8px; width: 168px; background: rgba(20,20,28,0.55); backdrop-filter: blur(8px); color: #fff; border-radius: 12px; padding: 10px; display: none; flex-direction: column; gap: 10px; z-index: 30;",
			},
		});
		this.gearBtn.onclick = (e) => {
			e.stopPropagation();
			const showing = this.settingsPanel.style.display !== "none";
			this.settingsPanel.style.display = showing ? "none" : "flex";
		};
		this.settingsPanel.addEventListener("click", (e) => e.stopPropagation());
		// Click anywhere outside the panel/gear closes it. registerDomEvent ties
		// the listener to this view's lifecycle so it's cleaned up automatically.
		this.registerDomEvent(document, "click", this.outsideClickHandler);

		const dragHandle = this.settingsPanel.createDiv({
			attr: {
				style: "font-size: 10px; font-weight: 300; color: rgba(255,255,255,0.6); cursor: move; text-align: center; margin: -10px -10px 0 -10px; padding: 6px; border-bottom: 1px solid rgba(255,255,255,0.12);",
			},
			text: "⋮⋮ 阅读设置",
		});
		this.makeDraggable(this.settingsPanel, dragHandle);

		// Sliding scroll/paginate segmented toggle: transparent track, thin outline thumb.
		const toggleTrack = this.settingsPanel.createDiv({
			attr: {
				style: "position: relative; width: 100%; height: 22px; border-radius: 11px; background: rgba(255,255,255,0.08); cursor: pointer;",
			},
		});
		this.thumb = toggleTrack.createDiv({
			attr: {
				style: "position: absolute; top: 0; left: 0; width: 50%; height: 22px; border-radius: 11px; background: transparent; border: 1.5px solid #ff902c; box-sizing: border-box; transition: left 0.15s ease;",
			},
		});
		toggleTrack.createDiv({
			attr: {
				style: "position: absolute; left: 0; width: 50%; height: 22px; line-height: 22px; text-align: center; font-size: 11px; font-weight: 300; color: #fff; pointer-events: none;",
			},
			text: "滚动",
		});
		toggleTrack.createDiv({
			attr: {
				style: "position: absolute; left: 50%; width: 50%; height: 22px; line-height: 22px; text-align: center; font-size: 11px; font-weight: 300; color: #fff; pointer-events: none;",
			},
			text: "分页",
		});
		toggleTrack.onclick = async () => {
			this.paginated = !this.paginated;
			if (this.thumb) this.thumb.style.left = this.paginated ? "50%" : "0%";
			await this.renderBook();
		};

		const selectRow = this.settingsPanel.createDiv({
			attr: { style: "display: flex; flex-direction: column; gap: 6px;" },
		});

		const fontSelect = selectRow.createEl("select", {
			attr: { style: `${FLAT_BTN_STYLE} background: rgba(255,255,255,0.08); color: #fff; font-size: 11px; width: 100%; border-radius: 6px; padding: 3px 4px;` },
		});
		for (const f of FONTS) {
			fontSelect.createEl("option", { text: f.name, value: f.value });
		}
		fontSelect.onchange = () => {
			if (fontSelect.value) this.rendition?.themes.font(fontSelect.value);
			else this.rendition?.themes.removeOverride("font-family");
		};
		fontSelect.addEventListener("mousedown", () => this.loadSystemFonts(fontSelect));

		const sizeSelect = selectRow.createEl("select", {
			attr: { style: `${FLAT_BTN_STYLE} background: rgba(255,255,255,0.08); color: #fff; font-size: 11px; width: 100%; border-radius: 6px; padding: 3px 4px;` },
		});
		for (const s of FONT_SIZES) {
			sizeSelect.createEl("option", { text: `${s}px`, value: `${s}` });
		}
		sizeSelect.value = "18";
		sizeSelect.onchange = () => this.rendition?.themes.fontSize(`${sizeSelect.value}px`);

		const bgRow = this.settingsPanel.createDiv({
			attr: { style: "display: flex; gap: 6px; justify-content: space-between;" },
		});
		this.bgBtns = [];
		for (const t of BG_THEMES) {
			const btn = bgRow.createEl("button", {
				attr: {
					style: `${FLAT_BTN_STYLE} width: 22px; height: 18px; border-radius: 4px; background: ${t.bg}; box-sizing: border-box;`,
					title: t.name,
				},
			});
			btn.onclick = () => {
				this.bgTheme = t.id;
				this.applyTheme();
			};
			this.bgBtns.push({ id: t.id, el: btn });
		}

		// 5th swatch: visually identical plain square to the other 4 — a real
		// <input type="color"> can't be restyled to match pixel-for-pixel
		// across browsers, so it's hidden and only used to open the native
		// color picker; the square itself just reflects the chosen color.
		this.customSwatch = bgRow.createDiv({
			attr: {
				style: `${FLAT_BTN_STYLE} width: 22px; height: 18px; border-radius: 4px; box-sizing: border-box; background: ${this.customColor}; position: relative;`,
				title: "自定义颜色",
			},
		});
		const hiddenColorInput = this.customSwatch.createEl("input", {
			attr: {
				type: "color",
				style: "position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; border: none; padding: 0;",
			},
		}) as HTMLInputElement;
		hiddenColorInput.value = this.customColor;
		hiddenColorInput.addEventListener("input", () => {
			this.customColor = hiddenColorInput.value;
			this.customSwatch!.style.background = this.customColor;
			this.bgTheme = "custom";
			this.applyTheme();
		});

		// Small floating dark-glass page-turn buttons, centered at the bottom (paginated mode only).
		this.bottomNav = this.contentEl.createDiv({
			attr: {
				style: "position: absolute; bottom: 10px; left: 50%; transform: translateX(-50%); display: none; gap: 10px; z-index: 20;",
			},
		});
		const prevBig = this.bottomNav.createDiv({
			attr: {
				style: `${GLASS_PILL} position: static; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 600; cursor: pointer;`,
			},
			text: "‹",
		});
		prevBig.onclick = () => this.rendition?.prev();
		const nextBig = this.bottomNav.createDiv({
			attr: {
				style: `${GLASS_PILL} position: static; width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 16px; font-weight: 600; cursor: pointer;`,
			},
			text: "›",
		});
		nextBig.onclick = () => this.rendition?.next();

		this.contentEl.tabIndex = 0;
		this.contentEl.addEventListener("keydown", this.keydownHandler);

		const arrayBuffer = await this.app.vault.readBinary(file);
		this.book = ePub(arrayBuffer);
		await this.renderBook();
	}

	makeDraggable(panel: HTMLElement, handle: HTMLElement) {
		handle.addEventListener("mousedown", (e: MouseEvent) => {
			e.preventDefault();
			const startX = e.clientX;
			const startY = e.clientY;
			const rect = panel.getBoundingClientRect();
			const parentRect = this.contentEl.getBoundingClientRect();
			const startLeft = rect.left - parentRect.left;
			const startTop = rect.top - parentRect.top;

			const onMove = (ev: MouseEvent) => {
				panel.style.right = "auto";
				panel.style.left = `${startLeft + (ev.clientX - startX)}px`;
				panel.style.top = `${startTop + (ev.clientY - startY)}px`;
			};
			const onUp = () => {
				window.removeEventListener("mousemove", onMove);
				window.removeEventListener("mouseup", onUp);
			};
			window.addEventListener("mousemove", onMove);
			window.addEventListener("mouseup", onUp);
		});
	}

	async loadSystemFonts(select: HTMLSelectElement) {
		if (this.fontsLoaded) return;
		this.fontsLoaded = true;
		try {
			// @ts-ignore - Local Font Access API, Chromium-only, needs a user gesture.
			if (!window.queryLocalFonts) return;
			// @ts-ignore
			const fonts = await window.queryLocalFonts();
			const names: string[] = Array.from(new Set(fonts.map((f: any) => f.family))).sort();
			const current = select.value;
			for (const n of names) {
				select.createEl("option", { text: n, value: `"${n}"` });
			}
			select.value = current;
		} catch {
			// Permission denied or unsupported: keep the curated fallback list.
		}
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

		const activeColor =
			BG_THEMES.find((t) => t.id === this.bgTheme)?.color ??
			(this.bgTheme === "custom" ? customTextColor : BG_THEMES[0].color);
		for (const { id, el } of this.bgBtns) {
			(el as HTMLElement).style.border = id === this.bgTheme ? `1.5px solid ${activeColor}` : "1.5px solid transparent";
		}
		if (this.customSwatch) {
			this.customSwatch.style.border = this.bgTheme === "custom" ? `1.5px solid ${activeColor}` : "1.5px solid transparent";
		}
	}

	updatePageNav() {
		if (this.pageIndicator) this.pageIndicator.style.display = this.paginated ? "" : "none";
		if (this.bottomNav) this.bottomNav.style.display = this.paginated ? "flex" : "none";
	}

	async ensureLocations() {
		if (this.book.locations.length()) return;
		const notice = new Notice("正在计算页码…", 0);
		await this.book.ready;
		await this.book.locations.generate(1024);
		notice.hide();
	}

	getPageLabel(cfiRange: string): string {
		if (!this.book?.locations?.length()) return "—";
		const loc = this.book.locations.locationFromCfi(cfiRange);
		if (loc < 0) return "—";
		return `${loc + 1}/${this.book.locations.length()}`;
	}

	async renderBook() {
		const cfi = this.rendition?.location?.start?.cfi;
		this.rendition?.destroy();

		this.rendition = this.book.renderTo(this.container, {
			width: "100%",
			height: "100%",
			flow: this.paginated ? "paginated" : "scrolled",
			manager: this.paginated ? "default" : "continuous",
		});

		this.applyTheme();
		this.updatePageNav();

		if (this.paginated) await this.ensureLocations();

		this.rendition.on("rendered", (section: any, view: any) => {
			this.applyStoredHighlightsToSection(section.index);
			const doc = view?.contents?.document;
			if (doc) {
				doc.addEventListener("keydown", this.keydownHandler);
				// Clicks inside the book live in a separate iframe document and
				// never bubble out to our own document's click listener.
				doc.addEventListener("click", this.outsideClickHandler);
				this.fixCoverSvgs(doc);
			}
		});

		this.rendition.on("relocated", (location: any) => {
			if (!this.pageIndicator) return;
			if (this.paginated && this.book.locations.length()) {
				const current = this.book.locations.locationFromCfi(location.start.cfi) + 1;
				const total = this.book.locations.length();
				this.pageIndicator.textContent = `${current}/${total}页`;
			} else {
				this.pageIndicator.textContent = "";
			}
			// Safety net: re-check every currently mounted section against stored
			// highlights, in case a "rendered" event was missed on revisit.
			this.reapplyAllMountedHighlights();
		});

		this.rendition.on("selected", (cfiRange: string, contents: any) => {
			this.showColorToolbar(cfiRange, contents);
		});

		await (cfi ? this.rendition.display(cfi) : this.rendition.display());
	}

	// Some covers hardcode preserveAspectRatio="none", which forces the inner
	// <image> to stretch to the viewBox regardless of its real aspect ratio.
	// That's an SVG attribute, not a CSS property, so it can't be fixed with a
	// stylesheet — it has to be patched directly on the element.
	fixCoverSvgs(doc: Document) {
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
			img.style.cssText = `display:block; margin:0 auto; max-width:100%; max-height:${maxH}px; width:auto; height:auto;`;
			svg.replaceWith(img);
		});

		// Inline cover/content images: same contain treatment.
		doc.querySelectorAll("img").forEach((img) => {
			img.style.setProperty("max-width", "100%", "important");
			img.style.setProperty("max-height", `${maxH}px`, "important");
			img.style.setProperty("width", "auto", "important");
			img.style.setProperty("height", "auto", "important");
			img.style.setProperty("display", "block", "important");
			img.style.setProperty("margin", "0 auto", "important");
		});

		// In paginated mode epub.js lays the body out as CSS columns; force a
		// single column on a cover page (body with one child) so the image
		// isn't split across columns.
		const body = doc.body;
		if (this.paginated && body && body.children.length === 1) {
			body.style.setProperty("column-width", "auto", "important");
			body.style.setProperty("columns", "1", "important");
			body.style.setProperty("overflow", "hidden", "important");
		}
	}

	// Reverse the most recent highlight action: a create is undone by removing
	// it, a delete is undone by restoring it.
	async undo() {
		const action = this.undoStack.pop();
		if (!action) {
			new Notice("没有可撤销的操作");
			return;
		}
		const record = this.plugin.getBookRecord(this.filePath);
		if (action.type === "create") {
			record.highlights = record.highlights.filter((x) => x.id !== action.highlight.id);
			this.unhighlightInAllViews(action.highlight.id);
			new Notice("已撤销高亮");
		} else {
			record.highlights.push(action.highlight);
			this.reapplyAllMountedHighlights();
			new Notice("已恢复删除的高亮");
		}
		await this.plugin.saveBookData();
	}

	reapplyAllMountedHighlights() {
		for (const view of this.rendition?.views()?.all() ?? []) {
			if (view?.section) this.applyStoredHighlightsToSection(view.section.index);
		}
	}

	unhighlightInAllViews(id: string) {
		for (const view of this.rendition?.views()?.all() ?? []) {
			const doc = view?.contents?.document;
			doc?.querySelectorAll(`[data-hl-id="${id}"]`).forEach((span: Element) => {
				span.replaceWith(...Array.from(span.childNodes));
			});
		}
	}

	applyStoredHighlightsToSection(sectionIndex: number) {
		const record = this.plugin.getBookRecord(this.filePath);
		const view = this.rendition.views().all().find((v: any) => v.section?.index === sectionIndex);
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

	showColorToolbar(cfiRange: string, contents: any) {
		this.colorToolbar?.remove();
		const selection = contents.window.getSelection();
		const text = selection?.toString() ?? "";
		if (!text.trim()) return;

		const range = selection.getRangeAt(0);
		const rect = range.getBoundingClientRect();
		const iframeRect = (contents.document.defaultView.frameElement as HTMLElement)?.getBoundingClientRect();
		// toolbar is positioned relative to contentEl, so viewport coordinates
		// must be re-based against contentEl's own offset, not the page origin.
		const containerRect = this.contentEl.getBoundingClientRect();

		const toolbar = this.contentEl.createDiv({
			attr: {
				style: `position: absolute; z-index: 1000; background: var(--background-secondary); border-radius: 6px; padding: 4px; display: flex; gap: 4px; box-shadow: var(--shadow-s);`,
			},
		});
		const top = (iframeRect?.top ?? 0) + rect.top - containerRect.top - 34;
		const left = (iframeRect?.left ?? 0) + rect.left - containerRect.left;
		toolbar.style.top = `${Math.max(top, 0)}px`;
		toolbar.style.left = `${left}px`;
		this.colorToolbar = toolbar;

		for (const c of HIGHLIGHT_COLORS) {
			const btn = toolbar.createEl("button", {
				attr: {
					style: `width: 18px; height: 18px; border-radius: 4px; background: ${c.value}; border: none; box-shadow: none; padding: 0; cursor: pointer;`,
					title: c.name,
				},
			});
			btn.onclick = () => {
				this.createHighlight(cfiRange, text, c.value, range, contents.document);
				selection?.removeAllRanges();
				toolbar.remove();
				this.colorToolbar = null;
			};
		}
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
		const record = this.plugin.getBookRecord(this.filePath);
		record.highlights.push(highlight);
		this.plugin.saveBookData();

		try {
			const spans = wrapRangeWithSpans(
				doc,
				domRange,
				"epub-highlight",
				`background: ${color}; cursor: pointer;`,
				() => this.handleHighlightClick(id)
			);
			spans.forEach((s) => s.setAttribute("data-hl-id", id));
			if (spans.length === 0) {
				new Notice("高亮失败：未找到可包裹的文本节点");
			} else {
				this.undoStack.push({ type: "create", highlight });
				new Notice("已高亮（⌘Z 可撤销）");
			}
		} catch (err) {
			console.error("epub-reader-highlighter: failed to apply highlight", err);
			new Notice(`高亮失败：${(err as Error).message}`);
		}
	}

	handleHighlightClick(id: string) {
		const record = this.plugin.getBookRecord(this.filePath);
		const highlight = record.highlights.find((h) => h.id === id);
		if (!highlight) return;

		new NoteModal(this.app, highlight.note, async (note) => {
			highlight.note = note;
			await this.plugin.saveBookData();
			new Notice("笔记已保存");
		}).open();
	}

	async onUnloadFile(file: TFile) {
		this.contentEl.removeEventListener("keydown", this.keydownHandler);
		this.colorToolbar?.remove();
		this.colorToolbar = null;
		this.rendition?.destroy();
		this.book?.destroy();
	}
}
