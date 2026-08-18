# EPUB Reader and Highlighter

English | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [Italiano](README.it.md)

Read EPUB books directly inside Obsidian, mark them up with color-coded highlights and notes, and export everything to Markdown.

## Features

- **In-app EPUB reader** — open any `.epub` file in your vault and read it without leaving Obsidian.
- **Scroll or paginated mode** — switch between continuous scrolling and page-by-page reading; turn pages with the on-screen buttons or the ← / → arrow keys.
- **Fixed page numbers (Apple Books style)** — the whole book is pre-paginated in the background at your current window size and font, so the total page count stays fixed while you read and every page turn advances by exactly 1. "Calculating" shows briefly on first open; the result is cached and only recomputed when the window or font changes. Type a number in the page box to jump straight to that page; scroll mode shows a reading-progress percent instead.
- **Reading position remembered** — close the book (or quit Obsidian) and reopening returns you to the passage where you left off.
- **Color-coded highlights** — select text and pick a color from the popup, or press **`Cmd/Ctrl+Shift+H`** to highlight with the default color; the default color is remembered across sessions.
- **Notes on highlights** — attach a comment to any highlight.
- **Highlights panel** — view every highlight in the current book with its page number, text, and note; jump back to the original location, edit notes, or delete.
- **Copy as quote** — copy the current selection, or all highlights at once, as `*page · time*` + quote blocks ready to paste into a note.
- **Undo** — `Cmd/Ctrl+Z` reverses the last highlight or deletion.
- **Reading themes** — five built-in backgrounds plus an inline color picker (no OS dialog) for any custom color, adjustable font and font size; link colors adapt to the background for readability.
- **Full-book search** — find a keyword anywhere in the book and jump to any result.
- **Cross-page highlighting** — mark a start point, turn as many pages as you like, then finish from a later selection to highlight the whole passage in one go (within a chapter).
- **Recently used colors** — custom colors you have picked stay one click away, and drop off the list once no highlight uses them.
- **Markdown export** — export all highlights, or just the ones you pick, with control over the folder, grouping, sort order and which details each highlight carries. Every export is a new file stamped with the date and time, so nothing is ever overwritten.
- **Merge exported notes** — fold several exports of the same book into a single note: duplicates are removed and everything you wrote yourself is preserved. The originals are never modified.
- **First-run guide** — a one-time popup explains the toolbar icons; the same reference lives in the plugin's settings tab.

## Installation

### From the community store
Search for "EPUB Reader and Highlighter" in **Settings → Community plugins → Browse**, install, and enable.

### Manual
1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [release](https://github.com/okkio-31mon/epub-reader-highlighter/releases).
2. Copy them into `<your-vault>/.obsidian/plugins/epub-reader-highlighter/`.
3. Reload Obsidian and enable the plugin in **Settings → Community plugins**.

## Usage

1. Place an `.epub` file anywhere in your vault and click it to open.
2. Select text to highlight — click a color in the popup, or press `Cmd/Ctrl+Shift+H` for the default color.
3. Click an existing highlight to add or edit a note.
4. Use the toolbar to browse the table of contents, copy a quote, open the highlights menu, adjust the font and background, turn pages, and search the book.

### Toolbar icons

| Icon | What it does |
| --- | --- |
| ☰ (menu) | **Table of contents** — browse the chapters and jump to one. |
| 〝 (quote) | **Copy quote** — copy the selected text as a `*page · time*` + quote block. |
| ▮ (highlighter) | **Highlights menu** — open the highlights list, copy all, export (all or selected), and set the default highlight color. |
| ≡ (sliders) | **Reading settings** — font, text size, and background; the color wheel expands an inline picker for any custom color. |
| Scroll / Paged | Switch between continuous scrolling and page-by-page reading. |
| ‹ page › | Previous / next page (← / → work too). The page box shows the fixed page / total · percent — type a number and press Enter to jump; in scroll mode it shows the progress percent. |
| 🔍 | **Search** — find a keyword anywhere in the book and jump to a result. |
| ✎ (pencil) | **Cross-page highlight · start** — mark the opening of a passage, then turn the page. |
| ✎✓ (pencil, check) | **Cross-page highlight · finish** — highlight everything between the marked start and the current selection. |
| ⋯ | **More** — interface language and the quick guide. |

Shortcuts: `Cmd/Ctrl+Shift+H` highlight the selection · `Cmd/Ctrl+Z` undo.

Highlights, reading positions, and preferences are stored in this plugin's `data.json` inside your vault and never leave your machine.

## Exporting and merging

Open the highlights menu and choose **Export selected…**. The top row of the dialog picks *which* highlights to export — "All", "Today", "Select chapter", and one chip per color the book uses (your chip choice is remembered per book). The bottom row covers *this* export: sort order, target folder, and a "Set as default" box that writes them back to the settings.

**Export to Markdown** in the same menu skips the dialog and exports everything.

The plugin's settings hold the defaults: export folder, grouping (none / by chapter / by color), sort order (book order or the order you highlighted), and toggles for chapter, page number, date, note, color name and numbering.

Because every export is its own timestamped file, a book read over several sittings leaves several notes. **Merge exported highlight notes** (command palette, or the button in the settings) folds any of them into one: choose the notes, the grouping and the sort order, preview the result, and it is written to a new file. Duplicate highlights are kept once; anything that matches no highlight — your own writing, or a quote you edited — is preserved under "Other content". The source notes are never touched.

## Development

```bash
npm install
npm run dev    # watch build
npm run build  # production build
```

## Credits

EPUB rendering is powered by [epub.js](https://github.com/futurepress/epub.js).

## License

[MIT](LICENSE)
