import { checkItalianVatOnVies, viesUrl } from "../providers/vies.js";

const api = globalThis.browser ?? globalThis.chrome;

const elements = {
  host: document.querySelector("#page-host"),
  input: document.querySelector("#vat-input"),
  button: document.querySelector("#check-button"),
  detectionNote: document.querySelector("#detection-note"),
  statusCard: document.querySelector("#status-card"),
  status: document.querySelector("#status"),
  companyCard: document.querySelector("#company-card"),
  name: document.querySelector("#company-name"),
  validity: document.querySelector("#validity-badge"),
  vat: document.querySelector("#company-vat"),
  address: document.querySelector("#company-address"),
  requestDate: document.querySelector("#request-date"),
  copyButton: document.querySelector("#copy-button"),
  viesLink: document.querySelector("#vies-link")
};

let currentVat = "";

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

function isValidItalianVat(value) {
  const vat = digitsOnly(value);
  if (!/^\d{11}$/.test(vat)) return false;

  let sum = 0;
  for (let i = 0; i < 10; i += 1) {
    let digit = Number(vat[i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }

  return ((10 - (sum % 10)) % 10) === Number(vat[10]);
}

function setStatus(message, { error = false } = {}) {
  elements.statusCard.classList.remove("hidden");
  elements.status.textContent = message;
  elements.status.style.color = error ? "crimson" : "";
}

function hideStatus() {
  elements.statusCard.classList.add("hidden");
}

function hideCompany() {
  elements.companyCard.classList.add("hidden");
}

function renderCompany(data) {
  currentVat = data.vatNumber;
  elements.name.textContent = data.name || "Ragione sociale non restituita da VIES";
  elements.validity.textContent = data.valid ? "Presente in VIES" : "Non presente in VIES";
  elements.validity.classList.toggle("valid", data.valid);
  elements.validity.classList.toggle("invalid", !data.valid);
  elements.vat.textContent = `${data.countryCode || "IT"} ${data.vatNumber}`;
  elements.address.textContent = data.address || "Non disponibile";
  elements.requestDate.textContent = data.requestDate || "—";
  elements.viesLink.href = viesUrl;
  elements.companyCard.classList.remove("hidden");
  hideStatus();
}

async function verifyVat(rawVat, { bypassCache = false } = {}) {
  const vat = digitsOnly(rawVat);

  if (!isValidItalianVat(vat)) {
    hideCompany();
    setStatus("Inserisci una Partita IVA italiana formalmente valida.", { error: true });
    return;
  }

  elements.input.value = vat;
  elements.button.disabled = true;
  hideCompany();
  setStatus("Verifica in corso su VIES…");

  try {
    const result = await checkItalianVatOnVies(vat, { bypassCache });
    renderCompany(result);
    elements.detectionNote.textContent = result.cached
      ? "Risultato VIES recuperato dalla cache locale."
      : result.valid
        ? "La P.IVA risulta abilitata agli scambi intracomunitari in VIES."
        : "La P.IVA è formalmente valida, ma non risulta abilitata in VIES.";
  } catch (error) {
    setStatus(error?.message || "Impossibile interrogare VIES.", { error: true });
  } finally {
    elements.button.disabled = false;
  }
}

async function inspectActivePage() {
  let tabs;
  try {
    tabs = await api.tabs.query({ active: true, currentWindow: true });
  } catch {
    setStatus("Impossibile leggere la scheda attiva.", { error: true });
    return;
  }

  const tab = tabs?.[0];
  if (!tab?.id) {
    setStatus("Nessuna scheda attiva disponibile.", { error: true });
    return;
  }

  try {
    if (tab.url) {
      const url = new URL(tab.url);
      elements.host.textContent = url.hostname || tab.url;

      if (!["http:", "https:"].includes(url.protocol)) {
        setStatus("Apri un normale sito web per cercare automaticamente la Partita IVA.");
        elements.detectionNote.textContent = "Puoi comunque inserirla manualmente.";
        return;
      }
    }
  } catch {
    elements.host.textContent = "Scheda attiva";
  }

  try {
    const injection = await api.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["src/content.js"]
    });

    const scan = injection?.[0]?.result;
    const candidates = scan?.candidates || [];

    if (!candidates.length) {
      setStatus("Nessuna Partita IVA valida trovata automaticamente.");
      elements.detectionNote.textContent = "Puoi inserirla manualmente.";
      return;
    }

    const best = candidates[0];
    elements.input.value = best.vat;

    elements.detectionNote.textContent = candidates.length > 1
      ? `Trovate ${candidates.length} P.IVA possibili; uso quella con il contesto più probabile.`
      : `P.IVA rilevata automaticamente (${best.source}).`;

    await verifyVat(best.vat);
  } catch (error) {
    setStatus("Non posso analizzare questa pagina. Inserisci la P.IVA manualmente.", { error: true });
    elements.detectionNote.textContent = error?.message || "";
  }
}

elements.button.addEventListener("click", () => verifyVat(elements.input.value, { bypassCache: true }));

elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") verifyVat(elements.input.value, { bypassCache: true });
});

elements.input.addEventListener("input", () => {
  const normalized = elements.input.value.replace(/[^0-9ITit\s]/g, "");
  if (normalized !== elements.input.value) elements.input.value = normalized;
});

elements.copyButton.addEventListener("click", async () => {
  if (!currentVat) return;

  await navigator.clipboard.writeText(currentVat);
  const previous = elements.copyButton.textContent;
  elements.copyButton.textContent = "Copiata";
  setTimeout(() => {
    elements.copyButton.textContent = previous;
  }, 1200);
});

inspectActivePage();
