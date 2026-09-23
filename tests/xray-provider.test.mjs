import test from "node:test";
import assert from "node:assert/strict";

import {
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
