import test from "node:test";
import assert from "node:assert/strict";

import {
  compareProviderData,
  needsFallback
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
