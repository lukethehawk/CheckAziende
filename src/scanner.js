export function scanCurrentPage() {
  const VAT_LABEL_PATTERN = /(?:partita\s*iva|p\.?\s*iva|piva|vat(?:\s*(?:number|id))?)/i;
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

  function clean(value, max = 260) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, max);
  }

  function unique(values) {
    return [...new Set(values.filter(Boolean))];
  }

  function upsertCandidate(candidates, candidate) {
    const previous = candidates.get(candidate.vat);
    if (!previous || candidate.score > previous.score) {
      candidates.set(candidate.vat, candidate);
    }
  }

  function collectLabeledVat(text, source, candidates, score = 100) {
    if (!text || !VAT_LABEL_PATTERN.test(text)) return;

    VAT_NUMBER_PATTERN.lastIndex = 0;
    let match;

    while ((match = VAT_NUMBER_PATTERN.exec(text)) !== null) {
      const vat = digitsOnly(match[1]);
      if (!isValidItalianVat(vat)) continue;

      const start = Math.max(0, match.index - 100);
      const end = Math.min(text.length, match.index + match[0].length + 100);
      const context = clean(text.slice(start, end));

      if (!VAT_LABEL_PATTERN.test(context)) continue;

      upsertCandidate(candidates, {
        vat,
        score,
        source,
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

  return {
    url: location.href,
    origin: location.origin,
    hostname: location.hostname,
    title: document.title,
    siteName,
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
