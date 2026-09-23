import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRegistroSlugCandidates,
  parseRegistroAziendeText
} from "../src/providers/registroaziende.js";

test("builds RegistroAziende slug from company and city", () => {
  const slugs = buildRegistroSlugCandidates(
    ["Future Tech S.R.L."],
    ["Basiglio"]
  );

  assert.ok(slugs.includes("future-tech-srl-basiglio"));
});

test("parses RegistroAziende company and financial history", () => {
  const text = `
Dati aziendali: Future Tech Srl, P.IVA 11295150152
Stato
Attiva
Ragione sociale
Future Tech S.R.L.
P.IVA
11295150152
Città
BASIGLIO
Indirizzo
VIA RESIDENZA ACACIE, 601
Provincia
Milano
Regione
Lombardia
Codice ATECO 2025
46.50.1: Commercio all'ingrosso di computer, unità periferiche e software
Dipendenti
0-9
€ 1.99 M
Fatturato
2024
€ 236.01 K
Utile/Perdita
2024
2022
€ 1.765.110
€ 166.073
2023
€ 1.635.153
€ 173.389
2024
€ 1.992.222
€ 236.014
`;

  const company = parseRegistroAziendeText(text);

  assert.equal(company.vat, "11295150152");
  assert.equal(company.status, "Attiva");
  assert.equal(company.financials.revenue.value, 1_990_000);
  assert.equal(company.financials.revenue.year, 2024);
  assert.equal(company.financials.profit.value, 236_010);
  assert.equal(company.financials.balanceHistory.length, 3);
  assert.equal(company.financials.balanceHistory[0].year, 2024);
  assert.equal(company.financials.balanceHistory[0].revenue, 1_992_222);
});

test("validates slug variants for another known public page", () => {
  const slugs = buildRegistroSlugCandidates(
    ["Rubino - S.R.L."],
    ["Giffoni Valle Piana"]
  );

  assert.ok(slugs.includes("rubino-srl-giffoni-valle-piana"));
});
