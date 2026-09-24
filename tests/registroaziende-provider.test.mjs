import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRegistroSlugCandidates,
  parseRegistroAziendeSearchCandidates,
  parseRegistroAziendeSearchRows,
  parseRegistroAziendeText,
  rankRegistroAziendeCompaniesByQuery
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


test("parses flattened MPS Monitor history rows", () => {
  const text = `
Dati aziendali: Mps Monitor Srl, P.IVA 03122040987
Stato Attiva
Ragione sociale Mps Monitor Srl
P.IVA 03122040987
Fatturato 2025 € 5.55 M
Utile/Perdita 2025 € 2.38 M
Fatturato, Utile/perdita dell'azienda MPS MONITOR SRL per gli anni 2023, 2024, 2025
Anno Fatturato Utile/Perdita
2023 € 4.192.298 € 548.583
2024 € 4.786.773 € 1.390.357
2025 € 5.548.281 € 2.383.651
`;

  const company = parseRegistroAziendeText(text);

  assert.deepEqual(
    company.financials.balanceHistory.map((item) => item.year),
    [2025, 2024, 2023]
  );
  assert.equal(company.financials.balanceHistory[2].revenue, 4_192_298);
  assert.equal(company.financials.balanceHistory[2].profit, 548_583);
});


test("builds Xray Finance owner slug from privacy name and city", () => {
  const slugs = buildRegistroSlugCandidates(
    ["Xray Finance Srl"],
    ["Bolzano"]
  );

  assert.ok(slugs.includes("xray-finance-srl-bolzano"));
  assert.ok(slugs.indexOf("xray-finance-srl-bolzano") < 3);
});


test("parses manual RegistroAziende search rows and limits results", () => {
  const rows = [
    {
      name: "Future Tech Srl",
      href: "/azienda/future-tech-srl-basiglio",
      cells: ["Future Tech Srl", "BASIGLIO, Milano", "11295150152", "€ 1.99 M"]
    },
    {
      name: "Future Tech Di Hoxhaj Gezim",
      href: "/azienda/future-tech-di-hoxhaj-gezim-brescia",
      cells: ["Future Tech Di Hoxhaj Gezim", "BRESCIA, Brescia", "03983230982", "-"]
    },
    {
      name: "Future Tech Srls",
      href: "/azienda/future-tech-srl-semplificata-caltagirone",
      cells: ["Future Tech Srls", "CALTAGIRONE, Catania", "05716410872", "-"]
    },
    {
      name: "Future Tech & Wisdom Srl",
      href: "/azienda/future-tech-wisdom-srl-messina",
      cells: ["Future Tech & Wisdom Srl", "MESSINA, Messina", "03833730835", "€ 8.71 K"]
    },
    {
      name: "Future Tech Roma Srls",
      href: "/azienda/future-tech-roma",
      cells: ["Future Tech Roma Srls", "ROMA, Roma", "17975871009", "-"]
    },
    {
      name: "Extra result",
      href: "/azienda/extra-result",
      cells: ["Extra result", "TORINO, Torino", "01234567890", "-"]
    }
  ];

  const companies = parseRegistroAziendeSearchRows(rows);

  assert.equal(companies.length, 5);
  assert.equal(companies[0].name, "Future Tech Srl");
  assert.equal(companies[0].vat, "11295150152");
  assert.equal(companies[0].city, "BASIGLIO");
  assert.equal(companies[0].province, "Milano");
  assert.equal(
    companies[0].providerUrl,
    "https://registroaziende.it/azienda/future-tech-srl-basiglio"
  );
});

test("manual RegistroAziende search rows skip entries without a valid VAT", () => {
  const companies = parseRegistroAziendeSearchRows([
    {
      name: "Without VAT",
      href: "/azienda/without-vat",
      cells: ["Without VAT", "MILANO, Milano", "None", "-"]
    },
    {
      name: "Valid Company Srl",
      href: "/azienda/valid-company-srl-milano",
      cells: ["Valid Company Srl", "MILANO, Milano", "11295150152", "€ 1 M"]
    }
  ]);

  assert.deepEqual(
    companies.map((company) => company.vat),
    ["11295150152"]
  );
});


test("manual search rows accept card-style extracted results", () => {
  const companies = parseRegistroAziendeSearchRows([
    {
      name: "Future Tech Srl",
      href: "/azienda/future-tech-srl-basiglio",
      location: "BASIGLIO, Milano",
      vat: "11295150152",
      cells: ["Future Tech Srl", "BASIGLIO, Milano", "11295150152"]
    }
  ]);

  assert.equal(companies.length, 1);
  assert.equal(companies[0].name, "Future Tech Srl");
  assert.equal(companies[0].vat, "11295150152");
  assert.equal(companies[0].city, "BASIGLIO");
  assert.equal(companies[0].province, "Milano");
});


test("manual company search prioritizes names matching the query", () => {
  const ranked = rankRegistroAziendeCompaniesByQuery([
    { name: "Isafe Srl", vat: "05070160261" },
    { name: "Gran Garage Carlo Mazzeo Srl", vat: "03170010734" },
    { name: "Future Tech Srl", vat: "11295150152" },
    { name: "New Investment Srl", vat: "02522610217" },
    { name: "Ristonami Srl", vat: "05866040651" },
    { name: "Annachiara Elmy Srl", vat: "04934100282" }
  ], "future tech srl");

  assert.deepEqual(
    ranked.map((company) => company.vat),
    ["11295150152"]
  );
});

test("manual company search keeps close variants but rejects unrelated companies", () => {
  const ranked = rankRegistroAziendeCompaniesByQuery([
    { name: "Future Tech Srl", vat: "11295150152" },
    { name: "Future Technology Srl", vat: "08714741215" },
    { name: "Future Srl", vat: "00874460967" },
    { name: "Tecnologie Future Srl", vat: "00941350571" },
    { name: "Gran Garage Carlo Mazzeo Srl", vat: "03170010734" }
  ], "future tech");

  assert.equal(ranked[0].vat, "11295150152");
  assert.ok(ranked.some((company) => company.vat === "08714741215"));
  assert.ok(!ranked.some((company) => company.vat === "03170010734"));
});


test("manual search discovery keeps relevant company links even without VAT in the result row", () => {
  const candidates = parseRegistroAziendeSearchCandidates([
    {
      name: "Future Tech Srl",
      href: "/azienda/future-tech-srl-basiglio",
      location: "BASIGLIO, Milano",
      cells: ["Future Tech Srl", "BASIGLIO", "€ 1.99 M"]
    }
  ]);

  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].name, "Future Tech Srl");
  assert.equal(candidates[0].vat, null);
  assert.equal(
    candidates[0].providerUrl,
    "https://registroaziende.it/azienda/future-tech-srl-basiglio"
  );
});

test("manual search rejects partial-token noise such as SCStechnology for Future Tech", () => {
  const ranked = rankRegistroAziendeCompaniesByQuery([
    { name: "Scstechnology Srl", vat: "02878300181" },
    { name: "Future Tech Srl", vat: "11295150152" },
    { name: "Future Technology Srl", vat: "08714741215" }
  ], "future tech srl");

  assert.deepEqual(
    ranked.map((company) => company.vat),
    ["11295150152", "08714741215"]
  );
});

test("manual search supports exact three-character company names", () => {
  const ranked = rankRegistroAziendeCompaniesByQuery([
    { name: "Epy Srl", vat: "05973540155" },
    { name: "Epy Srl", vat: "13237730018" },
    { name: "Happy Srl", vat: "00000000000" }
  ], "epy");

  assert.deepEqual(
    ranked.map((company) => company.vat),
    ["05973540155", "13237730018"]
  );
});
