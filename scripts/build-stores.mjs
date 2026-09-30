import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

export const STORE_TARGETS = ["firefox", "chrome", "edge", "opera"];
export const AZIENDE_HOST_PERMISSION = "https://www.aziende.it/*";

const sharedPaths = ["src", "assets", "LICENSE", "README.md", "PRIVACY.md"];
const backgroundPath = "src/background/service-worker.js";

export function chromiumManifest(base) {
  const manifest = structuredClone(base);
  delete manifest.browser_specific_settings;
  manifest.background = {
    service_worker: backgroundPath,
    type: "module"
  };

  manifest.action = {
    ...manifest.action,
    default_icon: {
      "16": "assets/icons/icon-16.png",
      "32": "assets/icons/icon-32.png",
      "48": "assets/icons/icon-48.png",
      "128": "assets/icons/icon-128.png"
    }
  };

  manifest.icons = {
    "16": "assets/icons/icon-16.png",
    "32": "assets/icons/icon-32.png",
    "48": "assets/icons/icon-48.png",
    "128": "assets/icons/icon-128.png"
  };

  return manifest;
}

export function firefoxManifest(base) {
  const manifest = structuredClone(base);
  // Firefox MV3 uses a module background script array instead of a service worker.
  manifest.background = {
    scripts: [backgroundPath],
    type: "module"
  };
  manifest.browser_specific_settings ||= {};
  manifest.browser_specific_settings.gecko ||= {};
  manifest.browser_specific_settings.gecko.data_collection_permissions = {
    required: ["websiteContent", "browsingActivity"]
  };
  manifest.action = {
    ...manifest.action,
    default_icon: "assets/icons/icon-toolbar.svg"
  };

  // Firefox upgrades do not re-prompt for new required host permissions, so the
  // Aziende origin ships as optional there: users grant it on first use. Every
  // other host permission stays required and ordered exactly as in the root
  // manifest, and the Chromium builds keep it required.
  const requiredHosts = manifest.host_permissions || [];
  if (!requiredHosts.includes(AZIENDE_HOST_PERMISSION)) {
    throw new Error(
      `firefox: root manifest is missing required host permission ${AZIENDE_HOST_PERMISSION}`
    );
  }
  manifest.host_permissions = requiredHosts.filter(
    (host) => host !== AZIENDE_HOST_PERMISSION
  );

  const optionalHosts = manifest.optional_host_permissions || [];
  if (!optionalHosts.includes(AZIENDE_HOST_PERMISSION)) {
    manifest.optional_host_permissions = [...optionalHosts, AZIENDE_HOST_PERMISSION];
  }

  return manifest;
}

export async function buildStorePackages({
  root = process.cwd(),
  distRoot = join(root, "dist")
} = {}) {
  const baseManifest = JSON.parse(
    await readFile(join(root, "manifest.json"), "utf8")
  );

  await rm(distRoot, { recursive: true, force: true });
  await mkdir(distRoot, { recursive: true });

  for (const target of STORE_TARGETS) {
    const targetDir = join(distRoot, target);
    await mkdir(targetDir, { recursive: true });

    for (const relativePath of sharedPaths) {
      const source = join(root, relativePath);
      const destination = join(targetDir, relativePath);
      await mkdir(dirname(destination), { recursive: true });
      await cp(source, destination, { recursive: true });
    }

    const manifest =
      target === "firefox"
        ? firefoxManifest(baseManifest)
        : chromiumManifest(baseManifest);

    await writeFile(
      join(targetDir, "manifest.json"),
      JSON.stringify(manifest, null, 2) + "\n",
      "utf8"
    );
  }

  return { targets: STORE_TARGETS, version: baseManifest.version };
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const { version, targets } = await buildStorePackages();
  console.log(
    `Built store packages for version ${version}: ${targets.join(", ")}`
  );
}
