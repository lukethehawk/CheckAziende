import test from "node:test";
import assert from "node:assert/strict";

import {
  enrichCompanyWithFallback,
  enrichCompanyWithXray,
  normalizeCompany
} from "../src/company.js";

test("normalizes canonical provider data with VIES fallback", () => {
  const company = normalizeCompany(
    {
      provider: "Aziende.it",
      name: "FUTURE TECH SRL",
      vat: "11295150152",
      status: "Attiva",
      rea: "MI-1453877",
      financials: {
        revenue: { value: 1992222, year: 2024, source: "Aziende.it", isFiled: true }
      }
    },
    {
      vatNumber: "11295150152",
      address: "RESIDENZE ACACIE 601 20079 BASIGLIO MI"
    },
    "11295150152"
  );

  assert.equal(company.provider, "Aziende.it");
  assert.equal(company.address, "RESIDENZE ACACIE 601 20079 BASIGLIO MI");
  assert.equal(company.rea, "MI-1453877");
});

test("fallback enriches missing fields and promotes newer filed year", () => {
  const company = normalizeCompany({
    provider: "Aziende.it",
    name: "FUTURE TECH SRL",
    vat: "11295150152",
    address: "Canonical address",
    financials: {
      revenue: { value: 1992222, year: 2024, source: "Aziende.it", isFiled: true },
      balanceHistory: [
        { year: 2024, revenue: 1992222, profit: 236014, source: "Aziende.it", isFiled: true }
      ]
    }
  }, null, "11295150152");

  enrichCompanyWithFallback(company, {
    provider: "RegistroAziende.it",
    rea: "MI-1453877",
    financials: {
      revenue: { value: 1820000, year: 2025, source: "RegistroAziende.it", isFiled: true },
      profit: { value: 266000, year: 2025, source: "RegistroAziende.it", isFiled: true },
      balanceHistory: [
        { year: 2025, revenue: 1820000, profit: 266000, source: "RegistroAziende.it", isFiled: true }
      ]
    }
  });

  assert.equal(company.address, "Canonical address");
  assert.equal(company.rea, "MI-1453877");
  assert.equal(company.financials.revenue.year, 2025);
  assert.equal(company.financials.revenue.value, 1820000);
  assert.equal(company.financials.revenue.isFiled, true);
  assert.deepEqual(company.financials.balanceHistory.map((item) => item.year), [2025, 2024]);
});

test("Xray enrichment keeps non-filed provenance", () => {
  const company = normalizeCompany(null, {
    vatNumber: "03122040987",
    name: "MPS MONITOR SRL"
  }, "03122040987");

  enrichCompanyWithXray(company, {
    provider: "Xray Finance",
    name: "MPS MONITOR S.R.L.",
    financials: {
      year: 2024,
      revenue: 4787000,
      profit: 1390000,
      ebitda: 1858000,
      ebitdaMargin: 38.81,
      employees: 16
    }
  });

  assert.equal(company.name, "MPS MONITOR SRL");
  assert.equal(company.financials.ebitda.value, 1858000);
  assert.equal(company.financials.revenue.source, "Xray Finance");
  assert.equal(company.financials.revenue.isFiled, false);
  assert.equal(company.financials.balanceHistory[0].isFiled, false);
});


test("Xray SEO-style title does not replace an existing VIES company name", () => {
  const company = normalizeCompany(null, {
    vatNumber: "11295150152",
    name: "FUTURE TECH SRL"
  }, "11295150152");

  enrichCompanyWithXray(company, {
    provider: "Xray Finance",
    name: "FUTURE TECH SRL - Fatturato, Bilancio 2025 e dati finanziari",
    financials: {
      year: 2024,
      revenue: 1992222,
      ebitda: 318000,
      ebitdaMargin: 16
    }
  });

  assert.equal(company.name, "FUTURE TECH SRL");
});

test("Xray can still provide a name when no other source has one", () => {
  const company = normalizeCompany(null, null, "11295150152");

  enrichCompanyWithXray(company, {
    provider: "Xray Finance",
    name: "FUTURE TECH SRL",
    financials: {
      year: 2024,
      revenue: 1992222
    }
  });

  assert.equal(company.name, "FUTURE TECH SRL");
});
