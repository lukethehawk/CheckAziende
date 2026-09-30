import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AZIENDE_HOST_PERMISSION,
  buildStorePackages,
  STORE_TARGETS
} from "../scripts/build-stores.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const chromiumTargets = STORE_TARGETS.filter((target) => target !== "firefox");

// Build the real packages into a throwaway directory so these tests exercise
// the actual manifest each store receives without touching repo `dist/`.
const rootManifestBefore = JSON.parse(
  await readFile(join(repoRoot, "manifest.json"), "utf8")
);
const tempRoot = await mkdtemp(join(tmpdir(), "checkaziende-store-permissions-"));
const distRoot = join(tempRoot, "dist");
await buildStorePackages({ root: repoRoot, distRoot });

after(async () => {
  await rm(tempRoot, { recursive: true, force: true });
});

const manifests = {};
for (const target of STORE_TARGETS) {
  manifests[target] = JSON.parse(
    await readFile(join(distRoot, target, "manifest.json"), "utf8")
  );
}

const rootHosts = rootManifestBefore.host_permissions;
const otherRootHosts = rootHosts.filter((host) => host !== AZIENDE_HOST_PERMISSION);

test("firefox requires every other root host and drops Aziende from required permissions", () => {
  const { host_permissions: required } = manifests.firefox;

  assert.ok(!required.includes(AZIENDE_HOST_PERMISSION));
  assert.deepEqual(required, otherRootHosts);
});

test("firefox ships the Aziende origin as its only optional host permission", () => {
  assert.deepEqual(manifests.firefox.optional_host_permissions, [
    AZIENDE_HOST_PERMISSION
  ]);
});

test("chromium stores keep the Aziende origin required with no optional entry", () => {
  for (const target of chromiumTargets) {
    const manifest = manifests[target];

    assert.deepEqual(manifest.host_permissions, rootHosts, target);
    assert.ok(manifest.host_permissions.includes(AZIENDE_HOST_PERMISSION), target);

    const optional = manifest.optional_host_permissions || [];
    assert.ok(!optional.includes(AZIENDE_HOST_PERMISSION), target);
    assert.deepEqual(
      optional,
      rootManifestBefore.optional_host_permissions || [],
      target
    );
  }
});

test("store builds neither drop nor broaden hosts across the Firefox/Chromium split", () => {
  const firefoxDeclared = [
    ...manifests.firefox.host_permissions,
    ...manifests.firefox.optional_host_permissions
  ];

  // Moving the origin keeps the full Firefox set identical to the root manifest.
  assert.deepEqual(new Set(firefoxDeclared), new Set(rootHosts));
  assert.equal(firefoxDeclared.length, rootHosts.length);

  for (const target of STORE_TARGETS) {
    const manifest = manifests[target];
    const declared = [
      ...(manifest.host_permissions || []),
      ...(manifest.optional_host_permissions || [])
    ];

    for (const host of declared) {
      assert.ok(rootHosts.includes(host), `${target}: unexpected host ${host}`);
      assert.ok(!["<all_urls>", "*://*/*", "*"].includes(host), target);
    }

    assert.deepEqual(manifest.permissions, rootManifestBefore.permissions, target);
  }
});

test("building store packages leaves the root manifest untouched", async () => {
  const rootManifestAfter = JSON.parse(
    await readFile(join(repoRoot, "manifest.json"), "utf8")
  );

  assert.deepEqual(rootManifestAfter, rootManifestBefore);
  assert.deepEqual(rootManifestAfter.host_permissions, rootHosts);
  assert.ok(!rootManifestAfter.optional_host_permissions);
});
