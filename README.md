# Q.U.I.Z. Maker

App web locale in italiano: configurazione Q.U.I.Z., domande singole, correzione con spiegazione, punteggi parziali, interruzione e riepilogo con ripasso mirato. Interfaccia responsive e utilizzabile da tastiera.

## Avvio

Richiede Node.js 24 o superiore. Nessuna dipendenza da installare.

1. Copia `.env.example` in `.env`.
2. Imposta `MISTRAL_API_KEY` nel file `.env`, senza condividerla in chat.
3. Esegui `pnpm start`.
4. Apri **http://localhost:3000**.

Per provarlo dal telefono sulla stessa rete Wi-Fi usa `pnpm start:lan`: il terminale mostra un indirizzo con un codice di accesso nuovo a ogni avvio. Aprilo sul telefono (al primo avvio Windows chiede di consentire Node nel firewall: scegli solo “Reti private”). Senza codice gli altri dispositivi della rete non possono usare il quiz né il tuo credito.

Senza chiave puoi esplorare la configurazione, ma non generare quiz. Modello predefinito: `mistral-small-latest`, modificabile con `AI_MODEL`. Le chiamate consumano il credito del tuo account Mistral. La generazione iniziale prepara tutto il quiz; le risposte multiple e “non so” vengono corrette senza altre chiamate, quelle libere e snippet richiedono una chiamata ciascuna.

## Sostituire Mistral

Il dominio (`server/quiz.js`) riceve un provider con un solo metodo:

```js
async complete({ system, input }) // restituisce un oggetto JSON
```

Per un servizio compatibile con Chat Completions e JSON mode, modifica solo `.env` e riavvia:

```dotenv
AI_PROVIDER=compatible
AI_BASE_URL=https://provider.example/v1
AI_API_KEY=imposta-la-chiave-solo-nel-file-env
AI_MODEL=nome-modello
```

Per API con un protocollo differente aggiungi un adattatore in `server/providers.js` che implementi lo stesso contratto. Non occorre modificare interfaccia, punteggi o riepilogo. La compatibilità di endpoint e JSON mode va verificata per il provider scelto.

Riferimento Mistral: [Chat Completions](https://docs.mistral.ai/studio/conversations/chat-completion) e [JSON mode](https://docs.mistral.ai/studio/conversations/structured-output/json_mode).

## Comportamento

- Puoi descrivere il quiz in una frase (es. “10 domande facili a risposta multipla sugli array in JavaScript”): l'AI riconosce gli elementi Q.U.I.Z. presenti. Se ci sono tutti e quattro il quiz parte subito, altrimenti il wizard chiede solo quelli mancanti, nell'ordine Q→U→I→Z. Ogni analisi è una chiamata AI, al massimo una ogni due secondi.
- Il wizard raccoglie un elemento mancante alla volta, con riepilogo delle scelte (✅ / ❌). I dati già forniti restano modificabili. Invio nei campi di testo equivale al pulsante del passo.
- Argomenti vaghi o snippet fuori dalla programmazione producono un chiarimento, senza avviare il quiz: il wizard torna direttamente al passo da correggere, con la scelta precedente modificabile.
- Nelle risposte multiple sbagliate la spiegazione dice anche perché l'opzione scelta è errata. Questi commenti sono generati insieme al quiz: nessuna chiamata AI in più.
- Nei mix si alternano tre tipi per la programmazione, due negli altri argomenti; per pacchetti non divisibili per tre la differenza è al massimo una domanda.
- Soluzioni e rubriche restano sul server. Il browser riceve la soluzione solo dopo la valutazione.
- Le domande sono generate in anticipo con concetti distinti; il server corregge piccole difformità di formato (spazi, campi vuoti mancanti, delimitatori markdown nel codice) e rifiuta duplicati di testo o concetto e formati non validi.
- “Da ripassare” raggruppa per area tutte le domande sbagliate o parziali, in 2-4 punti con i numeri delle domande; oltre la terza area le restanti confluiscono in “Altri concetti”. Somiglianze semantiche, correttezza didattica e aderenza della difficoltà dipendono anche dal modello: non c'è una garanzia assoluta di accuratezza AI.
- Nelle risposte multiple la posizione della risposta corretta è scelta dal server: casuale ma bilanciata tra A, B, C e D.
- Multipla: 0 o 1. Libera e snippet: 0, 0.5 o 1. “Non so”: sempre 0 con spiegazione.
- Il voto è arrotondato al mezzo punto; il livello usa la percentuale effettiva, prima dell'arrotondamento. In caso di interruzione il denominatore è il numero di domande svolte.
- Ricaricando la pagina riprendi la sessione tramite cookie HttpOnly. Sessioni solo in memoria: scadono dopo quattro ore di inattività e si perdono riavviando il server.

## Verifiche

```sh
pnpm test
pnpm check
```

I test usano provider simulati e non consumano credito. La verifica reale della generazione e della valutazione Mistral richiede una chiave configurata.

## Ambito della versione

Il server ascolta solo su `127.0.0.1`: questa è una versione per uso locale, senza account, database o pubblicazione. L'interfaccia si adatta anche a schermi piccoli; per accedervi da un telefono occorrerà distribuire il servizio con HTTPS e aggiungere autenticazione e limiti di utilizzo. Non esporre semplicemente questo server su Internet.

Le risposte e l'argomento vengono inviati al provider AI configurato. La chiave resta sul server; non viene inclusa nei file pubblici né nei messaggi di errore remoti.
