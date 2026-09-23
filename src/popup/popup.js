import { checkItalianVatOnVies } from "../providers/vies.js";
import { scanCurrentPage } from "../scanner.js";

const api = globalThis.browser ?? globalThis.chrome;

const elements = {
  host: document.querySelector("#page-host"),
  loadingView: document.querySelector("#loading-view"),
  status: document.querySelector("#status"),
  companyView: document.querySelector("#company-view"),
  identityBadge: document.querySelector("#identity-badge"),
  name: document.querySelector("#company-name"),
  location: document.querySelector("#company-location"),
  vat: document.querySelector("#company-vat"),
  address: document.querySelector("#company-address"),
  addressRow: document.querySelector("#address-row"),
  contactsSection: document.querySelector("#contacts-section"),
  emailCard: document.querySelector("#email-card"),
  email: document.querySelector("#company-email"),
  copyEmail: document.querySelector("#copy-email"),
  phoneCard: document.querySelector("#phone-card"),
  phone: document.querySelector("#company-phone"),
  copyPhone: document.querySelector("#copy-phone"),
  website: document.querySelector("#company-website"),
  sourceStatus: document.querySelector("#source-status"),
  showManual: document.querySelector("#show-manual"),
  manualPanel: document.querySelector("#manual-panel"),
  manualDescription: document.querySelector("#manual-description"),
  cancelManual: document.querySelector("#cancel-manual"),
  input: document.querySelector("#vat-input"),
  button: document.querySelector("#check-button"),
  financialSection: document.querySelector("#financial-section"),
  revenueValue: document.querySelector("#revenue-value"),
  revenueLabel: document.querySelector("#revenue-label"),
  employeesCard: document.querySelector("#employees-card"),
  employeesValue: document.querySelector("#employees-value"),
  profitCard: document.querySelector("#profit-card"),
  profitValue: document.querySelector("#profit-value"),
  profitLabel: document.querySelector("#profit-label"),
  marginCard: document.querySelector("#margin-card"),
  marginValue: document.querySelector("#margin-value"),
  atecoSection: document.querySelector("#ateco-section"),
  atecoCode: document.querySelector("#ateco-code"),
  atecoDescription: document.querySelector("#ateco-description")
};

let currentScan = null;
let companyIsVisible = false;

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

function setLoading(message) {
  elements.status.textContent = message;
  elements.loadingView.classList.remove("hidden");
}

function stopLoading() {
  elements.loadingView.classList.add("hidden");
}

function showManual({ allowCancel = companyIsVisible, message } = {}) {
  elements.manualDescription.textContent =
    message || "Inserisci la Partita IVA dell'azienda che vuoi cercare.";
  elements.cancelManual.classList.toggle("hidden", !allowCancel);
  elements.manualPanel.classList.remove("hidden");
  setTimeout(() => elements.input.focus(), 0);
}

function hideManual() {
  elements.manualPanel.classList.add("hidden");
}

function fallbackCompanyName(viesData) {
  if (viesData?.name) return viesData.name;
  if (currentScan?.siteName) return currentScan.siteName;
  if (currentScan?.hostname) return currentScan.hostname;
  return "Azienda";
}

function renderContacts(scan) {
  const email = scan?.contacts?.emails?.[0] || "";
  const phone = scan?.contacts?.phones?.[0] || "";
  const origin = scan?.origin || "";

  elements.emailCard.classList.toggle("hidden", !email);
  elements.phoneCard.classList.toggle("hidden", !phone);

  if (email) {
    elements.email.textContent = email;
    elements.email.href = `mailto:${email}`;
  }

  if (phone) {
    elements.phone.textContent = phone;
    elements.phone.href = `tel:${phone}`;
  }

  if (origin) {
    elements.website.textContent = scan.hostname || origin;
    elements.website.href = origin;
  } else {
    elements.website.textContent = "Sito non disponibile";
    elements.website.removeAttribute("href");
  }

  elements.contactsSection.classList.remove("hidden");
}

function renderFinancials(financials) {
  const hasRevenue = financials?.revenue?.value;
  const hasEmployees = financials?.employees;
  const hasProfit = financials?.profit?.value;
  const hasMargin = financials?.netMargin;
  const hasAny = hasRevenue || hasEmployees || hasProfit || hasMargin;

  elements.financialSection.classList.toggle("hidden", !hasAny);
  if (!hasAny) return;

  if (hasRevenue) {
    elements.revenueValue.textContent = financials.revenue.value;
    elements.revenueLabel.textContent = financials.revenue.year
      ? `Fatturato ${financials.revenue.year}`
      : "Fatturato";
  }

  elements.employeesCard.classList.toggle("hidden", !hasEmployees);
  if (hasEmployees) elements.employeesValue.textContent = financials.employees;

  elements.profitCard.classList.toggle("hidden", !hasProfit);
  if (hasProfit) {
    elements.profitValue.textContent = financials.profit.value;
    elements.profitLabel.textContent = financials.profit.year
      ? `utile ${financials.profit.year}`
      : "utile";
  }

  elements.marginCard.classList.toggle("hidden", !hasMargin);
  if (hasMargin) elements.marginValue.textContent = financials.netMargin;
}

function renderAteco(ateco) {
  const hasAteco = ateco?.code || ateco?.description;
  elements.atecoSection.classList.toggle("hidden", !hasAteco);
  if (!hasAteco) return;

  elements.atecoCode.textContent = ateco.code || "";
  elements.atecoDescription.textContent = ateco.description || "";
}

function renderCompany(viesData, { source = "automatic" } = {}) {
  const vat = viesData?.vatNumber || digitsOnly(elements.input.value);
  const name = fallbackCompanyName(viesData);
  const address = viesData?.address || "";

  elements.name.textContent = name;
  elements.vat.textContent = vat ? `IT ${vat}` : "—";
  elements.address.textContent = address || "Non disponibile";
  elements.addressRow.classList.toggle("hidden", !address);

  const verified = Boolean(viesData?.valid);
  elements.identityBadge.textContent = verified ? "Identificata" : "Rilevata";
  elements.identityBadge.classList.toggle("unverified", !verified);

  const cityHint = address
    ? address.split(/\s{2,}|\n/).filter(Boolean).pop()
    : currentScan?.hostname || "";
  elements.location.textContent = cityHint || "";

  elements.sourceStatus.textContent = source === "automatic"
    ? verified
      ? "P.IVA dal sito · anagrafica verificata"
      : "P.IVA rilevata dal sito"
    : verified
      ? "P.IVA inserita · anagrafica verificata"
      : "P.IVA inserita manualmente";

  renderContacts(currentScan);
  renderFinancials(null);
  renderAteco(null);

  elements.companyView.classList.remove("hidden");
  companyIsVisible = true;
  stopLoading();
}

async function lookupVat(rawVat, { source = "manual", bypassCache = false } = {}) {
  const vat = digitsOnly(rawVat);

  if (!isValidItalianVat(vat)) {
    stopLoading();
    showManual({
      allowCancel: companyIsVisible,
      message: "La Partita IVA inserita non supera il controllo formale."
    });
    return;
  }

  elements.input.value = vat;
  elements.button.disabled = true;
  setLoading("Recupero dati aziendali…");

  try {
    const viesData = await checkItalianVatOnVies(vat, { bypassCache });
    renderCompany(viesData, { source });
    hideManual();
  } catch {
    renderCompany(
      {
        vatNumber: vat,
        valid: false,
        name: null,
        address: null
      },
      { source }
    );
    elements.sourceStatus.textContent = source === "automatic"
      ? "P.IVA rilevata dal sito · anagrafica non disponibile"
      : "P.IVA inserita · anagrafica non disponibile";
    hideManual();
  } finally {
    elements.button.disabled = false;
  }
}

async function inspectActivePage() {
  let tabs;
  try {
    tabs = await api.tabs.query({ active: true, currentWindow: true });
  } catch {
    stopLoading();
    showManual({ allowCancel: false, message: "Non riesco a leggere la scheda attiva." });
    return;
  }

  const tab = tabs?.[0];
  if (!tab?.id) {
    stopLoading();
    showManual({ allowCancel: false, message: "Nessuna scheda attiva disponibile." });
    return;
  }

  try {
    if (tab.url) {
      const url = new URL(tab.url);
      elements.host.textContent = url.hostname || tab.url;
      if (!["http:", "https:"].includes(url.protocol)) {
        stopLoading();
        showManual({ allowCancel: false, message: "Apri un sito web oppure inserisci una P.IVA." });
        return;
      }
    }
  } catch {
    elements.host.textContent = "Scheda attiva";
  }

  try {
    const injection = await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: scanCurrentPage
    });

    const mainFrame = injection?.find((item) => item.frameId === 0) || injection?.[0];
    if (mainFrame?.error) {
      throw new Error(mainFrame.error?.message || String(mainFrame.error));
    }

    currentScan = mainFrame?.result || null;
    if (currentScan?.hostname) elements.host.textContent = currentScan.hostname;

    const candidates = currentScan?.candidates || [];
    if (!candidates.length) {
      stopLoading();
      showManual({
        allowCancel: false,
        message: "Non ho trovato una Partita IVA valida nella pagina."
      });
      return;
    }

    await lookupVat(candidates[0].vat, { source: "automatic" });
  } catch {
    stopLoading();
    showManual({
      allowCancel: false,
      message: "Non riesco ad analizzare questa pagina. Inserisci la P.IVA manualmente."
    });
  }
}

async function copyValue(value, button) {
  if (!value) return;
  await navigator.clipboard.writeText(value);
  const previous = button.textContent;
  button.textContent = "Copiato";
  setTimeout(() => {
    button.textContent = previous;
  }, 1100);
}

elements.button.addEventListener("click", () =>
  lookupVat(elements.input.value, { source: "manual", bypassCache: true })
);

elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    lookupVat(elements.input.value, { source: "manual", bypassCache: true });
  }
});

elements.input.addEventListener("input", () => {
  const normalized = elements.input.value.replace(/[^0-9ITit\s]/g, "");
  if (normalized !== elements.input.value) elements.input.value = normalized;
});

elements.showManual.addEventListener("click", () => {
  elements.input.value = elements.vat.textContent.replace(/\D/g, "");
  showManual({ allowCancel: true });
});

elements.cancelManual.addEventListener("click", hideManual);

elements.copyEmail.addEventListener("click", () =>
  copyValue(elements.email.textContent, elements.copyEmail)
);

elements.copyPhone.addEventListener("click", () =>
  copyValue(elements.phone.textContent, elements.copyPhone)
);

inspectActivePage();
