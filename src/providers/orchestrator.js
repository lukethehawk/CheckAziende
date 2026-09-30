import { findAziendeCompanyByVat } from "./aziende.js";
import { findCompanyReportsCompanyByVat } from "./companyreports.js";
import {
  buildXraySlugCandidates,
  findXrayCompanyByVat
} from "./xray.js";
import { findRegistroAziendeCompanyByVat } from "./registroaziende.js";
import { readSnapshot, writeSnapshot } from "./snapshot-client.js";
const PRIMARY_BUDGET_MS = 1600;
const XRAY_BUDGET_MS = 900;
const FALLBACK_BUDGET_MS = 550;
const ENRICHMENT_BUDGET_MS = 500;

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

export function selectCanonicalPrimary(companyReports, registro) {
  return companyReports || registro || null;
}

export function mergeProviderResultState(current = {}, patch = {}) {
  const merged = {
    ...(current || {}),
    ...(patch || {})
  };

  for (const key of ["primary", "companyReports", "aziende", "xray", "registro", "verification"]) {
    if (
      (patch?.[key] === null || patch?.[key] === undefined) &&
      current?.[key] !== null &&
      current?.[key] !== undefined
    ) {
      merged[key] = current[key];
    }
  }

  // CompanyReports.it remains canonical once it has been observed. The
  // optional Aziende.it enrichment only contributes `sectorComparison`, so it
  // must never replace the visible primary, and a later fallback update cannot
  // downgrade an already resolved canonical record.
  const canonical = merged.companyReports || merged.registro || null;
  if (canonical) merged.primary = canonical;

  return merged;
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


export function missingProviderRefreshPlan(value) {
  const canonical =
    value?.companyReports ||
    value?.registro ||
    null;

  // When the canonical records are still missing, the VAT may only be carried
  // by an optional provider (a progressive snapshot persisted before the
  // canonical record arrived). Without this fallback such a snapshot would
  // look complete and never refresh.
  const primary =
    canonical ||
    value?.primary ||
    value?.xray ||
    value?.aziende ||
    null;

  const hasVat = Boolean(primary?.vat);

  return {
    companyReports: hasVat && !value?.companyReports,
    // The optional Aziende.it sector enrichment is independent of the
    // canonical record, so a fresh snapshot that lacks it still gets one.
    aziende: hasVat && !value?.aziende,
    xray: hasVat && !value?.xray,
    registro:
      hasVat &&
      !value?.registro &&
      needsFallback(canonical || value?.primary || null)
  };
}

// A reordered canonical name can promote an existing base into the direct
// (first four) or numbered (first three) search window. Comparing all ten
// candidates would incorrectly skip the only lookup that can reach it.
function xrayCanonicalAddsCandidates(names, canonicalName) {
  if (!canonicalName) return false;

  const initial = buildXraySlugCandidates(names);
  const canonical = buildXraySlugCandidates([canonicalName, ...names]);
  const direct = new Set(initial.slice(0, 4));
  const numbered = new Set(initial.slice(0, 3));

  return canonical.slice(0, 4).some((slug) => !direct.has(slug)) ||
    canonical.slice(0, 3).some((slug) => !numbered.has(slug));
}

async function resolveNetwork({
  vat,
  names = [],
  provinceHints = [],
  cityHints = []
}) {
  // CompanyReports.it is the canonical record and leads the critical path.
  const companyReportsPromise = findCompanyReportsCompanyByVat(vat, {
    names,
    provinceHints
  }).catch(() => null);

  const initialXrayPromise = findXrayCompanyByVat(vat, {
    names
  }).catch(() => null);

  // Start the verifier immediately using the page/VIES hints we already have.
  // If we later obtain a better canonical name from CompanyReports.it we can
  // retry, but in most cases this removes RegistroAziende from the critical
  // path.
  const initialRegistroPromise = findRegistroAziendeCompanyByVat(vat, {
    names,
    cityHints
  }).catch(() => null);

  const [companyReportsFast, xrayFast] = await Promise.all([
    timeoutValue(companyReportsPromise, PRIMARY_BUDGET_MS),
    timeoutValue(initialXrayPromise, XRAY_BUDGET_MS)
  ]);

  const buildRegistroPromise = (companyReports = null) =>
    findRegistroAziendeCompanyByVat(vat, {
      names: [companyReports?.name, ...names].filter(Boolean),
      cityHints: [companyReports?.city, ...cityHints].filter(Boolean)
    }).catch(() => null);

  let registro = null;
  let nameBasedRegistroPromise = null;

  // RegistroAziende is a verifier/fallback. It may fill gaps, but it should
  // never replace a richer CompanyReports.it record when the latter is
  // available.
  if (needsFallback(companyReportsFast)) {
    registro = await timeoutValue(
      initialRegistroPromise,
      FALLBACK_BUDGET_MS
    );

    // The speculative lookup can miss when only the canonical company name
    // resolves the public RegistroAziende slug. Keep that promise alive so the
    // progressive channel reuses the lookup instead of issuing it twice.
    if (!registro && companyReportsFast?.name) {
      nameBasedRegistroPromise = buildRegistroPromise(companyReportsFast);
      registro = await timeoutValue(
        nameBasedRegistroPromise,
        ENRICHMENT_BUDGET_MS
      );
    }
  }

  let xray = xrayFast;
  let canonicalXrayPromise = null;

  // Xray matching is much more reliable once the canonical company name is
  // known, but only when that name unlocks new slug candidates. When the
  // speculative search already covers them, retrying would just duplicate the
  // same requests, so it is skipped.
  if (
    !xray &&
    companyReportsFast?.name &&
    xrayCanonicalAddsCandidates(names, companyReportsFast.name)
  ) {
    canonicalXrayPromise = findXrayCompanyByVat(vat, {
      names: [companyReportsFast.name, ...names]
    }).catch(() => null);

    xray = await timeoutValue(
      canonicalXrayPromise,
      ENRICHMENT_BUDGET_MS
    );
  }

  const primary = selectCanonicalPrimary(companyReportsFast, registro);
  const verification = compareProviderData(
    companyReportsFast || primary,
    registro
  );

  // Late providers publish their own progressive patch the moment their own
  // lookup settles. 'lateProviders' is the shared latch: a channel may read
  // what the other one already produced, but it must never wait for it,
  // otherwise a slow optional provider hides the canonical record until the
  // popup is reopened.
  const lateProviders = {
    companyReports: companyReportsFast || null,
    registro: registro || null
  };

  const xrayPublished = { value: Boolean(xray) };

  // Every lookup a channel owns is exposed as a progressive pending update
  // and persists its own snapshot slot: nothing is left as a fire-and-forget
  // loser.
  const pendingUpdates = [];

  if (!companyReportsFast) {
    pendingUpdates.push({
      provider: "companyReports",
      promise: companyReportsPromise
        .then(async (companyReports) => {
          if (!companyReports) return null;

          lateProviders.companyReports = companyReports;

          const update = {
            primary: companyReports,
            companyReports,
            verification: compareProviderData(
              companyReports,
              lateProviders.registro
            )
          };

          // Only attach the RegistroAziende record when it is already known:
          // a null would have to be ignored anyway, and waiting for it here is
          // exactly what delayed the canonical patch.
          if (lateProviders.registro) update.registro = lateProviders.registro;

          await writeSnapshot(vat, update);
          return update;
        })
        .catch(() => null)
    });
  }

  if (!registro) {
    const registroChannel = (async () => {
      // Reuse the speculative lookup: it is the exact VAT-driven request the
      // first render already started.
      let value = await initialRegistroPromise;

      if (!value) {
        // In some cases only the canonical company name resolves the public
        // RegistroAziende slug. Reuse a name-based lookup already started
        // above instead of issuing the same request twice.
        const canonical =
          lateProviders.companyReports || await companyReportsPromise;

        value = nameBasedRegistroPromise
          ? await nameBasedRegistroPromise
          : canonical?.name
            ? await buildRegistroPromise(canonical)
            : null;
      }

      if (!value) return null;

      lateProviders.registro = value;

      const canonical =
        lateProviders.companyReports || companyReportsFast || null;

      // Persist only the slot this channel resolved. The canonical record and
      // Xray are owned by their own channels and a null here must never
      // overwrite them.
      const update = {
        registro: value,
        verification: compareProviderData(canonical, value)
      };

      await writeSnapshot(vat, update);
      return update;
    })().catch(() => null);

    pendingUpdates.push({ provider: "registro", promise: registroChannel });
  }

  if (!xray) {
    // The speculative search started at the very beginning may still be
    // walking Xray profiles: keep it alive as its own progressive channel.
    pendingUpdates.push({
      provider: "xray",
      promise: initialXrayPromise
        .then(async (value) => {
          if (!value) return null;
          xrayPublished.value = true;
          await writeSnapshot(vat, { xray: value });
          return { xray: value };
        })
        .catch(() => null)
    });

    // Canonical retry channel: waits for the canonical name when it is still
    // unknown, reuses the lookup already started inside the fast window (if
    // any) or starts a single new one, and never issues a request the
    // speculative search already covers. It is only exposed when a retry is
    // still possible: either the canonical name is unknown yet, or a retry
    // lookup was already started during the fast window.
    if (canonicalXrayPromise || !companyReportsFast) {
      const canonicalXrayChannel = (async () => {
        let lookup = canonicalXrayPromise;

        if (!lookup) {
          const record = companyReportsFast || await companyReportsPromise;
          if (!record?.name) return null;
          if (xrayPublished.value) return null;
          if (!xrayCanonicalAddsCandidates(names, record.name)) return null;

          lookup = findXrayCompanyByVat(vat, {
            names: [record.name, ...names]
          }).catch(() => null);
        }

        const value = await lookup;
        return value || null;
      })().catch(() => null);

      pendingUpdates.push({
        provider: "xray",
        promise: canonicalXrayChannel
          .then(async (value) => {
            if (!value) return null;
            xrayPublished.value = true;
            await writeSnapshot(vat, { xray: value });
            return { xray: value };
          })
          .catch(() => null)
      });
    }
  }

  // Aziende.it sector comparison is optional enrichment. It starts only after
  // the fast result is ready, so it can never delay the first render, persists
  // on arrival and hands the popup a patch that cannot touch the canonical
  // primary.
  pendingUpdates.push({
    provider: "aziende",
    promise: findAziendeCompanyByVat(vat, {
      names: [companyReportsFast?.name, ...names].filter(Boolean),
      provinceHints,
      cityHints
    })
      .catch(() => null)
      .then(async (azienda) => {
        if (!azienda) return null;

        // Only merge the new slot: other providers may have completed after
        // the first render and already updated their snapshot fields.
        await writeSnapshot(vat, { aziende: azienda });

        return { aziende: azienda };
      })
      .catch(() => null)
  });

  const result = {
    primary,
    companyReports: companyReportsFast,
    aziende: null,
    xray,
    registro,
    verification,
    pendingUpdates
  };

  await writeSnapshot(vat, result);
  return result;
}

export async function resolveCompanyProviders(args) {
  const vat = String(args?.vat || "").replace(/\D/g, "");
  const cached = await readSnapshot(vat);

  if (cached?.value) {
    if (cached.stale) {
      // Stale-while-revalidate: the popup gets the cached record immediately
      // and a single nested refresh pending update. The fresh result carries
      // its own 'pendingUpdates', which the popup subscribes to recursively.
      const refresh = resolveNetwork(args).catch(() => null);

      return {
        ...cached.value,
        fromCache: true,
        stale: true,
        pendingUpdates: [{ provider: "refresh", promise: refresh }]
      };
    }

    const plan = missingProviderRefreshPlan(cached.value);
    const primary =
      cached.value.companyReports ||
      cached.value.primary ||
      cached.value.registro ||
      null;
    const names = [
      primary?.name,
      ...(args?.names || [])
    ].filter(Boolean);
    const provinceHints = args?.provinceHints || [];
    const cityHints = args?.cityHints || [];
    const pendingUpdates = [];

    if (plan.companyReports) {
      pendingUpdates.push({
        provider: "companyReports",
        promise: findCompanyReportsCompanyByVat(vat, {
          names,
          provinceHints
        })
          .then(async (companyReports) => {
            if (!companyReports) return null;

            const update = {
              primary: companyReports,
              companyReports,
              verification: compareProviderData(
                companyReports,
                cached.value.registro || null
              )
            };

            await writeSnapshot(vat, update);
            return update;
          })
          .catch(() => null)
      });
    }

    if (plan.registro) {
      const registroCities = [
        primary?.city,
        ...cityHints
      ].filter(Boolean);

      pendingUpdates.push({
        provider: "registro",
        promise: findRegistroAziendeCompanyByVat(vat, {
          names,
          cityHints: registroCities
        })
          .then(async (registro) => {
            if (!registro) return null;

            const canonical =
              cached.value.companyReports || primary || registro;

            const update = {
              registro,
              verification: compareProviderData(canonical, registro)
            };

            await writeSnapshot(vat, update);
            return update;
          })
          .catch(() => null)
      });
    }

    if (plan.xray) {
      pendingUpdates.push({
        provider: "xray",
        promise: findXrayCompanyByVat(vat, {
          names
        })
          .then(async (xray) => {
            if (!xray) return null;

            await writeSnapshot(vat, { xray });
            return { xray };
          })
          .catch(() => null)
      });
    }

    if (plan.aziende) {
      pendingUpdates.push({
        provider: "aziende",
        promise: findAziendeCompanyByVat(vat, {
          names,
          provinceHints,
          cityHints
        })
          .then(async (azienda) => {
            if (!azienda) return null;

            await writeSnapshot(vat, { aziende: azienda });
            return { aziende: azienda };
          })
          .catch(() => null)
      });
    }

    return {
      ...cached.value,
      fromCache: true,
      stale: false,
      pendingUpdates
    };
  }

  const result = await resolveNetwork(args);
  return {
    ...result,
    fromCache: false,
    stale: false
  };
}
