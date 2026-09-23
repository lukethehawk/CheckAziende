import { slugifyCompanyName } from "./aziende.js";

const BASE_URL = "https://xrayfinance.it";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const api = globalThis.browser ?? globalThis.chrome;

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function parseItalianInteger(value) {
  const raw = String(value || "").trim();
  if (!raw || /^NaN$/i.test(raw)) return null;

  const negative = /^-/.test(raw);
  const digits = raw.replace(/[^0-9]/g, "");
  if (!digits) return null;

  const parsed = Number(digits);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

function parsePercent(value) {
  const match = String(value || "").match(/-?\d+(?:[.,]\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0].replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function parseThousandsMetric(value) {
  const parsed = parseItalianInteger(value);
  return Number.isFinite(parsed) ? parsed * 1000 : null;
}

function inferVat(text) {
  const match = String(text || "").match(
    /(?:P\.?\s*IVA|Partita\s+IVA)\s*:?[\s]*([0-9]{11})/i
  );
  return match?.[1] || null;
}

function inferYear(text) {
  const match = String(text || "").match(/Fatturato\s+(20\d{2})\s+/i) ||
    String(text || "").match(/Ultimo\s+bilancio[^\n]*?(20\d{2})/i);
  return match ? Number(match[1]) : null;
}

function inferMetric(text, pattern) {
  const match = String(text || "").match(pattern);
  return match ? parseThousandsMetric(match[1]) : null;
}

export function parseXrayText(text, { name = null, url = null } = {}) {
  const source = String(text || "");
  const vat = inferVat(source);
  if (!vat) return null;

  const year = inferYear(source);
  const revenue = inferMetric(
    source,
    /Fatturato\s+20\d{2}\s+(-?[0-9][0-9.]*)/i
  );
  const ebitda = inferMetric(
    source,
    /EBITDA\s*(-?[0-9][0-9.]*)/i
  );
  const profit = inferMetric(
    source,
    /Utile\/Perdita\s*(-?[0-9][0-9.]*)/i
  );
  const netWorth = inferMetric(
    source,
    /Patrimonio\s+Netto\s*(-?[0-9][0-9.]*)/i
  );
  const pfn = inferMetric(
    source,
    /Posizione\s+Finanziaria\s+Netta\s*(-?[0-9][0-9.]*)/i
  );

  const marginMatch = source.match(/EBITDA\s+(-?(?:Infinity|\d+(?:[.,]\d+)?)%)?/i);
  let ebitdaMargin = null;

  const explicitMargin = source.match(/EBITDA\s+(-?\d+(?:[.,]\d+)?)%/i);
  if (explicitMargin) {
    ebitdaMargin = parsePercent(explicitMargin[1]);
  } else if (Number.isFinite(ebitda) && Number.isFinite(revenue) && revenue !== 0) {
    ebitdaMargin = (ebitda / revenue) * 100;
  }

  const employeeMatch = source.match(/Dipendenti\s+([0-9][0-9.]*)/i);
  const employees = employeeMatch
    ? parseItalianInteger(employeeMatch[1])
    : null;

  const atecoMatch = source.match(/ATECO\s+([0-9]{2}(?:\.[0-9]{1,2}){1,3})/i);

  return {
    provider: "Xray Finance",
    providerUrl: url || null,
    name: clean(name) || null,
    vat,
    ateco: atecoMatch ? { code: atecoMatch[1], description: null } : null,
    financials: {
      year,
      revenue,
      ebitda,
      ebitdaMargin,
      profit,
      employees,
      netWorth,
      pfn
    }
  };
}

export function parseXrayPage(html, url) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const h1 = clean(doc.querySelector("h1")?.textContent || "");
  const text = doc.body?.innerText || doc.body?.textContent || "";
  return parseXrayText(text, { name: h1 || null, url });
}

function nameSlugVariants(name) {
  const raw = slugifyCompanyName(name);
  if (!raw || raw.length < 3) return [];

  const variants = new Set([raw]);

  variants.add(
    raw
      .replace(/-spa(?:$|-)/g, "-s-p-a$1")
      .replace(/-srl(?:$|-)/g, "-s-r-l$1")
  );

  variants.add(
    raw
      .replace(/-societa-per-azioni(?:$|-)/g, "-s-p-a$1")
      .replace(/-societa-a-responsabilita-limitata(?:$|-)/g, "-s-r-l$1")
  );

  return [...variants]
    .map((value) => value.replace(/\$1/g, "").replace(/-{2,}/g, "-"))
    .filter(Boolean);
}

export function buildXraySlugCandidates(names) {
  const generic = new Set([
    "home",
    "homepage",
    "login",
    "benvenuti",
    "welcome",
    "area-clienti"
  ]);

  const bases = [];

  for (const name of unique(names)) {
    for (const slug of nameSlugVariants(name)) {
      if (!generic.has(slug)) bases.push(slug);
    }
  }

  return unique(bases).slice(0, 10);
}

async function readCache(key) {
  try {
    const stored = await api.storage.local.get(key);
    const entry = stored?.[key];
    if (!entry || Date.now() - entry.cachedAt > CACHE_TTL_MS) return undefined;
    return entry.value;
  } catch {
    return undefined;
  }
}

async function writeCache(key, value) {
  try {
    await api.storage.local.set({
      [key]: {
        cachedAt: Date.now(),
        value
      }
    });
  } catch {
    // Cache is optional.
  }
}

async function fetchSlug(slug) {
  const key = `xray:v1:slug:${slug}`;
  const cached = await readCache(key);
  if (cached !== undefined) return cached;

  const url = `${BASE_URL}/${encodeURIComponent(slug)}`;

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      credentials: "omit",
      headers: {
        "Accept": "text/html,application/xhtml+xml"
      }
    });

    if (!response.ok) {
      await writeCache(key, null);
      return null;
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) return null;

    const html = await response.text();
    const company = parseXrayPage(html, response.url || url);

    await writeCache(key, company || null);
    return company || null;
  } catch {
    return null;
  }
}

async function firstVatMatch(slugs, vat) {
  for (let i = 0; i < slugs.length; i += 5) {
    const batch = slugs.slice(i, i + 5);
    const results = await Promise.all(batch.map(fetchSlug));
    const match = results.find((company) => company?.vat === vat);
    if (match) return match;
  }

  return null;
}

export async function findXrayCompanyByVat(vat, { names = [] } = {}) {
  const targetVat = String(vat || "").replace(/\D/g, "");
  if (!/^\d{11}$/.test(targetVat)) return null;

  const bases = buildXraySlugCandidates(names);
  if (!bases.length) return null;

  const direct = await firstVatMatch(bases, targetVat);
  if (direct) return direct;

  // Xray disambiguates homonyms with numeric suffixes (e.g. name-2, name-8).
  // Only enumerate suffixes after direct candidates fail, and always validate VAT.
  const numbered = [];
  for (const base of bases.slice(0, 3)) {
    for (let suffix = 1; suffix <= 18; suffix += 1) {
      numbered.push(`${base}-${suffix}`);
    }
  }

  return firstVatMatch(numbered, targetVat);
}
