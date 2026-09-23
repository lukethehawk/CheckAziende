import test from "node:test";
import assert from "node:assert/strict";

import {
  compactIdentity,
  getDomainProfile,
  getRegistrableDomain,
  normalizeCompanyName
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
