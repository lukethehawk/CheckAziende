import test from "node:test";
import assert from "node:assert/strict";

import {
  compareProviderData,
  mergeBalanceHistories,
  needsFallback,
  previousBalanceRows,
  selectCanonicalPrimary
} from "../src/providers/orchestrator.js";

test("provider verification accepts matching financial data", () => {
  const primary = {
    vat: "11295150152",
    status: "Attiva",
    ateco: { code: "46.50.1" },
    financials: {
      revenue: { value: 1_992_222, year: 2024 },
      profit: { value: 236_014, year: 2024 },
      balanceHistory: [
        { year: 2024, revenue: 1_992_222, profit: 236_014 },
        { year: 2023, revenue: 1_635_153, profit: 173_389 }
      ]
    }
  };

  const verifier = {
    vat: "11295150152",
    status: "Attiva",
    financials: {
      revenue: { value: 1_992_222, year: 2024 },
      profit: { value: 236_014, year: 2024 }
    }
  };

  const result = compareProviderData(primary, verifier);
  assert.equal(result.verified, true);
  assert.deepEqual(result.conflicts, []);
});

test("provider verification flags material revenue conflict", () => {
  const primary = {
    vat: "11295150152",
    status: "Attiva",
    financials: {
      revenue: { value: 1_992_222, year: 2024 }
    }
  };

  const verifier = {
    vat: "11295150152",
    status: "Attiva",
    financials: {
      revenue: { value: 1_700_000, year: 2024 }
    }
  };

  const result = compareProviderData(primary, verifier);
  assert.ok(result.conflicts.includes("revenue"));
  assert.equal(result.verified, false);
});

test("complete primary provider does not require blocking fallback", () => {
  assert.equal(needsFallback({
    status: "Attiva",
    ateco: { code: "46.50.1" },
    financials: {
      revenue: { value: 1_992_222, year: 2024 },
      profit: { value: 236_014, year: 2024 },
      balanceHistory: [
        { year: 2024 },
        { year: 2023 }
      ]
    }
  }), false);
});

test("missing balance history triggers fallback", () => {
  assert.equal(needsFallback({
    status: "Attiva",
    ateco: { code: "46.50.1" },
    financials: {
      revenue: { value: 1_992_222, year: 2024 },
      profit: { value: 236_014, year: 2024 },
      balanceHistory: []
    }
  }), true);
});


test("Aziende.it remains canonical when RegistroAziende is also available", () => {
  const aziende = {
    provider: "Aziende.it",
    vat: "11295150152",
    rea: "MI-1453877",
    pec: "futuretech@pec.example"
  };
  const registro = {
    provider: "RegistroAziende.it",
    vat: "11295150152"
  };

  assert.equal(selectCanonicalPrimary(aziende, registro), aziende);
});

test("RegistroAziende is used only when canonical Aziende.it is unavailable", () => {
  const registro = {
    provider: "RegistroAziende.it",
    vat: "11295150152"
  };

  assert.equal(selectCanonicalPrimary(null, registro), registro);
});


test("merges balance years from canonical and fallback providers", () => {
  const merged = mergeBalanceHistories(
    [
      { year: 2024, revenue: 1_992_222, profit: 236_014 },
      { year: 2022, revenue: 1_765_110, profit: 166_073 },
      { year: 2021, revenue: 1_930_000, profit: null }
    ],
    [
      { year: 2024, revenue: 1_990_000, profit: 236_010 },
      { year: 2023, revenue: 1_635_153, profit: 173_389 },
      { year: 2022, revenue: 1_760_000, profit: 166_000 }
    ]
  );

  assert.deepEqual(merged.map((item) => item.year), [2024, 2023, 2022, 2021]);
  assert.equal(merged[0].revenue, 1_992_222);
  assert.equal(merged[2].revenue, 1_765_110);
  assert.equal(merged[1].revenue, 1_635_153);
});

test("history accordion excludes the current headline year", () => {
  const rows = previousBalanceRows(
    [
      { year: 2024, revenue: 1_992_222 },
      { year: 2023, revenue: 1_635_153 },
      { year: 2022, revenue: 1_765_110 },
      { year: 2021, revenue: 1_930_000 }
    ],
    2024,
    3
  );

  assert.deepEqual(rows.map((item) => item.year), [2023, 2022, 2021]);
});
