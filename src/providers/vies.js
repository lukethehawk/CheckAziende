const ENDPOINT = "https://ec.europa.eu/taxation_customs/vies/services/checkVatService";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const api = globalThis.browser ?? globalThis.chrome;

function xmlValue(document, localName) {
  const namespaced = document.getElementsByTagNameNS("*", localName);
  if (namespaced.length) return namespaced[0].textContent?.trim() || "";

  const plain = document.getElementsByTagName(localName);
  if (plain.length) return plain[0].textContent?.trim() || "";

  return "";
}

function normalizeCompanyValue(value) {
  const cleaned = String(value || "").trim();
  if (!cleaned || cleaned === "---") return null;
  return cleaned.replace(/\s+/g, " ");
}

async function readCache(vat) {
  try {
    const key = `vies:${vat}`;
    const stored = await api.storage.local.get(key);
    const entry = stored?.[key];

    if (!entry || Date.now() - entry.cachedAt > CACHE_TTL_MS) return null;
    return entry.value;
  } catch {
    return null;
  }
}

async function writeCache(vat, value) {
  try {
    const key = `vies:${vat}`;
    await api.storage.local.set({
      [key]: {
        cachedAt: Date.now(),
        value
      }
    });
  } catch {
    // Cache is optional.
  }
}

export async function checkItalianVatOnVies(vat, { bypassCache = false } = {}) {
  if (!/^\d{11}$/.test(vat)) {
    throw new Error("Partita IVA non valida.");
  }

  if (!bypassCache) {
    const cached = await readCache(vat);
    if (cached) return { ...cached, cached: true };
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                  xmlns:urn="urn:ec.europa.eu:taxud:vies:services:checkVat:types">
  <soapenv:Header/>
  <soapenv:Body>
    <urn:checkVat>
      <urn:countryCode>IT</urn:countryCode>
      <urn:vatNumber>${vat}</urn:vatNumber>
    </urn:checkVat>
  </soapenv:Body>
</soapenv:Envelope>`;

  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "text/xml; charset=utf-8"
    },
    body
  });

  if (!response.ok) {
    throw new Error(`VIES non disponibile (HTTP ${response.status}).`);
  }

  const xmlText = await response.text();
  const xml = new DOMParser().parseFromString(xmlText, "application/xml");

  const fault = xmlValue(xml, "faultstring");
  if (fault) {
    throw new Error(`VIES: ${fault}`);
  }

  const parserError = xml.querySelector("parsererror");
  if (parserError) {
    throw new Error("Risposta VIES non leggibile.");
  }

  const value = {
    provider: "VIES",
    countryCode: xmlValue(xml, "countryCode") || "IT",
    vatNumber: xmlValue(xml, "vatNumber") || vat,
    valid: xmlValue(xml, "valid").toLowerCase() === "true",
    name: normalizeCompanyValue(xmlValue(xml, "name")),
    address: normalizeCompanyValue(xmlValue(xml, "address")),
    requestDate: xmlValue(xml, "requestDate") || null,
    cached: false
  };

  await writeCache(vat, value);
  return value;
}

export const viesUrl = "https://ec.europa.eu/taxation_customs/vies/";
