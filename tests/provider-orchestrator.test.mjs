import test from "node:test";
import assert from "node:assert/strict";

import { createSnapshotStore } from "../src/background/provider-snapshot.js";
import { htmlToText, loadFixture } from "./helpers/fixtures.mjs";

/* ---------------------------------------------------------------------------
 * Integration harness
 *
 * `resolveCompanyProviders` runs against the real providers, the real parsers,
 * the real snapshot store and fixture pages. Only the extension APIs, the DOM
 * and the clock are faked, so a lookup can be deferred past its budget without
 * waiting for real time.
 * ------------------------------------------------------------------------- */

const VAT = "05488440651";
const NAMES = ["RUBINO - S.R.L."];
const PROVIDER_HOSTS = {
  companyReports: "https://www.companyreports.it",
  registro: "https://registroaziende.it/azienda",
  xray: "https://xrayfinance.it",
  aziende: "https://www.aziende.it"
};
const AZIENDE_PROFILE_SLUG = `rubino-s-r-l-${VAT}`;
const AZIENDE_PROFILE_URL = `${PROVIDER_HOSTS.aziende}/${AZIENDE_PROFILE_SLUG}`;
const AZIENDE_SEARCH_URL =
  `${PROVIDER_HOSTS.aziende}/search?q=${encodeURIComponent(VAT)}`;

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&euro;/gi, "€")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function cleanText(value) {
  return htmlToText(value).replace(/\s+/g, " ").trim();
}

function createExtensionStorage(initial = {}) {
  let entries = { ...initial };

  return {
    get entries() {
      return entries;
    },
    clear() {
      entries = {};
    },
    async get(key) {
      if (Array.isArray(key)) {
        const result = {};
        for (const name of key) {
          if (Object.hasOwn(entries, name)) result[name] = entries[name];
        }
        return result;
      }
      return Object.hasOwn(entries, key) ? { [key]: entries[key] } : {};
    },
    async set(patch) {
      Object.assign(entries, patch);
    }
  };
}

function createNetwork() {
  const calls = [];
  const unrouted = [];
  const routes = new Map();
  const prefixes = [];

  return {
    calls,
    unrouted,
    route(url, handler) {
      routes.set(String(url), handler);
    },
    routePrefix(prefix, handler) {
      prefixes.push({ prefix: String(prefix), handler });
    },
    reset() {
      calls.length = 0;
      unrouted.length = 0;
      routes.clear();
      prefixes.length = 0;
    },
    install() {
      globalThis.fetch = async (url, options = {}) => {
        const href = String(url);
        calls.push(href);

        const handler = routes.get(href) ||
          prefixes.find((entry) => href.startsWith(entry.prefix))?.handler;

        if (!handler) {
          unrouted.push(href);
          return htmlResponse("", { status: 404, url: href });
        }

        return handler(href, options);
      };
    }
  };
}

function htmlResponse(body, {
  status = 200,
  url = "",
  contentType = "text/html; charset=utf-8"
} = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get: (name) => (
        String(name).toLowerCase() === "content-type" ? contentType : null
      )
    },
    async text() {
      return body;
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((settle) => {
    resolve = settle;
  });

  return { promise, resolve };
}

// Minimal DOM: the providers only need a body text, a few tag lookups and
// attribute access. Selectors with descendant combinators throw on purpose so
// the Aziende.it reader keeps using its own markup fallback.
function createDomNode(tagName, attributes, innerHtml) {
  return {
    tagName: String(tagName).toUpperCase(),
    getAttribute(name) {
      const key = String(name).toLowerCase();
      return Object.hasOwn(attributes, key) ? attributes[key] : null;
    },
    get id() {
      return attributes.id || "";
    },
    get name() {
      return attributes.name || "";
    },
    get value() {
      return attributes.value || "";
    },
    disabled: false,
    checked: false,
    closest() {
      return null;
    },
    querySelectorAll(selector) {
      return selectDomElements(innerHtml, selector);
    },
    querySelector(selector) {
      return selectDomElements(innerHtml, selector)[0] || null;
    },
    get textContent() {
      return cleanText(innerHtml);
    },
    get innerText() {
      return htmlToText(innerHtml);
    }
  };
}

function parseAttributes(source) {
  const attributes = {};

  for (const match of String(source || "").matchAll(
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  )) {
    attributes[match[1].toLowerCase()] =
      decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }

  return attributes;
}

function selectDomElements(html, selector) {
  const source = String(html || "");
  const matches = [];

  for (const part of String(selector).split(",").map((value) => value.trim())) {
    if (!part) continue;
    if (/\s/.test(part)) {
      throw new Error(`unsupported selector: ${part}`);
    }

    const parsed = /^([a-zA-Z][\w-]*)?(#[\w-]+)?((?:\.[\w-]+)*)((?:\[[^\]]*\])*)$/
      .exec(part);
    if (!parsed) throw new Error(`unsupported selector: ${part}`);

    const [, tag, id, classList, attributePart] = parsed;
    const classes = String(classList || "").split(".").filter(Boolean);
    const attributes = [...String(attributePart || "").matchAll(
      /\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'))?\]/g
    )].map((match) => ({
      name: match[1].toLowerCase(),
      value: match[2] ?? match[3] ?? null
    }));

    const tagPattern = tag || "[a-zA-Z][\\w-]*";
    const pattern = new RegExp(
      `<(${tagPattern})\\b([^>]*)>([\\s\\S]*?)</\\1\\s*>`,
      "gi"
    );

    for (const match of source.matchAll(pattern)) {
      const parsedAttributes = parseAttributes(match[2]);
      if (id && parsedAttributes.id !== id.slice(1)) continue;
      if (classes.some((name) => !(parsedAttributes.class || "").split(/\s+/).includes(name))) {
        continue;
      }
      if (attributes.some((attribute) =>
        !Object.hasOwn(parsedAttributes, attribute.name) ||
        (attribute.value !== null && parsedAttributes[attribute.name] !== attribute.value)
      )) {
        continue;
      }

      matches.push(createDomNode(match[1], parsedAttributes, match[3]));
    }
  }

  return matches;
}

class FakeDOMParser {
  parseFromString(html, type = "text/html") {
    if (type !== "text/html") throw new Error(`unsupported type: ${type}`);

    const source = String(html ?? "");
    const bodyMatch = /<body\b([^>]*)>([\s\S]*?)<\/body\s*>/i.exec(source);
    const body = createDomNode(
      "body",
      parseAttributes(bodyMatch ? bodyMatch[1] : ""),
      bodyMatch ? bodyMatch[2] : source
    );
    const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(source);

    return {
      title: titleMatch ? cleanText(titleMatch[1]) : "",
      body,
      querySelector: (selector) => body.querySelector(selector),
      querySelectorAll: (selector) => body.querySelectorAll(selector)
    };
  }
}

// A controllable clock: `advance` fires only the timers that are due, in
// order, and flushes the microtasks in between.
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let activeClock = null;

// A test that times out is not interrupted, so its clock would leak into the
// next one: `startClock` always restores the previous clock first.
function startClock() {
  activeClock?.restore();
  activeClock = createClock();
  return activeClock;
}

function createClock() {
  let now = 0;
  let sequence = 0;
  const timers = new Map();

  globalThis.setTimeout = (callback, delay = 0, ...args) => {
    const id = `timer-${++sequence}`;
    timers.set(id, {
      at: now + Math.max(0, Number(delay) || 0),
      callback,
      args
    });
    return id;
  };

  globalThis.clearTimeout = (id) => {
    timers.delete(id);
  };

  const settle = async () => {
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    await new Promise((resolve) => realSetTimeout(resolve, 0));
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
  };

  return {
    get now() {
      return now;
    },
    settle,
    async advance(milliseconds) {
      const target = now + milliseconds;

      // Timers may only be scheduled once the pending work runs, so the window
      // keeps being re-examined until it settles.
      for (let pass = 0; pass < 1000; pass += 1) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];

        if (next) {
          const [id, timer] = next;
          timers.delete(id);
          now = Math.max(now, timer.at);
          timer.callback(...timer.args);
          await settle();
          continue;
        }

        const before = timers.size;
        await settle();

        const due = [...timers.values()].some((timer) => timer.at <= target);
        if (!due && timers.size === before) break;
      }

      now = target;
      await settle();
    },
    restore() {
      globalThis.setTimeout = realSetTimeout;
      globalThis.clearTimeout = realClearTimeout;
      timers.clear();
    }
  };
}

const extensionStorage = createExtensionStorage();
const snapshotStore = createSnapshotStore(extensionStorage);
const network = createNetwork();

globalThis.chrome = {
  permissions: { contains: (_details, callback) => callback(true) },
  runtime: {
    sendMessage(message, callback) {
      Promise.resolve()
        .then(async () => {
          if (message?.type === "providerSnapshot.read") {
            return { ok: true, value: await snapshotStore.read(message.vat) };
          }
          if (message?.type === "providerSnapshot.write") {
            await snapshotStore.write(message.vat, message.result);
            return { ok: true };
          }
          return { ok: false };
        })
        .then((response) => callback?.(response))
        .catch((error) => callback?.({ ok: false, error: String(error) }));
    }
  },
  storage: { local: extensionStorage }
};

globalThis.DOMParser = FakeDOMParser;
network.install();

// The provider modules read `globalThis.chrome` at module scope, so they are
// loaded only after the extension APIs above exist.
const {
  compareProviderData,
  financialHistoryNeedsRefresh,
  mergeBalanceHistories,
  mergeProviderResultState,
  missingProviderRefreshPlan,
  needsFallback,
  previousBalanceRows,
  promoteLatestFinancialYear,
  resolveAziendeEnrichment,
  resolveCompanyProviders,
  selectCanonicalPrimary
} = await import("../src/providers/orchestrator.js");

const { findXrayCompanyByVat, buildXraySlugCandidates } = await import(
  "../src/providers/xray.js"
);
const { buildRegistroSlugCandidates } = await import(
  "../src/providers/registroaziende.js"
);
// The real popup consumer of `pendingUpdates`, so the integration tests can
// prove the one-open completion indicator and the patch/render order.
const { createDataCompletionTracker, watchProviderUpdates } = await import(
  "../src/popup/data-completion.js"
);

const FIXTURES = {
  companyReports: await loadFixture("companyreports/rubino.html"),
  registro: await loadFixture("registro/rubino.html"),
  xray: await loadFixture("xray/rubino.html"),
  aziendeProfile: (await loadFixture("aziende-profile.html"))
    .replaceAll("11941480961", VAT)
};
const AZIENDE_SEARCH_HTML =
  "<html><body><table class=\"rg-reg\"><tr><td>" +
  `<a class="rg-co" href="/${AZIENDE_PROFILE_SLUG}">` +
  "RUBINO - S.R.L.</a></td></tr></table></body></html>";

const companyReportsUrl = `${PROVIDER_HOSTS.companyReports}/${VAT}`;
const xrayUrlFor = (names) =>
  `${PROVIDER_HOSTS.xray}/${encodeURIComponent(buildXraySlugCandidates(names)[0])}`;
const registroUrlsFor = (names, cityHints = []) =>
  buildRegistroSlugCandidates(names, cityHints).map(
    (slug) => `${PROVIDER_HOSTS.registro}/${encodeURIComponent(slug)}`
  );

function installFixtureProviders({ names, cityHints = [] }) {
  network.route(companyReportsUrl, () =>
    htmlResponse(FIXTURES.companyReports, { url: companyReportsUrl })
  );

  for (const url of registroUrlsFor(names, cityHints)) {
    network.route(url, () => htmlResponse(FIXTURES.registro, { url }));
  }

  const xrayUrl = xrayUrlFor(names);
  network.route(xrayUrl, () =>
    htmlResponse(FIXTURES.xray, { url: xrayUrl })
  );

  network.route(AZIENDE_SEARCH_URL, () =>
    htmlResponse(AZIENDE_SEARCH_HTML, { url: AZIENDE_SEARCH_URL })
  );
  network.route(AZIENDE_PROFILE_URL, () =>
    htmlResponse(FIXTURES.aziendeProfile, { url: AZIENDE_PROFILE_URL })
  );
}

function createRejectionTracker(t) {
  const rejections = [];
  const listener = (reason) => rejections.push(reason);

  process.on("unhandledRejection", listener);
  t.after(() => process.off("unhandledRejection", listener));

  return rejections;
}

// `resolveCompanyProviders` now exposes every still-running lookup as a
// progressive pending update instead of the old background* promise fields.
function pendingUpdatesFor(result, provider) {
  return (result?.pendingUpdates || []).filter(
    (entry) => entry.provider === provider
  );
}

function pendingPromiseFor(result, provider) {
  return pendingUpdatesFor(result, provider)[0]?.promise ?? null;
}

test("provider verification accepts matching financial data", () => {
  const primary = {
    vat: "11295150152",
    status: "Attiva",
    ateco: { code: "46.50.1" },
    financials: {
      revenue: { value: 1_992_222, year: 2024 },
      profit: { value: 236_014, year: 2024 },
      balanceHistory: [
        { year: 2024, revenue: 1_992_222, profit: 236_014 },
        { year: 2023, revenue: 1_635_153, profit: 173_389 }
      ]
    }
  };

  const verifier = {
    vat: "11295150152",
    status: "Attiva",
    financials: {
      revenue: { value: 1_992_222, year: 2024 },
      profit: { value: 236_014, year: 2024 }
    }
  };

  const result = compareProviderData(primary, verifier);
  assert.equal(result.verified, true);
  assert.deepEqual(result.conflicts, []);
});

test("provider verification flags material revenue conflict", () => {
  const primary = {
    vat: "11295150152",
    status: "Attiva",
    financials: {
      revenue: { value: 1_992_222, year: 2024 }
    }
  };

  const verifier = {
    vat: "11295150152",
    status: "Attiva",
    financials: {
      revenue: { value: 1_700_000, year: 2024 }
    }
  };

  const result = compareProviderData(primary, verifier);
  assert.ok(result.conflicts.includes("revenue"));
  assert.equal(result.verified, false);
});

test("fresh complete primary provider does not require blocking fallback", () => {
  assert.equal(needsFallback({
    status: "Attiva",
    ateco: { code: "46.50.1" },
    financials: {
      revenue: { value: 1_820_000, year: 2025 },
      profit: { value: 266_000, year: 2025 },
      balanceHistory: [
        { year: 2025 },
        { year: 2024 }
      ]
    }
  }, {
    now: new Date(2026, 8, 23)
  }), false);
});

test("missing balance history triggers fallback", () => {
  assert.equal(needsFallback({
    status: "Attiva",
    ateco: { code: "46.50.1" },
    financials: {
      revenue: { value: 1_992_222, year: 2024 },
      profit: { value: 236_014, year: 2024 },
      balanceHistory: []
    }
  }), true);
});


test("CompanyReports.it remains canonical when RegistroAziende is also available", () => {
  const companyReports = {
    provider: "CompanyReports.it",
    vat: "11295150152",
    rea: "MI-1453877",
    pec: "futuretech@pec.example"
  };
  const registro = {
    provider: "RegistroAziende.it",
    vat: "11295150152"
  };

  assert.equal(
    selectCanonicalPrimary(companyReports, registro),
    companyReports
  );
});

test("RegistroAziende is used only when canonical CompanyReports.it is unavailable", () => {
  const registro = {
    provider: "RegistroAziende.it",
    vat: "11295150152"
  };

  assert.equal(selectCanonicalPrimary(null, registro), registro);
});


test("merges balance years from canonical and fallback providers", () => {
  const merged = mergeBalanceHistories(
    [
      { year: 2024, revenue: 1_992_222, profit: 236_014 },
      { year: 2022, revenue: 1_765_110, profit: 166_073 },
      { year: 2021, revenue: 1_930_000, profit: null }
    ],
    [
      { year: 2024, revenue: 1_990_000, profit: 236_010 },
      { year: 2023, revenue: 1_635_153, profit: 173_389 },
      { year: 2022, revenue: 1_760_000, profit: 166_000 }
    ]
  );

  assert.deepEqual(merged.map((item) => item.year), [2024, 2023, 2022, 2021]);
  assert.equal(merged[0].revenue, 1_992_222);
  assert.equal(merged[2].revenue, 1_765_110);
  assert.equal(merged[1].revenue, 1_635_153);
});

test("history accordion excludes the current headline year", () => {
  const rows = previousBalanceRows(
    [
      { year: 2024, revenue: 1_992_222 },
      { year: 2023, revenue: 1_635_153 },
      { year: 2022, revenue: 1_765_110 },
      { year: 2021, revenue: 1_930_000 }
    ],
    2024,
    3
  );

  assert.deepEqual(rows.map((item) => item.year), [2023, 2022, 2021]);
});


test("newer verified year becomes the headline financial year", () => {
  const financials = promoteLatestFinancialYear({
    revenue: { value: 1_992_222, year: 2024 },
    profit: { value: 236_014, year: 2024 },
    employees: { value: 3, display: "3", year: null },
    netMargin: 11.8,
    revenuePerEmployee: 664074,
    balanceHistory: [
      { year: 2025, revenue: 1_820_000, profit: 266_000 },
      { year: 2024, revenue: 1_992_222, profit: 236_014 },
      { year: 2023, revenue: 1_635_153, profit: 173_389 },
      { year: 2022, revenue: 1_765_110, profit: 166_073 }
    ]
  });

  assert.equal(financials.revenue.value, 1_820_000);
  assert.equal(financials.revenue.year, 2025);
  assert.equal(financials.profit.value, 266_000);
  assert.equal(financials.profit.year, 2025);
  assert.ok(Math.abs(financials.netMargin - 14.6153846154) < 0.001);
  assert.equal(financials.revenuePerEmployee, 606666.6666666666);

  const rows = previousBalanceRows(
    financials.balanceHistory,
    financials.revenue.year,
    3
  );

  assert.deepEqual(rows.map((item) => item.year), [2024, 2023, 2022]);
});

test("canonical value wins when providers report the same latest year", () => {
  const merged = mergeBalanceHistories(
    [
      { year: 2025, revenue: 1_825_000, profit: 267_000 }
    ],
    [
      { year: 2025, revenue: 1_820_000, profit: 266_000 }
    ]
  );

  const financials = promoteLatestFinancialYear({
    revenue: { value: 1_825_000, year: 2025 },
    profit: { value: 267_000, year: 2025 },
    balanceHistory: merged
  });

  assert.equal(financials.revenue.value, 1_825_000);
  assert.equal(financials.profit.value, 267_000);
});


test("gapped history triggers verifier refresh", () => {
  const financials = {
    revenue: { value: 1_992_222, year: 2024 },
    profit: { value: 236_014, year: 2024 },
    balanceHistory: [
      { year: 2024, revenue: 1_992_222, profit: 236_014 },
      { year: 2022, revenue: 1_765_110, profit: 166_073 },
      { year: 2021, revenue: 1_930_000, profit: 150_000 }
    ]
  };

  assert.equal(
    financialHistoryNeedsRefresh(financials, {
      now: new Date(2026, 8, 23)
    }),
    true
  );
});

test("previous-year filing gap triggers verifier in second half of year", () => {
  const financials = {
    revenue: { value: 1_992_222, year: 2024 },
    profit: { value: 236_014, year: 2024 },
    balanceHistory: [
      { year: 2024, revenue: 1_992_222, profit: 236_014 },
      { year: 2023, revenue: 1_635_153, profit: 173_389 },
      { year: 2022, revenue: 1_765_110, profit: 166_073 }
    ]
  };

  assert.equal(
    financialHistoryNeedsRefresh(financials, {
      now: new Date(2026, 8, 23)
    }),
    true
  );
});

test("fresh contiguous history does not trigger verifier refresh", () => {
  const financials = {
    revenue: { value: 1_820_000, year: 2025 },
    profit: { value: 266_000, year: 2025 },
    balanceHistory: [
      { year: 2025, revenue: 1_820_000, profit: 266_000 },
      { year: 2024, revenue: 1_992_222, profit: 236_014 },
      { year: 2023, revenue: 1_635_153, profit: 173_389 }
    ]
  };

  assert.equal(
    financialHistoryNeedsRefresh(financials, {
      now: new Date(2026, 8, 23)
    }),
    false
  );
});


test("merged history preserves filed provenance from either provider", () => {
  const merged = mergeBalanceHistories(
    [
      {
        year: 2025,
        revenue: 2_000_000,
        source: "Xray Finance",
        isFiled: false
      }
    ],
    [
      {
        year: 2025,
        revenue: 1_990_000,
        profit: 200_000,
        source: "RegistroAziende.it",
        isFiled: true
      }
    ]
  );

  assert.equal(merged[0].revenue, 2_000_000);
  assert.equal(merged[0].profit, 200_000);
  assert.equal(merged[0].isFiled, true);
  assert.deepEqual(
    new Set(merged[0].sources),
    new Set(["Xray Finance", "RegistroAziende.it"])
  );
});

test("promoted headline keeps source and filed metadata", () => {
  const financials = promoteLatestFinancialYear({
    revenue: {
      value: 1_900_000,
      year: 2024,
      source: "Aziende.it",
      isFiled: true
    },
    balanceHistory: [
      {
        year: 2025,
        revenue: 2_000_000,
        profit: 210_000,
        source: "RegistroAziende.it",
        isFiled: true
      }
    ]
  });

  assert.equal(financials.revenue.year, 2025);
  assert.equal(financials.revenue.source, "RegistroAziende.it");
  assert.equal(financials.revenue.isFiled, true);
  assert.equal(financials.profit.source, "RegistroAziende.it");
});


test("fresh cached snapshot retries missing Xray without full refresh", () => {
  const plan = missingProviderRefreshPlan({
    primary: {
      provider: "CompanyReports.it",
      vat: "05488440651",
      name: "RUBINO - S.R.L.",
      status: "Attiva",
      ateco: { code: "46.49.9" },
      financials: {
        revenue: { value: 2_277_793, year: 2024 },
        profit: { value: 111_548, year: 2024 },
        balanceHistory: [
          { year: 2024 },
          { year: 2023 },
          { year: 2022 }
        ]
      }
    },
    companyReports: {
      provider: "CompanyReports.it",
      vat: "05488440651",
      status: "Attiva",
      ateco: { code: "46.49.9" },
      financials: {
        revenue: { value: 2_277_793, year: 2024 },
        profit: { value: 111_548, year: 2024 },
        balanceHistory: [
          { year: 2024 },
          { year: 2023 },
          { year: 2022 }
        ]
      }
    },
    xray: null,
    registro: null
  });

  assert.equal(plan.xray, true);
  assert.equal(plan.companyReports, false);
});

test("fresh cached snapshot lacking Aziende enrichment starts only that lookup", () => {
  const plan = missingProviderRefreshPlan({
    companyReports: { provider: "CompanyReports.it", vat: "05488440651" },
    registro: { provider: "RegistroAziende.it", vat: "05488440651" },
    aziende: null,
    xray: { provider: "Xray Finance", vat: "05488440651" }
  });

  assert.equal(plan.aziende, true);
  assert.equal(plan.companyReports, false);
  assert.equal(plan.xray, false);
  assert.equal(plan.registro, false);
});

test("Aziende enrichment is not planned without a usable VAT", () => {
  const plan = missingProviderRefreshPlan({
    registro: { provider: "RegistroAziende.it" },
    aziende: null
  });

  assert.equal(plan.aziende, false);
});

test("complete cached snapshot does not retry already present providers", () => {
  const plan = missingProviderRefreshPlan({
    primary: { vat: "05488440651" },
    companyReports: { vat: "05488440651" },
    aziende: { provider: "Aziende.it", vat: "05488440651" },
    xray: { provider: "Xray Finance", vat: "05488440651" }
  });

  assert.equal(plan.xray, false);
  assert.equal(plan.companyReports, false);
  assert.equal(plan.aziende, false);
});


test("async provider merge never drops an already resolved CompanyReports source", () => {
  const initial = {
    primary: {
      provider: "RegistroAziende.it",
      vat: "11295150152"
    },
    companyReports: null,
    aziende: null,
    registro: {
      provider: "RegistroAziende.it",
      vat: "11295150152"
    },
    xray: null
  };

  const withCompanyReports = mergeProviderResultState(initial, {
    primary: {
      provider: "CompanyReports.it",
      vat: "11295150152"
    },
    companyReports: {
      provider: "CompanyReports.it",
      vat: "11295150152"
    }
  });

  const withLateXray = mergeProviderResultState(withCompanyReports, {
    xray: {
      provider: "Xray Finance",
      vat: "11295150152"
    },
    companyReports: null
  });

  assert.equal(withLateXray.primary.provider, "CompanyReports.it");
  assert.equal(withLateXray.companyReports.provider, "CompanyReports.it");
  assert.equal(withLateXray.registro.provider, "RegistroAziende.it");
  assert.equal(withLateXray.xray.provider, "Xray Finance");
});

test("late Registro update cannot downgrade a CompanyReports canonical primary", () => {
  const state = mergeProviderResultState(
    {
      primary: { provider: "CompanyReports.it", vat: "05488440651" },
      companyReports: { provider: "CompanyReports.it", vat: "05488440651" },
      xray: { provider: "Xray Finance", vat: "05488440651" }
    },
    {
      primary: { provider: "RegistroAziende.it", vat: "05488440651" },
      registro: { provider: "RegistroAziende.it", vat: "05488440651" }
    }
  );

  assert.equal(state.primary.provider, "CompanyReports.it");
  assert.equal(state.companyReports.provider, "CompanyReports.it");
  assert.equal(state.registro.provider, "RegistroAziende.it");
  assert.equal(state.xray.provider, "Xray Finance");
});

test("Aziende sector enrichment never replaces the canonical primary", () => {
  const state = mergeProviderResultState(
    {
      primary: { provider: "CompanyReports.it", vat: "05488440651" },
      companyReports: { provider: "CompanyReports.it", vat: "05488440651" }
    },
    {
      aziende: {
        provider: "Aziende.it",
        vat: "05488440651",
        sectorComparison: {
          companyRevenue: 2_277_793,
          medianRevenue: 1_800_000,
          differencePct: 26.5
        }
      }
    }
  );

  assert.equal(state.primary.provider, "CompanyReports.it");
  assert.equal(state.companyReports.provider, "CompanyReports.it");
  assert.equal(state.aziende.provider, "Aziende.it");
  assert.equal(state.aziende.sectorComparison.companyRevenue, 2_277_793);
});

test("Aziende enrichment alone never becomes the primary without a canonical record", () => {
  const state = mergeProviderResultState(
    {
      primary: { provider: "RegistroAziende.it", vat: "05488440651" },
      registro: { provider: "RegistroAziende.it", vat: "05488440651" }
    },
    {
      aziende: { provider: "Aziende.it", vat: "05488440651" }
    }
  );

  assert.equal(state.primary.provider, "RegistroAziende.it");
  assert.equal(state.aziende.provider, "Aziende.it");
});


/* ---------------------------------------------------------------------------
 * Progressive publication of late providers (rubino-srl.com regression)
 * ------------------------------------------------------------------------- */

test("a progressive snapshot without any canonical record still refreshes on read", () => {
  const plan = missingProviderRefreshPlan({
    primary: null,
    companyReports: null,
    registro: null,
    aziende: null,
    xray: { provider: "Xray Finance", vat: VAT }
  });

  assert.equal(plan.companyReports, true);
  assert.equal(plan.aziende, true);
  assert.equal(plan.xray, false);
  assert.equal(plan.registro, true);
});

test("late CompanyReports.it publishes its patch before a delayed RegistroAziende verifier", async () => {
  const clock = startClock();

  try {
    network.reset();
    extensionStorage.clear();

    const companyReports = deferred();
    const registro = deferred();
    const aziendeSearch = deferred();
    const registroUrl = registroUrlsFor(NAMES)[0];
    const xrayUrl = xrayUrlFor(NAMES);

    network.route(companyReportsUrl, () => companyReports.promise);
    network.route(registroUrl, () => registro.promise);
    network.route(xrayUrl, () => htmlResponse(FIXTURES.xray, { url: xrayUrl }));
    network.route(AZIENDE_SEARCH_URL, () => aziendeSearch.promise);

    const pending = resolveCompanyProviders({ vat: VAT, names: NAMES, aziendeAllowed: true });
    await clock.advance(2600);
    const first = await pending;

    // First render: Xray is ready, both canonical providers are still late.
    assert.equal(first.xray?.vat, VAT);
    assert.equal(first.companyReports, null);
    assert.equal(first.registro, null);
    assert.equal(first.primary, null);
    const canonicalChannel = pendingPromiseFor(first, "companyReports");
    const registroChannel = pendingPromiseFor(first, "registro");
    assert.ok(canonicalChannel);
    assert.ok(registroChannel);

    const order = [];
    const canonicalUpdate = canonicalChannel.then((update) => {
      order.push("canonical");
      return update;
    });
    const verificationUpdate = registroChannel.then((update) => {
      order.push("verification");
      return update;
    });

    await clock.settle();
    assert.deepEqual(order, []);

    companyReports.resolve(
      htmlResponse(FIXTURES.companyReports, { url: companyReportsUrl })
    );
    await clock.settle();

    const canonical = await canonicalUpdate;
    assert.deepEqual(order, ["canonical"]);
    assert.equal(canonical.companyReports.vat, VAT);
    assert.equal(canonical.primary, canonical.companyReports);
    assert.equal(canonical.registro, undefined);
    assert.equal(canonical.verification.verified, false);

    let snapshot = await snapshotStore.read(VAT);
    assert.equal(snapshot.value.companyReports.vat, VAT);
    assert.equal(snapshot.value.registro, null);
    assert.equal(snapshot.value.xray.vat, VAT);

    registro.resolve(
      htmlResponse(FIXTURES.registro, { url: registroUrl })
    );
    await clock.settle();

    const verification = await verificationUpdate;
    assert.deepEqual(order, ["canonical", "verification"]);
    assert.equal(verification.registro.vat, VAT);
    assert.equal(verification.verification.verified, true);

    snapshot = await snapshotStore.read(VAT);
    assert.equal(snapshot.value.primary.provider, "CompanyReports.it");
    assert.equal(snapshot.value.companyReports.provider, "CompanyReports.it");
    assert.equal(snapshot.value.registro.provider, "RegistroAziende.it");
    assert.equal(snapshot.value.xray.provider, "Xray Finance");
    assert.equal(snapshot.value.verification.verified, true);

    assert.equal(
      network.calls.filter((url) => url === companyReportsUrl).length,
      1
    );
    assert.equal(
      network.calls.filter((url) =>
        url.startsWith(PROVIDER_HOSTS.registro)
      ).length,
      1
    );

    aziendeSearch.resolve(
      htmlResponse(AZIENDE_SEARCH_HTML, { url: AZIENDE_SEARCH_URL })
    );
    await clock.settle();
  } finally {
    clock.restore();
  }
});

test("late RegistroAziende publishes first without ever downgrading the canonical primary", async () => {
  const clock = startClock();

  try {
    network.reset();
    extensionStorage.clear();

    const companyReports = deferred();
    const registro = deferred();
    const registroUrl = registroUrlsFor(NAMES)[0];
    const xrayUrl = xrayUrlFor(NAMES);

    network.route(companyReportsUrl, () => companyReports.promise);
    network.route(registroUrl, () => registro.promise);
    network.route(xrayUrl, () => htmlResponse(FIXTURES.xray, { url: xrayUrl }));

    const pending = resolveCompanyProviders({ vat: VAT, names: NAMES, aziendeAllowed: true });
    await clock.advance(2600);
    const first = await pending;

    assert.equal(first.companyReports, null);
    assert.equal(first.registro, null);
    assert.equal(first.primary, null);

    const order = [];
    const canonicalUpdate = pendingPromiseFor(first, "companyReports").then(
      (update) => {
        order.push("canonical");
        return update;
      }
    );
    const verificationUpdate = pendingPromiseFor(first, "registro").then(
      (update) => {
        order.push("verification");
        return update;
      }
    );

    registro.resolve(htmlResponse(FIXTURES.registro, { url: registroUrl }));
    await clock.settle();

    const registroPatch = await verificationUpdate;
    assert.deepEqual(order, ["verification"]);
    assert.equal(registroPatch.registro.provider, "RegistroAziende.it");
    assert.equal(registroPatch.verification.verified, false);

    // RegistroAziende is the visible fallback while the canonical record is
    // still missing.
    let state = mergeProviderResultState({}, first);
    state = mergeProviderResultState(state, registroPatch);
    assert.equal(state.primary.provider, "RegistroAziende.it");

    companyReports.resolve(
      htmlResponse(FIXTURES.companyReports, { url: companyReportsUrl })
    );
    await clock.settle();

    const canonicalPatch = await canonicalUpdate;
    assert.deepEqual(order, ["verification", "canonical"]);
    assert.equal(canonicalPatch.companyReports.provider, "CompanyReports.it");
    assert.equal(canonicalPatch.registro.provider, "RegistroAziende.it");
    assert.equal(canonicalPatch.verification.verified, true);

    state = mergeProviderResultState(state, canonicalPatch);
    assert.equal(state.primary.provider, "CompanyReports.it");
    assert.equal(state.companyReports.provider, "CompanyReports.it");
    assert.equal(state.registro.provider, "RegistroAziende.it");

    const snapshot = await snapshotStore.read(VAT);
    assert.equal(snapshot.value.primary.provider, "CompanyReports.it");
    assert.equal(snapshot.value.registro.provider, "RegistroAziende.it");
  } finally {
    clock.restore();
  }
});

test("a late Xray retry resolves independently of the canonical patch", async () => {
  const clock = startClock();
  const names = ["RUBINO"];

  try {
    network.reset();
    extensionStorage.clear();

    const companyReports = deferred();
    const retryXray = deferred();
    const retryUrl = xrayUrlFor([...NAMES, ...names]);
    const homepageUrl = `${PROVIDER_HOSTS.xray}/`;

    network.route(companyReportsUrl, () => companyReports.promise);
    network.route(
      homepageUrl,
      () => htmlResponse("<html><body>nessun modulo</body></html>", {
        url: homepageUrl
      })
    );
    network.route(retryUrl, () => retryXray.promise);

    const pending = resolveCompanyProviders({ vat: VAT, names, aziendeAllowed: true });
    await clock.advance(2600);
    const first = await pending;

    assert.equal(first.xray, null);
    assert.equal(first.companyReports, null);
    assert.equal(pendingUpdatesFor(first, "xray").length, 2);

    const order = [];
    const canonicalUpdate = pendingPromiseFor(first, "companyReports").then(
      (update) => {
        order.push("canonical");
        return update;
      }
    );
    const xrayUpdates = pendingUpdatesFor(first, "xray").map((entry) =>
      entry.promise.then((update) => {
        if (update) order.push("xray");
        return update;
      })
    );

    companyReports.resolve(
      htmlResponse(FIXTURES.companyReports, { url: companyReportsUrl })
    );
    await clock.settle();

    const canonical = await canonicalUpdate;
    assert.deepEqual(order, ["canonical"]);
    assert.equal(canonical.companyReports.vat, VAT);
    assert.equal(canonical.xray, undefined);

    retryXray.resolve(htmlResponse(FIXTURES.xray, { url: retryUrl }));
    await clock.settle();

    const retried = (await Promise.all(xrayUpdates)).find(Boolean);
    assert.deepEqual(order, ["canonical", "xray"]);
    assert.equal(retried.xray.vat, VAT);

    const snapshot = await snapshotStore.read(VAT);
    assert.equal(snapshot.value.primary.provider, "CompanyReports.it");
    assert.equal(snapshot.value.xray.provider, "Xray Finance");
  } finally {
    clock.restore();
  }
});

test("late canonical name retries Xray while speculative search remains pending", async () => {
  const clock = startClock();
  const names = ["SITE LABEL"];
  const speculative = deferred();
  const companyReports = deferred();
  const initialUrl = xrayUrlFor(names);
  const canonicalUrl = xrayUrlFor([NAMES[0], ...names]);

  try {
    network.reset();
    extensionStorage.clear();
    network.route(companyReportsUrl, () => companyReports.promise);
    network.routePrefix(PROVIDER_HOSTS.xray, (url) =>
      htmlResponse("", { status: 404, url })
    );
    network.route(initialUrl, () => speculative.promise);
    network.route(canonicalUrl, () =>
      htmlResponse(FIXTURES.xray, { url: canonicalUrl })
    );

    const pending = resolveCompanyProviders({ vat: VAT, names, aziendeAllowed: true });
    await clock.advance(2600);
    const first = await pending;
    assert.equal(first.xray, null);
    assert.equal(pendingUpdatesFor(first, "xray").length, 2);

    companyReports.resolve(
      htmlResponse(FIXTURES.companyReports, { url: companyReportsUrl })
    );
    await clock.settle();
    const canonical = await pendingPromiseFor(first, "companyReports");
    // The speculative search is still in flight; the canonical channel
    // publishes the match on its own.
    const xray = await pendingUpdatesFor(first, "xray")[1].promise;
    assert.equal(canonical.companyReports.provider, "CompanyReports.it");
    assert.equal(xray.xray.provider, "Xray Finance");
    assert.equal(network.calls.filter((url) => url === canonicalUrl).length, 1);
    const snapshot = await snapshotStore.read(VAT);
    assert.equal(snapshot.value.xray.provider, "Xray Finance");
  } finally {
    speculative.resolve(htmlResponse("", { status: 404, url: initialUrl }));
    clock.restore();
  }
});

test("Aziende enrichment is requested only after the first render and never delays it", async () => {
  const clock = startClock();

  try {
    network.reset();
    extensionStorage.clear();

    const companyReports = deferred();
    const aziendeSearch = deferred();
    const registroUrl = registroUrlsFor(NAMES)[0];
    const xrayUrl = xrayUrlFor(NAMES);

    network.route(companyReportsUrl, () => companyReports.promise);
    network.route(registroUrl, () => htmlResponse(FIXTURES.registro, { url: registroUrl }));
    network.route(xrayUrl, () => htmlResponse(FIXTURES.xray, { url: xrayUrl }));
    network.route(AZIENDE_SEARCH_URL, () => aziendeSearch.promise);
    network.route(AZIENDE_PROFILE_URL, () =>
      htmlResponse(FIXTURES.aziendeProfile, { url: AZIENDE_PROFILE_URL })
    );

    const pending = resolveCompanyProviders({ vat: VAT, names: NAMES, aziendeAllowed: true });
    await clock.settle();

    // Inside the fast budget: the canonical providers were requested, the
    // optional Aziende.it enrichment was not.
    assert.equal(network.calls.includes(companyReportsUrl), true);
    assert.equal(network.calls.includes(AZIENDE_SEARCH_URL), false);

    await clock.advance(2600);
    const first = await pending;

    assert.equal(first.aziende, null);
    assert.equal(first.primary.provider, "RegistroAziende.it");
    assert.equal(first.xray.vat, VAT);
    assert.equal(
      network.calls.filter((url) => url === AZIENDE_SEARCH_URL).length,
      1
    );

    aziendeSearch.resolve(
      htmlResponse(AZIENDE_SEARCH_HTML, { url: AZIENDE_SEARCH_URL })
    );
    const aziendaPatch = await pendingPromiseFor(first, "aziende");

    assert.equal(aziendaPatch.aziende.provider, "Aziende.it");
    assert.equal(aziendaPatch.aziende.vat, VAT);

    const state = mergeProviderResultState(
      mergeProviderResultState({}, first),
      aziendaPatch
    );
    assert.equal(state.primary.provider, "RegistroAziende.it");
    assert.equal(state.aziende.provider, "Aziende.it");
  } finally {
    clock.restore();
  }
});

test("concurrent resolutions share a single in-flight Aziende lookup per VAT", async () => {
  const clock = startClock();

  try {
    network.reset();
    extensionStorage.clear();

    const companyReports = deferred();
    const aziendeSearch = deferred();
    const registroUrl = registroUrlsFor(NAMES)[0];
    const xrayUrl = xrayUrlFor(NAMES);

    network.route(companyReportsUrl, () => companyReports.promise);
    network.route(registroUrl, () => htmlResponse(FIXTURES.registro, { url: registroUrl }));
    network.route(xrayUrl, () => htmlResponse(FIXTURES.xray, { url: xrayUrl }));
    network.route(AZIENDE_SEARCH_URL, () => aziendeSearch.promise);
    network.route(AZIENDE_PROFILE_URL, () =>
      htmlResponse(FIXTURES.aziendeProfile, { url: AZIENDE_PROFILE_URL })
    );

    const firstPending = resolveCompanyProviders({ vat: VAT, names: NAMES, aziendeAllowed: true });
    const secondPending = resolveCompanyProviders({ vat: VAT, names: NAMES, aziendeAllowed: true });

    await clock.advance(2600);
    const [first, second] = await Promise.all([firstPending, secondPending]);

    assert.equal(
      network.calls.filter((url) => url === AZIENDE_SEARCH_URL).length,
      1
    );

    aziendeSearch.resolve(
      htmlResponse(AZIENDE_SEARCH_HTML, { url: AZIENDE_SEARCH_URL })
    );

    const [firstAzienda, secondAzienda] = await Promise.all([
      pendingPromiseFor(first, "aziende"),
      pendingPromiseFor(second, "aziende")
    ]);

    assert.equal(firstAzienda.aziende.vat, VAT);
    assert.equal(firstAzienda.aziende, secondAzienda.aziende);
    assert.equal(
      network.calls.filter((url) => url === AZIENDE_PROFILE_URL).length,
      1
    );
  } finally {
    clock.restore();
  }
});

test("reuses the in-flight name-based RegistroAziende lookup without a second request", async () => {
  const clock = startClock();
  const names = ["RUBINO"];

  try {
    network.reset();
    extensionStorage.clear();

    const nameBased = deferred();
    const nameBasedUrl = registroUrlsFor([...NAMES, ...names])[0];
    const xrayUrl = xrayUrlFor(names);

    network.route(companyReportsUrl, () =>
      htmlResponse(FIXTURES.companyReports, { url: companyReportsUrl })
    );
    network.route(nameBasedUrl, () => nameBased.promise);
    network.routePrefix(PROVIDER_HOSTS.registro, (url) =>
      htmlResponse("", { status: 404, url })
    );
    network.route(xrayUrl, () => htmlResponse(FIXTURES.xray, { url: xrayUrl }));

    const pending = resolveCompanyProviders({ vat: VAT, names, aziendeAllowed: true });
    await clock.advance(2600);
    const first = await pending;

    assert.equal(first.companyReports.vat, VAT);
    assert.equal(first.registro, null);
    assert.ok(pendingPromiseFor(first, "registro"));
    assert.equal(
      network.calls.filter((url) => url === nameBasedUrl).length,
      1
    );

    const registroCalls = network.calls.filter((url) =>
      url.startsWith(PROVIDER_HOSTS.registro)
    ).length;

    await clock.settle();

    // The background channel awaits the lookup that is already in flight.
    assert.equal(
      network.calls.filter((url) =>
        url.startsWith(PROVIDER_HOSTS.registro)
      ).length,
      registroCalls
    );

    nameBased.resolve(htmlResponse(FIXTURES.registro, { url: nameBasedUrl }));
    await clock.settle();

    const patch = await pendingPromiseFor(first, "registro");
    assert.equal(patch.registro.vat, VAT);
    assert.equal(patch.verification.verified, true);
    assert.equal(
      network.calls.filter((url) => url === nameBasedUrl).length,
      1
    );
  } finally {
    clock.restore();
  }
});

test("a failing optional late provider never blocks the others nor rejects", async (t) => {
  const rejections = createRejectionTracker(t);
  const clock = startClock();

  try {
    network.reset();
    extensionStorage.clear();

    const registro = deferred();
    const registroUrl = registroUrlsFor(NAMES)[0];
    const xrayUrl = xrayUrlFor(NAMES);

    network.route(companyReportsUrl, () =>
      Promise.reject(new Error("companyreports down"))
    );
    network.route(registroUrl, () => registro.promise);
    network.route(xrayUrl, () => htmlResponse(FIXTURES.xray, { url: xrayUrl }));

    const pending = resolveCompanyProviders({ vat: VAT, names: NAMES, aziendeAllowed: true });
    await clock.advance(2600);
    const first = await pending;

    assert.equal(first.xray.vat, VAT);

    registro.resolve(htmlResponse(FIXTURES.registro, { url: registroUrl }));
    await clock.settle();

    const [canonical, verification] = await Promise.all([
      pendingPromiseFor(first, "companyReports"),
      pendingPromiseFor(first, "registro")
    ]);

    assert.equal(canonical, null);
    assert.equal(verification.registro.vat, VAT);
    assert.equal(verification.verification.verified, false);

    await clock.settle();
    assert.deepEqual(rejections, []);
  } finally {
    clock.restore();
  }
});

test("a failing verifier still publishes the canonical record", async (t) => {
  const rejections = createRejectionTracker(t);
  const clock = startClock();

  try {
    network.reset();
    extensionStorage.clear();

    const companyReports = deferred();
    const registroUrl = registroUrlsFor(NAMES)[0];
    const xrayUrl = xrayUrlFor(NAMES);

    network.route(companyReportsUrl, () => companyReports.promise);
    network.routePrefix(PROVIDER_HOSTS.registro, (url) =>
      Promise.reject(new Error(`registro down: ${url}`))
    );
    network.route(xrayUrl, () => htmlResponse(FIXTURES.xray, { url: xrayUrl }));

    const pending = resolveCompanyProviders({ vat: VAT, names: NAMES, aziendeAllowed: true });
    await clock.advance(2600);
    const first = await pending;

    companyReports.resolve(
      htmlResponse(FIXTURES.companyReports, { url: companyReportsUrl })
    );
    await clock.settle();

    const [canonical, verification] = await Promise.all([
      pendingPromiseFor(first, "companyReports"),
      pendingPromiseFor(first, "registro")
    ]);

    assert.equal(canonical.companyReports.vat, VAT);
    assert.equal(canonical.verification.verified, false);
    assert.equal(verification, null);

    await clock.settle();
    assert.deepEqual(rejections, []);
  } finally {
    clock.restore();
  }
});

test("a snapshot completed by progressive patches resolves from cache without new lookups", async () => {
  const clock = startClock();

  try {
    network.reset();
    extensionStorage.clear();

    const companyReports = deferred();
    const registro = deferred();
    const aziendeSearch = deferred();
    const registroUrl = registroUrlsFor(NAMES)[0];
    const xrayUrl = xrayUrlFor(NAMES);

    network.route(companyReportsUrl, () => companyReports.promise);
    network.route(registroUrl, () => registro.promise);
    network.route(xrayUrl, () => htmlResponse(FIXTURES.xray, { url: xrayUrl }));
    network.route(AZIENDE_SEARCH_URL, () => aziendeSearch.promise);
    network.route(AZIENDE_PROFILE_URL, () =>
      htmlResponse(FIXTURES.aziendeProfile, { url: AZIENDE_PROFILE_URL })
    );

    const pending = resolveCompanyProviders({ vat: VAT, names: NAMES, aziendeAllowed: true });
    await clock.advance(2600);
    const first = await pending;

    companyReports.resolve(
      htmlResponse(FIXTURES.companyReports, { url: companyReportsUrl })
    );
    registro.resolve(htmlResponse(FIXTURES.registro, { url: registroUrl }));
    aziendeSearch.resolve(
      htmlResponse(AZIENDE_SEARCH_HTML, { url: AZIENDE_SEARCH_URL })
    );
    await clock.settle();

    await Promise.all([
      pendingPromiseFor(first, "companyReports"),
      pendingPromiseFor(first, "registro"),
      pendingPromiseFor(first, "aziende")
    ]);

    const snapshot = await snapshotStore.read(VAT);
    assert.equal(snapshot.stale, false);
    assert.equal(snapshot.value.primary.provider, "CompanyReports.it");
    assert.equal(snapshot.value.companyReports.provider, "CompanyReports.it");
    assert.equal(snapshot.value.registro.provider, "RegistroAziende.it");
    assert.equal(snapshot.value.xray.provider, "Xray Finance");
    assert.equal(snapshot.value.aziende.provider, "Aziende.it");
    assert.equal(snapshot.value.verification.verified, true);

    network.calls.length = 0;

    const cached = await resolveCompanyProviders({ vat: VAT, names: NAMES, aziendeAllowed: true });

    assert.equal(cached.fromCache, true);
    assert.equal(cached.stale, false);
    assert.deepEqual(cached.pendingUpdates, []);
    assert.deepEqual(network.calls, []);
  } finally {
    clock.restore();
  }
});

/* ---------------------------------------------------------------------------
 * Cached snapshots, transient throttling and progressive Xray publication
 * ------------------------------------------------------------------------- */

test("a fresh cached CompanyReports plus RegistroAziende snapshot refreshes only the missing providers", async () => {
  const clock = startClock();

  try {
    network.reset();
    extensionStorage.clear();

    const canonical = {
      provider: "CompanyReports.it",
      vat: VAT,
      name: "RUBINO - S.R.L."
    };
    const verifier = {
      provider: "RegistroAziende.it",
      vat: VAT,
      name: "RUBINO - S.R.L."
    };

    await snapshotStore.write(VAT, {
      primary: canonical,
      companyReports: canonical,
      registro: verifier,
      verification: { verified: true, conflicts: [], agreement: 100 }
    });

    const xrayUrl = xrayUrlFor(NAMES);
    network.route(xrayUrl, () => htmlResponse(FIXTURES.xray, { url: xrayUrl }));
    network.route(AZIENDE_SEARCH_URL, () =>
      htmlResponse(AZIENDE_SEARCH_HTML, { url: AZIENDE_SEARCH_URL })
    );
    network.route(AZIENDE_PROFILE_URL, () =>
      htmlResponse(FIXTURES.aziendeProfile, { url: AZIENDE_PROFILE_URL })
    );
    // Canonical providers are already cached: routing them lets the test
    // prove they are not looked up again.
    network.route(companyReportsUrl, () =>
      htmlResponse(FIXTURES.companyReports, { url: companyReportsUrl })
    );
    for (const url of registroUrlsFor(NAMES)) {
      network.route(url, () => htmlResponse(FIXTURES.registro, { url }));
    }

    const cached = await resolveCompanyProviders({ vat: VAT, names: NAMES, aziendeAllowed: true });

    assert.equal(cached.fromCache, true);
    assert.equal(cached.stale, false);
    assert.equal(cached.companyReports.provider, "CompanyReports.it");
    assert.deepEqual(
      cached.pendingUpdates.map((entry) => entry.provider).sort(),
      ["aziende", "xray"]
    );

    const [xrayPatch, aziendaPatch] = await Promise.all([
      pendingPromiseFor(cached, "xray"),
      pendingPromiseFor(cached, "aziende")
    ]);

    assert.equal(xrayPatch.xray.provider, "Xray Finance");
    assert.equal(aziendaPatch.aziende.provider, "Aziende.it");

    // "without reopening": the progressive patch already persisted its slot.
    const snapshot = await snapshotStore.read(VAT);
    assert.equal(snapshot.value.companyReports.provider, "CompanyReports.it");
    assert.equal(snapshot.value.registro.provider, "RegistroAziende.it");
    assert.equal(snapshot.value.xray.provider, "Xray Finance");
    assert.equal(snapshot.value.aziende.provider, "Aziende.it");

    assert.equal(
      network.calls.filter((url) => url.startsWith(PROVIDER_HOSTS.companyReports))
        .length,
      0
    );
    assert.equal(
      network.calls.filter((url) => url.startsWith(PROVIDER_HOSTS.registro))
        .length,
      0
    );
  } finally {
    clock.restore();
  }
});

test("an Xray lookup that outlives its budget still publishes a progressive patch", async () => {
  const clock = startClock();

  try {
    network.reset();
    extensionStorage.clear();

    const xray = deferred();
    const xrayUrl = xrayUrlFor(NAMES);

    network.route(companyReportsUrl, () =>
      htmlResponse(FIXTURES.companyReports, { url: companyReportsUrl })
    );
    for (const url of registroUrlsFor(NAMES)) {
      network.route(url, () => htmlResponse(FIXTURES.registro, { url }));
    }
    network.route(xrayUrl, () => xray.promise);
    network.route(AZIENDE_SEARCH_URL, () =>
      htmlResponse(AZIENDE_SEARCH_HTML, { url: AZIENDE_SEARCH_URL })
    );
    network.route(AZIENDE_PROFILE_URL, () =>
      htmlResponse(FIXTURES.aziendeProfile, { url: AZIENDE_PROFILE_URL })
    );

    const pending = resolveCompanyProviders({ vat: VAT, names: NAMES, aziendeAllowed: true });
    await clock.advance(2600);
    const first = await pending;

    assert.equal(first.xray, null);
    // The canonical name is already covered by the speculative search, so the
    // only pending Xray lookup is the one the first render started.
    assert.equal(pendingUpdatesFor(first, "xray").length, 1);

    xray.resolve(htmlResponse(FIXTURES.xray, { url: xrayUrl }));
    await clock.settle();

    const patch = await pendingPromiseFor(first, "xray");
    assert.equal(patch.xray.vat, VAT);
    assert.equal(network.calls.filter((url) => url === xrayUrl).length, 1);

    const snapshot = await snapshotStore.read(VAT);
    assert.equal(snapshot.value.xray.provider, "Xray Finance");
  } finally {
    clock.restore();
  }
});

test("a transient Xray 503 is retried instead of being negative-cached", async () => {
  try {
    network.reset();
    extensionStorage.clear();

    const directUrl = `${PROVIDER_HOSTS.xray}/${encodeURIComponent("rubino-s-r-l")}`;
    const homepageUrl = `${PROVIDER_HOSTS.xray}/`;
    let attempts = 0;

    network.routePrefix(PROVIDER_HOSTS.xray, (url) =>
      htmlResponse("<html><body></body></html>", { status: 404, url })
    );
    network.route(homepageUrl, () =>
      htmlResponse("<html><body>nessun modulo</body></html>", {
        url: homepageUrl
      })
    );
    network.route(directUrl, (url) => {
      attempts += 1;
      if (attempts === 1) return htmlResponse("busy", { status: 503, url });
      return htmlResponse(FIXTURES.xray, { url });
    });

    const [firstA, firstB] = await Promise.all([
      findXrayCompanyByVat(VAT, { names: ["RUBINO - S.R.L."] }),
      findXrayCompanyByVat(VAT, { names: ["RUBINO - S.R.L."] })
    ]);

    assert.equal(firstA, null);
    assert.equal(firstB, null);
    // Two concurrent searches share a single request for the throttled slug
    // instead of storming it twice, and the 503 is not cached as a miss.
    assert.equal(network.calls.filter((url) => url === directUrl).length, 1);
    assert.equal(attempts, 1);

    // The permanent 404 misses were cached by the first attempt. Only the
    // un-cached 503 is requested again, and it now succeeds.
    network.calls.length = 0;
    const retry = await findXrayCompanyByVat(VAT, {
      names: ["RUBINO - S.R.L."]
    });

    assert.equal(retry?.vat, VAT);
    assert.equal(attempts, 2);
    assert.deepEqual(network.calls, [directUrl]);
  } finally {
    network.reset();
  }
});

test("concurrent Xray searches share a single in-flight request per slug", async () => {
  try {
    network.reset();
    extensionStorage.clear();

    const directUrl = `${PROVIDER_HOSTS.xray}/${encodeURIComponent("rubino-s-r-l")}`;
    const first = deferred();
    let directCalls = 0;

    network.routePrefix(PROVIDER_HOSTS.xray, (url) =>
      htmlResponse("<html><body></body></html>", { status: 404, url })
    );
    network.route(`${PROVIDER_HOSTS.xray}/`, (url) =>
      htmlResponse("<html><body>nessun modulo</body></html>", { url })
    );
    network.route(directUrl, (url) => {
      directCalls += 1;
      return first.promise;
    });

    const left = findXrayCompanyByVat(VAT, { names: ["RUBINO - S.R.L."] });
    const right = findXrayCompanyByVat(VAT, { names: ["RUBINO - S.R.L."] });

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(directCalls, 1);

    first.resolve(htmlResponse(FIXTURES.xray, { url: directUrl }));

    const [leftResult, rightResult] = await Promise.all([left, right]);

    assert.equal(leftResult?.vat, VAT);
    assert.equal(rightResult?.vat, VAT);
    assert.equal(directCalls, 1);
    assert.equal(new Set(network.calls).size, network.calls.length);
  } finally {
    network.reset();
  }
});

test("a covered canonical Xray name does not start a second slug search", async () => {
  const clock = startClock();

  try {
    network.reset();
    extensionStorage.clear();

    const xrayUrl = xrayUrlFor(NAMES);
    const numberedUrl = `${PROVIDER_HOSTS.xray}/rubino-s-r-l-15`;

    network.route(companyReportsUrl, () =>
      htmlResponse(FIXTURES.companyReports, { url: companyReportsUrl })
    );
    for (const url of registroUrlsFor(NAMES)) {
      network.route(url, () => htmlResponse(FIXTURES.registro, { url }));
    }
    network.routePrefix(PROVIDER_HOSTS.xray, (url) =>
      htmlResponse("<html><body></body></html>", { status: 404, url })
    );
    network.route(`${PROVIDER_HOSTS.xray}/`, (url) =>
      htmlResponse("<html><body>nessun modulo</body></html>", { url })
    );
    network.route(xrayUrl, (url) => htmlResponse("busy", { status: 503, url }));
    network.route(numberedUrl, (url) =>
      htmlResponse("busy", { status: 503, url })
    );
    network.route(AZIENDE_SEARCH_URL, () =>
      htmlResponse(AZIENDE_SEARCH_HTML, { url: AZIENDE_SEARCH_URL })
    );
    network.route(AZIENDE_PROFILE_URL, () =>
      htmlResponse(FIXTURES.aziendeProfile, { url: AZIENDE_PROFILE_URL })
    );

    const pending = resolveCompanyProviders({ vat: VAT, names: NAMES, aziendeAllowed: true });
    await clock.advance(2600);
    const first = await pending;
    await clock.settle();

    assert.equal(first.xray, null);
    assert.equal(pendingUpdatesFor(first, "xray").length, 1);

    // Both throttled slugs are requested exactly once: the canonical name
    // covers the speculative slug space, so it must not start a duplicate
    // walk.
    assert.equal(network.calls.filter((url) => url === xrayUrl).length, 1);
    assert.equal(network.calls.filter((url) => url === numberedUrl).length, 1);
  } finally {
    clock.restore();
  }
});

test("a canonical Xray name probes numbered slugs beyond the speculative search limit", async () => {
  const clock = startClock();
  const names = ["Brand One", "Brand Two", "Rubino SRL"];
  const numberedUrl = PROVIDER_HOSTS.xray + "/rubino-s-r-l-15";

  try {
    network.reset();
    extensionStorage.clear();
    network.route(companyReportsUrl, () =>
      htmlResponse(FIXTURES.companyReports, { url: companyReportsUrl })
    );
    network.routePrefix(PROVIDER_HOSTS.xray, (url) =>
      htmlResponse("", { status: 404, url })
    );
    network.route(PROVIDER_HOSTS.xray + "/", (url) =>
      htmlResponse("<html><body>nessun modulo</body></html>", { url })
    );
    network.route(numberedUrl, (url) =>
      htmlResponse(FIXTURES.xray, { url })
    );

    const pending = resolveCompanyProviders({ vat: VAT, names, aziendeAllowed: true });
    await clock.advance(2600);
    const first = await pending;
    const lateXray = await Promise.all(
      pendingUpdatesFor(first, "xray").map((entry) => entry.promise)
    );
    const snapshot = await snapshotStore.read(VAT);

    assert.equal(first.companyReports.vat, VAT);
    assert.equal(first.xray?.vat || lateXray.find((patch) => patch?.xray)?.xray.vat, VAT);
    assert.equal(snapshot.value.xray.vat, VAT);
    assert.equal(network.calls.filter((url) => url === numberedUrl).length, 1);
  } finally {
    clock.restore();
  }
});

test("a stale snapshot exposes a single nested refresh pending update", async () => {
  const clock = startClock();

  try {
    network.reset();
    extensionStorage.clear();

    const canonical = {
      provider: "CompanyReports.it",
      vat: VAT,
      name: "RUBINO - S.R.L."
    };

    extensionStorage.entries[`provider-orchestrator:v9:${VAT}`] = {
      schemaVersion: 2,
      cachedAt: Date.now() - 2 * 24 * 60 * 60 * 1000,
      value: {
        primary: canonical,
        companyReports: canonical,
        aziende: null,
        xray: null,
        registro: null,
        verification: null
      }
    };

    const companyReports = deferred();
    const registro = deferred();
    const registroUrl = registroUrlsFor(NAMES)[0];
    const xrayUrl = xrayUrlFor(NAMES);

    network.route(companyReportsUrl, () => companyReports.promise);
    network.route(registroUrl, () => registro.promise);
    network.route(xrayUrl, () => htmlResponse(FIXTURES.xray, { url: xrayUrl }));
    network.route(AZIENDE_SEARCH_URL, () =>
      htmlResponse(AZIENDE_SEARCH_HTML, { url: AZIENDE_SEARCH_URL })
    );
    network.route(AZIENDE_PROFILE_URL, () =>
      htmlResponse(FIXTURES.aziendeProfile, { url: AZIENDE_PROFILE_URL })
    );

    const cached = await resolveCompanyProviders({ vat: VAT, names: NAMES, aziendeAllowed: true });

    assert.equal(cached.fromCache, true);
    assert.equal(cached.stale, true);
    // The cached record is served immediately.
    assert.equal(cached.companyReports.provider, "CompanyReports.it");
    assert.deepEqual(
      cached.pendingUpdates.map((entry) => entry.provider),
      ["refresh"]
    );

    await clock.settle();
    await clock.advance(2600);
    const fresh = await cached.pendingUpdates[0].promise;

    // The refresh resolves the fresh result, whose own pending updates the
    // popup subscribes to recursively.
    assert.deepEqual(
      fresh.pendingUpdates.map((entry) => entry.provider),
      ["companyReports", "registro", "aziende"]
    );

    companyReports.resolve(
      htmlResponse(FIXTURES.companyReports, { url: companyReportsUrl })
    );
    registro.resolve(htmlResponse(FIXTURES.registro, { url: registroUrl }));
    await clock.settle();
    await Promise.all(fresh.pendingUpdates.map((entry) => entry.promise));

    const snapshot = await snapshotStore.read(VAT);
    assert.equal(snapshot.stale, false);
    assert.equal(snapshot.value.primary.provider, "CompanyReports.it");
    assert.equal(snapshot.value.registro.provider, "RegistroAziende.it");
    assert.equal(snapshot.value.xray.provider, "Xray Finance");
  } finally {
    clock.restore();
  }
});

/* ---------------------------------------------------------------------------
 * One-open lifecycle: the real popup consumer of `pendingUpdates`
 * ------------------------------------------------------------------------- */

test("an uncached lookup keeps the completion indicator alive until the late Xray patch lands", async () => {
  const clock = startClock();

  try {
    network.reset();
    extensionStorage.clear();

    const xray = deferred();
    const xrayUrl = xrayUrlFor(NAMES);

    network.route(companyReportsUrl, () =>
      htmlResponse(FIXTURES.companyReports, { url: companyReportsUrl })
    );
    for (const url of registroUrlsFor(NAMES)) {
      network.route(url, () => htmlResponse(FIXTURES.registro, { url }));
    }
    network.route(xrayUrl, () => xray.promise);
    network.route(AZIENDE_SEARCH_URL, () =>
      htmlResponse(AZIENDE_SEARCH_HTML, { url: AZIENDE_SEARCH_URL })
    );
    network.route(AZIENDE_PROFILE_URL, () =>
      htmlResponse(FIXTURES.aziendeProfile, { url: AZIENDE_PROFILE_URL })
    );

    const pending = resolveCompanyProviders({ vat: VAT, names: NAMES, aziendeAllowed: true });
    await clock.advance(2600);
    const resolved = await pending;

    // First result: the canonical record is already visible, Xray is not yet
    // and is still exposed as a pending update.
    assert.equal(resolved.companyReports.provider, "CompanyReports.it");
    assert.equal(resolved.registro?.provider, "RegistroAziende.it");
    assert.equal(resolved.xray, null);
    assert.equal(pendingUpdatesFor(resolved, "xray").length, 1);

    let visible = false;
    const visibility = [];
    const tracker = createDataCompletionTracker((value) => {
      visible = value;
      visibility.push(value);
    });
    const generation = tracker.reset();

    let active = mergeProviderResultState({}, resolved);
    let xrayPatch = null;
    let visibleWhenXrayPatched = null;

    watchProviderUpdates(
      resolved,
      generation,
      () => true,
      (patch) => {
        active = mergeProviderResultState(active, patch);
        if (!patch?.xray) return;
        xrayPatch = patch;
        visibleWhenXrayPatched = visible;
      },
      (promise, current) => tracker.track(promise, current)
    );
    tracker.display(generation);

    // The late Xray lookup is still running: the indicator stays on and no
    // Xray patch has been emitted yet.
    await clock.advance(400);
    assert.deepEqual(visibility, [true]);
    assert.equal(xrayPatch, null);

    xray.resolve(htmlResponse(FIXTURES.xray, { url: xrayUrl }));
    await clock.settle();

    // The patch is applied while the indicator is still on, and only then
    // does it turn off - all in the same popup lifecycle.
    assert.equal(xrayPatch.xray.vat, VAT);
    assert.equal(active.primary.provider, "CompanyReports.it");
    assert.equal(active.registro.provider, "RegistroAziende.it");
    assert.equal(active.xray.provider, "Xray Finance");
    assert.equal(visibleWhenXrayPatched, true);
    assert.deepEqual(visibility, [true, false]);

    const snapshot = await snapshotStore.read(VAT);
    assert.equal(snapshot.value.xray.provider, "Xray Finance");
  } finally {
    clock.restore();
  }
});

test("a fresh cached snapshot without Xray keeps the indicator alive until the Xray patch lands", async () => {
  const clock = startClock();

  try {
    network.reset();
    extensionStorage.clear();

    const canonical = {
      provider: "CompanyReports.it",
      vat: VAT,
      name: "RUBINO - S.R.L."
    };
    const verifier = {
      provider: "RegistroAziende.it",
      vat: VAT,
      name: "RUBINO - S.R.L."
    };

    await snapshotStore.write(VAT, {
      primary: canonical,
      companyReports: canonical,
      registro: verifier,
      verification: { verified: true, conflicts: [], agreement: 100 }
    });

    const xray = deferred();
    const xrayUrl = xrayUrlFor(NAMES);

    network.route(xrayUrl, () => xray.promise);
    network.route(AZIENDE_SEARCH_URL, () =>
      htmlResponse(AZIENDE_SEARCH_HTML, { url: AZIENDE_SEARCH_URL })
    );
    network.route(AZIENDE_PROFILE_URL, () =>
      htmlResponse(FIXTURES.aziendeProfile, { url: AZIENDE_PROFILE_URL })
    );
    network.route(companyReportsUrl, () =>
      htmlResponse(FIXTURES.companyReports, { url: companyReportsUrl })
    );
    for (const url of registroUrlsFor(NAMES)) {
      network.route(url, () => htmlResponse(FIXTURES.registro, { url }));
    }

    const resolved = await resolveCompanyProviders({ vat: VAT, names: NAMES, aziendeAllowed: true });

    assert.equal(resolved.fromCache, true);
    assert.equal(resolved.companyReports.provider, "CompanyReports.it");
    assert.equal(resolved.xray, null);
    assert.deepEqual(
      resolved.pendingUpdates.map((entry) => entry.provider).sort(),
      ["aziende", "xray"]
    );

    let visible = false;
    const visibility = [];
    const tracker = createDataCompletionTracker((value) => {
      visible = value;
      visibility.push(value);
    });
    const generation = tracker.reset();

    let active = mergeProviderResultState({}, resolved);
    let xrayPatch = null;
    let visibleWhenXrayPatched = null;

    watchProviderUpdates(
      resolved,
      generation,
      () => true,
      (patch) => {
        active = mergeProviderResultState(active, patch);
        if (!patch?.xray) return;
        xrayPatch = patch;
        visibleWhenXrayPatched = visible;
      },
      (promise, current) => tracker.track(promise, current)
    );
    tracker.display(generation);

    await clock.advance(400);
    assert.deepEqual(visibility, [true]);
    assert.equal(xrayPatch, null);

    xray.resolve(htmlResponse(FIXTURES.xray, { url: xrayUrl }));
    await clock.settle();

    assert.equal(xrayPatch.xray.vat, VAT);
    assert.equal(active.primary.provider, "CompanyReports.it");
    assert.equal(active.registro.provider, "RegistroAziende.it");
    assert.equal(active.xray.provider, "Xray Finance");
    assert.equal(visibleWhenXrayPatched, true);
    assert.deepEqual(visibility, [true, false]);

    const snapshot = await snapshotStore.read(VAT);
    assert.equal(snapshot.value.companyReports.provider, "CompanyReports.it");
    assert.equal(snapshot.value.xray.provider, "Xray Finance");

    assert.equal(
      network.calls.filter((url) =>
        url.startsWith(PROVIDER_HOSTS.companyReports)
      ).length,
      0
    );
    assert.equal(
      network.calls.filter((url) => url.startsWith(PROVIDER_HOSTS.registro))
        .length,
      0
    );
  } finally {
    clock.restore();
  }
});

/* ---------------------------------------------------------------------------
 * Aziende.it optional host permission
 *
 * The provider is optional: without the exact Aziende.it host permission
 * neither its network lookup nor its cache may be touched, while every other
 * provider and both snapshot paths keep working normally.
 * ------------------------------------------------------------------------- */

function seedSnapshot(value, { cachedAt = Date.now() } = {}) {
  extensionStorage.entries[`provider-orchestrator:v9:${VAT}`] = {
    schemaVersion: 2,
    cachedAt,
    value
  };
}

test("the Aziende.it provider is never reached when the permission is missing", async () => {
  const clock = startClock();

  try {
    network.reset();
    extensionStorage.clear();
    installFixtureProviders({ names: NAMES });

    // No `aziendeAllowed` flag at all: the gate is deny-by-default.
    const pending = resolveCompanyProviders({ vat: VAT, names: NAMES });
    await clock.advance(2600);
    const first = await pending;
    await clock.settle();

    // Canonical providers and the optional Xray enrichment work normally.
    assert.equal(first.companyReports.provider, "CompanyReports.it");
    assert.equal(first.xray?.vat, VAT);

    let registro = first.registro;
    if (!registro) {
      registro = (await pendingPromiseFor(first, "registro"))?.registro || null;
    }
    assert.equal(registro?.provider, "RegistroAziende.it");

    // The optional provider is absent and was never requested.
    assert.equal(first.aziende, null);
    assert.deepEqual(pendingUpdatesFor(first, "aziende"), []);
    assert.equal(
      network.calls.filter((url) => url.startsWith(PROVIDER_HOSTS.aziende))
        .length,
      0
    );

    const snapshot = await snapshotStore.read(VAT);
    assert.equal(snapshot.value.companyReports.provider, "CompanyReports.it");
    assert.equal(snapshot.value.aziende, null);
  } finally {
    clock.restore();
  }
});

test("a fresh cached snapshot without Aziende starts no lookup without permission", async () => {
  const clock = startClock();

  try {
    network.reset();
    extensionStorage.clear();

    const canonical = {
      provider: "CompanyReports.it",
      vat: VAT,
      name: "RUBINO - S.R.L."
    };

    seedSnapshot({
      primary: canonical,
      companyReports: canonical,
      aziende: null,
      xray: { provider: "Xray Finance", vat: VAT },
      registro: {
        provider: "RegistroAziende.it",
        vat: VAT,
        name: "RUBINO - S.R.L."
      },
      verification: null
    });

    // Every provider is routed, so a stray Aziende.it request would be visible.
    installFixtureProviders({ names: NAMES });

    const cached = await resolveCompanyProviders({ vat: VAT, names: NAMES });
    await clock.settle();

    assert.equal(cached.fromCache, true);
    assert.equal(cached.stale, false);
    assert.equal(cached.companyReports.provider, "CompanyReports.it");
    assert.deepEqual(cached.pendingUpdates, []);
    assert.equal(
      network.calls.filter((url) => url.startsWith(PROVIDER_HOSTS.aziende))
        .length,
      0
    );
  } finally {
    clock.restore();
  }
});

test("a cached Aziende.it slot is served unchanged without permission", async () => {
  const clock = startClock();

  try {
    network.reset();
    extensionStorage.clear();

    const canonical = {
      provider: "CompanyReports.it",
      vat: VAT,
      name: "RUBINO - S.R.L."
    };
    const azienda = {
      provider: "Aziende.it",
      vat: VAT,
      sectorComparison: {
        sourceName: "Aziende.it",
        companyRevenue: 191_540,
        medianRevenue: 392_007,
        year: 2024
      }
    };

    seedSnapshot({
      primary: canonical,
      companyReports: canonical,
      aziende: azienda,
      xray: { provider: "Xray Finance", vat: VAT },
      registro: {
        provider: "RegistroAziende.it",
        vat: VAT,
        name: "RUBINO - S.R.L."
      },
      verification: null
    });

    installFixtureProviders({ names: NAMES });

    const cached = await resolveCompanyProviders({ vat: VAT, names: NAMES });
    await clock.settle();

    // The popup still receives the cached comparison (and hides it while the
    // permission is missing); nothing is refreshed or deleted.
    assert.equal(cached.aziende.provider, "Aziende.it");
    assert.deepEqual(cached.pendingUpdates, []);
    assert.equal(
      network.calls.filter((url) => url.startsWith(PROVIDER_HOSTS.aziende))
        .length,
      0
    );

    const snapshot = await snapshotStore.read(VAT);
    assert.equal(snapshot.value.aziende.provider, "Aziende.it");
  } finally {
    clock.restore();
  }
});

test("a stale refresh keeps canonical providers and never touches Aziende.it without permission", async () => {
  const clock = startClock();

  try {
    network.reset();
    extensionStorage.clear();

    const canonical = {
      provider: "CompanyReports.it",
      vat: VAT,
      name: "RUBINO - S.R.L."
    };

    seedSnapshot(
      {
        primary: canonical,
        companyReports: canonical,
        aziende: null,
        xray: null,
        registro: null,
        verification: null
      },
      { cachedAt: Date.now() - 2 * 24 * 60 * 60 * 1000 }
    );

    installFixtureProviders({ names: NAMES });

    const cached = await resolveCompanyProviders({ vat: VAT, names: NAMES });

    assert.equal(cached.fromCache, true);
    assert.equal(cached.stale, true);
    assert.deepEqual(
      cached.pendingUpdates.map((entry) => entry.provider),
      ["refresh"]
    );

    await clock.advance(2600);
    const fresh = await cached.pendingUpdates[0].promise;
    await clock.settle();

    assert.equal(fresh.companyReports.provider, "CompanyReports.it");
    assert.deepEqual(pendingUpdatesFor(fresh, "aziende"), []);
    assert.equal(
      network.calls.filter((url) => url.startsWith(PROVIDER_HOSTS.aziende))
        .length,
      0
    );
    assert.ok(
      network.calls.some((url) => url.startsWith(PROVIDER_HOSTS.companyReports))
    );
    assert.ok(
      network.calls.some((url) => url.startsWith(PROVIDER_HOSTS.xray))
    );

    const snapshot = await snapshotStore.read(VAT);
    assert.equal(snapshot.stale, false);
    assert.equal(snapshot.value.companyReports.provider, "CompanyReports.it");
    assert.equal(snapshot.value.aziende, null);
  } finally {
    clock.restore();
  }
});

test("the grant-time Aziende refresh is permission-gated and persists its own slot", async () => {
  const clock = startClock();

  try {
    network.reset();
    extensionStorage.clear();

    // An explicitly denied refresh never reaches the provider.
    const denied = resolveAziendeEnrichment({
      vat: VAT,
      names: NAMES,
      aziendeAllowed: false
    });
    assert.deepEqual(denied.pendingUpdates, []);
    assert.equal(network.calls.length, 0);

    installFixtureProviders({ names: NAMES });

    const granted = resolveAziendeEnrichment({
      vat: VAT,
      names: NAMES,
      aziendeAllowed: true
    });

    assert.equal(granted.pendingUpdates.length, 1);
    assert.equal(granted.pendingUpdates[0].provider, "aziende");

    const patch = await granted.pendingUpdates[0].promise;
    await clock.settle();

    assert.equal(patch.aziende.provider, "Aziende.it");
    assert.equal(patch.aziende.vat, VAT);

    const snapshot = await snapshotStore.read(VAT);
    assert.equal(snapshot.value.aziende.provider, "Aziende.it");

    // The targeted refresh never reruns the canonical providers.
    assert.equal(
      network.calls.filter((url) => url.startsWith(PROVIDER_HOSTS.companyReports))
        .length,
      0
    );
    assert.equal(
      network.calls.filter((url) => url.startsWith(PROVIDER_HOSTS.registro))
        .length,
      0
    );
    assert.equal(
      network.calls.filter((url) => url.startsWith(PROVIDER_HOSTS.xray)).length,
      0
    );
  } finally {
    clock.restore();
  }
});

test("a revoked host permission blocks Aziende despite a previously granted resolver flag", async () => {
  network.reset();
  extensionStorage.clear();
  installFixtureProviders({ names: NAMES });
  globalThis.chrome.permissions.contains = (_details, callback) => callback(false);
  try {
    const result = resolveAziendeEnrichment({ vat: VAT, names: NAMES, aziendeAllowed: true });
    const patch = await result.pendingUpdates[0].promise;
    assert.equal(patch, null);
    assert.equal(network.calls.filter((url) => url.startsWith(PROVIDER_HOSTS.aziende)).length, 0);
    assert.equal(await snapshotStore.read(VAT), null);
  } finally {
    globalThis.chrome.permissions.contains = (_details, callback) => callback(true);
  }
});
