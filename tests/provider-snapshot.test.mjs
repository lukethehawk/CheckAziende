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
  const value = {
    primary: null,
    companyReports: null,
    aziende: null,
    xray: null,
    registro: null,
    verification: null
  };
  const storage = createStorage({
    [keyFor(vat)]: { schemaVersion: 2, cachedAt: now - DAY, value }
  });
  const store = createSnapshotStore(storage, () => now);

  assert.deepEqual(await store.read(vat), { value, age: DAY, stale: false });

  storage.entries[keyFor(vat)].cachedAt = now - DAY - 1;
  assert.deepEqual(await store.read(vat), { value, age: DAY + 1, stale: true });

  storage.entries[keyFor(vat)].cachedAt = now - (7 * DAY) - 1;
  assert.equal(await store.read(vat), null);
});

test("normalizes legacy v9 snapshots on read without rewriting the stored envelope", async () => {
  const now = 10 * DAY;
  const vat = "11295150152";
  const companyReports = { provider: "CompanyReports.it", vat, name: "Acme" };
  // Pre-marker envelopes stored the canonical record in `aziende`.
  const legacyValue = {
    primary: companyReports,
    aziende: companyReports,
    xray: null,
    registro: null,
    verification: { verified: true }
  };
  const storage = createStorage({
    [keyFor(vat)]: { cachedAt: now - DAY, value: legacyValue }
  });
  const store = createSnapshotStore(storage, () => now);

  assert.deepEqual(await store.read(vat), {
    value: {
      primary: companyReports,
      companyReports,
      aziende: null,
      xray: null,
      registro: null,
      verification: { verified: true }
    },
    age: DAY,
    stale: false
  });

  // Reading must not migrate in place: cachedAt and the legacy shape stay put.
  assert.equal(storage.entries[keyFor(vat)].cachedAt, now - DAY);
  assert.equal(storage.entries[keyFor(vat)].schemaVersion, undefined);
  assert.deepEqual(storage.entries[keyFor(vat)].value, legacyValue);
});

test("writes merge partial provider results and retain verification", async () => {
  const vat = "11295150152";
  const companyReports = { provider: "CompanyReports.it" };
  const aziende = { provider: "Aziende.it" };
  const xray = { provider: "Xray" };
  const storage = createStorage();
  const store = createSnapshotStore(storage, () => 1234);

  await store.write(vat, {
    companyReports,
    aziende,
    verification: { verified: true }
  });
  await store.write(vat, { xray });

  assert.deepEqual(storage.entries[keyFor(vat)], {
    schemaVersion: 2,
    cachedAt: 1234,
    value: {
      primary: companyReports,
      companyReports,
      aziende,
      xray,
      registro: null,
      verification: { verified: true }
    }
  });
});

test("serializes concurrent writes for the same VAT", async () => {
  const vat = "11295150152";
  const companyReports = { provider: "CompanyReports.it" };
  const aziende = { provider: "Aziende.it" };
  const storage = createStorage({}, { delayed: true });
  const store = createSnapshotStore(storage, () => 1234);

  await Promise.all([
    store.write(vat, { companyReports }),
    store.write(vat, { aziende })
  ]);

  assert.deepEqual(storage.entries[keyFor(vat)].value, {
    primary: companyReports,
    companyReports,
    aziende,
    xray: null,
    registro: null,
    verification: null
  });
});

test("migrates legacy CompanyReports data on write and persists the v2 marker", async () => {
  const vat = "11295150152";
  const companyReports = { provider: "CompanyReports.it", vat };
  const registro = { provider: "RegistroAziende.it", vat };
  const storage = createStorage({
    [keyFor(vat)]: {
      cachedAt: 111,
      value: {
        primary: companyReports,
        aziende: companyReports,
        registro,
        verification: { verified: true }
      }
    }
  });
  const store = createSnapshotStore(storage, () => 1234);

  await store.write(vat, { xray: { provider: "Xray" } });

  assert.deepEqual(storage.entries[keyFor(vat)], {
    schemaVersion: 2,
    cachedAt: 1234,
    value: {
      primary: companyReports,
      companyReports,
      aziende: null,
      xray: { provider: "Xray" },
      registro,
      verification: { verified: true }
    }
  });
});

test("does not confuse legacy CompanyReports data with the Aziende.it enrichment", async () => {
  const vat = "11295150152";
  const companyReports = { provider: "CompanyReports.it", vat };
  const enrichment = { provider: "Aziende.it", vat };
  const storage = createStorage({
    [keyFor(vat)]: {
      cachedAt: 111,
      value: { primary: companyReports, aziende: companyReports }
    }
  });
  const store = createSnapshotStore(storage, () => 1234);

  await store.write(vat, { aziende: enrichment });

  const value = storage.entries[keyFor(vat)].value;
  assert.deepEqual(value.companyReports, companyReports);
  assert.deepEqual(value.aziende, enrichment);
  assert.deepEqual(value.primary, companyReports);
});

test("retains the Aziende.it enrichment across later partial writes", async () => {
  const vat = "11295150152";
  const companyReports = { provider: "CompanyReports.it", vat };
  const aziende = { provider: "Aziende.it", vat };
  const storage = createStorage();
  const store = createSnapshotStore(storage, () => 1234);

  await store.write(vat, { companyReports });
  await store.write(vat, { aziende });
  await store.write(vat, { xray: { provider: "Xray" } });

  const value = storage.entries[keyFor(vat)].value;
  assert.deepEqual(value.companyReports, companyReports);
  assert.deepEqual(value.aziende, aziende);
  assert.deepEqual(value.primary, companyReports);
  assert.deepEqual(value.xray, { provider: "Xray" });
});

test("never promotes the Aziende.it enrichment to the canonical primary", async () => {
  const vat = "11295150152";
  const aziende = { provider: "Aziende.it", vat };
  const storage = createStorage();
  const store = createSnapshotStore(storage, () => 1234);

  await store.write(vat, { aziende });

  const value = storage.entries[keyFor(vat)].value;
  assert.deepEqual(value.aziende, aziende);
  assert.equal(value.companyReports, null);
  assert.equal(value.primary, null);
});

test("never lets a later RegistroAziende result replace a CompanyReports primary", async () => {
  const vat = "11295150152";
  const companyReports = { provider: "CompanyReports.it" };
  const registro = { provider: "RegistroAziende.it" };
  const storage = createStorage();
  const store = createSnapshotStore(storage, () => 1234);

  await store.write(vat, { companyReports });
  await store.write(vat, { primary: registro, registro });

  const value = storage.entries[keyFor(vat)].value;
  assert.deepEqual(value.primary, companyReports);
  assert.deepEqual(value.registro, registro);
});
