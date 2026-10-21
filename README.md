# Q.U.I.Z. Maker

App web in italiano, utilizzabile in locale, online su Render e come app Android: configurazione Q.U.I.Z., domande singole, correzione con spiegazione, punteggi parziali, interruzione e riepilogo con ripasso mirato. Interfaccia responsive e utilizzabile da tastiera.

## Avvio

Richiede Node.js 24 o superiore. Il server non ha dipendenze; `pnpm install` serve solo per l'app Android (Capacitor).

1. Copia `.env.example` in `.env`.
2. Imposta `MISTRAL_API_KEY` nel file `.env`, senza condividerla in chat.
3. Esegui `pnpm start`.
4. Apri **http://localhost:3000**.

Per provarlo dal telefono sulla stessa rete Wi-Fi usa `pnpm start:lan`: il terminale mostra un indirizzo con un codice di accesso nuovo a ogni avvio. Aprilo sul telefono (al primo avvio Windows chiede di consentire Node nel firewall: scegli solo “Reti private”). Senza codice gli altri dispositivi della rete non possono usare il quiz né il tuo credito.

Senza chiave puoi esplorare la configurazione, ma non generare quiz. Modello predefinito: `mistral-small-latest`, modificabile con `AI_MODEL`. Le chiamate consumano il credito del tuo account Mistral. La generazione iniziale prepara tutto il quiz; le risposte multiple e “non so” vengono corrette senza altre chiamate, quelle libere e snippet richiedono una chiamata ciascuna.

## Pubblicazione su Render

Il servizio Web Node su Render usa:

- build: `pnpm install --frozen-lockfile --prod`
- avvio: `pnpm start`

Variabili d'ambiente, da impostare solo nel pannello di Render (Environment), mai nel codice:

| Variabile | Valore |
|---|---|
| `MISTRAL_API_KEY` | la chiave Mistral |
| `ACCESS_CODE` | codice di accesso scelto da te, almeno 8 caratteri |
| `AI_MODEL` | facoltativa, es. `mistral-medium-latest` |

Quando Render imposta `RENDER_EXTERNAL_HOSTNAME`, il server passa in modalità pubblica: senza `ACCESS_CODE` non si avvia. Ogni dispositivo inserisce il codice una volta; resta ricordato per 180 giorni in un cookie HttpOnly e Secure, che contiene un'impronta del codice e non il codice. Cambiando `ACCESS_CODE` tutti gli accessi scadono. Dopo 10 codici errati in 15 minuti l'accesso si blocca temporaneamente per tutti.

`GET /health` risponde senza codice ed è pensato per il controllo di Render o per un cron job che tenga sveglio il piano gratuito (che altrimenti si sospende dopo 15 minuti di inattività).

## App Android

L'app (Capacitor) apre il servizio pubblicato, indicato in `capacitor.config.json` (`server.url`): i miglioramenti al quiz arrivano senza reinstallare l'APK. `app-shell/` contiene solo la pagina mostrata se il server non è raggiungibile.

Richiede JDK 21 e Android SDK (`android/local.properties` con `sdk.dir`, escluso da git).

```sh
pnpm install
pnpm exec cap sync android
cd android && ./gradlew assembleDebug
```

Icona e schermata di avvio partono dalle immagini in `assets/` (rigenerabili con `node assets/genera-icona.mjs`, che usa `sharp` installato con `@capacitor/assets`): `pnpm exec capacitor-assets generate --android --iconBackgroundColor '#254b40' --splashBackgroundColor '#f6f5f0' --splashBackgroundColorDark '#1f3631'`.

L'APK di prova è in `android/app/build/outputs/apk/debug/app-debug.apk`. Si installa sul telefono consentendo l'installazione da origini sconosciute. Ricostruirlo serve solo se cambiano indirizzo, nome, icona o configurazione nativa.

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
- Gli argomenti ampi ma riconoscibili (es. “storia generale”, “cultura generale”) sono accettati e le domande si distribuiscono su periodi e sottotemi diversi. Argomenti senza un ambito comprensibile (es. “tutto”) o snippet fuori dalla programmazione producono un chiarimento, senza avviare il quiz: il wizard torna direttamente al passo da correggere, con la scelta precedente modificabile.
- Dopo la generazione una seconda chiamata AI ricontrolla le domande a risposta multipla: quelle con più opzioni valide o ambigue vengono riscritte prima dell'inizio del quiz (circa 5 secondi in più). Se la verifica non riesce o produce correzioni non valide, si usa il quiz generato.
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

Con `pnpm start` il server ascolta solo su `127.0.0.1`. Le modalità rete locale (`--lan`) e pubblica richiedono sempre un codice di accesso. Non ci sono account né database: un solo codice condiviso protegge il credito AI, e sessioni e quiz in corso si perdono a ogni riavvio o sospensione del servizio.

Le risposte e l'argomento vengono inviati al provider AI configurato. La chiave resta sul server; non viene inclusa nei file pubblici né nei messaggi di errore remoti.
