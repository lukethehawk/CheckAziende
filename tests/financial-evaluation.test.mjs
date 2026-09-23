import test from "node:test";
import assert from "node:assert/strict";

import {
  describeFinancialProfile,
  evaluateFinancialProfile
} from "../src/financial-evaluation.js";

test("evaluation tracks the two-filed-balances requirement", () => {
  const result = evaluateFinancialProfile({
    status: "Attiva",
    registrationDate: "15/09/1994",
    financials: {
      revenue: { value: 2_000_000, year: 2024 },
      profit: { value: 230_000, year: 2024 },
      netMargin: 11.5,
      ebitda: { value: 320_000, year: 2024 },
      ebitdaMargin: { value: 16, year: 2024 },
      balanceHistory: [
        { year: 2024, revenue: 2_000_000, profit: 230_000, isFiled: true },
        { year: 2023, revenue: 1_800_000, profit: 170_000, isFiled: true },
        { year: 2022, revenue: 1_700_000, profit: 160_000, isFiled: true }
      ]
    }
  }, {
    now: new Date(2026, 8, 23)
  });

  assert.equal(result.requirements.atLeastTwoFiledBalances, true);
  assert.ok(result.score >= 80);
  assert.equal(result.metrics.age, 32);
});

test("ceased companies are capped to a low internal score", () => {
  const result = evaluateFinancialProfile({
    status: "Cessata",
    registrationDate: "01/01/1990",
    financials: {
      revenue: { value: 10_000_000, year: 2024 },
      profit: { value: 2_000_000, year: 2024 },
      netMargin: 20,
      ebitda: { value: 3_000_000, year: 2024 },
      ebitdaMargin: { value: 30, year: 2024 },
      balanceHistory: [
        { year: 2024, revenue: 10_000_000, profit: 2_000_000, isFiled: true },
        { year: 2023, revenue: 9_000_000, profit: 1_800_000, isFiled: true },
        { year: 2022, revenue: 8_000_000, profit: 1_500_000, isFiled: true }
      ]
    }
  }, {
    now: new Date(2026, 8, 23)
  });

  assert.ok(result.score <= 20);
});


test("generic financial observations do not satisfy filed-balance requirement", () => {
  const result = evaluateFinancialProfile({
    status: "Attiva",
    registrationDate: "01/01/2015",
    financials: {
      revenue: { value: 2_000_000, year: 2025 },
      profit: { value: 100_000, year: 2025 },
      balanceHistory: [
        {
          year: 2025,
          revenue: 2_000_000,
          profit: 100_000,
          source: "Xray Finance",
          isFiled: false
        },
        {
          year: 2024,
          revenue: 1_800_000,
          profit: 80_000,
          source: "Xray Finance",
          isFiled: false
        }
      ]
    }
  });

  assert.equal(result.requirements.atLeastTwoFiledBalances, false);
  assert.equal(
    result.factors.find((item) => item.key === "balanceHistory").value,
    0
  );
});


test("financial profile label is conservative when filed balances are missing", () => {
  const evaluation = evaluateFinancialProfile({
    status: "Attiva",
    registrationDate: "01/01/2010",
    financials: {
      revenue: { value: 3_000_000, year: 2025 },
      profit: { value: 450_000, year: 2025 },
      netMargin: 15,
      ebitda: { value: 600_000, year: 2025 },
      ebitdaMargin: { value: 20, year: 2025 },
      balanceHistory: [
        {
          year: 2025,
          revenue: 3_000_000,
          profit: 450_000,
          source: "Xray Finance",
          isFiled: false
        }
      ]
    }
  });

  assert.equal(evaluation.requirements.atLeastTwoFiledBalances, false);
  assert.equal(describeFinancialProfile(evaluation).label, "Dati limitati");
});

test("financial profile label exposes a solid band only with sufficient coverage", () => {
  const description = describeFinancialProfile({
    score: 86,
    completeness: 100,
    requirements: {
      atLeastTwoFiledBalances: true
    }
  });

  assert.deepEqual(description, {
    key: "solid",
    label: "Solido"
  });
});

test("financial profile bands remain qualitative around score thresholds", () => {
  const base = {
    completeness: 83,
    requirements: {
      atLeastTwoFiledBalances: true
    }
  };

  assert.equal(describeFinancialProfile({ ...base, score: 72 }).label, "Buono");
  assert.equal(describeFinancialProfile({ ...base, score: 58 }).label, "Intermedio");
  assert.equal(describeFinancialProfile({ ...base, score: 41 }).label, "Fragile");
  assert.equal(describeFinancialProfile({ ...base, score: 22 }).label, "Debole");
});
