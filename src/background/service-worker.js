import { createSnapshotStore } from "./provider-snapshot.js";

const api = globalThis.browser ?? globalThis.chrome;
const snapshots = createSnapshotStore(api.storage.local);

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "providerSnapshot.read") {
    snapshots.read(message.vat)
      .then((value) => sendResponse({ ok: true, value }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (message?.type === "providerSnapshot.write") {
    snapshots.write(message.vat, message.result)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  return false;
});
