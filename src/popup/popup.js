import { checkItalianVatOnVies } from "../providers/vies.js";
import {
  findAziendeCompanyByVat,
  findAziendeCompaniesByContext
} from "../providers/aziende.js";
import { findXrayCompanyByVat } from "../providers/xray.js";
import { scanCurrentPage, scanRelatedPages } from "../scanner.js";
import { buildDomainLookupContext, uniqueBrandHints } from "../domain.js";
import {
  assessDomainCompanyMatch,
  assessVatMatch,
  confidenceLabel
} from "../confidence.js";

const api = globalThis.browser ?? globalThis.chrome;

const elements = {
  host: document.querySelector("#page-host"),
  loadingView: document.querySelector("#loading-view"),
  status: document.querySelector("#status"),
  unidentifiedView: document.querySelector("#unidentified-view"),
  companyView: document.querySelector("#company-view"),
  identityBadge: document.querySelector("#identity-badge"),
  name: document.querySelector("#company-name"),
  location: document.querySelector("#company-location"),
  companyBadges: document.querySelector("#company-badges"),
  statusBadge: document.querySelector("#status-badge"),
  ageBadge: document.querySelector("#age-badge"),
  vat: document.querySelector("#company-vat"),
  address: document.querySelector("#company-address"),
  addressRow: document.querySelector("#address-row"),
  legalFormRow: document.querySelector("#legal-form-row"),
  legalForm: document.querySelector("#company-legal-form"),
  reaRow: document.querySelector("#rea-row"),
  rea: document.querySelector("#company-rea"),
  pecRow: document.querySelector("#pec-row"),
  pec: document.querySelector("#company-pec"),
  sdiRow: document.querySelector("#sdi-row"),
  sdi: document.querySelector("#company-sdi"),
  registrationRow: document.querySelector("#registration-row"),
  registration: document.querySelector("#company-registration"),
  providerSource: document.querySelector("#provider-source"),
  contactsSection: document.querySelector("#contacts-section"),
  emailCard: document.querySelector("#email-card"),
  email: document.querySelector("#company-email"),
  copyEmail: document.querySelector("#copy-email"),
  phoneCard: document.querySelector("#phone-card"),
  phone: document.querySelector("#company-phone"),
  copyPhone: document.querySelector("#copy-phone"),
  sourceStatus: document.querySelector("#source-status"),
  confidenceStatus: document.querySelector("#confidence-status"),
  confidenceSeparator: document.querySelector("#confidence-separator"),
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
  ebitdaCard: document.querySelector("#ebitda-card"),
  ebitdaValue: document.querySelector("#ebitda-value"),
  ebitdaLabel: document.querySelector("#ebitda-label"),
  ebitdaMarginCard: document.querySelector("#ebitda-margin-card"),
  ebitdaMarginValue: document.querySelector("#ebitda-margin-value"),
  ebitdaMarginLabel: document.querySelector("#ebitda-margin-label"),
  revenuePerEmployeeCard: document.querySelector("#revenue-per-employee-card"),
  revenuePerEmployeeValue: document.querySelector("#revenue-per-employee-value"),
  marginCard: document.querySelector("#margin-card"),
  marginValue: document.querySelector("#margin-value"),
  atecoSection: document.querySelector("#ateco-section"),
  atecoCode: document.querySelector("#ateco-code"),
  atecoDescription: document.querySelector("#ateco-description"),
  balanceHistorySection: document.querySelector("#balance-history-section"),
  balanceHistoryCount: document.querySelector("#balance-history-count"),
  balanceHistory: document.querySelector("#balance-history")
};

let currentScan = null;
let currentDomainLookup = null;
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

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function getPageContext() {
  return {
    hostname: currentScan?.hostname || "",
    title: currentScan?.title || "",
    brandHints: uniqueBrandHints([
      ...(currentScan?.brandHints || []),
      currentScan?.siteName,
      ...(currentDomainLookup?.brandHints || [])
    ])
  };
}

function mergeRelatedContacts(related) {
  if (!currentScan) return;

  currentScan.contacts ||= { emails: [], phones: [] };
  currentScan.contacts.emails = unique([
    ...(currentScan.contacts.emails || []),
    ...(related?.contacts?.emails || [])
  ]).slice(0, 6);

  currentScan.contacts.phones = unique([
    ...(currentScan.contacts.phones || []),
    ...(related?.contacts?.phones || [])
  ]).slice(0, 6);
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
    message || "Inserisci la Partita IVA dell'azienda.";
  elements.cancelManual.classList.toggle("hidden", !allowCancel);
  elements.manualPanel.classList.remove("hidden");
  setTimeout(() => elements.input.focus(), 0);
}

function hideManual() {
  elements.manualPanel.classList.add("hidden");
}

function formatCompactNumber(value, maxFractionDigits = 2) {
  return Number(value).toLocaleString("it-IT", {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxFractionDigits
  });
}

function formatCompactCurrency(value) {
  if (!Number.isFinite(value)) return "—";

  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);

  if (absolute >= 1_000_000_000) {
    return `${sign}€${formatCompactNumber(absolute / 1_000_000, 0)}M`;
  }

  if (absolute >= 100_000_000) {
    return `${sign}€${formatCompactNumber(absolute / 1_000_000, 0)}M`;
  }

  if (absolute >= 10_000_000) {
    return `${sign}€${formatCompactNumber(absolute / 1_000_000, 1)}M`;
  }

  if (absolute >= 1_000_000) {
    return `${sign}€${formatCompactNumber(absolute / 1_000_000, 2)}M`;
  }

  if (absolute >= 100_000) {
    return `${sign}€${formatCompactNumber(absolute / 1_000, 0)}K`;
  }

  if (absolute >= 1_000) {
    return `${sign}€${formatCompactNumber(absolute / 1_000, 1)}K`;
  }

  return `${sign}€${formatCompactNumber(absolute, 0)}`;
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "—";
  return `${formatCompactNumber(value, 1)}%`;
}

function calculateCompanyAge(dateValue) {
  const match = String(dateValue || "").match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]) - 1;
  const year = Number(match[3]);
  const registered = new Date(year, month, day);

  if (Number.isNaN(registered.getTime())) return null;

  const now = new Date();
  let age = now.getFullYear() - registered.getFullYear();

  const anniversaryPassed =
    now.getMonth() > registered.getMonth() ||
    (now.getMonth() === registered.getMonth() && now.getDate() >= registered.getDate());

  if (!anniversaryPassed) age -= 1;
  return age >= 0 ? age : null;
}

function renderCompanyBadges(company) {
  const age = calculateCompanyAge(company?.registrationDate);

  const setBadge = (element, value) => {
    const visible = Boolean(value);
    element.classList.toggle("hidden", !visible);
    element.textContent = visible ? value : "";
  };

  setBadge(elements.statusBadge, company?.status);
  elements.statusBadge.classList.remove("status-active", "status-closed");

  const status = String(company?.status || "").toLowerCase();
  if (/^attiva\b/.test(status)) {
    elements.statusBadge.classList.add("status-active");
  } else if (/cessat|inattiv|chius|liquidaz|fallit/.test(status)) {
    elements.statusBadge.classList.add("status-closed");
  }

  setBadge(elements.ageBadge, Number.isFinite(age) ? `${age} anni` : null);

  elements.companyBadges.classList.toggle(
    "hidden",
    !company?.status && !Number.isFinite(age)
  );
}

function renderBalanceHistory(history) {
  const rows = Array.isArray(history) ? history.slice(0, 3) : [];
  elements.balanceHistorySection.classList.toggle("hidden", !rows.length);
  elements.balanceHistorySection.open = false;
  elements.balanceHistoryCount.textContent = rows.length
    ? rows.length === 1
      ? "1 esercizio"
      : `${rows.length} esercizi`
    : "";
  elements.balanceHistory.replaceChildren();

  for (const item of rows) {
    const row = document.createElement("div");
    row.className = "balance-history-row";

    const year = document.createElement("span");
    year.className = "balance-history-year";
    year.textContent = String(item.year || "—");

    const revenue = document.createElement("span");
    revenue.className = "balance-history-revenue";
    revenue.textContent = Number.isFinite(item.revenue)
      ? formatCompactCurrency(item.revenue)
      : "n/d";

    const profit = document.createElement("span");
    profit.className = "balance-history-profit";
    if (Number.isFinite(item.profit)) {
      profit.classList.add(item.profit < 0 ? "financial-negative" : "financial-positive");
      profit.textContent = `${item.profit < 0 ? "perdita" : "utile"} ${formatCompactCurrency(item.profit)}`;
    } else {
      profit.textContent = "";
    }

    row.append(year, revenue, profit);
    elements.balanceHistory.append(row);
  }
}

function setDetail(row, target, value) {
  const visible = Boolean(value);
  row.classList.toggle("hidden", !visible);
  target.textContent = visible ? value : "—";
}

function normalizeCompany(providerData, viesData, fallbackVat) {
  const vat = providerData?.vat || viesData?.vatNumber || digitsOnly(fallbackVat);

  return {
    provider: providerData?.provider || null,
    providers: providerData?.provider ? [providerData.provider] : [],
    providerUrl: providerData?.providerUrl || null,
    name: providerData?.name || viesData?.name || null,
    vat,
    status: providerData?.status || null,
    address: providerData?.address || viesData?.address || null,
    legalForm: providerData?.legalForm || null,
    taxCode: providerData?.taxCode || null,
    rea: providerData?.rea || null,
    pec: providerData?.pec || null,
    sdi: providerData?.sdi || null,
    registrationDate: providerData?.registrationDate || null,
    chamber: providerData?.chamber || null,
    city: providerData?.city || null,
    province: providerData?.province || null,
    region: providerData?.region || null,
    ateco: providerData?.ateco || null,
    financials: providerData?.financials ? { ...providerData.financials } : {}
  };
}

function enrichCompanyWithXray(company, xray) {
  if (!xray?.financials) return company;

  const financials = company.financials || {};
  const year = xray.financials.year || null;

  if (Number.isFinite(xray.financials.ebitda)) {
    financials.ebitda = {
      value: xray.financials.ebitda,
      year
    };
  }

  if (Number.isFinite(xray.financials.ebitdaMargin)) {
    financials.ebitdaMargin = {
      value: xray.financials.ebitdaMargin,
      year
    };
  }

  if (!Number.isFinite(financials.revenue?.value) && Number.isFinite(xray.financials.revenue)) {
    financials.revenue = { value: xray.financials.revenue, year };
  }

  if (!Number.isFinite(financials.profit?.value) && Number.isFinite(xray.financials.profit)) {
    financials.profit = { value: xray.financials.profit, year };
  }

  if (!financials.employees && Number.isFinite(xray.financials.employees)) {
    financials.employees = {
      value: xray.financials.employees,
      display: String(xray.financials.employees),
      year
    };
  }

  financials.netWorth = Number.isFinite(xray.financials.netWorth)
    ? xray.financials.netWorth
    : financials.netWorth ?? null;
  financials.pfn = Number.isFinite(xray.financials.pfn)
    ? xray.financials.pfn
    : financials.pfn ?? null;

  company.financials = financials;
  company.providers = unique([...(company.providers || []), xray.provider]);
  company.provider = company.providers.join(" · ");
  return company;
}

function fallbackCompanyName(company, source) {
  if (company?.name) return company.name;

  if (source !== "manual") {
    const siteName = String(currentScan?.siteName || "").trim();
    if (siteName && !/^https?:\/\//i.test(siteName)) return siteName;
  }

  return company?.vat ? `P.IVA ${company.vat}` : "Azienda";
}

function renderContacts(scan) {
  const email = scan?.contacts?.emails?.[0] || "";
  const phone = scan?.contacts?.phones?.[0] || "";
  const hasAny = Boolean(email || phone);

  elements.contactsSection.classList.toggle("hidden", !hasAny);
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
}

function renderFinancials(financials) {
  const revenue = financials?.revenue;
  const employees = financials?.employees;
  const profit = financials?.profit;
  const ebitda = financials?.ebitda;
  const ebitdaMargin = financials?.ebitdaMargin;
  const margin = financials?.netMargin;
  const revenuePerEmployee = financials?.revenuePerEmployee;

  const hasRevenue = Number.isFinite(revenue?.value);
  const hasEmployees = Boolean(employees?.display || Number.isFinite(employees?.value));
  const hasProfit = Number.isFinite(profit?.value);
  const hasEbitda = Number.isFinite(ebitda?.value);
  const hasEbitdaMargin = Number.isFinite(ebitdaMargin?.value);
  const hasMargin = Number.isFinite(margin);
  const hasRevenuePerEmployee = Number.isFinite(revenuePerEmployee);
  const hasAny =
    hasRevenue ||
    hasEmployees ||
    hasProfit ||
    hasEbitda ||
    hasEbitdaMargin ||
    hasMargin ||
    hasRevenuePerEmployee;

  elements.financialSection.classList.toggle("hidden", !hasAny);
  if (!hasAny) return;

  if (hasRevenue) {
    elements.revenueValue.textContent = formatCompactCurrency(revenue.value);
    elements.revenueLabel.textContent = revenue.year
      ? `Fatturato ${revenue.year}`
      : "Fatturato";
  }

  elements.employeesCard.classList.toggle("hidden", !hasEmployees);
  if (hasEmployees) {
    elements.employeesValue.textContent =
      employees.display || String(employees.value);
  }

  elements.profitCard.classList.toggle("hidden", !hasProfit);
  elements.profitValue.classList.remove("financial-positive", "financial-negative");
  if (hasProfit) {
    const isLoss = profit.value < 0;
    elements.profitValue.classList.add(
      isLoss ? "financial-negative" : "financial-positive"
    );
    elements.profitValue.textContent = formatCompactCurrency(profit.value);
    elements.profitLabel.textContent = profit.year
      ? `${isLoss ? "perdita" : "utile"} ${profit.year}`
      : isLoss
        ? "perdita"
        : "utile";
  }

  elements.ebitdaCard.classList.toggle("hidden", !hasEbitda);
  if (hasEbitda) {
    elements.ebitdaValue.textContent = formatCompactCurrency(ebitda.value);
    elements.ebitdaLabel.textContent = ebitda.year
      ? `EBITDA ${ebitda.year}`
      : "EBITDA";
  }

  elements.ebitdaMarginCard.classList.toggle("hidden", !hasEbitdaMargin);
  if (hasEbitdaMargin) {
    elements.ebitdaMarginValue.textContent = formatPercent(ebitdaMargin.value);
    elements.ebitdaMarginLabel.textContent = ebitdaMargin.year
      ? `EBITDA margin ${ebitdaMargin.year}`
      : "EBITDA margin";
  }

  elements.revenuePerEmployeeCard.classList.toggle(
    "hidden",
    !hasRevenuePerEmployee
  );
  if (hasRevenuePerEmployee) {
    elements.revenuePerEmployeeValue.textContent =
      formatCompactCurrency(revenuePerEmployee);
  }

  elements.marginCard.classList.toggle("hidden", !hasMargin);
  if (hasMargin) elements.marginValue.textContent = formatPercent(margin);
}

function renderAteco(ateco) {
  const hasAteco = ateco?.code || ateco?.description;
  elements.atecoSection.classList.toggle("hidden", !hasAteco);
  if (!hasAteco) return;

  elements.atecoCode.textContent = ateco.code || "";
  elements.atecoDescription.textContent = ateco.description || "";
}

function renderProviderSource(company) {
  if (!company?.provider) {
    elements.providerSource.classList.add("hidden");
    elements.providerSource.textContent = "";
    return;
  }

  elements.providerSource.textContent = `Fonti dati: ${company.provider}`;
  elements.providerSource.classList.remove("hidden");
}

function showUnidentified(message) {
  companyIsVisible = false;
  elements.companyView.classList.add("hidden");
  elements.unidentifiedView.classList.remove("hidden");
  const copy = elements.unidentifiedView.querySelector(".unidentified-copy");
  if (message) copy.textContent = message;
  renderContacts(currentScan);
  stopLoading();
  showManual({ allowCancel: false });
}

function renderCompany(
  company,
  { source = "automatic", evidenceLabel = "", assessment = null } = {}
) {
  const vat = company?.vat || digitsOnly(elements.input.value);
  const name = fallbackCompanyName(company, source);
  const address = company?.address || "";

  elements.unidentifiedView.classList.add("hidden");
  elements.name.textContent = name;
  elements.vat.textContent = vat ? `IT ${vat}` : "—";
  elements.address.textContent = address || "Non disponibile";
  elements.addressRow.classList.toggle("hidden", !address);

  setDetail(elements.legalFormRow, elements.legalForm, company?.legalForm);
  setDetail(elements.reaRow, elements.rea, company?.rea);
  setDetail(elements.pecRow, elements.pec, company?.pec);
  setDetail(elements.sdiRow, elements.sdi, company?.sdi);
  setDetail(
    elements.registrationRow,
    elements.registration,
    company?.registrationDate
  );

  const status =
    assessment?.status || (source === "manual" ? "manual" : "identified");

  elements.identityBadge.textContent = confidenceLabel(status);
  elements.identityBadge.classList.toggle("unverified", status === "manual");
  elements.identityBadge.classList.toggle("possible", status === "possible");

  const showConfidence =
    source !== "manual" && Number.isFinite(assessment?.score);

  elements.confidenceStatus.textContent = showConfidence
    ? `Confidenza ${assessment.score}%`
    : "";

  elements.confidenceStatus.classList.toggle("hidden", !showConfidence);
  elements.confidenceSeparator.classList.toggle("hidden", !showConfidence);

  // Avoid duplicating city/province/region above the full legal address.
  elements.location.textContent = "";

  elements.sourceStatus.textContent =
    source === "manual"
      ? "P.IVA inserita manualmente"
      : evidenceLabel || "Azienda identificata dal sito";

  renderCompanyBadges(company);
  renderFinancials(company?.financials);
  renderAteco(company?.ateco);
  renderBalanceHistory(company?.financials?.balanceHistory);
  renderProviderSource(company);
  renderContacts(currentScan);

  elements.companyView.classList.remove("hidden");
  companyIsVisible = true;
  stopLoading();
}

async function getViesData(vat, bypassCache) {
  try {
    return await checkItalianVatOnVies(vat, { bypassCache });
  } catch {
    return null;
  }
}

function providerNames(viesData) {
  return unique([
    viesData?.name,
    ...(currentDomainLookup?.brandHints || []),
    ...(currentDomainLookup?.searchNames || []),
    currentDomainLookup?.rootLabel,
    currentScan?.siteName,
    currentScan?.title
  ]);
}

function providerProvinceHints(viesData) {
  const hints = [];
  const address = String(viesData?.address || "").trim();

  const trailing = address.match(/\b([A-Z]{2})$/);
  if (trailing) hints.push(trailing[1]);

  const parenthesized = address.match(/\(([A-Z]{2})\)\s*$/);
  if (parenthesized) hints.push(parenthesized[1]);

  const evidence = String(
    currentScan?.candidates?.[0]?.context || ""
  );

  const contextProvince = evidence.match(/\(([A-Z]{2})\)/);
  if (contextProvince) hints.push(contextProvince[1]);

  return unique(hints);
}

async function lookupVat(
  rawVat,
  {
    source = "manual",
    bypassCache = false,
    evidenceLabel = "",
    candidate = null
  } = {}
) {
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

  const viesData = await getViesData(vat, bypassCache);

  setLoading("Recupero fatturato e dati societari…");

  const providerData = await findAziendeCompanyByVat(vat, {
    names: providerNames(viesData),
    provinceHints: providerProvinceHints(viesData)
  });

  const company = normalizeCompany(providerData, viesData, vat);

  setLoading("Recupero EBITDA e indicatori finanziari…");

  const xrayData = await findXrayCompanyByVat(vat, {
    names: unique([
      company.name,
      ...providerNames(viesData)
    ])
  });

  enrichCompanyWithXray(company, xrayData);

  const assessment = assessVatMatch({
    candidate,
    company: {
      name: company.name || "",
      vat: company.vat || vat
    },
    pageContext: getPageContext(),
    manual: source === "manual"
  });

  renderCompany(company, {
    source,
    evidenceLabel:
      evidenceLabel ||
      (source === "manual"
        ? "P.IVA inserita manualmente"
        : "P.IVA identificata dal sito"),
    assessment
  });

  hideManual();
  elements.button.disabled = false;
}

async function scanFallbackPages(tabId) {
  const relatedUrls = currentScan?.relatedUrls || [];
  if (!relatedUrls.length) return null;

  setLoading("Controllo privacy, contatti e note legali…");

  try {
    const injection = await api.scripting.executeScript({
      target: { tabId },
      func: scanRelatedPages,
      args: [relatedUrls]
    });

    const mainFrame =
      injection?.find((item) => item.frameId === 0) || injection?.[0];

    if (mainFrame?.error) return null;

    const related = mainFrame?.result || null;
    mergeRelatedContacts(related);
    return related;
  } catch {
    return null;
  }
}

function providerCandidateNames() {
  return unique([
    ...(currentDomainLookup?.brandHints || []),
    ...(currentDomainLookup?.searchNames || []),
    currentDomainLookup?.rootLabel,
    currentScan?.siteName,
    currentScan?.title
  ]);
}

async function lookupCompanyFromDomain() {
  const names = providerCandidateNames();
  if (!names.length) return false;

  setLoading("Cerco una possibile corrispondenza…");

  const candidates = await findAziendeCompaniesByContext({ names });
  if (!candidates.length) return false;

  const pageContext = getPageContext();

  const assessed = candidates
    .map((company) => ({
      company,
      assessment: assessDomainCompanyMatch({
        company,
        pageContext,
        confirmedMapping: false
      })
    }))
    .filter((item) => item.assessment.status !== "unidentified")
    .sort((a, b) => b.assessment.score - a.assessment.score);

  const best = assessed[0];
  if (!best) return false;

  const company = normalizeCompany(best.company, null, best.company.vat);

  setLoading("Recupero EBITDA e indicatori finanziari…");
  const xrayData = await findXrayCompanyByVat(company.vat, {
    names: unique([
      company.name,
      ...names
    ])
  });
  enrichCompanyWithXray(company, xrayData);

  renderCompany(company, {
    source: "domain",
    evidenceLabel: currentDomainLookup?.registrableDomain
      ? `Corrispondenza da ${currentDomainLookup.registrableDomain}`
      : "Corrispondenza da dominio e nome",
    assessment: best.assessment
  });

  hideManual();
  return true;
}

async function inspectActivePage() {
  let tabs;

  try {
    tabs = await api.tabs.query({ active: true, currentWindow: true });
  } catch {
    showUnidentified("Non riesco a leggere la scheda attiva.");
    return;
  }

  const tab = tabs?.[0];
  if (!tab?.id) {
    showUnidentified("Nessuna scheda attiva disponibile.");
    return;
  }

  try {
    if (tab.url) {
      const url = new URL(tab.url);
      elements.host.textContent = url.hostname || tab.url;

      if (!["http:", "https:"].includes(url.protocol)) {
        showUnidentified(
          "Questa pagina non può essere identificata automaticamente."
        );
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

    const mainFrame =
      injection?.find((item) => item.frameId === 0) || injection?.[0];

    if (mainFrame?.error) {
      throw new Error(mainFrame.error?.message || String(mainFrame.error));
    }

    currentScan = mainFrame?.result || null;

    currentDomainLookup = buildDomainLookupContext({
      hostname: currentScan?.hostname || "",
      title: currentScan?.title || "",
      siteName: currentScan?.siteName || "",
      brandHints: currentScan?.brandHints || []
    });

    if (currentScan) currentScan.domainLookup = currentDomainLookup;
    if (currentScan?.hostname) elements.host.textContent = currentScan.hostname;

    let candidates = currentScan?.candidates || [];

    if (!candidates.length) {
      const related = await scanFallbackPages(tab.id);
      candidates = related?.candidates || [];
    }

    if (candidates.length) {
      const best = candidates[0];

      await lookupVat(best.vat, {
        source: "automatic",
        evidenceLabel: best.source
          ? `P.IVA identificata da ${best.source}`
          : "P.IVA identificata dal sito",
        candidate: best
      });

      return;
    }

    const domainMatchFound = await lookupCompanyFromDomain();
    if (domainMatchFound) return;

    showUnidentified(
      "Nessuna società identificata automaticamente. Inserisci una P.IVA per cercarla manualmente."
    );
  } catch {
    showUnidentified(
      "Non riesco a identificare automaticamente una società su questa pagina."
    );
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
  lookupVat(elements.input.value, {
    source: "manual",
    bypassCache: true
  })
);

elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    lookupVat(elements.input.value, {
      source: "manual",
      bypassCache: true
    });
  }
});

elements.input.addEventListener("input", () => {
  const normalized = elements.input.value.replace(/[^0-9ITit\s]/g, "");
  if (normalized !== elements.input.value) {
    elements.input.value = normalized;
  }
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
