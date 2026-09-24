import test from "node:test";
import assert from "node:assert/strict";

import { scanCurrentPage } from "../src/scanner.js";

test("directory structured entities do not block owner VAT from textual footer", (t) => {
  const previousDocument = globalThis.document;
  const previousLocation = globalThis.location;

  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;

    if (previousLocation === undefined) delete globalThis.location;
    else globalThis.location = previousLocation;
  });

  const bodyText = [
    "Il fatturato delle aziende italiane.",
    "SI VOLA SRL - P.IVA 11295150152",
    "Aziende.it - Ad Intend Srl",
    "Sede Legale: Via Jacopo dal Verme, 7, 20159 Milano MI",
    "P.iva 02357550066"
  ].join("\n");

  globalThis.location = {
    href: "https://www.aziende.it/",
    origin: "https://www.aziende.it",
    hostname: "www.aziende.it",
    pathname: "/",
    search: ""
  };

  globalThis.document = {
    title: "Aziende.it - Il fatturato delle aziende italiane",
    body: {
      innerText: bodyText,
      textContent: bodyText
    },
    documentElement: {
      innerText: bodyText,
      textContent: bodyText
    },
    querySelector(selector) {
      if (selector === "h1") {
        return { textContent: "Il fatturato delle aziende italiane." };
      }
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'script[type="application/ld+json"]') {
        return [{
          textContent: JSON.stringify({
            "@type": "Organization",
            name: "SI VOLA SRL",
            taxID: "11295150152"
          })
        }];
      }

      return [];
    }
  };

  const scan = scanCurrentPage();

  assert.equal(scan.diagnostics.looksLikeSearchOrDirectoryPage, true);
  assert.equal(scan.candidates.length, 1);
  assert.equal(scan.candidates[0].vat, "02357550066");
  assert.equal(scan.candidates[0].evidenceType, "vat_footer_text");
  assert.ok(!scan.candidates.some((candidate) => candidate.vat === "11295150152"));
});
