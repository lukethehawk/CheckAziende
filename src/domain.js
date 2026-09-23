const MULTI_LABEL_PUBLIC_SUFFIXES = new Set([
  "ac.uk", "co.uk", "gov.uk", "ltd.uk", "me.uk", "net.uk", "org.uk", "plc.uk", "sch.uk",
  "asn.au", "com.au", "edu.au", "gov.au", "id.au", "net.au", "org.au",
  "ac.nz", "co.nz", "govt.nz", "net.nz", "org.nz",
  "com.br", "com.mx", "com.ar", "com.tr", "com.cn", "com.hk", "com.sg", "com.tw",
  "co.jp", "co.kr", "co.in", "firm.in", "gen.in", "ind.in", "net.in", "org.in",
  "co.za", "com.pl", "net.pl", "org.pl"
]);

const LEGAL_FORM_PATTERN = new RegExp(
  [
    "societa\\s+per\\s+azioni",
    "societa\\s+a\\s+responsabilita\\s+limitata",
    "s\\.?\\s*p\\.?\\s*a\\.?",
    "s\\.?\\s*r\\.?\\s*l\\.?",
    "s\\.?\\s*n\\.?\\s*c\\.?",
    "s\\.?\\s*a\\.?\\s*s\\.?",
    "srls",
    "incorporated",
    "corporation",
    "company",
    "limited",
    "gmbh",
    "llc",
    "ltd",
    "inc",
    "corp",
    "plc",
    "sarl",
    "sa",
    "ag",
    "bv",
    "nv"
  ].join("|"),
  "gi"
);

export function normalizeHostname(value) {
  let hostname = String(value || "").trim().toLowerCase();
  if (!hostname) return "";

  try {
    if (hostname.includes("://")) hostname = new URL(hostname).hostname;
  } catch {
    // Keep raw hostname and normalize below.
  }

  hostname = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  return hostname;
}

export function isIpAddress(hostname) {
  const value = normalizeHostname(hostname);
  if (!value) return false;

  if (value.includes(":")) return true;

  const parts = value.split(".");
  return parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255);
}

export function getRegistrableDomain(hostname) {
  const value = normalizeHostname(hostname);
  if (!value || value === "localhost" || isIpAddress(value)) return value;

  const labels = value.split(".").filter(Boolean);
  if (labels.length <= 2) return value;

  const lastTwo = labels.slice(-2).join(".");
  if (MULTI_LABEL_PUBLIC_SUFFIXES.has(lastTwo) && labels.length >= 3) {
    return labels.slice(-3).join(".");
  }

  return lastTwo;
}

export function getDomainProfile(hostname) {
  const normalizedHostname = normalizeHostname(hostname);
  const registrableDomain = getRegistrableDomain(normalizedHostname);

  if (!normalizedHostname) {
    return {
      hostname: "",
      registrableDomain: "",
      rootLabel: "",
      subdomain: "",
      isSubdomain: false
    };
  }

  const rootLabels = registrableDomain.split(".").filter(Boolean);
  const hostLabels = normalizedHostname.split(".").filter(Boolean);
  const prefixLength = Math.max(0, hostLabels.length - rootLabels.length);
  const rawSubdomain = hostLabels.slice(0, prefixLength).join(".");
  const meaningfulSubdomain = rawSubdomain === "www" ? "" : rawSubdomain;

  return {
    hostname: normalizedHostname,
    registrableDomain,
    rootLabel: rootLabels[0] || "",
    subdomain: meaningfulSubdomain,
    isSubdomain: Boolean(meaningfulSubdomain)
  };
}

export function normalizeCompanyName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(LEGAL_FORM_PATTERN, " ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function compactIdentity(value) {
  return normalizeCompanyName(value).replace(/[^a-z0-9]/g, "");
}

export function uniqueBrandHints(values) {
  const seen = new Set();
  const result = [];

  for (const value of values || []) {
    const raw = String(value || "").trim();
    if (!raw) continue;

    const compact = compactIdentity(raw);
    if (compact.length < 3 || seen.has(compact)) continue;

    seen.add(compact);
    result.push(raw);
  }

  return result.slice(0, 8);
}

export function compareCompanyToPage(company, pageContext) {
  const domain = getDomainProfile(pageContext?.hostname || "");
  const companyNameCompact = compactIdentity(company?.name || "");
  const rootCompact = compactIdentity(domain.rootLabel);
  const hints = uniqueBrandHints(pageContext?.brandHints || []);
  const hintCompacts = hints.map(compactIdentity);
  const titleCompact = compactIdentity(pageContext?.title || "");

  const companyDomains = [
    company?.domain,
    company?.website,
    ...(Array.isArray(company?.domains) ? company.domains : [])
  ]
    .map((value) => {
      try {
        return getDomainProfile(value).registrableDomain;
      } catch {
        return "";
      }
    })
    .filter(Boolean);

  const exactDomain = companyDomains.includes(domain.registrableDomain);
  const nameMatchesRoot = Boolean(
    companyNameCompact &&
    rootCompact &&
    (companyNameCompact === rootCompact ||
      companyNameCompact.includes(rootCompact) ||
      rootCompact.includes(companyNameCompact))
  );

  const exactBrandHint = Boolean(
    companyNameCompact &&
    hintCompacts.some((hint) => hint === companyNameCompact)
  );

  const brandContainsName = Boolean(
    companyNameCompact &&
    hintCompacts.some(
      (hint) => hint.includes(companyNameCompact) || companyNameCompact.includes(hint)
    )
  );

  const titleContainsName = Boolean(
    companyNameCompact &&
    titleCompact &&
    (titleCompact.includes(companyNameCompact) || companyNameCompact.includes(titleCompact))
  );

  return {
    domain,
    companyNameCompact,
    exactDomain,
    nameMatchesRoot,
    exactBrandHint,
    brandContainsName,
    titleContainsName
  };
}
