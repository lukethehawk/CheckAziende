import test from "node:test";
import assert from "node:assert/strict";

import {
  compareProviderData,
  financialHistoryNeedsRefresh,
  mergeBalanceHistories,
  missingProviderRefreshPlan,
  needsFallback,
  previousBalanceRows,
  promoteLatestFinancialYear,
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

test("fresh complete primary provider does not require blocking fallback", () => {
  assert.equal(needsFallback({
    status: "Attiva",
    ateco: { code: "46.50.1" },
    financials: {
      revenue: { value: 1_820_000, year: 2025 },
      profit: { value: 266_000, year: 2025 },
      balanceHistory: [
        { year: 2025 },
        { year: 2024 }
      ]
    }
  }, {
    now: new Date(2026, 8, 23)
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


test("newer verified year becomes the headline financial year", () => {
  const financials = promoteLatestFinancialYear({
    revenue: { value: 1_992_222, year: 2024 },
    profit: { value: 236_014, year: 2024 },
    employees: { value: 3, display: "3", year: null },
    netMargin: 11.8,
    revenuePerEmployee: 664074,
    balanceHistory: [
      { year: 2025, revenue: 1_820_000, profit: 266_000 },
      { year: 2024, revenue: 1_992_222, profit: 236_014 },
      { year: 2023, revenue: 1_635_153, profit: 173_389 },
      { year: 2022, revenue: 1_765_110, profit: 166_073 }
    ]
  });

  assert.equal(financials.revenue.value, 1_820_000);
  assert.equal(financials.revenue.year, 2025);
  assert.equal(financials.profit.value, 266_000);
  assert.equal(financials.profit.year, 2025);
  assert.ok(Math.abs(financials.netMargin - 14.6153846154) < 0.001);
  assert.equal(financials.revenuePerEmployee, 606666.6666666666);

  const rows = previousBalanceRows(
    financials.balanceHistory,
    financials.revenue.year,
    3
  );

  assert.deepEqual(rows.map((item) => item.year), [2024, 2023, 2022]);
});

test("canonical value wins when providers report the same latest year", () => {
  const merged = mergeBalanceHistories(
    [
      { year: 2025, revenue: 1_825_000, profit: 267_000 }
    ],
    [
      { year: 2025, revenue: 1_820_000, profit: 266_000 }
    ]
  );

  const financials = promoteLatestFinancialYear({
    revenue: { value: 1_825_000, year: 2025 },
    profit: { value: 267_000, year: 2025 },
    balanceHistory: merged
  });

  assert.equal(financials.revenue.value, 1_825_000);
  assert.equal(financials.profit.value, 267_000);
});


test("gapped history triggers verifier refresh", () => {
  const financials = {
    revenue: { value: 1_992_222, year: 2024 },
    profit: { value: 236_014, year: 2024 },
    balanceHistory: [
      { year: 2024, revenue: 1_992_222, profit: 236_014 },
      { year: 2022, revenue: 1_765_110, profit: 166_073 },
      { year: 2021, revenue: 1_930_000, profit: 150_000 }
    ]
  };

  assert.equal(
    financialHistoryNeedsRefresh(financials, {
      now: new Date(2026, 8, 23)
    }),
    true
  );
});

test("previous-year filing gap triggers verifier in second half of year", () => {
  const financials = {
    revenue: { value: 1_992_222, year: 2024 },
    profit: { value: 236_014, year: 2024 },
    balanceHistory: [
      { year: 2024, revenue: 1_992_222, profit: 236_014 },
      { year: 2023, revenue: 1_635_153, profit: 173_389 },
      { year: 2022, revenue: 1_765_110, profit: 166_073 }
    ]
  };

  assert.equal(
    financialHistoryNeedsRefresh(financials, {
      now: new Date(2026, 8, 23)
    }),
    true
  );
});

test("fresh contiguous history does not trigger verifier refresh", () => {
  const financials = {
    revenue: { value: 1_820_000, year: 2025 },
    profit: { value: 266_000, year: 2025 },
    balanceHistory: [
      { year: 2025, revenue: 1_820_000, profit: 266_000 },
      { year: 2024, revenue: 1_992_222, profit: 236_014 },
      { year: 2023, revenue: 1_635_153, profit: 173_389 }
    ]
  };

  assert.equal(
    financialHistoryNeedsRefresh(financials, {
      now: new Date(2026, 8, 23)
    }),
    false
  );
});


test("merged history preserves filed provenance from either provider", () => {
  const merged = mergeBalanceHistories(
    [
      {
        year: 2025,
        revenue: 2_000_000,
        source: "Xray Finance",
        isFiled: false
      }
    ],
    [
      {
        year: 2025,
        revenue: 1_990_000,
        profit: 200_000,
        source: "RegistroAziende.it",
        isFiled: true
      }
    ]
  );

  assert.equal(merged[0].revenue, 2_000_000);
  assert.equal(merged[0].profit, 200_000);
  assert.equal(merged[0].isFiled, true);
  assert.deepEqual(
    new Set(merged[0].sources),
    new Set(["Xray Finance", "RegistroAziende.it"])
  );
});

test("promoted headline keeps source and filed metadata", () => {
  const financials = promoteLatestFinancialYear({
    revenue: {
      value: 1_900_000,
      year: 2024,
      source: "Aziende.it",
      isFiled: true
    },
    balanceHistory: [
      {
        year: 2025,
        revenue: 2_000_000,
        profit: 210_000,
        source: "RegistroAziende.it",
        isFiled: true
      }
    ]
  });

  assert.equal(financials.revenue.year, 2025);
  assert.equal(financials.revenue.source, "RegistroAziende.it");
  assert.equal(financials.revenue.isFiled, true);
  assert.equal(financials.profit.source, "RegistroAziende.it");
});


test("fresh cached snapshot retries missing Xray without full refresh", () => {
  const plan = missingProviderRefreshPlan({
    primary: {
      provider: "Aziende.it",
      vat: "05488440651",
      name: "RUBINO - S.R.L.",
      status: "Attiva",
      ateco: { code: "46.49.9" },
      financials: {
        revenue: { value: 2_277_793, year: 2024 },
        profit: { value: 111_548, year: 2024 },
        balanceHistory: [
          { year: 2024 },
          { year: 2023 },
          { year: 2022 }
        ]
      }
    },
    aziende: {
      provider: "Aziende.it",
      vat: "05488440651",
      status: "Attiva",
      ateco: { code: "46.49.9" },
      financials: {
        revenue: { value: 2_277_793, year: 2024 },
        profit: { value: 111_548, year: 2024 },
        balanceHistory: [
          { year: 2024 },
          { year: 2023 },
          { year: 2022 }
        ]
      }
    },
    xray: null,
    registro: null
  });

  assert.equal(plan.xray, true);
  assert.equal(plan.aziende, false);
});

test("complete cached snapshot does not retry already present Xray", () => {
  const plan = missingProviderRefreshPlan({
    primary: {
      vat: "05488440651"
    },
    aziende: {
      vat: "05488440651"
    },
    xray: {
      provider: "Xray Finance",
      vat: "05488440651"
    }
  });

  assert.equal(plan.xray, false);
});
