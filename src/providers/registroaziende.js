import { slugifyCompanyName } from "./aziende.js";

const BASE_URL = "https://registroaziende.it/azienda";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
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

    if (!money.length) continue;

    history.push({
      year: Number(year),
      revenue: money[0] ?? null,
      profit: money[1] ?? null
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
    const number = Number(String(match[1]).replace(/\./g, "").replace(",", "."));
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
        ? { value: revenueValue, year: Number(revenueSection?.[3]) || null }
        : history[0]?.revenue
          ? { value: history[0].revenue, year: history[0].year }
          : null,
      profit: Number.isFinite(profitValue)
        ? { value: profitValue, year: Number(profitSection?.[3]) || null }
        : history[0]?.profit
          ? { value: history[0].profit, year: history[0].year }
          : null,
      employees: employees
        ? { value: null, display: employees, year: null }
        : null,
      balanceHistory: history
    }
  };
}

export function parseRegistroAziendePage(html, url) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const text = doc.body?.innerText || doc.body?.textContent || "";
  return parseRegistroAziendeText(text, { url });
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
  const key = `registro:v1:${slug}`;
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
