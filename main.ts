import {
	App,
	FileView,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	setIcon,
	TFile,
	TFolder,
	normalizePath,
	WorkspaceLeaf,
	Modal,
	MarkdownRenderer,
	TextAreaComponent,
	Component,
	getLanguage,
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
	// getLanguage() is the supported way, but it only exists on newer Obsidian
	// builds — older ones still have to be read out of local storage.
	const raw = typeof getLanguage === "function" ? getLanguage() : window.localStorage.getItem("language");
	const l = (raw ?? "").toLowerCase();
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
	// Where the passage starts, counted in characters of the chapter's text. A CFI
	// is a node path, so it goes stale when the markup around it shifts; this
	// survives that and lets a highlight be found again.
	offset?: number;
	text: string;
	color: string;
	note: string;
	created: number;
}

interface BookRecord {
	highlights: Highlight[];
	// What the epub looked like when these highlights were made. A different file
	// under the same path is a different book, and its anchors mean nothing here.
	bookSize?: number;
	bookHash?: string;
	// The color chips ticked last time this book was exported, restored on reopen.
	colorFilter?: string[];
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
	// Recently used custom highlight colors (hex, newest first, max 5).
	customHlHistory?: string[];
}

// How highlights are written out. Kept apart from ReadingPrefs because these
// describe the exported note, not the reading experience.
interface ExportPrefs {
	// Vault-relative folder; "" = vault root.
	folder: string;
	groupBy: "reading" | "chapter" | "color";
	// "book" = the order the passages appear in the book; "created" = the order
	// they were highlighted.
	sortBy: "book" | "created";
	showChapter: boolean;
	showPage: boolean;
	showDate: boolean;
	showNote: boolean;
	showColor: boolean;
	// A running number before each quote, so a long export stays easy to refer to.
	showIndex: boolean;
	// When on, `template` decides how one highlight is written and the toggles
	// above no longer apply.
	useTemplate: boolean;
	template: string;
}

const DEFAULT_EXPORT: ExportPrefs = {
	folder: "",
	groupBy: "reading",
	sortBy: "created",
	showChapter: true,
	showPage: true,
	showDate: true,
	showNote: true,
	showColor: false,
	showIndex: true,
	useTemplate: false,
	template: "",
};

// Exports carry no markers at all: every comment syntax Obsidian has stays
// visible in Live Preview, and a clean note matters more than exact matching —
// merging recognises a block by its quoted text instead. These two are still
// recognised when merging notes written by the versions that did write them.
const HL_BEGIN = "%%epub-hl:begin%%";
const HL_END = "%%epub-hl:end%%";

// Where each book's annotations live. The folder holds one file per book, as
// ordinary vault files, so any sync tool carries them and only the book that
// changed gets transferred.
interface StoragePrefs {
	folder: string;
	// Set once the annotations in data.json have been copied out to that folder.
	migratedAt?: number;
}

const DEFAULT_STORAGE: StoragePrefs = { folder: "epub-highlights" };

// One book's file in that folder.
interface SidecarFile {
	version: number;
	book: string;
	// Set on a file kept aside after the book it belonged to was replaced; the
	// plugin leaves these alone.
	archived?: boolean;
	bookSize?: number;
	bookHash?: string;
	highlights: Highlight[];
	lastCfi?: string;
	colorFilter?: string[];
}

// The whole-book pre-pagination cache: the start CFI of every visual page, the
// pages per spine section, and the layout key ("WxH|size|font") it was built
// for. It is derived from the window size and font, so it belongs to this
// device and never to the vault.
interface VisualCache {
	cfis: string[];
	counts: number[];
	key: string;
}

interface PluginData {
	books: Record<string, BookRecord>;
	prefs: ReadingPrefs;
	storage?: StoragePrefs;
	export?: ExportPrefs;
	// Whether the first-run icon guide has been shown (once ever).
	seenGuide?: boolean;
	// The release whose notes were last shown, so an upgrade shows them once.
	seenVersion?: string;
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

// Reading order needs CFIs compared, which one throwaway EpubCFI can do for any
// book without it being open.
const CFI_COMPARER = new EpubCFI();
function compareHighlights(a: Highlight, b: Highlight, by: ExportPrefs["sortBy"]): number {
	if (by === "book") {
		try {
			const r = (CFI_COMPARER as unknown as { compare(x: string, y: string): number }).compare(a.cfiRange, b.cfiRange);
			if (r !== 0) return r;
		} catch {
			// A malformed CFI just falls through to the time order below.
		}
	}
	return a.created - b.created;
}

// Fill {{name}} placeholders, and keep a {{#name}}…{{/name}} block only when that
// value isn't empty — without it, a highlight with no note would export a bare
// "Note:" label.
function renderTemplate(tpl: string, vars: Record<string, string>): string {
	// The newline after a closing tag goes with the block when it is dropped, and
	// stays when it is kept — otherwise a kept block glues itself to the next line.
	let out = tpl.replace(/\{\{#(\w+)\}\}([\s\S]*?)\{\{\/\1\}\}(\n?)/g, (_m, key: string, body: string, nl: string) =>
		vars[key]?.trim() ? body + nl : ""
	);
	out = out.replace(/\{\{(\w+)\}\}/g, (_m, key: string) => vars[key] ?? "");
	// An empty value in the middle of a "a · b · c" line leaves stray separators.
	out = out
		.replace(/(?: · ){2,}/g, " · ")
		.replace(/\*\s*·\s*/g, "*")
		.replace(/\s*·\s*\*/g, "*")
		.replace(/\n{3,}/g, "\n\n");
	return out.trim();
}

// The template that reproduces what the field toggles currently produce, used to
// prefill the box so custom templates start from something familiar.
function defaultTemplate(ep: ExportPrefs): string {
	const lines: string[] = [`> ${ep.showIndex ? "**{{index}}.** " : ""}{{text}}`];
	if (ep.showNote) lines.push("", `{{#note}}**${tr("备注", "Note", "備註", "Nota")}：** {{note}}{{/note}}`);
	const meta: string[] = [];
	if (ep.showChapter) meta.push("{{chapter}}");
	if (ep.showPage) meta.push(tr("第 {{page}} 页", "Page {{page}}", "第 {{page}} 頁", "Pagina {{page}}"));
	if (ep.showDate) meta.push("{{date}}");
	if (ep.showColor) meta.push("{{color}}");
	if (meta.length) lines.push("", `*${meta.join(" · ")}*`);
	return lines.join("\n");
}

// Hue names for colors picked with the wheel: "浅粉" says more than "custom",
// and costs the reader nothing to set up.
const HUE_NAMES: { max: number; zh: string; en: string; tw: string; it: string }[] = [
	{ max: 15, zh: "红", en: "red", tw: "紅", it: "rosso" },
	{ max: 45, zh: "橙", en: "orange", tw: "橙", it: "arancione" },
	{ max: 70, zh: "黄", en: "yellow", tw: "黃", it: "giallo" },
	{ max: 150, zh: "绿", en: "green", tw: "綠", it: "verde" },
	{ max: 195, zh: "青", en: "cyan", tw: "青", it: "ciano" },
	{ max: 250, zh: "蓝", en: "blue", tw: "藍", it: "blu" },
	{ max: 290, zh: "紫", en: "purple", tw: "紫", it: "viola" },
	{ max: 325, zh: "品红", en: "magenta", tw: "洋紅", it: "magenta" },
	{ max: 350, zh: "粉", en: "pink", tw: "粉", it: "rosa" },
	{ max: 361, zh: "红", en: "red", tw: "紅", it: "rosso" },
];

function autoColorName(value: string): string {
	const { h, s, v } = hexToHsv(rgbaToHex(value));
	if (s < 0.12) return v > 0.8 ? tr("浅灰", "Light grey", "淺灰", "Grigio chiaro") : tr("灰", "Grey", "灰", "Grigio");
	const hue = HUE_NAMES.find((x) => h < x.max) ?? HUE_NAMES[0];
	const name = tr(hue.zh, hue.en, hue.tw, hue.it);
	if (s < 0.4) return tr(`浅${name}`, `Light ${name}`, `淺${name}`, `${name} chiaro`);
	if (v < 0.45) return tr(`深${name}`, `Dark ${name}`, `深${name}`, `${name} scuro`);
	return name;
}

// Display name of a highlight color: the preset's name, or one read off the hue.
function colorLabel(value: string): string {
	const c = HIGHLIGHT_COLORS.find((x) => x.value === value);
	return c ? tr(c.name, c.en, c.tw, c.it) : autoColorName(value);
}

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

// Selection-popup icons match the color dots beside them (18px).
const TOOLBAR_ICON_PX = 18;
// Icon buttons in that popup: no button chrome at all (the default background
// would show as a white pill behind the icon), and a box exactly the size of
// the dots so the icon is centred against them rather than stretched.
const TOOLBAR_ICON_BTN_STYLE =
	`${FLAT_BTN_STYLE} background: transparent; display: flex; align-items: center; justify-content: center; ` +
	`width: ${TOOLBAR_ICON_PX}px; height: ${TOOLBAR_ICON_PX}px;`;
// Both cross-page icons share this pencil, so they read as one pair; only the
// mark at the lower right differs (a line to start, a check to finish).
const PENCIL_PATH = "M15.5 3.5a2.12 2.12 0 0 1 3 3L8 17l-4 1 1-4Z";
const PENCIL_MARK_START = "M14 20.5h7";
const PENCIL_MARK_END = "m14 18.5 2.5 2.5 4.5-4.5";
function drawPencilIcon(btn: HTMLElement, mark: string) {
	const svg = btn.createSvg("svg", {
		attr: {
			xmlns: "http://www.w3.org/2000/svg", viewBox: "0 0 24 24", fill: "none",
			stroke: "currentColor", "stroke-width": "2", "stroke-linecap": "round", "stroke-linejoin": "round",
		},
	});
	svg.createSvg("path", { attr: { d: PENCIL_PATH } });
	svg.createSvg("path", { attr: { d: mark } });
	sizeToolbarIcon(btn);
}

function sizeToolbarIcon(btn: HTMLElement) {
	const svg = btn.querySelector("svg");
	if (!svg) return;
	svg.setAttribute("width", `${TOOLBAR_ICON_PX}`);
	svg.setAttribute("height", `${TOOLBAR_ICON_PX}`);
	// setCssStyles is what Obsidian gives an SVGElement — addClass exists only on
	// HTMLElement, and calling it here threw, taking the rest of the popup with it.
	// Carries the size, the stroke weight Obsidian's .svg-icon would otherwise
	// thin, and the nudge that lines the pencil up with the round swatches.
	svg.setCssStyles({
		width: `${TOOLBAR_ICON_PX}px`,
		height: `${TOOLBAR_ICON_PX}px`,
		flexShrink: "0",
		strokeWidth: "2",
		transform: "translateY(5%)",
	});
}

// Rainbow shown on the "custom color" swatch when a preset is active.
const RAINBOW_GRADIENT = "conic-gradient(#f43f5e, #f59e0b, #eab308, #22c55e, #3b82f6, #a855f7, #f43f5e)";

export default class EpubReaderPlugin extends Plugin {
	data: PluginData = DEFAULT_DATA;
	// Annotations as they stood in data.json before they moved into the vault.
	// Kept, never rewritten: a reader who downgrades still finds them there.
	legacyBooks: Record<string, BookRecord> = {};
	// bookPath -> the file in the annotations folder holding it.
	private sidecarFor = new Map<string, string>();
	// bookPath -> what was last written, so an unchanged book isn't rewritten.
	private lastWritten = new Map<string, string>();
	// Files left behind by a book that was renamed; removed after the new one lands.
	private staleSidecars: string[] = [];
	// Books whose file name may no longer match, checked on the next write.
	private renamedBooks = new Set<string>();

	async onload() {
		const loaded = (await this.loadData()) as Partial<PluginData> | null;
		this.data = Object.assign({}, DEFAULT_DATA, loaded);
		// prefs is a nested object, so merge it explicitly to keep defaults for any
		// field a previously-saved (older) prefs object is missing.
		this.data.prefs = Object.assign({}, DEFAULT_DATA.prefs, loaded?.prefs);
		this.data.storage = Object.assign({}, DEFAULT_STORAGE, loaded?.storage);
		currentLang = resolveLang(this.data.prefs.language);

		// Annotations live in the vault; data.json keeps the frozen snapshot from
		// before the move. Derived caches older versions wrote there are dropped
		// here, so the next save leaves them behind for good.
		this.legacyBooks = {};
		for (const [bookPath, rec] of Object.entries(loaded?.books ?? {})) {
			this.legacyBooks[bookPath] = {
				highlights: rec.highlights ?? [],
				lastCfi: rec.lastCfi,
				colorFilter: rec.colorFilter,
			};
		}
		this.data.books = {};
		await this.loadSidecars();
		await this.migrateLegacyBooks();

		this.registerView(VIEW_TYPE_EPUB, (leaf) => new EpubView(leaf, this));

		// A book's highlights are filed under its vault path, so renaming an epub or
		// moving it to another folder would otherwise orphan every highlight it has.
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (file instanceof TFolder) {
					// Renaming a folder moves every book inside it at once.
					const from = `${oldPath}/`;
					for (const bookPath of Object.keys(this.data.books)) {
						if (bookPath.startsWith(from)) this.moveBookRecord(bookPath, `${file.path}/${bookPath.slice(from.length)}`);
					}
					void this.saveBookData();
					return;
				}
				if (!(file instanceof TFile) || file.extension.toLowerCase() !== "epub") return;
				this.moveBookRecord(oldPath, file.path);
				void this.saveBookData();
			})
		);
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
					this.exportHighlights(view.file?.path ?? "", (cfi) => view.getPageLabel(cfi), undefined, chapterLookup(view.book).labelOf)
				);
				return true;
			},
		});

		this.addCommand({
			id: "merge-highlight-exports",
			name: tr("合并已导出的高亮摘录", "Merge exported highlight notes", "合併已匯出的高亮摘錄", "Unisci le note di evidenziazioni esportate"),
			callback: () => new MergeExportsModal(this.app, this).open(),
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
		// data.json carries settings and the frozen pre-move snapshot; the live
		// annotations go to one file per book in the vault.
		await this.saveData({
			books: this.legacyBooks,
			prefs: this.data.prefs,
			storage: this.data.storage,
			export: this.data.export,
			seenGuide: this.data.seenGuide,
			seenVersion: this.data.seenVersion,
		});
		await this.flushSidecars();
	}

	// Rebuild any open reader views so a language change takes effect immediately.
	reloadOpenViews() {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_EPUB)) {
			const view = leaf.view;
			if (view instanceof EpubView && view.file) void view.onLoadFile(view.file);
		}
	}

	// A cheap content fingerprint: the size plus a hash of the first stretch of
	// bytes. Enough to tell one edition of a book from another.
	static fingerprint(buffer: ArrayBuffer): string {
		const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, 262144));
		let hash = 0x811c9dc5;
		for (let i = 0; i < bytes.length; i++) {
			hash ^= bytes[i];
			hash = Math.imul(hash, 0x01000193) >>> 0;
		}
		return hash.toString(16);
	}

	// Called when a book is opened. If the file behind the path is a different one
	// than the highlights were made against, they can never line up again — so the
	// old file is set aside intact and the book starts fresh.
	async checkBookFingerprint(bookPath: string, buffer: ArrayBuffer) {
		const record = this.getBookRecord(bookPath);
		const size = buffer.byteLength;
		const hash = EpubReaderPlugin.fingerprint(buffer);
		if (record.bookSize === undefined || record.bookHash === undefined) {
			record.bookSize = size;
			record.bookHash = hash;
			await this.saveBookData();
			return;
		}
		if (record.bookSize === size && record.bookHash === hash) return;
		if (record.highlights.length) {
			const archived = await this.archiveSidecar(bookPath);
			new Notice(
				tr(
					`这本书的文件已更换，原有 ${record.highlights.length} 条批注保留在「${archived ?? "原文件"}」，本书重新开始记录`,
					`This book's file has been replaced; its ${record.highlights.length} annotations are kept in "${archived ?? "the previous file"}" and the book starts fresh`,
					`這本書的檔案已更換，原有 ${record.highlights.length} 條批註保留在「${archived ?? "原檔案"}」，本書重新開始記錄`,
					`Il file di questo libro è stato sostituito; le ${record.highlights.length} annotazioni restano in "${archived ?? "il file precedente"}" e il libro riparte da zero`
				)
			);
		}
		record.highlights = [];
		record.lastCfi = undefined;
		record.bookSize = size;
		record.bookHash = hash;
		await this.saveBookData();
	}

	// Move a book's file aside, flagged so it is never loaded again, and free the
	// name for the fresh one.
	private async archiveSidecar(bookPath: string): Promise<string | null> {
		const current = this.sidecarFor.get(bookPath);
		if (!current) return null;
		const adapter = this.app.vault.adapter;
		const stamp = new Date().toISOString().slice(0, 10);
		const target = normalizePath(current.replace(/\.json$/i, ` (${tr("旧版", "previous", "舊版", "precedente")} ${stamp}).json`));
		try {
			const body = JSON.parse(await adapter.read(current)) as SidecarFile;
			body.archived = true;
			await adapter.write(target, JSON.stringify(body, null, "\t"));
			await adapter.remove(current);
		} catch {
			return null;
		}
		this.sidecarFor.delete(bookPath);
		this.lastWritten.delete(bookPath);
		return target;
	}

	// Re-file a book's record under its new path, folding it into whatever record
	// already sits there (a book opened once at the destination leaves an empty
	// one). Views showing the book follow, so their next save lands in the right
	// place.
	moveBookRecord(oldPath: string, newPath: string) {
		const record = this.data.books[oldPath];
		if (!record || oldPath === newPath) return;
		const existing = this.data.books[newPath];
		if (existing) {
			const seen = new Set(existing.highlights.map((h) => h.id));
			for (const h of record.highlights) if (!seen.has(h.id)) existing.highlights.push(h);
			existing.lastCfi = existing.lastCfi ?? record.lastCfi;
			existing.colorFilter = existing.colorFilter ?? record.colorFilter;
		} else {
			this.data.books[newPath] = record;
		}
		delete this.data.books[oldPath];
		// Keep the same file for now — renaming the folder around a book leaves its
		// own name unchanged, and the file it lives in is still the right one. The
		// next write checks whether the name should change and only then swaps it.
		const previous = this.sidecarFor.get(oldPath);
		if (previous) {
			this.sidecarFor.delete(oldPath);
			this.sidecarFor.set(newPath, previous);
			this.lastWritten.delete(newPath);
			this.renamedBooks.add(newPath);
		}
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_EPUB)) {
			const view = leaf.view;
			if (view instanceof EpubView && view.filePath === oldPath) view.filePath = newPath;
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
	buildHighlightsMarkdown(
		path: string,
		pageLabel?: (cfiRange: string) => string,
		ids?: Set<string>,
		chapterLabel?: (cfiRange: string) => string
	): string | null {
		const record = this.data.books[path];
		if (!record || record.highlights.length === 0) return null;

		const ep = this.exportPrefs;
		const bookTitle = path.split("/").pop()?.replace(/\.epub$/i, "") ?? "";
		const picked = ids ? record.highlights.filter((h) => ids.has(h.id)) : record.highlights;
		if (picked.length === 0) return null;
		const sorted = [...picked].sort((a, b) => compareHighlights(a, b, ep.sortBy));

		// The book name is already the file (note) title, so the H1 omits it to
		// avoid showing the name twice.
		const title = tr("高亮摘录", "Highlights", "高亮摘錄", "Evidenziazioni");
		const count = tr(`共 ${sorted.length} 条高亮`, `${sorted.length} highlights`, `共 ${sorted.length} 條高亮`, `${sorted.length} evidenziazioni`);
		const lines: string[] = [`# ${title}`, "", `> ${count}`, ""];

		// One group per chapter or color; reading order keeps a single unnamed group.
		const groups = new Map<string, Highlight[]>();
		for (const h of sorted) {
			const key =
				ep.groupBy === "chapter"
					? chapterLabel?.(h.cfiRange) || tr("未知章节", "Unknown chapter", "未知章節", "Capitolo sconosciuto")
					: ep.groupBy === "color"
						? colorLabel(h.color)
						: "";
			const bucket = groups.get(key);
			if (bucket) bucket.push(h);
			else groups.set(key, [h]);
		}

		let n = 0;
		for (const [key, items] of groups) {
			// A single group has nothing to separate, so its heading is just noise.
			if (key && groups.size > 1) lines.push(`## ${key}`, "");
			for (const h of items) {
				n++;
				const text = h.text.replace(/\n+/g, " ");
				const page = pageLabel?.(h.cfiRange) ?? "";
				const chapter = chapterLabel?.(h.cfiRange) ?? "";
				const when = new Date(h.created);
				if (ep.useTemplate && ep.template.trim()) {
					// Group headings and the separator stay the plugin's own, so a merge
					// can still find where one highlight ends and the next begins.
					lines.push(
						renderTemplate(ep.template, {
							index: `${n}`,
							text,
							note: h.note ?? "",
							page: page === "—" ? "" : page,
							chapter,
							date: when.toLocaleDateString(),
							time: when.toLocaleTimeString(),
							color: colorLabel(h.color),
							book: bookTitle,
						}),
						""
					);
					lines.push("---", "");
					continue;
				}
				const num = ep.showIndex ? `**${n}.** ` : "";
				lines.push(`> ${num}${text}`);
				lines.push("");
				if (ep.showNote && h.note) {
					lines.push(`**${tr("备注", "Note", "備註", "Nota")}：** ${h.note}`);
					lines.push("");
				}
				// Meta line: only the fields that aren't already the group heading.
				const meta: string[] = [];
				if (ep.showChapter && ep.groupBy !== "chapter" && chapter) meta.push(chapter);
				if (ep.showPage && page && page !== "—") {
					meta.push(tr(`第 ${page} 页`, `Page ${page}`, `第 ${page} 頁`, `Pagina ${page}`));
				}
				if (ep.showDate) meta.push(when.toLocaleDateString());
				if (ep.showColor && ep.groupBy !== "color") meta.push(colorLabel(h.color));
				if (meta.length) lines.push(`*${meta.join(" · ")}*`, "");
				lines.push("---", "");
			}
		}
		return lines.join("\n");
	}

	get storagePrefs(): StoragePrefs {
		if (!this.data.storage) this.data.storage = { ...DEFAULT_STORAGE };
		return this.data.storage;
	}

	// ---- annotations on disk ----

	private serializeBook(bookPath: string): string {
		const rec = this.data.books[bookPath];
		const payload: SidecarFile = {
			version: 1,
			book: bookPath,
			bookSize: rec.bookSize,
			bookHash: rec.bookHash,
			highlights: rec.highlights,
			lastCfi: rec.lastCfi,
			colorFilter: rec.colorFilter,
		};
		return JSON.stringify(payload, null, "\t");
	}

	// A file named after the book, so the folder stays readable; the book's own
	// path inside the file is what actually binds the two.
	private freeSidecarName(bookPath: string, ownedAlready?: string): string {
		const folder = this.storagePrefs.folder.replace(/^\/+|\/+$/g, "");
		const dir = folder ? `${folder}/` : "";
		const stem = (bookPath.split("/").pop() ?? "book").replace(/\.epub$/i, "").replace(/[\\/:*?"<>|]/g, "-");
		const taken = new Set(this.sidecarFor.values());
		// The caller's own file doesn't count as taken, or a book would rename its
		// file every time just to avoid itself.
		if (ownedAlready) taken.delete(ownedAlready);
		let name = normalizePath(`${dir}${stem}.json`);
		for (let n = 2; taken.has(name); n++) name = normalizePath(`${dir}${stem} (${n}).json`);
		return name;
	}

	async loadSidecars() {
		this.sidecarFor.clear();
		this.lastWritten.clear();
		const folder = this.storagePrefs.folder.replace(/^\/+|\/+$/g, "");
		const adapter = this.app.vault.adapter;
		if (!folder || !(await adapter.exists(folder))) return;
		const listing = await adapter.list(folder);
		for (const file of listing.files) {
			if (!file.toLowerCase().endsWith(".json")) continue;
			try {
				const parsed = JSON.parse(await adapter.read(file)) as SidecarFile;
				if (!parsed?.book || !Array.isArray(parsed.highlights)) continue;
				if (parsed.archived) continue;
				this.data.books[parsed.book] = {
					highlights: parsed.highlights,
					bookSize: parsed.bookSize,
					bookHash: parsed.bookHash,
					lastCfi: parsed.lastCfi,
					colorFilter: parsed.colorFilter,
				};
				this.sidecarFor.set(parsed.book, file);
				this.lastWritten.set(parsed.book, this.serializeBook(parsed.book));
			} catch {
				new Notice(tr(`无法读取批注文件「${file}」`, `Could not read annotation file "${file}"`, `無法讀取批註檔案「${file}」`, `Impossibile leggere il file "${file}"`));
			}
		}
	}

	// Writes only the books whose contents actually changed.
	private async flushSidecars() {
		const adapter = this.app.vault.adapter;
		const folder = this.storagePrefs.folder.replace(/^\/+|\/+$/g, "");
		for (const [bookPath, rec] of Object.entries(this.data.books)) {
			// A book that has been opened but not marked up needs no file yet.
			if (!rec.highlights.length && !rec.lastCfi) continue;
			const body = this.serializeBook(bookPath);
			if (this.lastWritten.get(bookPath) === body) continue;
			if (folder && !(await adapter.exists(folder))) await adapter.mkdir(folder);
			let target = this.sidecarFor.get(bookPath);
			if (target && this.renamedBooks.delete(bookPath)) {
				// The book was renamed: move its file only if the name really changed.
				const wanted = this.freeSidecarName(bookPath, target);
				if (wanted !== target) {
					this.staleSidecars.push(target);
					target = wanted;
					this.sidecarFor.set(bookPath, target);
				}
			}
			if (!target) {
				target = this.freeSidecarName(bookPath);
				this.sidecarFor.set(bookPath, target);
			}
			await adapter.write(target, body);
			this.lastWritten.set(bookPath, body);
		}
		// Only once the replacements are safely written.
		const inUse = new Set(this.sidecarFor.values());
		while (this.staleSidecars.length) {
			const old = this.staleSidecars.pop() as string;
			// A book may have been re-pointed at this very file in the meantime.
			if (inUse.has(old)) continue;
			try {
				if (await adapter.exists(old)) await adapter.remove(old);
			} catch {
				// A file already gone, or removed by hand: nothing to do.
			}
		}
	}

	// One-time move of whatever data.json still holds into the annotations folder.
	// Idempotent by design: a book already present is merged highlight by
	// highlight, so a folder synced from another machine is never overwritten.
	private async migrateLegacyBooks() {
		const storage = this.storagePrefs;
		if (storage.migratedAt) return;
		const carried = Object.entries(this.legacyBooks).filter(([, r]) => r.highlights.length > 0 || r.lastCfi);
		if (carried.length) {
			await this.writeMigrationBackup();
			for (const [bookPath, rec] of carried) {
				const live = this.data.books[bookPath];
				if (!live) {
					this.data.books[bookPath] = { highlights: [...rec.highlights], lastCfi: rec.lastCfi, colorFilter: rec.colorFilter };
					continue;
				}
				const seen = new Set(live.highlights.map((h) => h.id));
				for (const h of rec.highlights) if (!seen.has(h.id)) live.highlights.push(h);
				live.lastCfi = live.lastCfi ?? rec.lastCfi;
			}
			new Notice(
				tr(
					`批注已移到「${storage.folder}」（${carried.length} 本书），data.json 里的原始副本保留未动`,
					`Annotations moved to "${storage.folder}" (${carried.length} books); the original copy in data.json is left untouched`,
					`批註已移到「${storage.folder}」（${carried.length} 本書），data.json 裡的原始副本保留未動`,
					`Annotazioni spostate in "${storage.folder}" (${carried.length} libri); la copia originale in data.json resta intatta`
				)
			);
		}
		storage.migratedAt = Date.now();
		await this.saveBookData();
	}

	private async writeMigrationBackup() {
		const dir = this.manifest.dir;
		if (!dir) return;
		const adapter = this.app.vault.adapter;
		const target = normalizePath(`${dir}/data-backup-${this.manifest.version}.json`);
		try {
			if (await adapter.exists(target)) return;
			const source = normalizePath(`${dir}/data.json`);
			if (await adapter.exists(source)) await adapter.write(target, await adapter.read(source));
		} catch {
			new Notice(tr("批注备份写入失败，已中止迁移", "Could not write the annotation backup; migration stopped", "批註備份寫入失敗，已中止遷移", "Backup non riuscito; migrazione interrotta"));
			throw new Error("backup failed");
		}
	}

	// Point the annotations at another folder, carrying the existing files over:
	// everything is rewritten there, and the old copies are removed afterwards.
	async setAnnotationFolder(folder: string): Promise<number> {
		const clean = folder.replace(/^\/+|\/+$/g, "");
		if (clean === this.storagePrefs.folder) return 0;
		for (const file of this.sidecarFor.values()) this.staleSidecars.push(file);
		this.sidecarFor.clear();
		this.lastWritten.clear();
		this.storagePrefs.folder = clean;
		await this.saveBookData();
		return this.sidecarFor.size;
	}

	// How many books currently have a file of their own.
	annotationFileCount(): number {
		return this.sidecarFor.size;
	}

	// ---- per-device pagination cache ----

	private visualCacheKey(bookPath: string): string {
		return `epub-reader-highlighter:pages:${bookPath}`;
	}

	loadVisualCache(bookPath: string): VisualCache | null {
		const raw = this.app.loadLocalStorage(this.visualCacheKey(bookPath)) as VisualCache | null;
		return raw && Array.isArray(raw.cfis) && Array.isArray(raw.counts) ? raw : null;
	}

	saveVisualCache(bookPath: string, cache: VisualCache) {
		this.app.saveLocalStorage(this.visualCacheKey(bookPath), cache);
	}

	get exportPrefs(): ExportPrefs {
		if (!this.data.export) this.data.export = { ...DEFAULT_EXPORT };
		// Prefs written by an earlier version are missing every field added since,
		// and reading one of those would be undefined. Patch them in place — a fresh
		// merged object each call would drop mutations made to the previous one.
		const ex = this.data.export as unknown as Record<string, unknown>;
		for (const [key, value] of Object.entries(DEFAULT_EXPORT)) {
			if (ex[key] === undefined) ex[key] = value;
		}
		return this.data.export;
	}

	async exportHighlights(
		path: string,
		pageLabel?: (cfiRange: string) => string,
		ids?: Set<string>,
		chapterLabel?: (cfiRange: string) => string,
		folderOverride?: string
	) {
		const markdown = this.buildHighlightsMarkdown(path, pageLabel, ids, chapterLabel);
		if (markdown === null) {
			new Notice(tr("这本书还没有任何高亮记录", "This book has no highlights yet", "這本書還沒有任何高亮記錄", "Questo libro non ha ancora evidenziazioni"));
			return;
		}
		const bookName = path.split("/").pop()?.replace(/\.epub$/i, "") ?? "epub";
		const folder = await this.ensureExportFolder(folderOverride);
		if (folder === null) return;
		const name = tr(
			`${bookName} - 高亮摘录`,
			`${bookName} - Highlights`,
			`${bookName} - 高亮摘錄`,
			`${bookName} - Evidenziazioni`
		);
		await this.writeStampedNote(name, markdown, folder);
	}

	// Resolve the export folder, creating it when missing. null = it can't be made.
	async ensureExportFolder(folderOverride?: string): Promise<string | null> {
		const folder = (folderOverride ?? this.exportPrefs.folder).replace(/^\/+|\/+$/g, "");
		if (folder && !(this.app.vault.getAbstractFileByPath(folder) instanceof TFolder)) {
			try {
				await this.app.vault.createFolder(folder);
			} catch {
				new Notice(tr(`无法创建文件夹「${folder}」`, `Could not create folder "${folder}"`, `無法建立資料夾「${folder}」`, `Impossibile creare la cartella "${folder}"`));
				return null;
			}
		}
		return folder;
	}

	// Every export and every merge lands in its own file, stamped to the minute,
	// so nothing existing is ever overwritten.
	async writeStampedNote(name: string, markdown: string, folder: string) {
		const d = new Date();
		const pad = (n: number) => `${n}`.padStart(2, "0");
		const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
		const stem = `${name} ${stamp}`.replace(/[\\/:*?"<>|]/g, "-");
		const dir = folder ? `${folder}/` : "";
		let outPath = normalizePath(`${dir}${stem}.md`);
		for (let n = 2; this.app.vault.getAbstractFileByPath(outPath); n++) {
			outPath = normalizePath(`${dir}${stem} (${n}).md`);
		}
		const file = await this.app.vault.create(outPath, markdown);
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

	// Changing the folder moves every annotation file, so it asks first and says
	// what happened afterwards.
	private moveAnnotations(folder: string, revert?: () => void) {
		const clean = folder.replace(/^\/+|\/+$/g, "");
		if (clean === this.plugin.storagePrefs.folder) return;
		const count = this.plugin.annotationFileCount();
		new ConfirmModal(
			this.app,
			tr(
				`将把 ${count} 个批注文件移到「${clean || "库根目录"}」，原位置的文件会在移动完成后删除。`,
				`${count} annotation files will be moved to "${clean || "the vault root"}"; the originals are removed once the move finishes.`,
				`將把 ${count} 個批註檔案移到「${clean || "庫根目錄"}」，原位置的檔案會在移動完成後刪除。`,
				`${count} file di annotazioni verranno spostati in "${clean || "la radice"}"; gli originali sono rimossi al termine.`
			),
			tr("移动", "Move", "移動", "Sposta"),
			() => {
				void this.plugin.setAnnotationFolder(clean).then((moved) => {
					new Notice(
						tr(
							`已移动 ${moved} 个批注文件到「${clean || "库根目录"}」`,
							`Moved ${moved} annotation files to "${clean || "the vault root"}"`,
							`已移動 ${moved} 個批註檔案到「${clean || "庫根目錄"}」`,
							`Spostati ${moved} file in "${clean || "la radice"}"`
						)
					);
					this.display();
				});
			},
			revert
		).open();
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

		// ---- Storage ----
		new Setting(containerEl).setName(tr("批注存储", "Annotation storage", "批註儲存", "Archiviazione")).setHeading();
		new Setting(containerEl)
			.setName(tr("批注文件夹", "Annotation folder", "批註資料夾", "Cartella delle annotazioni"))
			.setDesc(
				tr(
					"1. 每本书的高亮存成这个文件夹里的一个 .json 文件\n2. 文件在你的库里，任何同步工具都会带上；修改一本书只会传输相关文件\n3. 换文件夹时，既有的文件会同步搬运\n4. Obsidian 默认不显示 .json，所以侧边栏里这个文件夹看起来是空的。可用访达打开库文件夹，或到「选项 → 文件与链接 → 检测所有文件扩展名」打开显示",
					"1. Each book's highlights are one .json file in this folder\n2. The files sit in your vault, so any sync tool carries them; editing one book transfers only the files involved\n3. Changing the folder moves the existing files along with it\n4. Obsidian doesn't show .json by default, so this folder looks empty in the sidebar. Open the vault in your file manager, or turn on Settings → Files and links → Detect all file extensions",
					"1. 每本書的高亮存成這個資料夾裡的一個 .json 檔案\n2. 檔案在你的庫裡，任何同步工具都會帶上；修改一本書只會傳輸相關檔案\n3. 換資料夾時，既有的檔案會同步搬運\n4. Obsidian 預設不顯示 .json，所以側邊欄裡這個資料夾看起來是空的。可用 Finder 開啟庫資料夾，或到「選項 → 檔案與連結 → 偵測所有副檔名」打開顯示",
					"1. Le evidenziazioni di ogni libro stanno in un file .json di questa cartella\n2. I file sono nella cassaforte, quindi qualsiasi sincronizzazione li porta con sé; modificare un libro trasferisce solo i file interessati\n3. Cambiando cartella i file esistenti vengono spostati insieme\n4. Obsidian non mostra i .json, quindi nella barra laterale la cartella sembra vuota. Aprila nel gestore file oppure attiva Impostazioni → File e collegamenti → Rileva tutte le estensioni"
				)
			)
			.then((row) => row.descEl.setCssStyles({ whiteSpace: "pre-line" }))
			.addText((t) => {
				t.setPlaceholder(DEFAULT_STORAGE.folder);
				t.setValue(this.plugin.storagePrefs.folder);
				t.inputEl.onblur = () => this.moveAnnotations(t.getValue().trim() || DEFAULT_STORAGE.folder, () => t.setValue(this.plugin.storagePrefs.folder));
			})
			.addExtraButton((b) =>
				b
					.setIcon("folder")
					.setTooltip(tr("浏览文件夹", "Browse folders", "瀏覽資料夾", "Sfoglia le cartelle"))
					.onClick(() =>
						new FolderPickerModal(this.app, (f) => this.moveAnnotations(f || DEFAULT_STORAGE.folder)).open()
					)
			);

		// ---- Export ----
		new Setting(containerEl).setName(tr("导出", "Export", "匯出", "Esportazione")).setHeading();
		const ep = this.plugin.exportPrefs;

		new Setting(containerEl)
			.setName(tr("导出文件夹", "Export folder", "匯出資料夾", "Cartella di esportazione"))
			.setDesc(
				tr(
					"留空 = 库根目录。可直接粘贴库内相对路径，或点右侧图标浏览。在这里改是全局的，之后每次导出都用它；在导出弹窗里改则只影响那一次，除非勾选「设为默认」。",
					"Empty = vault root. Paste a vault-relative path, or browse with the icon. Changing it here is global and applies to every later export; changing it in the export dialog affects that one export only, unless “set as default” is ticked.",
					"留空 = 庫根目錄。可直接貼上庫內相對路徑，或點右側圖示瀏覽。在這裡改是全域的，之後每次匯出都用它；在匯出彈窗裡改則只影響那一次，除非勾選「設為預設」。",
					"Vuoto = radice. Incolla un percorso relativo o sfoglia con l'icona. Qui la modifica è globale e vale per ogni esportazione successiva; nella finestra di esportazione vale solo per quella volta, salvo spuntare «imposta come predefinito»."
				)
			)
			.addText((t) => {
				t.setPlaceholder(tr("库根目录", "Vault root", "庫根目錄", "Radice della cassaforte"));
				t.setValue(ep.folder);
				t.onChange(async (v) => {
					ep.folder = v.trim().replace(/^\/+|\/+$/g, "");
					await this.plugin.saveBookData();
				});
			})
			.addExtraButton((b) =>
				b
					.setIcon("folder")
					.setTooltip(tr("浏览文件夹", "Browse folders", "瀏覽資料夾", "Sfoglia le cartelle"))
					.onClick(() =>
						new FolderPickerModal(this.app, async (f) => {
							ep.folder = f;
							await this.plugin.saveBookData();
							this.display();
						}).open()
					)
			);

		new Setting(containerEl)
			.setName(tr("分组方式", "Group by", "分組方式", "Raggruppa per"))
			.setDesc(tr("导出的高亮如何排列。", "How exported highlights are arranged.", "匯出的高亮如何排列。", "Come sono disposte le evidenziazioni."))
			.addDropdown((dd) => {
				dd.addOption("reading", tr("不分组", "No grouping", "不分組", "Nessun raggruppamento"));
				dd.addOption("chapter", tr("按章节", "By chapter", "按章節", "Per capitolo"));
				dd.addOption("color", tr("按颜色", "By color", "按顏色", "Per colore"));
				dd.setValue(ep.groupBy);
				dd.onChange(async (v) => {
					ep.groupBy = v as ExportPrefs["groupBy"];
					await this.plugin.saveBookData();
				});
			});

		new Setting(containerEl)
			.setName(tr("排序方式", "Sort by", "排序方式", "Ordina per"))
			.setDesc(
				tr(
					"按书中顺序 = 高亮在书里出现的先后；按划线时间 = 你标记它们的先后。",
					"Book order = where the passages sit in the book; highlight time = the order you marked them.",
					"按書中順序 = 高亮在書裡出現的先後；按劃線時間 = 你標記它們的先後。",
					"Ordine del libro = dove si trovano i passaggi; ora = l'ordine in cui li hai segnati."
				)
			)
			.addDropdown((dd) => {
				dd.addOption("book", tr("按书中顺序", "Book order", "按書中順序", "Ordine del libro"));
				dd.addOption("created", tr("按划线时间", "Highlight time", "按劃線時間", "Ora dell'evidenziazione"));
				dd.setValue(ep.sortBy);
				dd.onChange(async (v) => {
					ep.sortBy = v as ExportPrefs["sortBy"];
					await this.plugin.saveBookData();
				});
			});

		const fields: { key: "showChapter" | "showPage" | "showDate" | "showNote" | "showColor" | "showIndex"; label: string }[] = [
			{ key: "showChapter", label: tr("章节标题", "Chapter", "章節標題", "Capitolo") },
			{ key: "showPage", label: tr("页码", "Page number", "頁碼", "Numero di pagina") },
			{ key: "showDate", label: tr("日期", "Date", "日期", "Data") },
			{ key: "showNote", label: tr("备注", "Note", "備註", "Nota") },
			{ key: "showColor", label: tr("颜色名称", "Color name", "顏色名稱", "Nome del colore") },
			{ key: "showIndex", label: tr("序号", "Numbering", "序號", "Numerazione") },
		];
		// Both modes are built once and shown or hidden as the switch moves: a full
		// re-render of the tab is not something a toggle can rely on.
		const fieldSettings: Setting[] = [];
		let templateEls: HTMLElement[] = [];

		new Setting(containerEl)
			.setName(tr("使用自定义模板", "Use a custom template", "使用自訂模板", "Usa un modello personalizzato"))
			.setDesc(
				tr(
					"打开后每条高亮的排版由模板决定，下面的字段开关不再生效；关掉即回到开关模式。首次打开会用与当前开关等效的模板填好。",
					"With this on, a template decides how each highlight is written and the field toggles below no longer apply; turn it off to return to them. The box is prefilled with the template matching your current toggles.",
					"打開後每條高亮的排版由模板決定，下面的欄位開關不再生效；關掉即回到開關模式。首次打開會用與目前開關等效的模板填好。",
					"Con questa opzione un modello decide come viene scritta ogni evidenziazione e gli interruttori non valgono più; disattivala per tornare a loro. Il riquadro viene precompilato con il modello equivalente."
				)
			)
			.addToggle((t) => {
				t.setValue(ep.useTemplate === true);
				t.onChange(async (v) => {
					ep.useTemplate = v;
					if (v && !ep.template?.trim()) {
						ep.template = defaultTemplate(ep);
						box.setValue(ep.template);
					}
					syncMode();
					await this.plugin.saveBookData();
				});
			});

		const tplSetting = new Setting(containerEl)
			.setName(tr("模板", "Template", "模板", "Modello"))
			.addExtraButton((btn) =>
				btn
					.setIcon("rotate-ccw")
					.setTooltip(tr("恢复默认模板", "Reset to default", "恢復預設模板", "Ripristina il modello"))
					.onClick(async () => {
						ep.template = defaultTemplate(ep);
						box.setValue(ep.template);
						await this.plugin.saveBookData();
					})
			);
		let box!: TextAreaComponent;
		tplSetting.addTextArea((ta) => {
			box = ta;
			ta.setValue(ep.template || defaultTemplate(ep));
			ta.inputEl.rows = 12;
			ta.inputEl.setCssStyles({ width: "100%", minWidth: "260px", fontFamily: "var(--font-monospace)", fontSize: "12px" });
			// Saved on blur: writing the whole data file on every keystroke would be
			// wasteful with a plugin data file this size.
			ta.inputEl.onblur = async () => {
				if (ta.getValue() === ep.template) return;
				ep.template = ta.getValue();
				await this.plugin.saveBookData();
			};
		});
		// Three labelled blocks: a hanging-indent layout wraps badly in the narrow
		// settings column, so each part gets its own line.
		tplSetting.descEl.empty();
		const helpBlock = (label: string, body: string) => {
			const wrap = tplSetting.descEl.createDiv({ cls: "epub-tpl-help" });
			wrap.createDiv({ cls: "epub-tpl-help-label", text: label });
			wrap.createDiv({ text: body });
		};
		helpBlock(
			tr("变量", "Variables", "變數", "Variabili"),
			tr(
				"{{index}} 序号 · {{text}} 原文 · {{note}} 备注 · {{page}} 页码 · {{chapter}} 章节 · {{book}} 书名 · {{date}} 日期 · {{time}} 时间 · {{color}} 颜色",
				"{{index}} · {{text}} · {{note}} · {{page}} · {{chapter}} · {{book}} · {{date}} · {{time}} · {{color}}",
				"{{index}} 序號 · {{text}} 原文 · {{note}} 備註 · {{page}} 頁碼 · {{chapter}} 章節 · {{book}} 書名 · {{date}} 日期 · {{time}} 時間 · {{color}} 顏色",
				"{{index}} · {{text}} · {{note}} · {{page}} · {{chapter}} · {{book}} · {{date}} · {{time}} · {{color}}"
			)
		);
		helpBlock(
			tr("条件", "Condition", "條件", "Condizione"),
			tr(
				"{{#note}}…{{/note}} 之间的内容只在备注非空时才输出，换成别的变量名同理",
				"What sits between {{#note}} and {{/note}} is written only when the note isn't empty; any variable name works the same way",
				"{{#note}}…{{/note}} 之間的內容只在備註非空時才輸出，換成別的變數名同理",
				"Ciò che sta tra {{#note}} e {{/note}} viene scritto solo se la nota non è vuota; vale per qualsiasi variabile"
			)
		);
		helpBlock(
			tr("不用写", "Leave out", "不用寫", "Da omettere"),
			tr(
				"分组标题和每条之间的分隔线由插件输出",
				"Group headings and the separator between entries are written by the plugin",
				"分組標題和每條之間的分隔線由外掛輸出",
				"I titoli dei gruppi e il separatore tra le voci li scrive l'estensione"
			)
		);
		templateEls = [tplSetting.settingEl];

		new Setting(containerEl)
			.setName(tr("导出内容", "Fields to include", "匯出內容", "Campi da includere"))
			.setDesc(tr("每条高亮下方要带哪些信息。", "Which details each highlight carries.", "每條高亮下方要帶哪些資訊。", "Quali dettagli accompagnano ogni evidenziazione."))
			.then((sect) => fieldSettings.push(sect));
		for (const f of fields) {
			const row = new Setting(containerEl).setName(f.label).addToggle((t) => {
				t.setValue(ep[f.key]);
				t.onChange(async (v) => {
					ep[f.key] = v;
					await this.plugin.saveBookData();
				});
			});
			fieldSettings.push(row);
		}

		const syncMode = () => {
			for (const el of templateEls) el.setCssStyles({ display: ep.useTemplate ? "" : "none" });
			for (const st of fieldSettings) st.settingEl.setCssStyles({ display: ep.useTemplate ? "none" : "" });
		};
		syncMode();

		new Setting(containerEl)
			.setName(tr("合并已导出的摘录", "Merge exported notes", "合併已匯出的摘錄", "Unisci le note esportate"))
			.setDesc(
				tr(
					"合并同一本书的多份导出。可选择要合并哪几份、如何分组排序，生成前可预览。重复内容自动去除，其余一律保留。结果写入新文件。",
					"Merge several exports of the same book. Choose which notes to include and how they are grouped and sorted, and preview the result before it is created. Duplicates are removed, everything else is kept. The result is written to a new file.",
					"合併同一本書的多份匯出。可選擇要合併哪幾份、如何分組排序，產生前可預覽。重複內容自動去除，其餘一律保留。結果寫入新檔案。",
					"Unisce più esportazioni dello stesso libro. Scegli quali note includere e come raggrupparle e ordinarle, con anteprima prima della creazione. I duplicati vengono rimossi, tutto il resto viene conservato. Il risultato è scritto in un nuovo file."
				)
			)
			.addButton((b) =>
				b.setButtonText(tr("打开", "Open", "開啟", "Apri")).onClick(() => new MergeExportsModal(this.app, this.plugin).open())
			);

		new Setting(containerEl)
			.setName(tr("更新记录", "Changelog", "更新記錄", "Registro delle modifiche"))
			.setDesc(tr(`当前版本 ${RELEASE_NOTES[0].version}`, `Version ${RELEASE_NOTES[0].version}`, `目前版本 ${RELEASE_NOTES[0].version}`, `Versione ${RELEASE_NOTES[0].version}`))
			.addButton((b) =>
				b
					.setButtonText(tr("查看", "Open", "檢視", "Apri"))
					.onClick(() =>
						new WhatsNewModal(this.app, RELEASE_NOTES, tr("更新记录", "Changelog", "更新記錄", "Registro delle modifiche")).open()
					)
			);

		// Icon guide — the same reference shown once on first open.
		new Setting(containerEl).setName(tr("图标说明", "Icon guide", "圖示說明", "Guida icone")).setHeading();
		for (const e of toolbarGuide()) {
			const s = new Setting(containerEl).setName(e.label).setDesc(e.desc);
			s.descEl.setCssStyles({ whiteSpace: "pre-line" });
			if (e.icon || e.mark) {
				const iconEl = s.nameEl.createSpan({ attr: { style: "margin-left:8px; color:var(--text-muted); vertical-align:middle; display:inline-flex;" } });
				if (e.icon) setIcon(iconEl, e.icon);
				else if (e.mark) drawPencilIcon(iconEl, e.mark);
			}
		}
	}
}

class NoteModal extends Modal {
	private result: string;
	private onSubmit: (note: string) => void | Promise<void>;

	constructor(app: App, initial: string, onSubmit: (note: string) => void | Promise<void>) {
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
function toolbarGuide(): { icon?: string; mark?: string; label: string; desc: string }[] {
	return [
		{ icon: "menu", label: tr("目录", "Table of contents", "目錄", "Sommario"), desc: tr("查看章节目录，点击跳转", "Browse the chapters and jump to one", "檢視章節目錄，點擊跳轉", "Sfoglia i capitoli e salta a uno di essi") },
		{ icon: "message-square-quote", label: tr("复制引用", "Copy quote", "複製引用", "Copia citazione"), desc: tr("把选中的文字复制成「页码·时间 + 引用」格式", "Copy the selected text as a “page · time + quote” block", "把選取文字複製成「頁碼·時間 + 引用」格式", "Copia il testo selezionato come blocco “pagina · ora + citazione”") },
		{ icon: "highlighter", label: tr("高亮菜单", "Highlights menu", "高亮選單", "Menu evidenziazioni"), desc: tr("查看全部高亮、复制全部、导出，及设置默认高光颜色", "View, copy or export all highlights, and set the default highlight color", "檢視全部高亮、複製全部、匯出，及設定預設高光顏色", "Vedi, copia o esporta tutte le evidenziazioni e imposta il colore predefinito") },
		{
			mark: PENCIL_MARK_START,
			label: tr("跨页高亮 · 起点", "Cross-page highlight · start", "跨頁高亮 · 起點", "Evidenziazione multi-pagina · inizio"),
			desc: tr(
				"选中起点文字后点它做标记，然后翻页",
				"Select the opening text, click to mark it, then turn the page",
				"選取起點文字後點它做標記，然後翻頁",
				"Seleziona il testo iniziale, segnalo, poi gira pagina"
			),
		},
		{
			mark: PENCIL_MARK_END,
			label: tr("跨页高亮 · 结束", "Cross-page highlight · finish", "跨頁高亮 · 結束", "Evidenziazione multi-pagina · fine"),
			desc: tr(
				"翻页后选中终点文字，点它把中间整段高亮起来（限同一章内）",
				"Select the closing text after turning pages and click to highlight everything between (within one chapter)",
				"翻頁後選取終點文字，點它把中間整段高亮起來（限同一章內）",
				"Dopo aver girato pagina seleziona il testo finale e clicca per evidenziare tutto (nello stesso capitolo)"
			),
		},
		{ icon: "sliders-horizontal", label: tr("阅读设置", "Reading settings", "閱讀設定", "Impostazioni di lettura"), desc: tr("字体、字号、背景色；点色轮展开取色面板自定义颜色", "Font, text size and background; the color wheel expands an inline picker for any custom color", "字型、字級、背景色；點色輪展開取色面板自訂顏色", "Carattere, dimensione e sfondo; la ruota dei colori apre un selettore integrato") },
		{ label: tr("滚动 / 分页", "Scroll / Paged", "捲動 / 分頁", "Scorri / Pagine"), desc: tr("切换滚动阅读或分页阅读", "Switch between scrolling and paginated reading", "切換捲動或分頁閱讀", "Passa tra lettura a scorrimento o a pagine") },
		{ label: "‹  ›", desc: tr("上一页 / 下一页，也可用键盘方向键", "Previous / next page — the arrow keys work too", "上一頁 / 下一頁，也可用方向鍵", "Pagina precedente / successiva — anche con le frecce") },
		{ label: tr("页码", "Pages", "頁碼", "Pagine"), desc: tr("页码按当前窗口和字号预排全书得出：总数固定、翻页只 +1，打开或改字号后短暂显示「计算中」。在页码框输入数字回车可跳页；滚动模式下显示进度百分比", "Page numbers come from pre-paginating the whole book at your window size and font: the total is fixed and each turn advances by exactly 1; “Calculating” shows briefly after opening or changing the font. Type a number in the page box to jump; scroll mode shows a progress percent instead", "頁碼按目前視窗和字級預排全書得出：總數固定、翻頁只 +1，開啟或改字級後短暫顯示「計算中」。在頁碼框輸入數字按 Enter 可跳頁；捲動模式下顯示進度百分比", "I numeri di pagina derivano dall'impaginazione dell'intero libro alla finestra e al carattere attuali: il totale è fisso e ogni pagina avanza di 1; dopo l'apertura o un cambio di carattere appare brevemente «Calcolo». Digita un numero nella casella per saltare a una pagina; in modalità scorrimento mostra la percentuale di lettura") },
		{
			icon: "download",
			label: tr("导出高亮", "Exporting highlights", "匯出高亮", "Esportare le evidenziazioni"),
			desc: tr(
				"1. 高亮菜单 →「选择导出…」打开弹窗，上排挑要导出哪些：「全部」「今日」「章节选择」和色点（色点按书记住上次的选择）\n2. 弹窗底部的「排序」和「导出到」只影响这一次；勾「设为默认」才写回设置\n3. 插件设置里的「导出文件夹」「分组方式」「排序方式」和几个字段开关是全局默认值\n4. 高亮菜单 →「导出为 Markdown」不经过弹窗，直接导出全部\n5. 每次导出都是一个新文件，文件名带日期时间，永不覆盖旧文件\n6. 想自己决定每条高亮的排版，打开设置里的「使用自定义模板」，用 {{变量}} 写",
				"1. Highlights menu → “Export selected…” opens the dialog; the top row picks what to export: “All”, “Today”, “Select chapter” and the color chips (remembered per book)\n2. “Sort” and “Export to” at the bottom of the dialog affect that one export only; “Set as default” writes them back to settings\n3. “Export folder”, “Group by”, “Sort by” and the field toggles in the plugin settings are the global defaults\n4. Highlights menu → “Export to Markdown” skips the dialog and exports everything\n5. Every export is a new file stamped with the date and time; nothing is ever overwritten\n6. To decide the layout of each highlight yourself, turn on “Use a custom template” in the settings and write it with {{variables}}",
				"1. 高亮選單 →「選擇匯出…」開啟彈窗，上排挑要匯出哪些：「全部」「今日」「章節選擇」和色點（色點按書記住上次的選擇）\n2. 彈窗底部的「排序」和「匯出到」只影響這一次；勾「設為預設」才寫回設定\n3. 外掛設定裡的「匯出資料夾」「分組方式」「排序方式」和幾個欄位開關是全域預設值\n4. 高亮選單 →「匯出為 Markdown」不經過彈窗，直接匯出全部\n5. 每次匯出都是一個新檔案，檔名帶日期時間，永不覆蓋舊檔\n6. 想自己決定每條高亮的排版，打開設定裡的「使用自訂模板」，用 {{變數}} 寫",
				"1. Menu evidenziazioni → «Esporta selezionate…» apre la finestra; la riga in alto sceglie cosa esportare: «Tutte», «Oggi», «Seleziona capitolo» e i pallini colorati (ricordati per libro)\n2. «Ordina» ed «Esporta in» in fondo alla finestra valgono solo per quella esportazione; «Imposta come predefinito» li riscrive nelle impostazioni\n3. «Cartella di esportazione», «Raggruppa per», «Ordina per» e gli interruttori dei campi nelle impostazioni sono i valori predefiniti globali\n4. Menu evidenziazioni → «Esporta in Markdown» salta la finestra ed esporta tutto\n5. Ogni esportazione crea un nuovo file con data e ora: nulla viene mai sovrascritto\n6. Per decidere tu il layout di ogni evidenziazione, attiva «Usa un modello personalizzato» nelle impostazioni e scrivilo con {{variabili}}"
			),
		},
		{
			icon: "git-merge",
			label: tr("合并摘录", "Merging exports", "合併摘錄", "Unire le esportazioni"),
			desc: tr(
				"合并同一本书的多份导出。可选择要合并哪几份、如何分组排序，生成前可预览。重复内容自动去除，其余一律保留。结果写入新文件。",
				"Merge several exports of the same book. Choose which notes to include and how they are grouped and sorted, and preview the result before it is created. Duplicates are removed, everything else is kept. The result is written to a new file.",
				"合併同一本書的多份匯出。可選擇要合併哪幾份、如何分組排序，產生前可預覽。重複內容自動去除，其餘一律保留。結果寫入新檔案。",
				"Unisce più esportazioni dello stesso libro. Scegli quali note includere e come raggrupparle e ordinarle, con anteprima prima della creazione. I duplicati vengono rimossi, tutto il resto viene conservato. Il risultato è scritto in un nuovo file."
			),
		},
		{ icon: "search", label: tr("搜索", "Search", "搜尋", "Cerca"), desc: tr("全书搜索关键词，点击结果跳转", "Search the whole book and jump to a result", "全書搜尋關鍵詞，點擊結果跳轉", "Cerca in tutto il libro e salta a un risultato") },
		{ icon: "more-horizontal", label: tr("更多", "More", "更多", "Altro"), desc: tr("界面语言和使用说明", "Interface language and this quick guide", "介面語言和使用說明", "Lingua dell'interfaccia e questa guida") },
		{ label: tr("自动保存", "Auto-save", "自動儲存", "Salvataggio"), desc: tr("阅读位置、偏好和高亮都会自动保存，重新打开回到上次读到的地方", "Reading position, preferences and highlights are saved automatically; reopening returns to where you left off", "閱讀位置、偏好和高亮都會自動儲存，重新開啟回到上次讀到的地方", "Posizione di lettura, preferenze ed evidenziazioni si salvano da sole; alla riapertura torni dove avevi lasciato") },
		{ label: tr("快捷键", "Shortcuts", "快捷鍵", "Scorciatoie"), desc: tr("⌘⇧H 高亮选中文字；⌘Z 撤销高亮", "Cmd/Ctrl+Shift+H highlights the selection; Cmd/Ctrl+Z undoes it", "⌘⇧H 高亮選取文字；⌘Z 復原高亮", "Cmd/Ctrl+Maiusc+H evidenzia la selezione; Cmd/Ctrl+Z annulla") },
	];
}

// What changed in this release, shown once after an upgrade. Keep it to the
// things a reader would otherwise have to discover by accident; the full guide
// is one button away.
const RELEASE_NOTES: { version: string; lines: () => string[] }[] = [
	{
		version: "0.4.0",
		lines: () => [
			tr(
				"批注改为每本书一个文件，存放在库内的「epub-highlights」文件夹，位置可在设置中修改；任何更改都会同步变动",
				"Annotations are stored as one file per book in the vault's “epub-highlights” folder, configurable in the settings; changes sync along with the rest of the vault",
				"批註改為每本書一個檔案，存放在庫內的「epub-highlights」資料夾，位置可在設定中修改；任何更改都會同步變動",
				"Le annotazioni sono un file per libro nella cartella «epub-highlights», configurabile nelle impostazioni; le modifiche si sincronizzano con il resto della cassaforte"
			),
			tr(
				"高亮定位失效时会按原文重新找回并自动修复，换机器或删除相邻高亮不再导致高亮消失",
				"A highlight whose anchor no longer lands on its passage is found again by its text and repaired, so it no longer disappears after switching machines or deleting a neighbouring highlight",
				"高亮定位失效時會按原文重新找回並自動修復，換機器或刪除相鄰高亮不再導致高亮消失",
				"Un'evidenziazione la cui ancora non trova più il passaggio viene ritrovata dal testo e riparata: non sparisce più cambiando macchina o eliminando quella accanto"
			),
			tr(
				"在已有高亮上重新划线时合并为一条，采用新的范围和颜色",
				"Highlighting over existing highlights folds them into one, with the new extent and color",
				"在已有高亮上重新劃線時合併為一條，採用新的範圍和顏色",
				"Evidenziare sopra evidenziazioni esistenti le unisce in una, con la nuova estensione e il nuovo colore"
			),
			tr(
				"文件被更换时会被识别，原有批注保留在标记为旧版的文件中",
				"A replaced book file is recognised, and the earlier annotations are kept in a file marked as previous",
				"檔案被更換時會被識別，原有批註保留在標記為舊版的檔案中",
				"La sostituzione del file di un libro viene riconosciuta e le annotazioni precedenti restano in un file contrassegnato come precedente"
			),
			tr(
				"分页缓存改为本机存储，不再随库同步，插件数据文件体积大幅下降",
				"The pagination cache is kept on the device rather than in the vault, cutting the plugin's data file down sharply",
				"分頁快取改為本機儲存，不再隨庫同步，外掛資料檔案體積大幅下降",
				"La cache di impaginazione resta sul dispositivo, riducendo molto il file dati dell'estensione"
			),
		],
	},
	{
		version: "0.3.2",
		lines: () => [
			tr(
				"修复在非所属章节显示高亮的问题",
				"Fixed highlights being drawn in chapters they do not belong to",
				"修復在非所屬章節顯示高亮的問題",
				"Corretto il disegno delle evidenziazioni in capitoli a cui non appartengono"
			),
			tr(
				"重命名或移动书籍、以及重命名其所在文件夹时，高亮记录随之更新",
				"Highlights follow a book that is renamed or moved, including a rename of the folder containing it",
				"重新命名或移動書籍、以及重新命名其所在資料夾時，高亮記錄隨之更新",
				"Le evidenziazioni seguono il libro rinominato o spostato, anche rinominando la cartella che lo contiene"
			),
			tr(
				"点击高亮显示操作栏：更换颜色、编辑备注、复制、删除",
				"Clicking a highlight opens a menu: change color, edit note, copy, delete",
				"點擊高亮顯示操作列：更換顏色、編輯備註、複製、刪除",
				"Facendo clic su un'evidenziazione compare un menu: colore, nota, copia, elimina"
			),
		],
	},
	{
		version: "0.3.1",
		lines: () => [
			tr(
				"支持自定义导出模板，可用变量编排每条高亮的排版",
				"Custom export templates, with variables that lay out each highlight",
				"支援自訂匯出模板，可用變數編排每條高亮的排版",
				"Modelli di esportazione personalizzati, con variabili per comporre ogni evidenziazione"
			),
			tr(
				"改进合并：识别自定义格式、匹配短句；内容完全被涵盖的副本会丢弃，有额外内容的副本保留在文末",
				"Merging recognises custom formats and matches short highlights; a copy whose content is already covered is dropped, one carrying anything extra is kept at the end of the note",
				"改進合併：辨識自訂格式、比對短句；內容完全被涵蓋的副本會丟棄，有額外內容的副本保留在文末",
				"L'unione riconosce i formati personalizzati e abbina le evidenziazioni brevi; una copia già contenuta viene scartata, una con contenuto in più resta in fondo alla nota"
			),
		],
	},
	{
		version: "0.3.0",
		lines: () => [
			tr(
				"导出设置：目标文件夹、分组方式、排序方式、字段开关",
				"Export settings: target folder, grouping, sort order, field toggles",
				"匯出設定：目標資料夾、分組方式、排序方式、欄位開關",
				"Impostazioni di esportazione: cartella, raggruppamento, ordinamento, campi"
			),
			tr(
				"新增合并功能，可将同一本书的多份导出合成一份",
				"Added merging, folding several exports of one book into a single note",
				"新增合併功能，可將同一本書的多份匯出合成一份",
				"Aggiunta l'unione di più esportazioni dello stesso libro in una nota"
			),
		],
	},
];

// Semver-ish ordering, enough to tell which entries a reader hasn't seen.
function versionRank(v: string): number {
	const [a = 0, b = 0, c = 0] = v.split(".").map((n) => parseInt(n, 10) || 0);
	return a * 1e6 + b * 1e3 + c;
}

// Everything released since the version last seen. An unknown last-seen version
// (or none) shows just the newest entry rather than the whole history.
function notesSince(seen: string | undefined): typeof RELEASE_NOTES {
	if (!seen) return RELEASE_NOTES.slice(0, 1);
	return RELEASE_NOTES.filter((n) => versionRank(n.version) > versionRank(seen));
}

// Shown on the first book opened after an upgrade, so a change nobody asked to
// see doesn't go unnoticed.
class WhatsNewModal extends Modal {
	private entries: typeof RELEASE_NOTES;
	private heading: string;

	constructor(app: App, entries: typeof RELEASE_NOTES, heading?: string) {
		super(app);
		this.entries = entries.length ? entries : RELEASE_NOTES.slice(0, 1);
		this.heading = heading ?? tr("新版本", "What's new", "新版本", "Novità");
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: this.heading, attr: { style: "margin-top: 0;" } });
		for (const entry of this.entries) {
			contentEl.createEl("div", { text: entry.version, attr: { style: "font-weight:600; margin-top:8px;" } });
			const list = contentEl.createEl("ul");
			for (const line of entry.lines()) list.createEl("li", { text: line, attr: { style: "margin-bottom: 6px;" } });
		}
		const row = contentEl.createDiv({ attr: { style: "margin-top:12px; display:flex; justify-content:flex-end; gap:8px;" } });
		const guide = row.createEl("button", { text: tr("使用说明", "Quick guide", "使用說明", "Guida rapida") });
		guide.onclick = () => {
			this.close();
			new LegendModal(this.app).open();
		};
		const ok = row.createEl("button", { cls: "mod-cta", text: tr("知道了", "Got it", "知道了", "Ho capito") });
		ok.onclick = () => this.close();
	}

	onClose() {
		this.contentEl.empty();
	}
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
			else if (e.mark) drawPencilIcon(iconBox, e.mark);
			else iconBox.setText(e.label.length <= 4 ? e.label : "•");
			const body = row.createDiv({ attr: { style: "flex:1; min-width:0;" } });
			body.createDiv({ text: e.label, attr: { style: "font-weight:600;" } });
			body.createDiv({ text: e.desc, attr: { style: "font-size:12px; color:var(--text-muted); white-space:pre-line;" } });
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
// Which spine item (chapter file) a CFI belongs to. -1 when it can't be read.
function cfiSpinePos(cfiRange: string): number {
	try {
		return (new EpubCFI(cfiRange) as unknown as { spinePos: number }).spinePos ?? -1;
	} catch {
		return -1;
	}
}

// Chapter naming for one book: spine index of a CFI, and the TOC label for that
// index. Used by the export filter and by chapter grouping in the export itself.
function chapterLookup(book: Book) {
	const spineItems = (book.spine as unknown as { spineItems?: { href: string }[] }).spineItems ?? [];
	// Flatten the (possibly nested) TOC and match spine hrefs loosely — TOC and
	// spine often disagree on relative path prefixes ("Text/ch1.xhtml" vs
	// "ch1.xhtml"), which would otherwise degrade every label to "章节 N".
	const flatToc: { href: string; label: string }[] = [];
	const flatten = (items: { href: string; label: string; subitems?: unknown[] }[]) => {
		for (const t of items) {
			flatToc.push({ href: t.href.split("#")[0], label: t.label });
			if (t.subitems?.length) flatten(t.subitems as typeof items);
		}
	};
	flatten((book.navigation as unknown as { toc?: { href: string; label: string; subitems?: unknown[] }[] })?.toc ?? []);
	const posOf = cfiSpinePos;
	// Resolve every TOC entry to a spine index. Matching the href strings directly
	// fails often (the TOC and the spine disagree on path prefixes and on URL
	// encoding), so ask the spine to resolve the href first and only fall back to
	// string matching.
	const unescape = (h: string) => {
		try {
			return decodeURIComponent(h);
		} catch {
			return h;
		}
	};
	const spineGet = (book.spine as unknown as { get?(target: string): { index?: number } | null }).get?.bind(book.spine);
	const labelByIndex = new Map<number, string>();
	for (const t of flatToc) {
		let idx = -1;
		try {
			idx = spineGet?.(t.href)?.index ?? -1;
		} catch {
			idx = -1;
		}
		if (idx < 0) {
			const href = unescape(t.href);
			idx = spineItems.findIndex((sp) => {
				const sh = unescape(sp.href);
				return sh === href || sh.endsWith("/" + href) || href.endsWith("/" + sh);
			});
		}
		if (idx >= 0 && !labelByIndex.has(idx)) labelByIndex.set(idx, t.label.trim());
	}
	// A chapter split across several spine files only names its first one, so walk
	// back to the nearest named one instead of falling straight to "Chapter N".
	const labelAt = (pos: number): string => {
		for (let i = pos; i >= 0; i--) {
			const label = labelByIndex.get(i);
			if (label) return label;
		}
		return tr(`章节 ${pos + 1}`, `Chapter ${pos + 1}`, `章節 ${pos + 1}`, `Capitolo ${pos + 1}`);
	};
	return {
		posOf,
		labelAt,
		labelOf: (cfi: string) => {
			const pos = posOf(cfi);
			return pos >= 0 ? labelAt(pos) : "";
		},
	};
}

// ---- Merging exported notes ----

// One block of an exported note: the highlight id it carries (from the %%hl:…%%
// marker, or the HTML-comment one the first version wrote) and the block exactly
// as written, so a merge can move it without rewriting it.
interface ParsedBlock {
	id: string | null;
	raw: string;
	// The group heading the block sat under, lifted out of the block so a merge
	// can regroup freely — it's the only chapter name a chapter-grouped export
	// carries, since that export leaves the chapter out of the meta line.
	heading: string | null;
}

const HL_ID_RE = /%%hl:([^%\s]+)%%|<!--\s*hl:([^\s>]+)\s*-->/;
// "{book} - Highlights[ 2026-08-18 1730]", in any of the four export languages.
const EXPORT_NAME_RE = /^(.*?) - (?:高亮摘录|高亮摘錄|Highlights|Evidenziazioni)(?:\s|$)/;

// Drop the "# Highlights" + "> N highlights" header the plugin writes itself, so
// it isn't mistaken for something the reader added.
function stripGeneratedHeader(text: string): string {
	return text.replace(/^\s*#\s+[^\n]*\n+(?:>\s*[^\n]*\n+)?/, "");
}

// Split an exported note into its generated blocks and everything the reader put
// around them. Notes written before the markers existed have no fenced region,
// so their blocks have to be recognised by their text instead.
function parseExportNote(content: string): { blocks: ParsedBlock[]; outside: string } {
	const begin = content.indexOf(HL_BEGIN);
	const end = content.indexOf(HL_END);
	let region: string;
	let outside = "";
	if (begin >= 0 && end > begin) {
		region = content.slice(begin + HL_BEGIN.length, end);
		outside = [stripGeneratedHeader(content.slice(0, begin)), content.slice(end + HL_END.length)]
			.map((t) => t.trim())
			.filter(Boolean)
			.join("\n\n");
	} else {
		region = stripGeneratedHeader(content);
	}
	const blocks = region
		.split(/^---$/m)
		.map((b) => b.trim())
		.filter(Boolean)
		.map((chunk) => {
			const head = chunk.match(/^#{1,6}\s+([^\n]*)\n+/);
			const raw = head ? chunk.slice(head[0].length).trim() : chunk;
			const m = raw.match(HL_ID_RE);
			return { id: m ? (m[1] ?? m[2]) : null, raw, heading: head ? head[1].trim() : null };
		})
		.filter((b) => b.raw.length > 0);
	return { blocks, outside };
}

// A block's quoted text, whitespace stripped, for matching a marker-less block
// back to the highlight it came from.
function blockQuote(raw: string): string {
	const line = raw.split("\n").find((l) => l.trimStart().startsWith(">"));
	return (line ?? "").replace(/^\s*>\s*/, "").replace(HL_ID_RE, "").replace(/\s+/g, "");
}

// Chapter name out of a block's meta line ("*chapter · page · date · color*").
function blockChapter(raw: string): string {
	const line = raw.split("\n").find((l) => /^\*[^*].*\*$/.test(l.trim()));
	if (!line) return "";
	for (const part of line.trim().replace(/^\*|\*$/g, "").split(" · ")) {
		if (/^(第\s|Page\s|Pagina\s)/.test(part)) continue;
		if (/\d{4}/.test(part) && /[/\-.]/.test(part)) continue;
		if (HIGHLIGHT_COLORS.some((c) => [c.name, c.en, c.tw, c.it].includes(part))) continue;
		return part;
	}
	return "";
}

// Fold several exported notes for one book into a single new note. The sources
// are only ever read: the result is always a new file, so nothing can be lost.
class MergeExportsModal extends Modal {
	private plugin: EpubReaderPlugin;
	private books = new Map<string, TFile[]>();
	private stem = "";
	private picked = new Set<string>();
	private groupBy: ExportPrefs["groupBy"];
	private sortBy: ExportPrefs["sortBy"];
	// Owns what the preview renders, and is unloaded with the modal.
	private renderHost = new Component();
	private preview!: HTMLElement;

	constructor(app: App, plugin: EpubReaderPlugin) {
		super(app);
		this.plugin = plugin;
		this.groupBy = plugin.exportPrefs.groupBy;
		this.sortBy = plugin.exportPrefs.sortBy;
	}

	onOpen() {
		const { contentEl } = this;
		this.renderHost.load();
		// Same column layout as the export dialog: only the preview scrolls, so the
		// buttons never get pushed out of sight by a long result.
		contentEl.setCssStyles({ display: "flex", flexDirection: "column", maxHeight: "76vh" });
		contentEl.createEl("h3", {
			text: tr("合并高亮摘录", "Merge highlight exports", "合併高亮摘錄", "Unisci le esportazioni"),
			attr: { style: "margin-top: 0; flex-shrink: 0;" },
		});

		for (const f of this.app.vault.getMarkdownFiles()) {
			const m = f.basename.match(EXPORT_NAME_RE);
			if (!m) continue;
			const list = this.books.get(m[1]);
			if (list) list.push(f);
			else this.books.set(m[1], [f]);
		}
		if (this.books.size === 0) {
			contentEl.createEl("p", {
				text: tr("库里没有找到导出的高亮摘录。", "No exported highlight notes found in the vault.", "庫裡沒有找到匯出的高亮摘錄。", "Nessuna nota di evidenziazioni trovata."),
				attr: { style: "color: var(--text-muted);" },
			});
			return;
		}
		const names = [...this.books.keys()].sort();
		this.stem = names[0];

		const row = contentEl.createDiv({ attr: { style: "display:flex; align-items:center; gap:8px; padding:6px 0; flex-wrap:wrap; flex-shrink:0;" } });
		row.createSpan({ text: tr("书", "Book", "書", "Libro"), attr: { style: "color:var(--text-muted);" } });
		const bookSel = row.createEl("select", { cls: "dropdown" });
		for (const n of names) bookSel.createEl("option", { text: n, value: n });
		bookSel.value = this.stem;
		row.createSpan({ text: tr("分组", "Group by", "分組", "Raggruppa"), attr: { style: "color:var(--text-muted); margin-left:8px;" } });
		const groupSel = row.createEl("select", { cls: "dropdown" });
		groupSel.createEl("option", { text: tr("不分组", "No grouping", "不分組", "Nessun raggruppamento"), value: "reading" });
		groupSel.createEl("option", { text: tr("按章节", "By chapter", "按章節", "Per capitolo"), value: "chapter" });
		groupSel.createEl("option", { text: tr("按颜色", "By color", "按顏色", "Per colore"), value: "color" });
		groupSel.value = this.groupBy;
		// A preview already on screen would otherwise still show the old arrangement.
		const refreshPreview = () => {
			if (this.preview.childElementCount) void this.renderPreview();
		};
		groupSel.onchange = () => {
			this.groupBy = groupSel.value as ExportPrefs["groupBy"];
			refreshPreview();
		};
		row.createSpan({ text: tr("排序", "Sort", "排序", "Ordina"), attr: { style: "color:var(--text-muted); margin-left:8px;" } });
		const sortSel = row.createEl("select", { cls: "dropdown" });
		sortSel.createEl("option", { text: tr("按书中顺序", "Book order", "按書中順序", "Ordine del libro"), value: "book" });
		sortSel.createEl("option", { text: tr("按划线时间", "Highlight time", "按劃線時間", "Ora dell'evidenziazione"), value: "created" });
		sortSel.value = this.sortBy;
		sortSel.onchange = () => {
			this.sortBy = sortSel.value as ExportPrefs["sortBy"];
			refreshPreview();
		};

		const list = contentEl.createDiv({ attr: { style: "max-height:28vh; overflow:auto; border-top:1px solid var(--background-modifier-border); border-bottom:1px solid var(--background-modifier-border); padding:4px 0; flex-shrink:0;" } });
		const renderFiles = () => {
			list.empty();
			this.picked.clear();
			const files = [...(this.books.get(this.stem) ?? [])].sort((a, b) => a.stat.mtime - b.stat.mtime);
			for (const f of files) {
				const fileRow = list.createDiv({ attr: { style: "display:flex; gap:8px; align-items:center; padding:5px 0; cursor:pointer;" } });
				const cb = fileRow.createEl("input", { attr: { type: "checkbox" } });
				cb.checked = true;
				this.picked.add(f.path);
				fileRow.createSpan({ text: f.basename });
				const set = (on: boolean) => {
					cb.checked = on;
					if (on) this.picked.add(f.path);
					else this.picked.delete(f.path);
				};
				cb.onclick = (e) => {
					e.stopPropagation();
					set(cb.checked);
				};
				fileRow.onclick = () => set(!cb.checked);
			}
		};
		bookSel.onchange = () => {
			this.stem = bookSel.value;
			renderFiles();
			this.preview.empty();
		};
		renderFiles();

		this.preview = contentEl.createDiv({ attr: { style: "flex:1; min-height:0; overflow:auto; padding:8px 0;" } });

		const footer = contentEl.createDiv({ attr: { style: "margin-top:12px; display:flex; justify-content:flex-end; gap:8px; flex-shrink:0;" } });
		const previewBtn = footer.createEl("button", { text: tr("预览", "Preview", "預覽", "Anteprima") });
		previewBtn.onclick = () => void this.renderPreview();
		const mergeBtn = footer.createEl("button", { cls: "mod-cta", text: tr("生成合并文件", "Create merged note", "產生合併檔案", "Crea la nota unita") });
		mergeBtn.onclick = () => void this.write();
	}

	private async renderPreview() {
		const built = await this.build();
		this.preview.empty();
		if (!built) return;
		this.preview.createDiv({
			text: built.stats,
			attr: { style: "color:var(--text-muted); padding-bottom:8px; margin-bottom:8px; border-bottom:1px solid var(--background-modifier-border);" },
		});
		await MarkdownRenderer.render(this.app, built.md, this.preview.createDiv(), "", this.renderHost);
	}

	private async write() {
		const built = await this.build();
		if (!built) return;
		const folder = await this.plugin.ensureExportFolder();
		if (folder === null) return;
		const name = tr(
			`${this.stem} - 高亮摘录 合并`,
			`${this.stem} - Highlights merged`,
			`${this.stem} - 高亮摘錄 合併`,
			`${this.stem} - Evidenziazioni unite`
		);
		await this.plugin.writeStampedNote(name, built.md, folder);
		this.close();
	}

	private async build(): Promise<{ md: string; stats: string } | null> {
		const files = (this.books.get(this.stem) ?? [])
			.filter((f) => this.picked.has(f.path))
			.sort((a, b) => a.stat.mtime - b.stat.mtime);
		if (files.length === 0) {
			new Notice(tr("请先选择要合并的文件", "Pick at least one note to merge", "請先選擇要合併的檔案", "Scegli almeno una nota"));
			return null;
		}

		// The book's own highlights supply each block's order and color, and let a
		// marker-less block be matched back by its text. Moving an epub inside the
		// vault leaves a record behind under the old path, so take every record
		// carrying this book's name and use them together.
		const known = new Map<string, Highlight>();
		for (const [bookPath, rec] of Object.entries(this.plugin.data.books)) {
			if ((bookPath.split("/").pop() ?? "").replace(/\.epub$/i, "") !== this.stem) continue;
			for (const h of rec.highlights) known.set(h.id, h);
		}
		const byText = new Map<string, Highlight>();
		for (const h of known.values()) byText.set(h.text.replace(/\s+/g, ""), h);

		const variants = new Map<string, { block: ParsedBlock; file: TFile }[]>();
		const loose: string[] = [];
		const looseSeen = new Set<string>();
		const kept: string[] = [];
		let seen = 0;
		for (const f of files) {
			const { blocks, outside } = parseExportNote(await this.app.vault.cachedRead(f));
			for (const b of blocks) {
				seen++;
				// A custom template can put the text anywhere, so fall back to looking
				// for any known highlight inside the whole block. Short highlights
				// count too — taking the longest match keeps a brief one from
				// shadowing the longer passage that actually contains it.
				let hl = byText.get(blockQuote(b.raw));
				if (!hl) {
					const flat = b.raw.replace(HL_ID_RE, "").replace(/\s+/g, "");
					let longest = 0;
					for (const [text, cand] of byText) {
						if (text.length >= 4 && text.length > longest && flat.includes(text)) {
							hl = cand;
							longest = text.length;
						}
					}
				}
				const id = b.id ?? hl?.id ?? null;
				if (!id) {
					// Unmatched blocks keep the heading they sat under: for a section the
					// reader wrote themselves, that heading is their own title. The same
					// leftover appearing in several notes is still one leftover.
					const key = `${b.heading ?? ""}\u0000${b.raw.replace(/\s+/g, "")}`;
					if (looseSeen.has(key)) continue;
					looseSeen.add(key);
					const head = b.heading ? `### ${b.heading}\n\n` : "";
					loose.push(`${head}${b.raw}\n\n*${tr("来自", "From", "來自", "Da")} [[${f.basename}]]*`);
					continue;
				}
				const seenBefore = variants.get(id);
				if (seenBefore) seenBefore.push({ block: b, file: f });
				else variants.set(id, [{ block: b, file: f }]);
			}
			if (outside) kept.push(`### ${f.basename}\n\n${outside}`);
		}

		// One highlight can appear in several notes, exported with different
		// templates, languages or fields — same words, different shape. Comparing
		// the raw blocks would file every one of those as an edited copy, so compare
		// what is left after removing the parts the plugin itself wrote: the
		// highlight's text, its note, and the punctuation, digits and Latin letters
		// that carry the formatting. Only wording beyond that came from the reader.
		const byId = new Map<string, ParsedBlock>();
		const conflicts: string[] = [];
		const bare = (t: string) => t.replace(/\s+/g, "");
		const FORMATTING = /[0-9A-Za-z*#>|\-–—·・….,:;/()[\]（）【】「」《》"'“”‘’、。，：；！？!?%]+/g;
		const residue = (raw: string, h?: Highlight) => {
			let t = bare(raw.replace(HL_ID_RE, ""));
			if (h) t = t.replace(bare(h.text), "").replace(bare(h.note ?? ""), "");
			return t.replace(FORMATTING, "");
		};
		const NEW_RUN = 8;
		for (const [id, vs] of variants) {
			const best = vs.reduce((x, y) => (y.block.raw.length > x.block.raw.length ? y : x));
			byId.set(id, best.block);
			const known_h = known.get(id);
			const kept = residue(best.block.raw, known_h);
			for (const v of vs) {
				if (v === best) continue;
				const other = residue(v.block.raw, known_h);
				if (other.length <= NEW_RUN) continue;
				let novel = false;
				for (let i = 0; i + NEW_RUN <= other.length; i++) {
					if (!kept.includes(other.slice(i, i + NEW_RUN))) {
						novel = true;
						break;
					}
				}
				if (novel) conflicts.push(`${v.block.raw}\n\n*${tr("来自", "From", "來自", "Da")} [[${v.file.basename}]]*`);
			}
		}

		// Blocks whose highlight is no longer in the book (deleted since that export)
		// have nothing to sort by, so they keep to the end in the order they appeared.
		const hById = known;
		const ids = [...byId.keys()].sort((a, b) => {
			const ha = hById.get(a);
			const hb = hById.get(b);
			if (!ha || !hb) return ha ? -1 : hb ? 1 : 0;
			return compareHighlights(ha, hb, this.sortBy);
		});
		const colorOf = (id: string) => known.get(id)?.color ?? "";

		const groups = new Map<string, string[]>();
		const colorLabels = HIGHLIGHT_COLORS.flatMap((c) => [c.name, c.en, c.tw, c.it]);
		for (const id of ids) {
			const block = byId.get(id) as ParsedBlock;
			const raw = block.raw;
			// A chapter-grouped source keeps its chapter only in the heading, so fall
			// back to that — unless the heading is a color, i.e. it was grouped by color.
			const fromHeading = block.heading && !colorLabels.includes(block.heading) ? block.heading : "";
			const key =
				this.groupBy === "chapter"
					? blockChapter(raw) || fromHeading || tr("未知章节", "Unknown chapter", "未知章節", "Capitolo sconosciuto")
					: this.groupBy === "color"
						? colorOf(id)
							? colorLabel(colorOf(id))
							: tr("未知颜色", "Unknown color", "未知顏色", "Colore sconosciuto")
						: "";
			const bucket = groups.get(key);
			if (bucket) bucket.push(raw);
			else groups.set(key, [raw]);
		}


		const lines: string[] = [
			`# ${tr("高亮摘录（合并）", "Highlights (merged)", "高亮摘錄（合併）", "Evidenziazioni (unite)")}`,
			"",
			`> ${tr(
				`共 ${ids.length} 条高亮 · 合并自 ${files.length} 个文件`,
				`${ids.length} highlights · merged from ${files.length} notes`,
				`共 ${ids.length} 條高亮 · 合併自 ${files.length} 個檔案`,
				`${ids.length} evidenziazioni · da ${files.length} note`
			)}`,
			"",
		];
		for (const [key, items] of groups) {
			if (key && groups.size > 1) lines.push(`## ${key}`, "");
			for (const raw of items) lines.push(raw, "", "---", "");
		}
		// Blocks that matched nothing are kept verbatim, so a later merge of this
		// file sees them again exactly as they are.
		if (conflicts.length) {
			lines.push(
				`## ${tr("同一条高亮的其他版本", "Other versions of the same highlight", "同一條高亮的其他版本", "Altre versioni della stessa evidenziazione")}`,
				"",
				`> ${tr(
					"这些是你改动过的副本，没有丢，请自行取舍",
					"Copies you had edited — kept here rather than dropped, so you can choose",
					"這些是你改動過的副本，沒有丟，請自行取捨",
					"Copie che avevi modificato: conservate qui, scegli tu"
				)}`,
				""
			);
			for (const c of conflicts) lines.push(c, "", "---", "");
		}
		if (loose.length) {
			lines.push(
				`## ${tr("其他内容", "Other content", "其他內容", "Altri contenuti")}`,
				"",
				`> ${tr(
					"这些段落对应不上任何高亮：你自己写的，或原文被改动过的",
					"These blocks match no highlight: things you wrote, or quotes you edited",
					"這些段落對應不上任何高亮：你自己寫的，或原文被改動過的",
					"Blocchi che non corrispondono a nessuna evidenziazione: cose che hai scritto o citazioni modificate"
				)}`,
				""
			);
			for (const l of loose) lines.push(l, "", "---", "");
		}
		if (kept.length) {
			lines.push(`## ${tr("你写的其他内容", "Your other notes", "你寫的其他內容", "Le tue altre note")}`, "");
			for (const k of kept) lines.push(k, "");
		}

		const dupes = seen - loose.length - ids.length - conflicts.length;
		const stats = tr(
			`合并 ${files.length} 个文件 · 去重后 ${ids.length} 条 · 去掉重复 ${dupes} 条 · 其他内容 ${kept.length + loose.length} 段 · 改动过的副本 ${conflicts.length} 份`,
			`${files.length} notes · ${ids.length} highlights after dedupe · ${dupes} duplicates dropped · ${kept.length + loose.length} other sections kept · ${conflicts.length} edited copies set aside`,
			`合併 ${files.length} 個檔案 · 去重後 ${ids.length} 條 · 去掉重複 ${dupes} 條 · 其他內容 ${kept.length + loose.length} 段 · 改動過的副本 ${conflicts.length} 份`,
			`${files.length} note · ${ids.length} dopo la deduplica · ${dupes} duplicati rimossi · ${kept.length + loose.length} altre sezioni conservate · ${conflicts.length} copie modificate`
		);
		return { md: lines.join("\n"), stats };
	}

	onClose() {
		this.renderHost.unload();
		this.contentEl.empty();
	}
}

// A yes/no dialog for the one action that moves files around on its own.
class ConfirmModal extends Modal {
	private body: string;
	private confirmText: string;
	private onConfirm: () => void;
	private decided = false;
	private onCancel?: () => void;

	constructor(app: App, body: string, confirmText: string, onConfirm: () => void, onCancel?: () => void) {
		super(app);
		this.body = body;
		this.confirmText = confirmText;
		this.onConfirm = onConfirm;
		this.onCancel = onCancel;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("p", { text: this.body, attr: { style: "margin-top: 0;" } });
		const row = contentEl.createDiv({ attr: { style: "display:flex; justify-content:flex-end; gap:8px;" } });
		const cancel = row.createEl("button", { text: tr("取消", "Cancel", "取消", "Annulla") });
		cancel.onclick = () => this.close();
		const ok = row.createEl("button", { cls: "mod-cta", text: this.confirmText });
		ok.onclick = () => {
			this.decided = true;
			this.close();
			this.onConfirm();
		};
	}

	onClose() {
		if (!this.decided) this.onCancel?.();
		this.contentEl.empty();
	}
}

// Pick an export folder by browsing the vault's folders instead of typing a path.
class FolderPickerModal extends Modal {
	private onPick: (path: string) => void | Promise<void>;

	constructor(app: App, onPick: (path: string) => void | Promise<void>) {
		super(app);
		this.onPick = onPick;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.createEl("h3", { text: tr("选择导出文件夹", "Choose export folder", "選擇匯出資料夾", "Scegli la cartella di esportazione"), attr: { style: "margin-top: 0;" } });
		const folders = ["", ...this.app.vault.getAllLoadedFiles().filter((f): f is TFolder => f instanceof TFolder).map((f) => f.path)]
			.filter((f, i, a) => a.indexOf(f) === i)
			.sort();
		const filter = contentEl.createEl("input", {
			attr: { type: "text", placeholder: tr("筛选…", "Filter…", "篩選…", "Filtra…"), style: "width: 100%; margin-bottom: 8px;" },
		});
		const list = contentEl.createDiv({ attr: { style: "max-height: 50vh; overflow: auto;" } });
		const render = () => {
			list.empty();
			const q = filter.value.trim().toLowerCase();
			for (const f of folders) {
				if (q && !f.toLowerCase().includes(q)) continue;
				const row = list.createDiv({ cls: "epub-menu-item" });
				row.createSpan({ text: f || tr("（库根目录）", "(vault root)", "（庫根目錄）", "(radice della cassaforte)") });
				row.onclick = () => {
					this.onPick(f);
					this.close();
				};
			}
		};
		filter.oninput = render;
		render();
		window.setTimeout(() => filter.focus(), 0);
	}

	onClose() {
		this.contentEl.empty();
	}
}

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
		// Column layout with only the list scrolling, so the export button and the
		// path row stay in view however many highlights the book has.
		contentEl.setCssStyles({ display: "flex", flexDirection: "column", maxHeight: "72vh" });
		contentEl.createEl("h3", { text: tr("选择要导出的高亮", "Choose highlights to export", "選擇要匯出的高亮", "Scegli le evidenziazioni da esportare"), attr: { style: "margin-top: 0; flex-shrink: 0;" } });

		const record = this.view.plugin.getBookRecord(this.view.filePath);
		const sorted = [...record.highlights].sort((a, b) => a.created - b.created);
		if (sorted.length === 0) {
			contentEl.createEl("p", { text: tr("还没有任何高亮。", "No highlights yet.", "還沒有任何高亮。", "Ancora nessuna evidenziazione."), attr: { style: "color: var(--text-muted);" } });
			return;
		}

		let exportBtn: HTMLButtonElement;
		let copyBtn: HTMLButtonElement;
		const updateBtns = () => {
			exportBtn.textContent = tr(`导出所选 (${this.selected.size})`, `Export selected (${this.selected.size})`, `匯出所選 (${this.selected.size})`, `Esporta (${this.selected.size})`);
			copyBtn.textContent = tr(`复制所选 (${this.selected.size})`, `Copy selected (${this.selected.size})`, `複製所選 (${this.selected.size})`, `Copia (${this.selected.size})`);
			exportBtn.disabled = copyBtn.disabled = this.selected.size === 0;
		};

		// Spine index / chapter name of each highlight, for the per-chapter filter.
		const chapters = chapterLookup(this.view.book);
		const spinePos = chapters.posOf;
		const chapterLabel = chapters.labelAt;
		const positions = [...new Set(sorted.map((h) => spinePos(h.cfiRange)).filter((p) => p >= 0))].sort((a, b) => a - b);

		const rowCbs: { cb: HTMLInputElement; h: Highlight }[] = [];
		let allCb: HTMLInputElement;
		// Replace the selection with `ids` and sync every checkbox to it.
		const applySelection = (ids: Set<string>) => {
			this.selected = ids;
			rowCbs.forEach(({ cb, h }) => (cb.checked = ids.has(h.id)));
			allCb.checked = ids.size === sorted.length;
			updateBtns();
		};

		// Quick filters: all / today / one chapter / by color. Each one replaces the
		// selection, so the list always shows exactly what will be exported.
		const activeColors = new Set<string>();
		let clearChips: () => void = () => undefined;
		const filterRow = contentEl.createDiv({ attr: { style: "display:flex; align-items:center; gap:8px; padding:6px 0; flex-wrap:wrap; flex-shrink:0;" } });
		const allBtn = filterRow.createEl("button", { text: tr("全部", "All", "全部", "Tutte") });
		allBtn.onclick = () => {
			chapterSel.value = "";
			clearChips();
			applySelection(new Set(sorted.map((h) => h.id)));
		};
		const todayBtn = filterRow.createEl("button", { text: tr("今日", "Today", "今日", "Oggi") });
		todayBtn.onclick = () => {
			chapterSel.value = "";
			clearChips();
			const now = new Date();
			applySelection(new Set(sorted.filter((h) => {
				const d = new Date(h.created);
				return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
			}).map((h) => h.id)));
		};
		// Obsidian's native "dropdown" class gives the select the same control
		// chrome (border, radius, height) as the two buttons beside it.
		const chapterSel = filterRow.createEl("select", { cls: "dropdown" });
		// Chapter titles can be long, and a select is as wide as its widest option,
		// which would push everything else onto another line.
		chapterSel.setCssStyles({ maxWidth: "150px", flexShrink: "0" });
		chapterSel.createEl("option", { text: tr("章节选择…", "Select chapter…", "章節選擇…", "Seleziona capitolo…"), value: "" });
		for (const p of positions) chapterSel.createEl("option", { text: chapterLabel(p), value: `${p}` });
		// The dropdown carries its own radius, which the theme may set apart from the
		// buttons'. Copy the buttons' computed radius so all three share one shape.
		window.requestAnimationFrame(() => {
			const radius = getComputedStyle(allBtn).borderRadius;
			for (const sel of [chapterSel, sortSel]) sel.setCssStyles({ borderRadius: radius });
		});
		chapterSel.onchange = () => {
			if (chapterSel.value === "") return;
			clearChips();
			const p = Number(chapterSel.value);
			applySelection(new Set(sorted.filter((h) => spinePos(h.cfiRange) === p).map((h) => h.id)));
		};

		// One chip per color this book actually uses, presets first. Ticking chips
		// selects those highlights (several chips = all of them together); the set is
		// remembered so the same colors come back ticked next time.
		const presetRank = (v: string) => {
			const i = HIGHLIGHT_COLORS.findIndex((c) => c.value === v);
			return i < 0 ? HIGHLIGHT_COLORS.length : i;
		};
		const usedColors = [...new Set(sorted.map((h) => h.color))].sort((x, y) => presetRank(x) - presetRank(y));
		const chips = new Map<string, HTMLElement>();
		const applyColors = () => {
			chapterSel.value = "";
			for (const [value, chip] of chips) chip.toggleClass("is-active", activeColors.has(value));
			applySelection(
				new Set(
					(activeColors.size ? sorted.filter((h) => activeColors.has(h.color)) : sorted).map((h) => h.id)
				)
			);
		};
		clearChips = () => {
			activeColors.clear();
			for (const chip of chips.values()) chip.removeClass("is-active");
		};
		if (usedColors.length > 1) {
			const chipRow = filterRow.createDiv({ attr: { style: "display:flex; gap:6px; margin-left:4px;" } });
			for (const value of usedColors) {
				const chip = chipRow.createEl("button", { cls: "epub-swatch-dot", attr: { title: colorLabel(value) } });
				chip.setCssStyles({ background: value, width: "18px", height: "18px" });
				chips.set(value, chip);
				chip.onclick = () => {
					if (activeColors.has(value)) activeColors.delete(value);
					else activeColors.add(value);
					applyColors();
				};
			}
		}

		const allRow = contentEl.createDiv({ attr: { style: "display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--background-modifier-border); flex-shrink:0;" } });
		allCb = allRow.createEl("input", { attr: { type: "checkbox" } });
		allCb.checked = true;
		allRow.createSpan({ text: tr("全选", "Select all", "全選", "Seleziona tutto"), attr: { style: "font-weight:600;" } });

		const list = contentEl.createDiv({ attr: { style: "flex:1; min-height:0; overflow:auto;" } });
		for (const h of sorted) {
			const row = list.createDiv({ attr: { style: "display:flex; gap:8px; padding:8px 0; border-bottom:1px solid var(--background-modifier-border); cursor:pointer;" } });
			const cb = row.createEl("input", { attr: { type: "checkbox", style: "margin-top:3px; flex-shrink:0;" } });
			cb.checked = true;
			rowCbs.push({ cb, h });
			row.createDiv({ attr: { style: `width:12px;height:12px;border-radius:3px;background:${h.color};margin-top:3px;flex-shrink:0;` } });
			const body = row.createDiv({ attr: { style: "flex:1; min-width:0;" } });
			const page = this.view.getPageLabel(h.cfiRange);
			body.createDiv({ text: tr(`第 ${page} 页`, `Page ${page}`, `第 ${page} 頁`, `Pagina ${page}`), attr: { style: "font-size:11px; color:var(--text-muted); margin-bottom:2px;" } });
			body.createDiv({ text: h.text, attr: { style: "line-height:1.4;" } });
			cb.onchange = () => {
				if (cb.checked) this.selected.add(h.id);
				else this.selected.delete(h.id);
				allCb.checked = this.selected.size === sorted.length;
				updateBtns();
			};
			// The whole row toggles the checkbox (a bigger click target).
			row.onclick = (e) => {
				if (e.target !== cb) cb.click();
			};
		}

		allCb.onchange = () => {
			applySelection(allCb.checked ? new Set(sorted.map((h) => h.id)) : new Set());
		};

		// Export target: prefilled from settings, editable for this export only —
		// unless "set as default" is ticked, which writes the path back to settings.
		const ep = this.view.plugin.exportPrefs;
		let folder = ep.folder;
		const pathRow = contentEl.createDiv({ attr: { style: "display:flex; align-items:center; gap:8px; margin-top:12px; flex-shrink:0; flex-wrap:wrap;" } });
		pathRow.createSpan({ text: tr("排序：", "Sort:", "排序：", "Ordina:"), attr: { style: "color:var(--text-muted); white-space:nowrap;" } });
		const sortSel = pathRow.createEl("select", { cls: "dropdown" });
		sortSel.createEl("option", { text: tr("按书中顺序", "Book order", "按書中順序", "Ordine del libro"), value: "book" });
		sortSel.createEl("option", { text: tr("按划线时间", "Highlight time", "按劃線時間", "Ora dell'evidenziazione"), value: "created" });
		sortSel.value = this.view.plugin.exportPrefs.sortBy;
		pathRow.createSpan({ text: tr("导出到：", "Export to:", "匯出到：", "Esporta in:"), attr: { style: "color:var(--text-muted); white-space:nowrap;" } });
		const pathInput = pathRow.createEl("input", {
			attr: { type: "text", style: "flex:1; min-width:0;", placeholder: tr("库根目录", "Vault root", "庫根目錄", "Radice della cassaforte") },
		});
		pathInput.value = folder;
		pathInput.oninput = () => (folder = pathInput.value.trim());
		const browseBtn = pathRow.createEl("button", { attr: { style: "display:flex; align-items:center;", title: tr("浏览文件夹", "Browse folders", "瀏覽資料夾", "Sfoglia le cartelle") } });
		setIcon(browseBtn, "folder");
		browseBtn.onclick = () =>
			new FolderPickerModal(this.app, (f) => {
				folder = f;
				pathInput.value = f;
			}).open();
		const defLabel = pathRow.createEl("label", { attr: { style: "display:flex; align-items:center; gap:4px; white-space:nowrap; color:var(--text-muted);" } });
		const defCb = defLabel.createEl("input", { attr: { type: "checkbox" } });
		defLabel.createSpan({ text: tr("设为默认", "Set as default", "設為預設", "Imposta come predefinito") });

		const footer = contentEl.createDiv({ attr: { style: "margin-top:12px; display:flex; justify-content:flex-end; gap:8px; flex-shrink:0;" } });
		copyBtn = footer.createEl("button");
		copyBtn.onclick = async () => {
			const items = sorted.filter((h) => this.selected.has(h.id));
			if (items.length === 0) return;
			await this.view.waitForPagination();
			this.view.copyQuotes(items);
		};
		exportBtn = footer.createEl("button", { cls: "mod-cta" });
		updateBtns();
		exportBtn.onclick = async () => {
			if (this.selected.size === 0) return;
			exportBtn.disabled = true;
			new Notice(tr("正在导出为 Markdown…", "Exporting to Markdown…", "正在匯出為 Markdown…", "Esportazione in Markdown…"));
			await this.view.waitForPagination();
			// Remember the chips (and the folder, if asked) in one write — the plugin
			// data file is large enough that saving on every click would be wasteful.
			const chosen = [...activeColors];
			const was = record.colorFilter ?? [];
			const chipsChanged = chosen.length !== was.length || chosen.some((c) => !was.includes(c));
			const folderChanged = defCb.checked && folder !== ep.folder;
			if (chipsChanged || folderChanged) {
				record.colorFilter = chosen;
				if (folderChanged) ep.folder = folder;
				await this.view.plugin.saveBookData();
			}
			// The dialog's sort choice covers this export only; the stored default is
			// put back as soon as the file is written.
			const savedSort = ep.sortBy;
			ep.sortBy = sortSel.value as ExportPrefs["sortBy"];
			try {
				await this.view.plugin.exportHighlights(
					this.view.filePath,
					(cfi) => this.view.getPageLabel(cfi),
					this.selected,
					chapters.labelOf,
					folder
				);
			} finally {
				ep.sortBy = savedSort;
			}
			this.close();
		};

		// Last of all: restoring the chips changes the selection, which refreshes the
		// footer buttons — so they have to exist by now. Colors this book no longer
		// has are ignored.
		const remembered = (record.colorFilter ?? []).filter((c) => chips.has(c));
		if (remembered.length) {
			for (const c of remembered) activeColors.add(c);
			applyColors();
		}
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

// Where a range starts and ends counted in characters of `root`'s text. Node
// paths shift the moment spans are unwrapped; character offsets don't.
function textOffsetsOf(root: Node, range: Range, doc: Document): { start: number; end: number } | null {
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	let seen = 0;
	let start = -1;
	let end = -1;
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const len = node.textContent?.length ?? 0;
		if (node === range.startContainer) start = seen + range.startOffset;
		if (node === range.endContainer) end = seen + range.endOffset;
		seen += len;
	}
	return start >= 0 && end > start ? { start, end } : null;
}

// The inverse, run after the DOM has been rearranged.
function rangeFromTextOffsets(root: Node, start: number, end: number, doc: Document): Range | null {
	const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
	const range = doc.createRange();
	let seen = 0;
	let placedStart = false;
	for (let node = walker.nextNode(); node; node = walker.nextNode()) {
		const len = node.textContent?.length ?? 0;
		if (!placedStart && seen + len > start) {
			range.setStart(node, start - seen);
			placedStart = true;
		}
		if (placedStart && seen + len >= end) {
			range.setEnd(node, end - seen);
			return range;
		}
		seen += len;
	}
	return null;
}

// Wraps every text node intersecting `range` in its own <span>, since a Range
// can cross element boundaries (e.g. into <em>) and Range.surroundContents
// throws in that case. Per-text-node sub-ranges are always single-node-safe.
function wrapRangeWithSpans(
	doc: Document,
	range: Range,
	className: string,
	cssText: string,
	onClick: (ev: MouseEvent) => void
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
	spans.forEach((s) => s.addEventListener("click", (ev) => onClick(ev as MouseEvent)));
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
	// Last hex chosen from the custom color picker (for its swatch + picker default).
	customHlColor = "#ffd54f";
	// Cross-page highlight anchor: start point marked in a chapter's document,
	// finished by a later selection in the same document. Cleared on re-render.
	pendingStart: { doc: Document; node: Node; offset: number } | null = null;
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
					await this.plugin.exportHighlights(this.filePath, (cfi) => this.getPageLabel(cfi), undefined, chapterLookup(this.book).labelOf);
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
				rainbow.setCssStyles({ background: this.customColorActive() ? this.lastColor : RAINBOW_GRADIENT });
				rainbow.toggleClass("is-active", this.customColorActive());
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
							this.customHlColor = hex;
							this.lastColor = hexToHighlightRgba(hex);
							rainbow.setCssStyles({ background: this.lastColor });
							presetSws.forEach((s) => s.removeClass("is-active"));
							rainbow.addClass("is-active");
						},
						() => {
							if (this.customColorActive()) this.recordCustomColor(this.customHlColor);
							this.savePrefs();
						}
					);
					window.requestAnimationFrame(() => hlPicker?.addClass("is-open"));
				};

				// Recently used custom colors — small dots, shown only once one exists.
				// Only colors that still have highlights: a color picked once and since
				// deleted is just noise in a palette meant for reuse.
				const inUse = new Set<string>();
				for (const book of Object.values(this.plugin.data.books)) {
					for (const h of book.highlights) inUse.add(h.color);
				}
				const hist = (this.plugin.data.prefs.customHlHistory ?? [])
					.filter((hex) => inUse.has(hexToHighlightRgba(hex)))
					.slice(0, 5);
				if (hist.length) {
					menu.createDiv({ cls: "epub-menu-label", text: tr("最近使用的颜色", "Recently used colors", "最近使用的顏色", "Colori usati di recente") });
					// Same class and row styling as the preset palette above, so the two
					// groups read as one stack (identical dot size and spacing).
					const histRow = menu.createDiv({ cls: "epub-menu-item" });
					histRow.setCssStyles({ gap: "10px", flexWrap: "wrap", cursor: "default" });
					for (const hex of hist) {
						const d = histRow.createEl("button", { cls: "epub-swatch-dot", attr: { title: hex } });
						d.setCssStyles({ background: hexToHighlightRgba(hex) });
						d.onclick = (ev) => {
							ev.stopPropagation();
							this.customHlColor = hex;
							this.lastColor = hexToHighlightRgba(hex);
							rainbow.setCssStyles({ background: this.lastColor });
							presetSws.forEach((s) => s.removeClass("is-active"));
							rainbow.addClass("is-active");
							this.recordCustomColor(hex);
							this.savePrefs();
						};
					}
				}
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
			await this.plugin.checkBookFingerprint(file.path, arrayBuffer);
			this.book = ePub(arrayBuffer);
		}
		await this.renderBook();

		// First ever open: the icon guide. After that, only when the version the
		// reader last saw isn't this one — an upgrade they didn't ask for shouldn't
		// change things silently. Both stay reachable from the settings tab.
		const latest = RELEASE_NOTES[0].version;
		if (!this.plugin.data.seenGuide) {
			// A fresh install: the guide already describes everything the plugin does,
			// so there is nothing to catch up on.
			this.plugin.data.seenGuide = true;
			this.plugin.data.seenVersion = latest;
			void this.plugin.saveBookData();
			new LegendModal(this.app).open();
		} else if (this.plugin.data.seenVersion !== latest) {
			const missed = notesSince(this.plugin.data.seenVersion);
			this.plugin.data.seenVersion = latest;
			void this.plugin.saveBookData();
			if (missed.length) new WhatsNewModal(this.app, missed).open();

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
			customHlHistory: this.plugin.data.prefs.customHlHistory ?? [],
		};
		void this.plugin.saveBookData();
	}

	// Remember a picked custom color in the recent-colors history (dedup, max 5).
	recordCustomColor(hex: string) {
		const list = (this.plugin.data.prefs.customHlHistory ?? []).filter((c) => c.toLowerCase() !== hex.toLowerCase());
		list.unshift(hex);
		this.plugin.data.prefs.customHlHistory = list.slice(0, 5);
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
		// A cached scan for this exact layout → adopt it instantly.
		const cached = this.plugin.loadVisualCache(this.filePath);
		if (cached && cached.key === key && cached.cfis.length && cached.counts.length) {
			this.adoptVisualPages(cached.cfis, cached.counts, key);
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
		// Per-device: stored outside the vault, so it is never synced and never
		// makes the plugin's own data file bigger.
		this.plugin.saveVisualCache(this.filePath, { cfis, counts, key });
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
		// The old chapter documents are gone; a marked cross-page start is stale.
		this.pendingStart = null;

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
			// Locate the current screen inside the scanned page grid by CFI. This
			// stays accurate even if the live layout drifts slightly from the scan
			// (offset+page would then over/under-shoot and make numbers jump).
			const byCfi = loc.cfi ? this.visualPageFromCfi(loc.cfi) : 0;
			const current = Math.max(1, byCfi > 0 ? byCfi : this.currentVisualPage());
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
			const parents = new Set<Node>();
			doc?.querySelectorAll(`[data-hl-id="${id}"]`).forEach((span: Element) => {
				if (span.parentNode) parents.add(span.parentNode);
				span.replaceWith(...Array.from(span.childNodes));
			});
			// Unwrapping leaves the text in fragments where the span used to split
			// it. They look identical but shift every node path after them, so the
			// CFI of any other highlight there would resolve to the wrong words.
			// Merging them back restores the structure those CFIs were written for.
			for (const parent of parents) (parent as Element).normalize();
		}
	}

	applyStoredHighlightsToSection(sectionIndex: number) {
		const record = this.plugin.getBookRecord(this.filePath);
		const view = this.mountedViews().find((v) => v.section?.index === sectionIndex);
		if (!view?.contents) return;
		// Set when a highlight had to be found by its text, so the repaired anchors
		// are written back once rather than after every single one.
		let rehomed = false;

		for (const h of record.highlights) {
			// A CFI carries the chapter it belongs to, but resolving one against
			// another chapter's document doesn't fail — it walks the same node path
			// there and lands on unrelated text, which then gets painted. Every
			// highlight has to be matched to its own section first.
			const pos = cfiSpinePos(h.cfiRange);
			if (pos >= 0 && pos !== sectionIndex) continue;

			let range: Range | null = null;
			try {
				range = view.contents.range(h.cfiRange);
			} catch {
				range = null;
			}
			if (range && range.commonAncestorContainer.ownerDocument !== view.contents.document) range = null;
			// Second guard: the text under the range must still be the text that was
			// highlighted. Protects against a book whose content shifted, and against
			// a CFI whose spine step couldn't be read above. Invisible characters are
			// dropped as well as whitespace — a soft hyphen or zero-width space in the
			// markup would otherwise hide a perfectly good highlight.
			const bare = (t: string) => t.replace(/[\s\u00ad\u200b-\u200f\ufeff]+/g, "");
			if (!range || bare(range.toString()) !== bare(h.text)) {
				// The anchor no longer lands on the passage — markup around it moved,
				// or another machine rendered the chapter differently. Look the text up
				// instead and re-anchor to where it actually is now.
				const found = this.locateByText(h, view.contents.document);
				if (!found) continue;
				range = found;
				h.cfiRange = view.contents.cfiFromRange(found);
				h.offset = view.contents.document.body ? (textOffsetsOf(view.contents.document.body, found, view.contents.document)?.start ?? h.offset) : h.offset;
				rehomed = true;
			}
			// Skip if already applied (re-render of a section already on screen).
			const existing = view.contents.document.querySelector(`[data-hl-id="${h.id}"]`);
			if (existing) continue;

			const spans = wrapRangeWithSpans(
				view.contents.document,
				range,
				"epub-highlight",
				`background: ${h.color}; cursor: pointer;`,
				(ev) => this.showHighlightMenu(h.id, ev)
			);
			spans.forEach((s) => s.setAttribute("data-hl-id", h.id));
		}
		if (rehomed) void this.plugin.saveBookData();
	}

	// Find a highlight's passage by its own text, preferring the occurrence closest
	// to where it used to be — a chapter can repeat a sentence.
	private locateByText(h: Highlight, doc: Document): Range | null {
		const body = doc.body;
		if (!body || !h.text.trim()) return null;
		const full = body.textContent ?? "";
		const positions: number[] = [];
		for (let i = full.indexOf(h.text); i >= 0 && positions.length < 50; i = full.indexOf(h.text, i + 1)) positions.push(i);
		if (!positions.length) return null;
		const target = h.offset ?? 0;
		const best = positions.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
		return rangeFromTextOffsets(body, best, best + h.text.length, doc);
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
			attr: { style: "position: absolute; z-index: 1000; background: var(--background-secondary); border-radius: 6px; padding: 4px; display: flex; align-items: center; gap: 4px; box-shadow: var(--shadow-s);" },
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
				this.createHighlight(cfiRange, text, c.value, range, contents.document);
				selection.removeAllRanges();
				this.dismissColorToolbar();
			};
		}
		// Custom-color swatch: shows the rainbow until a custom color is in use, then
		// shows that color. Clicking opens the picker and highlights with the choice.
		const custom = toolbar.createEl("button", {
			attr: {
				style: `${FLAT_BTN_STYLE} width: 18px; height: 18px; border-radius: 50%; background: ${this.customColorActive() ? this.lastColor : RAINBOW_GRADIENT};`,
				title: tr("自定义颜色…", "Custom color…", "自訂顏色…", "Colore personalizzato…"),
			},
		});
		custom.onclick = () => {
			const input = this.contentEl.createEl("input", { attr: { type: "color", style: "position:absolute; width:0; height:0; opacity:0; pointer-events:none;" } });
			input.value = this.customHlColor;
			input.addEventListener("change", () => {
				this.customHlColor = input.value;
				this.lastColor = hexToHighlightRgba(input.value);
				this.recordCustomColor(input.value);
				this.savePrefs();
				this.createHighlight(cfiRange, text, this.lastColor, range, contents.document);
				selection.removeAllRanges();
				this.dismissColorToolbar();
				input.remove();
			});
			input.click();
		};

		// Cross-page highlight within one chapter: mark a start point, turn pages,
		// then finish from a later selection. A DOM Range can span the pages of one
		// chapter (they're columns of the same document) but never two chapters.
		const sep = toolbar.createDiv();
		sep.setCssStyles({ width: "0.8px", height: `${TOOLBAR_ICON_PX}px`, background: "var(--background-modifier-border)", margin: "0 2px" });
		const startBtn = toolbar.createEl("button", {
			attr: { style: `${TOOLBAR_ICON_BTN_STYLE} color: var(--text-normal);`, title: tr("标记跨页起点", "Mark cross-page start", "標記跨頁起點", "Segna inizio multi-pagina") },
		});
		drawPencilIcon(startBtn, PENCIL_MARK_START);
		startBtn.onclick = () => {
			this.pendingStart = { doc: contents.document, node: range.startContainer, offset: range.startOffset };
			selection.removeAllRanges();
			this.dismissColorToolbar();
			new Notice(tr("已标记起点：翻页后选中终点，再点铅笔 ✓", "Start marked: turn pages, select the end, then click the pencil with the check", "已標記起點：翻頁後選取終點，再點鉛筆 ✓", "Inizio segnato: gira pagina, seleziona la fine, poi la matita con la spunta"));
		};
		if (this.pendingStart && this.pendingStart.doc === contents.document) {
			const endBtn = toolbar.createEl("button", {
				attr: { style: `${TOOLBAR_ICON_BTN_STYLE} color: var(--interactive-accent);`, title: tr("从起点高亮到此处", "Highlight from start to here", "從起點高亮到此處", "Evidenzia dall'inizio a qui") },
			});
			drawPencilIcon(endBtn, PENCIL_MARK_END);
			endBtn.onclick = () => {
				const start = this.pendingStart!;
				try {
					const r = contents.document.createRange();
					r.setStart(start.node, start.offset);
					r.setEnd(range.endContainer, range.endOffset);
					// Selection made before the marked start: build the range the other way.
					if (r.collapsed) {
						r.setStart(range.startContainer, range.startOffset);
						r.setEnd(start.node, start.offset);
					}
					const fullText = r.toString();
					if (!fullText.trim()) throw new Error("empty");
					this.createHighlight(contents.cfiFromRange(r), fullText, this.lastColor, r, contents.document);
					this.pendingStart = null;
					selection.removeAllRanges();
					this.dismissColorToolbar();
				} catch {
					new Notice(tr("跨页高亮失败：请重新标记起点", "Cross-page highlight failed: mark the start again", "跨頁高亮失敗：請重新標記起點", "Evidenziazione multi-pagina non riuscita: risegna l'inizio"));
					this.pendingStart = null;
				}
			};
		}

		// All buttons are in place — clamp the popup inside the view's right edge
		// (selections near the margin would otherwise push part of it off-screen).
		toolbar.setCssStyles({ left: `${Math.max(4, Math.min(left, containerRect.width - toolbar.offsetWidth - 4))}px` });
	}

	// Whether the active highlight color is a custom (non-preset) one.
	private customColorActive(): boolean {
		return !HIGHLIGHT_COLORS.some((c) => c.value === this.lastColor);
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
		this.copyQuotes(sorted);
	}

	// Copy the given highlights to the clipboard as stacked quote blocks.
	copyQuotes(items: Highlight[]) {
		const text = items
			.map((h) => formatQuote(this.getPageLabel(h.cfiRange), h.created, h.text, h.note))
			.join("\n\n");
		void navigator.clipboard.writeText(text).then(
			() => new Notice(tr(`已复制 ${items.length} 条高亮`, `Copied ${items.length} highlights`, `已複製 ${items.length} 條高亮`, `Copiate ${items.length} evidenziazioni`)),
			() => new Notice(tr("复制失败", "Copy failed", "複製失敗", "Copia non riuscita"))
		);
	}

	dismissColorToolbar() {
		this.colorToolbar?.remove();
		this.colorToolbar = null;
	}

	createHighlight(cfiRange: string, text: string, color: string, domRange: Range, doc: Document) {
		// Highlighting the same passage twice is a change of mind about its color,
		// not a second highlight. It can't be caught by comparing CFIs: wrapping the
		// first one in spans changes the node path, so the second CFI over the same
		// words differs. Compare against what is already painted there instead.
		// Two highlights must never sit on top of each other: the outer background
		// hides the inner one and swallows its clicks. Anything the new selection
		// overlaps is folded into it.
		// Two highlights must never sit on top of each other: the outer background
		// hides the inner one and swallows its clicks. Whatever the new selection
		// runs into is folded into it — the new extent and the new color win,
		// whether that grows the old one, trims it, or joins several together.
		let mergedNote = "";
		const touched = this.highlightsIntersecting(domRange, doc);
		if (touched.length) {
			// Unwrapping the old spans rearranges the very nodes this range points
			// into, so hold the selection as character offsets across the chapter and
			// rebuild it once the DOM has settled.
			const offsets = doc.body ? textOffsetsOf(doc.body, domRange, doc) : null;
			const record = this.plugin.getBookRecord(this.filePath);
			const ids = new Set(touched.map((t) => t.highlight.id));
			for (const t of touched) {
				this.unhighlightInAllViews(t.highlight.id);
				this.undoStack.push({ type: "delete", highlight: t.highlight });
			}
			record.highlights = record.highlights.filter((h) => !ids.has(h.id));
			// The note travels with the passage; ⌘Z puts the originals back.
			mergedNote = touched.map((t) => t.highlight.note).filter(Boolean).join("\n");
			const rebuilt = offsets && doc.body ? rangeFromTextOffsets(doc.body, offsets.start, offsets.end, doc) : null;
			if (rebuilt) {
				domRange = rebuilt;
				text = rebuilt.toString();
				const contents = this.mountedViews().find((v) => v.contents?.document === doc)?.contents;
				if (contents) cfiRange = contents.cfiFromRange(rebuilt);
			}
			if (touched.length > 1) {
				new Notice(
					tr(
						`已合并 ${touched.length} 条重叠的高亮`,
						`Merged ${touched.length} overlapping highlights`,
						`已合併 ${touched.length} 條重疊的高亮`,
						`Unite ${touched.length} evidenziazioni sovrapposte`
					)
				);
			}
		}

		// A highlight of this passage that never made it onto the page — its anchor
		// no longer resolves, so nothing is painted and the DOM check above can't
		// see it. Re-anchor that one to where the reader just selected instead of
		// leaving a ghost behind and adding a second entry.
		const ghost = this.unpaintedHighlightFor(text, cfiRange, doc);
		if (ghost) {
			ghost.cfiRange = cfiRange;
			ghost.color = color;
			void this.plugin.saveBookData();
			const spans = wrapRangeWithSpans(doc, domRange, "epub-highlight", `background: ${color}; cursor: pointer;`, (ev) =>
				this.showHighlightMenu(ghost.id, ev)
			);
			spans.forEach((sp) => sp.setAttribute("data-hl-id", ghost.id));
			return;
		}
		const id = `hl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const highlight: Highlight = {
			id,
			cfiRange,
			offset: doc.body ? (textOffsetsOf(doc.body, domRange, doc)?.start ?? undefined) : undefined,
			text,
			color,
			note: mergedNote,
			created: Date.now(),
		};
		try {
			const spans = wrapRangeWithSpans(
				doc,
				domRange,
				"epub-highlight",
				`background: ${color}; cursor: pointer;`,
				(ev) => this.showHighlightMenu(id, ev)
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

	// Everything you can do to one highlight, next to the highlight itself: recolor
	// it, write a note, copy it, delete it. Reuses the selection popup's slot, so
	// an outside click dismisses it the same way.
	showHighlightMenu(id: string, ev: MouseEvent) {
		const record = this.plugin.getBookRecord(this.filePath);
		const highlight = record.highlights.find((h) => h.id === id);
		if (!highlight) return;
		ev.stopPropagation();
		this.dismissColorToolbar();

		const target = ev.target as HTMLElement;
		const rect = target.getBoundingClientRect();
		const iframeRect = target.ownerDocument.defaultView?.frameElement?.getBoundingClientRect();
		const containerRect = this.contentEl.getBoundingClientRect();

		const bar = this.contentEl.createDiv({
			attr: { style: "position: absolute; z-index: 1000; background: var(--background-secondary); border-radius: 6px; padding: 4px; display: flex; align-items: center; gap: 4px; box-shadow: var(--shadow-s);" },
		});
		bar.addEventListener("click", (e) => e.stopPropagation());
		const top = (iframeRect?.top ?? 0) + rect.top - containerRect.top - 34;
		const left = (iframeRect?.left ?? 0) + rect.left - containerRect.left;
		bar.setCssStyles({ top: `${Math.max(top, 0)}px`, left: `${left}px` });
		this.colorToolbar = bar;
		this.colorToolbarTs = Date.now();

		// Recolour. The swatch matching the current color is marked the same way as
		// everywhere else in the plugin: a white dot in its centre.
		const swatch = (background: string, title: string, selected: boolean) => {
			const dot = bar.createEl("button", { cls: "epub-swatch-dot epub-swatch-sm", attr: { title } });
			dot.setCssStyles({ background });
			dot.toggleClass("is-active", selected);
			return dot;
		};
		const applyColor = async (value: string) => {
			highlight.color = value;
			this.recolorInAllViews(id, value);
			await this.plugin.saveBookData();
			this.dismissColorToolbar();
		};
		for (const c of HIGHLIGHT_COLORS) {
			swatch(c.value, tr(c.name, c.en, c.tw, c.it), c.value === highlight.color).onclick = () => void applyColor(c.value);
		}
		// Custom colors this book already uses, so a palette you built stays reachable
		// without reopening the picker. Most recently highlighted first: a color just
		// mixed is the one most likely to be wanted again.
		const customs = [...record.highlights]
			.sort((a, b) => b.created - a.created)
			.map((h) => h.color)
			.filter((v, i, all) => !HIGHLIGHT_COLORS.some((c) => c.value === v) && all.indexOf(v) === i)
			.slice(0, 4);
		for (const value of customs) {
			swatch(value, colorLabel(value), value === highlight.color).onclick = () => void applyColor(value);
		}
		// And the wheel, for a color not used yet.
		const wheel = swatch(RAINBOW_GRADIENT, tr("自定义颜色…", "Custom color…", "自訂顏色…", "Colore personalizzato…"), false);
		wheel.onclick = () => {
			const input = this.contentEl.createEl("input", {
				attr: { type: "color", style: "position:absolute; width:0; height:0; opacity:0; pointer-events:none;" },
			});
			input.value = rgbaToHex(highlight.color);
			input.addEventListener("change", () => {
				this.customHlColor = input.value;
				this.recordCustomColor(input.value);
				void this.savePrefs();
				void applyColor(hexToHighlightRgba(input.value));
				input.remove();
			});
			input.click();
		};

		const sep = bar.createDiv();
		sep.setCssStyles({ width: "0.8px", height: `${TOOLBAR_ICON_PX}px`, background: "var(--background-modifier-border)", margin: "0 2px" });

		const action = (icon: string, title: string, run: () => void) => {
			const btn = bar.createEl("button", { attr: { style: `${TOOLBAR_ICON_BTN_STYLE} color: var(--text-normal);`, title } });
			setIcon(btn, icon);
			sizeToolbarIcon(btn);
			btn.onclick = () => {
				this.dismissColorToolbar();
				run();
			};
		};
		action(
			highlight.note ? "pencil" : "message-square-plus",
			highlight.note ? tr("编辑备注", "Edit note", "編輯備註", "Modifica nota") : tr("添加备注", "Add note", "新增備註", "Aggiungi nota"),
			() => this.handleHighlightClick(id)
		);
		action("copy", tr("复制引用", "Copy quote", "複製引用", "Copia citazione"), () => this.copyQuotes([highlight]));
		action("trash-2", tr("删除（⌘Z 可撤销）", "Delete (⌘Z to undo)", "刪除（⌘Z 可復原）", "Elimina (⌘Z per annullare)"), () => {
			void this.deleteHighlight(id);
		});
	}

	// Every painted highlight the given range runs into.
	private highlightsIntersecting(range: Range, doc: Document): { highlight: Highlight; range: Range }[] {
		const record = this.plugin.getBookRecord(this.filePath);
		const byId = new Map<string, Element[]>();
		for (const span of Array.from(doc.querySelectorAll("[data-hl-id]"))) {
			const id = span.getAttribute("data-hl-id");
			if (!id) continue;
			const list = byId.get(id);
			if (list) list.push(span);
			else byId.set(id, [span]);
		}
		const out: { highlight: Highlight; range: Range }[] = [];
		for (const [id, spans] of byId) {
			const highlight = record.highlights.find((h) => h.id === id);
			if (!highlight) continue;
			const other = doc.createRange();
			other.setStartBefore(spans[0]);
			other.setEndAfter(spans[spans.length - 1]);
			if (range.compareBoundaryPoints(Range.END_TO_START, other) >= 0) continue;
			if (range.compareBoundaryPoints(Range.START_TO_END, other) <= 0) continue;
			out.push({ highlight, range: other });
		}
		return out;
	}

	// A highlight of the same passage, in the same chapter, that has no spans on
	// the page: it exists in the data but can't be drawn where it claims to be.
	private unpaintedHighlightFor(text: string, cfiRange: string, doc: Document): Highlight | null {
		const bare = (t: string) => t.replace(/\s+/g, "");
		const wanted = bare(text);
		const section = cfiSpinePos(cfiRange);
		const record = this.plugin.getBookRecord(this.filePath);
		return (
			record.highlights.find(
				(h) => bare(h.text) === wanted && cfiSpinePos(h.cfiRange) === section && !doc.querySelector(`[data-hl-id="${h.id}"]`)
			) ?? null
		);
	}

	// Repaint a highlight that changed color, in every view showing this book.
	recolorInAllViews(id: string, color: string) {
		for (const view of this.mountedViews()) {
			view?.contents?.document?.querySelectorAll(`[data-hl-id="${id}"]`).forEach((span: Element) => {
				span.setAttribute("style", `background: ${color}; cursor: pointer;`);
			});
		}
	}

	async deleteHighlight(id: string) {
		const record = this.plugin.getBookRecord(this.filePath);
		const highlight = record.highlights.find((h) => h.id === id);
		if (!highlight) return;
		try {
			this.undoStack.push({ type: "delete", highlight });
			record.highlights = record.highlights.filter((h) => h.id !== id);
			await this.plugin.saveBookData();
			this.unhighlightInAllViews(id);
			new Notice(tr("已删除（⌘Z 可撤销）", "Deleted (⌘Z to undo)", "已刪除（⌘Z 可復原）", "Eliminato (⌘Z per annullare)"));
		} catch (err) {
			console.error("epub-reader-highlighter: failed to delete highlight", err);
			new Notice(tr(`删除失败：${(err as Error).message}`, `Delete failed: ${(err as Error).message}`, `刪除失敗：${(err as Error).message}`, `Eliminazione non riuscita: ${(err as Error).message}`));
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
