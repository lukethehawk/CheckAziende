import { access, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const targets = ["firefox", "chrome", "edge", "opera"];
const manifests = {};

for (const target of targets) {
  const manifestPath = join(root, "dist", target, "manifest.json");
  manifests[target] = JSON.parse(await readFile(manifestPath, "utf8"));
}

const version = manifests.firefox.version;
for (const target of targets) {
  if (manifests[target].version !== version) {
    throw new Error(`${target}: version mismatch`);
  }
}

const firefox = manifests.firefox;
const required =
  firefox.browser_specific_settings?.gecko?.data_collection_permissions?.required ||
  [];

for (const category of ["websiteContent", "browsingActivity"]) {
  if (!required.includes(category)) {
    throw new Error(`firefox: missing data collection category ${category}`);
  }
}

if (!String(firefox.action?.default_icon || "").endsWith(".svg")) {
  throw new Error("firefox: toolbar icon must use the SVG HiDPI asset");
}

for (const target of ["chrome", "edge", "opera"]) {
  const manifest = manifests[target];

  if (manifest.browser_specific_settings) {
    throw new Error(`${target}: Firefox-only browser_specific_settings present`);
  }

  const icons = manifest.action?.default_icon || {};
  for (const size of ["16", "32", "48", "128"]) {
    const iconPath = icons[size];
    if (!iconPath || String(iconPath).endsWith(".svg")) {
      throw new Error(`${target}: invalid toolbar icon for size ${size}`);
    }
    await access(join(root, "dist", target, iconPath));
  }
}

console.log(`Validated store builds for CheckAziende ${version}`);
