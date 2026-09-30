import test from "node:test";
import assert from "node:assert/strict";

import { createDataCompletionTracker, watchProviderUpdates } from "../src/popup/data-completion.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function completionHarness() {
  const timers = new Map();
  const visibility = [];
  let nextId = 0;
  const tracker = createDataCompletionTracker(
    (visible) => visibility.push(visible),
    {
      setTimer(callback) {
        const id = ++nextId;
        timers.set(id, callback);
        return id;
      },
      clearTimer(id) { timers.delete(id); }
    }
  );
  const tick = () => {
    const callbacks = [...timers.values()];
    timers.clear();
    for (const callback of callbacks) callback();
  };
  return { tracker, tick, visibility, timers };
}

test("completion stays active until the last pending provider settles, including failures", async () => {
  const { tracker, tick, visibility } = completionHarness();
  const companyReports = deferred();
  const registro = deferred();
  const aziende = deferred();
  const generation = tracker.reset();
  tracker.track(companyReports.promise, generation);
  tracker.track(registro.promise, generation);
  tracker.track(aziende.promise, generation);
  tracker.display(generation);
  tick();
  assert.deepEqual(visibility, [true]);

  companyReports.resolve();
  await companyReports.promise;
  await Promise.resolve();
  assert.deepEqual(visibility, [true]);

  registro.reject(new Error("provider unavailable"));
  await assert.rejects(registro.promise);
  await Promise.resolve();
  assert.deepEqual(visibility, [true]);

  aziende.resolve();
  await aziende.promise;
  await Promise.resolve();
  assert.deepEqual(visibility, [true, false]);
});

test("completed requests never light the indicator; stale lookups cannot change a new view", async () => {
  const { tracker, tick, visibility, timers } = completionHarness();
  const old = deferred();
  const generation = tracker.reset();
  tracker.track(old.promise, generation);
  old.resolve();
  await old.promise;
  await Promise.resolve();
  tracker.display(generation);
  assert.equal(timers.size, 0);
  tick();
  assert.deepEqual(visibility, []);

  const next = deferred();
  tracker.track(next.promise, generation);
  tick();
  assert.deepEqual(visibility, [true]);
  const newGeneration = tracker.reset();
  assert.deepEqual(visibility, [true, false]);
  const pending = deferred();
  tracker.track(pending.promise, newGeneration);
  tracker.display(newGeneration);
  tracker.track(next.promise, generation);
  next.resolve();
  await next.promise;
  await Promise.resolve();
  tick();
  assert.deepEqual(visibility, [true, false, true]);
  pending.resolve();
  await pending.promise;
  await Promise.resolve();
  assert.deepEqual(visibility, [true, false, true, false]);
});

test("hiding an unidentified view suppresses pending work until a company is displayed", async () => {
  const { tracker, tick, visibility } = completionHarness();
  const provider = deferred();
  const generation = tracker.reset();
  tracker.track(provider.promise, generation);
  tracker.display(generation);
  tracker.hide();
  tick();
  assert.deepEqual(visibility, []);
  tracker.display(generation);
  tick();
  assert.deepEqual(visibility, [true]);
  provider.resolve();
  await provider.promise;
  await Promise.resolve();
  assert.deepEqual(visibility, [true, false]);
});

test("cached canonical card publishes delayed Xray before completion clears", async () => {
  const { tracker, tick, visibility } = completionHarness();
  const xray = deferred();
  const events = [];
  const generation = tracker.reset();
  const state = { companyReports: { vat: "05488440651" }, registro: { vat: "05488440651" } };
  watchProviderUpdates(
    { pendingUpdates: [{ provider: "xray", promise: xray.promise }] },
    generation,
    () => true,
    (patch) => { Object.assign(state, patch); events.push("render"); },
    (promise, current) => tracker.track(promise, current)
  );
  tracker.display(generation);
  tick();
  assert.deepEqual(visibility, [true]);
  assert.equal(state.xray, undefined);

  xray.resolve({ xray: { vat: "05488440651", financials: { ebitda: 283000 } } });
  await xray.promise;
  await new Promise(setImmediate);
  assert.equal(state.xray.financials.ebitda, 283000);
  assert.deepEqual(events, ["render"]);
  assert.deepEqual(visibility, [true, false]);
});

test("stale refresh registers nested missing-provider work before its own completion", async () => {
  const { tracker, tick, visibility } = completionHarness();
  const refresh = deferred();
  const missingXray = deferred();
  const generation = tracker.reset();
  const applied = [];
  watchProviderUpdates(
    { pendingUpdates: [{ provider: "refresh", promise: refresh.promise }] },
    generation,
    () => true,
    (patch) => applied.push(patch.xray?.provider || patch.companyReports?.provider),
    (promise, current) => tracker.track(promise, current)
  );
  tracker.display(generation);
  tick();
  refresh.resolve({
    companyReports: { provider: "CompanyReports.it" },
    pendingUpdates: [{ provider: "xray", promise: missingXray.promise }]
  });
  await refresh.promise;
  await new Promise(setImmediate);
  assert.deepEqual(applied, ["CompanyReports.it"]);
  assert.deepEqual(visibility, [true]);

  missingXray.resolve({ xray: { provider: "Xray Finance" } });
  await missingXray.promise;
  await new Promise(setImmediate);
  assert.deepEqual(applied, ["CompanyReports.it", "Xray Finance"]);
  assert.deepEqual(visibility, [true, false]);
});

test("a failed provider does not hide completion while another update can still render", async () => {
  const { tracker, tick, visibility } = completionHarness();
  const failed = deferred();
  const xray = deferred();
  const generation = tracker.reset();
  const applied = [];
  watchProviderUpdates({ pendingUpdates: [
    { provider: "registro", promise: failed.promise },
    { provider: "xray", promise: xray.promise }
  ] }, generation, () => true, (patch) => applied.push(patch.xray?.vat),
  (promise, current) => tracker.track(promise, current));
  tracker.display(generation);
  tick();
  failed.reject(new Error("temporarily unavailable"));
  await assert.rejects(failed.promise);
  await new Promise(setImmediate);
  assert.deepEqual(visibility, [true]);
  xray.resolve({ xray: { vat: "05488440651" } });
  await xray.promise;
  await new Promise(setImmediate);
  assert.deepEqual(applied, ["05488440651"]);
  assert.deepEqual(visibility, [true, false]);
});
