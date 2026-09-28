import test from "node:test";
import assert from "node:assert/strict";

import { createSnapshotStore } from "../src/background/provider-snapshot.js";

const DAY = 24 * 60 * 60 * 1000;
const keyFor = (vat) => `provider-orchestrator:v9:${vat}`;

function createStorage(initial = {}, { delayed = false } = {}) {
  const entries = structuredClone(initial);
  const pause = delayed ? () => new Promise((resolve) => setTimeout(resolve, 5)) : async () => {};

  return {
    async get(key) {
      await pause();
      return structuredClone({ [key]: entries[key] });
    },
    async set(values) {
      await pause();
      Object.assign(entries, structuredClone(values));
    },
    entries
  };
}

test("reads fresh and stale snapshots but expires snapshots older than seven days", async () => {
  const now = 10 * DAY;
  const vat = "11295150152";
  const storage = createStorage({
    [keyFor(vat)]: { cachedAt: now - DAY, value: { primary: "fresh" } }
  });
  const store = createSnapshotStore(storage, () => now);

  assert.deepEqual(await store.read(vat), {
    value: { primary: "fresh" },
    age: DAY,
    stale: false
  });

  storage.entries[keyFor(vat)].cachedAt = now - DAY - 1;
  assert.deepEqual(await store.read(vat), {
    value: { primary: "fresh" },
    age: DAY + 1,
    stale: true
  });

  storage.entries[keyFor(vat)].cachedAt = now - (7 * DAY) - 1;
  assert.equal(await store.read(vat), null);
});

test("writes merge partial provider results and retain verification", async () => {
  const vat = "11295150152";
  const aziende = { provider: "Aziende.it" };
  const xray = { provider: "Xray" };
  const storage = createStorage();
  const store = createSnapshotStore(storage, () => 1234);

  await store.write(vat, { aziende, verification: { verified: true } });
  await store.write(vat, { xray });

  assert.deepEqual(storage.entries[keyFor(vat)], {
    cachedAt: 1234,
    value: {
      primary: aziende,
      aziende,
      xray,
      registro: null,
      verification: { verified: true }
    }
  });
});

test("serializes concurrent writes for the same VAT", async () => {
  const vat = "11295150152";
  const aziende = { provider: "Aziende.it" };
  const xray = { provider: "Xray" };
  const storage = createStorage({}, { delayed: true });
  const store = createSnapshotStore(storage, () => 1234);

  await Promise.all([
    store.write(vat, { aziende }),
    store.write(vat, { xray })
  ]);

  assert.deepEqual(storage.entries[keyFor(vat)].value, {
    primary: aziende,
    aziende,
    xray,
    registro: null,
    verification: null
  });
});

test("never lets a later RegistroAziende result replace an Aziende.it primary", async () => {
  const vat = "11295150152";
  const aziende = { provider: "Aziende.it" };
  const registro = { provider: "RegistroAziende.it" };
  const storage = createStorage();
  const store = createSnapshotStore(storage, () => 1234);

  await store.write(vat, { aziende });
  await store.write(vat, { primary: registro, registro });

  const value = storage.entries[keyFor(vat)].value;
  assert.deepEqual(value.primary, aziende);
  assert.deepEqual(value.registro, registro);
});
