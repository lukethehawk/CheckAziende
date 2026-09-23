# CheckAziende

Estensione WebExtension per Firefox e browser Chromium che identifica l'azienda collegata al sito aperto e prepara una scheda societaria da fonti pubbliche.

## Stato

Versione `0.5.0`.

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
- mapping dominio-società confermato che può diventare **Identificata**.

## Struttura

```text
manifest.json
src/
  confidence.js
  domain.js
  scanner.js
  providers/
    vies.js
  popup/
    popup.html
    popup.css
    popup.js
tests/
  domain-confidence.test.mjs
```

## Provider societario

La versione 0.4.0 aggiunge un primo provider per Aziende.it.

Il provider:
- cerca una scheda tramite ragione sociale/brand e varianti delle forme giuridiche;
- quando la P.IVA è già nota, accetta la scheda solo se la P.IVA coincide;
- quando la P.IVA non è presente sul sito, passa la società candidata al confidence engine;
- normalizza fatturato, utile/perdita, dipendenti, margine netto, fatturato per dipendente, ATECO, forma giuridica, REA, PEC, SDI e data di iscrizione;
- usa una cache locale di 12 ore;
- è isolato in `src/providers/aziende.js`, quindi può essere sostituito o affiancato da altre fonti.

L'accesso cross-origin è limitato a `www.aziende.it` e VIES.

## Prossimi passi

- feedback **È questa / Non è questa** con backend e protezione da abuso;
- secondo provider/fallback per aumentare copertura e resilienza;
- storico degli ultimi bilanci;
- ricerca manuale anche per ragione sociale;
- packaging e release Firefox/Chromium.

Le integrazioni con fonti terze devono restare isolate in moduli provider, così una fonte può essere sostituita senza modificare il motore di identificazione.


## EBITDA e valutazione finanziaria

La versione 0.5.0 aggiunge un secondo provider opzionale basato sulle schede pubbliche di Xray Finance.

Quando la P.IVA è già stata identificata:
- CheckAziende cerca la società su Xray Finance;
- accetta la scheda soltanto se la P.IVA coincide;
- importa EBITDA ed EBITDA margin;
- mantiene Aziende.it come fonte primaria per anagrafica, fatturato, utile e storico bilanci;
- se Xray Finance non trova una corrispondenza valida, la scheda continua a funzionare senza EBITDA.

È presente anche un motore interno di valutazione finanziaria che considera stato, anzianità, numero di bilanci disponibili, EBITDA margin, margine netto, trend del fatturato e continuità degli utili. Il punteggio non viene ancora mostrato nell'interfaccia: servirà per una futura scala rosso-verde e per il requisito operativo di almeno due bilanci depositati.

L'utile è mostrato in verde quando positivo e in rosso con segno meno quando negativo. Il badge con il numero di bilanci è stato rimosso; restano soltanto stato dell'impresa e anzianità.
