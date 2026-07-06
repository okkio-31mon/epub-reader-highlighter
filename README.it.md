# EPUB Reader and Highlighter

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | Italiano

Leggi i libri EPUB direttamente dentro Obsidian, annotali con evidenziazioni colorate e note, ed esporta tutto in Markdown.

## Funzionalità

- **Lettore EPUB integrato** — apri qualsiasi file `.epub` del tuo vault e leggilo senza uscire da Obsidian.
- **Modalità scorrimento o pagine** — passa dalla lettura a scorrimento continuo a quella pagina per pagina; volta pagina con i pulsanti a schermo o con le frecce ← / →.
- **Numeri di pagina fissi (stile Apple Books)** — l'intero libro viene impaginato in background alla dimensione della finestra e al carattere attuali, quindi il totale delle pagine resta fisso durante la lettura e ogni voltata di pagina avanza esattamente di 1. Alla prima apertura appare brevemente «Calcolo»; il risultato viene messo in cache e ricalcolato solo quando cambiano finestra o carattere. Digita un numero nella casella per saltare direttamente a quella pagina; in modalità scorrimento viene mostrata invece la percentuale di lettura.
- **Posizione di lettura memorizzata** — chiudi il libro (o Obsidian) e alla riapertura torni al passaggio dove avevi lasciato.
- **Evidenziazioni colorate** — seleziona il testo e scegli un colore dal popup, oppure premi **`Cmd/Ctrl+Shift+H`** per evidenziare con il colore predefinito; il colore predefinito viene ricordato tra le sessioni.
- **Note sulle evidenziazioni** — aggiungi un commento a qualsiasi evidenziazione.
- **Pannello evidenziazioni** — vedi ogni evidenziazione del libro con numero di pagina, testo e nota; torna al punto originale, modifica le note o elimina.
- **Copia come citazione** — copia la selezione corrente, o tutte le evidenziazioni insieme, come blocchi `*pagina · ora*` + citazione pronti da incollare in una nota.
- **Annulla** — `Cmd/Ctrl+Z` annulla l'ultima evidenziazione o eliminazione.
- **Temi di lettura** — cinque sfondi integrati più un selettore di colore integrato (senza finestre di sistema) per qualsiasi colore personalizzato; carattere e dimensione regolabili; il colore dei link si adatta allo sfondo per restare leggibile.
- **Ricerca in tutto il libro** — cerca una parola in tutto il libro e salta a qualsiasi risultato.
- **Esportazione Markdown** — esporta tutte le evidenziazioni, o solo quelle che scegli, in una nota Markdown dal menu evidenziazioni.
- **Guida al primo avvio** — un popup una tantum spiega le icone della barra degli strumenti; lo stesso riferimento resta nella scheda impostazioni del plugin.

## Installazione

### Dallo store della community
Cerca "EPUB Reader and Highlighter" in **Impostazioni → Plugin della community → Sfoglia**, installa e attiva.

### Manuale
1. Scarica `main.js`, `manifest.json` e `styles.css` dall'ultima [release](https://github.com/okkio-31mon/epub-reader-highlighter/releases).
2. Copiali in `<il-tuo-vault>/.obsidian/plugins/epub-reader-highlighter/`.
3. Ricarica Obsidian e attiva il plugin in **Impostazioni → Plugin della community**.

## Utilizzo

1. Metti un file `.epub` in un punto qualsiasi del vault e cliccalo per aprirlo.
2. Seleziona il testo da evidenziare — clicca un colore nel popup, oppure premi `Cmd/Ctrl+Shift+H` per il colore predefinito.
3. Clicca un'evidenziazione esistente per aggiungere o modificare una nota.
4. Usa la barra degli strumenti per sfogliare il sommario, copiare una citazione, aprire il menu evidenziazioni, regolare carattere e sfondo, voltare pagina e cercare nel libro.

### Icone della barra degli strumenti

| Icona | Cosa fa |
| --- | --- |
| ☰ (menu) | **Sommario** — sfoglia i capitoli e salta a uno di essi. |
| 〝 (citazione) | **Copia citazione** — copia il testo selezionato come blocco `*pagina · ora*` + citazione. |
| ▮ (evidenziatore) | **Menu evidenziazioni** — apri l'elenco, copia tutto, esporta (tutte o selezionate) e imposta il colore predefinito. |
| ≡ (cursori) | **Impostazioni di lettura** — carattere, dimensione e sfondo; la ruota dei colori apre un selettore integrato per qualsiasi colore. |
| Scorri / Pagine | Passa dalla lettura a scorrimento continuo a quella pagina per pagina. |
| ‹ pagina › | Pagina precedente / successiva (anche con ← / →). La casella mostra pagina fissa / totale · percentuale — digita un numero e premi Invio per saltare; in modalità scorrimento mostra la percentuale di lettura. |
| 🔍 | **Cerca** — trova una parola in tutto il libro e salta a un risultato. |
| ⋯ | **Altro** — lingua dell'interfaccia e guida rapida. |

Scorciatoie: `Cmd/Ctrl+Shift+H` evidenzia la selezione · `Cmd/Ctrl+Z` annulla.

Evidenziazioni, posizioni di lettura e preferenze sono salvate nel `data.json` di questo plugin dentro il tuo vault e non lasciano mai il tuo dispositivo.

## Sviluppo

```bash
npm install
npm run dev    # build in watch mode
npm run build  # build di produzione
```

## Riconoscimenti

Il rendering EPUB è basato su [epub.js](https://github.com/futurepress/epub.js).

## Licenza

[MIT](LICENSE)
