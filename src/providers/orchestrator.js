import { findAziendeCompanyByVat } from "./aziende.js";
import { findXrayCompanyByVat } from "./xray.js";
import { findRegistroAziendeCompanyByVat } from "./registroaziende.js";

const FAST_BUDGET_MS = 950;
const FALLBACK_BUDGET_MS = 650;

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

export function needsFallback(company) {
  if (!company) return true;

  const financials = company.financials || {};
  const history = financials.balanceHistory || [];

  return !company.status ||
    !company.ateco?.code ||
    !Number.isFinite(financials.revenue?.value) ||
    !Number.isFinite(financials.profit?.value) ||
    history.length < 2;
}

export async function resolveCompanyProviders({
  vat,
  names = [],
  provinceHints = [],
  cityHints = []
}) {
  const aziendePromise = findAziendeCompanyByVat(vat, {
    names,
    provinceHints
  });

  const xrayPromise = findXrayCompanyByVat(vat, { names });

  const [aziende, xray] = await Promise.all([
    timeoutValue(aziendePromise, FAST_BUDGET_MS),
    timeoutValue(xrayPromise, FAST_BUDGET_MS)
  ]);

  const registroPromise = findRegistroAziendeCompanyByVat(vat, {
    names: [aziende?.name, ...names].filter(Boolean),
    cityHints: [aziende?.city, ...cityHints].filter(Boolean)
  });

  let registro = null;

  if (needsFallback(aziende)) {
    registro = await timeoutValue(
      registroPromise,
      FALLBACK_BUDGET_MS
    );
  }

  const primary = aziende || registro || null;
  const verification = compareProviderData(primary, registro);

  return {
    primary,
    aziende,
    xray,
    registro,
    verification,
    backgroundVerification: registro
      ? null
      : registroPromise.then((value) => ({
          registro: value,
          verification: compareProviderData(primary, value)
        }))
  };
}
