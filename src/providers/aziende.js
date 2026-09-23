const BASE_URL = "https://www.aziende.it";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_SLUGS = 56;
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
  const match = String(value || "").match(/-?\d[\d.]*?(?:,\d+)?(?=\s*(?:€|euro|EUR|\(|$))/i) ||
    String(value || "").match(/-?\d[\d.]*(?:,\d+)?/);

  return match ? parseItalianNumber(match[0]) : null;
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
    const exact = previous.match(/^([0-9][0-9.]*)$/);
    if (exact) {
      const value = parseItalianNumber(exact[1]);
      if (Number.isFinite(value)) {
        return {
          value,
          display: String(value),
          year: findYearFromLine([lines[i]], /dipendenti/i)
        };
      }
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

export function inferCompanyStatus(text, lines = normalizeLines(text)) {
  const explicit = findLabelValue(lines, [
    "Stato attività",
    "Stato attivita",
    "Stato impresa",
    "Stato"
  ]);

  if (explicit) {
    if (/^attiva\b/i.test(explicit)) return "Attiva";
    if (/^cessata\b/i.test(explicit)) return "Cessata";
    if (/^inattiva\b/i.test(explicit)) return "Inattiva";
    if (/liquidazione/i.test(explicit)) return "In liquidazione";
  }

  // Aziende.it puts the status next to the legal form in the company header.
  // Search only the beginning of the page so FAQ/product text cannot override it.
  const headerText = clean(String(text || "").slice(0, 3500));
  const headerMatch = headerText.match(
    /(Attiva|Cessata|Inattiva|In liquidazione)\s+(?=(?:SOCIETA|SOGGETTO|IMPRESA|DITTA|ENTE|COOPERATIVA)\b)/i
  );

  if (headerMatch) {
    const normalized = headerMatch[1].toLowerCase();
    if (normalized === "attiva") return "Attiva";
    if (normalized === "cessata") return "Cessata";
    if (normalized === "inattiva") return "Inattiva";
    if (normalized === "in liquidazione") return "In liquidazione";
  }

  for (const line of lines.slice(0, 35)) {
    const match = line.match(/^(Attiva|Cessata|Inattiva|In liquidazione)\b/i);
    if (!match) continue;

    const normalized = match[1].toLowerCase();
    if (normalized === "attiva") return "Attiva";
    if (normalized === "cessata") return "Cessata";
    if (normalized === "inattiva") return "Inattiva";
    if (normalized === "in liquidazione") return "In liquidazione";
  }

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

  if (value !== null) {
    return { value, year, source: "Aziende.it", isFiled: true };
  }

  const tableValue = findLabelValue(lines, ["Fatturato"]);
  if (!tableValue) return null;

  const amount = parseMoney(tableValue);
  const yearMatch = tableValue.match(/\b(20\d{2})\b/);

  return amount === null ? null : {
    value: amount,
    year: yearMatch ? Number(yearMatch[1]) : null,
    source: "Aziende.it",
    isFiled: true
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
    year: yearMatch ? Number(yearMatch[1]) : null,
    source: "Aziende.it",
    isFiled: true
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

function inferBalanceHistory(lines) {
  const start = lines.findIndex((line) =>
    /^Ultimi\s+3\s+bilanci\s+disponibili\.?$/i.test(line)
  );

  if (start < 0) return [];

  const history = [];

  for (let i = start + 1; i < lines.length && history.length < 3; i += 1) {
    const yearMatch = lines[i].match(/^(20\d{2})$/);
    if (!yearMatch) continue;

    const year = Number(yearMatch[1]);
    const row = [];

    for (let j = i + 1; j < lines.length && row.length < 7; j += 1) {
      if (/^20\d{2}$/.test(lines[j])) break;
      if (/^(?:Appalti pubblici|Aiuti di Stato|Confronto di settore|Dove si trova|Domande Frequenti)$/i.test(lines[j])) break;
      row.push(lines[j]);
    }

    const moneyValues = row
      .filter((value) => /€|\beuro\b/i.test(value))
      .map(parseMoney)
      .filter((value) => Number.isFinite(value));

    const delta = row.find((value) => /%|^—$/.test(value)) || null;

    let employees = null;
    for (const value of row) {
      if (/^\d{1,6}$/.test(value)) {
        employees = Number(value);
        break;
      }
    }

    history.push({
      year,
      revenue: moneyValues[0] ?? null,
      delta,
      profit: moneyValues[1] ?? null,
      employees,
      capital: moneyValues[2] ?? null,
      source: "Aziende.it",
      isFiled: true
    });
  }

  return history;
}

function inferAddress(lines, text) {
  const summary = String(text || "").match(/Sede\s+legale:\s*([^\n]+)/i);
  if (summary?.[1]) return sanitizeField(summary[1]);

  return sanitizeField(findLabelValue(lines, ["Sede"]));
}

export function parseBalanceHistoryRows(rows) {
  if (!Array.isArray(rows) || rows.length < 2) return [];

  const normalizedRows = rows
    .map((row) => (Array.isArray(row) ? row.map(clean) : []))
    .filter((row) => row.length);

  if (!normalizedRows.length) return [];

  const headerIndex = normalizedRows.findIndex((row) => {
    const joined = row.join(" ").toLowerCase();
    return joined.includes("anno") &&
      joined.includes("fatturato") &&
      /utile|perdita/.test(joined);
  });

  if (headerIndex < 0) return [];

  const headers = normalizedRows[headerIndex].map((value) => value.toLowerCase());
  const indexOf = (pattern, fallback) => {
    const index = headers.findIndex((value) => pattern.test(value));
    return index >= 0 ? index : fallback;
  };

  const yearIndex = indexOf(/^anno$/, 0);
  const revenueIndex = indexOf(/fatturato/, 1);
  const deltaIndex = indexOf(/Δ|varia|%/, 2);
  const profitIndex = indexOf(/utile|perdita/, 3);
  const employeesIndex = indexOf(/dipendenti/, 4);
  const capitalIndex = indexOf(/capitale/, 5);

  const history = [];

  for (const row of normalizedRows.slice(headerIndex + 1)) {
    const yearMatch = String(row[yearIndex] || "").match(/\b(20\d{2})\b/);
    if (!yearMatch) continue;

    const employeeRaw = String(row[employeesIndex] || "").trim();
    const employeeValue = /^\d[\d.]*$/.test(employeeRaw)
      ? parseItalianNumber(employeeRaw)
      : null;

    history.push({
      year: Number(yearMatch[1]),
      revenue: parseMoney(row[revenueIndex]) ?? null,
      delta: row[deltaIndex] && !/^[-—]$/.test(row[deltaIndex])
        ? row[deltaIndex]
        : null,
      profit: parseMoney(row[profitIndex]) ?? null,
      employees: Number.isFinite(employeeValue) ? employeeValue : null,
      capital: parseMoney(row[capitalIndex]) ?? null,
      source: "Aziende.it",
      isFiled: true
    });

    if (history.length >= 3) break;
  }

  return history;
}

function extractBalanceHistoryFromDocument(doc) {
  for (const table of doc.querySelectorAll("table")) {
    const tableText = clean(table.textContent || "").toLowerCase();
    if (!tableText.includes("anno") ||
        !tableText.includes("fatturato") ||
        !/utile|perdita/.test(tableText)) {
      continue;
    }

    const rows = [...table.querySelectorAll("tr")].map((row) =>
      [...row.querySelectorAll("th, td")].map((cell) => cell.textContent || "")
    );

    const parsed = parseBalanceHistoryRows(rows);
    if (parsed.length) return parsed;
  }

  return [];
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

export function legalNameLookupVariants(value) {
  const source = clean(
    stripDescriptor(value)
      .replace(/[!]+/g, " ")
      .replace(/\s+/g, " ")
  );

  if (!source) return [];

  const variants = [source];

  // Registry/VIES names can append qualifiers or even repeat the legal form,
  // e.g. "MPS MONITOR SRL A SOCIO UNICO !!S.R.L.". Keep the original
  // candidate, but also try the canonical name up to the first legal form.
  // VAT validation still decides whether the fetched company is acceptable.
  const canonical = source.match(
    /^(.+?\b(?:s\.?\s*r\.?\s*l\.?\s*s?\.?|s\.?\s*p\.?\s*a\.?|s\.?\s*n\.?\s*c\.?|s\.?\s*a\.?\s*s\.?|srls|srl|spa|snc|sas))(?=\s|$)/i
  )?.[1];

  if (canonical) variants.push(clean(canonical));

  return unique(variants);
}

function legalFormExpandedSlugs(value) {
  const normalized = slugifyCompanyName(value);
  if (!normalized) return [];

  const variants = new Set([normalized]);

  const replacements = [
    [/(?:^|-)s-p-a(?:$|-)/g, "-societa-per-azioni-"],
    [/(?:^|-)spa(?:$|-)/g, "-societa-per-azioni-"],
    [/(?:^|-)s-r-l(?:$|-)/g, "-societa-a-responsabilita-limitata-"],
    [/(?:^|-)srl(?:$|-)/g, "-societa-a-responsabilita-limitata-"],
    [/(?:^|-)s-r-l-s(?:$|-)/g, "-societa-a-responsabilita-limitata-semplificata-"],
    [/(?:^|-)srls(?:$|-)/g, "-societa-a-responsabilita-limitata-semplificata-"]
  ];

  for (const [pattern, replacement] of replacements) {
    const expanded = normalized
      .replace(pattern, replacement)
      .replace(/^-+|-+$/g, "")
      .replace(/-{2,}/g, "-");

    if (expanded && expanded !== normalized) variants.add(expanded);
  }

  return [...variants];
}

function normalizeProvinceHints(values) {
  return unique(values)
    .map((value) => String(value || "").trim().toUpperCase())
    .filter((value) => /^[A-Z]{2}$/.test(value))
    .slice(0, 4);
}

export function buildSlugCandidates(
  names,
  { provinceHints = [], includeItalianBrandVariants = false } = {}
) {
  const legalVariants = [
    "srl",
    "s-r-l",
    "societa-a-responsabilita-limitata",
    "srl-a-socio-unico",
    "srl-unipersonale",
    "spa",
    "s-p-a",
    "societa-per-azioni",
    "srls",
    "s-r-l-s",
    "societa-a-responsabilita-limitata-semplificata",
    "snc",
    "sas",
    "inc",
    "ltd"
  ];
  const territorialLegalVariants = [
    "srl",
    "s-r-l",
    "societa-a-responsabilita-limitata",
    "spa",
    "s-p-a",
    "societa-per-azioni"
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
    for (const candidate of legalNameLookupVariants(raw)) {
      for (const slug of legalFormExpandedSlugs(candidate)) {
        if (!slug || slug.length < 3 || generic.has(slug)) continue;
        bases.push(slug);
      }
    }
  }

  const uniqueBases = unique(bases);
  const provinces = normalizeProvinceHints(provinceHints);
  const result = [];
  const hasLegalSuffix = (slug) =>
    /(?:^|-)(?:srl|s-r-l|spa|s-p-a|srls|s-r-l-s|snc|sas|inc|ltd|societa-per-azioni|societa-a-responsabilita-limitata|societa-a-responsabilita-limitata-semplificata)(?:$|-)/.test(slug);

  // Exact and expanded names first.
  for (const slug of uniqueBases) {
    result.push(slug);

    // Aziende.it often disambiguates duplicate names with the province suffix.
    for (const province of provinces) {
      result.push(`${slug}-${province}`);
    }
  }

  // Italian subsidiaries of international brands frequently include a
  // territorial qualifier in the legal name even when the public site only
  // exposes the global brand (e.g. creditsafe.com -> Creditsafe Italia Srl).
  // Keep this expansion limited to domain/name inference so normal VAT
  // enrichment does not pay the extra lookup cost.
  if (includeItalianBrandVariants) {
    for (const slug of uniqueBases) {
      if (hasLegalSuffix(slug)) continue;

      for (const qualifier of ["italia", "italy"]) {
        const qualified = `${slug}-${qualifier}`;
        result.push(qualified);

        for (const province of provinces) {
          result.push(`${qualified}-${province}`);
        }

        for (const suffix of territorialLegalVariants) {
          const candidate = `${qualified}-${suffix}`;
          result.push(candidate);

          for (const province of provinces) {
            result.push(`${candidate}-${province}`);
          }

          if (result.length >= MAX_SLUGS) {
            return unique(result).slice(0, MAX_SLUGS);
          }
        }
      }
    }
  }

  // Then generate legal-form variants for brand-only names.
  for (const suffix of legalVariants) {
    for (const slug of uniqueBases) {
      if (hasLegalSuffix(slug)) continue;

      const candidate = `${slug}-${suffix}`;
      result.push(candidate);

      for (const province of provinces) {
        result.push(`${candidate}-${province}`);
      }

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
    status: inferCompanyStatus(text, lines),
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
      balanceHistory: inferBalanceHistory(lines),
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
  const company = parseAziendeText(text, { name: h1 || null, url });

  if (!company) return null;

  // DOMParser may flatten visual line breaks, so derive these fields from
  // structural HTML when possible instead of relying only on text lines.
  company.status = inferCompanyStatus(text, normalizeLines(text));

  const domHistory = extractBalanceHistoryFromDocument(doc);
  if (domHistory.length) {
    company.financials.balanceHistory = domHistory;
  }

  return company;
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

async function fetchCompanySlug(slug) {
  const key = `aziende:v6:slug:${slug}`;
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
      // Only a real 404 is a durable miss. Rate limits, server errors and
      // anti-bot responses must not poison the provider cache for 12 hours.
      if (response.status === 404) {
        await writeCache(key, null);
      }
      return null;
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      return null;
    }

    const html = await response.text();
    const company = parseAziendePage(html, response.url || url);

    // A 200 page that cannot be parsed can be a temporary challenge or a
    // changed response. Do not persist it as a negative lookup.
    if (!company?.vat) {
      return null;
    }

    await writeCache(key, company);
    return company;
  } catch {
    return null;
  }
}

async function firstVatMatch(slugs, vat) {
  const uniqueSlugs = unique(slugs).slice(0, MAX_SLUGS);

  for (let i = 0; i < uniqueSlugs.length; i += 4) {
    const batch = uniqueSlugs.slice(i, i + 4);
    const values = await Promise.all(batch.map((slug) => fetchCompanySlug(slug)));
    const match = values.find((company) => company?.vat === vat);
    if (match) return match;
  }

  return null;
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

export async function findAziendeCompanyByVat(
  vat,
  { names = [], provinceHints = [] } = {}
) {
  const targetVat = String(vat || "").replace(/\D/g, "");
  if (!/^\d{11}$/.test(targetVat)) return null;

  return firstVatMatch(
    buildSlugCandidates(names, { provinceHints }),
    targetVat
  );
}

export async function findAziendeCompaniesByContext({
  names = [],
  provinceHints = []
} = {}) {
  if (!names?.length) return [];

  return fetchCandidates(
    buildSlugCandidates(names, {
      provinceHints,
      includeItalianBrandVariants: true
    })
  );
}
