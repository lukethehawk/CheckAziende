import { slugifyCompanyName } from "./aziende.js";

const BASE_URL = "https://registroaziende.it/azienda";
const SEARCH_URL = "https://registroaziende.it/ricerca";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const SEARCH_CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_CANDIDATES = 24;
const api = globalThis.browser ?? globalThis.chrome;

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function parseItalianNumber(value) {
  const raw = String(value || "").replace(/[^0-9,.-]/g, "").trim();
  if (!raw) return null;

  let normalized = raw;
  if (normalized.includes(",")) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  } else {
    normalized = normalized.replace(/\./g, "");
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseMoney(value) {
  return parseItalianNumber(value);
}

function normalizeLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map(clean)
    .filter(Boolean);
}

function findLabelValue(lines, label) {
  const target = String(label || "").toLowerCase();

  for (let i = 0; i < lines.length; i += 1) {
    const lower = lines[i].toLowerCase();

    if (lower === target) return lines[i + 1] || null;
    if (lower.startsWith(target + " ")) {
      const value = clean(lines[i].slice(label.length));
      if (value) return value;
    }
  }

  return null;
}

function normalizeCompanySlug(value) {
  return slugifyCompanyName(value)
    .replace(/-s-r-l(?:-s)?$/, (match) => match === "-s-r-l-s" ? "-srls" : "-srl")
    .replace(/-s-p-a$/, "-spa")
    .replace(/-societa-per-azioni$/, "-spa")
    .replace(/-societa-a-responsabilita-limitata$/, "-srl")
    .replace(/-societa-a-responsabilita-limitata-semplificata$/, "-srls");
}

function normalizeCitySlug(value) {
  return slugifyCompanyName(value)
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

export function buildRegistroSlugCandidates(names, cityHints = []) {
  const bases = unique(
    names
      .map(normalizeCompanySlug)
      .filter((value) => value && value.length >= 3)
  ).slice(0, 8);

  const cities = unique(
    cityHints
      .map(normalizeCitySlug)
      .filter((value) => value && value.length >= 2)
  ).slice(0, 4);

  const result = [];

  for (const base of bases) {
    for (const city of cities) result.push(`${base}-${city}`);
    result.push(base);
  }

  return unique(result).slice(0, MAX_CANDIDATES);
}

function parseHistoryFromLines(lines) {
  const history = [];

  for (let i = 0; i < lines.length; i += 1) {
    const year = lines[i].match(/^(20\d{2})$/)?.[1];
    if (!year) continue;

    const row = [];
    for (let j = i + 1; j < Math.min(lines.length, i + 5); j += 1) {
      if (/^20\d{2}$/.test(lines[j])) break;
      row.push(lines[j]);
    }

    const money = row
      .filter((value) => /€/.test(value))
      .map(parseMoney)
      .filter(Number.isFinite);

    // Historical rows contain both turnover and profit/loss. Summary blocks
    // above the table may also contain a year and one monetary value.
    if (money.length < 2) continue;

    history.push({
      year: Number(year),
      revenue: money[0] ?? null,
      profit: money[1] ?? null,
      source: "RegistroAziende.it",
      isFiled: true
    });
  }

  const byYear = new Map();
  for (const item of history) {
    if (!byYear.has(item.year)) byYear.set(item.year, item);
  }

  return [...byYear.values()]
    .sort((a, b) => b.year - a.year)
    .slice(0, 3);
}

function parseHistoryFromInlineText(text) {
  const source = clean(text);
  const history = [];
  const pattern = /\b(20\d{2})\b\s+€\s*([0-9][0-9.,]*)\s+€\s*(-?[0-9][0-9.,]*)/g;

  let match;
  while ((match = pattern.exec(source)) !== null) {
    const year = Number(match[1]);
    const revenue = parseMoney(match[2]);
    const profit = parseMoney(match[3]);

    if (!Number.isFinite(revenue) || !Number.isFinite(profit)) continue;

    history.push({
      year,
      revenue,
      profit,
      source: "RegistroAziende.it",
      isFiled: true
    });
  }

  const byYear = new Map();
  for (const item of history) {
    if (!byYear.has(item.year)) byYear.set(item.year, item);
  }

  return [...byYear.values()]
    .sort((a, b) => b.year - a.year)
    .slice(0, 3);
}

export function parseRegistroAziendeText(text, { url = null } = {}) {
  const source = String(text || "");
  const lines = normalizeLines(source);

  const heading = source.match(
    /Dati\s+aziendali:\s*(.+?),\s*P\.IVA\s*(\d{11})/i
  );

  const vat =
    heading?.[2] ||
    source.match(/\bP\.IVA\s*\|?\s*(\d{11})\b/i)?.[1] ||
    source.match(/\bP\.IVA\s+(\d{11})\b/i)?.[1];

  if (!vat) return null;

  const name =
    clean(heading?.[1]) ||
    clean(findLabelValue(lines, "Ragione sociale"));

  const status = clean(findLabelValue(lines, "Stato"));
  const city = clean(findLabelValue(lines, "Città"));
  const address = clean(findLabelValue(lines, "Indirizzo"));
  const province = clean(findLabelValue(lines, "Provincia"));
  const region = clean(findLabelValue(lines, "Regione"));
  const employees = clean(findLabelValue(lines, "Dipendenti"));

  const atecoMatch = source.match(
    /Codice\s+ATECO\s+(?:20\d{2}\s+)?([0-9]{2}(?:\.[0-9]{1,2}){1,3})\s*:\s*([^\n]+)/i
  );

  const revenueSection = source.match(
    /€\s*([0-9.,]+)\s*(B|M|K)?\s*Fatturato\s*(20\d{2})/i
  );
  const profitSection = source.match(
    /€\s*([0-9.,]+)\s*(B|M|K)?\s*Utile\/Perdita\s*(20\d{2})/i
  );

  function scaledMoney(match) {
    if (!match) return null;
    const number = Number(String(match[1]).replace(",", "."));
    if (!Number.isFinite(number)) return null;
    const suffix = String(match[2] || "").toUpperCase();
    if (suffix === "B") return number * 1_000_000_000;
    if (suffix === "M") return number * 1_000_000;
    if (suffix === "K") return number * 1_000;
    return number;
  }

  const revenueValue = scaledMoney(revenueSection);
  const profitValue = scaledMoney(profitSection);
  const history = parseHistoryFromLines(lines);
  const inlineHistory = parseHistoryFromInlineText(source);
  const mergedHistory = mergeHistoryRows(history, inlineHistory);

  return {
    provider: "RegistroAziende.it",
    providerUrl: url,
    name: name || null,
    vat,
    status: status || null,
    city: city || null,
    province: province || null,
    region: region || null,
    address: address || null,
    ateco: atecoMatch
      ? {
          code: atecoMatch[1],
          description: clean(atecoMatch[2])
        }
      : null,
    financials: {
      revenue: Number.isFinite(revenueValue)
        ? {
            value: revenueValue,
            year: Number(revenueSection?.[3]) || null,
            source: "RegistroAziende.it",
            isFiled: true
          }
        : mergedHistory[0]?.revenue
          ? {
              value: mergedHistory[0].revenue,
              year: mergedHistory[0].year,
              source: "RegistroAziende.it",
              isFiled: true
            }
          : null,
      profit: Number.isFinite(profitValue)
        ? {
            value: profitValue,
            year: Number(profitSection?.[3]) || null,
            source: "RegistroAziende.it",
            isFiled: true
          }
        : mergedHistory[0]?.profit
          ? {
              value: mergedHistory[0].profit,
              year: mergedHistory[0].year,
              source: "RegistroAziende.it",
              isFiled: true
            }
          : null,
      employees: employees
        ? { value: null, display: employees, year: null }
        : null,
      balanceHistory: mergedHistory
    }
  };
}

function parseHistoryFromDocument(doc) {
  for (const table of doc.querySelectorAll("table")) {
    const headers = [...table.querySelectorAll("th")].map((cell) =>
      clean(cell.textContent).toLowerCase()
    );

    if (!headers.some((value) => value.includes("fatturato")) ||
        !headers.some((value) => /utile|perdita/.test(value))) {
      continue;
    }

    const history = [];

    for (const row of table.querySelectorAll("tr")) {
      const cells = [...row.querySelectorAll("td")].map((cell) =>
        clean(cell.textContent)
      );
      if (cells.length < 3) continue;

      const year = cells[0].match(/^(20\d{2})$/)?.[1];
      if (!year) continue;

      const revenue = /accedi/i.test(cells[1]) ? null : parseMoney(cells[1]);
      const profit = /accedi/i.test(cells[2]) ? null : parseMoney(cells[2]);

      if (!Number.isFinite(revenue) && !Number.isFinite(profit)) continue;

      history.push({
        year: Number(year),
        revenue: Number.isFinite(revenue) ? revenue : null,
        profit: Number.isFinite(profit) ? profit : null,
        source: "RegistroAziende.it",
        isFiled: true
      });
    }

    if (history.length) {
      return history.sort((a, b) => b.year - a.year).slice(0, 3);
    }
  }

  return [];
}

function mergeHistoryRows(primary, fallback) {
  const byYear = new Map();

  const mergeOne = (item, preferExisting = false) => {
    const year = Number(item?.year);
    if (!Number.isFinite(year)) return;

    const previous = byYear.get(year);
    if (!previous) {
      byYear.set(year, { ...item, year });
      return;
    }

    const preferred = preferExisting ? previous : item;
    const secondary = preferExisting ? item : previous;
    const sources = [...new Set([
      ...(Array.isArray(previous.sources) ? previous.sources : []),
      previous.source,
      ...(Array.isArray(item.sources) ? item.sources : []),
      item.source
    ].filter(Boolean))];

    byYear.set(year, {
      ...secondary,
      ...Object.fromEntries(
        Object.entries(preferred).filter(([, value]) => value !== null && value !== undefined)
      ),
      year,
      sources,
      source: preferred.source || secondary.source || null,
      isFiled: Boolean(previous.isFiled || item.isFiled)
    });
  };

  for (const item of Array.isArray(primary) ? primary : []) {
    mergeOne(item, false);
  }
  for (const item of Array.isArray(fallback) ? fallback : []) {
    mergeOne(item, true);
  }

  return [...byYear.values()]
    .sort((a, b) => b.year - a.year)
    .slice(0, 3);
}

export function parseRegistroAziendePage(html, url) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const text = doc.body?.innerText || doc.body?.textContent || "";
  const company = parseRegistroAziendeText(text, { url });

  if (!company) return null;

  const domHistory = parseHistoryFromDocument(doc);
  if (domHistory.length) {
    company.financials.balanceHistory = mergeHistoryRows(
      company.financials.balanceHistory,
      domHistory
    );

    const latest = company.financials.balanceHistory[0];
    if (!Number.isFinite(company.financials.revenue?.value) &&
        Number.isFinite(latest.revenue)) {
      company.financials.revenue = {
        value: latest.revenue,
        year: latest.year,
        source: "RegistroAziende.it",
        isFiled: true
      };
    }

    if (!Number.isFinite(company.financials.profit?.value) &&
        Number.isFinite(latest.profit)) {
      company.financials.profit = {
        value: latest.profit,
        year: latest.year,
        source: "RegistroAziende.it",
        isFiled: true
      };
    }
  }

  return company;
}

async function readCache(key, ttlMs = CACHE_TTL_MS) {
  try {
    const stored = await api.storage.local.get(key);
    const entry = stored?.[key];
    if (!entry || Date.now() - entry.cachedAt > ttlMs) return undefined;
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
  const key = `registro:v3:${slug}`;
  const cached = await readCache(key);
  if (cached !== undefined) return cached;

  const url = `${BASE_URL}/${encodeURIComponent(slug)}`;

  try {
    const response = await fetch(url, {
      credentials: "omit",
      redirect: "follow",
      headers: { Accept: "text/html,application/xhtml+xml" }
    });

    if (!response.ok) {
      await writeCache(key, null);
      return null;
    }

    const html = await response.text();
    const company = parseRegistroAziendePage(html, response.url || url);
    await writeCache(key, company || null);
    return company || null;
  } catch {
    return null;
  }
}

async function fetchCandidates(slugs) {
  const companies = [];
  const byVat = new Map();

  for (let i = 0; i < slugs.length; i += 4) {
    const batch = slugs.slice(i, i + 4);
    const results = await Promise.all(batch.map(fetchSlug));

    for (const company of results) {
      if (!company?.vat || byVat.has(company.vat)) continue;
      byVat.set(company.vat, company);
      companies.push(company);
    }
  }

  return companies;
}

export function parseRegistroAziendeSearchRows(
  rows,
  { baseUrl = SEARCH_URL } = {}
) {
  const companies = [];
  const byVat = new Set();

  for (const row of Array.isArray(rows) ? rows : []) {
    const cells = (row?.cells || []).map(clean).filter(Boolean);
    const joined = cells.join(" ");
    const vat =
      clean(row?.vat) ||
      joined.match(/\b(\d{11})\b/)?.[1] ||
      null;

    if (!/^\d{11}$/.test(vat || "") || byVat.has(vat)) continue;

    const name = clean(row?.name || cells[0]);
    if (!name) continue;

    const location = clean(row?.location || cells[1]);
    const locationParts = location
      .split(",")
      .map(clean)
      .filter(Boolean);

    let providerUrl = null;
    const href = clean(row?.href);
    if (href) {
      try {
        providerUrl = new URL(href, baseUrl).href;
      } catch {
        providerUrl = null;
      }
    }

    byVat.add(vat);
    companies.push({
      provider: "RegistroAziende.it",
      providerUrl,
      name,
      vat,
      city: locationParts[0] || null,
      province: locationParts[1] || null,
      address: null,
      financials: {}
    });
  }

  return companies.slice(0, 5);
}

export function parseRegistroAziendeSearchPage(html, url = SEARCH_URL) {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const rows = [...doc.querySelectorAll("tr")].map((row) => {
    const cells = [...row.querySelectorAll("td")].map((cell) =>
      clean(cell.textContent)
    );
    const anchor = row.querySelector('a[href*="/azienda/"]');

    return {
      cells,
      name: clean(anchor?.textContent || cells[0]),
      href: anchor?.getAttribute("href") || "",
      location: cells[1] || "",
      vat: cells.find((value) => /^\d{11}$/.test(value)) || ""
    };
  });

  return parseRegistroAziendeSearchRows(rows, { baseUrl: url });
}

export async function findRegistroAziendeCompaniesByName(query) {
  const normalizedQuery = clean(query);
  if (normalizedQuery.length < 4) return [];

  const cacheKey =
    `registro:manual-search:v1:${normalizedQuery.toLowerCase()}`;
  const cached = await readCache(cacheKey, SEARCH_CACHE_TTL_MS);
  if (cached !== undefined) return cached;

  const url = `${SEARCH_URL}?q=${encodeURIComponent(normalizedQuery)}`;

  try {
    const response = await fetch(url, {
      credentials: "omit",
      redirect: "follow",
      headers: { Accept: "text/html,application/xhtml+xml" }
    });

    if (!response.ok) return [];

    const html = await response.text();
    const companies = parseRegistroAziendeSearchPage(
      html,
      response.url || url
    );

    await writeCache(cacheKey, companies);
    return companies;
  } catch {
    return [];
  }
}


export async function findRegistroAziendeCompaniesByContext({
  names = [],
  cityHints = []
} = {}) {
  if (!names?.length) return [];

  return fetchCandidates(
    buildRegistroSlugCandidates(names, cityHints)
  );
}

export async function findRegistroAziendeCompanyByVat(
  vat,
  { names = [], cityHints = [] } = {}
) {
  const targetVat = String(vat || "").replace(/\D/g, "");
  if (!/^\d{11}$/.test(targetVat)) return null;

  const slugs = buildRegistroSlugCandidates(names, cityHints);

  for (let i = 0; i < slugs.length; i += 4) {
    const batch = slugs.slice(i, i + 4);
    const results = await Promise.all(batch.map(fetchSlug));
    const match = results.find((company) => company?.vat === targetVat);
    if (match) return match;
  }

  return null;
}
