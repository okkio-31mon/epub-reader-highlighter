# EPUB Reader and Highlighter

Read EPUB books directly inside Obsidian, mark them up with color-coded highlights and notes, and export everything to Markdown.

## Features

- **In-app EPUB reader** — open any `.epub` file in your vault and read it without leaving Obsidian.
- **Scroll or paginated mode** — switch between continuous scrolling and page-by-page reading; turn pages with the on-screen buttons or the ← / → arrow keys.
- **Color-coded highlights** — select text and pick from several highlight colors. Highlights are saved per book and restored when you reopen it.
- **Notes on highlights** — attach a comment to any highlight.
- **Highlights panel** — view every highlight in the current book with its page number, text, and note; jump back to the original location, edit notes, or delete.
- **Undo** — `Cmd/Ctrl+Z` reverses the last highlight or deletion.
- **Reading themes** — built-in background colors plus a custom color picker, adjustable font and font size; link colors adapt to the background for readability.
- **Markdown export** — export all highlights of a book (page, text, note) to a Markdown note via the command palette.

## Installation

### From the community store
Search for "EPUB Reader and Highlighter" in **Settings → Community plugins → Browse**, install, and enable.

### Manual
1. Download `main.js`, `manifest.json`, and `styles.css` from the latest [release](https://github.com/okkio-31mon/epub-reader-highlighter/releases).
2. Copy them into `<your-vault>/.obsidian/plugins/epub-reader-highlighter/`.
3. Reload Obsidian and enable the plugin in **Settings → Community plugins**.

## Usage

1. Place an `.epub` file anywhere in your vault and click it to open.
2. Select text to highlight; click a color in the popup.
3. Click an existing highlight to add or edit a note.
4. Use the top-right buttons to open the highlights list (▤) or reading settings (＋).
5. Run **"导出当前 EPUB 的高亮到 Markdown"** from the command palette to export.

Highlights are stored in this plugin's `data.json` inside your vault and never leave your machine.

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
