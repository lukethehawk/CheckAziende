import { readFile } from "node:fs/promises";

const FIXTURE_ROOT = new URL("../fixtures/", import.meta.url);

export async function loadFixture(path) {
  return readFile(new URL(path, FIXTURE_ROOT), "utf8");
}

function decodeEntities(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&euro;/gi, "€")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

export function htmlToText(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(?:p|div|li|tr|td|th|h[1-6]|section|article|dt|dd|footer|header|main)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
  )
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function attributeValue(tag, attribute) {
  const pattern = new RegExp(
    `${attribute}\\s*=\\s*["']([^"']+)["']`,
    "i"
  );
  return tag.match(pattern)?.[1] || "";
}

export function pageContextFromFixture(html) {
  const source = String(html || "");
  const htmlTag = source.match(/<html\b[^>]*>/i)?.[0] || "";
  const title = decodeEntities(
    source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] || ""
  ).replace(/\s+/g, " ").trim();

  const metaTags = source.match(/<meta\b[^>]*>/gi) || [];
  const siteNameMeta = metaTags.find((tag) =>
    /(?:property|name)\s*=\s*["']og:site_name["']/i.test(tag)
  );

  const siteName = siteNameMeta
    ? attributeValue(siteNameMeta, "content")
    : "";

  return {
    hostname: attributeValue(htmlTag, "data-hostname"),
    title,
    siteName,
    brandHints: siteName ? [siteName] : []
  };
}

export function extractFooterText(html) {
  const match = String(html || "").match(
    /<footer\b[^>]*>([\s\S]*?)<\/footer>/i
  );
  return match ? htmlToText(match[1]) : "";
}
