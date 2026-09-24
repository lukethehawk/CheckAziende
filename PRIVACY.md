# Privacy Policy — CheckAziende

Last updated: 24 September 2026

CheckAziende is a browser extension that identifies the company associated with the website currently open in the active tab and enriches the result with public company information.

## Data processed locally

When the user opens the extension, CheckAziende may read information from the active page, including:

- the page URL and hostname;
- visible page text and legal/footer sections;
- company names, VAT numbers and location hints found on the page;
- public email addresses and telephone numbers exposed by the website.

This information is processed in the extension to identify the company and display the result in the popup.

## Data transmitted to third-party public sources

To retrieve and verify public company data, the extension may send only the information needed for the lookup directly from the browser to these external services:

- European Commission VIES: VAT number validation;
- CompanyReports.it: public company data lookup by VAT number;
- RegistroAziende.it: public company lookup and verification;
- Xray Finance: public financial-data enrichment.

Depending on the lookup, transmitted lookup values may include a VAT number, company name, city/province hints or equivalent identifiers derived from the active website.

CheckAziende does not intentionally transmit page email addresses, telephone numbers, passwords, authentication data, form contents or the full page text to these providers.

Requests are made directly by the user's browser to the third-party services. Those services may receive normal network metadata such as the user's IP address and request headers according to their own privacy policies.

## Local storage and cache

CheckAziende uses browser local storage only to cache public lookup results and improve performance.

Current cache durations are generally:

- CompanyReports.it: up to 12 hours;
- VIES: up to 24 hours;
- RegistroAziende.it: up to 24 hours;
- Xray Finance: up to 24 hours.

The extension does not use its own remote backend or cloud database.

## Analytics, advertising and sale of data

CheckAziende does not include analytics, advertising trackers or behavioral profiling.

CheckAziende does not sell user data.

## Browsing information

The extension accesses only the active tab when the user invokes it. It does not read or maintain the user's browser history.

The active hostname may be processed locally and may be used to derive a company/brand lookup term when no VAT number is found directly on the page.

## User-entered data

The stable release allows manual lookup by VAT number. The entered VAT number is sent only to the public company-data services required to perform that lookup.

## Third-party services

CheckAziende is not affiliated with, endorsed by, or sponsored by VIES, CompanyReports.it, RegistroAziende.it or Xray Finance.

Availability and data returned by those services may change independently of CheckAziende.

## Changes

This policy may be updated if the extension's functionality or data flows change. The current version is published with the source code in this repository.

## Contact

For privacy questions or issues, open an issue in the CheckAziende GitHub repository:
https://github.com/lukethehawk/CheckAziende/issues
