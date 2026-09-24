import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const root = process.cwd();
const distRoot = join(root, "dist");
const baseManifest = JSON.parse(
  await readFile(join(root, "manifest.json"), "utf8")
);

const targets = ["firefox", "chrome", "edge", "opera"];
const sharedPaths = ["src", "assets", "LICENSE", "README.md", "PRIVACY.md"];

function chromiumManifest(base) {
  const manifest = structuredClone(base);
  delete manifest.browser_specific_settings;

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

function firefoxManifest(base) {
  const manifest = structuredClone(base);
  manifest.browser_specific_settings ||= {};
  manifest.browser_specific_settings.gecko ||= {};
  manifest.browser_specific_settings.gecko.data_collection_permissions = {
    required: ["websiteContent", "browsingActivity"]
  };
  manifest.action = {
    ...manifest.action,
    default_icon: "assets/icons/icon-toolbar.svg"
  };
  return manifest;
}

await rm(distRoot, { recursive: true, force: true });
await mkdir(distRoot, { recursive: true });

for (const target of targets) {
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

console.log(
  `Built store packages for version ${baseManifest.version}: ${targets.join(", ")}`
);
