# CheckAziende

Estensione WebExtension per Firefox e browser Chromium che identifica l'azienda collegata al sito aperto e prepara una scheda societaria da fonti pubbliche.

## Stato

Versione `0.8.5`.

Il flusso di identificazione è volutamente conservativo:

1. cerca una P.IVA esplicita nella pagina, dando priorità a dati strutturati, footer e aree legali;
2. se non trova nulla, controlla un piccolo insieme di pagine same-origin come Privacy, Note legali, Contatti e Chi siamo;
3. distingue host, sottodominio e dominio registrabile, ad esempio `frontend.computergross.it` → `computergross.it`;
4. raccoglie indizi di brand da titolo, `og:site_name`, application name, H1 e logo;
5. assegna una confidence al risultato;
6. se l'evidenza non basta, mostra **Non identificata** invece di attribuire numeri presenti casualmente nella pagina.

## Confidence engine

Le evidenze vengono normalizzate e pesate. Esempi:

- VAT/P.IVA in dati strutturati: evidenza molto forte;
- P.IVA esplicita in footer o area legale: evidenza molto forte;
- P.IVA in Privacy / Note legali / Contatti: evidenza forte;
- dominio principale coincidente con quello della società: evidenza importante;
- ragione sociale coerente con dominio, titolo e brand: evidenza utile ma non sufficiente da sola.

Soglie UI:

- `>= 90`: **Identificata**
- `65–89`: **Possibile corrispondenza**
- `< 65`: **Non identificata**

Un match basato soltanto su dominio/nome viene limitato a un massimo di 89 finché non esiste una conferma più forte. Questo evita che un semplice logo o un nome simile diventino una falsa identificazione.

## Identificazione dei domini

`src/domain.js` espone un contesto riutilizzabile dai provider societari:

```text
hostname: frontend.computergross.it
registrableDomain: computergross.it
rootLabel: computergross
subdomain: frontend
brandHints: [...]
searchNames: [...]
```

La gestione dei public suffix multilivello copre i casi più comuni (ad esempio `.co.uk`, `.com.au`, `.co.jp`). In futuro può essere sostituita da una Public Suffix List completa senza cambiare l'interfaccia del motore.

## Privacy

CheckAziende non richiede accesso permanente a tutti i siti.

La pagina corrente viene analizzata localmente solo quando l'utente apre l'estensione tramite `activeTab` e `scripting`. Le pagine Privacy/Contatti/Legal vengono controllate soltanto sullo stesso origin. Per la verifica VIES viene trasmessa soltanto la Partita IVA.

## Installazione temporanea su Firefox

1. Clona o scarica il repository.
2. Apri `about:debugging#/runtime/this-firefox`.
3. Clicca **Carica componente aggiuntivo temporaneo**.
4. Seleziona `manifest.json`.
5. Apri un sito e clicca CheckAziende.

Dopo una modifica usa **Ricarica** nella scheda dell'estensione in `about:debugging`.

## Test

```bash
npm test
```

I test coprono anche:

- `frontend.computergross.it` → `computergross.it`;
- dominio `.co.uk`;
- normalizzazione delle forme societarie;
- match P.IVA forte;
- match dominio/nome che deve restare **Possibile corrispondenza**;
- mapping dominio-società confermato che può diventare **Identificata**;
- fixture HTML ridotte e ricostruite dei casi reali Future Tech, Rubino, MPS Monitor, Xray e Creditsafe;
- regressioni cross-provider, ad esempio Rubino che deve mantenere l'arricchimento Xray e Future Tech che deve promuovere il bilancio più recente di RegistroAziende;
- sicurezza sulle directory: una società descritta in una pagina Xray non deve diventare automaticamente il proprietario del dominio.

Le fixture sono in `tests/fixtures/` e contengono solo la struttura e i campi necessari ai test, non copie integrali delle pagine pubbliche.

## Struttura

```text
manifest.json
src/
  confidence.js
  company.js
  domain.js
  scanner.js
  providers/
    vies.js
    aziende.js
    xray.js
    registroaziende.js
    orchestrator.js
  popup/
    popup.html
    popup.css
    popup.js
tests/
  domain-confidence.test.mjs
```

## Provider societari

L'architettura corrente usa tre fonti con ruoli separati:

- **CompanyReports.it** è il provider canonico per anagrafica e dati economici pubblici quando la P.IVA è nota;
- **RegistroAziende.it** è il fallback/verificatore e può completare campi mancanti e storico dei bilanci;
- **Xray Finance** è un provider di arricchimento finanziario, in particolare per EBITDA ed EBITDA margin.

Il provider CompanyReports usa direttamente la P.IVA nella URL pubblica e accetta la scheda solo se la P.IVA estratta coincide con quella richiesta. Normalizza i campi pubblici disponibili mantenendo invariata l'interfaccia usata dall'orchestratore.

Per compatibilità interna il modulo primario conserva ancora il nome storico `src/providers/aziende.js`; il nome del file non indica più la fonte utilizzata.

L'accesso cross-origin è limitato a VIES e ai tre provider configurati nel `manifest.json`.

## Prossimi passi

- feedback **È questa / Non è questa** con backend e protezione da abuso;
- ricerca manuale anche per ragione sociale;
- Public Suffix List completa per i domini internazionali;
- fixture HTML reali per i provider;
- separazione ulteriore tra controller e renderer del popup;
- possibile resolver dedicato dominio → proprietario del sito, mantenuto separato e disattivabile;
- packaging e release Firefox/Chromium.

Le integrazioni con fonti terze devono restare isolate in moduli provider, così una fonte può essere sostituita senza modificare il motore di identificazione.


## EBITDA e valutazione finanziaria

La versione 0.5.0 aggiunge un secondo provider opzionale basato sulle schede pubbliche di Xray Finance.

Quando la P.IVA è già stata identificata:
- CheckAziende cerca la società su Xray Finance;
- accetta la scheda soltanto se la P.IVA coincide;
- importa EBITDA ed EBITDA margin;
- mantiene il provider canonico come fonte primaria per anagrafica, fatturato e utile; RegistroAziende completa lo storico dei bilanci quando disponibile;
- se Xray Finance non trova una corrispondenza valida, la scheda continua a funzionare senza EBITDA.

È presente anche un motore interno di valutazione finanziaria che considera stato, anzianità, numero di bilanci disponibili, EBITDA margin, margine netto, trend del fatturato e continuità degli utili. Il punteggio non viene ancora mostrato nell'interfaccia: servirà per una futura scala rosso-verde e per il requisito operativo di almeno due bilanci depositati.

L'utile è mostrato in verde quando positivo e in rosso con segno meno quando negativo. Il badge con il numero di bilanci è stato rimosso; restano soltanto stato dell'impresa e anzianità.


## Provider orchestrator

La versione 0.6.0 introduce un orchestratore dei provider con priorità alla velocità:

- VIES continua a verificare la P.IVA;
- CompanyReports.it e Xray Finance vengono interrogati in parallelo con un budget breve;
- RegistroAziende.it viene usato come fallback bloccante solo se il provider primario è incompleto;
- quando i dati principali sono già disponibili, RegistroAziende.it viene usato in background come verifica incrociata e non ritarda il primo render;
- i risultati completi vengono memorizzati localmente per 24 ore e possono essere riutilizzati fino a 7 giorni con aggiornamento in background (stale-while-revalidate);
- eventuali conflitti su stato, fatturato o utile vengono registrati nella struttura di verifica per il futuro score di affidabilità dei dati.

RegistroAziende.it viene sempre validato sulla stessa P.IVA prima di essere accettato.

ReportAziende resta una possibile fonte futura tramite API autenticata. CompanyReports.it è invece ora integrato nel fast path tramite la scheda pubblica per P.IVA.


## Hardening 0.7.0

La versione 0.7.0 introduce un passaggio di hardening qualitativo senza modificare la UX:

- la cache negativa di Aziende.it distingue correttamente un miss memorizzato da una cache assente;
- il lookup Aziende.it per P.IVA termina appena trova un match valido, senza scandire inutilmente tutti gli slug candidati;
- VAT/P.IVA presenti nei metadati di pagine directory vengono trattati come evidenza debole se non coerenti con dominio/brand;
- gli anni finanziari mantengono la provenienza (`source`, `sources`) e l'indicazione `isFiled`;
- Xray Finance può arricchire i dati economici ma non viene considerato, da solo, prova di bilancio depositato;
- il requisito interno "almeno due bilanci depositati" conta soltanto esercizi marcati come depositati dalle fonti societarie;
- i risultati di RegistroAziende ottenuti da parser DOM e parser testuale vengono fusi per anno anziché sostituiti;
- uno snapshot provider ancora fresco non viene aggiornato ad ogni apertura: il refresh di rete parte solo quando la cache è stale;
- la CI esegue anche un controllo sintattico esplicito sui moduli dell'estensione.

Queste regole preparano il futuro score rosso-verde evitando di confondere dati economici osservati con bilanci effettivamente depositati.


## Refactor 0.7.1

La normalizzazione della società e l'arricchimento fra provider canonico, RegistroAziende e Xray sono gestiti in `src/company.js`. Il popup resta responsabile del flusso e del rendering, mentre il modello dati è ora isolato e testabile separatamente. Questo riduce il rischio di regressioni quando verranno aggiunti nuovi provider o lo score finanziario visibile.


## UI 0.7.3

Quando una scheda azienda è già visibile ma uno o più provider stanno ancora completando i dati, compare in alto una piccola riga `Completamento dati in corso…`. L'indicatore appare solo se il caricamento in background dura più di circa 350 ms e scompare automaticamente quando le richieste pendenti terminano. La logica di identificazione, merge e priorità dei provider non viene modificata.


## Fix Xray 0.7.4

Il provider Xray non memorizza più per 24 ore errori HTTP temporanei come risultati negativi. La cache Xray è stata invalidata e il caso reale `rubino-s-r-l-15` è coperto da test di regressione. Inoltre, quando una pagina profilo descrive una società terza, il titolo della pagina non viene usato per identificare il proprietario del sito nel fallback per dominio.


## Site-owner fallback 0.7.5

Le pagine Privacy/Legal possono ora fornire anche la ragione sociale del titolare del sito, non solo P.IVA e contatti. Questo copre portali come Xray Finance, la cui Privacy identifica `Xray Finance Srl` ma non ripete la P.IVA. Inoltre il testo di un link same-origin alla home viene considerato un segnale di brand del sito, utile quando il logo è testuale. La logica dei provider e dei dati finanziari resta invariata.


## Cache fix 0.7.6

Dopo il fix Xray 0.7.4 viene invalidato anche lo snapshot generale dell'orchestratore. Questo evita che una società già memorizzata senza Xray continui a riutilizzare per 24 ore un risultato incompleto senza eseguire la nuova ricerca Xray.


## Xray search-first 0.7.7

Il lookup Xray prova ora prima la ricerca pubblica per P.IVA quando la homepage espone un form utilizzabile, e usa l'enumerazione degli slug numerici solo come fallback. Le richieste speculative sono state ridotte a piccoli batch per evitare throttling prima di raggiungere profili disambiguati come `rubino-s-r-l-15`. Il retry con la ragione sociale canonica viene inoltre mantenuto in background e riutilizzato dal popup. Sono state invalidate sia la cache Xray sia la cache dell'orchestratore.


## Domain fallback 0.7.8

Quando l'estensione è aperta su un sottodominio applicativo e non trova una P.IVA locale, il fallback per dominio può ora cercare anche la variante italiana del brand nelle fonti pubbliche (es. `creditsafe.com` -> `Creditsafe Italia Srl`). Questa espansione viene usata solo nel lookup per dominio, quindi non aumenta il costo dei normali lookup per P.IVA. Non sono stati aggiunti permessi host globali.


## Privacy owner fallback 0.7.9

Il fallback Privacy/Legal estrae ora la ragione sociale del titolare usando prima la struttura HTML (intestazione `Titolare del Trattamento dei Dati` + contenuto successivo), con regex testuale come fallback. Questo evita i falsi negativi quando `DOMParser` appiattisce i ritorni a capo, come sulle schede Xray Finance. Inoltre i tentativi automatici di P.IVA non popolano più il campo di ricerca manuale, che viene svuotato nello stato `Non identificata`.


## Provider recovery 0.7.10

Gli snapshot freschi ma incompleti non congelano più per 24 ore i provider mancanti: se Xray Finance non era pronto al primo caricamento, viene ritentato in background alle aperture successive mantenendo il render immediato dalla cache. Il fallback per dominio usa ora anche RegistroAziende come sorgente di discovery, utile quando Privacy/Legal identifica il titolare per nome ma Aziende.it non espone la società. Le pagine Privacy/Legal possono inoltre fornire un hint di città dal blocco del titolare, ad esempio `Xray Finance Srl - ... Bolzano`, così RegistroAziende può risolvere lo slug corretto.


## Possibile resolver dominio → proprietario

Per ora il progetto mantiene il metodo attuale di identificazione. È stata però annotata come possibile evoluzione futura l'introduzione di un resolver dedicato al proprietario del dominio, separato dalla società descritta nella pagina.

L'obiettivo sarebbe distinguere in modo esplicito tre concetti:
- proprietario del sito/dominio;
- società descritta nella pagina corrente;
- società cercata manualmente dall'utente.

Un caso tipico è una directory o un portale dati: una pagina può descrivere una società terza, mentre il dominio appartiene a un'altra società. Il resolver lavorerebbe quindi sul dominio registrabile e sui segnali del sito, non sul contenuto aziendale della singola scheda.

Architettura ipotizzata:
- nuovo modulo isolato, ad esempio `src/site-owner-resolver.js`;
- feature flag per poterlo disattivare immediatamente in caso di regressioni;
- metodo attuale lasciato invariato come fallback;
- cache separata, ad esempio `site-owner:v1:xrayfinance.it`, senza interferire con le cache dei provider;
- stati conservativi `identified`, `possible`, `unknown`;
- solo gli owner risolti con evidenza forte verrebbero riutilizzati automaticamente alle aperture successive.

Ordine di evidenza previsto:
1. P.IVA esplicita in footer/area legale della pagina corrente;
2. P.IVA trovata in Privacy / Note legali / Contatti;
3. ragione sociale del titolare ricavata da Privacy/Legal;
4. risoluzione della ragione sociale tramite i provider societari disponibili, con CompanyReports quando la P.IVA è nota e RegistroAziende come fallback;
5. dominio, logo, `og:site_name`, copyright e brand come segnali di coerenza;
6. Xray Finance usato come verifica/arricchimento finanziario, non come fonte primaria per stabilire il proprietario del dominio.

Il resolver non dovrebbe dipendere da un singolo provider: RegistroAziende può restare utile per il discovery nome → società/P.IVA, CompanyReports per il dettaglio una volta nota la P.IVA, mentre Xray resta soprattutto un provider finanziario.

La scelta attuale è di non implementarlo ancora: i casi esistenti vengono gestiti con il flusso corrente e il resolver resta una possibile evoluzione architetturale generale, da introdurre solo se i casi directory/portali diventano abbastanza frequenti da giustificarlo.


## Profilo finanziario 0.8.0

La valutazione finanziaria interna viene ora mostrata nel popup in un accordion compatto **prima dei contatti**, così non appesantisce la scheda principale.

L'interfaccia non espone il punteggio numerico interno. Mostra invece una fascia qualitativa conservativa:

- **Solido**
- **Buono**
- **Intermedio**
- **Fragile**
- **Debole**
- **Dati limitati**

Per evitare giudizi troppo forti con informazioni incomplete, una società resta in **Dati limitati** se la copertura dei segnali è inferiore al 50% oppure se non risultano almeno due bilanci depositati.

Nell'accordion vengono mostrati, quando disponibili, bilanci depositati, EBITDA margin, margine netto, trend del fatturato, continuità degli utili e copertura dei dati. La UI specifica che si tratta di un indicatore interno basato sui dati disponibili e non di un rating creditizio.

Le fixture realistiche di Future Tech e Rubino verificano anche che il profilo resti utilizzabile dopo il merge dei provider.


## Aziende.it reliability 0.8.1

Il lookup Aziende.it è stato reso più conservativo dopo alcuni casi in cui il provider spariva temporaneamente dalla scheda pur essendo disponibile sul sito pubblico.

- i lookup per P.IVA provano ora gli slug in sequenza, dando priorità al candidato esatto, invece di aprire piccoli batch concorrenti;
- gli errori temporanei come `429` e `5xx` non vengono più memorizzati come risultati negativi;
- sui transienti viene eseguito un solo retry leggero;
- la cache negativa resta solo per i veri `404`;
- la cache provider Aziende.it è stata invalidata (`v6`);
- i nomi VIES rumorosi o con forme societarie ripetute, ad esempio `MPS MONITOR SRL A SOCIO UNICO !!S.R.L.`, generano anche la variante canonica `mps-monitor-srl`;
- un test protegge l'ordine del caso normale `FUTURE TECH SRL` → `future-tech-srl`.

La P.IVA resta sempre il controllo finale: una pagina Aziende.it viene accettata solo se il VAT trovato coincide con quello richiesto.


## Provider async merge 0.8.2

Gli aggiornamenti in background dei provider vengono ora fusi nello stato già visibile invece di partire ogni volta dallo snapshot iniziale.

Questo evita una regressione in cui Aziende.it poteva risolversi correttamente in background e comparire per un istante, ma un successivo aggiornamento Xray/Registro poteva ridisegnare la scheda usando uno stato precedente e rimuoverlo dalle fonti mostrate.

Regole:
- una fonte già risolta non viene rimossa da un aggiornamento asincrono successivo che non la contiene;
- Aziende.it resta il provider canonico una volta risolto;
- RegistroAziende e Xray continuano ad arricchire senza sostituire la fonte canonica;
- la cache generale dell'orchestratore è stata invalidata a `v8` per non riutilizzare snapshot precedenti incompleti.

Sono presenti test di regressione sulla sequenza Registro → Aziende → Xray e sul mantenimento di Aziende come primary.


## Consolidamento 0.8.3

La versione 0.8.3 consolida il passaggio del provider canonico da Aziende.it a CompanyReports.it senza modificare le logiche di identificazione, confidence, merge o rendering.

- documentata l'architettura corrente dei provider;
- allineati versione di manifest e package;
- aggiunte fixture CompanyReports ricostruite per i casi Future Tech e Rubino;
- i test di regressione usano ora fixture coerenti con il provider canonico corrente;
- le fixture legacy Aziende.it non fanno più parte della suite attiva.

Il flusso resta: **CompanyReports.it → canonico**, **RegistroAziende.it → fallback/verifica**, **Xray Finance → arricchimento**.


## Dati CompanyReports in UI 0.8.4

La versione 0.8.4 espone alcuni dati già disponibili dal provider CompanyReports senza appesantire la scheda principale.

- il **costo del personale** viene mostrato nell'accordion del profilo finanziario, con l'anno quando disponibile;
- viene calcolata automaticamente l'**incidenza costo personale / fatturato**, usando il fatturato dello stesso esercizio del costo del personale;
- il **Codice fiscale** compare nei dati societari solo quando è diverso dalla Partita IVA;
- il campo precedentemente etichettato **Iscrizione** viene mostrato come **Costituzione**, coerentemente con il dato `Fondazione` fornito da CompanyReports.

Il rapporto costo personale / fatturato conserva il riferimento allo stesso esercizio anche quando RegistroAziende promuove un fatturato più recente come dato principale.


## Directory owner detection 0.8.5

Corretto un caso reale in cui una homepage directory poteva contenere dati strutturati relativi alle aziende elencate e, contemporaneamente, la P.IVA del proprietario del sito nel footer.

Sulle pagine riconosciute come directory/ricerca:
- i VAT presenti in JSON-LD o metadati della pagina non vengono più usati come candidati proprietario del sito;
- una P.IVA trovata in un vero footer/area legale mantiene priorità;
- se il footer non è semanticamente marcato, il fallback sulla coda testuale della pagina resta attivo;
- quando la coda contiene più P.IVA, viene privilegiata l'ultima occorrenza con forte contesto legale, tipicamente quella del footer.

È presente un test di regressione sul caso `aziende.it`, dove il proprietario del sito è Ad Intend Srl (P.IVA 02357550066) ma la pagina contiene anche dati di società terze.
