import { compareCompanyToPage } from "./domain.js";

export const CONFIDENCE_THRESHOLDS = Object.freeze({
  identified: 90,
  possible: 65
});

const VAT_SOURCE_SCORES = Object.freeze({
  vat_structured: 99,
  vat_metadata: 98,
  vat_legal: 97,
  vat_privacy: 96,
  vat_related_legal: 96,
  vat_contact: 94,
  vat_company_page: 55,
  vat_footer_text: 92,
  vat_other_labeled: 90
});

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function combinePositiveEvidence(evidence) {
  let remaining = 1;

  for (const item of evidence) {
    const weight = clamp(item.weight) / 100;
    remaining *= 1 - weight;
  }

  return 100 * (1 - remaining);
}

function classify(score, { manual = false } = {}) {
  if (manual) return "manual";
  if (score >= CONFIDENCE_THRESHOLDS.identified) return "identified";
  if (score >= CONFIDENCE_THRESHOLDS.possible) return "possible";
  return "unidentified";
}

export function vatEvidenceType(candidate) {
  const source = String(candidate?.source || "").toLowerCase();
  const evidenceType = candidate?.evidenceType;

  if (evidenceType && VAT_SOURCE_SCORES[evidenceType]) return evidenceType;
  if (source.includes("dati strutturati")) return "vat_structured";
  if (source.includes("metadati")) return "vat_metadata";
  if (source.includes("privacy")) return "vat_privacy";
  if (source.includes("note legali") || source.includes("legal")) return "vat_related_legal";
  if (source.includes("contatti") || source.includes("contact")) return "vat_contact";
  if (source.includes("pagina azienda") || source.includes("about")) return "vat_company_page";
  if (source.includes("footer testuale")) return "vat_footer_text";
  if (source.includes("footer") || source.includes("area legale")) return "vat_legal";
  return "vat_other_labeled";
}

export function assessVatMatch({ candidate, company, pageContext, manual = false }) {
  if (manual) {
    return {
      score: 100,
      status: "manual",
      evidence: [{ type: "manual", weight: 100, label: "P.IVA inserita manualmente" }]
    };
  }

  const evidenceType = vatEvidenceType(candidate);
  const comparison = compareCompanyToPage(company, pageContext);

  const ownerCoherent = Boolean(
    comparison.exactDomain ||
    comparison.nameMatchesRoot ||
    comparison.exactBrandHint ||
    comparison.brandContainsName
  );

  let baseWeight = VAT_SOURCE_SCORES[evidenceType];

  // JSON-LD on a directory/profile page often describes the company being
  // viewed rather than the website owner. Treat it as strong ownership
  // evidence only when the company is coherent with site-level brand/domain.
  if (
    (evidenceType === "vat_structured" || evidenceType === "vat_metadata") &&
    !ownerCoherent
  ) {
    baseWeight = 55;
  }

  const evidence = [{
    type: evidenceType,
    weight: baseWeight,
    label: candidate?.source || "P.IVA rilevata dal sito"
  }];

  if (comparison.exactDomain) {
    evidence.push({ type: "domain_exact", weight: 35, label: "Dominio aziendale coincidente" });
  } else if (comparison.nameMatchesRoot) {
    evidence.push({ type: "name_root", weight: 18, label: "Nome coerente con il dominio" });
  }

  if (comparison.exactBrandHint) {
    evidence.push({ type: "brand_exact", weight: 14, label: "Brand del sito coincidente" });
  } else if (comparison.brandContainsName || comparison.titleContainsName) {
    evidence.push({ type: "brand_related", weight: 8, label: "Brand del sito coerente" });
  }

  const score = clamp(combinePositiveEvidence(evidence));

  return {
    score,
    status: classify(score),
    evidence,
    domain: comparison.domain
  };
}

export function assessDomainCompanyMatch({ company, pageContext, confirmedMapping = false }) {
  const comparison = compareCompanyToPage(company, pageContext);
  const evidence = [];

  if (comparison.exactDomain) {
    evidence.push({ type: "domain_exact", weight: 82, label: "Dominio principale coincidente" });
  }

  if (comparison.nameMatchesRoot) {
    evidence.push({ type: "name_root", weight: 58, label: "Ragione sociale coerente con il dominio" });
  }

  if (comparison.exactBrandHint) {
    evidence.push({ type: "brand_exact", weight: 62, label: "Ragione sociale coincidente con il brand" });
  } else if (comparison.brandContainsName) {
    evidence.push({ type: "brand_related", weight: 42, label: "Ragione sociale simile al brand" });
  }

  if (comparison.titleContainsName) {
    evidence.push({ type: "title_match", weight: 38, label: "Nome coerente con il titolo della pagina" });
  }

  if (comparison.domain.isSubdomain) {
    evidence.push({ type: "subdomain", weight: 10, label: "Portale su sottodominio del dominio principale" });
  }

  if (confirmedMapping) {
    evidence.push({ type: "confirmed_mapping", weight: 96, label: "Associazione dominio-società confermata" });
  }

  let score = clamp(combinePositiveEvidence(evidence));

  // Domain/name inference alone is intentionally never considered certain.
  if (!confirmedMapping) score = Math.min(score, 89);

  return {
    score,
    status: classify(score),
    evidence,
    domain: comparison.domain
  };
}

export function confidenceLabel(status) {
  if (status === "identified") return "Identificata";
  if (status === "possible") return "Possibile corrispondenza";
  if (status === "manual") return "Ricerca manuale";
  return "Non identificata";
}
