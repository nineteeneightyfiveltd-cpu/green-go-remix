/**
 * Centralized Country Management — Single Source of Truth
 *
 * ALL country-related data lives here. No other file should define
 * its own country maps, currency maps, or phone prefix maps.
 *
 * To add a new country:
 *   1. Add an entry to COUNTRY_REGISTRY below
 *   2. Add the alpha-2 code to SUPPORTED_COUNTRIES
 *   Done. No other files need changing.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AddressHints {
  address1: string;
  address2: string;
  city: string;
  state: string;
  /** Label for the state/region field (e.g. "Province", "County", "Distrito") */
  stateLabel: string;
  landmark: string;
}

export interface CountryConfig {
  alpha2: string;
  alpha3: string;
  name: string;
  // Currency
  currency: string;
  currencySymbol: string;
  locale: string;
  // Phone
  phonePrefix: string;
  phonePlaceholder: string;
  phonePattern: string;
  // Postal
  postalCodeLabel: string;
  postalCodePlaceholder: string;
  postalCodePattern: string;
  // Misc
  dateFormat: string;
  // Contact info (regional office)
  contactEmail: string;
  contactPhone: string;
  contactAddress: string;
  contactCity: string;
  // Address field placeholder hints (locale-aware)
  addressHints: AddressHints;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default market — South Africa */
export const DEFAULT_COUNTRY = 'ZA';

/** Countries where Healing Buds is actively operating */
export const SUPPORTED_COUNTRIES = ['PT', 'GB', 'ZA', 'TH'] as const;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const COUNTRY_REGISTRY: Record<string, CountryConfig> = {
  PT: {
    alpha2: 'PT', alpha3: 'PRT', name: 'Portugal',
    currency: 'EUR', currencySymbol: '€', locale: 'pt-PT',
    phonePrefix: '+351',
    phonePlaceholder: '+351 912 345 678',
    phonePattern: '^\\+?351?\\s?9[1236]\\d{1}\\s?\\d{3}\\s?\\d{3}$',
    postalCodeLabel: 'Código Postal',
    postalCodePlaceholder: '1000-001',
    postalCodePattern: '^\\d{4}-\\d{3}$',
    dateFormat: 'dd/MM/yyyy',
    contactEmail: 'info@healingbuds.pt',
    contactPhone: '+351 210 123 456',
    contactAddress: 'Avenida D. João II, 98 A',
    contactCity: '1990-100 Lisboa, Portugal',
    addressHints: {
      address1: 'ex. Rua das Flores, 25',
      address2: 'ex. Andar 3, Fração B',
      city: 'ex. Lisboa',
      state: 'ex. Setúbal',
      stateLabel: 'Distrito',
      landmark: 'ex. perto da Estação do Oriente',
    },
  },
  GB: {
    alpha2: 'GB', alpha3: 'GBR', name: 'United Kingdom',
    currency: 'GBP', currencySymbol: '£', locale: 'en-GB',
    phonePrefix: '+44',
    phonePlaceholder: '+44 7911 123456',
    phonePattern: '^\\+?44?\\s?7\\d{3}\\s?\\d{6}$',
    postalCodeLabel: 'Post Code',
    postalCodePlaceholder: 'SW1A 1AA',
    postalCodePattern: '^[A-Z]{1,2}\\d[A-Z\\d]?\\s?\\d[A-Z]{2}$',
    dateFormat: 'dd/MM/yyyy',
    contactEmail: 'info@healingbuds.co.uk',
    contactPhone: '+44 20 7123 4567',
    contactAddress: '123 Harley Street',
    contactCity: 'London W1G 6AX, United Kingdom',
    addressHints: {
      address1: 'e.g. 12 High Street',
      address2: 'e.g. Flat 2A',
      city: 'e.g. London',
      state: 'e.g. Surrey',
      stateLabel: 'County',
      landmark: 'e.g. near the post office',
    },
  },
  ZA: {
    alpha2: 'ZA', alpha3: 'ZAF', name: 'South Africa',
    currency: 'ZAR', currencySymbol: 'R', locale: 'en-ZA',
    phonePrefix: '+27',
    phonePlaceholder: '+27 82 123 4567',
    phonePattern: '^\\+?27?\\s?[6-8]\\d{1}\\s?\\d{3}\\s?\\d{4}$',
    postalCodeLabel: 'Postal Code',
    postalCodePlaceholder: '0001',
    postalCodePattern: '^\\d{4}$',
    dateFormat: 'yyyy/MM/dd',
    contactEmail: 'info@healingbuds.co.za',
    contactPhone: '+27 11 123 4567',
    contactAddress: '123 Sandton Drive',
    contactCity: 'Sandton 2196, South Africa',
    addressHints: {
      address1: 'e.g. 45 Main Road',
      address2: 'e.g. Unit 5B',
      city: 'e.g. Cape Town',
      state: 'e.g. Western Cape',
      stateLabel: 'Province',
      landmark: 'e.g. near the shopping centre',
    },
  },
  TH: {
    alpha2: 'TH', alpha3: 'THA', name: 'Thailand',
    currency: 'THB', currencySymbol: '฿', locale: 'th-TH',
    phonePrefix: '+66',
    phonePlaceholder: '+66 81 234 5678',
    phonePattern: '^\\+?66?\\s?[689]\\d{1}\\s?\\d{3}\\s?\\d{4}$',
    postalCodeLabel: 'Postal Code',
    postalCodePlaceholder: '10110',
    postalCodePattern: '^\\d{5}$',
    dateFormat: 'dd/MM/yyyy',
    contactEmail: 'info@healingbuds.co.th',
    contactPhone: '+66 2 123 4567',
    contactAddress: '123 Sukhumvit Road',
    contactCity: 'Bangkok 10110, Thailand',
    addressHints: {
      address1: 'e.g. 88 Charoen Krung Rd',
      address2: 'e.g. Room 4B',
      city: 'e.g. Bangkok',
      state: 'e.g. Chiang Rai',
      stateLabel: 'Changwat (Province)',
      landmark: 'e.g. near BTS station',
    },
  },
  US: {
    alpha2: 'US', alpha3: 'USA', name: 'United States',
    currency: 'USD', currencySymbol: '$', locale: 'en-US',
    phonePrefix: '+1',
    phonePlaceholder: '+1 (555) 123-4567',
    phonePattern: '^\\+?1?\\s?\\(?\\d{3}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{4}$',
    postalCodeLabel: 'Zip Code',
    postalCodePlaceholder: '10001',
    postalCodePattern: '^\\d{5}(-\\d{4})?$',
    dateFormat: 'MM/dd/yyyy',
    contactEmail: 'info@healingbuds.com',
    contactPhone: '+1 (555) 123-4567',
    contactAddress: '123 Fifth Avenue',
    contactCity: 'New York, NY 10001, USA',
    addressHints: {
      address1: 'e.g. 123 Main Street',
      address2: 'e.g. Apt 4B',
      city: 'e.g. New York',
      state: 'e.g. New York',
      stateLabel: 'State',
      landmark: 'e.g. near Central Park',
    },
  },
};

// ---------------------------------------------------------------------------
// Derived lookup tables (built once from the registry)
// ---------------------------------------------------------------------------

const alpha3ToAlpha2Map: Record<string, string> = {};
const alpha2ToAlpha3Map: Record<string, string> = {};
const nameToAlpha2Map: Record<string, string> = {};
const prefixToAlpha2Map: Record<string, string> = {};

for (const cfg of Object.values(COUNTRY_REGISTRY)) {
  alpha2ToAlpha3Map[cfg.alpha2] = cfg.alpha3;
  alpha3ToAlpha2Map[cfg.alpha3] = cfg.alpha2;
  nameToAlpha2Map[cfg.name.toLowerCase()] = cfg.alpha2;
  // Strip '+' for prefix lookup
  prefixToAlpha2Map[cfg.phonePrefix.replace('+', '')] = cfg.alpha2;
}

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

/** Convert Alpha-2 → Alpha-3  (e.g. 'ZA' → 'ZAF') */
export function toAlpha3(code: string): string {
  if (!code) return alpha2ToAlpha3Map[DEFAULT_COUNTRY];
  const upper = code.toUpperCase().trim();
  // Already alpha-3?
  if (upper.length === 3 && alpha3ToAlpha2Map[upper]) return upper;
  return alpha2ToAlpha3Map[upper] || upper;
}

/** Convert Alpha-3 → Alpha-2  (e.g. 'ZAF' → 'ZA') */
export function toAlpha2(code: string): string {
  if (!code) return DEFAULT_COUNTRY;
  const upper = code.toUpperCase().trim();
  if (upper.length === 2 && COUNTRY_REGISTRY[upper]) return upper;
  return alpha3ToAlpha2Map[upper] || upper;
}

/** Country name → Alpha-2  (e.g. 'South Africa' → 'ZA') */
export function getCountryFromName(name: string): string {
  if (!name) return DEFAULT_COUNTRY;
  return nameToAlpha2Map[name.toLowerCase().trim()] || DEFAULT_COUNTRY;
}

/** Get the CountryConfig for an alpha-2 code (falls back to DEFAULT_COUNTRY) */
export function getCountryConfig(code: string): CountryConfig {
  const upper = (code || DEFAULT_COUNTRY).toUpperCase().trim();
  return COUNTRY_REGISTRY[upper] || COUNTRY_REGISTRY[DEFAULT_COUNTRY];
}

/** Currency code for a country  (e.g. 'ZA' → 'ZAR') */
export function getCurrency(countryCode: string): string {
  return getCountryConfig(countryCode).currency;
}

/** Currency symbol  (e.g. 'ZA' → 'R') */
export function getCurrencySymbol(countryCode: string): string {
  return getCountryConfig(countryCode).currencySymbol;
}

/** Locale string  (e.g. 'ZA' → 'en-ZA') */
export function getLocale(countryCode: string): string {
  return getCountryConfig(countryCode).locale;
}

/** Phone prefix  (e.g. 'ZA' → '+27') */
export function getPhonePrefix(countryCode: string): string {
  return getCountryConfig(countryCode).phonePrefix;
}

/** Is this country in our supported list? */
export function isSupported(countryCode: string): boolean {
  return (SUPPORTED_COUNTRIES as readonly string[]).includes(countryCode?.toUpperCase?.() || '');
}

/**
 * Normalize any country input (alpha2, alpha3, name) to alpha-2.
 * Returns DEFAULT_COUNTRY when nothing matches.
 */
export function resolveCountry(input: string): string {
  if (!input) return DEFAULT_COUNTRY;
  const trimmed = input.trim();

  // Try alpha-2
  if (trimmed.length === 2 && COUNTRY_REGISTRY[trimmed.toUpperCase()]) {
    return trimmed.toUpperCase();
  }
  // Try alpha-3
  if (trimmed.length === 3) {
    const a2 = alpha3ToAlpha2Map[trimmed.toUpperCase()];
    if (a2) return a2;
  }
  // Try name
  const byName = nameToAlpha2Map[trimmed.toLowerCase()];
  if (byName) return byName;

  return DEFAULT_COUNTRY;
}

/**
 * Detect country from the current browser domain.
 * Lovable preview/staging → DEFAULT_COUNTRY (ZA).
 */
export function getCountryFromDomain(): string {
  if (typeof window === 'undefined') return DEFAULT_COUNTRY;

  const hostname = window.location.hostname.toLowerCase();

  // Lovable staging/preview
  if (hostname.includes('lovable.app') || hostname.includes('lovable.dev') || hostname.includes('lovableproject.com')) {
    return DEFAULT_COUNTRY;
  }

  // Country TLDs
  if (hostname.endsWith('.pt') || hostname.includes('healingbuds.pt')) return 'PT';
  if (hostname.endsWith('.co.uk') || hostname.includes('healingbuds.co.uk')) return 'GB';
  if (hostname.endsWith('.co.za') || hostname.includes('healingbuds.co.za')) return 'ZA';
  if (hostname.endsWith('.co.th') || hostname.includes('.co.th')) return 'TH';
  if (hostname.endsWith('.global') || hostname.includes('healingbuds.global')) return DEFAULT_COUNTRY;
  if (hostname.endsWith('.us')) return 'US';
  if (hostname === 'healingbuds.com' || hostname === 'www.healingbuds.com') return 'US';

  return DEFAULT_COUNTRY;
}

/**
 * Get alpha-2 country code from a phone prefix string.
 * e.g. '351' → 'PT', '27' → 'ZA'
 */
export function getCountryFromPhone(prefix: string): string {
  const cleaned = (prefix || '').replace(/[^0-9]/g, '');
  return prefixToAlpha2Map[cleaned] || DEFAULT_COUNTRY;
}
