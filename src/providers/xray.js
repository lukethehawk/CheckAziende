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

  const srlMatch = raw.match(
    /^(.*?)-(?:srl|s-r-l|societa-a-responsabilita-limitata)(?:-|$)/
  );
  if (srlMatch?.[1]) {
    variants.add(`${srlMatch[1]}-srl`);
    variants.add(`${srlMatch[1]}-s-r-l`);
    variants.add(`${srlMatch[1]}-societa-a-responsabilita-limitata`);
  }

  const spaMatch = raw.match(
    /^(.*?)-(?:spa|s-p-a|societa-per-azioni)(?:-|$)/
  );
  if (spaMatch?.[1]) {
    variants.add(`${spaMatch[1]}-spa`);
    variants.add(`${spaMatch[1]}-s-p-a`);
    variants.add(`${spaMatch[1]}-societa-per-azioni`);
  }

  variants.add(
    raw
      .replace(/-spa$/, "-s-p-a")
      .replace(/-srl$/, "-s-r-l")
      .replace(/-srls$/, "-s-r-l-s")
  );

  variants.add(
    raw
      .replace(/-s-p-a$/, "-spa")
      .replace(/-s-r-l$/, "-srl")
      .replace(/-s-r-l-s$/, "-srls")
  );

  variants.add(
    raw
      .replace(/-societa-per-azioni$/, "-s-p-a")
      .replace(/-societa-a-responsabilita-limitata$/, "-s-r-l")
      .replace(/-societa-a-responsabilita-limitata-semplificata$/, "-s-r-l-s")
  );

  variants.add(
    raw
      .replace(/-spa$/, "-societa-per-azioni")
      .replace(/-s-p-a$/, "-societa-per-azioni")
      .replace(/-srl$/, "-societa-a-responsabilita-limitata")
      .replace(/-s-r-l$/, "-societa-a-responsabilita-limitata")
  );

  return [...variants]
    .map((value) => value.replace(/-{2,}/g, "-"))
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


async function fetchHtml(url, options = {}) {
  try {
    const response = await fetch(url, {
      method: options.method || "GET",
      body: options.body || undefined,
      redirect: "follow",
      credentials: "omit",
      headers: {
        "Accept": "text/html,application/xhtml+xml",
        ...(options.headers || {})
      }
    });

    if (!response.ok) {
      return { response, html: null };
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      return { response, html: null };
    }

    return {
      response,
      html: await response.text()
    };
  } catch {
    return { response: null, html: null };
  }
}

function findSearchInput(doc) {
  return [...doc.querySelectorAll("input")].find((input) => {
    const haystack = [
      input.getAttribute("placeholder"),
      input.getAttribute("aria-label"),
      input.getAttribute("name"),
      input.id
    ].filter(Boolean).join(" ");

    return /codice\s*fiscale|p\.?\s*iva|partita\s*iva|nome\s*azienda/i.test(haystack);
  }) || null;
}

function findCompanyHrefForVat(doc, vat, baseUrl) {
  for (const anchor of doc.querySelectorAll("a[href]")) {
    const container =
      anchor.closest("tr, li, article, [role='option'], [role='row']") ||
      anchor.parentElement;

    const text = clean(container?.textContent || "");
    if (!text.includes(vat)) continue;

    try {
      const url = new URL(anchor.getAttribute("href") || "", baseUrl);
      if (url.origin !== BASE_URL) continue;
      if (url.pathname === "/" || url.pathname.startsWith("/b/")) continue;
      return url.href;
    } catch {
      // Ignore malformed links.
    }
  }

  return null;
}

async function findXrayCompanyViaPublicSearch(vat) {
  const searchKey = `xray:v1:vat-search:${vat}`;
  const cached = await readCache(searchKey);
  if (cached) return cached;

  const home = await fetchHtml(`${BASE_URL}/`);
  if (!home.html) return null;

  const doc = new DOMParser().parseFromString(home.html, "text/html");
  const input = findSearchInput(doc);
  const form = input?.closest("form");

  if (!input || !form || !input.name) return null;

  const params = new URLSearchParams();

  for (const field of form.querySelectorAll("input[name], select[name], textarea[name]")) {
    if (field === input) continue;
    if (field.disabled) continue;

    const type = String(field.getAttribute("type") || "").toLowerCase();
    if ((type === "checkbox" || type === "radio") && !field.checked) continue;

    if (field.name && field.value) {
      params.set(field.name, field.value);
    }
  }

  params.set(input.name, vat);

  let action;
  try {
    action = new URL(form.getAttribute("action") || "/", BASE_URL);
  } catch {
    return null;
  }

  const method = String(form.getAttribute("method") || "GET").toUpperCase();
  let result;

  if (method === "POST") {
    result = await fetchHtml(action.href, {
      method: "POST",
      body: params.toString(),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
      }
    });
  } else {
    for (const [key, value] of params.entries()) {
      action.searchParams.set(key, value);
    }
    result = await fetchHtml(action.href);
  }

  if (!result.html || !result.response) return null;

  const directCompany = parseXrayPage(
    result.html,
    result.response.url || action.href
  );

  if (directCompany?.vat === vat) {
    await writeCache(searchKey, directCompany);
    return directCompany;
  }

  const resultDoc = new DOMParser().parseFromString(result.html, "text/html");
  const href = findCompanyHrefForVat(
    resultDoc,
    vat,
    result.response.url || action.href
  );

  if (!href) return null;

  const profile = await fetchHtml(href);
  if (!profile.html || !profile.response) return null;

  const company = parseXrayPage(
    profile.html,
    profile.response.url || href
  );

  if (company?.vat !== vat) return null;

  await writeCache(searchKey, company);
  return company;
}

async function fetchSlug(slug) {
  const key = `xray:v2:slug:${slug}`;
  const cached = await readCache(key);
  if (cached !== undefined) return cached;

  const url = `${BASE_URL}/${encodeURIComponent(slug)}`;

  const result = await fetchHtml(url);

  if (!result.response?.ok) {
    // Cache only permanent misses. Transient failures (429/5xx, bot
    // challenges, etc.) must not poison the provider for 24 hours.
    if (result.response?.status === 404) {
      await writeCache(key, null);
    }
    return null;
  }

  if (!result.html) return null;

  const company = parseXrayPage(
    result.html,
    result.response.url || url
  );

  if (company) {
    await writeCache(key, company);
  }

  return company || null;
}

async function firstVatMatch(slugs, vat, { batchSize = 2 } = {}) {
  for (let i = 0; i < slugs.length; i += batchSize) {
    const batch = slugs.slice(i, i + batchSize);
    const results = await Promise.all(batch.map(fetchSlug));
    const match = results.find((company) => company?.vat === vat);
    if (match) return match;
  }

  return null;
}

export function buildXrayNumberedSlugCandidates(
  bases,
  { maxBases = 3, maxSuffix = 18 } = {}
) {
  const numbered = [];

  for (const base of (bases || []).slice(0, maxBases)) {
    for (let suffix = 1; suffix <= maxSuffix; suffix += 1) {
      numbered.push(`${base}-${suffix}`);
    }
  }

  return numbered;
}

export async function findXrayCompanyByVat(vat, { names = [] } = {}) {
  const targetVat = String(vat || "").replace(/\D/g, "");
  if (!/^\d{11}$/.test(targetVat)) return null;

  const bases = buildXraySlugCandidates(names);
  if (!bases.length) return null;

  // Keep speculative slug traffic small. Xray can throttle bursts of misses.
  const direct = await firstVatMatch(
    bases.slice(0, 4),
    targetVat,
    { batchSize: 2 }
  );
  if (direct) return direct;

  // Prefer Xray's own public search when the homepage exposes a normal form.
  // This resolves disambiguated profiles such as rubino-s-r-l-15 without
  // probing many nonexistent URLs first.
  const searched = await findXrayCompanyViaPublicSearch(targetVat);
  if (searched) return searched;

  // Final fallback for sites where the public search is JavaScript-only.
  // Probe one legal-name base at a time with low concurrency to avoid
  // triggering throttling before reaching the correct numeric suffix.
  for (const base of bases.slice(0, 3)) {
    const numbered = buildXrayNumberedSlugCandidates(
      [base],
      { maxBases: 1 }
    );

    const match = await firstVatMatch(
      numbered,
      targetVat,
      { batchSize: 2 }
    );

    if (match) return match;
  }

  return null;
}
