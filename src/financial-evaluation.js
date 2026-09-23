function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function parseItalianDate(value) {
  const match = String(value || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;

  const date = new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function companyAgeYears(registrationDate, now = new Date()) {
  const registered = parseItalianDate(registrationDate);
  if (!registered) return null;

  let age = now.getFullYear() - registered.getFullYear();
  const anniversaryPassed =
    now.getMonth() > registered.getMonth() ||
    (now.getMonth() === registered.getMonth() && now.getDate() >= registered.getDate());

  if (!anniversaryPassed) age -= 1;
  return age >= 0 ? age : null;
}

function netMargin(financials) {
  if (Number.isFinite(financials?.netMargin)) return financials.netMargin;

  const revenue = financials?.revenue?.value;
  const profit = financials?.profit?.value;

  if (!Number.isFinite(revenue) || revenue === 0 || !Number.isFinite(profit)) return null;
  return (profit / revenue) * 100;
}

function ebitdaMargin(financials) {
  if (Number.isFinite(financials?.ebitdaMargin?.value)) {
    return financials.ebitdaMargin.value;
  }

  const revenue = financials?.revenue?.value;
  const ebitda = financials?.ebitda?.value;

  if (!Number.isFinite(revenue) || revenue === 0 || !Number.isFinite(ebitda)) return null;
  return (ebitda / revenue) * 100;
}

function revenueTrend(history) {
  const rows = (Array.isArray(history) ? history : [])
    .filter((item) => Number.isFinite(item?.revenue))
    .sort((a, b) => b.year - a.year);

  if (rows.length < 2) return null;

  const latest = rows[0].revenue;
  const oldest = rows[rows.length - 1].revenue;
  if (!oldest) return null;

  return ((latest - oldest) / Math.abs(oldest)) * 100;
}

export function evaluateFinancialProfile(company, { now = new Date() } = {}) {
  const financials = company?.financials || {};
  const history = Array.isArray(financials.balanceHistory)
    ? financials.balanceHistory.slice(0, 3)
    : [];
  const filedHistory = history.filter((item) => item?.isFiled === true);
  const status = String(company?.status || "").toLowerCase();
  const active = /^attiva\b/.test(status);
  const closed = /cessat|inattiv|chius|liquidaz|fallit/.test(status);
  const age = companyAgeYears(company?.registrationDate, now);
  const ebitdaPct = ebitdaMargin(financials);
  const netPct = netMargin(financials);
  const trendPct = revenueTrend(history);

  const factors = [];
  let score = 0;

  if (closed) {
    factors.push({ key: "status", points: 0, max: 15, value: company?.status || null });
  } else if (active) {
    score += 15;
    factors.push({ key: "status", points: 15, max: 15, value: company?.status });
  } else {
    score += 7;
    factors.push({ key: "status", points: 7, max: 15, value: company?.status || null });
  }

  let agePoints = 0;
  if (Number.isFinite(age)) {
    if (age >= 5) agePoints = 10;
    else if (age >= 2) agePoints = 7;
    else agePoints = 2;
  }
  score += agePoints;
  factors.push({ key: "age", points: agePoints, max: 10, value: age });

  let balancePoints = 0;
  if (filedHistory.length >= 3) balancePoints = 15;
  else if (filedHistory.length >= 2) balancePoints = 12;
  else if (filedHistory.length === 1) balancePoints = 4;
  score += balancePoints;
  factors.push({
    key: "balanceHistory",
    points: balancePoints,
    max: 15,
    value: filedHistory.length,
    observedFinancialYears: history.length
  });

  let ebitdaPoints = 0;
  if (Number.isFinite(ebitdaPct)) {
    if (ebitdaPct >= 15) ebitdaPoints = 20;
    else if (ebitdaPct >= 8) ebitdaPoints = 16;
    else if (ebitdaPct >= 3) ebitdaPoints = 10;
    else if (ebitdaPct > 0) ebitdaPoints = 5;
    else ebitdaPoints = -5;
  }
  score += ebitdaPoints;
  factors.push({ key: "ebitdaMargin", points: ebitdaPoints, max: 20, value: ebitdaPct });

  let netPoints = 0;
  if (Number.isFinite(netPct)) {
    if (netPct >= 10) netPoints = 15;
    else if (netPct >= 3) netPoints = 12;
    else if (netPct > 0) netPoints = 8;
    else netPoints = -8;
  }
  score += netPoints;
  factors.push({ key: "netMargin", points: netPoints, max: 15, value: netPct });

  let trendPoints = 0;
  if (Number.isFinite(trendPct)) {
    if (trendPct >= 10) trendPoints = 15;
    else if (trendPct >= -10) trendPoints = 10;
    else trendPoints = 3;
  }
  score += trendPoints;
  factors.push({ key: "revenueTrend", points: trendPoints, max: 15, value: trendPct });

  const historicalProfits = history.filter((item) => Number.isFinite(item?.profit));
  const positiveYears = historicalProfits.filter((item) => item.profit > 0).length;
  let consistencyPoints = 0;
  if (historicalProfits.length) {
    if (positiveYears === historicalProfits.length && historicalProfits.length >= 3) {
      consistencyPoints = 10;
    } else if (positiveYears >= 2) {
      consistencyPoints = 7;
    } else if (positiveYears === 1) {
      consistencyPoints = 3;
    }
  }
  score += consistencyPoints;
  factors.push({
    key: "profitConsistency",
    points: consistencyPoints,
    max: 10,
    value: historicalProfits.length ? `${positiveYears}/${historicalProfits.length}` : null
  });

  if (closed) score = Math.min(score, 20);

  const availableSignals = [
    company?.status,
    Number.isFinite(age),
    filedHistory.length,
    Number.isFinite(ebitdaPct),
    Number.isFinite(netPct),
    Number.isFinite(trendPct)
  ].filter(Boolean).length;

  return {
    score: clamp(score),
    factors,
    metrics: {
      age,
      ebitdaMargin: ebitdaPct,
      netMargin: netPct,
      revenueTrend: trendPct
    },
    requirements: {
      atLeastTwoFiledBalances: filedHistory.length >= 2
    },
    completeness: Math.round((availableSignals / 6) * 100)
  };
}
