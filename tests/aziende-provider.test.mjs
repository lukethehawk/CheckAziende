import test from "node:test";
import assert from "node:assert/strict";

import {
  buildSlugCandidates,
  parseAziendeText,
  slugifyCompanyName
} from "../src/providers/aziende.js";

test("slugifies Italian legal forms like Aziende.it URLs", () => {
  assert.equal(
    slugifyCompanyName("COMPUTER GROSS S.P.A."),
    "computer-gross-s-p-a"
  );

  assert.equal(
    slugifyCompanyName("Future Tech SRL"),
    "future-tech-srl"
  );
});

test("builds legal-form variants for a brand-only name", () => {
  const slugs = buildSlugCandidates(["MPS Monitor"]);

  assert.ok(slugs.includes("mps-monitor"));
  assert.ok(slugs.includes("mps-monitor-srl"));
  assert.ok(slugs.includes("mps-monitor-s-p-a"));
});

test("parses Future Tech financial and registry data", () => {
  const text = `
FUTURE TECH SRL
Attiva SOCIETA' A RESPONSABILITA' LIMITATA Basiglio (MI) ATECO 46.50.1 dal 1994
P.IVA 11295150152 REA MI-1453877
Sede legale: Residenze Acacie 601, 20079 Basiglio (MI)
€ 1.992.222
Fatturato 2024
€ 236.014
Utile 2024
3
Dipendenti
€ 18.000
Capitale sociale
11,8%
Margine netto
Attività
Commercio all'ingrosso di computer, unita' periferiche e software
Ragione Sociale
Future Tech Srl
Natura Giuridica
SOCIETA' A RESPONSABILITA' LIMITATA
Partita IVA
11295150152
Data Iscrizione
15/09/1994
PEC
amministrazione@pec.future-tech.it
Codice Destinatario SDI
T04ZHR3
Comune
Basiglio
Provincia
Milano
Regione
Lombardia
`;

  const company = parseAziendeText(text, {
    name: "FUTURE TECH SRL",
    url: "https://www.aziende.it/future-tech-srl"
  });

  assert.equal(company.vat, "11295150152");
  assert.equal(company.name, "FUTURE TECH SRL");
  assert.equal(company.rea, "MI-1453877");
  assert.equal(company.ateco.code, "46.50.1");
  assert.equal(company.financials.revenue.value, 1992222);
  assert.equal(company.financials.revenue.year, 2024);
  assert.equal(company.financials.profit.value, 236014);
  assert.equal(company.financials.employees.value, 3);
  assert.equal(Math.round(company.financials.netMargin * 10) / 10, 11.8);
  assert.equal(company.pec, "amministrazione@pec.future-tech.it");
});

test("parses a large company without corrupting year into revenue", () => {
  const text = `
COMPUTER GROSS S.P.A.
Attiva SOCIETA' PER AZIONI Empoli (FI) ATECO 46.50.1 dal 1997
P.IVA 04801490485 REA FI-487781
Sede legale: Via Del Pino 1, 50053 Empoli (FI)
€ 1.821.753.823
Fatturato 2025
€ 39.409.089
Utile 2025
368
Dipendenti
Ragione Sociale
Computer Gross S.p.a.
Natura Giuridica
SOCIETA' PER AZIONI
Data Iscrizione
22/01/1997
PEC
computergross@pec.computergross.it
Codice Destinatario SDI
LV530WW
Comune
Empoli
Provincia
Firenze
Regione
Toscana
`;

  const company = parseAziendeText(text, {
    name: "COMPUTER GROSS S.P.A."
  });

  assert.equal(company.financials.revenue.value, 1821753823);
  assert.equal(company.financials.profit.value, 39409089);
  assert.equal(company.financials.employees.value, 368);
  assert.equal(company.city, "Empoli");
});

test("parses foreign subject with employee range and no public balance", () => {
  const text = `
CODING CONSULTANTS INTERNATIONAL INC.
Attiva SOGGETTO ESTERO Venezia (VE) ATECO 46.51 dal 2002
P.IVA 03659120962 REA VE-283130
0-9 dipendenti
Dipendenti
Attività
Commercio all'ingrosso di computer, apparecchiature informatiche periferiche e di software
Natura Giuridica
SOGGETTO ESTERO
Data Iscrizione
01/09/2002
Comune
Venezia
Provincia
Venezia
Regione
Veneto
`;

  const company = parseAziendeText(text, {
    name: "CODING CONSULTANTS INTERNATIONAL INC."
  });

  assert.equal(company.vat, "03659120962");
  assert.equal(company.legalForm, "SOGGETTO ESTERO");
  assert.equal(company.financials.revenue, null);
  assert.equal(company.financials.employees.display, "0-9");
});


test("parses the last three available balances", () => {
  const text = `
COMPUTER GROSS S.P.A.
Attiva SOCIETA' PER AZIONI Empoli (FI) ATECO 46.50.1 dal 1997
P.IVA 04801490485 REA FI-487781
€ 1.821.753.823
Fatturato 2025
€ 39.409.089
Utile 2025
Ultimi 3 bilanci disponibili.
Anno
Fatturato
Δ%
Utile/Perdita
Dipendenti
Capitale
2025
€ 1.821.753.823
-8,3%
€ 39.409.089
368
€ 40.000.000
2024
€ 1.987.208.400
+8,0%
€ 48.763.538
—
€ 40.000.000
2023
€ 1.839.857.066
—
€ 41.154.978
—
€ 40.000.000
Appalti pubblici
`;

  const company = parseAziendeText(text, {
    name: "COMPUTER GROSS S.P.A."
  });

  assert.equal(company.financials.balanceHistory.length, 3);
  assert.deepEqual(
    company.financials.balanceHistory.map((item) => item.year),
    [2025, 2024, 2023]
  );
  assert.equal(company.financials.balanceHistory[0].revenue, 1821753823);
  assert.equal(company.financials.balanceHistory[0].profit, 39409089);
  assert.equal(company.financials.balanceHistory[0].employees, 368);
  assert.equal(company.financials.balanceHistory[1].revenue, 1987208400);
  assert.equal(company.financials.balanceHistory[2].profit, 41154978);
});
