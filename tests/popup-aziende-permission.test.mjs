import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { createSnapshotStore } from "../src/background/provider-snapshot.js";
import { loadFixture } from "./helpers/fixtures.mjs";

/* ---------------------------------------------------------------------------
 * Popup integration harness
 *
 * The real popup module is imported against a fake DOM, fake extension APIs and
 * fixture pages, so the permission prompt, the grant flow and the revocation
 * guards run end to end instead of being re-implemented by the test.
 * ------------------------------------------------------------------------- */

const VAT = "05488440651";
const NAMES = ["RUBINO - S.R.L."];
const AZIENDE_HOST = "https://www.aziende.it";
const AZIENDE_HOST_PATTERN = "https://www.aziende.it/*";
const COMPANYREPORTS_HOST = "https://www.companyreports.it";
const REGISTRO_HOST = "https://registroaziende.it/azienda";
const XRAY_HOST = "https://xrayfinance.it";
const COMPANYREPORTS_URL = `${COMPANYREPORTS_HOST}/${VAT}`;
const AZIENDE_PROFILE_SLUG = `rubino-s-r-l-${VAT}`;
const AZIENDE_PROFILE_URL = `${AZIENDE_HOST}/${AZIENDE_PROFILE_SLUG}`;
const AZIENDE_SEARCH_URL =
  `${AZIENDE_HOST}/search?q=${encodeURIComponent(VAT)}`;
const AZIENDE_SEARCH_HTML =
  "<html><body><table class=\"rg-reg\"><tr><td>" +
  `<a class="rg-co" href="/${AZIENDE_PROFILE_SLUG}">` +
  "RUBINO - S.R.L.</a></td></tr></table></body></html>";

/* ---------------------------------------------------------------------------
 * Extension API stubs. These are installed before the provider modules load
 * because some of them capture the namespace at module scope.
 * ------------------------------------------------------------------------- */

function createStorage() {
  let entries = {};
  const readKeys = [];

  return {
    get entries() {
      return entries;
    },
    readKeys,
    clear() {
      entries = {};
      readKeys.length = 0;
    },
    async get(key) {
      if (Array.isArray(key)) {
        readKeys.push(...key);
        const result = {};
        for (const name of key) {
          if (Object.hasOwn(entries, name)) result[name] = entries[name];
        }
        return result;
      }

      readKeys.push(key);
      return Object.hasOwn(entries, key) ? { [key]: entries[key] } : {};
    },
    async set(patch) {
      Object.assign(entries, patch);
    }
  };
}

function htmlResponse(body, { status = 200, url = "" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: {
      get: (name) => (
        String(name).toLowerCase() === "content-type"
          ? "text/html; charset=utf-8"
          : null
      )
    },
    async text() {
      return body;
    }
  };
}

function createNetwork() {
  const calls = [];
  const routes = new Map();
  const prefixes = [];

  return {
    calls,
    route(url, handler) {
      routes.set(String(url), handler);
    },
    reset() {
      calls.length = 0;
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
          return htmlResponse("", { status: 404, url: href });
        }

        return handler(href, options);
      };
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

const storage = createStorage();
const snapshotStore = createSnapshotStore(storage);
const network = createNetwork();
network.install();

const permissionControl = {
  granted: false,
  requestResult: true,
  failRequest: false,
  containsHandler: null,
  containsCalls: [],
  requestCalls: [],
  removedListeners: []
};

const scanState = {
  result: {
    hostname: "example.com",
    title: "Example Srl",
    siteName: "Example Srl",
    brandHints: [],
    candidates: [],
    relatedUrls: [],
    contacts: { emails: [], phones: [] }
  }
};

async function handleSnapshotMessage(message) {
  if (message?.type === "providerSnapshot.read") {
    return { ok: true, value: await snapshotStore.read(message.vat) };
  }

  if (message?.type === "providerSnapshot.write") {
    await snapshotStore.write(message.vat, message.result);
    return { ok: true };
  }

  return { ok: false };
}

const extensionApi = {
  tabs: {
    async query() {
      return [{ id: 1, url: "https://example.com/" }];
    }
  },
  scripting: {
    async executeScript() {
      return [{ frameId: 0, result: scanState.promise ? await scanState.promise : scanState.result }];
    }
  },
  runtime: {
    sendMessage(message) {
      return handleSnapshotMessage(message);
    }
  },
  storage: { local: storage },
  permissions: {
    contains(details) {
      permissionControl.containsCalls.push(details);
      return permissionControl.containsHandler
        ? permissionControl.containsHandler(details)
        : Promise.resolve(permissionControl.granted);
    },
    request(details) {
      permissionControl.requestCalls.push(details);
      if (permissionControl.failRequest) {
        return Promise.reject(new Error("no user gesture"));
      }
      // A real engine applies the decision immediately.
      permissionControl.granted = permissionControl.requestResult;
      return Promise.resolve(permissionControl.requestResult);
    },
    onRemoved: {
      addListener(listener) {
        permissionControl.removedListeners.push(listener);
      },
      removeListener(listener) {
        const index = permissionControl.removedListeners.indexOf(listener);
        if (index >= 0) permissionControl.removedListeners.splice(index, 1);
      }
    }
  }
};

globalThis.browser = extensionApi;
globalThis.chrome = extensionApi;

const { buildXraySlugCandidates } = await import("../src/providers/xray.js");
const { buildRegistroSlugCandidates } = await import(
  "../src/providers/registroaziende.js"
);

const FIXTURES = {
  companyReports: await loadFixture("companyreports/rubino.html"),
  registro: await loadFixture("registro/rubino.html"),
  xray: await loadFixture("xray/rubino.html"),
  aziendeProfile: (await loadFixture("aziende-profile.html"))
    .replaceAll("11941480961", VAT),
  popupHtml: await readFile(
    new URL("../src/popup/popup.html", import.meta.url),
    "utf8"
  )
};

const xrayUrl = () =>
  `${XRAY_HOST}/${encodeURIComponent(buildXraySlugCandidates(NAMES)[0])}`;
const registroUrls = () =>
  buildRegistroSlugCandidates(NAMES).map(
    (slug) => `${REGISTRO_HOST}/${encodeURIComponent(slug)}`
  );

function installCanonicalRoutes() {
  network.route(COMPANYREPORTS_URL, () =>
    htmlResponse(FIXTURES.companyReports, { url: COMPANYREPORTS_URL })
  );

  for (const url of registroUrls()) {
    network.route(url, () => htmlResponse(FIXTURES.registro, { url }));
  }

  network.route(xrayUrl(), () =>
    htmlResponse(FIXTURES.xray, { url: xrayUrl() })
  );
}

function installAziendeRoutes(handler = null) {
  network.route(AZIENDE_SEARCH_URL, () =>
    handler
      ? handler()
      : htmlResponse(AZIENDE_SEARCH_HTML, { url: AZIENDE_SEARCH_URL })
  );
  network.route(AZIENDE_PROFILE_URL, () =>
    htmlResponse(FIXTURES.aziendeProfile, { url: AZIENDE_PROFILE_URL })
  );
}

/* ---------------------------------------------------------------------------
 * Fake DOM
 * ------------------------------------------------------------------------- */

function parseAttributes(source) {
  const attributes = {};

  for (const match of String(source || "").matchAll(
    /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
  )) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? "";
  }

  return attributes;
}

function elementClasses(html) {
  const map = new Map();

  for (const match of String(html).matchAll(/<([a-zA-Z][\w-]*)\b([^>]*)>/g)) {
    const attributes = parseAttributes(match[2]);
    if (attributes.id) map.set(attributes.id, attributes.class || "");
  }

  return map;
}

function createFakeElement(tagName = "div") {
  const classes = new Set();
  const listeners = new Map();

  const element = {
    tagName: String(tagName).toUpperCase(),
    children: [],
    textContent: "",
    value: "",
    href: "",
    open: false,
    disabled: false,
    className: "",
    classList: {
      add(...names) {
        for (const name of names) classes.add(name);
      },
      remove(...names) {
        for (const name of names) classes.delete(name);
      },
      contains(name) {
        return classes.has(name);
      },
      toggle(name, force) {
        const shouldHave = force === undefined
          ? !classes.has(name)
          : Boolean(force);
        if (shouldHave) classes.add(name);
        else classes.delete(name);
        return shouldHave;
      }
    },
    append(...items) {
      element.children.push(...items);
    },
    replaceChildren(...items) {
      element.children.length = 0;
      element.children.push(...items);
    },
    addEventListener(type, handler) {
      const list = listeners.get(type) || [];
      list.push(handler);
      listeners.set(type, list);
    },
    dispatch(type) {
      for (const handler of [...(listeners.get(type) || [])]) {
        handler({ type, target: element });
      }
    },
    focus() {},
    querySelector(selector) {
      if (selector === ".unidentified-copy") {
        element._unidentifiedCopy ||= createFakeElement("p");
        return element._unidentifiedCopy;
      }
      throw new Error(`unsupported element selector: ${selector}`);
    }
  };

  return element;
}

function createFakeDom(html) {
  const classMap = elementClasses(html);
  const nodes = new Map();

  function node(id) {
    if (!nodes.has(id)) {
      const element = createFakeElement("div");
      for (const name of String(classMap.get(id) || "").split(/\s+/).filter(Boolean)) {
        element.classList.add(name);
      }
      nodes.set(id, element);
    }
    return nodes.get(id);
  }

  return {
    nodes,
    document: {
      querySelector(selector) {
        if (!selector.startsWith("#")) {
          throw new Error(`unsupported selector: ${selector}`);
        }
        return node(selector.slice(1));
      },
      createElement(tagName) {
        return createFakeElement(tagName);
      }
    }
  };
}

/* ---------------------------------------------------------------------------
 * Harness lifecycle
 * ------------------------------------------------------------------------- */

async function settle(rounds = 10) {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function delay(milliseconds) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate, { timeout = 5000, label = "condition" } = {}) {
  const start = Date.now();

  while (!predicate()) {
    if (Date.now() - start > timeout) {
      throw new Error(`timed out waiting for ${label}`);
    }
    await delay(10);
  }
}

let scenarioCounter = 0;

async function launchPopup({ permission = {}, seed = null, routes = null, scan = {}, scanPromise = null, firefox = true } = {}) {
  if (firefox) extensionApi.runtime.getBrowserInfo = async () => ({ name: "Firefox" });
  else delete extensionApi.runtime.getBrowserInfo;
  storage.clear();
  network.reset();

  permissionControl.granted = permission.granted === true;
  permissionControl.requestResult = permission.requestResult !== false;
  permissionControl.failRequest = permission.failRequest === true;
  permissionControl.containsHandler = permission.containsHandler || null;
  permissionControl.containsCalls.length = 0;
  permissionControl.requestCalls.length = 0;
  permissionControl.removedListeners.length = 0;

  if (Array.isArray(seed)) {
    for (const entry of seed) {
      await snapshotStore.write(entry.vat, entry.result);
    }
  } else if (seed) {
    await snapshotStore.write(VAT, seed);
  }
  if (routes) routes();

  const dom = createFakeDom(FIXTURES.popupHtml);
  globalThis.document = dom.document;
  scanState.promise = scanPromise;
  scanState.result = {
    hostname: "example.com",
    title: "Example Srl",
    siteName: "Example Srl",
    brandHints: [],
    candidates: [],
    relatedUrls: [],
    contacts: { emails: [], phones: [] },
    ...scan
  };

  await import(`../src/popup/popup.js?scenario=${++scenarioCounter}`);
  await settle();

  const elements = dom.nodes;
  const isHidden = (id) => elements.get(id).classList.contains("hidden");

  const manualLookup = async (vat = VAT) => {
    elements.get("vat-input").value = vat;
    elements.get("check-button").dispatch("click");
    await settle();
  };

  const callsTo = (prefix) =>
    network.calls.filter((url) => url.startsWith(prefix)).length;

  const aziendeCacheReads = () =>
    storage.readKeys.filter((key) => String(key).startsWith("aziende:")).length;

  return {
    elements,
    isHidden,
    manualLookup,
    callsTo,
    aziendeCacheReads,
    snapshotStore
  };
}

function createRejectionTracker(t) {
  const rejections = [];
  const listener = (reason) => rejections.push(reason);

  process.on("unhandledRejection", listener);
  t.after(() => process.off("unhandledRejection", listener));

  return rejections;
}

/* ---------------------------------------------------------------------------
 * Runtime behaviour
 * ------------------------------------------------------------------------- */

test("missing permission never touches Aziende.it, and granting updates the displayed company", async (t) => {
  const rejections = createRejectionTracker(t);
  const aziendeSearch = deferred();

  const handle = await launchPopup({
    permission: { granted: false, requestResult: true },
    routes: () => {
      installCanonicalRoutes();
      installAziendeRoutes(() => aziendeSearch.promise);
    }
  });

  await handle.manualLookup();
  await waitFor(() => !handle.isHidden("company-view"), {
    label: "company view"
  });

  // The company is rendered from the canonical providers, with the prompt in
  // place of the comparison.
  assert.equal(handle.elements.get("company-vat").textContent, `IT ${VAT}`);
  assert.equal(handle.isHidden("sector-comparison-section"), false);
  assert.equal(handle.isHidden("sector-permission"), false);
  assert.equal(handle.isHidden("sector-data"), true);

  // No Aziende.it request, no provider cache read, no permission request.
  assert.equal(handle.callsTo(AZIENDE_HOST), 0);
  assert.equal(handle.aziendeCacheReads(), 0);
  assert.equal(permissionControl.requestCalls.length, 0);

  const companyReportsBefore = handle.callsTo(COMPANYREPORTS_HOST);

  const enable = handle.elements.get("enable-aziende");
  enable.dispatch("click");

  // `permissions.request` runs synchronously inside the click gesture.
  assert.equal(permissionControl.requestCalls.length, 1);
  assert.deepEqual(permissionControl.requestCalls[0], {
    origins: [AZIENDE_HOST_PATTERN]
  });

  await waitFor(() => network.calls.includes(AZIENDE_SEARCH_URL), {
    label: "targeted Aziende.it lookup"
  });

  assert.equal(handle.isHidden("sector-permission"), true);
  assert.equal(handle.callsTo(AZIENDE_HOST), 1);

  // The existing completion indicator covers the targeted lookup.
  await delay(450);
  assert.equal(handle.isHidden("data-completion-status"), false);

  aziendeSearch.resolve(
    htmlResponse(AZIENDE_SEARCH_HTML, { url: AZIENDE_SEARCH_URL })
  );
  await waitFor(() => !handle.isHidden("sector-data"), {
    label: "sector comparison"
  });

  assert.equal(handle.isHidden("sector-permission"), true);
  assert.match(
    handle.elements.get("sector-company-revenue").textContent,
    /Fatturato azienda/
  );
  assert.match(
    handle.elements.get("sector-median-revenue").textContent,
    /Mediana settore/
  );

  // Exactly one targeted lookup, persisted through the existing snapshot slot.
  assert.equal(
    network.calls.filter((url) => url === AZIENDE_SEARCH_URL).length,
    1
  );
  const snapshot = await handle.snapshotStore.read(VAT);
  assert.equal(snapshot.value.aziende.provider, "Aziende.it");

  // The canonical providers were not rerun to enrich the view.
  assert.equal(handle.callsTo(COMPANYREPORTS_HOST), companyReportsBefore);
  assert.deepEqual(rejections, []);
});

test("a cached Aziende.it comparison stays hidden until the permission is granted", async (t) => {
  const rejections = createRejectionTracker(t);

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
      year: 2024,
      province: "TO",
      sampleSize: 1090,
      differencePct: -51.1
    }
  };

  const handle = await launchPopup({
    permission: { granted: false, requestResult: true },
    seed: {
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
    },
    routes: () => {
      installCanonicalRoutes();
      installAziendeRoutes();
    }
  });

  // Provider-host calls only: the manual lookup itself still asks VIES.
  const providerCalls = () =>
    network.calls.filter((url) =>
      url.startsWith(COMPANYREPORTS_HOST) ||
      url.startsWith(REGISTRO_HOST) ||
      url.startsWith(XRAY_HOST) ||
      url.startsWith(AZIENDE_HOST)
    );

  const networkBefore = providerCalls();

  await handle.manualLookup();
  await waitFor(() => !handle.isHidden("company-view"), {
    label: "company view"
  });

  // The cached snapshot is served without a single provider request; the cached
  // comparison is hidden and the prompt is shown instead.
  assert.deepEqual(providerCalls(), networkBefore);
  assert.equal(handle.callsTo(AZIENDE_HOST), 0);
  assert.equal(handle.isHidden("sector-permission"), false);
  assert.equal(handle.isHidden("sector-data"), true);
  assert.equal(handle.aziendeCacheReads(), 0);

  handle.elements.get("enable-aziende").dispatch("click");
  await waitFor(() => !handle.isHidden("sector-data"), {
    label: "sector comparison after grant"
  });

  assert.equal(handle.isHidden("sector-permission"), true);
  assert.match(
    handle.elements.get("sector-median-revenue").textContent,
    /Mediana settore/
  );

  const snapshot = await handle.snapshotStore.read(VAT);
  assert.equal(snapshot.value.aziende.provider, "Aziende.it");
  assert.deepEqual(rejections, []);
});

test("revoking the permission hides the comparison and late patches cannot leak it back", async (t) => {
  const rejections = createRejectionTracker(t);
  const aziendeSearch = deferred();

  const handle = await launchPopup({
    permission: { granted: true },
    routes: () => {
      installCanonicalRoutes();
      installAziendeRoutes(() => aziendeSearch.promise);
    }
  });

  await handle.manualLookup();
  await waitFor(() => !handle.isHidden("company-view"), {
    label: "company view"
  });
  await waitFor(() => network.calls.includes(AZIENDE_SEARCH_URL), {
    label: "Aziende.it lookup"
  });

  // Granted: no prompt, but the comparison has not arrived yet.
  assert.equal(handle.isHidden("sector-permission"), true);
  assert.equal(handle.isHidden("sector-data"), true);

  const listener = permissionControl.removedListeners[0];
  assert.equal(typeof listener, "function");
  permissionControl.granted = false;
  listener({ origins: [AZIENDE_HOST_PATTERN] });

  // The prompt comes back immediately, the cached comparison is not rendered.
  assert.equal(handle.isHidden("sector-permission"), false);
  assert.equal(handle.isHidden("sector-data"), true);

  // A late completion still in flight must not render the comparison.
  aziendeSearch.resolve(
    htmlResponse(AZIENDE_SEARCH_HTML, { url: AZIENDE_SEARCH_URL })
  );
  await settle(20);
  await delay(50);

  assert.equal(handle.isHidden("sector-data"), true);
  assert.equal(handle.isHidden("sector-permission"), false);
  assert.deepEqual(rejections, []);
});

test("a denied or failing permission request leaves a usable button and no request", async (t) => {
  const rejections = createRejectionTracker(t);

  const handle = await launchPopup({
    permission: { granted: false, requestResult: false },
    routes: () => {
      installCanonicalRoutes();
      installAziendeRoutes();
    }
  });

  await handle.manualLookup();
  await waitFor(() => !handle.isHidden("company-view"), {
    label: "company view"
  });

  const enable = handle.elements.get("enable-aziende");

  enable.dispatch("click");
  assert.equal(permissionControl.requestCalls.length, 1);
  await settle();

  assert.equal(permissionControl.requestResult, false);
  assert.equal(enable.disabled, false);
  assert.equal(handle.isHidden("sector-permission"), false);
  assert.equal(handle.callsTo(AZIENDE_HOST), 0);

  // An engine error follows the same path: usable button, prompt intact.
  permissionControl.failRequest = true;
  enable.dispatch("click");
  await settle();

  assert.equal(permissionControl.requestCalls.length, 2);
  assert.equal(enable.disabled, false);
  assert.equal(handle.isHidden("sector-permission"), false);
  assert.equal(handle.callsTo(AZIENDE_HOST), 0);
  assert.deepEqual(rejections, []);
});

test("a changed displayed VAT blocks the granted targeted lookup", async (t) => {
  createRejectionTracker(t);

  const handle = await launchPopup({
    permission: { granted: false, requestResult: true },
    routes: () => {
      installCanonicalRoutes();
      installAziendeRoutes();
    }
  });

  await handle.manualLookup();
  await waitFor(() => !handle.isHidden("company-view"), {
    label: "company view"
  });

  // The displayed company changed before the user granted the permission.
  handle.elements.get("company-vat").textContent = "IT 11122233344";
  handle.elements.get("enable-aziende").dispatch("click");
  await settle(20);
  await delay(50);

  assert.equal(permissionControl.requestCalls.length, 1);
  assert.equal(handle.callsTo(AZIENDE_HOST), 0);
});

test("a late Aziende.it patch from a previous lookup never lands on the new company", async (t) => {
  const rejections = createRejectionTracker(t);
  const VAT_2 = "11295150152";
  const searchUrl1 = AZIENDE_SEARCH_URL;
  const searchUrl2 = `${AZIENDE_HOST}/search?q=${encodeURIComponent(VAT_2)}`;
  const profileUrl2 = `${AZIENDE_HOST}/rubino-s-r-l-${VAT_2}`;
  const searchHtml2 =
    "<html><body><table class=\"rg-reg\"><tr><td>" +
    `<a class="rg-co" href="/rubino-s-r-l-${VAT_2}">` +
    "FUTURE TECH - S.R.L.</a></td></tr></table></body></html>";

  const aziendeSearch1 = deferred();
  const aziendeSearch2 = deferred();

  const cachedCompany = (vat, name) => ({
    primary: { provider: "CompanyReports.it", vat, name },
    companyReports: { provider: "CompanyReports.it", vat, name },
    aziende: null,
    xray: { provider: "Xray Finance", vat },
    registro: { provider: "RegistroAziende.it", vat, name },
    verification: null
  });

  const handle = await launchPopup({
    permission: { granted: true },
    seed: [
      {
        vat: VAT,
        result: cachedCompany(VAT, "RUBINO - S.R.L.")
      },
      {
        vat: VAT_2,
        result: cachedCompany(VAT_2, "FUTURE TECH - S.R.L.")
      }
    ],
    routes: () => {
      installCanonicalRoutes();
      installAziendeRoutes(() => aziendeSearch1.promise);
      network.route(searchUrl2, () => aziendeSearch2.promise);
      network.route(profileUrl2, () =>
        htmlResponse(FIXTURES.aziendeProfile.replaceAll(VAT, VAT_2), {
          url: profileUrl2
        })
      );
    }
  });

  await handle.manualLookup(VAT);
  await waitFor(() => network.calls.includes(searchUrl1), {
    label: "first Aziende.it lookup"
  });

  // A new lookup for another company invalidates the first one.
  await handle.manualLookup(VAT_2);
  await waitFor(
    () => handle.elements.get("company-vat").textContent === `IT ${VAT_2}`,
    { label: "second company view" }
  );
  await waitFor(() => network.calls.includes(searchUrl2), {
    label: "second Aziende.it lookup"
  });

  // The previous company's patch arrives after the new lookup started: it is
  // fetched but must never render on the new company.
  aziendeSearch1.resolve(
    htmlResponse(AZIENDE_SEARCH_HTML, { url: searchUrl1 })
  );
  await settle(20);
  await delay(50);

  assert.ok(network.calls.includes(AZIENDE_PROFILE_URL));
  assert.equal(handle.isHidden("sector-data"), true);

  // The lookup belonging to the displayed company still applies.
  aziendeSearch2.resolve(htmlResponse(searchHtml2, { url: searchUrl2 }));
  await waitFor(() => !handle.isHidden("sector-data"), {
    label: "current company sector comparison"
  });
  assert.match(
    handle.elements.get("sector-company-revenue").textContent,
    /Fatturato azienda/
  );
  assert.deepEqual(rejections, []);
});

function cachedCompany(vat = VAT, comparison = true) {
  const canonical = { provider: "CompanyReports.it", vat, name: "RUBINO - S.R.L." };
  return {
    primary: canonical, companyReports: canonical,
    registro: { ...canonical, provider: "RegistroAziende.it" },
    xray: { ...canonical, provider: "Xray Finance" },
    aziende: comparison ? { provider: "Aziende.it", vat, sectorComparison: {
      sourceName: "Aziende.it", companyRevenue: 191540, medianRevenue: 392007,
      year: 2024, province: "TO", differencePct: -51.14
    }} : null
  };
}

test("revocation clears displayed sector data after an invalid replacement VAT", async () => {
  const handle = await launchPopup({ permission: { granted: true }, seed: cachedCompany() });
  await handle.manualLookup();
  await waitFor(() => !handle.isHidden("sector-data"));
  await handle.manualLookup("123");
  permissionControl.granted = false;
  permissionControl.removedListeners[0]({ origins: [AZIENDE_HOST_PATTERN] });
  assert.equal(handle.isHidden("company-view"), false);
  assert.equal(handle.isHidden("sector-data"), true);
  assert.equal(handle.isHidden("sector-permission"), false);
  assert.doesNotMatch(handle.elements.get("provider-source").textContent, /(?:^|[:,] )Aziende\.it(?:,|$)/);
});

test("a startup contains result cannot overwrite a later permission grant", async () => {
  const startup = deferred();
  let reads = 0;
  const handle = await launchPopup({
    permission: { containsHandler: () => ++reads === 1 ? startup.promise : Promise.resolve(permissionControl.granted) },
    seed: cachedCompany(VAT, false),
    routes: installAziendeRoutes
  });
  await handle.manualLookup();
  await waitFor(() => !handle.isHidden("sector-permission"));
  handle.elements.get("enable-aziende").dispatch("click");
  await waitFor(() => !handle.isHidden("sector-data"));
  startup.resolve(false);
  await settle(20);
  assert.equal(handle.isHidden("sector-permission"), true);
  assert.equal(handle.isHidden("sector-data"), false);
});

test("a startup contains result cannot undo a later permission revocation", async () => {
  const startup = deferred();
  let reads = 0;
  const handle = await launchPopup({
    permission: { granted: true, containsHandler: () => ++reads === 1 ? startup.promise : Promise.resolve(permissionControl.granted) },
    seed: cachedCompany()
  });
  await handle.manualLookup();
  await waitFor(() => !handle.isHidden("sector-data"));
  permissionControl.granted = false;
  permissionControl.removedListeners[0]({ origins: [AZIENDE_HOST_PATTERN] });
  startup.resolve(true);
  await settle(20);
  assert.equal(handle.isHidden("sector-permission"), false);
  assert.equal(handle.isHidden("sector-data"), true);
});

test("grant during a replacement lookup enriches the visible and then replacement VAT", async (t) => {
  const nextVat = "11295150152";
  const delayedRead = deferred();
  const oldSearch = deferred();
  const originalSend = extensionApi.runtime.sendMessage;
  let waiting = false;
  const nextSearch = AZIENDE_HOST + "/search?q=" + nextVat;
  const nextProfile = AZIENDE_HOST + "/replacement-company";
  const handle = await launchPopup({
    seed: [{ vat: VAT, result: cachedCompany(VAT, false) }, { vat: nextVat, result: cachedCompany(nextVat, false) }],
    routes: () => {
      installAziendeRoutes(() => oldSearch.promise);
      network.route(nextSearch, () => htmlResponse('<table class="rg-reg"><tr><td><a class="rg-co" href="/replacement-company">Replacement</a></td></tr></table>', { url: nextSearch }));
      network.route(nextProfile, () => htmlResponse(FIXTURES.aziendeProfile.replaceAll(VAT, nextVat), { url: nextProfile }));
    }
  });
  t.after(async () => {
    delayedRead.resolve();
    oldSearch.resolve(htmlResponse(AZIENDE_SEARCH_HTML, { url: AZIENDE_SEARCH_URL }));
    await settle(20);
    extensionApi.runtime.sendMessage = originalSend;
  });
  await handle.manualLookup();
  await waitFor(() => !handle.isHidden("sector-permission"));
  extensionApi.runtime.sendMessage = async (message) => {
    if (message.type === "providerSnapshot.read" && message.vat === nextVat) {
      waiting = true;
      await delayedRead.promise;
    }
    return originalSend(message);
  };
  await handle.manualLookup(nextVat);
  await waitFor(() => waiting);
  handle.elements.get("enable-aziende").dispatch("click");
  await waitFor(() => network.calls.includes(AZIENDE_SEARCH_URL), { label: "currently displayed VAT enrichment after grant" });
  delayedRead.resolve();
  await waitFor(() => handle.elements.get("company-vat").textContent.includes(nextVat));
  await waitFor(() => !handle.isHidden("sector-data"), { label: "replacement VAT enrichment after grant" });
  // The previous card remains in flight, but no longer contributes useful work.
  await delay(450);
  assert.equal(handle.isHidden("data-completion-status"), true);
  assert.ok(network.calls.includes(nextSearch));
  assert.equal(handle.isHidden("sector-permission"), true);
  assert.equal((await snapshotStore.read(nextVat)).value.aziende.vat, nextVat);
});

test("a domain-discovered visible card accepts grant and revocation after an invalid VAT", async () => {
  const handle = await launchPopup({
    scan: { hostname: "rubino-srl.com", title: `RUBINO - S.R.L. ${VAT}`, siteName: "RUBINO - S.R.L." },
    seed: cachedCompany(VAT, false),
    routes: () => {
      installAziendeRoutes();
      storage.entries[`companyreports:v1:vat:${VAT}`] = {
        cachedAt: Date.now(), value: cachedCompany().companyReports
      };
    }
  });
  await waitFor(() => !handle.isHidden("company-view"), { label: "domain-discovered card" });
  assert.match(handle.elements.get("source-status").textContent, /dominio|rubino-srl/);
  await handle.manualLookup("123");
  handle.elements.get("enable-aziende").dispatch("click");
  await waitFor(() => !handle.isHidden("sector-data"), { label: "grant on inactive domain card" });
  permissionControl.granted = false;
  permissionControl.removedListeners[0]({ origins: [AZIENDE_HOST_PATTERN] });
  assert.equal(handle.isHidden("sector-data"), true);
  assert.equal(handle.isHidden("sector-permission"), false);
  assert.doesNotMatch(handle.elements.get("provider-source").textContent, /(?:^|[:,] )Aziende\.it(?:,|$)/);
});

test("regrant restores a cached comparison while the original refresh is pending and then misses", async (t) => {
  const search = deferred();
  const handle = await launchPopup({ seed: cachedCompany(), routes: () => installAziendeRoutes(() => search.promise) });
  t.after(async () => { search.resolve(htmlResponse("", { status: 404, url: AZIENDE_SEARCH_URL })); await settle(20); });
  await handle.manualLookup();
  handle.elements.get("enable-aziende").dispatch("click");
  await waitFor(() => network.calls.includes(AZIENDE_SEARCH_URL));
  await waitFor(() => !handle.isHidden("sector-data"));
  permissionControl.granted = false;
  permissionControl.removedListeners[0]({ origins: [AZIENDE_HOST_PATTERN] });
  assert.equal(handle.isHidden("sector-data"), true);
  handle.elements.get("enable-aziende").dispatch("click");
  await waitFor(() => !handle.isHidden("sector-data"), { label: "cached comparison after regrant" });
  search.resolve(htmlResponse("", { status: 404, url: AZIENDE_SEARCH_URL }));
  await settle(20);
  assert.equal(handle.isHidden("sector-data"), false);
  assert.equal(handle.isHidden("sector-permission"), true);
  assert.equal(handle.callsTo(AZIENDE_HOST), 1);
});

test("a delayed denied grant read cannot rerender an older card for the same VAT", async (t) => {
  const read = deferred();
  const handle = await launchPopup({ seed: cachedCompany() });
  t.after(async () => { read.resolve(false); await settle(20); });
  await handle.manualLookup();
  let pending = false;
  permissionControl.containsHandler = () => {
    if (!pending) { pending = true; return read.promise; }
    return Promise.resolve(permissionControl.granted);
  };
  handle.elements.get("enable-aziende").dispatch("click");
  await waitFor(() => pending);
  const latest = cachedCompany();
  for (const key of ["primary", "companyReports", "registro", "xray"]) latest[key].name = "UPDATED S.R.L.";
  await snapshotStore.write(VAT, latest);
  await handle.manualLookup();
  assert.equal(handle.elements.get("company-name").textContent, "UPDATED S.R.L.");
  permissionControl.granted = false;
  permissionControl.removedListeners[0]({ origins: [AZIENDE_HOST_PATTERN] });
  read.resolve(false);
  await settle(20);
  assert.equal(handle.elements.get("company-name").textContent, "UPDATED S.R.L.");
  assert.equal(handle.isHidden("sector-data"), true);
});

test("a rejected late automatic candidate keeps the displayed manual card permission controls", async (t) => {
  const scan = deferred();
  const otherVat = "11295150152";
  const handle = await launchPopup({
    permission: { granted: true }, scanPromise: scan.promise,
    seed: [{ vat: VAT, result: cachedCompany() }, { vat: otherVat, result: cachedCompany(otherVat, false) }],
    routes: installAziendeRoutes
  });
  t.after(async () => { scan.resolve(scanState.result); await settle(20); });
  await handle.manualLookup();
  await waitFor(() => !handle.isHidden("sector-data"));
  const readCount = storage.readKeys.length;
  scan.resolve({ ...scanState.result, candidates: [{ vat: otherVat, evidenceType: "vat_company_page" }] });
  await waitFor(() => storage.readKeys.slice(readCount).includes('provider-orchestrator:v9:' + otherVat));
  await settle(20);
  assert.equal(handle.elements.get("company-vat").textContent, 'IT ' + VAT);
  permissionControl.granted = false;
  permissionControl.removedListeners[0]({ origins: [AZIENDE_HOST_PATTERN] });
  assert.equal(handle.isHidden("sector-data"), true);
  assert.equal(handle.isHidden("sector-permission"), false);
  handle.elements.get("enable-aziende").dispatch("click");
  await waitFor(() => !handle.isHidden("sector-data"));
  assert.equal(handle.elements.get("company-vat").textContent, 'IT ' + VAT);
});

async function exerciseLateAcceptanceGrant(t, initiallyGranted) {
  const scan = deferred();
  const providerRead = deferred();
  const aziendeGate = deferred();
  let gateWaiting = false;
  const nextVat = "11295150152";
  const next = cachedCompany(nextVat, false);
  next.companyReports = null;
  const nextSearch = AZIENDE_HOST + "/search?q=" + nextVat;
  const nextProfile = AZIENDE_HOST + "/late-accepted-company";
  const originalGet = storage.get;
  let waiting = false;
  const handle = await launchPopup({
    scanPromise: scan.promise,
    permission: { granted: initiallyGranted },
    seed: [{ vat: VAT, result: cachedCompany() }, { vat: nextVat, result: next }],
    routes: () => {
      installAziendeRoutes();
      network.route(nextSearch, () => htmlResponse('<table class="rg-reg"><tr><td><a class="rg-co" href="/late-accepted-company">Owner</a></td></tr></table>', { url: nextSearch }));
      network.route(nextProfile, () => htmlResponse(FIXTURES.aziendeProfile.replaceAll(VAT, nextVat), { url: nextProfile }));
      storage.entries['companyreports:v1:vat:' + nextVat] = { cachedAt: Date.now(), value: { provider: "CompanyReports.it", vat: nextVat, name: "OWNER S.R.L." } };
    }
  });
  t.after(async () => { providerRead.resolve(); aziendeGate.resolve(false); scan.resolve(scanState.result); await settle(20); storage.get = originalGet; });
  await handle.manualLookup();
  storage.get = async (key) => {
    if (key === 'companyreports:v1:vat:' + nextVat) { waiting = true; await providerRead.promise; }
    return originalGet(key);
  };
  if (initiallyGranted) {
    let permissionReads = 0;
    permissionControl.containsHandler = () => {
      if (++permissionReads === 2) { gateWaiting = true; return aziendeGate.promise; }
      return Promise.resolve(permissionControl.granted);
    };
  }
  scan.resolve({ ...scanState.result, hostname: "owner.it", title: "OWNER S.R.L.", siteName: "OWNER S.R.L.", candidates: [{ vat: nextVat, evidenceType: "vat_metadata" }] });
  await waitFor(() => waiting);
  await settle(20);
  assert.equal(handle.elements.get("company-vat").textContent, "IT " + VAT);
  if (initiallyGranted) {
    await waitFor(() => gateWaiting);
    permissionControl.granted = false;
    permissionControl.removedListeners[0]({ origins: [AZIENDE_HOST_PATTERN] });
    aziendeGate.resolve(false);
    await settle(20);
    assert.ok(!network.calls.includes(nextSearch));
  }
  handle.elements.get("enable-aziende").dispatch("click");
  await waitFor(() => permissionControl.granted);
  providerRead.resolve();
  await waitFor(() => handle.elements.get("company-vat").textContent === 'IT ' + nextVat);
  await waitFor(() => network.calls.includes(nextSearch), { label: "late accepted company sector lookup after grant" });
  await waitFor(() => !handle.isHidden("sector-data"));
  assert.equal((await snapshotStore.read(nextVat)).value.aziende.vat, nextVat);
}

test("a first late accepted automatic card catches up a grant made on the prior visible card", async (t) => {
  await exerciseLateAcceptanceGrant(t, false);
});

test("a late accepted card catches up a regrant after its initially allowed Aziende channel was denied", async (t) => {
  await exerciseLateAcceptanceGrant(t, true);
});

test("Firefox permission note follows missing, denied, granted and revoked permission", async () => {
  const handle = await launchPopup({ seed: cachedCompany(), permission: { requestResult: false }, routes: installAziendeRoutes });
  assert.equal(handle.isHidden("aziende-firefox-note"), true);
  await handle.manualLookup();
  assert.equal(handle.isHidden("aziende-firefox-note"), false);
  handle.elements.get("enable-aziende").dispatch("click");
  await settle();
  assert.equal(handle.isHidden("aziende-firefox-note"), false);
  permissionControl.requestResult = true;
  handle.elements.get("enable-aziende").dispatch("click");
  await waitFor(() => !handle.isHidden("sector-data"));
  assert.equal(handle.isHidden("aziende-firefox-note"), true);
  permissionControl.granted = false;
  permissionControl.removedListeners[0]({ origins: [AZIENDE_HOST_PATTERN] });
  assert.equal(handle.isHidden("aziende-firefox-note"), false);
});

test("Chromium browsers never show the Firefox note, even with a browser namespace and missing permission", async () => {
  const handle = await launchPopup({ firefox: false, seed: cachedCompany(), permission: { requestResult: false } });
  await handle.manualLookup();
  assert.equal(handle.isHidden("sector-permission"), false);
  assert.equal(handle.isHidden("aziende-firefox-note"), true);
  handle.elements.get("enable-aziende").dispatch("click");
  await settle();
  assert.equal(handle.isHidden("aziende-firefox-note"), true);
});

test("Firefox with an already granted permission never shows the note", async () => {
  const handle = await launchPopup({ seed: cachedCompany(), permission: { granted: true } });
  await handle.manualLookup();
  assert.equal(handle.isHidden("aziende-firefox-note"), true);
  assert.equal(handle.isHidden("sector-permission"), true);
});
