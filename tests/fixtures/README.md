# Regression fixtures

Queste fixture sono snapshot HTML **ridotti e ricostruiti** dei casi reali usati durante lo sviluppo di CheckAziende.

Non sono copie integrali delle pagine pubbliche: contengono soltanto la struttura e i campi necessari a proteggere parser, merge e confidence engine dalle regressioni.

Casi coperti:

- Future Tech: anagrafica CompanyReports.it + bilancio RegistroAziende;
- Rubino: CompanyReports.it + Xray Finance;
- MPS Monitor: storico RegistroAziende;
- Aziende.it: ricerca pubblica per P.IVA, profilo con P.IVA verificata e confronto di settore (con anno ricostruito e senza), pagina di challenge anti-bot;
- profilo azienda su Xray: la P.IVA della società mostrata non deve diventare proprietario del sito;
- portale Creditsafe su sottodominio: dominio/brand devono produrre solo una corrispondenza prudente;
- sito corporate con P.IVA nel footer: evidenza forte.

Le fixture devono restare piccole e deterministiche. Quando cambia un parser, modificare la fixture solo se è cambiata davvero la struttura che vogliamo supportare.
