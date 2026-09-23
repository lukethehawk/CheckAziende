# CheckAziende

Estensione WebExtension per Firefox e browser Chromium che identifica l'azienda collegata al sito aperto e raccoglie dati societari da fonti pubbliche.

## MVP 0.1.0

La prima versione include:

- rilevamento automatico della Partita IVA italiana nella pagina corrente;
- controllo del checksum della P.IVA;
- priorità a footer, aree legali e contesti con "Partita IVA" / "P.IVA";
- fallback sull'intero testo/HTML della pagina;
- inserimento manuale;
- verifica VIES della Commissione europea;
- visualizzazione di ragione sociale e sede quando VIES le restituisce;
- cache locale di 24 ore;
- architettura a provider pronta per aggiungere fonti economico-finanziarie.

> VIES verifica l'abilitazione agli scambi intracomunitari. Una P.IVA italiana può essere formalmente valida e attiva in Italia anche se non risulta in VIES.

## Privacy

CheckAziende non richiede accesso permanente a tutti i siti.

La pagina corrente viene analizzata localmente solo quando l'utente apre l'estensione, tramite i permessi `activeTab` e `scripting`. Per la verifica VIES viene trasmessa soltanto la Partita IVA rilevata o inserita.

## Installazione temporanea su Firefox

1. Clona o scarica il repository.
2. Apri `about:debugging#/runtime/this-firefox`.
3. Clicca **Carica componente aggiuntivo temporaneo**.
4. Seleziona `manifest.json`.
5. Apri un sito aziendale e clicca CheckAziende.

Dopo una modifica al codice, usa **Ricarica** nella scheda dell'estensione in `about:debugging`.

L'installazione temporanea viene rimossa al riavvio di Firefox. Una distribuzione stabile richiederà la firma Mozilla.

## Chrome / Edge / Opera

Il progetto usa Manifest V3 e può essere caricato anche come estensione non pacchettizzata nei browser Chromium.

## Struttura

```text
manifest.json
src/
  scanner.js
  providers/
    vies.js
  popup/
    popup.html
    popup.css
    popup.js
```

## Roadmap

La prossima fase è il nucleo "QuantoFattura-like":

- fatturato e anno di riferimento;
- utile/perdita;
- dipendenti;
- codice ATECO;
- forma giuridica;
- capitale sociale;
- fallback tra più fonti pubbliche;
- indicazione della fonte di ogni dato;
- gestione di più P.IVA trovate nella stessa pagina;
- ricerca controllata delle pagine Contatti / Privacy / Note legali quando la homepage non contiene la P.IVA;
- packaging e release Firefox/Chromium.

Le integrazioni con fonti terze devono essere isolate in moduli provider, in modo da poter disabilitare o sostituire una fonte senza rompere l'estensione.
