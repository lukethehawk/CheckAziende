const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function snapshotKey(vat) {
  return `provider-orchestrator:v9:${vat}`;
}

export function createSnapshotStore(storage, now = () => Date.now()) {
  const operations = new Map();

  function serialize(vat, operation) {
    const previous = operations.get(vat) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.catch(() => undefined);

    operations.set(vat, tail);
    tail.finally(() => {
      if (operations.get(vat) === tail) operations.delete(vat);
    });

    return current;
  }

  return {
    read(vat) {
      return serialize(vat, async () => {
        const key = snapshotKey(vat);
        const stored = await storage.get(key);
        const entry = stored?.[key];
        if (!entry) return null;

        const age = now() - entry.cachedAt;
        if (age > STALE_TTL_MS) return null;

        return {
          value: entry.value,
          age,
          stale: age > SNAPSHOT_TTL_MS
        };
      });
    },

    write(vat, result) {
      return serialize(vat, async () => {
        const key = snapshotKey(vat);
        const stored = await storage.get(key);
        const previous = stored?.[key]?.value || {};

        const aziende = result.aziende || previous.aziende || null;
        const registro = result.registro || previous.registro || null;
        const xray = result.xray || previous.xray || null;
        const primary =
          aziende ||
          result.primary ||
          previous.primary ||
          registro ||
          null;

        await storage.set({
          [key]: {
            cachedAt: now(),
            value: {
              primary,
              aziende,
              xray,
              registro,
              verification:
                result.verification ??
                previous.verification ??
                null
            }
          }
        });
      });
    }
  };
}
