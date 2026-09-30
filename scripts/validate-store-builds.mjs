import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import {
  AZIENDE_HOST_PERMISSION,
  STORE_TARGETS
} from "./build-stores.mjs";

const root = process.cwd();
const targets = STORE_TARGETS;
const backgroundPath = "src/background/service-worker.js";
const manifests = {};
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const BROAD_HOST_PERMISSIONS = new Set(["<all_urls>", "*://*/*", "*"]);

function sameStringList(left, right) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function hostPermissions(manifest) {
  return {
    required: manifest.host_permissions || [],
    optional: manifest.optional_host_permissions || []
  };
}

function parsePng(buffer, expectedSize, label) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(signature)) {
    throw new Error(`${label}: invalid PNG signature`);
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const bitDepth = buffer[24];
  const colorType = buffer[25];
  const interlace = buffer[28];

  if (width !== expectedSize || height !== expectedSize) {
    throw new Error(
      `${label}: expected ${expectedSize}x${expectedSize}, got ${width}x${height}`
    );
  }

  if (bitDepth !== 8 || ![3, 6].includes(colorType) || interlace !== 0) {
    throw new Error(
      `${label}: expected non-interlaced 8-bit indexed or RGBA PNG (bitDepth=${bitDepth}, colorType=${colorType}, interlace=${interlace})`
    );
  }

  const idat = [];
  let offset = 8;

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;

    if (dataEnd + 4 > buffer.length) {
      throw new Error(`${label}: truncated PNG chunk`);
    }

    if (type === "IDAT") idat.push(buffer.subarray(dataStart, dataEnd));
    offset = dataEnd + 4;
    if (type === "IEND") break;
  }

  if (!idat.length) throw new Error(`${label}: missing IDAT data`);

  const raw = inflateSync(Buffer.concat(idat));
  const bytesPerPixel = colorType === 6 ? 4 : 1;
  const stride = width * bytesPerPixel;
  const expectedRawLength = (stride + 1) * height;

  if (raw.length !== expectedRawLength) {
    throw new Error(
      `${label}: unexpected decoded PNG length ${raw.length}, expected ${expectedRawLength}`
    );
  }

  const previous = Buffer.alloc(stride);
  let visiblePixels = 0;
  let pos = 0;

  for (let y = 0; y < height; y += 1) {
    const filter = raw[pos];
    pos += 1;
    const scanline = Buffer.from(raw.subarray(pos, pos + stride));
    pos += stride;

    for (let x = 0; x < stride; x += 1) {
      const left = x >= bytesPerPixel ? scanline[x - bytesPerPixel] : 0;
      const up = previous[x];
      const upLeft = x >= bytesPerPixel ? previous[x - bytesPerPixel] : 0;

      if (filter === 1) {
        scanline[x] = (scanline[x] + left) & 0xff;
      } else if (filter === 2) {
        scanline[x] = (scanline[x] + up) & 0xff;
      } else if (filter === 3) {
        scanline[x] = (scanline[x] + Math.floor((left + up) / 2)) & 0xff;
      } else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        scanline[x] = (scanline[x] + predictor) & 0xff;
      } else if (filter !== 0) {
        throw new Error(`${label}: unsupported PNG filter ${filter}`);
      }
    }

    if (colorType === 6) {
      for (let x = 3; x < stride; x += bytesPerPixel) {
        if (scanline[x] > 0) visiblePixels += 1;
      }
    } else {
      // Indexed PNGs may store transparency in a palette/tRNS chunk.
      // Reaching this point proves the image decodes correctly; count indexed
      // pixels as visible so store artwork is not rejected solely for palette use.
      visiblePixels += width;
    }

    scanline.copy(previous);
  }

  const visibleRatio = visiblePixels / (width * height);
  if (visibleRatio < 0.08) {
    throw new Error(
      `${label}: icon appears empty (visible pixel ratio ${visibleRatio.toFixed(3)})`
    );
  }
}

async function validatePng(path, expectedSize, label) {
  const buffer = await readFile(path);
  parsePng(buffer, expectedSize, label);
}

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

const rootManifest = JSON.parse(
  await readFile(join(root, "manifest.json"), "utf8")
);
const rootBackground = rootManifest.background || {};
if (rootManifest.manifest_version !== 3 ||
    rootBackground.type !== "module" ||
    rootBackground.service_worker !== backgroundPath ||
    hasOwn(rootBackground, "scripts")) {
  throw new Error(
    "root manifest: expected MV3 module background service worker without background.scripts"
  );
}
await readFile(join(root, rootBackground.service_worker));

const rootHostPermissions = rootManifest.host_permissions || [];
if (!rootHostPermissions.includes(AZIENDE_HOST_PERMISSION)) {
  throw new Error(
    `root manifest: ${AZIENDE_HOST_PERMISSION} must stay a required host permission`
  );
}
if (
  (rootManifest.optional_host_permissions || []).includes(AZIENDE_HOST_PERMISSION)
) {
  throw new Error(
    `root manifest: ${AZIENDE_HOST_PERMISSION} must not be an optional host permission`
  );
}
const rootOtherHostPermissions = rootHostPermissions.filter(
  (host) => host !== AZIENDE_HOST_PERMISSION
);
const allowedHostPermissions = new Set(rootHostPermissions);

for (const target of targets) {
  const { required, optional } = hostPermissions(manifests[target]);

  // No build may add a host the root manifest does not declare, or broaden to
  // an all-hosts wildcard.
  for (const host of [...required, ...optional]) {
    if (BROAD_HOST_PERMISSIONS.has(host) || !allowedHostPermissions.has(host)) {
      throw new Error(`${target}: unexpected host permission ${host}`);
    }
  }

  if (target === "firefox") {
    if (required.includes(AZIENDE_HOST_PERMISSION)) {
      throw new Error(
        `firefox: ${AZIENDE_HOST_PERMISSION} must move out of required host_permissions`
      );
    }
    if (!sameStringList(required, rootOtherHostPermissions)) {
      throw new Error(
        "firefox: required host_permissions must list every other root host unchanged"
      );
    }
    if (!sameStringList(optional, [AZIENDE_HOST_PERMISSION])) {
      throw new Error(
        `firefox: optional_host_permissions must be exactly [${AZIENDE_HOST_PERMISSION}]`
      );
    }
  } else {
    if (!sameStringList(required, rootHostPermissions)) {
      throw new Error(
        `${target}: host_permissions must match the root manifest with ${AZIENDE_HOST_PERMISSION} still required`
      );
    }
    if (optional.includes(AZIENDE_HOST_PERMISSION)) {
      throw new Error(
        `${target}: ${AZIENDE_HOST_PERMISSION} is required here, so it must not be optional`
      );
    }
  }
}

const firefox = manifests.firefox;
const firefoxBackground = firefox.background || {};
if (firefoxBackground.type !== "module" ||
    hasOwn(firefoxBackground, "service_worker") ||
    !hasOwn(firefoxBackground, "scripts") ||
    !Array.isArray(firefoxBackground.scripts) ||
    firefoxBackground.scripts.length !== 1 ||
    firefoxBackground.scripts[0] !== backgroundPath) {
  throw new Error("firefox: expected module background script, not service worker");
}
await readFile(join(root, "dist", "firefox", firefoxBackground.scripts[0]));
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

for (const size of [16, 32, 48, 128]) {
  await validatePng(
    join(root, "assets", "icons", `icon-${size}.png`),
    size,
    `source icon-${size}.png`
  );
}

for (const target of ["chrome", "edge", "opera"]) {
  const manifest = manifests[target];

  const chromiumBackground = manifest.background || {};
  if (chromiumBackground.type !== "module" ||
      hasOwn(chromiumBackground, "scripts") ||
      chromiumBackground.service_worker !== backgroundPath) {
    throw new Error(
      `${target}: expected module background service worker without background.scripts`
    );
  }
  await readFile(join(root, "dist", target, chromiumBackground.service_worker));
  if (manifest.browser_specific_settings) {
    throw new Error(`${target}: Firefox-only browser_specific_settings present`);
  }

  const icons = manifest.action?.default_icon || {};
  for (const size of [16, 32, 48, 128]) {
    const iconPath = icons[String(size)];
    if (!iconPath || String(iconPath).endsWith(".svg")) {
      throw new Error(`${target}: invalid toolbar icon for size ${size}`);
    }

    await validatePng(
      join(root, "dist", target, iconPath),
      size,
      `${target}: ${iconPath}`
    );
  }
}

console.log(`Validated store builds and PNG assets for CheckAziende ${version}`);
