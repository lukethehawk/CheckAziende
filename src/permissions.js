// Optional Aziende.it host permission.
//
// The Chromium build keeps the exact Aziende.it host on the required
// `host_permissions` manifest key, so the permission is always present there.
// The Firefox build moves the same exact origin to `optional_host_permissions`
// so an already-installed add-on can be updated without the provider host being
// granted up front; the user opts in at runtime through this module.
//
// Both engines expose `permissions.*`, but Firefox returns Promises while
// Chromium takes a callback, so the helpers below normalise both shapes and
// never throw: a provider must simply stay disabled when the answer is
// uncertain.

export const AZIENDE_ORIGIN = "https://www.aziende.it";
export const AZIENDE_HOST_PATTERN = "https://www.aziende.it/*";

function permissionsApi() {
  const api = globalThis.browser ?? globalThis.chrome;
  return api?.permissions ?? null;
}

// Firefox exposes the promise-based `browser.*` namespace; Chromium uses
// callback-based `chrome.*`. The namespace presence is the reliable
// discriminator, since both engines accept the same details object.
function isPromiseApi() {
  return Boolean(globalThis.browser?.permissions);
}

function invokePermissions(method, details) {
  const permissions = permissionsApi();
  if (!permissions || typeof permissions[method] !== "function") {
    return Promise.resolve(null);
  }

  if (isPromiseApi()) {
    try {
      return Promise.resolve(permissions[method](details));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  return new Promise((resolve) => {
    try {
      permissions[method](details, (result) => {
        // Reading `lastError` clears the "Unchecked runtime.lastError" warning.
        const runtimeError = globalThis.chrome?.runtime?.lastError;
        resolve(runtimeError ? null : result);
      });
    } catch {
      resolve(null);
    }
  });
}

export function aziendePermissionRequest() {
  return { origins: [AZIENDE_HOST_PATTERN] };
}

// `contains` is checked against the exact Aziende.it origin before any real
// Aziende.it request; an unavailable API answers `false`.
export async function hasAziendePermission() {
  try {
    return (await invokePermissions("contains", aziendePermissionRequest())) === true;
  } catch {
    return false;
  }
}

// `request` must be invoked synchronously from the user gesture (the click
// handler calls this function before any `await`). A denial or an engine error
// resolves `false` instead of rejecting, so the caller keeps a usable button.
export function requestAziendePermission() {
  return invokePermissions("request", aziendePermissionRequest())
    .then((granted) => granted === true)
    .catch(() => false);
}

function isAziendeOrigin(value) {
  const text = String(value || "").trim().toLowerCase();
  return (
    text === AZIENDE_ORIGIN ||
    text === AZIENDE_HOST_PATTERN ||
    text === `${AZIENDE_ORIGIN}/`
  );
}

// Subscribes to permission removals when the engine supports it. Returns a
// disposer; unsupported engines get a no-op.
export function watchAziendePermissionRemoved(handler) {
  const permissions = permissionsApi();
  const emitter = permissions?.onRemoved;
  if (!emitter?.addListener || typeof handler !== "function") return () => {};

  const listener = (removed) => {
    const origins = Array.isArray(removed?.origins) ? removed.origins : [];
    if (origins.some(isAziendeOrigin)) handler(removed);
  };

  try {
    emitter.addListener(listener);
  } catch {
    return () => {};
  }

  return () => {
    try {
      emitter.removeListener?.(listener);
    } catch {
      // The listener is already gone.
    }
  };
}
