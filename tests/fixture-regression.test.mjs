import test from "node:test";
import assert from "node:assert/strict";

import {
  parseAziendeText
} from "../src/providers/aziende.js";
import {
  parseRegistroAziendeText
} from "../src/providers/registroaziende.js";
import {
  parseXrayText
} from "../src/providers/xray.js";
import {
  enrichCompanyWithFallback,
  enrichCompanyWithXray,
  normalizeCompany
} from "../src/company.js";
import {
  buildDomainLookupContext
} from "../src/domain.js";
import {
  assessDomainCompanyMatch,
  assessVatMatch
} from "../src/confidence.js";
import {
  describeFinancialProfile,
  evaluateFinancialProfile
} from "../src/financial-evaluation.js";
import {
  extractFooterText,
  htmlToText,
  loadFixture,
  pageContextFromFixture
} from "./helpers/fixtures.mjs";

test("fixture: Future Tech keeps canonical data and promotes newer filed year", async () => {
  const aziendeHtml = await loadFixture("aziende/future-tech.html");
  const registroHtml = await loadFixture("registro/future-tech.html");

  const aziende = parseAziendeText(htmlToText(aziendeHtml), {
    name: "FUTURE TECH SRL",
    url: "https://www.aziende.it/future-tech-srl"
  });
  const registro = parseRegistroAziendeText(
    htmlToText(registroHtml),
    { url: "https://registroaziende.it/azienda/future-tech-srl-basiglio" }
  );

  assert.equal(aziende.vat, "11295150152");
  assert.equal(aziende.status, "Attiva");
  assert.equal(aziende.rea, "MI-1453877");
  assert.equal(aziende.financials.revenue.value, 1_992_222);

  assert.equal(registro.vat, "11295150152");
  assert.equal(registro.financials.balanceHistory[0].year, 2025);

  const company = normalizeCompany(aziende, null, aziende.vat);
  enrichCompanyWithFallback(company, registro);

  assert.equal(company.name, "FUTURE TECH SRL");
  assert.equal(company.financials.revenue.year, 2025);
  assert.equal(company.financials.revenue.value, 1_820_000);
  assert.equal(company.financials.profit.value, 266_000);
  assert.ok(company.provider.includes("Aziende.it"));
  assert.ok(company.provider.includes("RegistroAziende.it"));

  const evaluation = evaluateFinancialProfile(company, {
    now: new Date(2026, 8, 23)
  });
  assert.equal(evaluation.requirements.atLeastTwoFiledBalances, true);
  assert.notEqual(describeFinancialProfile(evaluation).key, "limited");
});

test("fixture: Rubino keeps Xray enrichment after canonical Aziende data", async () => {
  const aziendeHtml = await loadFixture("aziende/rubino.html");
  const xrayHtml = await loadFixture("xray/rubino.html");

  const aziende = parseAziendeText(htmlToText(aziendeHtml), {
    name: "RUBINO - S.R.L.",
    url: "https://www.aziende.it/rubino-s-r-l-SA"
  });
  const xray = parseXrayText(htmlToText(xrayHtml), {
    name: "RUBINO S.R.L.",
    url: "https://xrayfinance.it/rubino-s-r-l-15"
  });

  assert.equal(aziende.vat, "05488440651");
  assert.equal(xray.vat, "05488440651");
  assert.equal(xray.financials.ebitda, 283_000);
  assert.equal(xray.financials.ebitdaMargin, 12.41);

  const company = normalizeCompany(aziende, null, aziende.vat);
  enrichCompanyWithXray(company, xray);

  assert.equal(company.name, "RUBINO - S.R.L.");
  assert.equal(company.financials.ebitda.value, 283_000);
  assert.equal(company.financials.ebitdaMargin.value, 12.41);
  assert.equal(company.financials.revenue.value, 2_277_793);
  assert.ok(company.provider.includes("Aziende.it"));
  assert.ok(company.provider.includes("Xray Finance"));

  const evaluation = evaluateFinancialProfile(company, {
    now: new Date(2026, 8, 23)
  });
  assert.equal(evaluation.requirements.atLeastTwoFiledBalances, true);
  assert.notEqual(describeFinancialProfile(evaluation).key, "limited");
});

test("fixture: MPS Monitor retains the latest three RegistroAziende balances", async () => {
  const html = await loadFixture("registro/mps-monitor.html");
  const company = parseRegistroAziendeText(htmlToText(html), {
    url: "https://registroaziende.it/azienda/mps-monitor-srl"
  });

  assert.equal(company.vat, "03122040987");
  assert.deepEqual(
    company.financials.balanceHistory.map((row) => row.year),
    [2025, 2024, 2023]
  );
  assert.equal(company.financials.balanceHistory[0].revenue, 5_548_281);
  assert.equal(company.financials.balanceHistory[0].profit, 2_383_651);
});

test("fixture: third-party company on Xray profile is not classified as site owner", async () => {
  const html = await loadFixture("pages/xray-third-party-profile.html");
  const pageContext = pageContextFromFixture(html);

  const assessment = assessVatMatch({
    candidate: {
      vat: "11295150152",
      source: "dati strutturati",
      evidenceType: "vat_structured"
    },
    company: {
      name: "FUTURE TECH SRL",
      vat: "11295150152"
    },
    pageContext
  });

  assert.equal(pageContext.hostname, "xrayfinance.it");
  assert.deepEqual(pageContext.brandHints, ["Xray Finance"]);
  assert.equal(assessment.status, "unidentified");
  assert.ok(assessment.score < 65);
});

test("fixture: Creditsafe app subdomain remains a cautious domain match", async () => {
  const html = await loadFixture("pages/creditsafe-app.html");
  const page = pageContextFromFixture(html);
  const domain = buildDomainLookupContext({
    hostname: page.hostname,
    title: page.title,
    siteName: page.siteName,
    brandHints: page.brandHints
  });

  const assessment = assessDomainCompanyMatch({
    company: {
      name: "CREDITSAFE ITALIA SRL",
      vat: "07589380968"
    },
    pageContext: {
      hostname: page.hostname,
      title: page.title,
      brandHints: domain.brandHints
    }
  });

  assert.equal(domain.registrableDomain, "creditsafe.com");
  assert.equal(domain.rootLabel, "creditsafe");
  assert.equal(domain.subdomain, "app");
  assert.equal(assessment.status, "possible");
  assert.ok(assessment.score >= 65);
  assert.ok(assessment.score <= 89);
});

test("fixture: explicit corporate footer VAT remains strong ownership evidence", async () => {
  const html = await loadFixture("pages/corporate-footer.html");
  const pageContext = pageContextFromFixture(html);
  const footer = extractFooterText(html);

  assert.match(footer, /P\.IVA 11295150152/);

  const assessment = assessVatMatch({
    candidate: {
      vat: "11295150152",
      source: "footer/area legale",
      evidenceType: "vat_legal",
      context: footer
    },
    company: {
      name: "FUTURE TECH SRL",
      vat: "11295150152"
    },
    pageContext
  });

  assert.equal(assessment.status, "identified");
  assert.ok(assessment.score >= 90);
});
