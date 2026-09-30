import test from "node:test";
import assert from "node:assert/strict";

import {
  AZIENDE_HOST_PATTERN,
  AZIENDE_ORIGIN,
  aziendePermissionRequest,
  hasAziendePermission,
  requestAziendePermission,
  watchAziendePermissionRemoved
} from "../src/permissions.js";

const EXPECTED_REQUEST = { origins: [AZIENDE_HOST_PATTERN] };

function withGlobals(t, { browser, chrome } = {}) {
  const previousBrowser = globalThis.browser;
  const previousChrome = globalThis.chrome;

  if (browser === undefined) delete globalThis.browser;
  else globalThis.browser = browser;

  if (chrome === undefined) delete globalThis.chrome;
  else globalThis.chrome = chrome;

  t.after(() => {
    if (previousBrowser === undefined) delete globalThis.browser;
    else globalThis.browser = previousBrowser;

    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  });
}

test("the optional permission is requested for the exact Aziende.it origin", () => {
  assert.equal(AZIENDE_HOST_PATTERN, "https://www.aziende.it/*");
  assert.equal(AZIENDE_ORIGIN, "https://www.aziende.it");
  assert.deepEqual(aziendePermissionRequest(), EXPECTED_REQUEST);
});

test("Firefox promise API reports the granted and missing states", async (t) => {
  const calls = [];
  let granted = true;

  withGlobals(t, {
    browser: {
      permissions: {
        contains(details) {
          calls.push(details);
          return Promise.resolve(granted);
        }
      }
    }
  });

  assert.equal(await hasAziendePermission(), true);

  granted = false;
  assert.equal(await hasAziendePermission(), false);

  assert.deepEqual(calls[0], EXPECTED_REQUEST);
  assert.deepEqual(calls[1], EXPECTED_REQUEST);
});

test("Firefox request is invoked synchronously and resolves the grant state", async (t) => {
  const calls = [];
  let answer = true;

  withGlobals(t, {
    browser: {
      permissions: {
        request(details) {
          calls.push(details);
          return Promise.resolve(answer);
        }
      }
    }
  });

  const granted = requestAziendePermission();
  // No `await` may happen before the engine sees the user gesture.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], EXPECTED_REQUEST);
  assert.equal(await granted, true);

  answer = false;
  assert.equal(await requestAziendePermission(), false);
});

test("a failing promise API answers false instead of throwing", async (t) => {
  withGlobals(t, {
    browser: {
      permissions: {
        contains: () => Promise.reject(new Error("nope")),
        request: () => {
          throw new Error("gesture rejected");
        }
      }
    }
  });

  assert.equal(await hasAziendePermission(), false);
  assert.equal(await requestAziendePermission(), false);
});

test("Chromium callback API reports the granted and missing states", async (t) => {
  const calls = [];
  let granted = true;

  withGlobals(t, {
    chrome: {
      permissions: {
        contains(details, callback) {
          calls.push(details);
          callback(granted);
        }
      }
    }
  });

  assert.equal(await hasAziendePermission(), true);

  granted = false;
  assert.equal(await hasAziendePermission(), false);
  assert.deepEqual(calls[0], EXPECTED_REQUEST);
  assert.deepEqual(calls[1], EXPECTED_REQUEST);
});

test("a Chromium runtime error answers false without rejecting", async (t) => {
  withGlobals(t, {
    chrome: {
      runtime: { lastError: { message: "permission unknown" } },
      permissions: {
        contains: (details, callback) => callback(true),
        request: (details, callback) => callback(true)
      }
    }
  });

  assert.equal(await hasAziendePermission(), false);
  assert.equal(await requestAziendePermission(), false);
});

test("Chromium request is invoked synchronously and tolerates a throw", async (t) => {
  const calls = [];

  withGlobals(t, {
    chrome: {
      permissions: {
        request(details, callback) {
          calls.push(details);
          callback(true);
        }
      }
    }
  });

  const granted = requestAziendePermission();
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], EXPECTED_REQUEST);
  assert.equal(await granted, true);

  withGlobals(t, {
    chrome: {
      permissions: {
        request() {
          throw new Error("no user gesture");
        }
      }
    }
  });

  assert.equal(await requestAziendePermission(), false);
});

test("an unavailable permissions API keeps the provider disabled", async (t) => {
  withGlobals(t, { browser: { permissions: {} }, chrome: undefined });

  assert.equal(await hasAziendePermission(), false);
  assert.equal(await requestAziendePermission(), false);

  withGlobals(t, { browser: undefined, chrome: {} });
  assert.equal(await hasAziendePermission(), false);
  assert.equal(await requestAziendePermission(), false);
});

test("removal listeners fire for the Aziende.it origin and can be disposed", (t) => {
  const added = [];
  const removed = [];
  const events = [];

  withGlobals(t, {
    chrome: {
      permissions: {
        onRemoved: {
          addListener(listener) {
            added.push(listener);
          },
          removeListener(listener) {
            removed.push(listener);
          }
        }
      }
    }
  });

  const dispose = watchAziendePermissionRemoved((details) => events.push(details));
  assert.equal(added.length, 1);

  added[0]({ origins: ["https://example.com/*"] });
  assert.deepEqual(events, []);

  added[0]({ origins: ["https://www.aziende.it/*"] });
  assert.equal(events.length, 1);

  added[0]({ origins: [AZIENDE_ORIGIN] });
  assert.equal(events.length, 2);

  dispose();
  assert.equal(removed.length, 1);
});

test("unsupported removal events are a safe no-op", () => {
  const previousChrome = globalThis.chrome;
  const previousBrowser = globalThis.browser;
  delete globalThis.chrome;
  delete globalThis.browser;

  try {
    const dispose = watchAziendePermissionRemoved(() => {
      throw new Error("must never run");
    });
    assert.equal(typeof dispose, "function");
    dispose();
  } finally {
    if (previousChrome !== undefined) globalThis.chrome = previousChrome;
    if (previousBrowser !== undefined) globalThis.browser = previousBrowser;
  }
});
