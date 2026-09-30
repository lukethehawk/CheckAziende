const SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;
const STALE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SNAPSHOT_SCHEMA_VERSION = 2;

function snapshotKey(vat) {
  return `provider-orchestrator:v9:${vat}`;
}

// Envelopes written before the schema marker stored the canonical
// CompanyReports record in `aziende`; the dedicated Aziende.it enrichment did
// not exist yet. Normalization maps that legacy field to `companyReports` and
// leaves the new `aziende` (Aziende.it) slot empty so the two never collide.
function normalizeValue(value = {}) {
  const companyReports = value.companyReports ?? value.aziende ?? null;

  return {
    primary: companyReports || value.primary || value.registro || null,
    companyReports,
    aziende: value.companyReports ? value.aziende ?? null : null,
    xray: value.xray ?? null,
    registro: value.registro ?? null,
    verification: value.verification ?? null
  };
}

function entryValue(entry) {
  if (!entry) return {};
  if (entry.schemaVersion === SNAPSHOT_SCHEMA_VERSION) return entry.value ?? {};
  return normalizeValue(entry.value ?? {});
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
          value: entryValue(entry),
          age,
          stale: age > SNAPSHOT_TTL_MS
        };
      });
    },

    write(vat, result) {
      return serialize(vat, async () => {
        const key = snapshotKey(vat);
        const stored = await storage.get(key);
        const previous = entryValue(stored?.[key]);

        const companyReports =
          result.companyReports || previous.companyReports || null;
        const aziende = result.aziende || previous.aziende || null;
        const registro = result.registro || previous.registro || null;
        const xray = result.xray || previous.xray || null;
        const primary =
          companyReports ||
          result.primary ||
          previous.primary ||
          registro ||
          null;

        await storage.set({
          [key]: {
            schemaVersion: SNAPSHOT_SCHEMA_VERSION,
            cachedAt: now(),
            value: {
              primary,
              companyReports,
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
