import assert from "node:assert/strict";
import test from "node:test";

import { readSnapshot, writeSnapshot } from "../src/providers/snapshot-client.js";

const originalBrowser = globalThis.browser;
const originalChrome = globalThis.chrome;

test.after(() => {
  globalThis.browser = originalBrowser;
  globalThis.chrome = originalChrome;
});

test("serializes only persisted fields when resolver result contains live promises", async () => {
  const messages = [];
  globalThis.browser = {
    runtime: {
      async sendMessage(message) {
        // Extension messaging cannot clone the resolver's enrichment promises.
        messages.push(structuredClone(message));
        return { ok: true };
      }
    }
  };
  globalThis.chrome = undefined;

  await writeSnapshot("11295150152", {
    primary: { name: "Acme" },
    companyReports: { name: "Acme", provider: "CompanyReports.it" },
    aziende: { name: "Acme", provider: "Aziende.it" },
    pendingUpdates: [{ provider: "xray", promise: Promise.resolve({ xray: { vat: "11295150152" } }) }]
  });

  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0].result.companyReports, {
    name: "Acme",
    provider: "CompanyReports.it"
  });
  assert.deepEqual(messages[0].result.aziende, {
    name: "Acme",
    provider: "Aziende.it"
  });
  assert.equal(Object.hasOwn(messages[0].result, "pendingUpdates"), false);
});

test("Chrome callback messaging returns cached snapshots without Promise API support", async () => {
  globalThis.browser = undefined;
  const snapshot = {
    value: { primary: { name: "Acme" }, companyReports: { name: "Acme" } },
    age: 120,
    stale: false
  };
  globalThis.chrome = {
    runtime: {
      sendMessage(message, respond) {
        respond(message.type === "providerSnapshot.read"
          ? { ok: true, value: snapshot }
          : { ok: true });
      }
    }
  };

  assert.deepEqual(await readSnapshot("11295150152"), snapshot);
  await writeSnapshot("11295150152", { primary: snapshot.value.primary });
});

test("background errors remain non-blocking cache misses", async () => {
  globalThis.browser = undefined;
  globalThis.chrome = {
    runtime: {
      lastError: null,
      sendMessage(_message, respond) {
        this.lastError = { message: "background unavailable" };
        respond(undefined);
        this.lastError = null;
      }
    }
  };

  assert.equal(await readSnapshot("11295150152"), null);
  assert.equal(await writeSnapshot("11295150152", { primary: { name: "Acme" } }), undefined);
});
