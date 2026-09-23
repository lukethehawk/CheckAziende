import test from "node:test";
import assert from "node:assert/strict";

import {
  buildXrayNumberedSlugCandidates,
  buildXraySlugCandidates,
  parseXrayText
} from "../src/providers/xray.js";

test("parses Computer Gross EBITDA data expressed in thousands", () => {
  const text = `
COMPUTER GROSS S.P.A.
Fatturato e dati di Bilancio - Empoli - FI - P.IVA: 04801490485
Partita IVA 04801490485
ATECO 46.50.1
Ultimo bilancio | valori in €/000 30/04/2025
Fatturato 2025 1.821.754
EBITDA 76.084
Utile/Perdita 39.409
Dipendenti 354
Patrimonio Netto 292.840
Posizione Finanziaria Netta-218.629
Margine
76.084
EBITDA 4.18%
`;

  const company = parseXrayText(text, {
    name: "COMPUTER GROSS S.P.A."
  });

  assert.equal(company.vat, "04801490485");
  assert.equal(company.financials.year, 2025);
  assert.equal(company.financials.revenue, 1821754000);
  assert.equal(company.financials.ebitda, 76084000);
  assert.equal(company.financials.profit, 39409000);
  assert.equal(company.financials.employees, 354);
  assert.equal(company.financials.netWorth, 292840000);
  assert.equal(company.financials.pfn, -218629000);
  assert.equal(company.financials.ebitdaMargin, 4.18);
});

test("parses MPS Monitor EBITDA and margin", () => {
  const text = `
MPS MONITOR S.R.L.
P.IVA: 03122040987
Partita IVA 03122040987
Ultimo bilancio | valori in €/000 31/12/2024
Fatturato 2024 4.787
EBITDA 1.858
Utile/Perdita 1.390
Dipendenti 16
Patrimonio Netto 1.404
Posizione Finanziaria Netta-1.235
EBITDA 38.81%
`;

  const company = parseXrayText(text);

  assert.equal(company.financials.revenue, 4787000);
  assert.equal(company.financials.ebitda, 1858000);
  assert.equal(company.financials.ebitdaMargin, 38.81);
});

test("builds Xray legal-form URL variants", () => {
  const mps = buildXraySlugCandidates(["MPS MONITOR S.R.L."]);
  const gross = buildXraySlugCandidates(["COMPUTER GROSS S.P.A."]);

  assert.ok(mps.includes("mps-monitor-srl"));
  assert.ok(mps.includes("mps-monitor-s-r-l"));
  assert.ok(gross.includes("computer-gross-s-p-a"));
  assert.ok(gross.includes("computer-gross-spa"));
});


test("normalizes noisy VIES MPS Monitor legal name into Xray candidates", () => {
  const slugs = buildXraySlugCandidates([
    "MPS MONITOR SRL A SOCIO UNICO !!S.R.L."
  ]);

  assert.ok(slugs.includes("mps-monitor-srl"));
  assert.ok(slugs.includes("mps-monitor-s-r-l"));
});


test("builds the real Rubino Xray disambiguated slug", () => {
  const bases = buildXraySlugCandidates(["RUBINO - S.R.L."]);
  const numbered = buildXrayNumberedSlugCandidates(bases);

  assert.ok(bases.includes("rubino-s-r-l"));
  assert.ok(numbered.includes("rubino-s-r-l-15"));
});

test("parses Rubino Xray financial data", () => {
  const text = `
RUBINO S.R.L.
Fatturato e dati di Bilancio - Giffoni Valle Piana - SA - P.IVA: 05488440651
Partita IVA 05488440651
ATECO 46.49.90
Ultimo bilancio | valori in €/000 31/12/2024
Fatturato 2024 2.278
EBITDA 283
Utile/Perdita 112
Dipendenti 13
Patrimonio Netto 999
Posizione Finanziaria Netta 45
EBITDA 12.41%
`;

  const company = parseXrayText(text, {
    name: "RUBINO S.R.L.",
    url: "https://xrayfinance.it/rubino-s-r-l-15"
  });

  assert.equal(company.vat, "05488440651");
  assert.equal(company.financials.revenue, 2_278_000);
  assert.equal(company.financials.ebitda, 283_000);
  assert.equal(company.financials.profit, 112_000);
  assert.equal(company.financials.employees, 13);
  assert.equal(company.financials.ebitdaMargin, 12.41);
});
