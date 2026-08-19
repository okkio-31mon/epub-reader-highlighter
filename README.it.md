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
- **Evidenziazione multi-pagina** — segna un punto d'inizio, gira quante pagine vuoi e concludi da una selezione successiva per evidenziare l'intero passaggio in una volta (all'interno di un capitolo).
- **Colori usati di recente** — i colori personalizzati restano a portata di clic e spariscono dall'elenco quando nessuna evidenziazione li usa più.
- **Esportazione Markdown** — esporta tutte le evidenziazioni o solo quelle che scegli, decidendo cartella, raggruppamento, ordinamento e quali dettagli accompagnano ogni evidenziazione. Ogni esportazione crea un nuovo file con data e ora: nulla viene mai sovrascritto.
- **Unione delle note esportate** — fonde più esportazioni dello stesso libro in una sola: i duplicati vengono rimossi e ciò che hai scritto resta intatto. Gli originali non vengono modificati.
- **Modello di esportazione personalizzato** — decidi come viene scritta ogni evidenziazione con `{{text}}`, `{{note}}`, `{{page}}`, `{{chapter}}` e altre variabili, con un blocco condizionale che compare solo se esiste una nota.
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
| ✎ (matita) | **Evidenziazione multi-pagina · inizio** — segna l'inizio di un passaggio, poi gira pagina. |
| ✎✓ (matita con spunta) | **Evidenziazione multi-pagina · fine** — evidenzia tutto tra l'inizio segnato e la selezione attuale. |
| ⋯ | **Altro** — lingua dell'interfaccia e guida rapida. |

Scorciatoie: `Cmd/Ctrl+Shift+H` evidenzia la selezione · `Cmd/Ctrl+Z` annulla.

Evidenziazioni, posizioni di lettura e preferenze sono salvate nel `data.json` di questo plugin dentro il tuo vault e non lasciano mai il tuo dispositivo.

## Esportare e unire

Dal menu evidenziazioni scegli **Esporta selezionate…**. La riga in alto della finestra sceglie *quali* evidenziazioni esportare: «Tutte», «Oggi», «Seleziona capitolo» e un pallino per ogni colore usato dal libro (la scelta dei pallini viene ricordata per ogni libro). La riga in basso riguarda *questa* esportazione: ordinamento, cartella di destinazione e la casella «Imposta come predefinito», che li riscrive nelle impostazioni.

**Esporta in Markdown**, nello stesso menu, salta la finestra ed esporta tutto.

Le impostazioni dell'estensione contengono i valori predefiniti: cartella di esportazione, raggruppamento (nessuno / per capitolo / per colore), ordinamento (ordine del libro oppure ordine di evidenziazione) e gli interruttori per capitolo, numero di pagina, data, nota, nome del colore e numerazione.

Attivando **Usa un modello personalizzato** quegli interruttori lasciano il posto a un riquadro in cui decidi la forma di ogni voce: `{{index}}`, `{{text}}`, `{{note}}`, `{{page}}`, `{{chapter}}`, `{{book}}`, `{{date}}`, `{{time}}`, `{{color}}`. Ciò che sta tra `{{#note}}` e `{{/note}}` viene scritto solo se la nota esiste, così le voci senza nota non lasciano etichette vuote. I titoli dei gruppi e il separatore restano all'estensione: l'unione si basa su di essi.

Poiché ogni esportazione è un file a sé con data e ora, un libro letto in più sessioni lascia più note. **Unisci le note di evidenziazioni esportate** (tavolozza dei comandi o pulsante nelle impostazioni) ne fonde quante ne vuoi in una sola: scegli le note, il raggruppamento e l'ordinamento, guarda l'anteprima e il risultato viene scritto in un nuovo file. Le evidenziazioni ripetute restano una volta sola; ciò che non corrisponde a nessuna evidenziazione — quello che hai scritto tu o una citazione che hai modificato — resta sotto «Altri contenuti». Le note di partenza non vengono mai toccate.

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
