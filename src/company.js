import {
  mergeBalanceHistories,
  promoteLatestFinancialYear
} from "./providers/orchestrator.js";

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}


export function distinctTaxCode(taxCode, vat) {
  const value = String(taxCode || "").trim();
  if (!value) return null;

  const normalizedTaxCode = value.replace(/\s+/g, "").toUpperCase();
  const normalizedVat = digitsOnly(vat);

  if (
    normalizedVat &&
    /^(?:IT)?\d{11}$/.test(normalizedTaxCode) &&
    normalizedTaxCode.replace(/^IT/, "") === normalizedVat
  ) {
    return null;
  }

  return value;
}

export function calculatePersonnelCostRatio(financials) {
  const personnelCost = financials?.personnelCost;
  if (!Number.isFinite(personnelCost?.value) || personnelCost.value < 0) {
    return null;
  }

  const targetYear = Number.isFinite(personnelCost?.year)
    ? personnelCost.year
    : null;

  let revenueValue = null;
  let revenueYear = null;

  if (targetYear && Array.isArray(financials?.balanceHistory)) {
    const matchingRow = financials.balanceHistory.find((row) =>
      row?.year === targetYear &&
      Number.isFinite(row?.revenue) &&
      row.revenue > 0
    );

    if (matchingRow) {
      revenueValue = matchingRow.revenue;
      revenueYear = matchingRow.year;
    }
  }

  if (
    !Number.isFinite(revenueValue) &&
    Number.isFinite(financials?.revenue?.value) &&
    financials.revenue.value > 0 &&
    (
      !targetYear ||
      !Number.isFinite(financials.revenue?.year) ||
      financials.revenue.year === targetYear
    )
  ) {
    revenueValue = financials.revenue.value;
    revenueYear = financials.revenue.year || targetYear || null;
  }

  if (!Number.isFinite(revenueValue) || revenueValue <= 0) {
    return null;
  }

  return {
    value: (personnelCost.value / revenueValue) * 100,
    year: targetYear || revenueYear || null,
    revenue: revenueValue
  };
}

function ensurePersonnelCostRatio(financials) {
  if (!financials || Number.isFinite(financials.personnelCostRatio?.value)) {
    return financials;
  }

  const ratio = calculatePersonnelCostRatio(financials);
  if (ratio) financials.personnelCostRatio = ratio;
  return financials;
}

export function normalizeCompany(providerData, viesData, fallbackVat) {
  const vat = providerData?.vat || viesData?.vatNumber || digitsOnly(fallbackVat);
  const financials = providerData?.financials
    ? { ...providerData.financials }
    : {};

  ensurePersonnelCostRatio(financials);

  return {
    provider: providerData?.provider || null,
    providers: providerData?.provider ? [providerData.provider] : [],
    providerUrl: providerData?.providerUrl || null,
    name: providerData?.name || viesData?.name || null,
    vat,
    status: providerData?.status || null,
    address: providerData?.address || viesData?.address || null,
    legalForm: providerData?.legalForm || null,
    taxCode: providerData?.taxCode || null,
    rea: providerData?.rea || null,
    pec: providerData?.pec || null,
    sdi: providerData?.sdi || null,
    registrationDate: providerData?.registrationDate || null,
    chamber: providerData?.chamber || null,
    city: providerData?.city || null,
    province: providerData?.province || null,
    region: providerData?.region || null,
    ateco: providerData?.ateco || null,
    financials
  };
}

export function enrichCompanyWithXray(company, xray) {
  if (!xray?.financials) return company;

  const hadPrimaryProvider = Boolean(company.providers?.length);

  // Xray is an enrichment source. Its H1 can contain SEO text such as
  // "Company - Fatturato, Bilancio..." and must not temporarily replace a
  // company name already obtained from VIES or a registry provider.
  if (!company.name && !hadPrimaryProvider && xray.name) {
    company.name = xray.name;
  }

  if ((!company.ateco?.code && !company.ateco?.description) && xray.ateco) {
    company.ateco = xray.ateco;
  }

  const financials = company.financials || {};
  const year = xray.financials.year || null;

  if (Number.isFinite(xray.financials.ebitda)) {
    financials.ebitda = {
      value: xray.financials.ebitda,
      year
    };
  }

  if (Number.isFinite(xray.financials.ebitdaMargin)) {
    financials.ebitdaMargin = {
      value: xray.financials.ebitdaMargin,
      year
    };
  }

  if (!Number.isFinite(financials.revenue?.value) &&
      Number.isFinite(xray.financials.revenue)) {
    financials.revenue = {
      value: xray.financials.revenue,
      year,
      source: "Xray Finance",
      isFiled: false
    };
  }

  if (!Number.isFinite(financials.profit?.value) &&
      Number.isFinite(xray.financials.profit)) {
    financials.profit = {
      value: xray.financials.profit,
      year,
      source: "Xray Finance",
      isFiled: false
    };
  }

  if (
    (!financials.employees || typeof financials.employees !== "object") &&
    Number.isFinite(xray.financials.employees)
  ) {
    financials.employees = {
      value: xray.financials.employees,
      display: String(xray.financials.employees),
      year
    };
  }

  financials.netWorth = Number.isFinite(xray.financials.netWorth)
    ? xray.financials.netWorth
    : financials.netWorth ?? null;
  financials.pfn = Number.isFinite(xray.financials.pfn)
    ? xray.financials.pfn
    : financials.pfn ?? null;

  if (
    Number.isFinite(xray.financials.year) &&
    (
      Number.isFinite(xray.financials.revenue) ||
      Number.isFinite(xray.financials.profit)
    )
  ) {
    financials.balanceHistory = mergeBalanceHistories(
      financials.balanceHistory,
      [{
        year: xray.financials.year,
        revenue: Number.isFinite(xray.financials.revenue)
          ? xray.financials.revenue
          : null,
        profit: Number.isFinite(xray.financials.profit)
          ? xray.financials.profit
          : null,
        source: "Xray Finance",
        isFiled: false
      }]
    );
  }

  company.financials = promoteLatestFinancialYear(financials);
  ensurePersonnelCostRatio(company.financials);
  company.providers = unique([...(company.providers || []), xray.provider]);
  company.provider = company.providers.join(" · ");
  return company;
}

export function enrichCompanyWithFallback(company, fallback) {
  if (!fallback) return company;

  for (const key of [
    "status",
    "address",
    "legalForm",
    "taxCode",
    "rea",
    "pec",
    "sdi",
    "registrationDate",
    "chamber",
    "city",
    "province",
    "region"
  ]) {
    if (!company[key] && fallback[key]) company[key] = fallback[key];
  }

  if ((!company.ateco?.code && !company.ateco?.description) && fallback.ateco) {
    company.ateco = fallback.ateco;
  }

  const financials = company.financials || {};
  const fallbackFinancials = fallback.financials || {};

  for (const key of ["revenue", "profit", "employees"]) {
    if (!financials[key] && fallbackFinancials[key]) {
      financials[key] = fallbackFinancials[key];
    }
  }

  financials.balanceHistory = mergeBalanceHistories(
    financials.balanceHistory,
    fallbackFinancials.balanceHistory
  );

  if (!Number.isFinite(financials.netMargin) &&
      Number.isFinite(financials.profit?.value) &&
      Number.isFinite(financials.revenue?.value) &&
      financials.revenue.value !== 0) {
    financials.netMargin =
      (financials.profit.value / financials.revenue.value) * 100;
  }

  if (!Number.isFinite(financials.revenuePerEmployee) &&
      Number.isFinite(financials.revenue?.value) &&
      Number.isFinite(financials.employees?.value) &&
      financials.employees.value > 0) {
    financials.revenuePerEmployee =
      financials.revenue.value / financials.employees.value;
  }

  company.financials = promoteLatestFinancialYear(financials);
  ensurePersonnelCostRatio(company.financials);
  company.providers = unique([
    ...(company.providers || []),
    fallback.provider
  ]);
  company.provider = company.providers.join(" · ");

  return company;
}
