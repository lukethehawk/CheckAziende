import test from "node:test";
import assert from "node:assert/strict";

import {
  compactIdentity,
  getDomainProfile,
  getRegistrableDomain,
  normalizeCompanyName,
  buildDomainLookupContext
} from "../src/domain.js";

import {
  assessDomainCompanyMatch,
  assessVatMatch
} from "../src/confidence.js";

test("extracts registrable Italian domain from a subdomain", () => {
  const profile = getDomainProfile("frontend.computergross.it");

  assert.equal(profile.registrableDomain, "computergross.it");
  assert.equal(profile.rootLabel, "computergross");
  assert.equal(profile.subdomain, "frontend");
  assert.equal(profile.isSubdomain, true);
});

test("ignores www as a meaningful subdomain", () => {
  const profile = getDomainProfile("www.mpsmonitor.com");

  assert.equal(profile.registrableDomain, "mpsmonitor.com");
  assert.equal(profile.subdomain, "");
  assert.equal(profile.isSubdomain, false);
});

test("handles common multi-label public suffixes", () => {
  assert.equal(
    getRegistrableDomain("portal.example.co.uk"),
    "example.co.uk"
  );
});

test("normalizes legal forms without damaging the company name", () => {
  assert.equal(normalizeCompanyName("COMPUTER GROSS S.P.A."), "computer gross");
  assert.equal(compactIdentity("Future Tech S.r.l."), "futuretech");
});

test("direct labeled VAT evidence is identified with high confidence", () => {
  const assessment = assessVatMatch({
    candidate: {
      vat: "04801490485",
      source: "footer/area legale",
      evidenceType: "vat_legal"
    },
    company: {
      name: "COMPUTER GROSS S.P.A."
    },
    pageContext: {
      hostname: "www.computergross.it",
      title: "Computer Gross S.p.A.",
      brandHints: ["Computer Gross"]
    }
  });

  assert.equal(assessment.status, "identified");
  assert.ok(assessment.score >= 90);
});

test("domain/name inference stays a possible match without direct proof", () => {
  const assessment = assessDomainCompanyMatch({
    company: {
      name: "COMPUTER GROSS S.P.A."
    },
    pageContext: {
      hostname: "frontend.computergross.it",
      title: "Computer Gross S.p.A.",
      brandHints: ["Computer Gross"]
    }
  });

  assert.equal(assessment.status, "possible");
  assert.ok(assessment.score >= 65);
  assert.ok(assessment.score <= 89);
});

test("confirmed domain mapping can become identified", () => {
  const assessment = assessDomainCompanyMatch({
    company: {
      name: "COMPUTER GROSS S.P.A.",
      domain: "computergross.it"
    },
    pageContext: {
      hostname: "frontend.computergross.it",
      title: "Computer Gross S.p.A.",
      brandHints: ["Computer Gross"]
    },
    confirmedMapping: true
  });

  assert.equal(assessment.status, "identified");
  assert.ok(assessment.score >= 90);
});


test("generic company-page VAT is rejected when company conflicts with the site brand", () => {
  const assessment = assessVatMatch({
    candidate: {
      vat: "02263110229",
      source: "pagina azienda",
      evidenceType: "vat_company_page"
    },
    company: {
      name: "GRIMONT E.P.C.M. S.R.L."
    },
    pageContext: {
      hostname: "xrayfinance.it",
      title: "Xray Finance - Fatturato e Dati Finanziari delle aziende italiane",
      brandHints: ["Xray Finance"]
    }
  });

  assert.equal(assessment.status, "unidentified");
  assert.ok(assessment.score < 65);
});

test("generic company-page VAT can remain a possible match when brand and domain agree", () => {
  const assessment = assessVatMatch({
    candidate: {
      vat: "03201220211",
      source: "pagina azienda",
      evidenceType: "vat_company_page"
    },
    company: {
      name: "XRAY FINANCE SRL"
    },
    pageContext: {
      hostname: "xrayfinance.it",
      title: "Xray Finance",
      brandHints: ["Xray Finance"]
    }
  });

  assert.equal(assessment.status, "possible");
  assert.ok(assessment.score >= 65);
  assert.ok(assessment.score < 90);
});


test("structured VAT for a third-party profile is not treated as site ownership", () => {
  const assessment = assessVatMatch({
    candidate: {
      vat: "11295150152",
      source: "dati strutturati",
      evidenceType: "vat_structured"
    },
    company: {
      name: "FUTURE TECH SRL"
    },
    pageContext: {
      hostname: "www.aziende.it",
      title: "Future Tech Srl: fatturato 2024",
      brandHints: ["Aziende.it"]
    }
  });

  assert.equal(assessment.status, "unidentified");
  assert.ok(assessment.score < 65);
});

test("legal footer VAT remains strong even when legal owner name differs from domain brand", () => {
  const assessment = assessVatMatch({
    candidate: {
      vat: "02357550066",
      source: "footer/area legale",
      evidenceType: "vat_legal"
    },
    company: {
      name: "AD INTEND S.R.L."
    },
    pageContext: {
      hostname: "www.aziende.it",
      title: "Future Tech Srl: fatturato 2024",
      brandHints: ["Aziende.it"]
    }
  });

  assert.equal(assessment.status, "identified");
  assert.ok(assessment.score >= 90);
});

test("domain lookup context does not promote page title to site brand", () => {
  const context = buildDomainLookupContext({
    hostname: "www.aziende.it",
    title: "FUTURE TECH SRL",
    siteName: "Aziende.it",
    brandHints: ["Aziende.it"]
  });

  assert.ok(context.searchNames.includes("aziende it") || context.searchNames.includes("aziende"));
  assert.ok(!context.searchNames.includes("future tech"));
});


test("metadata VAT for a third-party profile is not treated as site ownership", () => {
  const assessment = assessVatMatch({
    candidate: {
      vat: "11295150152",
      source: "metadati",
      evidenceType: "vat_metadata"
    },
    company: {
      name: "FUTURE TECH SRL"
    },
    pageContext: {
      hostname: "www.aziende.it",
      title: "Future Tech Srl: fatturato 2024",
      brandHints: ["Aziende.it"]
    }
  });

  assert.equal(assessment.status, "unidentified");
  assert.ok(assessment.score < 65);
});
