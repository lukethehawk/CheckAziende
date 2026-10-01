# CheckAziende

Estensione WebExtension per Firefox e browser Chromium che identifica l'azienda collegata al sito aperto e prepara una scheda societaria usando fonti pubbliche.

## Stato del progetto

Versione stabile: **1.1.1**

Branch principali:

- `main` — versione stabile e rilasciabile;
- `beta/manual-company-search` — sviluppo sperimentale della ricerca manuale per ragione sociale, esclusa dalla release stabile.

La release stabile mantiene la ricerca manuale per **Partita IVA**. La ricerca per ragione sociale resta separata finché il comportamento delle fonti pubbliche usate per il discovery non sarà sufficientemente affidabile.

## Funzionalità principali

CheckAziende prova a identificare il proprietario del sito con un flusso volutamente conservativo:

1. cerca una P.IVA esplicita nella pagina, dando priorità a dati strutturati, footer e aree legali;
2. se necessario controlla alcune pagine same-origin, come Privacy, Note legali, Contatti e Chi siamo;
3. distingue host, sottodominio e dominio registrabile;
4. raccoglie indizi di brand da titolo, `og:site_name`, application name, H1, logo e link alla home;
5. assegna una confidence al risultato;
6. se l'evidenza non è sufficiente mostra **Non identificata** invece di forzare un'associazione.

Una volta nota la P.IVA, i provider societari completano la scheda con anagrafica, stato, sede, REA, attività, dati economici, storico bilanci ed eventuali indicatori finanziari.

## Confidence engine

Le evidenze vengono normalizzate e pesate.

Indicativamente:

- P.IVA in dati strutturati: evidenza molto forte;
- P.IVA esplicita in footer o area legale: evidenza molto forte;
- P.IVA in Privacy / Note legali / Contatti: evidenza forte;
- dominio coerente con la società: evidenza importante;
- ragione sociale coerente con dominio e brand: evidenza utile ma non sufficiente da sola.

Soglie UI:

- `>= 90`: **Identificata**
- `65–89`: **Possibile corrispondenza**
- `< 65`: **Non identificata**

Un match basato soltanto su dominio/nome viene limitato a un massimo di 89 finché non esiste una conferma più forte.

## Gestione dei domini

`src/domain.js` costruisce un contesto riutilizzabile dai provider:

```text
hostname: frontend.computergross.it
registrableDomain: computergross.it
rootLabel: computergross
subdomain: frontend
brandHints: [...]
searchNames: [...]
```

Sono gestiti anche diversi public suffix multilivello comuni, ad esempio `.co.uk`, `.com.au` e `.co.jp`.

## Provider societari

L'architettura corrente assegna un ruolo distinto a ogni fonte:

- **CompanyReports.it** — provider canonico per anagrafica e dati economici quando la P.IVA è nota;
- **RegistroAziende.it** — fallback e verifica, utile anche per completare campi mancanti e storico bilanci;
- **Xray Finance** — arricchimento finanziario, in particolare EBITDA ed EBITDA margin;
- **Aziende.it** — confronto di settore opzionale tramite mediana di fatturato, sempre verificato sulla stessa P.IVA;
- **VIES** — verifica della Partita IVA.

Ogni provider viene accettato solo quando i dati recuperati sono coerenti con la P.IVA richiesta. Le fonti terze restano isolate in moduli separati, così possono essere corrette o sostituite senza modificare il motore di identificazione.

## Orchestrazione e cache

`src/providers/orchestrator.js` privilegia il primo render rapido e applica gli arricchimenti in modo progressivo.

- CompanyReports e Xray possono essere interrogati in parallelo;
- RegistroAziende completa o verifica i dati senza bloccare inutilmente il primo render;
- Aziende.it è un arricchimento opzionale e non modifica l'identità canonica della società;
- gli aggiornamenti tardivi vengono fusi nello stato già visibile senza rimuovere dati validi forniti da altri provider;
- gli snapshot aggregati sono salvati in `storage.local` dal background;
- i dati completi possono essere riutilizzati dalla cache e aggiornati in background secondo la logica stale-while-revalidate.

La cache aggregata usa attualmente il namespace:

```text
provider-orchestrator:v9:<P.IVA>
```

## Profilo finanziario

Quando i dati disponibili sono sufficienti, il popup può mostrare un profilo finanziario sintetico basato su indicatori interni come:

- numero di bilanci depositati;
- EBITDA margin;
- margine netto;
- trend del fatturato;
- continuità degli utili;
- costo del personale e relativa incidenza sul fatturato quando disponibili.

La UI espone una fascia qualitativa conservativa e non presenta questo indicatore come rating creditizio. Con copertura insufficiente dei dati il risultato resta **Dati limitati**.

## Confronto di settore con Aziende.it

Aziende.it è separato dal provider canonico CompanyReports.it.

Dopo il primo render può aggiungere un confronto tra il fatturato dell'azienda e la mediana del relativo settore/provincia. La pagina viene accettata soltanto se la P.IVA coincide esattamente con quella della scheda corrente.

Se il dato non è disponibile, il sito limita le richieste oppure il permesso manca, la sezione resta nascosta senza influenzare anagrafica e dati finanziari principali.

Su Firefox l'accesso a `https://www.aziende.it/*` è gestito come permesso host opzionale nel pacchetto generato. La richiesta parte soltanto da un'azione esplicita dell'utente nella sezione **Confronto di settore**. Chrome, Edge e Opera mantengono invece il relativo host permission nel pacchetto Chromium.

## Privacy e permessi

CheckAziende non richiede accesso permanente a tutti i siti visitati.

La pagina corrente viene analizzata localmente quando l'utente apre l'estensione tramite `activeTab` e `scripting`. Le eventuali pagine Privacy/Contatti/Legal vengono controllate soltanto sullo stesso origin.

Le richieste cross-origin sono limitate ai provider configurati nel manifest e a VIES.

## Installazione temporanea su Firefox

1. Clona o scarica il repository.
2. Installa le dipendenze se necessario.
3. Esegui:

```bash
npm run build:stores
```

4. Apri `about:debugging#/runtime/this-firefox`.
5. Clicca **Carica componente aggiuntivo temporaneo**.
6. Seleziona `dist/firefox/manifest.json`.

Il `manifest.json` nella radice è orientato ai browser Chromium e usa `background.service_worker`. Il build genera il manifest Firefox compatibile con `background.scripts` e applica le differenze di permessi richieste dai diversi store.

Dopo una modifica, rigenera il build e usa **Ricarica** nella scheda dell'estensione in `about:debugging`.

## Build e validazione store

Generazione dei pacchetti:

```bash
npm run build:stores
```

Validazione dei manifest e dei pacchetti:

```bash
npm run validate:stores
```

Il workflow di release produce pacchetti separati per:

- Firefox;
- Chrome;
- Edge;
- Opera.

Le release GitHub vengono generate a partire dai tag `v*`.

## Test

Esegui la suite completa con:

```bash
npm test
```

È disponibile anche il controllo sintattico dei moduli principali:

```bash
npm run syntax
```

I test includono casi reali ricostruiti e regressioni su:

- gestione di sottodomini e dominio registrabile;
- normalizzazione delle forme societarie;
- confidence e identificazione conservativa;
- directory e pagine che descrivono società terze;
- fallback Privacy/Legal;
- merge progressivo dei provider;
- storico bilanci e promozione dell'esercizio più recente;
- Xray e transient HTTP;
- Aziende.it e gestione dei permessi Firefox;
- reset dei dati quando cambia la società visualizzata.

Le fixture sono in `tests/fixtures/` e contengono soltanto la struttura e i campi necessari ai test.

## Struttura principale

```text
manifest.json
src/
  confidence.js
  company.js
  domain.js
  financial-evaluation.js
  scanner.js
  permissions.js
  background/
    provider-snapshot.js
    service-worker.js
  providers/
    vies.js
    companyreports.js
    aziende.js
    xray.js
    registroaziende.js
    orchestrator.js
    snapshot-client.js
  popup/
    popup.html
    popup.css
    popup.js
    data-completion.js
scripts/
  build-stores.mjs
  validate-store-builds.mjs
tests/
  fixtures/
```

## Branching

La policy consigliata per il repository è semplice:

- `main` contiene solo codice stabile;
- feature e fix vengono sviluppati su branch temporanei;
- dopo il merge i branch temporanei possono essere eliminati;
- `beta/manual-company-search` resta separato perché contiene una funzione volutamente esclusa dalla release stabile.

## Roadmap

Possibili evoluzioni:

- feedback **È questa / Non è questa** con backend e protezione da abuso;
- Public Suffix List completa;
- ulteriore separazione tra controller e renderer del popup;
- resolver dedicato dominio → proprietario del sito, mantenuto separato e disattivabile;
- eventuale reintegro della ricerca per ragione sociale quando il discovery sarà sufficientemente affidabile.

L'obiettivo resta privilegiare identificazioni verificabili e ridurre i falsi positivi, anche a costo di mostrare **Non identificata** nei casi ambigui.