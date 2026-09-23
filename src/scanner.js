export function scanCurrentPage() {
  const VAT_LABEL_PATTERN =
    /(?:partita\s*iva|p\.?\s*iva|piva|p\s*\.\s*i\s*\.?|vat(?:\s*(?:number|id))?)/i;
  const VAT_NUMBER_PATTERN = /(?:\bIT[\s.:-]*)?(\d{11})\b/gi;
  const STRONG_LEGAL_CONTEXT_PATTERN =
    /(?:\bREA\b|privacy|cookie|copyright|(?:via|viale|piazza|corso|strada|largo)\s+.{0,80}\b\d{5}\b|(?:s\.?r\.?l\.?|s\.?p\.?a\.?|s\.?n\.?c\.?|s\.?a\.?s\.?|inc\.?|ltd\.?|gmbh)\b.{0,120}(?:via|viale|piazza|corso|strada|largo))/i;

  function digitsOnly(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function isValidItalianVat(value) {
    const vat = digitsOnly(value);
    if (!/^\d{11}$/.test(vat)) return false;

    let sum = 0;
    for (let i = 0; i < 10; i += 1) {
      let digit = Number(vat[i]);
      if (i % 2 === 1) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
    }

    return ((10 - (sum % 10)) % 10) === Number(vat[10]);
  }

  function clean(value, max = 260) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function evidenceTypeForSource(source) {
    const value = String(source || "").toLowerCase();
    if (value.includes("dati strutturati")) return "vat_structured";
    if (value.includes("metadati")) return "vat_metadata";
    if (value.includes("privacy")) return "vat_privacy";
    if (value.includes("note legali") || value.includes("legal")) return "vat_related_legal";
    if (value.includes("contatti") || value.includes("contact")) return "vat_contact";
    if (value.includes("pagina azienda") || value.includes("about")) return "vat_company_page";
    if (value.includes("footer testuale")) return "vat_footer_text";
    if (value.includes("footer") || value.includes("area legale")) return "vat_legal";
    return "vat_other_labeled";
  }

  function upsertCandidate(candidates, candidate) {
    const previous = candidates.get(candidate.vat);
    if (!previous || candidate.score > previous.score) {
      candidates.set(candidate.vat, candidate);
    }
  }

  function collectLabeledVat(
    text,
    source,
    candidates,
    score = 100,
    { requireStrongLegalContext = false } = {}
  ) {
    if (!text || !VAT_LABEL_PATTERN.test(text)) return;

    VAT_NUMBER_PATTERN.lastIndex = 0;
    let match;

    while ((match = VAT_NUMBER_PATTERN.exec(text)) !== null) {
      const vat = digitsOnly(match[1]);
      if (!isValidItalianVat(vat)) continue;

      const start = Math.max(0, match.index - 140);
      const end = Math.min(text.length, match.index + match[0].length + 140);
      const context = clean(text.slice(start, end), 320);

      if (!VAT_LABEL_PATTERN.test(context)) continue;
      if (requireStrongLegalContext && !STRONG_LEGAL_CONTEXT_PATTERN.test(context)) continue;

      upsertCandidate(candidates, {
        vat,
        score,
        source,
        evidenceType: evidenceTypeForSource(source),
        confidence: "high",
        context
      });
    }
  }

  function collectStructuredVat(value, source, candidates) {
    const vat = digitsOnly(value);
    if (!isValidItalianVat(vat)) return;

    upsertCandidate(candidates, {
      vat,
      score: 140,
      source,
      evidenceType: evidenceTypeForSource(source),
      confidence: "high",
      context: "Dati strutturati del sito"
    });
  }

  function walkStructuredData(value, candidates) {
    if (!value || typeof value !== "object") return;

    if (Array.isArray(value)) {
      for (const item of value) walkStructuredData(item, candidates);
      return;
    }

    for (const [key, rawValue] of Object.entries(value)) {
      if (/^(?:vatID|vatId|vatNumber|taxID|taxId)$/i.test(key)) {
        if (typeof rawValue === "string" || typeof rawValue === "number") {
          collectStructuredVat(rawValue, "dati strutturati", candidates);
        }
      }

      if (rawValue && typeof rawValue === "object") {
        walkStructuredData(rawValue, candidates);
      }
    }
  }

  function extractStructuredCandidates(candidates) {
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      const raw = node.textContent?.trim();
      if (!raw) continue;

      try {
        walkStructuredData(JSON.parse(raw), candidates);
      } catch {
        // JSON-LD malformed: ignore it.
      }
    }
  }

  function discoverRelatedUrls() {
    const strongPatterns = [
      /privacy/i,
      /privacy-policy/i,
      /legal/i,
      /legal-notices/i,
      /note-legali/i,
      /contatti/i,
      /contact(?:s)?/i,
      /chi-siamo/i,
      /about(?:-us)?/i,
      /terms/i,
      /termini/i,
      /impressum/i
    ];

    const scored = [];

    for (const anchor of document.querySelectorAll("a[href]")) {
      const href = anchor.getAttribute("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:")) continue;

      let url;
      try {
        url = new URL(href, location.href);
      } catch {
        continue;
      }

      if (url.origin !== location.origin) continue;
      if (!["http:", "https:"].includes(url.protocol)) continue;

      url.hash = "";

      const path = url.pathname.toLowerCase();
      const anchorText = clean(anchor.textContent || "", 120).toLowerCase();
      const haystack = `${path} ${anchorText}`;

      let score = 0;

      for (const pattern of strongPatterns) {
        if (pattern.test(haystack)) score += 20;
      }

      if (/privacy|legal|note-legali|impressum/.test(haystack)) score += 30;
      if (/contatti|contact/.test(haystack)) score += 25;
      if (/chi-siamo|about(?:-us)?/.test(haystack)) score += 20;

      // Generic "azienda/company/corporate" pages are useful on a normal
      // corporate site, but dangerous on directories and data providers.
      // Accept them only when both path and anchor are clearly the site's own
      // corporate page, not when the word merely appears inside a longer URL
      // such as /confronto-aziende or /elenco-aziende.
      const pathSegments = path.split("/").filter(Boolean);
      const lastSegment = pathSegments.at(-1) || "";
      const exactCorporatePath = /^(?:azienda|company|corporate)$/.test(lastSegment);
      const exactCorporateAnchor = /^(?:azienda|company|corporate)$/.test(anchorText);

      if (exactCorporatePath && exactCorporateAnchor) {
        score += 12;
      }

      if (score > 0) scored.push({ url: url.href, score });
    }

    const seen = new Set();
    return scored
      .sort((a, b) => b.score - a.score)
      .filter((item) => {
        if (seen.has(item.url)) return false;
        seen.add(item.url);
        return true;
      })
      .slice(0, 6)
      .map((item) => item.url);
  }

  const legalSelector = [
    "footer",
    "address",
    "[class*='footer' i]",
    "[id*='footer' i]",
    "[class*='legal' i]",
    "[id*='legal' i]",
    "[class*='copyright' i]",
    "[id*='copyright' i]",
    "[class*='company-info' i]",
    "[id*='company-info' i]"
  ].join(", ");

  let legalNodes = [];
  try {
    legalNodes = [...document.querySelectorAll(legalSelector)];
  } catch {
    legalNodes = [...document.querySelectorAll("footer, address")];
  }

  const candidates = new Map();
  extractStructuredCandidates(candidates);

  for (const node of legalNodes) {
    const text = node.innerText || node.textContent || "";
    collectLabeledVat(text, "footer/area legale", candidates, 120);
  }

  for (const node of document.querySelectorAll("meta[content]")) {
    const key = [
      node.getAttribute("name"),
      node.getAttribute("property"),
      node.getAttribute("itemprop")
    ]
      .filter(Boolean)
      .join(" ");

    if (!/(?:vat|partita.?iva|tax.?id)/i.test(key)) continue;
    collectStructuredVat(node.getAttribute("content") || "", "metadati", candidates);
  }

  if (!candidates.size) {
    const bodyText =
      document.body?.innerText ||
      document.body?.textContent ||
      document.documentElement?.innerText ||
      document.documentElement?.textContent ||
      "";

    const footerTail = bodyText.slice(Math.max(0, bodyText.length - 6000));

    collectLabeledVat(
      footerTail,
      "footer testuale",
      candidates,
      105,
      { requireStrongLegalContext: true }
    );
  }

  const contactSelector = [
    "footer",
    "address",
    "[class*='footer' i]",
    "[id*='footer' i]",
    "[class*='contact' i]",
    "[id*='contact' i]",
    "[class*='legal' i]",
    "[id*='legal' i]"
  ].join(", ");

  let contactNodes = [];
  try {
    contactNodes = [...document.querySelectorAll(contactSelector)];
  } catch {
    contactNodes = [...document.querySelectorAll("footer, address")];
  }

  const contactText = contactNodes
    .map((node) => node.innerText || node.textContent || "")
    .join("\n");

  const mailtoEmails = [...document.querySelectorAll('a[href^="mailto:" i]')]
    .map((node) => {
      const href = node.getAttribute("href") || "";
      const raw = href.replace(/^mailto:/i, "").split("?")[0].trim();
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    });

  const contactEmails =
    contactText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];

  const emails = unique([...mailtoEmails, ...contactEmails])
    .filter((email) => email.length <= 120)
    .slice(0, 4);

  const phones = unique(
    [...document.querySelectorAll('a[href^="tel:" i]')]
      .map((node) => (node.getAttribute("href") || "").replace(/^tel:/i, "").trim())
      .map((phone) => phone.replace(/\s+/g, " "))
  )
    .filter((phone) => phone.length >= 6 && phone.length <= 40)
    .slice(0, 4);

  const siteName =
    document.querySelector('meta[property="og:site_name"]')?.getAttribute("content")?.trim() ||
    document.title?.trim() ||
    location.hostname;

  const brandHints = unique([
    document.querySelector('meta[property="og:site_name"]')?.getAttribute("content")?.trim(),
    document.querySelector('meta[name="application-name"]')?.getAttribute("content")?.trim(),
    document.querySelector("h1")?.textContent?.trim(),
    ...[...document.querySelectorAll('img[alt]')]
      .filter((node) => /logo|brand/i.test(node.className || "") || /logo|brand/i.test(node.id || ""))
      .map((node) => node.getAttribute("alt")?.trim())
  ]).slice(0, 8);

  return {
    url: location.href,
    origin: location.origin,
    hostname: location.hostname,
    title: document.title,
    siteName,
    brandHints,
    relatedUrls: discoverRelatedUrls(),
    contacts: {
      emails,
      phones
    },
    candidates: [...candidates.values()]
      .sort((a, b) => b.score - a.score || a.vat.localeCompare(b.vat))
      .slice(0, 4),
    diagnostics: {
      legalNodes: legalNodes.length,
      contactNodes: contactNodes.length
    }
  };
}

export async function scanRelatedPages(urls) {
  const VAT_LABEL_PATTERN =
    /(?:partita\s*iva|p\.?\s*iva|piva|p\s*\.\s*i\s*\.?|vat(?:\s*(?:number|id))?)/i;
  const VAT_NUMBER_PATTERN = /(?:\bIT[\s.:-]*)?(\d{11})\b/gi;

  function digitsOnly(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function isValidItalianVat(value) {
    const vat = digitsOnly(value);
    if (!/^\d{11}$/.test(vat)) return false;

    let sum = 0;
    for (let i = 0; i < 10; i += 1) {
      let digit = Number(vat[i]);
      if (i % 2 === 1) {
        digit *= 2;
        if (digit > 9) digit -= 9;
      }
      sum += digit;
    }

    return ((10 - (sum % 10)) % 10) === Number(vat[10]);
  }

  function clean(value, max = 340) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function sourceLabel(url, title) {
    let path = "";
    try {
      path = new URL(url).pathname.toLowerCase();
    } catch {
      return title || "pagina societaria";
    }

    if (path.includes("privacy")) return "privacy policy";
    if (path.includes("legal") || path.includes("note-legali") || path.includes("impressum")) {
      return "note legali";
    }
    if (path.includes("contact") || path.includes("contatti")) return "pagina contatti";
    if (path.includes("about") || path.includes("chi-siamo") || path.includes("company") || path.includes("azienda")) {
      return "pagina azienda";
    }
    if (path.includes("terms") || path.includes("termini")) return "termini del sito";
    return title || "pagina societaria";
  }

  const origin = location.origin;
  const candidates = [];
  const emails = [];
  const phones = [];
  const checkedUrls = [];

  for (const rawUrl of Array.isArray(urls) ? urls.slice(0, 6) : []) {
    let url;
    try {
      url = new URL(rawUrl, location.href);
    } catch {
      continue;
    }

    if (url.origin !== origin) continue;

    try {
      const response = await fetch(url.href, {
        credentials: "same-origin",
        redirect: "follow"
      });

      if (!response.ok) continue;

      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("text/html")) continue;

      const html = await response.text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      const text = doc.body?.innerText || doc.body?.textContent || "";
      const label = sourceLabel(response.url || url.href, doc.title?.trim());
      checkedUrls.push(response.url || url.href);

      VAT_NUMBER_PATTERN.lastIndex = 0;
      let match;
      while ((match = VAT_NUMBER_PATTERN.exec(text)) !== null) {
        const vat = digitsOnly(match[1]);
        if (!isValidItalianVat(vat)) continue;

        const start = Math.max(0, match.index - 160);
        const end = Math.min(text.length, match.index + match[0].length + 160);
        const context = clean(text.slice(start, end));

        if (!VAT_LABEL_PATTERN.test(context)) continue;

        const evidenceType = label === "privacy policy"
          ? "vat_privacy"
          : label === "note legali"
            ? "vat_related_legal"
            : label === "pagina contatti"
              ? "vat_contact"
              : label === "pagina azienda"
                ? "vat_company_page"
                : "vat_other_labeled";

        candidates.push({
          vat,
          score: 130,
          source: label,
          evidenceType,
          confidence: "high",
          context,
          url: response.url || url.href
        });
      }

      for (const anchor of doc.querySelectorAll('a[href^="mailto:" i]')) {
        const href = anchor.getAttribute("href") || "";
        const raw = href.replace(/^mailto:/i, "").split("?")[0].trim();
        try {
          emails.push(decodeURIComponent(raw));
        } catch {
          emails.push(raw);
        }
      }

      for (const anchor of doc.querySelectorAll('a[href^="tel:" i]')) {
        const href = anchor.getAttribute("href") || "";
        phones.push(href.replace(/^tel:/i, "").trim().replace(/\s+/g, " "));
      }
    } catch {
      // Ignore individual related-page failures.
    }
  }

  const byVat = new Map();
  for (const candidate of candidates) {
    const previous = byVat.get(candidate.vat);
    if (!previous || candidate.score > previous.score) {
      byVat.set(candidate.vat, candidate);
    }
  }

  return {
    candidates: [...byVat.values()].sort((a, b) => b.score - a.score),
    contacts: {
      emails: unique(emails).filter((email) => email.length <= 120).slice(0, 6),
      phones: unique(phones).filter((phone) => phone.length >= 6 && phone.length <= 40).slice(0, 6)
    },
    checkedUrls
  };
}
