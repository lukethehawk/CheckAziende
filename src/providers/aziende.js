const BASE_URL = "https://www.aziende.it";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SLUGS = 28;
const api = globalThis.browser ?? globalThis.chrome;

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function normalizeLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => clean(line))
    .filter(Boolean);
}

function findLabelValue(lines, labels) {
  const normalizedLabels = labels.map((label) => label.toLowerCase());

  for (let i = 0; i < lines.length; i += 1) {
    const lower = lines[i].toLowerCase();
    const exactIndex = normalizedLabels.findIndex((label) => lower === label);

    if (exactIndex >= 0) {
      return lines[i + 1] || null;
    }

    for (const label of normalizedLabels) {
      if (lower.startsWith(label + " ")) {
        const value = clean(lines[i].slice(label.length));
        if (value) return value;
      }
    }
  }

  return null;
}

function parseItalianNumber(value) {
  const raw = String(value || "")
    .replace(/[^0-9,.-]/g, "")
    .trim();

  if (!raw) return null;

  let normalized = raw;
  if (normalized.includes(",")) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  } else {
    normalized = normalized.replace(/\./g, "");
  }

  const result = Number(normalized);
  return Number.isFinite(result) ? result : null;
}

function parseMoney(value) {
  return parseItalianNumber(value);
}

function findMoneyBefore(lines, labelPattern) {
  for (let i = 0; i < lines.length; i += 1) {
    if (!labelPattern.test(lines[i])) continue;

    for (let j = i - 1; j >= Math.max(0, i - 3); j -= 1) {
      if (!/€/.test(lines[j])) continue;
      const value = parseMoney(lines[j]);
      if (value !== null) return value;
    }
  }

  return null;
}

function findYearFromLine(lines, labelPattern) {
  const line = lines.find((item) => labelPattern.test(item));
  const match = line?.match(/\b(20\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function findEmployees(lines, text) {
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^dipendenti(?:\s+\d{4})?$/i.test(lines[i])) continue;

    const previous = lines[i - 1] || "";
    const exact = previous.match(/^([0-9]{1,6})$/);
    if (exact) {
      return {
        value: Number(exact[1]),
        display: exact[1],
        year: findYearFromLine([lines[i]], /dipendenti/i)
      };
    }
  }

  const rangeMatch = String(text || "").match(/\b(\d+\s*-\s*\d+)\s+dipendenti\b/i);
  if (rangeMatch) {
    return {
      value: null,
      display: rangeMatch[1].replace(/\s+/g, ""),
      year: null
    };
  }

  return null;
}

function sanitizeField(value) {
  if (!value) return null;

  return clean(value)
    .replace(/Acquista\s+(?:visura|bilancio).*$/i, "")
    .replace(/·\s*fonte\s+VIES.*$/i, "")
    .trim() || null;
}

function inferStatus(text) {
  if (/\bcessata\b/i.test(text)) return "Cessata";
  if (/\binattiva\b/i.test(text)) return "Inattiva";
  if (/\battiva\b/i.test(text)) return "Attiva";
  return null;
}

function inferVat(text) {
  const match = String(text || "").match(/(?:P\.?\s*IVA|Partita\s+IVA)\s*[:|]?\s*(\d{11})/i);
  return match?.[1] || null;
}

function inferRea(text) {
  const match = String(text || "").match(/\bREA\s*[:|]?\s*([A-Z]{2})[-\s]?([0-9]{3,})\b/i);
  return match ? `${match[1].toUpperCase()}-${match[2]}` : null;
}

function inferAteco(text, lines) {
  const summary = String(text || "").match(/\bATECO\s+([0-9]{2}(?:\.[0-9]{1,2}){1,3})\b/i);
  const code = summary?.[1] || sanitizeField(findLabelValue(lines, ["Codice Ateco"]));
  const description = sanitizeField(findLabelValue(lines, ["Attività"]));

  if (!code && !description) return null;
  return { code: code || null, description: description || null };
}

function inferRevenue(lines) {
  const value = findMoneyBefore(lines, /^Fatturato\s+20\d{2}$/i);
  const year = findYearFromLine(lines, /^Fatturato\s+20\d{2}$/i);

  if (value !== null) return { value, year };

  const tableValue = findLabelValue(lines, ["Fatturato"]);
  if (!tableValue) return null;

  const amount = parseMoney(tableValue);
  const yearMatch = tableValue.match(/\b(20\d{2})\b/);

  return amount === null ? null : {
    value: amount,
    year: yearMatch ? Number(yearMatch[1]) : null
  };
}

function inferProfit(lines) {
  const value = findMoneyBefore(lines, /^Utile\s+20\d{2}$/i);
  const year = findYearFromLine(lines, /^Utile\s+20\d{2}$/i);

  if (value !== null) return { value, year };

  const tableValue = findLabelValue(lines, ["Utile", "Utile/Perdita"]);
  if (!tableValue) return null;

  const amount = parseMoney(tableValue);
  const yearMatch = tableValue.match(/\b(20\d{2})\b/);

  return amount === null ? null : {
    value: amount,
    year: yearMatch ? Number(yearMatch[1]) : null
  };
}

function inferNetMargin(text, revenue, profit) {
  const match = String(text || "").match(/([+-]?\d+(?:[.,]\d+)?)%\s*Margine\s+netto/i);
  if (match) return Number(match[1].replace(",", "."));

  if (revenue?.value && Number.isFinite(profit?.value)) {
    return (profit.value / revenue.value) * 100;
  }

  return null;
}

function inferRevenuePerEmployee(revenue, employees) {
  if (!revenue?.value || !employees?.value) return null;
  return revenue.value / employees.value;
}

function inferAddress(lines, text) {
  const summary = String(text || "").match(/Sede\s+legale:\s*([^\n]+)/i);
  if (summary?.[1]) return sanitizeField(summary[1]);

  return sanitizeField(findLabelValue(lines, ["Sede"]));
}

export function slugifyCompanyName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function stripDescriptor(value) {
  return clean(
    String(value || "")
      .split(/\s+[|–—-]\s+/)[0]
      .replace(/\b(?:home|homepage|login|area clienti|benvenuti)\b/gi, " ")
  );
}

export function buildSlugCandidates(names) {
  const legalVariants = [
    "srl",
    "s-r-l",
    "srl-a-socio-unico",
    "srl-unipersonale",
    "spa",
    "s-p-a",
    "srls",
    "s-r-l-s",
    "snc",
    "sas",
    "inc",
    "ltd"
  ];

  const generic = new Set([
    "home",
    "homepage",
    "login",
    "welcome",
    "benvenuti",
    "area-clienti",
    "customer-area"
  ]);

  const bases = [];

  for (const raw of unique(names)) {
    for (const candidate of unique([clean(raw), stripDescriptor(raw)])) {
      const slug = slugifyCompanyName(candidate);
      if (!slug || slug.length < 3 || generic.has(slug)) continue;
      bases.push(slug);
    }
  }

  const uniqueBases = unique(bases);
  const result = [...uniqueBases];

  for (const suffix of legalVariants) {
    for (const slug of uniqueBases) {
      const hasLegalSuffix =
        /(?:^|-)(?:srl|s-r-l|spa|s-p-a|srls|s-r-l-s|snc|sas|inc|ltd)(?:$|-)/.test(slug);

      if (hasLegalSuffix) continue;
      result.push(`${slug}-${suffix}`);

      if (result.length >= MAX_SLUGS) {
        return unique(result).slice(0, MAX_SLUGS);
      }
    }
  }

  return unique(result).slice(0, MAX_SLUGS);
}

export function parseAziendeText(text, { name = null, url = null } = {}) {
  const lines = normalizeLines(text);
  const vat = inferVat(text);

  if (!vat) return null;

  const revenue = inferRevenue(lines);
  const profit = inferProfit(lines);
  const employees = findEmployees(lines, text);
  const netMargin = inferNetMargin(text, revenue, profit);

  const company = {
    provider: "Aziende.it",
    providerUrl: url || null,
    name: sanitizeField(name) || sanitizeField(findLabelValue(lines, ["Ragione Sociale"])) || null,
    vat,
    status: inferStatus(text),
    legalForm: sanitizeField(findLabelValue(lines, ["Natura Giuridica", "Forma"])),
    taxCode: sanitizeField(findLabelValue(lines, ["Codice Fiscale"])),
    rea: inferRea(text) || sanitizeField(findLabelValue(lines, ["REA"])),
    pec: sanitizeField(findLabelValue(lines, ["PEC"])),
    sdi: sanitizeField(findLabelValue(lines, ["Codice Destinatario SDI", "SDI"])),
    registrationDate: sanitizeField(findLabelValue(lines, ["Data Iscrizione", "Iscrizione"])),
    chamber: sanitizeField(findLabelValue(lines, ["Camera di Commercio"])),
    city: sanitizeField(findLabelValue(lines, ["Comune", "Città"])),
    province: sanitizeField(findLabelValue(lines, ["Provincia"])),
    region: sanitizeField(findLabelValue(lines, ["Regione"])),
    address: inferAddress(lines, text),
    ateco: inferAteco(text, lines),
    financials: {
      revenue,
      profit,
      employees,
      netMargin,
      revenuePerEmployee: inferRevenuePerEmployee(revenue, employees),
      capital: (() => {
        const value = findLabelValue(lines, ["Capitale Sociale", "Capitale sociale"]);
        const amount = parseMoney(value);
        return amount === null ? null : amount;
      })()
    }
  };

  return company;
}

export function parseAziendePage(html, url) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const h1 = clean(doc.querySelector("h1")?.textContent || "");
  const text = doc.body?.innerText || doc.body?.textContent || "";
  return parseAziendeText(text, { name: h1 || null, url });
}

async function readCache(key) {
  try {
    const stored = await api.storage.local.get(key);
    const entry = stored?.[key];
    if (!entry || Date.now() - entry.cachedAt > CACHE_TTL_MS) return null;
    return entry.value;
  } catch {
    return null;
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

async function fetchCompanySlug(slug) {
  const key = `aziende:slug:${slug}`;
  const cached = await readCache(key);
  if (cached) return cached;

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
    const company = parseAziendePage(html, response.url || url);

    if (!company?.vat) return null;

    await writeCache(key, company);
    return company;
  } catch {
    return null;
  }
}

async function fetchCandidates(slugs) {
  const uniqueSlugs = unique(slugs).slice(0, MAX_SLUGS);
  const results = [];

  for (let i = 0; i < uniqueSlugs.length; i += 4) {
    const batch = uniqueSlugs.slice(i, i + 4);
    const values = await Promise.all(batch.map((slug) => fetchCompanySlug(slug)));

    for (const value of values) {
      if (value) results.push(value);
    }
  }

  const byVat = new Map();
  for (const company of results) {
    if (!byVat.has(company.vat)) byVat.set(company.vat, company);
  }

  return [...byVat.values()];
}

export async function findAziendeCompanyByVat(vat, { names = [] } = {}) {
  const targetVat = String(vat || "").replace(/\D/g, "");
  if (!/^\d{11}$/.test(targetVat)) return null;

  const candidates = await fetchCandidates(buildSlugCandidates(names));
  return candidates.find((company) => company.vat === targetVat) || null;
}

export async function findAziendeCompaniesByContext({ names = [] } = {}) {
  if (!names?.length) return [];
  return fetchCandidates(buildSlugCandidates(names));
}
