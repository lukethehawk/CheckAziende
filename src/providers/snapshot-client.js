function sendSnapshotMessage(message) {
  if (globalThis.browser) {
    return globalThis.browser.runtime.sendMessage(message);
  }

  return new Promise((resolve, reject) => {
    globalThis.chrome.runtime.sendMessage(message, (response) => {
      const error = globalThis.chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

export async function readSnapshot(vat) {
  try {
    const response = await sendSnapshotMessage({
      type: "providerSnapshot.read",
      vat
    });
    return response?.ok ? response.value : null;
  } catch {
    return null;
  }
}

export async function writeSnapshot(vat, result) {
  try {
    // Resolver results also carry live enrichment Promises, which cannot cross
    // the runtime messaging boundary. Only the persisted fields belong here.
    const { primary, companyReports, aziende, xray, registro, verification } =
      result;
    await sendSnapshotMessage({
      type: "providerSnapshot.write",
      vat,
      result: { primary, companyReports, aziende, xray, registro, verification }
    });
  } catch {
    // Snapshot cache is optional.
  }
}
