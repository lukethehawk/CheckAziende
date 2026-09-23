(() => {
  const LABEL_PATTERN = /(?:partita\s*iva|p\.?\s*iva|piva|vat(?:\s*number)?)/i;

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

    const checkDigit = (10 - (sum % 10)) % 10;
    return checkDigit === Number(vat[10]);
  }

  function cleanContext(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 180);
  }

  function collectFromText(text, baseScore, source, candidates) {
    if (!text) return;

    const regex = /(?:\bIT\s*)?(\d{11})\b/gi;
    let match;

    while ((match = regex.exec(text)) !== null) {
      const vat = digitsOnly(match[1]);
      if (!isValidItalianVat(vat)) continue;

      const start = Math.max(0, match.index - 90);
      const end = Math.min(text.length, match.index + match[0].length + 90);
      const context = cleanContext(text.slice(start, end));

      let score = baseScore;
      if (LABEL_PATTERN.test(context)) score += 100;
      if (/codice\s*fiscale/i.test(context) && !LABEL_PATTERN.test(context)) score -= 15;

      const previous = candidates.get(vat);
      if (!previous || score > previous.score) {
        candidates.set(vat, { vat, score, source, context });
      }
    }
  }

  function scanDocument() {
    const candidates = new Map();

    const footerNodes = [
      ...document.querySelectorAll(
        "footer, address, [class*='footer' i], [id*='footer' i], [class*='legal' i], [id*='legal' i]"
      )
    ];

    for (const node of footerNodes) {
      collectFromText(node.innerText || node.textContent || "", 60, "footer", candidates);
    }

    const bodyText = document.body?.innerText || document.documentElement?.innerText || "";
    collectFromText(bodyText, 10, "pagina", candidates);

    const metaValues = [
      ...document.querySelectorAll("meta[content]")
    ].map((node) => node.getAttribute("content") || "");

    for (const value of metaValues) {
      collectFromText(value, 20, "meta", candidates);
    }

    const ordered = [...candidates.values()]
      .sort((a, b) => b.score - a.score || a.vat.localeCompare(b.vat))
      .slice(0, 8);

    return {
      url: location.href,
      title: document.title,
      candidates: ordered
    };
  }

  return scanDocument();
})();
