// Aziende.it (www.aziende.it) public-data enrichment provider.
//
// Only public pages are read:
//   1. GET /search?q=<VAT> resolves the company profile slug;
//   2. at most MAX_PROFILE_FETCHES same-origin profile GETs confirm the exact
//      VAT and read the "Confronto di settore" benchmark.
//
// Candidate URLs come from the search result table alone: no slug is guessed
// from a company name, so a wrong search never multiplies speculative requests.
//
// The module runs in the popup, where DOMParser exists (the background worker
// has no DOM). readMarkup() prefers DOMParser and falls back to a small
// dependency-free markup reader so the module also works - and stays testable
// without a DOM - where DOMParser is missing.

const BASE_URL = "https://www.aziende.it";
const SEARCH_PATH = "/search";
const PROVIDER_NAME = "Aziende.it";

const RESULT_TTL_MS = 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 10 * 60 * 1000;
const COOLDOWN_TTL_MS = 60 * 60 * 1000;

const RESULT_KEY_PREFIX = "aziende:v1:vat:";
const COOLDOWN_KEY = "aziende:v1:cooldown";

const MAX_PROFILE_FETCHES = 3;

// Single lowercase path segment, e.g. /mediane-italia-s-r-l-socio-unico.
const PROFILE_PATH_PATTERN = /^\/[a-z0-9][a-z0-9-]{2,119}$/;

// Static pages that share the profile path shape but are not companies.
const RESERVED_PATHS = new Set([
  "about",
  "aziende",
  "blog",
  "categorie",
  "chi-siamo",
  "classifica",
  "codice-sdi",
  "contatti",
  "fatturato",
  "faq",
  "login",
  "prezzi",
  "privacy",
  "registrati",
  "search",
  "servizi",
  "termini"
]);

// Dynamic variants of those pages, e.g. /fascia-3.
const RESERVED_PATH_PATTERN = /^fascia-\d+$/;

// Anti-bot / challenge / block markers. A response matching one of these is
// never retried and puts the provider in a temporary cooldown.
const CHALLENGE_PATTERN =
  /(?:just a moment|cf-(?:browser-verification|challenge)|checking your browser|attention required|access denied|you have been blocked|request blocked|richiesta bloccata|accesso negato|unusual traffic|captcha|are you a robot|security checkpoint|enable javascript and cookies)/i;

const ENTITIES = {
  amp: "&",
  apos: "'",
  agrave: "à",
  deg: "°",
  egrave: "è",
  eacute: "é",
  euro: "€",
  gt: ">",
  hellip: "…",
  igrave: "ì",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  middot: "·",
  nbsp: " ",
  ndash: "–",
  ograve: "ò",
  quot: '"',
  rdquo: "”",
  reg: "®",
  rsquo: "’",
  ugrave: "ù"
};

// "Il fatturato di <name> (<revenue>) è inferiore/superiore alla mediana ...
//  (<median>), calcolata su <N> imprese."
const SECTOR_SENTENCE_PATTERN =
  /Il\s+fatturato\s+di\s+[^(]{1,200}?\(\s*([^()]{1,60}?)\s*\)\s*(?:è|e['’])\s*(?:inferiore|superiore)\s+(?:alla|al)\s+mediana\b([^(]{0,220}?)\(\s*([^()]{1,60}?)\s*\)([^()]{0,180})/i;

const inFlight = new Map();

function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function normalizeLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(clean)
    .filter(Boolean);
}

function decodeEntities(value) {
  return String(value || "").replace(
    /&(#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi,
    (match, entity) => {
      if (entity[0] === "#") {
        const hex = entity[1]?.toLowerCase() === "x";
        const code = parseInt(hex ? entity.slice(2) : entity.slice(1), hex ? 16 : 10);
        if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return match;
        return String.fromCodePoint(code);
      }

      return ENTITIES[entity] ?? ENTITIES[entity.toLowerCase()] ?? match;
    }
  );
}

// Italian amounts accept "." and "," separators. When both are present the
// last one is the decimal separator; a single separator followed by exactly
// three digits is read as a thousands separator ("191.540" -> 191540).
export function parseItalianNumber(value) {
  let raw = String(value ?? "").replace(/[^0-9,.-]/g, "");
  if (!/\d/.test(raw)) return null;

  const negative = raw.startsWith("-");
  raw = raw.replace(/-/g, "");

  const lastComma = raw.lastIndexOf(",");
  const lastDot = raw.lastIndexOf(".");
  let normalized = raw;

  if (lastComma >= 0 && lastDot >= 0) {
    normalized = lastComma > lastDot
      ? raw.replace(/\./g, "").replace(",", ".")
      : raw.replace(/,/g, "");
  } else if (lastComma >= 0) {
    normalized = /^\d{1,3}(?:,\d{3})+$/.test(raw)
      ? raw.replace(/,/g, "")
      : raw.replace(",", ".");
  } else if (lastDot >= 0) {
    normalized = /^\d{1,3}(?:\.\d{3})+$/.test(raw)
      ? raw.replace(/\./g, "")
      : raw;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

// Money tokens must carry a currency marker, so a bare year ("Fatturato 2024")
// can never be mistaken for an amount.
function parseMoneyToken(value) {
  const text = clean(value);
  if (!text) return null;

  const match =
    text.match(/€\s*(\d[\d.,]*)/) ||
    text.match(/(\d[\d.,]*)\s*(?:euro|EUR)\b/i) ||
    text.match(/(\d[\d.,]*)\s*€/);

  return match ? parseItalianNumber(match[1]) : null;
}

function normalizeProvince(value) {
  const token = clean(value).replace(/[.,;]+$/, "");
  if (!token) return null;
  return /^[a-z]{2}$/i.test(token) ? token.toUpperCase() : token;
}

// Year-labelled annual revenue, e.g. the profile KPI "€ 191.540" +
// "Fatturato 2024" (value line before the label) or "Fatturato 2024\n€ 191.540".
export function extractAnnualRevenues(text) {
  const lines = normalizeLines(text);
  const byYear = new Map();

  for (let index = 0; index < lines.length; index += 1) {
    const label = lines[index].match(/Fatturato\s*\(?\s*(20\d{2})\s*\)?/i);
    if (!label) continue;

    const year = Number(label[1]);
    if (byYear.has(year)) continue;

    const inline = lines[index].replace(/Fatturato\s*\(?\s*20\d{2}\s*\)?/i, " ");
    const revenue = parseMoneyToken(inline) ??
      parseMoneyToken(lines[index - 1]) ??
      parseMoneyToken(lines[index + 1]);

    if (revenue === null) continue;
    byYear.set(year, { year, revenue });
  }

  return [...byYear.values()].sort((a, b) => b.year - a.year);
}

// Benchmark sentence of the "Confronto di settore" box. Returns the paired
// figures only: the year is reported only when the sentence itself labels it.
export function parseSectorBenchmark(text) {
  const match = SECTOR_SENTENCE_PATTERN.exec(clean(text));
  if (!match) return null;

  const companyRevenue = parseMoneyToken(match[1]);
  const medianRevenue = parseMoneyToken(match[3]);
  if (companyRevenue === null || medianRevenue === null) return null;

  const middle = match[2] || "";
  const trailing = match[4] || "";

  const provinceMatch =
    middle.match(/(?:in|nella)\s+provincia\s+di\s+([A-Z]{2})\b/) ||
    middle.match(/(?:in|nella)\s+provincia\s+di\s+([A-Za-zÀ-ÖØ-öø-ÿ']{3,30})/i);

  const sampleMatch = `${middle} ${trailing}`.match(
    /calcolata\s+su\s+([\d.,]+)\s+imprese/i
  );

  const yearMatch = `${match[1]} ${middle}`.match(
    /(?:fatturato|bilancio|esercizio|anno|nel)\s*(?:del\s*)?(20\d{2})/i
  );

  return {
    companyRevenue,
    medianRevenue,
    province: provinceMatch ? normalizeProvince(provinceMatch[1]) : null,
    sampleSize: sampleMatch ? parseItalianNumber(sampleMatch[1]) : null,
    year: yearMatch ? Number(yearMatch[1]) : null
  };
}

// differencePct is signed against the sector median and is only computed once
// the benchmark figure is tied to a year: either a year labelled inside the
// benchmark sentence or a year-labelled annual revenue with the same amount.
// Otherwise the year stays null and no percentage is fabricated.
function buildSectorComparison(benchmark, annualRevenues, sourceUrl) {
  if (!benchmark) return null;

  const { companyRevenue, medianRevenue, province, sampleSize } = benchmark;
  if (!Number.isFinite(companyRevenue) || !Number.isFinite(medianRevenue)) {
    return null;
  }

  const tiedYear = Number.isFinite(benchmark.year)
    ? benchmark.year
    : annualRevenues.find((row) => row.revenue === companyRevenue)?.year ?? null;

  const differencePct =
    Number.isFinite(tiedYear) && medianRevenue > 0
      ? Math.round(((companyRevenue - medianRevenue) / medianRevenue) * 10000) / 100
      : null;

  return {
    companyRevenue,
    medianRevenue,
    year: Number.isFinite(tiedYear) ? tiedYear : null,
    province: province || null,
    sampleSize: Number.isFinite(sampleSize) ? sampleSize : null,
    differencePct,
    sourceName: PROVIDER_NAME,
    sourceUrl: sourceUrl || null
  };
}

function inferProfileVat(title, text) {
  for (const source of [title, text]) {
    const match = String(source || "").match(
      /(?:P\.?\s*IVA|Partita\s+IVA)\s*[.:#-]?\s*(\d{11})(?!\d)/i
    );
    if (match) return match[1];
  }

  return null;
}

function inferNameFromTitle(title) {
  const value = clean(title).split(/\s+[-–|]\s+P\.?\s*IVA/i)[0];
  return clean(value) || null;
}

export function parseAziendeProfileText(
  text,
  { name = null, title = null, url = null, benchmarkText = null } = {}
) {
  const body = String(text || "");
  const vat = inferProfileVat(title, body);
  if (!vat) return null;

  const benchmark = parseSectorBenchmark(benchmarkText || body);

  return {
    provider: PROVIDER_NAME,
    providerUrl: url || null,
    name: clean(name) || inferNameFromTitle(title) || null,
    vat,
    sectorComparison: buildSectorComparison(
      benchmark,
      extractAnnualRevenues(body),
      url
    )
  };
}

function htmlToText(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(
        /<\/(?:p|div|li|tr|td|th|h[1-6]|section|article|header|footer|main|nav|aside|dl|dt|dd|table|thead|tbody|ul|ol)>/gi,
        "\n"
      )
      .replace(/<[^>]+>/g, "")
  );
}

function tagText(html, tag) {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i")
    .exec(String(html || ""));
  return match ? clean(htmlToText(match[1])) : "";
}

function sliceFrom(source, pattern, length = 2500, endToken = null) {
  const text = String(source || "");
  const match = pattern.exec(text);
  if (!match) return "";

  if (!endToken) return text.slice(match.index, match.index + length);

  const end = text.indexOf(endToken, match.index);
  return text.slice(match.index, end === -1 ? match.index + length : end);
}

function anchorHrefs(source, className = null) {
  const classPattern = className
    ? new RegExp(`class\\s*=\\s*["'][^"']*\\b${className}\\b`, "i")
    : null;
  const hrefs = [];

  for (const match of String(source || "").matchAll(/<a\b([^>]*)>/gi)) {
    const attributes = match[1] || "";
    if (classPattern && !classPattern.test(attributes)) continue;

    const href = attributes.match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
    if (href) hrefs.push(decodeEntities(href));
  }

  return hrefs;
}

// Search results live in a.rg-co anchors inside table.rg-reg. The table scan
// is a structural hedge in case the anchor class is renamed.
function readMarkup(source) {
  const html = String(source || "");

  if (typeof globalThis.DOMParser === "function") {
    try {
      const doc = new globalThis.DOMParser().parseFromString(html, "text/html");
      const links = [
        ...doc.querySelectorAll("a.rg-co[href], table.rg-reg a[href]")
      ]
        .map((node) => node.getAttribute?.("href") || node.href || "")
        .filter(Boolean);

      return {
        links,
        title: clean(doc.title || ""),
        name: clean(doc.querySelector("h1")?.textContent || "") || null,
        text: String(doc.body?.innerText || doc.body?.textContent || ""),
        benchmarkText:
          clean(doc.querySelector("#benchmark-settore")?.textContent || "") || null
      };
    } catch {
      // Fall through to the markup reader below.
    }
  }

  const body = html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, " ");
  const table = sliceFrom(
    html,
    /<table\b[^>]*\brg-reg\b[^>]*>/i,
    8000,
    "</table>"
  );
  const benchmarkSection = sliceFrom(html, /id\s*=\s*["']benchmark-settore["']/i);

  return {
    links: [...anchorHrefs(html, "rg-co"), ...anchorHrefs(table)],
    title: tagText(html, "title"),
    name: tagText(body, "h1") || null,
    text: htmlToText(body),
    benchmarkText: benchmarkSection ? htmlToText(benchmarkSection) : null
  };
}

// Same-origin, single-segment, non-reserved profile URLs, in page order.
function profileCandidates(links, baseUrl) {
  let base;
  try {
    base = new URL(baseUrl || BASE_URL);
  } catch {
    return [];
  }

  const seen = new Set();
  const result = [];

  for (const href of Array.isArray(links) ? links : []) {
    let url;
    try {
      url = new URL(String(href || ""), base);
    } catch {
      continue;
    }

    if (url.origin !== base.origin) continue;

    const path = url.pathname.replace(/\/+$/, "");
    if (!PROFILE_PATH_PATTERN.test(path)) continue;

    const segment = path.slice(1);
    if (RESERVED_PATHS.has(segment)) continue;
    if (RESERVED_PATH_PATTERN.test(segment)) continue;
    if (seen.has(path)) continue;

    seen.add(path);
    result.push(`${base.origin}${path}`);
  }

  return result;
}

export function parseAziendeSearchResults(html, baseUrl = BASE_URL) {
  return profileCandidates(readMarkup(html).links, baseUrl);
}

export function shouldCacheAziendeMiss(status) {
  const value = Number(status);
  return value === 404 || value === 410;
}

export function isAziendeChallenge(status, body) {
  const value = Number(status);
  if (value === 403 || value === 429) return true;
  return CHALLENGE_PATTERN.test(String(body || "").slice(0, 8000));
}

function storageLocal() {
  const api = globalThis.browser ?? globalThis.chrome;
  return api?.storage?.local ?? null;
}

async function readEntry(key) {
  const local = storageLocal();
  if (!local) return undefined;

  try {
    const stored = await local.get(key);
    return stored?.[key] ?? undefined;
  } catch {
    return undefined;
  }
}

async function writeEntry(key, value) {
  const local = storageLocal();
  if (!local) return;

  try {
    await local.set({ [key]: { cachedAt: Date.now(), value } });
  } catch {
    // Cache is optional.
  }
}

// A cached null is a durable miss with a short TTL; a cached record keeps the
// full positive TTL.
async function readResult(key) {
  const entry = await readEntry(key);
  if (!entry) return undefined;

  const age = Date.now() - Number(entry.cachedAt || 0);
  const ttl = entry.value === null ? MISS_TTL_MS : RESULT_TTL_MS;
  if (!(age >= 0 && age <= ttl)) return undefined;

  return entry.value;
}

async function isCoolingDown() {
  const entry = await readEntry(COOLDOWN_KEY);
  return Date.now() < Number(entry?.value?.until || 0);
}

async function startCooldown() {
  await writeEntry(COOLDOWN_KEY, { until: Date.now() + COOLDOWN_TTL_MS });
}

async function requestHtml(url) {
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    credentials: "omit",
    headers: { Accept: "text/html,application/xhtml+xml" }
  });

  let body = "";
  try {
    body = await response.text();
  } catch {
    body = "";
  }

  return {
    status: Number(response?.status || 0),
    ok: Boolean(response?.ok),
    url: response?.url || url,
    contentType: response?.headers?.get?.("content-type") || "",
    body
  };
}

async function lookupByVat(targetVat, nameHint) {
  const key = `${RESULT_KEY_PREFIX}${targetVat}`;

  const cached = await readResult(key);
  if (cached !== undefined) return cached;

  if (await isCoolingDown()) return null;

  const searchUrl = `${BASE_URL}${SEARCH_PATH}?q=${encodeURIComponent(targetVat)}`;
  const search = await requestHtml(searchUrl);

  // 403/429/challenge/block: stop immediately, no retries, temporary cooldown.
  if (isAziendeChallenge(search.status, search.body)) {
    await startCooldown();
    return null;
  }

  if (!search.ok) {
    if (shouldCacheAziendeMiss(search.status)) await writeEntry(key, null);
    return null;
  }

  if (!/text\/html/i.test(search.contentType)) return null;

  const candidates = profileCandidates(readMarkup(search.body).links, searchUrl);

  if (!candidates.length) {
    await writeEntry(key, null);
    return null;
  }

  let transientFailure = false;
  for (const candidate of candidates.slice(0, MAX_PROFILE_FETCHES)) {
    const profile = await requestHtml(candidate);

    if (isAziendeChallenge(profile.status, profile.body)) {
      await startCooldown();
      return null;
    }

    if (profile.url !== candidate) {
      transientFailure = true;
      continue;
    }
    if (!profile.ok) {
      if (!shouldCacheAziendeMiss(profile.status)) transientFailure = true;
      continue;
    }

    const markup = readMarkup(profile.body);
    const company = parseAziendeProfileText(markup.text, {
      name: markup.name || nameHint,
      title: markup.title,
      url: profile.url || candidate,
      benchmarkText: markup.benchmarkText
    });

    // The search result text is never trusted for the VAT: the profile itself
    // must carry the exact 11 digits we are looking for.
    if (!company || company.vat !== targetVat) continue;

    await writeEntry(key, company);
    return company;
  }

  if (!transientFailure) await writeEntry(key, null);
  return null;
}

function runLookup(targetVat, nameHint) {
  const pending = lookupByVat(targetVat, nameHint)
    .catch(() => null)
    .finally(() => {
      inFlight.delete(targetVat);
    });

  inFlight.set(targetVat, pending);
  return pending;
}

// Public entry point. `options.names` is only a last-resort label fallback:
// the lookup is VAT-driven and every hint (province/city) is ignored on
// purpose, so no speculative request is ever issued.
export function findAziendeCompanyByVat(vat, options = {}) {
  const targetVat = String(vat ?? "").replace(/\D/g, "");
  if (!/^\d{11}$/.test(targetVat)) return Promise.resolve(null);

  const nameHint = Array.isArray(options?.names)
    ? clean(options.names[0]) || null
    : null;

  const existing = inFlight.get(targetVat);
  if (existing) return existing;

  return runLookup(targetVat, nameHint);
}
