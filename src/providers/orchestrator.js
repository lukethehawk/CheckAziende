import { findAziendeCompanyByVat } from "./aziende.js";
import { findXrayCompanyByVat } from "./xray.js";
import { findRegistroAziendeCompanyByVat } from "./registroaziende.js";

const PRIMARY_BUDGET_MS = 1600;
const XRAY_BUDGET_MS = 900;
const FALLBACK_BUDGET_MS = 550;
const ENRICHMENT_BUDGET_MS = 500;
const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const api = globalThis.browser ?? globalThis.chrome;

function timeoutValue(promise, ms, fallback = null) {
  return Promise.race([
    Promise.resolve(promise).catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), ms))
  ]);
}

function sameYearValue(a, b, field) {
  const left = a?.financials?.[field];
  const right = b?.financials?.[field];
  if (!left || !right) return null;
  if (!Number.isFinite(left.value) || !Number.isFinite(right.value)) return null;
  if (!left.year || !right.year || left.year !== right.year) return null;
  return { left: left.value, right: right.value, year: left.year };
}

function relativeDifference(left, right) {
  const denominator = Math.max(Math.abs(left), Math.abs(right), 1);
  return Math.abs(left - right) / denominator;
}

export function compareProviderData(primary, verifier) {
  const conflicts = [];

  if (!primary || !verifier) {
    return { verified: false, conflicts, agreement: null };
  }

  if (primary.vat && verifier.vat && primary.vat !== verifier.vat) {
    conflicts.push("vat");
  }

  if (
    primary.status &&
    verifier.status &&
    primary.status.toLowerCase() !== verifier.status.toLowerCase()
  ) {
    conflicts.push("status");
  }

  for (const field of ["revenue", "profit"]) {
    const values = sameYearValue(primary, verifier, field);
    if (!values) continue;
    if (relativeDifference(values.left, values.right) > 0.02) {
      conflicts.push(field);
    }
  }

  const checks = [
    Boolean(primary.vat && verifier.vat && primary.vat === verifier.vat),
    Boolean(primary.status && verifier.status),
    Boolean(sameYearValue(primary, verifier, "revenue")),
    Boolean(sameYearValue(primary, verifier, "profit"))
  ].filter(Boolean).length;

  return {
    verified: conflicts.length === 0 && checks > 0,
    conflicts,
    agreement: checks ? Math.max(0, 100 - conflicts.length * 25) : null
  };
}

export function selectCanonicalPrimary(aziende, registro) {
  return aziende || registro || null;
}

export function mergeBalanceHistories(primaryHistory, fallbackHistory) {
  const byYear = new Map();

  const sourceList = (item) => [
    ...(Array.isArray(item?.sources) ? item.sources : []),
    item?.source
  ].filter(Boolean);

  const addPrimary = (item) => {
    const year = Number(item?.year);
    if (!Number.isFinite(year)) return;

    const sources = [...new Set(sourceList(item))];
    byYear.set(year, {
      ...item,
      year,
      sources,
      source: item?.source || sources[0] || null,
      isFiled: Boolean(item?.isFiled)
    });
  };

  const addFallback = (item) => {
    const year = Number(item?.year);
    if (!Number.isFinite(year)) return;

    const existing = byYear.get(year);
    if (!existing) {
      addPrimary(item);
      return;
    }

    const sources = [...new Set([
      ...sourceList(existing),
      ...sourceList(item)
    ])];

    byYear.set(year, {
      ...item,
      ...Object.fromEntries(
        Object.entries(existing).filter(([, value]) => value !== null && value !== undefined)
      ),
      year,
      sources,
      source: existing.source || item?.source || sources[0] || null,
      isFiled: Boolean(existing.isFiled || item?.isFiled)
    });
  };

  for (const item of Array.isArray(primaryHistory) ? primaryHistory : []) {
    addPrimary(item);
  }

  for (const item of Array.isArray(fallbackHistory) ? fallbackHistory : []) {
    addFallback(item);
  }

  return [...byYear.values()].sort((a, b) => b.year - a.year);
}

export function previousBalanceRows(history, currentYear, limit = 3) {
  const year = Number(currentYear);

  return (Array.isArray(history) ? history : [])
    .filter((item) => Number(item?.year) !== year)
    .sort((a, b) => Number(b?.year || 0) - Number(a?.year || 0))
    .slice(0, limit);
}

export function promoteLatestFinancialYear(financials) {
  const result = {
    ...(financials || {}),
    balanceHistory: Array.isArray(financials?.balanceHistory)
      ? [...financials.balanceHistory]
      : []
  };

  const history = result.balanceHistory
    .filter((item) => Number.isFinite(Number(item?.year)))
    .sort((a, b) => Number(b.year) - Number(a.year));

  const sourceList = (item) => [
    ...(Array.isArray(item?.sources) ? item.sources : []),
    item?.source
  ].filter(Boolean);

  const chooseLatest = (summary, field) => {
    const summaryYear = Number(summary?.year);
    const summaryValid =
      Number.isFinite(summary?.value) &&
      Number.isFinite(summaryYear);

    const historyRows = history.filter((item) =>
      Number.isFinite(item?.[field])
    );

    const latestHistory = historyRows[0] || null;
    const historyYear = Number(latestHistory?.year);

    if (
      summaryValid &&
      (!latestHistory || summaryYear >= historyYear)
    ) {
      const sameYearHistory = historyRows.find(
        (item) => Number(item?.year) === summaryYear
      );
      const sources = [...new Set([
        ...sourceList(summary),
        ...sourceList(sameYearHistory)
      ])];

      return {
        ...summary,
        value: summary.value,
        year: summaryYear,
        source: summary?.source || sameYearHistory?.source || sources[0] || null,
        sources,
        isFiled: Boolean(summary?.isFiled || sameYearHistory?.isFiled)
      };
    }

    if (latestHistory) {
      const sources = [...new Set(sourceList(latestHistory))];
      return {
        value: latestHistory[field],
        year: historyYear,
        source: latestHistory.source || sources[0] || null,
        sources,
        isFiled: Boolean(latestHistory.isFiled)
      };
    }

    return summary || null;
  };

  result.revenue = chooseLatest(result.revenue, "revenue");

  const revenueYear = Number(result.revenue?.year);
  const matchingProfitRow = history.find((item) =>
    Number(item?.year) === revenueYear &&
    Number.isFinite(item?.profit)
  );

  if (matchingProfitRow) {
    const sources = [...new Set(sourceList(matchingProfitRow))];
    result.profit = {
      value: matchingProfitRow.profit,
      year: revenueYear,
      source: matchingProfitRow.source || sources[0] || null,
      sources,
      isFiled: Boolean(matchingProfitRow.isFiled)
    };
  } else {
    result.profit = chooseLatest(result.profit, "profit");
  }

  const profitYear = Number(result.profit?.year);

  if (
    Number.isFinite(result.revenue?.value) &&
    result.revenue.value !== 0 &&
    Number.isFinite(result.profit?.value) &&
    revenueYear === profitYear
  ) {
    result.netMargin =
      (result.profit.value / result.revenue.value) * 100;
  } else if (
    Number(financials?.revenue?.year) !== revenueYear
  ) {
    result.netMargin = null;
  }

  if (
    Number.isFinite(result.revenue?.value) &&
    Number.isFinite(result.employees?.value) &&
    result.employees.value > 0
  ) {
    result.revenuePerEmployee =
      result.revenue.value / result.employees.value;
  } else if (
    Number(financials?.revenue?.year) !== revenueYear
  ) {
    result.revenuePerEmployee = null;
  }

  return result;
}

export function financialHistoryNeedsRefresh(
  financials,
  { now = new Date() } = {}
) {
  const history = Array.isArray(financials?.balanceHistory)
    ? financials.balanceHistory
    : [];

  const years = [...new Set(
    history
      .map((item) => Number(item?.year))
      .filter(Number.isFinite)
  )].sort((a, b) => b - a);

  const summaryYear = Number(financials?.revenue?.year);
  if (Number.isFinite(summaryYear) && !years.includes(summaryYear)) {
    years.push(summaryYear);
    years.sort((a, b) => b - a);
  }

  if (years.length < 2) return true;

  const latestYear = years[0];
  const expectedLatest = now.getFullYear() - 1;

  // By the second half of a year, the previous fiscal year is normally the
  // first one worth checking. This is a trigger for verification, not an
  // assumption that a filing must exist.
  const latestMayBeStale =
    now.getMonth() >= 6 &&
    latestYear < expectedLatest;

  const topYears = years.slice(0, 3);
  const hasGap = topYears.some((year, index) =>
    index > 0 && topYears[index - 1] - year > 1
  );

  return latestMayBeStale || hasGap;
}

export function needsFallback(company, options = {}) {
  if (!company) return true;

  const financials = company.financials || {};

  return !company.status ||
    !company.ateco?.code ||
    !Number.isFinite(financials.revenue?.value) ||
    !Number.isFinite(financials.profit?.value) ||
    financialHistoryNeedsRefresh(financials, options);
}

function snapshotKey(vat) {
  return `provider-orchestrator:v4:${vat}`;
}

async function readSnapshot(vat) {
  try {
    const stored = await api.storage.local.get(snapshotKey(vat));
    const entry = stored?.[snapshotKey(vat)];
    if (!entry) return null;

    const age = Date.now() - entry.cachedAt;
    if (age > STALE_TTL_MS) return null;

    return {
      value: entry.value,
      age,
      stale: age > SNAPSHOT_TTL_MS
    };
  } catch {
    return null;
  }
}

async function writeSnapshot(vat, result) {
  try {
    const key = snapshotKey(vat);
    const stored = await api.storage.local.get(key);
    const previous = stored?.[key]?.value || {};

    const aziende = result.aziende || previous.aziende || null;
    const registro = result.registro || previous.registro || null;
    const xray = result.xray || previous.xray || null;

    // Once Aziende.it has resolved, never let a later async fallback write
    // downgrade the canonical company back to RegistroAziende.
    const primary =
      aziende ||
      result.primary ||
      previous.primary ||
      registro ||
      null;

    await api.storage.local.set({
      [key]: {
        cachedAt: Date.now(),
        value: {
          primary,
          aziende,
          xray,
          registro,
          verification:
            result.verification ??
            previous.verification ??
            null
        }
      }
    });
  } catch {
    // Snapshot cache is optional.
  }
}

async function resolveNetwork({
  vat,
  names = [],
  provinceHints = [],
  cityHints = []
}) {
  const aziendePromise = findAziendeCompanyByVat(vat, {
    names,
    provinceHints
  }).catch(() => null);

  const initialXrayPromise = findXrayCompanyByVat(vat, {
    names
  }).catch(() => null);

  // Start the verifier immediately using the page/VIES hints we already have.
  // If we later obtain a better canonical name from Aziende.it we can retry,
  // but in most cases this removes RegistroAziende from the critical path.
  const initialRegistroPromise = findRegistroAziendeCompanyByVat(vat, {
    names,
    cityHints
  }).catch(() => null);

  const [aziendeFast, xrayFast] = await Promise.all([
    timeoutValue(aziendePromise, PRIMARY_BUDGET_MS),
    timeoutValue(initialXrayPromise, XRAY_BUDGET_MS)
  ]);

  const buildRegistroPromise = (azienda = null) =>
    findRegistroAziendeCompanyByVat(vat, {
      names: [azienda?.name, ...names].filter(Boolean),
      cityHints: [azienda?.city, ...cityHints].filter(Boolean)
    }).catch(() => null);

  let registro = null;

  // RegistroAziende is a verifier/fallback. It may fill gaps, but it should
  // never replace a richer Aziende.it record when the latter is available.
  if (needsFallback(aziendeFast)) {
    registro = await timeoutValue(
      initialRegistroPromise,
      FALLBACK_BUDGET_MS
    );

    // The speculative lookup can miss when only the canonical company name
    // resolves the public RegistroAziende slug.
    if (!registro && aziendeFast?.name) {
      registro = await timeoutValue(
        buildRegistroPromise(aziendeFast),
        ENRICHMENT_BUDGET_MS
      );
    }
  }

  let xray = xrayFast;

  // Xray matching is much more reliable once the canonical company name is
  // known. Retry cheaply with the Aziende.it name if the speculative lookup
  // did not resolve.
  if (!xray && aziendeFast?.name) {
    xray = await timeoutValue(
      findXrayCompanyByVat(vat, {
        names: [aziendeFast.name, ...names]
      }),
      ENRICHMENT_BUDGET_MS
    );
  }

  const primary = selectCanonicalPrimary(aziendeFast, registro);
  const verification = compareProviderData(
    aziendeFast || primary,
    registro
  );

  const backgroundCanonical = aziendeFast
    ? null
    : aziendePromise.then(async (azienda) => {
        if (!azienda) return null;

        let richerXray = xray;
        if (!richerXray) {
          richerXray = await findXrayCompanyByVat(vat, {
            names: [azienda.name, ...names].filter(Boolean)
          }).catch(() => null);
        }

        let richerRegistro = registro || await initialRegistroPromise;
        if (!richerRegistro) {
          richerRegistro = await buildRegistroPromise(azienda);
        }

        const update = {
          primary: azienda,
          aziende: azienda,
          xray: richerXray,
          registro: richerRegistro,
          verification: compareProviderData(azienda, richerRegistro)
        };

        await writeSnapshot(vat, update);
        return update;
      });

  const backgroundXray = xray
    ? null
    : initialXrayPromise.then(async (initial) => {
        if (initial) {
          await writeSnapshot(vat, {
            primary,
            aziende: aziendeFast,
            xray: initial,
            registro,
            verification
          });
          return initial;
        }

        const azienda = aziendeFast || await aziendePromise;
        if (!azienda?.name) return null;

        const retry = await findXrayCompanyByVat(vat, {
          names: [azienda.name, ...names].filter(Boolean)
        }).catch(() => null);

        if (retry) {
          await writeSnapshot(vat, {
            primary: azienda || primary,
            aziende: azienda || aziendeFast,
            xray: retry,
            registro,
            verification: compareProviderData(azienda || primary, registro)
          });
        }

        return retry;
      });

  const backgroundVerification = registro
    ? null
    : initialRegistroPromise.then(async (initialValue) => {
        const eventualAziende = aziendeFast || await aziendePromise;
        let value = initialValue;

        if (!value && eventualAziende?.name) {
          value = await buildRegistroPromise(eventualAziende);
        }

        const canonical = eventualAziende || primary || value;
        const update = {
          registro: value,
          verification: compareProviderData(canonical, value)
        };

        await writeSnapshot(vat, {
          primary: canonical,
          aziende: eventualAziende,
          xray,
          registro: value,
          verification: update.verification
        });

        return update;
      });

  const result = {
    primary,
    aziende: aziendeFast,
    xray,
    registro,
    verification,
    backgroundCanonical,
    backgroundXray,
    backgroundVerification
  };

  await writeSnapshot(vat, result);
  return result;
}

export async function resolveCompanyProviders(args) {
  const vat = String(args?.vat || "").replace(/\D/g, "");
  const cached = await readSnapshot(vat);

  if (cached?.value) {
    const backgroundRefresh = cached.stale
      ? resolveNetwork(args).catch(() => null)
      : null;

    return {
      ...cached.value,
      fromCache: true,
      stale: cached.stale,
      backgroundCanonical: null,
      backgroundXray: null,
      backgroundVerification: null,
      backgroundRefresh
    };
  }

  const result = await resolveNetwork(args);
  return {
    ...result,
    fromCache: false,
    stale: false,
    backgroundRefresh: null
  };
}
