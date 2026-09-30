import test from "node:test";
import assert from "node:assert/strict";

import {
  extractAnnualRevenues,
  findAziendeCompanyByVat,
  isAziendeChallenge,
  parseAziendeProfileText,
  parseAziendeSearchResults,
  parseItalianNumber,
  parseSectorBenchmark,
  shouldCacheAziendeMiss
} from "../src/providers/aziende.js";
import { htmlToText, loadFixture } from "./helpers/fixtures.mjs";

const BASE_URL = "https://www.aziende.it";
const VAT = "11941480961";
const PROFILE_URL = `${BASE_URL}/mediane-italia-s-r-l-socio-unico`;
const COOLDOWN_KEY = "aziende:v1:cooldown";
const cacheKey = (vat) => `aziende:v1:vat:${vat}`;
const searchUrl = (vat) => `${BASE_URL}/search?q=${vat}`;

function createStorage(initial = {}) {
  const entries = { ...initial };

  return {
    entries,
    async get(key) {
      return Object.hasOwn(entries, key) ? { [key]: entries[key] } : {};
    },
    async set(patch) {
      Object.assign(entries, patch);
    }
  };
}

function htmlResponse(body, { status = 200, url = "", contentType = "text/html; charset=utf-8" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get: (name) => (String(name).toLowerCase() === "content-type" ? contentType : null)
    },
    async text() {
      return body;
    }
  };
}

// Installs fake fetch/storage and returns the recorded request URLs.
function installEnvironment(t, handler, storage = createStorage()) {
  const previousChrome = globalThis.chrome;
  const previousFetch = globalThis.fetch;
  const calls = [];

  t.after(() => {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;

    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  });

  globalThis.chrome = { storage: { local: storage } };
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    return handler(String(url), options);
  };

  return calls;
}

test("parses Italian amounts written with dot and comma separators", () => {
  assert.equal(parseItalianNumber("191.540"), 191540);
  assert.equal(parseItalianNumber("1.234.567,89"), 1234567.89);
  assert.equal(parseItalianNumber("1,090"), 1090);
  assert.equal(parseItalianNumber("392.007 euro"), 392007);
  assert.equal(parseItalianNumber("51,3"), 51.3);
  assert.equal(parseItalianNumber("3.5"), 3.5);
  assert.equal(parseItalianNumber(""), null);
  assert.equal(parseItalianNumber("-77.983"), -77983);
});

test("reads the year-labelled annual revenue from the profile KPI", async () => {
  const html = await loadFixture("aziende-profile.html");

  assert.deepEqual(extractAnnualRevenues(htmlToText(html)), [
    { year: 2024, revenue: 191540 }
  ]);
});

test("parses the sector benchmark sentence", async () => {
  const html = await loadFixture("aziende-profile.html");

  assert.deepEqual(parseSectorBenchmark(htmlToText(html)), {
    companyRevenue: 191540,
    medianRevenue: 392007,
    province: "TO",
    sampleSize: 1090,
    year: null
  });
});

test("normalizes the observed sector comparison and ties it to the annual year", async () => {
  const html = await loadFixture("aziende-profile.html");

  const company = parseAziendeProfileText(htmlToText(html), {
    name: "MEDIANE ITALIA S.R.L. SOCIO UNICO IN LIQUIDAZIONE",
    title: "Mediane Italia S.r.l. Socio Unico In Liquidazione - P.IVA 11941480961",
    url: PROFILE_URL
  });

  assert.equal(company.provider, "Aziende.it");
  assert.equal(company.providerUrl, PROFILE_URL);
  assert.equal(company.vat, VAT);
  assert.equal(company.name, "MEDIANE ITALIA S.R.L. SOCIO UNICO IN LIQUIDAZIONE");
  assert.deepEqual(company.sectorComparison, {
    companyRevenue: 191540,
    medianRevenue: 392007,
    year: 2024,
    province: "TO",
    sampleSize: 1090,
    differencePct: -51.14,
    sourceName: "Aziende.it",
    sourceUrl: PROFILE_URL
  });
});

test("supports comma decimals, thousands dots and a median below the company", () => {
  const text = [
    "ACME S.R.L.",
    "P.IVA 11295150152",
    "€ 1.234.567,89",
    "Fatturato 2024",
    "Il fatturato di Acme S.r.l. (1.234.567,89 euro) è superiore alla mediana delle aziende dello stesso settore in provincia di MI (1.000.000,00 euro), calcolata su 2.500 imprese."
  ].join("\n");

  const company = parseAziendeProfileText(text, { url: `${BASE_URL}/acme-s-r-l` });

  assert.equal(company.sectorComparison.companyRevenue, 1234567.89);
  assert.equal(company.sectorComparison.medianRevenue, 1000000);
  assert.equal(company.sectorComparison.sampleSize, 2500);
  assert.equal(company.sectorComparison.year, 2024);
  assert.equal(company.sectorComparison.differencePct, 23.46);
});

test("keeps the year null when the benchmark figure matches no year-labelled revenue", async () => {
  const html = await loadFixture("aziende-profile-no-year.html");
  const url = `${BASE_URL}/acme-servizi-s-r-l`;

  const company = parseAziendeProfileText(htmlToText(html), { url });

  assert.equal(company.vat, "11295150152");
  assert.deepEqual(company.sectorComparison, {
    companyRevenue: 640000,
    medianRevenue: 800000,
    year: null,
    province: "MI",
    sampleSize: null,
    differencePct: null,
    sourceName: "Aziende.it",
    sourceUrl: url
  });
});

test("returns a null sector comparison when the profile has no benchmark", () => {
  const company = parseAziendeProfileText(
    "ACME S.R.L.\nP.IVA 11295150152\n€ 100.000\nFatturato 2024",
    { url: `${BASE_URL}/acme-s-r-l` }
  );

  assert.equal(company.vat, "11295150152");
  assert.equal(company.sectorComparison, null);
});

test("ignores pages without a VAT", () => {
  assert.equal(parseAziendeProfileText("0 aziende trovate."), null);
});

test("reads same-origin profile candidates from the search page", async () => {
  const html = await loadFixture("aziende-search.html");

  assert.deepEqual(parseAziendeSearchResults(html), [PROFILE_URL]);
});

test("resolves a company by VAT through the public search", async (t) => {
  const search = await loadFixture("aziende-search.html");
  const profile = await loadFixture("aziende-profile.html");

  const calls = installEnvironment(t, (url) => {
    if (url === searchUrl(VAT)) return htmlResponse(search, { url });
    if (url === PROFILE_URL) return htmlResponse(profile, { url });
    throw new Error(`unexpected request: ${url}`);
  });

  const company = await findAziendeCompanyByVat(VAT, {
    names: ["MEDIANE ITALIA S.R.L."]
  });

  assert.deepEqual(calls, [searchUrl(VAT), PROFILE_URL]);
  assert.equal(company.provider, "Aziende.it");
  assert.equal(company.vat, VAT);
  assert.equal(company.providerUrl, PROFILE_URL);
  assert.equal(company.name, "MEDIANE ITALIA S.R.L. SOCIO UNICO IN LIQUIDAZIONE");
  assert.equal(company.sectorComparison.province, "TO");
  assert.equal(company.sectorComparison.sampleSize, 1090);
  assert.equal(company.sectorComparison.year, 2024);
  assert.equal(company.sectorComparison.differencePct, -51.14);
});

test("rejects a profile whose VAT does not match the requested one", async (t) => {
  const target = "11295150152";
  const search = await loadFixture("aziende-search.html");
  const profile = await loadFixture("aziende-profile.html");

  const calls = installEnvironment(t, (url) => {
    if (url === searchUrl(target)) return htmlResponse(search, { url });
    if (url === PROFILE_URL) return htmlResponse(profile, { url });
    throw new Error(`unexpected request: ${url}`);
  });

  assert.equal(await findAziendeCompanyByVat(target), null);
  assert.deepEqual(calls, [searchUrl(target), PROFILE_URL]);
});

test("stops on a 403 and serves the cached cooldown without retrying", async (t) => {
  const blocked = await loadFixture("aziende-blocked.html");
  const storage = createStorage();

  const calls = installEnvironment(
    t,
    () => htmlResponse(blocked, { status: 403, url: searchUrl(VAT) }),
    storage
  );

  assert.equal(await findAziendeCompanyByVat(VAT), null);
  assert.equal(await findAziendeCompanyByVat(VAT), null);

  assert.deepEqual(calls, [searchUrl(VAT)]);
  assert.ok(storage.entries[COOLDOWN_KEY].value.until > Date.now());
  assert.equal(storage.entries[cacheKey(VAT)], undefined);
});

test("stops on a 429 without retrying", async (t) => {
  const storage = createStorage();
  const calls = installEnvironment(
    t,
    () => htmlResponse("Too many requests", { status: 429, url: searchUrl(VAT), contentType: "text/plain" }),
    storage
  );

  assert.equal(await findAziendeCompanyByVat(VAT), null);
  assert.deepEqual(calls, [searchUrl(VAT)]);
  assert.ok(storage.entries[COOLDOWN_KEY]);
});

test("treats a 200 challenge page as a block and cools down", async (t) => {
  const blocked = await loadFixture("aziende-blocked.html");
  const storage = createStorage();

  const calls = installEnvironment(
    t,
    () => htmlResponse(blocked, { status: 200, url: searchUrl(VAT) }),
    storage
  );

  assert.equal(await findAziendeCompanyByVat(VAT), null);
  assert.deepEqual(calls, [searchUrl(VAT)]);
  assert.ok(storage.entries[COOLDOWN_KEY]);

  assert.equal(isAziendeChallenge(200, blocked), true);
  assert.equal(isAziendeChallenge(403, ""), true);
  assert.equal(isAziendeChallenge(429, ""), true);
  assert.equal(isAziendeChallenge(200, "<html><body>Risultati della ricerca</body></html>"), false);
  assert.equal(isAziendeChallenge(404, "<html><body>Pagina non trovata</body></html>"), false);
});

test("deduplicates concurrent lookups for the same VAT", async (t) => {
  const search = await loadFixture("aziende-search.html");
  const profile = await loadFixture("aziende-profile.html");

  const calls = installEnvironment(t, (url) => {
    if (url === searchUrl(VAT)) return htmlResponse(search, { url });
    if (url === PROFILE_URL) return htmlResponse(profile, { url });
    throw new Error(`unexpected request: ${url}`);
  });

  const [first, second] = await Promise.all([
    findAziendeCompanyByVat(VAT),
    findAziendeCompanyByVat(VAT)
  ]);

  assert.equal(first, second);
  assert.deepEqual(calls, [searchUrl(VAT), PROFILE_URL]);
});

test("caches a positive result and reuses it without network", async (t) => {
  const search = await loadFixture("aziende-search.html");
  const profile = await loadFixture("aziende-profile.html");
  const storage = createStorage();

  const calls = installEnvironment(
    t,
    (url) => {
      if (url === searchUrl(VAT)) return htmlResponse(search, { url });
      if (url === PROFILE_URL) return htmlResponse(profile, { url });
      throw new Error(`unexpected request: ${url}`);
    },
    storage
  );

  const first = await findAziendeCompanyByVat(VAT);
  const second = await findAziendeCompanyByVat(VAT);

  assert.deepEqual(calls, [searchUrl(VAT), PROFILE_URL]);
  assert.equal(second.vat, VAT);
  assert.deepEqual(second.sectorComparison, first.sectorComparison);
});

test("refreshes a positive result older than its TTL", async (t) => {
  const search = await loadFixture("aziende-search.html");
  const profile = await loadFixture("aziende-profile.html");
  const stale = createStorage({
    [cacheKey(VAT)]: {
      cachedAt: Date.now() - 25 * 60 * 60 * 1000,
      value: { provider: "Aziende.it", vat: VAT, sectorComparison: null }
    }
  });

  const calls = installEnvironment(
    t,
    (url) => {
      if (url === searchUrl(VAT)) return htmlResponse(search, { url });
      if (url === PROFILE_URL) return htmlResponse(profile, { url });
      throw new Error(`unexpected request: ${url}`);
    },
    stale
  );

  const company = await findAziendeCompanyByVat(VAT);

  assert.deepEqual(calls, [searchUrl(VAT), PROFILE_URL]);
  assert.equal(company.sectorComparison.year, 2024);
});

test("stores an empty search as a short-lived miss", async (t) => {
  const empty =
    "<html><head><title>Risultati della ricerca</title></head><body><p><b>0</b> aziende trovate.</p></body></html>";
  const storage = createStorage();

  const calls = installEnvironment(
    t,
    () => htmlResponse(empty, { url: searchUrl(VAT) }),
    storage
  );

  assert.equal(await findAziendeCompanyByVat(VAT), null);
  assert.equal(await findAziendeCompanyByVat(VAT), null);

  assert.deepEqual(calls, [searchUrl(VAT)]);
  assert.equal(storage.entries[cacheKey(VAT)].value, null);
});

test("retries a miss once the short negative TTL expired", async (t) => {
  const empty =
    "<html><head><title>Risultati della ricerca</title></head><body><p><b>0</b> aziende trovate.</p></body></html>";
  const storage = createStorage({
    [cacheKey(VAT)]: {
      cachedAt: Date.now() - 11 * 60 * 1000,
      value: null
    }
  });

  const calls = installEnvironment(
    t,
    () => htmlResponse(empty, { url: searchUrl(VAT) }),
    storage
  );

  assert.equal(await findAziendeCompanyByVat(VAT), null);
  assert.deepEqual(calls, [searchUrl(VAT)]);
});

test("fetches at most three same-origin profile candidates", async (t) => {
  const rows = [1, 2, 3, 4, 5]
    .map((index) => `<tr><td><a class="rg-co" href="/societa-${index}-s-r-l">SOCIETA ${index} S.R.L.</a></td></tr>`)
    .join("");
  const search =
    `<html><body><table class="rg-reg">${rows}` +
    '<tr><td><a class="rg-co" href="https://evil.example/societa-x">X</a></td></tr>' +
    '<tr><td><a class="rg-co" href="//other.example/societa-y">Y</a></td></tr>' +
    "</table></body></html>";
  const profile = await loadFixture("aziende-profile-no-year.html");

  const calls = installEnvironment(t, (url) => {
    if (url === searchUrl(VAT)) return htmlResponse(search, { url });
    return htmlResponse(profile, { url });
  });

  assert.equal(await findAziendeCompanyByVat(VAT), null);

  const profileCalls = calls.filter((url) => url !== searchUrl(VAT));
  assert.equal(profileCalls.length, 3);
  assert.deepEqual(profileCalls, [
    `${BASE_URL}/societa-1-s-r-l`,
    `${BASE_URL}/societa-2-s-r-l`,
    `${BASE_URL}/societa-3-s-r-l`
  ]);
  assert.ok(calls.every((url) => url.startsWith(BASE_URL)));
});

test("tolerates a missing options argument", async (t) => {
  const calls = installEnvironment(
    t,
    () => htmlResponse("<html><body>404</body></html>", { status: 404, url: searchUrl(VAT) })
  );

  assert.equal(await findAziendeCompanyByVat(VAT, null), null);
  assert.deepEqual(calls, [searchUrl(VAT)]);
});

test("never propagates network errors", async (t) => {
  installEnvironment(t, () => {
    throw new Error("offline");
  });

  assert.equal(await findAziendeCompanyByVat(VAT), null);
});

test("ignores invalid VATs without any request", async (t) => {
  const calls = installEnvironment(t, () => {
    throw new Error("unexpected request");
  });

  assert.equal(await findAziendeCompanyByVat("12345"), null);
  assert.equal(await findAziendeCompanyByVat(""), null);
  assert.equal(await findAziendeCompanyByVat(null), null);
  assert.deepEqual(calls, []);
});

test("does not follow a search-result redirect to an untrusted host", async (t) => {
  const search = await loadFixture("aziende-search.html");
  const profile = await loadFixture("aziende-profile.html");
  const storage = createStorage();
  const calls = installEnvironment(t, (url, options) => {
    if (url === searchUrl(VAT)) return htmlResponse(search, { url });
    if (options?.redirect === "follow") {
      return htmlResponse(profile, { url: "https://untrusted.example/company" });
    }
    return htmlResponse("", { status: 302, url });
  }, storage);

  assert.equal(await findAziendeCompanyByVat(VAT), null);
  assert.deepEqual(calls, [searchUrl(VAT), PROFILE_URL]);
  assert.equal(storage.entries[cacheKey(VAT)], undefined);
});

test("does not cache a transient profile error as a missing company", async (t) => {
  const search = await loadFixture("aziende-search.html");
  const profile = await loadFixture("aziende-profile.html");
  const storage = createStorage();
  let profileCalls = 0;
  const calls = installEnvironment(t, (url) => {
    if (url === searchUrl(VAT)) return htmlResponse(search, { url });
    profileCalls += 1;
    return profileCalls === 1
      ? htmlResponse("temporarily unavailable", { status: 503, url })
      : htmlResponse(profile, { url });
  }, storage);

  assert.equal(await findAziendeCompanyByVat(VAT), null);
  assert.equal(storage.entries[cacheKey(VAT)], undefined);
  assert.equal((await findAziendeCompanyByVat(VAT))?.sectorComparison?.medianRevenue, 392007);
  assert.deepEqual(calls, [searchUrl(VAT), PROFILE_URL, searchUrl(VAT), PROFILE_URL]);
});

test("stores only durable misses", () => {
  assert.equal(shouldCacheAziendeMiss(404), true);
  assert.equal(shouldCacheAziendeMiss(410), true);
  assert.equal(shouldCacheAziendeMiss(403), false);
  assert.equal(shouldCacheAziendeMiss(429), false);
  assert.equal(shouldCacheAziendeMiss(500), false);
});
