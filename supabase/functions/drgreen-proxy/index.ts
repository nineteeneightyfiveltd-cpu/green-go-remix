import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { encode as base64Encode } from "https://deno.land/std@0.168.0/encoding/base64.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as secp256k1 from "https://esm.sh/@noble/secp256k1@2.1.0";
import { sha256 } from "https://esm.sh/@noble/hashes@1.4.0/sha256";
import { hmac } from "https://esm.sh/@noble/hashes@1.4.0/hmac";

// Initialize secp256k1 with the required HMAC-SHA256 function
// This is required for signing operations in the noble library
secp256k1.etc.hmacSha256Sync = (key: Uint8Array, ...messages: Uint8Array[]) => {
  const h = hmac.create(sha256, key);
  for (const msg of messages) h.update(msg);
  return h.digest();
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version',
};

// Log level configuration - defaults to INFO in production
const LOG_LEVEL = Deno.env.get('LOG_LEVEL') || 'INFO';
const LOG_LEVELS: Record<string, number> = { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 };

function shouldLog(level: string): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[LOG_LEVEL];
}

// Sanitized logging - never log sensitive data in production
function logDebug(message: string, data?: Record<string, unknown>) {
  if (shouldLog('DEBUG')) {
    console.log(`[Debug] ${message}`, data ? sanitizeForLogging(data) : '');
  }
}

function logInfo(message: string, data?: Record<string, unknown>) {
  if (shouldLog('INFO')) {
    console.log(`[Info] ${message}`, data ? sanitizeForLogging(data) : '');
  }
}

function logWarn(message: string, data?: Record<string, unknown>) {
  if (shouldLog('WARN')) {
    console.warn(`[Warn] ${message}`, data ? sanitizeForLogging(data) : '');
  }
}

function logError(message: string, data?: Record<string, unknown>) {
  if (shouldLog('ERROR')) {
    console.error(`[Error] ${message}`, data ? sanitizeForLogging(data) : '');
  }
}

// Sanitize data for logging - redact sensitive fields
function sanitizeForLogging(data: Record<string, unknown>): Record<string, unknown> {
  const sensitiveFields = [
    'email', 'phone', 'contactNumber', 'firstName', 'lastName', 
    'dob', 'dateOfBirth', 'address', 'signature', 'apikey', 'token',
    'medicalRecord', 'medicalHistory', 'password', 'secret', 'key',
    'shipping', 'kycLink', 'payload'
  ];
  
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    const lowerKey = key.toLowerCase();
    const isSensitive = sensitiveFields.some(f => lowerKey.includes(f.toLowerCase()));
    
    if (isSensitive) {
      if (typeof value === 'string') {
        sanitized[key] = value.length > 6 ? `${value.slice(0, 3)}***${value.slice(-3)}` : '***';
      } else {
        sanitized[key] = '[REDACTED]';
      }
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = '[Object]';
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

// Admin-only actions that require admin role
const ADMIN_ACTIONS = [
  'dashboard-summary', 'dashboard-analytics', 'sales-summary',
  'dapp-clients', 'dapp-client-details', 'dapp-verify-client',
  'dapp-orders', 'dapp-order-details', 'dapp-update-order',
  'dapp-carts', 'dapp-nfts', 'dapp-strains', 'dapp-clients-list',
  'update-order', 'update-client', 'delete-client', 'patch-client',
  'activate-client', 'deactivate-client', 'bulk-delete-clients',
  'admin-list-all-clients', // List all clients for debugging
  'admin-update-shipping-address', // Admin can update any client's address
  'admin-reregister-client', // Re-register a client with current API key pair
  'get-clients-summary', 'get-sales', // Admin dashboard endpoints
];

// Actions that require ownership verification (user must own the resource)
const OWNERSHIP_ACTIONS = [
  'get-client', 'get-cart-legacy', 'get-cart',
  'add-to-cart', 'remove-from-cart', 'empty-cart',
  'place-order', 'get-order', 'get-orders',
  'get-my-details',           // Users can fetch their own client details
  'update-shipping-address',  // Users can update their own shipping address
  'create-order',             // Users can only create orders for their own clientId
  'auto-rehome-client',       // Users can trigger re-homing for their own client
];

// Public actions that don't require authentication (minimal - only webhooks/health)
const PUBLIC_ACTIONS: string[] = [];

// Country-gated actions: open countries (ZA, TH) don't require auth, restricted (GB, PT) do
const COUNTRY_GATED_ACTIONS = [
  'get-strains', 'get-all-strains', 'get-strains-legacy', 'get-strain'
];

// Open countries where unauthenticated users can browse products
const OPEN_COUNTRIES = ['ZAF', 'THA'];

// Authenticated but no ownership check needed
const AUTH_ONLY_ACTIONS: string[] = ['get-user-me', 'get-client-by-auth-email'];

// Debug mode REMOVED for security — all actions require proper authentication

// Retry configuration for transient failures
const RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 5000,
  backoffMultiplier: 2,
  retryableStatusCodes: [408, 429, 500, 502, 503, 504],
};

/**
 * Sleep helper for retry delays
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Calculate delay with exponential backoff and jitter
 */
function calculateBackoffDelay(attempt: number): number {
  const baseDelay = RETRY_CONFIG.initialDelayMs * Math.pow(RETRY_CONFIG.backoffMultiplier, attempt);
  const jitter = Math.random() * 0.3 * baseDelay; // Add up to 30% jitter
  return Math.min(baseDelay + jitter, RETRY_CONFIG.maxDelayMs);
}

/**
 * Check if an error or status code is retryable
 */
function isRetryable(error: unknown, statusCode?: number): boolean {
  // Network errors are retryable
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    if (message.includes('timeout') || 
        message.includes('network') || 
        message.includes('econnreset') ||
        message.includes('fetch failed')) {
      return true;
    }
  }
  
  // Specific status codes are retryable
  if (statusCode && RETRY_CONFIG.retryableStatusCodes.includes(statusCode)) {
    return true;
  }
  
  return false;
}

// getDebugSecret REMOVED — debug mode eliminated for security

/**
 * Input validation schemas
 */
function validateClientId(clientId: unknown): boolean {
  return typeof clientId === 'string' && clientId.length > 0 && clientId.length <= 100;
}

function validateCountryCode(code: unknown): boolean {
  const validCodes = ['PT', 'PRT', 'GB', 'GBR', 'ZA', 'ZAF', 'TH', 'THA', 'US', 'USA'];
  return typeof code === 'string' && (validCodes.includes(code.toUpperCase()) || code.length === 0);
}

function validatePagination(page: unknown, take: unknown): boolean {
  const pageNum = Number(page);
  const takeNum = Number(take);
  return (!page || (pageNum >= 1 && pageNum <= 1000)) && 
         (!take || (takeNum >= 1 && takeNum <= 100));
}

function validateEmail(email: unknown): boolean {
  if (typeof email !== 'string') return false;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email) && email.length <= 255;
}

function validateStringLength(value: unknown, maxLength: number): boolean {
  return typeof value === 'string' && value.length <= maxLength;
}

/**
 * Extract PEM body from Base64-encoded PEM string
 * When DRGREEN_API_KEY is stored as Base64-encoded PEM (e.g., "LS0tLS1CRUdJTi..."), 
 * this extracts just the inner key content (e.g., "MFYwEAYH...") for the API header
 */
// extractPemBody REMOVED — dead code, known source of key corruption bugs

/**
 * Convert country name to ISO 3166-1 alpha-3 code
 */
function getCountryCodeFromName(countryName: string | undefined): string {
  if (!countryName) return '';
  const name = countryName.toLowerCase().trim();
  const countryMap: Record<string, string> = {
    'south africa': 'ZAF',
    'za': 'ZAF',
    'portugal': 'PRT',
    'pt': 'PRT',
    'united kingdom': 'GBR',
    'uk': 'GBR',
    'gb': 'GBR',
    'thailand': 'THA',
    'th': 'THA',
    'united states': 'USA',
    'usa': 'USA',
    'us': 'USA',
  };
  return countryMap[name] || countryName.toUpperCase();
}

/**
 * Convert Alpha-2 country code to Alpha-3, or pass through if already Alpha-3
 * e.g. 'ZA' → 'ZAF', 'GB' → 'GBR', 'ZAF' → 'ZAF'
 */
function toAlpha3(code: string | undefined): string {
  if (!code) return '';
  const upper = code.toUpperCase().trim();
  // Already Alpha-3?
  if (upper.length === 3) return upper;
  const alpha2ToAlpha3: Record<string, string> = {
    'ZA': 'ZAF', 'PT': 'PRT', 'GB': 'GBR', 'UK': 'GBR',
    'TH': 'THA', 'US': 'USA', 'DE': 'DEU', 'FR': 'FRA',
    'ES': 'ESP', 'IT': 'ITA', 'NL': 'NLD', 'BE': 'BEL',
  };
  return alpha2ToAlpha3[upper] || upper;
}

/**
 * Convert Alpha-3 country code to Alpha-2, or pass through if already Alpha-2
 */
function toAlpha2(code: string | undefined): string {
  if (!code) return '';
  const upper = code.toUpperCase().trim();
  if (upper.length === 2) return upper;
  const alpha3ToAlpha2: Record<string, string> = {
    'ZAF': 'ZA', 'PRT': 'PT', 'GBR': 'GB', 'THA': 'TH', 'USA': 'US',
    'DEU': 'DE', 'FRA': 'FR', 'ESP': 'ES', 'ITA': 'IT', 'NLD': 'NL', 'BEL': 'BE',
  };
  return alpha3ToAlpha2[upper] || upper;
}

/**
 * Verify user authentication and return user data
 * Uses getClaims() for Lovable Cloud ES256 signing-keys compatibility,
 * with getUser() fallback for full user data when needed.
 */
async function verifyAuthentication(req: Request): Promise<{ user: any; supabaseClient: any } | null> {
  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logDebug('Auth: No authorization header found');
    return null;
  }

  const token = authHeader.replace('Bearer ', '');

  const supabaseClient = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_ANON_KEY')!,
    { global: { headers: { Authorization: authHeader } } }
  );

  // Primary: Use getClaims() which works with Lovable Cloud ES256 signing-keys
  try {
    const { data: claimsData, error: claimsError } = await supabaseClient.auth.getClaims(token);
    if (!claimsError && claimsData?.claims) {
      const user = {
        id: claimsData.claims.sub,
        email: claimsData.claims.email,
        role: claimsData.claims.role,
      };
      logDebug('Auth: Verified via getClaims', { userId: user.id });
      return { user, supabaseClient };
    }
    logDebug('Auth: getClaims failed, trying getUser fallback', { error: claimsError?.message });
  } catch (e) {
    logDebug('Auth: getClaims threw, trying getUser fallback', { error: String(e) });
  }

  // Fallback: Use getUser() for older SDK compatibility
  try {
    const { data: { user }, error } = await supabaseClient.auth.getUser(token);
    if (!error && user) {
      logDebug('Auth: Verified via getUser fallback', { userId: user.id });
      return { user, supabaseClient };
    }
    logDebug('Auth: getUser also failed', { error: error?.message });
  } catch (e) {
    logDebug('Auth: getUser threw', { error: String(e) });
  }

  return null;
}

/**
 * Check if user has admin role
 */
async function isAdmin(supabaseClient: any, userId: string): Promise<boolean> {
  const { data } = await supabaseClient
    .rpc('has_role', { _user_id: userId, _role: 'admin' });
  return !!data;
}

/**
 * Verify user owns the client resource
 */
async function verifyClientOwnership(
  supabaseClient: any, 
  userId: string, 
  clientId: string
): Promise<boolean> {
  const { data, error } = await supabaseClient
    .from('drgreen_clients')
    .select('user_id')
    .eq('drgreen_client_id', clientId)
    .maybeSingle();

  if (error || !data) {
    return false;
  }

  return data.user_id === userId;
}

// ============================================================
// ENVIRONMENT CONFIGURATION - Supports production and staging
// ============================================================
interface EnvConfig {
  apiUrl: string;
  apiKeyEnv: string;
  privateKeyEnv: string;
  name: string;
}

// Helper to get staging URL - validates it's actually a URL
function getStagingApiUrl(): string {
  const envUrl = Deno.env.get('DRGREEN_STAGING_API_URL');
  // Only use env URL if it looks like a valid URL
  if (envUrl && (envUrl.startsWith('http://') || envUrl.startsWith('https://'))) {
    return envUrl;
  }
  // Default staging URL
  return 'https://stage-api.drgreennft.com/api/v1';
}

// All environments use the same credentials — no separate write keys
// Production and Railway are the only two environments

const ENV_CONFIG: Record<string, EnvConfig> = {
  production: {
    apiUrl: 'https://api.drgreennft.com/api/v1',
    apiKeyEnv: 'DRGREEN_API_KEY',
    privateKeyEnv: 'DRGREEN_PRIVATE_KEY',
    name: 'Production',
  },
  railway: {
    apiUrl: 'https://budstack-backend-main-development.up.railway.app/api/v1',
    apiKeyEnv: 'DRGREEN_STAGING_API_KEY',
    privateKeyEnv: 'DRGREEN_STAGING_PRIVATE_KEY',
    name: 'Railway (Dev)',
  },
};

/**
 * Get environment configuration based on request or global setting
 * Priority: 1) Explicit env param 2) DRGREEN_USE_STAGING env var 3) production default
 */
function getEnvironment(requestedEnv?: string): EnvConfig {
  // If explicit environment requested, use it (only production and railway supported)
  if (requestedEnv && ENV_CONFIG[requestedEnv]) {
    logInfo(`Using environment: ${requestedEnv} (explicit)`);
    return ENV_CONFIG[requestedEnv];
  }
  
  // Default to production
  return ENV_CONFIG.production;
}

/**
 * Get credentials for a specific environment
 */
function getEnvCredentials(envConfig: EnvConfig): { apiKey: string | undefined; privateKey: string | undefined } {
  return {
    apiKey: Deno.env.get(envConfig.apiKeyEnv),
    privateKey: Deno.env.get(envConfig.privateKeyEnv),
  };
}

// Default API URL (for backwards compatibility with existing code)
const DRGREEN_API_URL = "https://api.drgreennft.com/api/v1";

// API timeout in milliseconds (20 seconds)
const API_TIMEOUT_MS = 20000;

/**
 * Clean and normalize Base64 string for decoding
 * Handles URL-safe Base64, whitespace, and padding issues
 */
function cleanBase64(base64: string): string {
  // Remove any whitespace, newlines, quotes
  let cleaned = (base64 || '')
    .replace(/[\s\r\n"']/g, '')
    .trim();
  
  // Convert URL-safe Base64 to standard Base64
  cleaned = cleaned.replace(/-/g, '+').replace(/_/g, '/');
  
  // Fix padding if needed
  const paddingNeeded = (4 - (cleaned.length % 4)) % 4;
  if (paddingNeeded > 0 && paddingNeeded < 4) {
    cleaned += '='.repeat(paddingNeeded);
  }
  
  return cleaned;
}

/**
 * Check if a string is valid Base64 (after cleaning)
 */
function isBase64(str: string): boolean {
  const cleaned = cleanBase64(str);
  if (!cleaned || cleaned.length === 0) return false;
  // More permissive regex that allows for various Base64 formats
  return /^[A-Za-z0-9+/]*=*$/.test(cleaned);
}

/**
 * Decode Base64 string to Uint8Array with robust error handling
 */
function base64ToBytes(base64: string): Uint8Array {
  const cleaned = cleanBase64(base64);
  
  if (!cleaned) {
    throw new Error('Empty Base64 string');
  }
  
  try {
    const binaryString = atob(cleaned);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes;
  } catch (e) {
    // Log more details for debugging
    logError('Base64 decode failed', {
      originalLength: base64?.length || 0,
      cleanedLength: cleaned.length,
      first20Chars: cleaned.substring(0, 20),
      last20Chars: cleaned.substring(cleaned.length - 20),
      error: String(e)
    });
    throw e;
  }
}

/**
 * Convert Uint8Array to Base64 string
 */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Extract raw 32-byte private key from PKCS#8 secp256k1 key
 * PKCS#8 structure for EC keys:
 *   SEQUENCE {
 *     INTEGER 0 (version)
 *     SEQUENCE { OID ecPublicKey, OID secp256k1 }
 *     OCTET STRING containing SEC1 private key:
 *       SEQUENCE {
 *         INTEGER 1
 *         OCTET STRING (32 bytes - the actual private key)
 *         ...
 *       }
 *   }
 */
function extractSecp256k1PrivateKey(derBytes: Uint8Array): Uint8Array {
  // Supports both PKCS#8 and SEC1 EC private key formats
  // PKCS#8 (~138 bytes): SEQUENCE { INTEGER 0, SEQUENCE {OIDs}, OCTET STRING {SEC1} }
  // SEC1 (~88 bytes):    SEQUENCE { INTEGER 1, OCTET STRING (32 bytes), ... }
  
  let offset = 0;
  
  function readLength(): number {
    const firstByte = derBytes[offset++];
    if (firstByte < 0x80) return firstByte;
    const numBytes = firstByte & 0x7f;
    let length = 0;
    for (let i = 0; i < numBytes; i++) {
      length = (length << 8) | derBytes[offset++];
    }
    return length;
  }
  
  function readInteger(): { value: number; rawBytes: Uint8Array } {
    if (derBytes[offset++] !== 0x02) throw new Error('Expected INTEGER');
    const len = readLength();
    const raw = derBytes.slice(offset, offset + len);
    let value = 0;
    for (let i = 0; i < len; i++) value = (value << 8) | derBytes[offset + i];
    offset += len;
    return { value, rawBytes: raw };
  }
  
  // Outer SEQUENCE
  if (derBytes[offset++] !== 0x30) throw new Error('Expected SEQUENCE');
  readLength();
  
  // Log first bytes after SEQUENCE header for debugging
  logInfo('secp256k1: DER structure', {
    totalLength: derBytes.length,
    nextByte: `0x${derBytes[offset].toString(16).padStart(2, '0')}`,
    first16Hex: Array.from(derBytes.slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join(' '),
  });
  
  // If the key is exactly 32 bytes after decoding, it might be a raw key
  if (derBytes.length === 32) {
    logInfo('secp256k1: Using as raw 32-byte key');
    return derBytes;
  }
  
  // Check the tag at current position to determine format
  const nextTag = derBytes[offset];
  
  // If next byte is INTEGER (0x02), it's a structured key (PKCS#8 or SEC1)
  if (nextTag === 0x02) {
    const version = readInteger();
  
    if (version.value === 1) {
      // SEC1 ECPrivateKey format: SEQUENCE { INTEGER 1, OCTET STRING (32 bytes), ... }
      logInfo('secp256k1: Detected SEC1 format');
      if (derBytes[offset++] !== 0x04) throw new Error('Expected OCTET STRING (private key)');
      const keyLen = readLength();
      if (keyLen !== 32) throw new Error(`Expected 32-byte private key, got ${keyLen}`);
      return derBytes.slice(offset, offset + 32);
      
    } else if (version.value === 0) {
      // PKCS#8 format: SEQUENCE { INTEGER 0, SEQUENCE {OIDs}, OCTET STRING {SEC1} }
      logInfo('secp256k1: Detected PKCS#8 format');
      
      // Skip algorithm identifier SEQUENCE
      if (derBytes[offset++] !== 0x30) throw new Error('Expected SEQUENCE (algorithm)');
      const algLen = readLength();
      offset += algLen;
      
      // OCTET STRING containing SEC1 ECPrivateKey
      if (derBytes[offset++] !== 0x04) throw new Error('Expected OCTET STRING');
      readLength();
      
      // Parse inner SEC1 structure
      if (derBytes[offset++] !== 0x30) throw new Error('Expected SEQUENCE (SEC1)');
      readLength();
      
      // SEC1 version INTEGER (should be 1)
      if (derBytes[offset++] !== 0x02) throw new Error('Expected INTEGER (SEC1 version)');
      const sec1VersionLen = readLength();
      offset += sec1VersionLen;
      
      // Private key OCTET STRING (32 bytes)
      if (derBytes[offset++] !== 0x04) throw new Error('Expected OCTET STRING (private key)');
      const keyLen = readLength();
      if (keyLen !== 32) throw new Error(`Expected 32-byte private key, got ${keyLen}`);
      return derBytes.slice(offset, offset + 32);
      
    } else {
      throw new Error(`Unexpected key version: ${version.value}. Expected 0 (PKCS#8) or 1 (SEC1)`);
    }
  }
  
  // If next byte is OCTET STRING (0x04), try to read 32 bytes directly
  if (nextTag === 0x04) {
    offset++; // skip tag
    const keyLen = readLength();
    if (keyLen === 32) {
      logInfo('secp256k1: Found raw OCTET STRING key');
      return derBytes.slice(offset, offset + 32);
    }
  }
  
  throw new Error(`Unsupported key format. Tag at offset: 0x${nextTag.toString(16)}, DER length: ${derBytes.length}`);
}

/**
 * Generate secp256k1 ECDSA signature using @noble/secp256k1
 * This handles the EC key format that WebCrypto doesn't support
 */
async function generateSecp256k1Signature(
  data: string,
  base64PrivateKey: string
): Promise<string> {
  const encoder = new TextEncoder();
  const secret = (base64PrivateKey || '').trim();

  // Step 1: Base64 decode the secret
  let decodedSecretBytes: Uint8Array;
  try {
    decodedSecretBytes = base64ToBytes(secret);
  } catch (e) {
    logError("Failed to decode private key from Base64", { error: String(e) });
    throw new Error("Invalid private key format - must be Base64-encoded");
  }

  // Step 2: Check if it's PEM format and extract DER
  const decodedAsText = new TextDecoder().decode(decodedSecretBytes);
  let keyDerBytes: Uint8Array;

  // Robust PEM detection: string check + byte-level fallback for dashes (0x2D)
  const isPem = decodedAsText.includes('-----BEGIN') ||
    decodedAsText.includes('BEGIN') ||
    (decodedSecretBytes.length >= 2 &&
      decodedSecretBytes[0] === 0x2D && decodedSecretBytes[1] === 0x2D);

  logInfo('secp256k1: PEM detection', {
    isPem,
    decodedLength: decodedSecretBytes.length,
    first30Chars: decodedAsText.substring(0, 30).replace(/[^\x20-\x7E]/g, '?'),
    firstBytes: Array.from(decodedSecretBytes.slice(0, 6)).map(b => b.toString(16).padStart(2, '0')).join(' '),
  });

  // Helper: extract Base64 body from PEM text (handles truncated/malformed headers)
  function extractPemBase64Body(text: string): string {
    return text
      // Strip standard PEM headers
      .replace(/-----BEGIN [A-Z0-9 ]+-----/g, '')
      .replace(/-----END [A-Z0-9 ]+-----/g, '')
      // Strip truncated/malformed dash headers (e.g. "---\n" or "--\n")
      .replace(/-{2,}[^\n]*\n?/g, '')
      .replace(/[\r\n\s]/g, '')
      .trim();
  }

  if (isPem) {
    const pemBody = extractPemBase64Body(decodedAsText);

    if (!pemBody || !isBase64(pemBody)) {
      throw new Error('Invalid private key PEM format');
    }

    keyDerBytes = base64ToBytes(pemBody);
    logInfo('secp256k1: Decoded PEM to DER', { derLength: keyDerBytes.length });
  } else if (decodedSecretBytes.length >= 150 && decodedSecretBytes.length <= 500) {
    // Fallback: size looks like PEM text, try PEM extraction anyway
    logInfo('secp256k1: Size suggests PEM text, attempting PEM extraction as fallback', { 
      decodedLength: decodedSecretBytes.length 
    });
    const pemBody = extractPemBase64Body(decodedAsText);

    if (pemBody && isBase64(pemBody)) {
      keyDerBytes = base64ToBytes(pemBody);
      logInfo('secp256k1: Fallback PEM extraction succeeded', { derLength: keyDerBytes.length });
    } else {
      keyDerBytes = decodedSecretBytes;
      logInfo('secp256k1: Fallback PEM extraction failed, using raw bytes', { derLength: keyDerBytes.length });
    }
  } else {
    keyDerBytes = decodedSecretBytes;
    logInfo('secp256k1: Using raw DER', { derLength: keyDerBytes.length });
  }

  // Step 3: Extract the 32-byte private key from PKCS#8
  let privateKeyBytes: Uint8Array;
  try {
    privateKeyBytes = extractSecp256k1PrivateKey(keyDerBytes);
    logInfo('secp256k1: Extracted private key', { 
      keyLength: privateKeyBytes.length,
      // Log first 4 bytes (safe, just for debugging format)
      prefix: Array.from(privateKeyBytes.slice(0, 4)).map(b => b.toString(16).padStart(2, '0')).join(''),
    });
  } catch (e) {
    // Check if the input was actually ASCII text (PEM) that wasn't detected
    const isAsciiText = keyDerBytes.every(b => b < 128);
    if (isAsciiText) {
      logError('secp256k1: DER parse failed on ASCII text — key is likely PEM that was not detected', {
        error: String(e),
        keyLength: keyDerBytes.length,
        firstChars: new TextDecoder().decode(keyDerBytes.slice(0, 40)).replace(/[^\x20-\x7E]/g, '?'),
      });
    } else {
      logError('secp256k1: Failed to extract private key', { error: String(e) });
    }
    throw new Error(`Failed to parse secp256k1 private key: ${e}`);
  }

  // Step 4: Hash the data with SHA-256 and sign
  const dataBytes = encoder.encode(data);
  const messageHash = sha256(dataBytes);
  
  // Sign with secp256k1 - returns SignatureWithRecovery object
  const signature = secp256k1.sign(messageHash, privateKeyBytes);
  
  // Get compact signature (64 bytes: r || s) and convert to DER manually
  // since toDERBytes may not exist on SignatureWithRecovery type
  const compactSig = signature.toCompactRawBytes();
  
  // Convert compact (r || s) to DER format
  const r = compactSig.slice(0, 32);
  const s = compactSig.slice(32, 64);
  
  function integerToDER(val: Uint8Array): Uint8Array {
    // Remove leading zeros but keep at least one byte
    let start = 0;
    while (start < val.length - 1 && val[start] === 0) start++;
    let trimmed = val.slice(start);
    
    // If high bit is set, prepend 0x00 to keep it positive
    const needsPadding = trimmed[0] >= 0x80;
    const result = new Uint8Array((needsPadding ? 1 : 0) + trimmed.length);
    if (needsPadding) result[0] = 0x00;
    result.set(trimmed, needsPadding ? 1 : 0);
    return result;
  }
  
  const rDer = integerToDER(r);
  const sDer = integerToDER(s);
  
  // DER SEQUENCE: 0x30 length [0x02 rLen r...] [0x02 sLen s...]
  const innerLen = 2 + rDer.length + 2 + sDer.length;
  const derSig = new Uint8Array(2 + innerLen);
  derSig[0] = 0x30; // SEQUENCE
  derSig[1] = innerLen;
  derSig[2] = 0x02; // INTEGER
  derSig[3] = rDer.length;
  derSig.set(rDer, 4);
  derSig[4 + rDer.length] = 0x02; // INTEGER
  derSig[5 + rDer.length] = sDer.length;
  derSig.set(sDer, 6 + rDer.length);
  
  logInfo('secp256k1: Signature generated', {
    signatureLength: derSig.length,
    dataLength: data.length,
  });

  return bytesToBase64(derSig);
}

/**
 * Generate RSA/EC signature using asymmetric private key
 * Matches the Node.js pattern from Dr Green API docs:
 * 
 *   const privateKeyBuffer = Buffer.from(secretKey, 'base64');
 *   const privateKeyObject = crypto.createPrivateKey(privateKeyBuffer);
 *   const signature = crypto.sign(null, Buffer.from(payload), privateKeyObject);
 *   const signatureBase64 = signature.toString('base64');
 * 
 * @param data - The data to sign (payload string)
 * @param base64PrivateKey - The Base64-encoded private key (PEM or DER format)
 * @returns Base64-encoded signature
 */
async function generatePrivateKeySignature(
  data: string,
  base64PrivateKey: string
): Promise<string> {
  const encoder = new TextEncoder();
  const secret = (base64PrivateKey || '').trim();

  // Step 1: Base64 decode the secret
  let decodedSecretBytes: Uint8Array;
  try {
    decodedSecretBytes = base64ToBytes(secret);
  } catch (e) {
    logError("Failed to decode private key from Base64", { error: String(e) });
    throw new Error("Invalid private key format - must be Base64-encoded");
  }

  // Step 2: Detect PEM and extract DER bytes
  let keyDerBytes: Uint8Array;
  const decodedAsText = new TextDecoder().decode(decodedSecretBytes);

  // Log key format detection for debugging
  const hasPemHeader = decodedAsText.includes('-----BEGIN');
  const pemHeaderMatch = decodedAsText.match(/-----BEGIN ([A-Z0-9 ]+)-----/);
  const pemType = pemHeaderMatch ? pemHeaderMatch[1] : 'UNKNOWN';
  
  logInfo('Private key format detection', {
    hasPemHeader,
    pemType,
    decodedLength: decodedSecretBytes.length,
  });

  if (hasPemHeader) {
    // Extract the PEM body (base64 DER)
    const pemBody = decodedAsText
      .replace(/-----BEGIN [A-Z0-9 ]+-----/g, '')
      .replace(/-----END [A-Z0-9 ]+-----/g, '')
      .replace(/[\r\n\s]/g, '')
      .trim();

    if (!pemBody || !isBase64(pemBody)) {
      logError('Private key PEM body is empty or not Base64', {
        pemDetected: true,
        decodedLength: decodedAsText.length,
      });
      throw new Error('Invalid private key PEM format');
    }

    keyDerBytes = base64ToBytes(pemBody);
    logInfo('Private key decoded from Base64 PEM', {
      pemType,
      derLength: keyDerBytes.length,
    });
  } else {
    keyDerBytes = decodedSecretBytes;
    logInfo('Private key decoded from Base64 DER', {
      derLength: keyDerBytes.length,
    });
  }

  // Step 3: Check for secp256k1 OID (1.3.132.0.10 = 06 05 2B 81 04 00 0A)
  const keyHex = Array.from(keyDerBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const secp256k1OID = '2b8104000a'; // OID 1.3.132.0.10 in hex
  
  if (keyHex.includes(secp256k1OID)) {
    logInfo('secp256k1 key detected, using @noble/secp256k1 for signing');
    return generateSecp256k1Signature(data, base64PrivateKey);
  }

  // Step 4: Try WebCrypto for RSA or standard EC curves
  let cryptoKey: CryptoKey;

  try {
    cryptoKey = await crypto.subtle.importKey(
      'pkcs8',
      keyDerBytes.buffer as ArrayBuffer,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['sign']
    );
    logDebug('Successfully imported RSA private key (PKCS#8)');
  } catch (rsaError) {
    logDebug('RSA import failed, trying EC P-256', { error: String(rsaError) });

    try {
      cryptoKey = await crypto.subtle.importKey(
        'pkcs8',
        keyDerBytes.buffer as ArrayBuffer,
        {
          name: 'ECDSA',
          namedCurve: 'P-256',
        },
        false,
        ['sign']
      );
      logDebug('Successfully imported EC private key (P-256)');
    } catch (ecError) {
      logDebug('EC P-256 import failed, trying P-384', { error: String(ecError) });

      try {
        cryptoKey = await crypto.subtle.importKey(
          'pkcs8',
          keyDerBytes.buffer as ArrayBuffer,
          {
            name: 'ECDSA',
            namedCurve: 'P-384',
          },
          false,
          ['sign']
        );
        logDebug('Successfully imported EC private key (P-384)');
      } catch (ec384Error) {
        logError('All WebCrypto imports failed', {
          rsaError: String(rsaError),
          ecError: String(ecError),
          ec384Error: String(ec384Error),
        });
        throw new Error('Failed to import private key - unsupported format');
      }
    }
  }

  // Step 5: Sign the data
  const dataBytes = encoder.encode(data);

  let signatureBuffer: ArrayBuffer;
  if (cryptoKey.algorithm.name === 'ECDSA') {
    signatureBuffer = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      cryptoKey,
      dataBytes
    );
  } else {
    signatureBuffer = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', cryptoKey, dataBytes);
  }

  // Step 6: Return Base64 signature
  return bytesToBase64(new Uint8Array(signatureBuffer));
}

// Deep-normalize a shipping address object for frontend consistency
function normalizeShippingObject(shipping: Record<string, unknown>): Record<string, unknown> {
  return {
    ...shipping,
    postalCode: String(shipping.postalCode || shipping.zipCode || shipping.zip_code || '').trim(),
    address1: String(shipping.address1 || shipping.address_line_1 || '').trim(),
    address2: String(shipping.address2 || shipping.address_line_2 || '').trim(),
    city: String(shipping.city || '').trim(),
    state: String(shipping.state || shipping.city || '').trim(),
    country: String(shipping.country || '').trim(),
    countryCode: String(shipping.countryCode || shipping.country_code || '').trim().toUpperCase(),
    landmark: String(shipping.landmark || '').trim(),
  };
}


/**
 * HMAC-SHA256 signing - THE CORRECT METHOD for Dr Green API
 * Matches the working health check approach and WordPress reference implementation.
 * 
 * For GET requests: signs the query string (e.g., "orderBy=desc&take=10&page=1")
 * For POST requests: signs the JSON body string
 * For empty payloads: signs an empty string ""
 * 
 * @param data - The data to sign (query string for GET, JSON body for POST)
 * @param secretKey - The Base64-encoded private key from secrets
 * @returns Base64-encoded HMAC-SHA256 signature
 */
async function signWithHmac(data: string, secretKey: string): Promise<string> {
  const encoder = new TextEncoder();
  const secret = (secretKey || '').trim();
  
  // Decode secret key - try Base64 first, fall back to raw bytes
  let keyBytes: Uint8Array;
  const isBase64Key = /^[A-Za-z0-9+/]+=*$/.test(secret) && secret.length % 4 === 0;
  
  if (isBase64Key) {
    try {
      const binaryString = atob(secret);
      keyBytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        keyBytes[i] = binaryString.charCodeAt(i);
      }
    } catch {
      keyBytes = encoder.encode(secret);
    }
  } else {
    keyBytes = encoder.encode(secret);
  }
  
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes.buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  
  const dataBytes = encoder.encode(data);
  const signatureBuffer = await crypto.subtle.sign("HMAC", cryptoKey, dataBytes);
  
  // Convert to Base64
  const signatureBytes = new Uint8Array(signatureBuffer);
  let binary = '';
  for (let i = 0; i < signatureBytes.byteLength; i++) {
    binary += String.fromCharCode(signatureBytes[i]);
  }
  
  const signature = btoa(binary);
  
  logDebug("HMAC-SHA256 signature generated", {
    signatureLength: signature.length,
    dataLength: data.length,
  });
  
  return signature;
}

/**
 * Legacy fallback HMAC-SHA256 signature (kept for backwards compatibility)
 */
// generateHmacSignatureFallback REMOVED — was just a wrapper around signWithHmac

/**
 * Sign payload using secp256k1 ECDSA (primary method)
 * Falls back to HMAC only if DRGREEN_USE_HMAC is explicitly set to "true"
 */
async function signPayload(payload: string, secretKey: string): Promise<string> {
  const useHmac = Deno.env.get('DRGREEN_USE_HMAC') === 'true';
  
  if (useHmac) {
    return signWithHmac(payload, secretKey);
  }
  
  // Primary: use secp256k1 ECDSA signing (matches working drgreen-comparison)
  return generateSecp256k1Signature(payload, secretKey);
}

/**
 * Sign query string using secp256k1 ECDSA
 * This is used for GET list endpoints
 */
async function signQueryString(queryString: string, secretKey: string): Promise<string> {
  return generateSecp256k1Signature(queryString, secretKey);
}

/**
 * Generate signature with specific mode (for diagnostics)
 */
// signPayloadWithMode REMOVED — unused wrapper

/**
 * Retry wrapper for API requests with exponential backoff
 */
async function withRetry<T>(
  operation: () => Promise<T>,
  operationName: string,
  isResponseRetryable?: (response: T) => boolean
): Promise<T> {
  let lastError: unknown;
  
  for (let attempt = 0; attempt <= RETRY_CONFIG.maxRetries; attempt++) {
    try {
      const result = await operation();
      
      // Check if the response itself indicates a retryable condition
      if (isResponseRetryable && isResponseRetryable(result)) {
        if (attempt < RETRY_CONFIG.maxRetries) {
          const delay = calculateBackoffDelay(attempt);
          logWarn(`${operationName}: Retryable response, attempt ${attempt + 1}/${RETRY_CONFIG.maxRetries + 1}, waiting ${Math.round(delay)}ms`);
          await sleep(delay);
          continue;
        }
      }
      
      return result;
    } catch (error) {
      lastError = error;
      
      if (!isRetryable(error) || attempt >= RETRY_CONFIG.maxRetries) {
        throw error;
      }
      
      const delay = calculateBackoffDelay(attempt);
      logWarn(`${operationName}: Retry attempt ${attempt + 1}/${RETRY_CONFIG.maxRetries}, waiting ${Math.round(delay)}ms`, {
        error: error instanceof Error ? error.message : String(error),
      });
      await sleep(delay);
    }
  }
  
  throw lastError;
}

/**
 * Make authenticated request to Dr Green API with body signing (Method A)
 * Used for: POST, DELETE, and singular GET endpoints
 * Includes automatic retry with exponential backoff for transient failures
 * 
 * @param endpoint - API endpoint path
 * @param method - HTTP method
 * @param body - Request body object
 * @param enableDetailedLogging - Enable verbose logging
 * @param envConfig - Optional environment config (defaults to production)
 */
async function drGreenRequestBody(
  endpoint: string,
  method: string,
  body?: object,
  enableDetailedLogging = false,
  envConfig?: EnvConfig
): Promise<Response> {
  // Use provided env or default to production
  const env = envConfig || ENV_CONFIG.production;
  const { apiKey, privateKey: secretKey } = getEnvCredentials(env);
  
  // Enhanced credential diagnostics when enabled
  if (enableDetailedLogging) {
    console.log("[API-DEBUG] ========== BODY REQUEST PREPARATION ==========");
    console.log("[API-DEBUG] Environment:", env.name);
    console.log("[API-DEBUG] API URL:", env.apiUrl);
    console.log("[API-DEBUG] Endpoint:", endpoint);
    console.log("[API-DEBUG] Method:", method);
    console.log("[API-DEBUG] API Key env var:", env.apiKeyEnv);
    console.log("[API-DEBUG] API Key present:", !!apiKey);
    console.log("[API-DEBUG] API Key length:", apiKey?.length || 0);
    console.log("[API-DEBUG] API Key prefix:", apiKey ? apiKey.slice(0, 8) + "..." : "N/A");
    console.log("[API-DEBUG] API Key is Base64:", apiKey ? /^[A-Za-z0-9+/=]+$/.test(apiKey) : false);
    console.log("[API-DEBUG] Private Key env var:", env.privateKeyEnv);
    console.log("[API-DEBUG] Private Key present:", !!secretKey);
    console.log("[API-DEBUG] Private Key length:", secretKey?.length || 0);
  }
  
  if (!apiKey || !secretKey) {
    throw new Error(`Dr Green API credentials not configured for ${env.name} (${env.apiKeyEnv}, ${env.privateKeyEnv})`);
  }
  
  // Validate API key format - should be Base64-encoded, not raw PEM
  if (apiKey.startsWith('-----BEGIN')) {
    console.error(`[API-ERROR] ${env.apiKeyEnv} contains raw PEM format. It should be Base64-encoded.`);
    throw new Error('API key misconfigured - contact administrator');
  }
  
  const payload = body ? JSON.stringify(body) : "";
  
  // Use secp256k1 ECDSA signing (matches working drgreen-comparison approach)
  const signature = await generateSecp256k1Signature(payload, secretKey);
  
  if (enableDetailedLogging) {
    console.log("[API-DEBUG] Payload length:", payload.length);
    console.log("[API-DEBUG] Payload preview:", payload.slice(0, 150));
    console.log("[API-DEBUG] Signing method: secp256k1 ECDSA");
    console.log("[API-DEBUG] Signature length:", signature.length);
    console.log("[API-DEBUG] Signature prefix:", signature.slice(0, 16) + "...");
  }
  
  // Send the raw API key as-is (no PEM stripping)
  // The Dr. Green API expects the key exactly as stored in the secret
  if (enableDetailedLogging) {
    console.log("[API-DEBUG] API Key: raw (no extractPemBody), length:", apiKey.length);
  }
  
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-auth-apikey": apiKey,
    "x-auth-signature": signature,
  };
  
  if (enableDetailedLogging) {
    console.log("[API-DEBUG] Headers:", {
      "Content-Type": headers["Content-Type"],
      "x-auth-apikey": `${headers["x-auth-apikey"]?.slice(0, 12)}... (len: ${headers["x-auth-apikey"]?.length})`,
      "x-auth-signature": `${headers["x-auth-signature"]?.slice(0, 12)}... (len: ${headers["x-auth-signature"]?.length})`
    });
  }
  
  const url = `${env.apiUrl}${endpoint}`;
  logInfo(`API request: ${method} ${endpoint}`, { environment: env.name });
  
  // Wrap the fetch in retry logic
  return withRetry(
    async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
      
      try {
        const response = await fetch(url, {
          method,
          headers,
          body: method !== "GET" && method !== "HEAD" ? payload : undefined,
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);
        
        // Enhanced 401 error analysis when enabled
        if (response.status === 401 && enableDetailedLogging) {
          const clonedResp = response.clone();
          const errorBody = await clonedResp.text();
          console.log("[API-DEBUG] ========== 401 UNAUTHORIZED ANALYSIS ==========");
          console.log("[API-DEBUG] Environment:", env.name);
          console.log("[API-DEBUG] Response status:", response.status);
          console.log("[API-DEBUG] Response headers:", JSON.stringify(Object.fromEntries(response.headers.entries())));
          console.log("[API-DEBUG] Error body:", errorBody);
          console.log("[API-DEBUG] Possible causes:");
          console.log("[API-DEBUG]   1. API key not properly Base64 encoded");
          console.log("[API-DEBUG]   2. Private key incorrect or mismatched");
          console.log("[API-DEBUG]   3. Account lacks permission for this endpoint");
          console.log("[API-DEBUG]   4. Wrong environment (sandbox vs production)");
          console.log("[API-DEBUG]   5. IP not whitelisted");
        }
        
        return response;
      } catch (error: unknown) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('API request timed out. Please try again.');
        }
        throw error;
      }
    },
    `${method} ${endpoint}`,
    (response: Response) => isRetryable(null, response.status)
  );
}

/**
 * Make authenticated GET request to Dr Green API with EMPTY OBJECT signing
 * Per official API docs: GET requests sign an empty object {} as payload
 * The signature is generated from JSON.stringify({}) = "{}"
 * 
 * Used for: All GET endpoints (both singular resource and list endpoints)
 * Includes automatic retry with exponential backoff for transient failures
 * 
 * @param endpoint - API endpoint path
 * @param queryParams - Query string parameters
 * @param enableDetailedLogging - Enable verbose logging
 * @param envConfig - Optional environment config (defaults to production)
 */
async function drGreenRequestGet(
  endpoint: string,
  queryParams: Record<string, string | number> = {},
  enableDetailedLogging = false,
  envConfig?: EnvConfig
): Promise<Response> {
  // Use provided env or default to production
  const env = envConfig || ENV_CONFIG.production;
  const { apiKey, privateKey: secretKey } = getEnvCredentials(env);
  
  if (enableDetailedLogging) {
    console.log("[API-DEBUG] ========== GET REQUEST (EMPTY OBJECT SIGNING) ==========");
    console.log("[API-DEBUG] Environment:", env.name);
    console.log("[API-DEBUG] API URL:", env.apiUrl);
    console.log("[API-DEBUG] Endpoint:", endpoint);
    console.log("[API-DEBUG] Query params:", JSON.stringify(queryParams));
    console.log("[API-DEBUG] API Key env var:", env.apiKeyEnv);
    console.log("[API-DEBUG] Private Key env var:", env.privateKeyEnv);
  }
  
  if (!apiKey || !secretKey) {
    throw new Error(`Dr Green API credentials not configured for ${env.name} (${env.apiKeyEnv}, ${env.privateKeyEnv})`);
  }
  
  // Validate API key format - should be Base64-encoded, not raw PEM
  if (apiKey.startsWith('-----BEGIN')) {
    console.error(`[API-ERROR] ${env.apiKeyEnv} contains raw PEM format. It should be Base64-encoded.`);
    throw new Error('API key misconfigured - contact administrator');
  }
  
  // Build query string for URL
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(queryParams)) {
    if (value !== undefined && value !== null && value !== '') {
      params.append(key, String(value));
    }
  }
  const queryString = params.toString();
  
  // Use secp256k1 ECDSA signing on query string (matches working drgreen-comparison approach)
  // For GET requests, sign the query string parameters
  const dataToSign = queryString || "";
  const signature = await generateSecp256k1Signature(dataToSign, secretKey);
  
  if (enableDetailedLogging) {
    console.log("[API-DEBUG] Signing method: secp256k1 ECDSA on query string");
    console.log("[API-DEBUG] Data being signed:", dataToSign);
    console.log("[API-DEBUG] Query string for URL:", queryString);
    console.log("[API-DEBUG] Signature length:", signature.length);
    console.log("[API-DEBUG] Signature prefix:", signature.slice(0, 16) + "...");
  }
  
  // Send the raw API key as-is (no PEM stripping)
  if (enableDetailedLogging) {
    console.log("[API-DEBUG] API Key: raw (no extractPemBody), length:", apiKey.length);
  }
  
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-auth-apikey": apiKey,
    "x-auth-signature": signature,
  };
  
  const url = queryString 
    ? `${env.apiUrl}${endpoint}?${queryString}`
    : `${env.apiUrl}${endpoint}`;
    
  logInfo(`API request: GET ${endpoint}`, { environment: env.name, hasQueryParams: !!queryString });
  
  // Wrap the fetch in retry logic
  return withRetry(
    async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
      
      try {
        const response = await fetch(url, {
          method: "GET",
          headers,
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);
        
        if (response.status === 401 && enableDetailedLogging) {
          console.log("[API-DEBUG] ========== GET 401 ANALYSIS ==========");
          console.log("[API-DEBUG] Environment:", env.name);
          console.log("[API-DEBUG] Status:", response.status);
          const errorBody = await response.clone().text();
          console.log("[API-DEBUG] Error body:", errorBody);
        }
        
        return response;
      } catch (error: unknown) {
        clearTimeout(timeoutId);
        if (error instanceof Error && error.name === 'AbortError') {
          throw new Error('API request timed out. Please try again.');
        }
        throw error;
      }
    },
    `GET ${endpoint}`,
    (response: Response) => isRetryable(null, response.status)
  );
}

// drGreenRequestQuery is now just an alias for drGreenRequestGet
const drGreenRequestQuery = drGreenRequestGet;

// ============================================================
// findClientById: List-and-filter workaround for GET /dapp/clients/{id}
// The API key lacks permission for the individual client endpoint (401),
// but GET /dapp/clients (list all) works. This helper fetches the full
// list and filters for the requested client ID.
// ============================================================
let _cachedClientList: any[] | null = null;
let _cacheExpiry = 0;
const CLIENT_LIST_CACHE_TTL = 5000; // 5 seconds

async function findClientById(clientId: string, envConfig?: EnvConfig): Promise<Response> {
  const now = Date.now();
  const env = envConfig || ENV_CONFIG.production;

  // Use cache if still valid
  if (_cachedClientList && now < _cacheExpiry) {
    logDebug('findClientById: using cached client list', { cacheSize: _cachedClientList.length });
    const client = _cachedClientList.find((c: any) => c.id === clientId);
    if (client) {
      return new Response(JSON.stringify({ success: true, data: client }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ success: false, message: 'Client not found', clientId }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // Paginated fetch — up to 3 pages (matching sync-client-by-email logic)
  const PAGE_SIZE = 200;
  const MAX_PAGES = 3;
  let allClients: any[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    logInfo(`findClientById: fetching page ${page}/${MAX_PAGES}`, { clientId, env: env.name });
    const listResponse = await drGreenRequestQuery('/dapp/clients', { take: PAGE_SIZE, page, orderBy: 'desc' }, false, env);

    if (!listResponse.ok) {
      logError('findClientById: client list fetch failed', { status: listResponse.status, page });
      break; // Stop pagination on error
    }

    const listData = await listResponse.json();

    // Handle all known response shapes
    let clients: any[] = [];
    if (Array.isArray(listData)) {
      clients = listData;
    } else if (Array.isArray(listData?.data)) {
      clients = listData.data;
    } else if (listData?.data?.items && Array.isArray(listData.data.items)) {
      clients = listData.data.items;
    } else if (Array.isArray(listData?.data?.data)) {
      clients = listData.data.data;
    } else if (Array.isArray(listData?.clients)) {
      clients = listData.clients;
    } else if (listData?.data?.clients && Array.isArray(listData.data.clients)) {
      clients = listData.data.clients;
    }

    if (!clients || clients.length === 0) {
      logInfo(`findClientById: no more clients on page ${page}`);
      break;
    }

    allClients.push(...clients);

    // Early exit if found on this page
    const match = clients.find((c: any) => c.id === clientId);
    if (match) {
      logInfo(`findClientById: found client on page ${page}`, { totalFetched: allClients.length });
      // Cache the full list we have so far
      _cachedClientList = allClients;
      _cacheExpiry = now + CLIENT_LIST_CACHE_TTL;
      return new Response(JSON.stringify({ success: true, data: match }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Stop if last page
    if (clients.length < PAGE_SIZE) {
      logInfo(`findClientById: last page reached (page ${page}, ${clients.length} clients)`);
      break;
    }
  }

  // Update cache with everything we fetched
  _cachedClientList = allClients;
  _cacheExpiry = now + CLIENT_LIST_CACHE_TTL;
  logInfo('findClientById: cached client list', { count: allClients.length });

  logWarn('findClientById: client not found after paginated search', { clientId, totalClients: allClients.length, pagesSearched: MAX_PAGES });
  return new Response(JSON.stringify({ success: false, message: 'Client not found', clientId }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Legacy request handler for backwards compatibility
 * Uses body signing for all requests
 */
async function drGreenRequest(
  endpoint: string,
  method: string,
  body?: object,
  envConfig?: EnvConfig
): Promise<Response> {
  return drGreenRequestBody(endpoint, method, body, false, envConfig);
}

serve(async (req) => {
  // ENTRY POINT LOGGING - Debug deployment and request routing
  console.log("[drgreen-proxy] ========== REQUEST RECEIVED ==========");
  console.log("[drgreen-proxy] Method:", req.method);
  console.log("[drgreen-proxy] URL:", req.url);
  console.log("[drgreen-proxy] Timestamp:", new Date().toISOString());
  
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    console.log("[drgreen-proxy] CORS preflight - returning 200");
    return new Response(null, { headers: corsHeaders });
  }
  
  try {
    const url = new URL(req.url);
    const pathParts = url.pathname.split("/").filter(Boolean);
    
    // Remove "drgreen-proxy" from path
    const apiPath = pathParts.slice(1).join("/");
    
    let body;
    if (req.method !== "GET" && req.method !== "HEAD") {
      try {
        body = await req.json();
        console.log("[drgreen-proxy] Request body action:", body?.action);
      } catch {
        body = undefined;
        console.log("[drgreen-proxy] No JSON body");
      }
    }
    
    // Route handling
    const action = body?.action || apiPath;
    console.log("[drgreen-proxy] Resolved action:", action);
    
    // Health check endpoint - verify deployment and secrets with enhanced validation
    if (action === 'health-check') {
      const apiKey = Deno.env.get("DRGREEN_API_KEY");
      const privateKey = Deno.env.get("DRGREEN_PRIVATE_KEY");
      const hasSupabaseUrl = !!Deno.env.get("SUPABASE_URL");
      const hasAnonKey = !!Deno.env.get("SUPABASE_ANON_KEY");
      
      // Enhanced credential validation
      const isApiKeyBase64 = apiKey ? /^[A-Za-z0-9+/=]+$/.test(apiKey) : false;
      let decodedApiKeyLength = 0;
      if (isApiKeyBase64 && apiKey) {
        try {
          decodedApiKeyLength = atob(apiKey).length;
        } catch {
          // Not valid base64
        }
      }
      
      console.log("[drgreen-proxy] Health check:", { 
        hasApiKey: !!apiKey, 
        hasPrivateKey: !!privateKey, 
        hasSupabaseUrl, 
        hasAnonKey,
        isApiKeyBase64,
        decodedApiKeyLength
      });
      
      const healthResult: Record<string, unknown> = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        secrets: {
          DRGREEN_API_KEY: apiKey ? 'configured' : 'MISSING',
          DRGREEN_PRIVATE_KEY: privateKey ? 'configured' : 'MISSING',
          SUPABASE_URL: hasSupabaseUrl ? 'configured' : 'MISSING',
          SUPABASE_ANON_KEY: hasAnonKey ? 'configured' : 'MISSING',
        },
        credentialValidation: {
          apiKeyPresent: !!apiKey,
          apiKeyLength: apiKey?.length || 0,
          apiKeyIsBase64: isApiKeyBase64,
          apiKeyDecodedLength: decodedApiKeyLength,
          apiKeyPrefix: apiKey ? apiKey.slice(0, 8) + '...' : 'N/A',
          privateKeyPresent: !!privateKey,
          privateKeyLength: privateKey?.length || 0,
          privateKeyPrefix: privateKey ? privateKey.slice(0, 4) + '...' : 'N/A',
        },
        allSecretsConfigured: !!apiKey && !!privateKey && hasSupabaseUrl && hasAnonKey,
        apiBaseUrl: DRGREEN_API_URL,
      };
      
      // Quick API connectivity test with /strains if credentials available
      if (apiKey && privateKey) {
        try {
          const testResponse = await drGreenRequestQuery("/strains", { take: 1 });
          healthResult.apiConnectivity = {
            endpoint: "GET /strains",
            status: testResponse.status,
            success: testResponse.ok,
          };
        } catch (e) {
          healthResult.apiConnectivity = {
            endpoint: "GET /strains",
            error: e instanceof Error ? e.message : 'Unknown error',
            success: false,
          };
        }
      }
      
      return new Response(JSON.stringify(healthResult, null, 2), { 
        status: 200, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }
    
    // Test environments - verify credentials work for production and railway
    if (action === 'test-staging' || action === 'test-environments') {
      console.log("[drgreen-proxy] Testing environment credentials...");
      
      const result: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        action: 'test-environments',
        environments: {} as Record<string, unknown>,
        tests: [] as Record<string, unknown>[],
      };
      
      // Helper to test an environment
      async function testEnvironment(envCfg: EnvConfig, envName: string) {
        const { apiKey, privateKey } = getEnvCredentials(envCfg);
        
        (result.environments as Record<string, unknown>)[envName] = {
          name: envCfg.name,
          apiUrl: envCfg.apiUrl,
          apiKeyConfigured: !!apiKey,
          privateKeyConfigured: !!privateKey,
          apiKeyLength: apiKey?.length || 0,
          apiKeyPrefix: apiKey ? apiKey.slice(0, 8) + '...' : 'N/A',
        };
        
        if (!apiKey || !privateKey) {
          (result.tests as Record<string, unknown>[]).push({
            environment: envName,
            endpoint: 'N/A',
            error: 'Credentials not configured',
            success: false,
          });
          return;
        }
        
        try {
          console.log(`[drgreen-proxy] Testing ${envName} GET /strains...`);
          const resp = await drGreenRequestGet("/strains", { take: 1, countryCode: 'ZAF' }, envName !== 'production', envCfg);
          const respBody = await resp.clone().text();
          
          (result.tests as Record<string, unknown>[]).push({
            environment: envName,
            endpoint: 'GET /strains',
            status: resp.status,
            success: resp.ok,
            responsePreview: respBody.slice(0, 300),
          });
          
          if (resp.ok) {
            try {
              console.log(`[drgreen-proxy] Testing ${envName} GET /dapp/clients...`);
              const clientsResp = await drGreenRequestGet("/dapp/clients", { take: 1 }, envName !== 'production', envCfg);
              const clientsBody = await clientsResp.clone().text();
              
              (result.tests as Record<string, unknown>[]).push({
                environment: envName,
                endpoint: 'GET /dapp/clients',
                status: clientsResp.status,
                success: clientsResp.ok,
                responsePreview: clientsBody.slice(0, 300),
              });
            } catch (e) {
              (result.tests as Record<string, unknown>[]).push({
                environment: envName,
                endpoint: 'GET /dapp/clients',
                error: e instanceof Error ? e.message : String(e),
                success: false,
              });
            }
          }
        } catch (e) {
          (result.tests as Record<string, unknown>[]).push({
            environment: envName,
            endpoint: 'GET /strains',
            error: e instanceof Error ? e.message : String(e),
            success: false,
          });
        }
      }
      
      // Test both environments
      for (const [envName, envCfg] of Object.entries(ENV_CONFIG)) {
        await testEnvironment(envCfg, envName);
      }
      
      // Summary per environment
      const envSummary = (envName: string) => {
        const tests = (result.tests as Record<string, unknown>[]).filter(t => t.environment === envName);
        const strainsTest = tests.find(t => t.endpoint === 'GET /strains');
        const clientsTest = tests.find(t => t.endpoint === 'GET /dapp/clients');
        const firstTestError = tests[0]?.error as string | undefined;
        return {
          configured: tests.length > 0 && !(firstTestError?.includes('not configured')),
          strainsWorking: strainsTest?.success === true,
          clientsWorking: clientsTest?.success === true,
        };
      };
      
      const summaries: Record<string, unknown> = {};
      for (const envName of Object.keys(ENV_CONFIG)) {
        summaries[envName] = envSummary(envName);
      }
      result.summary = summaries;
      
      return new Response(JSON.stringify(result, null, 2), { 
        status: 200, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }
    
    // API Diagnostics endpoint - comprehensive endpoint testing
    if (action === 'api-diagnostics') {
      const apiKey = Deno.env.get("DRGREEN_API_KEY");
      const privateKey = Deno.env.get("DRGREEN_PRIVATE_KEY");
      
      console.log("[API-DIAGNOSTICS] Starting comprehensive diagnostics...");
      
      const diagnostics: Record<string, unknown> = {
        timestamp: new Date().toISOString(),
        environment: {
          apiKeyPresent: !!apiKey,
          apiKeyLength: apiKey?.length || 0,
          apiKeyFormat: apiKey ? (/^[A-Za-z0-9+/=]+$/.test(apiKey) ? 'base64' : 'not-base64') : 'missing',
          apiKeyPrefix: apiKey ? apiKey.slice(0, 8) + '...' : 'N/A',
          privateKeyPresent: !!privateKey,
          privateKeyLength: privateKey?.length || 0,
          privateKeyPrefix: privateKey ? privateKey.slice(0, 4) + '...' : 'N/A',
          apiBaseUrl: DRGREEN_API_URL,
        },
        signatureTests: {},
        endpointTests: [] as Record<string, unknown>[],
      };
      
      if (apiKey && privateKey) {
        // Test signature generation with both modes
        const testPayload = JSON.stringify({ test: "diagnostic" });
        const testQueryString = "orderBy=desc&take=1&page=1";
        
        // Key analysis
        const privateKeyIsBase64 = isBase64(privateKey);
        let decodedKeyInfo = null;
        if (privateKeyIsBase64) {
          try {
            const decoded = base64ToBytes(privateKey);
            const decodedStr = new TextDecoder().decode(decoded);
            decodedKeyInfo = {
              decodedLength: decoded.length,
              startsWithBegin: decodedStr.startsWith("-----BEGIN"),
              preview: decodedStr.slice(0, 20) + "...",
            };
          } catch (e) {
            decodedKeyInfo = { error: "Failed to decode" };
          }
        }
        
        diagnostics.keyAnalysis = {
          privateKeyLength: privateKey.length,
          privateKeyIsBase64,
          decodedKeyInfo,
          signingMethod: "Private Key (RSA/EC) - per Dr Green API docs",
        };
        
        // Test signature generation with private key
        try {
          const signature = await signPayload(testPayload, privateKey);
          
          diagnostics.signatureTests = {
            privateKeySignature: {
              outputLength: signature.length,
              outputPrefix: signature.slice(0, 16) + '...',
              // RSA signatures are typically 256+ bytes (342+ base64 chars)
              // EC signatures are typically 64 bytes (88 base64 chars)
              // HMAC fallback is 32 bytes (44 base64 chars)
              likelyType: signature.length > 100 ? "RSA/EC (asymmetric)" : "HMAC (fallback)",
            },
          };
        } catch (e) {
          diagnostics.signatureTests = { error: e instanceof Error ? e.message : 'Unknown error' };
        }
        
        // Test GET /strains 
        console.log("[API-DIAGNOSTICS] Testing GET /strains...");
        try {
          const strainsResp = await drGreenRequestQuery("/strains", { take: 1 }, true);
          const strainsBody = await strainsResp.clone().text();
          (diagnostics.endpointTests as Record<string, unknown>[]).push({
            endpoint: "GET /strains",
            method: "Private Key Signing",
            status: strainsResp.status,
            success: strainsResp.ok,
            responsePreview: strainsBody.slice(0, 200),
          });
        } catch (e) {
          (diagnostics.endpointTests as Record<string, unknown>[]).push({
            endpoint: "GET /strains",
            method: "Private Key Signing",
            error: e instanceof Error ? e.message : 'Unknown error',
            success: false,
          });
        }
        
        // Test POST /dapp/clients 
        console.log("[API-DIAGNOSTICS] Testing POST /dapp/clients...");
        const testClientPayload = {
          transaction_metadata: { 
            source: "Healingbuds_Diagnostic_Test",
            timestamp: new Date().toISOString(),
          },
        };
        
        try {
          const clientResp = await drGreenRequestBody("/dapp/clients", "POST", testClientPayload, true);
          const clientBody = await clientResp.clone().text();
          (diagnostics.endpointTests as Record<string, unknown>[]).push({
            endpoint: "POST /dapp/clients",
            method: "Private Key Signing (per API docs)",
            status: clientResp.status,
            success: clientResp.ok,
            responsePreview: clientBody.slice(0, 300),
          });
        } catch (e) {
          (diagnostics.endpointTests as Record<string, unknown>[]).push({
            endpoint: "POST /dapp/clients",
            method: "Private Key Signing (per API docs)",
            error: e instanceof Error ? e.message : 'Unknown error',
            success: false,
          });
        }
        
        // Determine success based on tests
        const strainsTest = (diagnostics.endpointTests as Record<string, unknown>[]).find(
          t => t.endpoint === "GET /strains"
        );
        const clientTest = (diagnostics.endpointTests as Record<string, unknown>[]).find(
          t => t.endpoint === "POST /dapp/clients"
        );
        
        diagnostics.selectedMode = "Private Key (RSA/EC)";
        
        // Summary and recommendations
        diagnostics.summary = {
          readEndpointsWork: strainsTest?.success === true,
          writeEndpointWorks: clientTest?.success === true,
          signingMethod: "Private Key (RSA/EC) per API docs",
          selectedSigningMode: diagnostics.selectedMode,
          likelyIssue: 
            clientTest?.success 
              ? "SUCCESS: Private key signing works! Client creation is operational."
              : clientTest?.status === 401
              ? "SIGNATURE_INVALID: 401 Unauthorized - signature verification failed. Check private key format."
              : clientTest?.status === 403
              ? "PERMISSION_DENIED: 403 Forbidden - API credentials lack write permissions."
              : clientTest?.status === 422
              ? "PAYLOAD_VALIDATION: 422 - Auth works but payload structure needs adjustment."
              : "UNKNOWN_ERROR: Unexpected status code.",
          clientTestStatus: clientTest?.status,
          strainsTestStatus: strainsTest?.status,
          recommendations: [] as string[],
        };
        
        if (!clientTest?.success) {
          if (clientTest?.status === 401) {
            (diagnostics.summary as Record<string, unknown>).recommendations = [
              "Verify DRGREEN_PRIVATE_KEY is a valid Base64-encoded PEM/DER private key",
              "The key should be RSA or EC PKCS#8 format",
              "Check if the private key matches the public key registered with Dr. Green",
            ];
          } else if (clientTest?.status === 403) {
            (diagnostics.summary as Record<string, unknown>).recommendations = [
              "Contact Dr. Green NFT API administrator",
              "Verify your account has permission for POST /dapp/clients",
              "Check if IP whitelisting is required",
            ];
          } else if (clientTest?.status === 422) {
            (diagnostics.summary as Record<string, unknown>).recommendations = [
              "Auth is working! Payload validation failed.",
              "Check the response body for specific field errors.",
              "Update the payload structure to match API requirements.",
            ];
          }
        }
      } else {
        diagnostics.summary = {
          error: "Missing credentials",
          recommendations: ["Configure DRGREEN_API_KEY and DRGREEN_PRIVATE_KEY secrets"],
        };
      }
      
      console.log("[API-DIAGNOSTICS] Complete:", JSON.stringify(diagnostics.summary));
      
      return new Response(JSON.stringify(diagnostics, null, 2), { 
        status: 200, 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }
    
    logInfo(`Processing action: ${action}`, { method: req.method });

    // ==========================================
    // AUTHENTICATION & AUTHORIZATION CHECK
    // ==========================================
    
    // Check if action is public (no auth required)
    const isPublicAction = PUBLIC_ACTIONS.includes(action);
    
    // Check if action is country-gated (open countries don't require auth)
    const isCountryGatedAction = COUNTRY_GATED_ACTIONS.includes(action);
    
    // Check if action only requires authentication (no ownership check)
    const isAuthOnlyAction = AUTH_ONLY_ACTIONS.includes(action);
    
    // Hoisted auth variables - accessible in route handlers below
    let authenticatedUser: any = null;
    let supabaseClient: any = null;
    
    // Handle country-gated actions (strains)
    // IMPORTANT: For open countries (ZAF, THA), skip ALL auth checks completely.
    // Even if client sends an invalid/expired JWT, we ignore it for open country browsing.
    if (isCountryGatedAction) {
      const countryCode = (body?.countryCode || '').toString().toUpperCase().trim();
      
      // Validate country code input
      if (countryCode && !validateCountryCode(countryCode)) {
        return new Response(
          JSON.stringify({ error: 'Invalid country code' }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      const isOpenCountry = countryCode && OPEN_COUNTRIES.includes(countryCode);
      
      if (isOpenCountry) {
        // Open countries (ZAF, THA) bypass auth entirely - no JWT validation at all
        logInfo(`Public access granted to ${action} for open country: ${countryCode}`);
        // Continue to route processing without any authentication check
      } else {
        // Restricted countries (GBR, PRT) or missing country require valid auth
        const authResult = await verifyAuthentication(req);
        
        if (!authResult) {
          logWarn(`Auth required for ${action}`);
          return new Response(
            JSON.stringify({ 
              error: 'Authentication required. Please sign in to view products in your region.',
              code: 401
            }),
            { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        logInfo(`Authenticated user accessing ${action}`);
      }
    } else if (!isPublicAction) {
      // All non-country-gated, non-public actions require authentication
      const authResult = await verifyAuthentication(req);
      
      if (!authResult) {
        logWarn(`Unauthenticated request to ${action}`);
        return new Response(
          JSON.stringify({ error: 'Authentication required' }),
          { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Hoist user and supabaseClient so they're accessible in route handlers below
      authenticatedUser = authResult.user;
      supabaseClient = authResult.supabaseClient;

      // Check admin role for admin-only endpoints
      if (ADMIN_ACTIONS.includes(action)) {
        const hasAdminRole = await isAdmin(supabaseClient, authenticatedUser.id);
        
        if (!hasAdminRole) {
          logWarn(`Non-admin attempted to access ${action}`);
          return new Response(
            JSON.stringify({ error: 'Admin access required' }),
            { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        logInfo(`Admin accessed ${action}`);
      }

      // Verify resource ownership for client-specific operations
      if (OWNERSHIP_ACTIONS.includes(action)) {
        const clientId = body?.clientId || body?.data?.clientId;
        
        if (clientId) {
          // Validate clientId input
          if (!validateClientId(clientId)) {
            return new Response(
              JSON.stringify({ error: 'Invalid client ID format' }),
              { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
          
          // Check ownership or admin status
          const ownsResource = await verifyClientOwnership(supabaseClient, authenticatedUser.id, clientId);
          
          if (!ownsResource) {
            const hasAdminRole = await isAdmin(supabaseClient, authenticatedUser.id);
            
            if (!hasAdminRole) {
              logWarn(`User attempted unauthorized access`);
              return new Response(
                JSON.stringify({ error: 'Access denied' }),
                { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
              );
            }
          }
        }
      }

      // Special case: create-client-legacy and create-client don't require ownership 
      // (new client creation) but do require authentication
      if (action === 'create-client-legacy' || action === 'create-client') {
        logInfo(`User creating new client`);
      }
    }

    // ==========================================
    // ROUTE PROCESSING
    // ==========================================
    
    // Extract requested environment from body (supports production and railway)
    const requestedEnv = body?.env as string | undefined;

    // SAFETY GUARD: Whitelist approach — only explicitly listed admin debug actions
    // may use the railway (staging) environment. Everything else ALWAYS uses production.
    // This means localStorage env selector can never poison patient-facing flows.
    const ADMIN_DEBUG_ONLY_ACTIONS = [
      'dapp-clients', 'dapp-client-details', 'dapp-orders', 'dapp-order-details',
      'dapp-update-order', 'dapp-strains', 'dapp-carts', 'dapp-nfts',
      'dashboard-summary', 'dashboard-analytics', 'sales-summary',
      'get-sales', 'get-sales-summary', 'get-clients-summary',
      'sync-client-status', 'dapp-verify-client', 'dapp-clients-list',
      'admin-list-all-clients', 'delete-client', 'patch-client',
      'activate-client', 'deactivate-client', 'bulk-delete-clients',
      'admin-update-shipping-address', 'admin-reregister-client',
      'get-client-orders', 'get-user-nfts', 'get-user-me',
    ];
    const isAdminDebugAction = ADMIN_DEBUG_ONLY_ACTIONS.includes(action);
    // Force production for ALL non-admin actions, regardless of requested env
    const effectiveEnv = isAdminDebugAction ? (requestedEnv || 'production') : 'production';
    if (!isAdminDebugAction && requestedEnv && requestedEnv !== 'production') {
      console.warn(`[drgreen-proxy] SAFETY: Forcing production for action "${action}" (requested: ${requestedEnv}). Non-admin actions always use production.`);
    }

    const envConfig = getEnvironment(effectiveEnv);
    // All actions use the same credentials per environment — no separate write keys
    const adminEnvConfig = envConfig; // Alias for backwards compatibility
    if (requestedEnv) {
      console.log(`[drgreen-proxy] Using environment: ${envConfig.name} (effective: ${effectiveEnv})`);
    }
    
    let response: Response;
    
    switch (action) {
      // ==========================================
      // LEGACY WORDPRESS-COMPATIBLE ENDPOINTS
      // ==========================================
      
      // Create client with legacy payload format - exact Dr. Green API schema
      // Per API docs: POST /dapp/clients with exact field structure
      case "create-client-legacy": {
        console.log("[create-client-legacy] ========== STARTING HANDLER ==========");
        console.log("[create-client-legacy] Request received at:", new Date().toISOString());
        console.log("[create-client-legacy] Has body.payload:", !!body?.payload);
        console.log("[create-client-legacy] Payload keys:", body?.payload ? Object.keys(body.payload) : "none");
        
        const legacyPayload = body?.payload;
        if (!legacyPayload) {
          console.log("[create-client-legacy] ERROR: No payload provided");
          throw new Error("Payload is required for client creation");
        }
        console.log("[create-client-legacy] Payload validation passed, proceeding with email:", legacyPayload.email?.slice(0, 3) + "***");
        
        // Validate required fields
        if (!validateEmail(legacyPayload.email)) {
          throw new Error("Invalid email format");
        }
        if (!validateStringLength(legacyPayload.firstName, 100) || !validateStringLength(legacyPayload.lastName, 100)) {
          throw new Error("Name fields exceed maximum length");
        }
        
        // Extract nested objects from legacy payload
        const shipping = legacyPayload.shipping || {};
        const medicalRecord = legacyPayload.medicalRecord || {};
        
        // Build EXACT payload structure per Dr. Green API documentation
        // Required fields only - omit optional fields if empty/undefined
        const dappPayload: Record<string, unknown> = {
          // Required personal fields
          firstName: String(legacyPayload.firstName || "").trim(),
          lastName: String(legacyPayload.lastName || "").trim(),
          email: String(legacyPayload.email || "").toLowerCase().trim(),
          phoneCode: String(legacyPayload.phoneCode || "+351"),
          phoneCountryCode: String(legacyPayload.phoneCountryCode || "PT").toUpperCase(),
          contactNumber: String(legacyPayload.contactNumber || ""),
          
          // Required shipping object (with required fields)
          shipping: {
            address1: String(shipping.address1 || "").trim(),
            address2: String(shipping.address2 || "").trim(), // API requires this as string, even if empty
            city: String(shipping.city || "").trim(),
            state: String(shipping.state || shipping.city || "").trim(),
            country: String(shipping.country || "Portugal").trim(),
            countryCode: String(shipping.countryCode || "PRT").toUpperCase(),
            postalCode: String(shipping.postalCode || "").trim(),
            landmark: String(shipping.landmark || "").trim(), // API may require this as string too
          } as Record<string, string>,
          
          // Required medicalRecord object
          medicalRecord: {
            dob: String(medicalRecord.dob || ""),
            gender: String(medicalRecord.gender || "prefer_not_to_say"),
            // Required boolean flags (medicalHistory 0-4, 8-10, 12)
            medicalHistory0: medicalRecord.medicalHistory0 === true,
            medicalHistory1: medicalRecord.medicalHistory1 === true,
            medicalHistory2: medicalRecord.medicalHistory2 === true,
            medicalHistory3: medicalRecord.medicalHistory3 === true,
            medicalHistory4: medicalRecord.medicalHistory4 === true,
            medicalHistory8: medicalRecord.medicalHistory8 === true,
            medicalHistory9: medicalRecord.medicalHistory9 === true,
            medicalHistory10: medicalRecord.medicalHistory10 === true,
            medicalHistory12: medicalRecord.medicalHistory12 === true,
            // Required array fields
            medicalHistory5: Array.isArray(medicalRecord.medicalHistory5) && medicalRecord.medicalHistory5.length > 0
              ? medicalRecord.medicalHistory5
              : ["none"],
            medicalHistory14: Array.isArray(medicalRecord.medicalHistory14) && medicalRecord.medicalHistory14.length > 0
              ? medicalRecord.medicalHistory14
              : ["never"],
            // Required string fields
            medicalHistory13: String(medicalRecord.medicalHistory13 || "never").toLowerCase(),
          } as Record<string, unknown>,
        };
        
        // Add optional medicalRecord fields only if present
        const mr = dappPayload.medicalRecord as Record<string, unknown>;
        
        // medicalConditions array (optional)
        if (Array.isArray(medicalRecord.medicalConditions) && medicalRecord.medicalConditions.length > 0) {
          mr.medicalConditions = medicalRecord.medicalConditions;
        }
        // otherMedicalCondition string (optional)
        if (medicalRecord.otherMedicalCondition && String(medicalRecord.otherMedicalCondition).trim()) {
          mr.otherMedicalCondition = String(medicalRecord.otherMedicalCondition).trim();
        }
        // medicinesTreatments array (optional)
        if (Array.isArray(medicalRecord.medicinesTreatments) && medicalRecord.medicinesTreatments.length > 0) {
          mr.medicinesTreatments = medicalRecord.medicinesTreatments;
        }
        // otherMedicalTreatments string (optional)
        if (medicalRecord.otherMedicalTreatments && String(medicalRecord.otherMedicalTreatments).trim()) {
          mr.otherMedicalTreatments = String(medicalRecord.otherMedicalTreatments).trim();
        }
        // medicalHistory6 boolean (optional)
        if (medicalRecord.medicalHistory6 !== undefined) {
          mr.medicalHistory6 = medicalRecord.medicalHistory6 === true;
        }
        // medicalHistory7 array (optional)
        if (Array.isArray(medicalRecord.medicalHistory7) && medicalRecord.medicalHistory7.length > 0) {
          mr.medicalHistory7 = medicalRecord.medicalHistory7;
          // medicalHistory7Relation is only included if medicalHistory7 exists and doesn't contain "none"
          const hasNone = medicalRecord.medicalHistory7.some((v: string) => 
            String(v).toLowerCase() === 'none'
          );
          if (!hasNone && medicalRecord.medicalHistory7Relation) {
            mr.medicalHistory7Relation = String(medicalRecord.medicalHistory7Relation);
          }
        }
        // medicalHistory11 string (optional - alcohol units)
        if (medicalRecord.medicalHistory11 && String(medicalRecord.medicalHistory11) !== '0') {
          mr.medicalHistory11 = String(medicalRecord.medicalHistory11);
        }
        // medicalHistory15 string (optional - cannabis amount)
        if (medicalRecord.medicalHistory15 && String(medicalRecord.medicalHistory15).trim()) {
          mr.medicalHistory15 = String(medicalRecord.medicalHistory15).trim();
        }
        // medicalHistory16 boolean (optional - cannabis reaction)
        if (medicalRecord.medicalHistory16 !== undefined) {
          mr.medicalHistory16 = medicalRecord.medicalHistory16 === true;
        }
        // prescriptionsSupplements string (optional)
        if (medicalRecord.prescriptionsSupplements && String(medicalRecord.prescriptionsSupplements).trim()) {
          mr.prescriptionsSupplements = String(medicalRecord.prescriptionsSupplements).trim();
        }
        
        // Add clientBusiness only if provided (entire object is optional)
        if (legacyPayload.clientBusiness && legacyPayload.clientBusiness.name) {
          const cb = legacyPayload.clientBusiness;
          const clientBusiness: Record<string, string> = {};
          
          // Add only non-empty business fields
          if (cb.businessType) clientBusiness.businessType = String(cb.businessType);
          if (cb.name) clientBusiness.name = String(cb.name);
          if (cb.address1) clientBusiness.address1 = String(cb.address1);
          if (cb.address2) clientBusiness.address2 = String(cb.address2);
          if (cb.landmark) clientBusiness.landmark = String(cb.landmark);
          if (cb.city) clientBusiness.city = String(cb.city);
          if (cb.state) clientBusiness.state = String(cb.state);
          if (cb.country) clientBusiness.country = String(cb.country);
          if (cb.countryCode) clientBusiness.countryCode = String(cb.countryCode);
          if (cb.postalCode) clientBusiness.postalCode = String(cb.postalCode);
          
          if (Object.keys(clientBusiness).length > 0) {
            dappPayload.clientBusiness = clientBusiness;
          }
        }
        
        // Enhanced logging for debugging
        console.log("[create-client-legacy] ========== CLIENT CREATION START ==========");
        console.log("[create-client-legacy] Timestamp:", new Date().toISOString());
        console.log("[create-client-legacy] API credentials check:", {
          hasApiKey: !!Deno.env.get("DRGREEN_API_KEY"),
          hasPrivateKey: !!Deno.env.get("DRGREEN_PRIVATE_KEY"),
          apiKeyLength: Deno.env.get("DRGREEN_API_KEY")?.length || 0,
          privateKeyLength: Deno.env.get("DRGREEN_PRIVATE_KEY")?.length || 0,
        });
        console.log("[create-client-legacy] Payload structure keys:", Object.keys(dappPayload));
        console.log("[create-client-legacy] Shipping keys:", Object.keys(dappPayload.shipping as object));
        console.log("[create-client-legacy] MedicalRecord keys:", Object.keys(dappPayload.medicalRecord as object));
        console.log("[create-client-legacy] Has clientBusiness:", !!dappPayload.clientBusiness);
        console.log("[create-client-legacy] Payload (sanitized):", JSON.stringify({
          ...dappPayload,
          email: (dappPayload.email as string)?.slice(0, 5) + '***',
          contactNumber: '***',
        }, null, 2).slice(0, 1500));
        
        logInfo("Creating client with exact API payload structure", {
          hasApiKey: !!Deno.env.get("DRGREEN_API_KEY"),
          hasPrivateKey: !!Deno.env.get("DRGREEN_PRIVATE_KEY"),
          countryCode: (dappPayload.shipping as Record<string, string>).countryCode,
          hasClientBusiness: !!dappPayload.clientBusiness,
        });
        
        // Use write-enabled credentials for client creation
        console.log("[create-client-legacy] Using environment:", envConfig.name, `(${envConfig.apiKeyEnv})`);
        
        // Call API with detailed logging enabled
        response = await drGreenRequestBody("/dapp/clients", "POST", dappPayload, true, envConfig);
        
        // Log response details for debugging
        const clonedResp = response.clone();
        const respBody = await clonedResp.text();
        
        console.log("[create-client-legacy] ========== API RESPONSE ==========");
        console.log("[create-client-legacy] Status:", response.status);
        console.log("[create-client-legacy] StatusText:", response.statusText);
        console.log("[create-client-legacy] Headers:", JSON.stringify(Object.fromEntries(response.headers.entries())));
        console.log("[create-client-legacy] Body:", respBody.slice(0, 500));
        
        logInfo("Client creation API response", {
          status: response.status,
          statusText: response.statusText,
          bodyPreview: respBody.slice(0, 300),
        });
        
        if (!response.ok) {
          console.log("[create-client-legacy] ========== ERROR ANALYSIS ==========");
          console.log("[create-client-legacy] Error status:", response.status);
          console.log("[create-client-legacy] Full error body:", respBody);
          
          // Handle 409 Conflict: client email already exists
          // Instead of failing, fetch the existing client and return their details
          if (response.status === 409) {
            console.log("[create-client-legacy] DIAGNOSIS: Client email already exists - attempting to fetch existing client");
            
            try {
              const parsedError = JSON.parse(respBody);
              const clientEmail = String(dappPayload.email).toLowerCase().trim();
              
              // Try to find existing client in local DB by email
              const { data: existingClient } = await supabaseClient
                .from('drgreen_clients')
                .select('*')
                .eq('email', clientEmail)
                .maybeSingle();
              
              if (existingClient) {
                console.log("[create-client-legacy] Found existing local client record:", existingClient.drgreen_client_id?.slice(0, 8) + '***');
                return new Response(JSON.stringify({
                  success: true,
                  clientId: existingClient.drgreen_client_id,
                  kycLink: existingClient.kyc_link,
                  isKYCVerified: existingClient.is_kyc_verified || false,
                  adminApproval: existingClient.admin_approval || 'PENDING',
                  alreadyExists: true,
                  message: 'Client already registered. Returning existing record.',
                }), {
                  status: 200,
                  headers: { ...corsHeaders, "Content-Type": "application/json" },
                });
              }
              
              // No local record but API says email exists - return helpful message
              console.log("[create-client-legacy] No local record found for existing API client");
              return new Response(JSON.stringify({
                success: false,
                alreadyExists: true,
                message: 'This email is already registered with Dr. Green. Please contact support if you need to recover your account.',
                errorCode: 409,
              }), {
                status: 200,
                headers: { ...corsHeaders, "Content-Type": "application/json" },
              });
            } catch (conflictErr) {
              console.log("[create-client-legacy] Error handling 409 conflict:", conflictErr);
            }
          }
          
          if (response.status === 401) {
            console.log("[create-client-legacy] DIAGNOSIS: Authentication failed - signature mismatch or invalid API key");
          } else if (response.status === 422) {
            console.log("[create-client-legacy] DIAGNOSIS: Validation error - payload structure mismatch");
            console.log("[create-client-legacy] Check: field names, required fields, option values");
          } else if (response.status === 403) {
            console.log("[create-client-legacy] DIAGNOSIS: Permission denied - account lacks access");
          }
          
          logError("Client creation failed", {
            status: response.status,
            body: respBody.slice(0, 500),
          });
        } else {
          console.log("[create-client-legacy] SUCCESS: Client created successfully");
          
          // Parse and normalize the response for frontend consumption
          try {
            const rawData = JSON.parse(respBody);
            
            console.log("[create-client-legacy] Raw response keys:", Object.keys(rawData));
            
            // Extract clientId and kycLink from various possible response structures
            const normalizedResponse = {
              success: true,
              clientId: rawData.client?.id || rawData.data?.id || rawData.clientId || rawData.client_id || rawData.id,
              kycLink: rawData.client?.kycLink || rawData.client?.kyc_link || rawData.data?.kycLink || rawData.data?.kyc_link || rawData.kycLink || rawData.kyc_link,
              isKYCVerified: rawData.client?.isKYCVerified || rawData.client?.is_kyc_verified || rawData.data?.isKYCVerified || rawData.isKYCVerified || rawData.is_kyc_verified || false,
              adminApproval: rawData.client?.adminApproval || rawData.client?.admin_approval || rawData.data?.adminApproval || rawData.adminApproval || rawData.admin_approval || null,
              raw: rawData,
            };
            
            console.log("[create-client-legacy] Extracted clientId:", normalizedResponse.clientId || 'NOT FOUND');
            console.log("[create-client-legacy] Extracted kycLink:", normalizedResponse.kycLink ? 'PRESENT' : 'NOT FOUND');
            
            logInfo("Client creation normalized response", {
              hasClientId: !!normalizedResponse.clientId,
              hasKycLink: !!normalizedResponse.kycLink,
            });
            
            // Return normalized response directly
            return new Response(JSON.stringify(normalizedResponse), {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          } catch (parseError) {
            console.log("[create-client-legacy] Failed to parse response:", parseError);
            // Fall through to default response handling
          }
        }
        
        break;
      }
      
      // Get strains list with query signing (Method B - Query Sign)
      // IMPORTANT: Uses a short 8s timeout with NO retries to prevent the edge function
      // from hanging for 60s+ (3 retries × 20s = silent death). The client-side
      // Promise.race at 15s catches failures cleanly with a "Try Again" button.
      case "get-strains-legacy": {
        const { countryCode, orderBy, take, page } = body || {};
        
        // Validate pagination
        if (!validatePagination(page, take)) {
          throw new Error("Invalid pagination parameters");
        }
        
        const queryParams: Record<string, string | number> = {
          orderBy: orderBy || 'desc',
          take: take || 10,
          page: page || 1,
        };
        if (countryCode) queryParams.countryCode = countryCode;
        
        // Build signed URL directly with a short 8-second timeout (no retries)
        // so the function returns before Deno's 60s wall-clock limit
        const STRAINS_TIMEOUT_MS = 8000;
        const env = envConfig || ENV_CONFIG.production;
        const { apiKey: strainsApiKey, privateKey: strainsPrivKey } = getEnvCredentials(env);
        
        if (!strainsApiKey || !strainsPrivKey) {
          throw new Error("API credentials not configured for strains fetch");
        }
        
        // Build signed query string
        const queryEntries = Object.entries(queryParams)
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
          .join('&');
        const strainsSignature = await signQueryString(queryEntries, strainsPrivKey);
        const strainsUrl = `${env.apiUrl}/strains?${queryEntries}`;
        
        const strainsController = new AbortController();
        const strainsTimeoutId = setTimeout(() => strainsController.abort(), STRAINS_TIMEOUT_MS);
        
        try {
          response = await fetch(strainsUrl, {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              "x-auth-apikey": strainsApiKey,
              "x-auth-signature": strainsSignature,
            },
            signal: strainsController.signal,
          });
        } catch (strainsErr: unknown) {
          if (strainsErr instanceof Error && strainsErr.name === 'AbortError') {
            throw new Error('Strains API timed out after 8s. Please try again.');
          }
          throw strainsErr;
        } finally {
          clearTimeout(strainsTimeoutId);
        }
        break;
      }
      
      // Get cart with query signing (Method B - Query Sign)
      case "get-cart-legacy": {
        const { clientId, orderBy, take, page } = body || {};
        if (!clientId) throw new Error("clientId is required");
        
        // Validate inputs
        if (!validateClientId(clientId)) {
          throw new Error("Invalid client ID format");
        }
        if (!validatePagination(page, take)) {
          throw new Error("Invalid pagination parameters");
        }
        
        const queryParams: Record<string, string | number> = {
          orderBy: orderBy || 'desc',
          take: take || 10,
          page: page || 1,
          clientId: clientId,
        };
        
        response = await drGreenRequestQuery("/carts", queryParams);
        break;
      }
      
      // NOTE: add-to-cart is defined later in the switch statement (around line 2163)
      // with proper payload formatting (clientId, productId)
      
      
      // Remove from cart (Method A - Body Sign for signature, query for strainId) - uses /dapp/carts endpoint
      case "remove-from-cart": {
        const { cartId, strainId } = body || {};
        if (!cartId || !strainId) throw new Error("cartId and strainId are required");
        
        // Validate inputs
        if (!validateStringLength(cartId, 100) || !validateStringLength(strainId, 100)) {
          throw new Error("Invalid ID format");
        }
        
        // Sign the JSON payload with secp256k1 using write credentials
        const signPayloadData = { cartId };
        const payloadStr = JSON.stringify(signPayloadData);
        const writeEnv = envConfig;
        const { apiKey: writeApiKey, privateKey: writePrivKey } = getEnvCredentials(writeEnv);
        if (!writeApiKey || !writePrivKey) {
          throw new Error(`Write credentials not configured for remove-from-cart (${writeEnv.apiKeyEnv})`);
        }
        const signature = await generateSecp256k1Signature(payloadStr, writePrivKey);
        
        const apiKey = writeApiKey;
        const apiUrl = `${writeEnv.apiUrl}/dapp/carts/${cartId}?strainId=${strainId}`;
        
        logInfo(`Removing item from cart via /dapp/carts endpoint`);
        
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
        
        response = await fetch(apiUrl, {
          method: "DELETE",
          headers: {
            "Content-Type": "application/json",
            "x-auth-apikey": apiKey,
            "x-auth-signature": signature,
          },
          body: payloadStr,
          signal: controller.signal,
        });
        
        clearTimeout(timeoutId);
        break;
      }
      
      // NOTE: "empty-cart" and "place-order" are defined later in the switch
      // with more complete implementations (around lines 2707-2733).
      // Duplicate first-definitions removed to let the correct ones execute.
      
      // ==========================================
      // DAPP ADMIN ENDPOINTS
      // ==========================================
      
      case "dashboard-summary": {
        // Use query string signing for GET endpoint (fixes 401)
        response = await drGreenRequestQuery("/dapp/dashboard/summary", {}, false, adminEnvConfig);
        break;
      }
      
      case "dashboard-analytics": {
        const { startDate, endDate, filterBy, orderBy } = body || {};
        const queryParams: Record<string, string | number> = {
          orderBy: orderBy || 'asc',
        };
        if (startDate) queryParams.startDate = startDate;
        if (endDate) queryParams.endDate = endDate;
        if (filterBy) queryParams.filterBy = filterBy;
        // Use query string signing for GET with params (fixes 401)
        response = await drGreenRequestQuery("/dapp/dashboard/analytics", queryParams, false, adminEnvConfig);
        break;
      }
      
      case "sales-summary": {
        // Use query string signing for GET endpoint (fixes 401)
        response = await drGreenRequestQuery("/dapp/sales/summary", {}, false, adminEnvConfig);
        break;
      }
      
      case "dapp-clients": {
        const { page, take, orderBy, search, searchBy, status, kyc, adminApproval } = body || {};
        
        if (!validatePagination(page, take)) {
          throw new Error("Invalid pagination parameters");
        }
        
        // Build query params object for proper signing
        const queryParams: Record<string, string | number> = {
          orderBy: orderBy || 'desc',
          take: take || 10,
          page: page || 1,
        };
        if (search) queryParams.search = String(search).slice(0, 100);
        if (searchBy) queryParams.searchBy = searchBy;
        if (status) queryParams.status = status;
        if (kyc !== undefined) queryParams.kyc = String(kyc);
        if (adminApproval) queryParams.adminApproval = adminApproval;
        
        // Use query string signing for GET with params (fixes 401)
        response = await drGreenRequestQuery("/dapp/clients", queryParams, false, adminEnvConfig);
        break;
      }
      
      case "dapp-client-details": {
        const { clientId } = body || {};
        if (!clientId) throw new Error("clientId is required");
        if (!validateClientId(clientId)) throw new Error("Invalid client ID format");
        // Use list-and-filter helper (GET /dapp/clients/{id} returns 401)
        response = await findClientById(clientId, adminEnvConfig);
        break;
      }
      
      // User fetching their own client details (ownership verified via clientId match)
      // This endpoint has SPECIAL HANDLING to pull shipping from DApp API
      // Strategy: 1) Try direct /dapp/clients/:id (has shippings[]), 2) fallback to list search, 3) local DB
      case "get-my-details": {
        const clientId = body.clientId || body.data?.clientId;
        if (!clientId) {
          throw new Error("clientId is required");
        }
        if (!validateClientId(clientId)) {
          throw new Error("Invalid client ID format");
        }
        
        // Always load local client as fallback
        const supabaseAdmin = createClient(
          Deno.env.get('SUPABASE_URL')!,
          Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
        );
        
        const { data: localClient } = await supabaseAdmin
          .from('drgreen_clients')
          .select('*')
          .eq('drgreen_client_id', clientId)
          .maybeSingle();
        
        let apiData: Record<string, unknown> | null = null;
        
        // Strategy 1: Try direct individual endpoint GET /dapp/clients/:clientId
        // This endpoint returns full client data including shippings[] array
        try {
          const directResponse = await drGreenRequestQuery(`/dapp/clients/${clientId}`, {}, false, adminEnvConfig);
          if (directResponse.ok) {
            const directData = await directResponse.json() as Record<string, unknown>;
            logInfo("Got client details from direct endpoint", { clientId });
            apiData = directData;
          } else {
            logInfo("Direct client endpoint returned non-200, trying list fallback", { clientId, status: directResponse.status });
          }
        } catch (directErr) {
          logWarn("Direct client endpoint failed, trying list fallback", {
            error: directErr instanceof Error ? directErr.message : 'Unknown'
          });
        }

        // Strategy 2: Fallback — find client via paginated list (list lacks shippings but has base data)
        if (!apiData) {
          try {
            const listResponse = await findClientById(clientId, adminEnvConfig);
            if (listResponse.ok) {
              apiData = await listResponse.json() as Record<string, unknown>;
              logInfo("Got client details from list fallback", { clientId });
            } else {
              logInfo("List fallback also failed, using local DB", { clientId, status: listResponse.status });
            }
          } catch (listErr) {
            logWarn("List fallback failed", { error: listErr instanceof Error ? listErr.message : 'Unknown' });
          }
        }
        
        // Normalize shippings[] -> shipping{} in API data
        if (apiData) {
          const innerData = (apiData.data as Record<string, unknown> | undefined) || apiData;
          if (Array.isArray(innerData.shippings) && (innerData.shippings as unknown[]).length > 0) {
            innerData.shipping = normalizeShippingObject((innerData.shippings as Record<string, unknown>[])[0]);
            logInfo("Normalized shippings[] to shipping{} from DApp API", { clientId });
          }
          // Only merge local DB shipping if DApp returned NO real address data at all.
          // This prevents stale local data from contaminating a valid (but empty) DApp shippings[].
          const dappHasAddress = !!(innerData.shipping as Record<string, unknown> | undefined)?.address1 ||
            (Array.isArray(innerData.shippings) && (innerData.shippings as Record<string, unknown>[]).some((s) => s?.address1));
          logInfo("DApp address check", { clientId, dappHasAddress });
          if (!dappHasAddress && (localClient?.shipping_address as Record<string, unknown> | null)?.address1) {
            const localShip = localClient!.shipping_address as Record<string, unknown>;
            innerData.shipping = normalizeShippingObject(localShip);
            logInfo("Merged local DB shipping into API response (DApp has no address)", { clientId });
          }
          if (apiData.data) {
            return new Response(JSON.stringify(apiData), {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
          return new Response(JSON.stringify({ success: true, data: innerData }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        
        // Fall back to local client data
        if (localClient) {
          // Use shipping_address from local DB if available
          const localShipping = localClient.shipping_address as Record<string, unknown> | null;
          
          // Build a response that matches what the checkout expects
          const fallbackResponse = {
            id: localClient.drgreen_client_id,
            clientId: localClient.drgreen_client_id,
            email: localClient.email,
            fullName: localClient.full_name,
            firstName: localClient.full_name?.split(' ')[0] || '',
            lastName: localClient.full_name?.split(' ').slice(1).join(' ') || '',
            isKYCVerified: localClient.is_kyc_verified || false,
            adminApproval: localClient.admin_approval || 'PENDING',
            countryCode: localClient.country_code,
            kycLink: localClient.kyc_link,
            // Use local shipping_address if available
            shipping: localShipping,
            _source: 'local_fallback',
            _note: localShipping 
              ? 'Using locally stored shipping address.' 
              : 'Dr. Green API access restricted. Shipping address may need to be entered.',
          };
          
          logInfo("Returning local client data as fallback", { 
            clientId: localClient.drgreen_client_id,
            hasEmail: !!localClient.email,
            hasLocalShipping: !!localShipping,
          });
          
          return new Response(JSON.stringify(fallbackResponse), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        
        // No data anywhere
        logWarn("Client not found in API or local DB", { clientId });
        return new Response(
          JSON.stringify({ 
            error: 'Client not found', 
            clientId,
            message: 'Could not fetch client details from API or local database.' 
          }),
          { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      case "dapp-verify-client": {
        // DEPRECATED: The Dr. Green API does NOT support external approval/rejection.
        // The only documented PATCH endpoints are /activate and /deactivate (for isActive status).
        // Client adminApproval can ONLY be changed within the Dr. Green DApp admin panel.
        // Webhooks (client.approved, client.rejected) notify us when status changes.
        throw new Error(
          "Client approval/rejection is not supported via API. " +
          "Please approve clients directly in the Dr. Green DApp admin portal. " +
          "Use the 'Sync Status' feature to refresh local data."
        );
      }
      
      // Sync client status - fetches live data from Dr. Green API
      case "sync-client-status": {
        const { clientId } = body || {};
        if (!clientId) throw new Error("clientId is required");
        if (!validateClientId(clientId)) throw new Error("Invalid client ID format");
        
        // Use list-and-filter helper (GET /dapp/clients/{id} returns 401)
        response = await findClientById(clientId, adminEnvConfig);
        break;
      }
      
      case "dapp-orders": {
        const { page, take, orderBy, search, searchBy, adminApproval, clientIds } = body || {};
        
        if (!validatePagination(page, take)) {
          throw new Error("Invalid pagination parameters");
        }
        
        // Build query params object for proper signing
        const queryParams: Record<string, string | number> = {
          orderBy: orderBy || 'desc',
          take: take || 10,
          page: page || 1,
        };
        if (search) queryParams.search = String(search).slice(0, 100);
        if (searchBy) queryParams.searchBy = searchBy;
        if (adminApproval) queryParams.adminApproval = adminApproval;
        if (clientIds) queryParams.clientIds = JSON.stringify(clientIds);
        
        // Use query string signing for GET with params (fixes 401)
        response = await drGreenRequestQuery("/dapp/orders", queryParams, false, adminEnvConfig);
        break;
      }
      
      case "dapp-order-details": {
        const { orderId } = body || {};
        if (!orderId) throw new Error("orderId is required");
        if (!validateStringLength(orderId, 100)) throw new Error("Invalid order ID format");
        // Use query string signing for GET endpoints (fixes 401)
        response = await drGreenRequestQuery(`/dapp/orders/${orderId}`, {}, false, adminEnvConfig);
        break;
      }
      
      case "dapp-update-order": {
        const { orderId, orderStatus, paymentStatus } = body || {};
        if (!orderId) throw new Error("orderId is required");
        if (!validateStringLength(orderId, 100)) throw new Error("Invalid order ID format");
        response = await drGreenRequest(`/dapp/orders/${orderId}`, "PATCH", { orderStatus, paymentStatus }, adminEnvConfig);
        break;
      }
      
      case "dapp-carts": {
        const { page, take, orderBy, search, searchBy } = body || {};
        
        if (!validatePagination(page, take)) {
          throw new Error("Invalid pagination parameters");
        }
        
        // Build query params object for proper signing
        const queryParams: Record<string, string | number> = {
          orderBy: orderBy || 'desc',
          take: take || 10,
          page: page || 1,
        };
        if (search) queryParams.search = String(search).slice(0, 100);
        if (searchBy) queryParams.searchBy = searchBy;
        
        // Use query string signing for GET with params (fixes 401)
        response = await drGreenRequestQuery("/dapp/carts", queryParams, false, adminEnvConfig);
        break;
      }
      
      case "dapp-nfts": {
        // Use query string signing for GET endpoint (fixes 401)
        response = await drGreenRequestQuery("/dapp/users/nfts", {}, false, adminEnvConfig);
        break;
      }
      
      case "dapp-strains": {
        const { countryCode, orderBy, search, searchBy } = body || {};
        
        if (countryCode && !validateCountryCode(countryCode)) {
          throw new Error("Invalid country code");
        }
        
        // Build query params object for proper signing
        const queryParams: Record<string, string | number> = {
          orderBy: orderBy || 'desc',
        };
        if (countryCode) queryParams.countryCode = countryCode;
        if (search) queryParams.search = String(search).slice(0, 100);
        if (searchBy) queryParams.searchBy = searchBy;
        
        // Use query string signing for GET with params (fixes 401)
        response = await drGreenRequestQuery("/strains", queryParams, false, adminEnvConfig);
        break;
      }
      
      case "dapp-clients-list": {
        const { orderBy, status, kyc } = body || {};
        
        // Build query params object for proper signing
        const queryParams: Record<string, string | number> = {
          orderBy: orderBy || 'desc',
        };
        if (status) queryParams.status = status;
        if (kyc !== undefined) queryParams.kyc = String(kyc);
        
        // Use query string signing for GET with params (fixes 401)
        response = await drGreenRequestQuery("/dapp/clients/list", queryParams, false, adminEnvConfig);
        break;
      }
      
      // ==========================================
      // EXISTING CLIENT/SHOP ENDPOINTS (BACKWARDS COMPAT)
      // ==========================================
      
      case "create-client": {
        const { personal, address, medicalRecord } = body.data || {};
        
        // Validate email
        if (personal?.email && !validateEmail(personal.email)) {
          throw new Error("Invalid email format");
        }
        
        // Build schema-compliant payload for KYC API
        const kycPayload = {
          transaction_metadata: {
            source: "Healingbuds_Web_Store",
            timestamp: new Date().toISOString(),
            flow_type: "Onboarding_KYC_v1"
          },
          user_identity: {
            first_name: String(personal?.firstName || "").slice(0, 100),
            last_name: String(personal?.lastName || "").slice(0, 100),
            dob: personal?.dateOfBirth || "",
            email: String(personal?.email || "").toLowerCase().slice(0, 255),
            phone_number: String(personal?.phone || "").slice(0, 20)
          },
          eligibility_results: {
            age_verified: true,
            region_eligible: true,
            postal_code: String(address?.postalCode || "").slice(0, 20),
            country_code: String(address?.country || "PT").slice(0, 3),
            declared_medical_patient: medicalRecord?.doctorApproval || false
          },
          shipping_address: {
            street: String(address?.street || "").slice(0, 200),
            city: String(address?.city || "").slice(0, 100),
            postal_code: String(address?.postalCode || "").slice(0, 20),
            country: String(address?.country || "PT").slice(0, 3)
          },
          medical_record: {
            conditions: String(medicalRecord?.conditions || "").slice(0, 2000),
            current_medications: String(medicalRecord?.currentMedications || "").slice(0, 1000),
            allergies: String(medicalRecord?.allergies || "").slice(0, 500),
            previous_cannabis_use: medicalRecord?.previousCannabisUse || false
          },
          kyc_requirements: {
            document_type: "Government_ID",
            id_country: String(address?.country || "PT").slice(0, 3),
            selfie_required: true,
            liveness_check: "active"
          }
        };
        
        logInfo("Creating client with KYC payload");
        logInfo(`Using environment: ${envConfig.name} (${envConfig.apiKeyEnv})`);
        response = await drGreenRequestBody("/dapp/clients", "POST", kycPayload, false, envConfig);
        break;
      }
      
      case "request-kyc-link": {
        const { clientId, personal, address } = body.data || {};
        
        if (!clientId) {
          throw new Error("clientId is required for KYC link request");
        }
        if (!validateClientId(clientId)) {
          throw new Error("Invalid client ID format");
        }
        
        const kycLinkPayload = {
          transaction_metadata: {
            source: "Healingbuds_Web_Store",
            timestamp: new Date().toISOString(),
            flow_type: "KYC_Link_Retry_v1"
          },
          client_id: clientId,
          user_identity: {
            first_name: String(personal?.firstName || "").slice(0, 100),
            last_name: String(personal?.lastName || "").slice(0, 100),
            email: String(personal?.email || "").toLowerCase().slice(0, 255)
          },
          kyc_requirements: {
            document_type: "Government_ID",
            id_country: String(address?.country || "PT").slice(0, 3),
            selfie_required: true,
            liveness_check: "active"
          }
        };
        
        logInfo("Requesting KYC link");
        response = await drGreenRequest(`/dapp/clients/${clientId}/kyc-link`, "POST", kycLinkPayload);
        break;
      }
      
      case "get-client": {
        if (!validateClientId(body.clientId)) {
          throw new Error("Invalid client ID format");
        }
        // Use list-and-filter helper (GET /dapp/clients/{id} returns 401)
        const clientResponse = await findClientById(body.clientId, adminEnvConfig);
        if (clientResponse && clientResponse.ok) {
          const clientData = await clientResponse.json();
          // Normalize shippings array to shipping object - check both wrapper and inner data levels
          const innerClientData = clientData?.data || clientData;
          if (Array.isArray(innerClientData.shippings) && innerClientData.shippings.length > 0) {
            innerClientData.shipping = normalizeShippingObject(innerClientData.shippings[0]);
          }
          // Wrap in { success: true, data: ... } envelope so ShopContext can parse it
          return new Response(JSON.stringify({
            success: true,
            data: innerClientData,
          }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
        response = clientResponse;
        break;
      }
      
      case "update-client": {
        if (!validateClientId(body.clientId)) {
          throw new Error("Invalid client ID format");
        }
        response = await drGreenRequest(`/dapp/clients/${body.clientId}`, "PUT", body.data);
        break;
      }
      
      case "get-strains": {
        const countryCode = body?.countryCode || "PRT";
        if (!validateCountryCode(countryCode)) {
          throw new Error("Invalid country code");
        }
        logInfo(`Fetching strains for country: ${countryCode}, env: ${envConfig.name}`);
        // Use /strains endpoint (not /dapp/strains) with query string signing
        response = await drGreenRequestGet("/strains", { countryCode, take: 50 }, requestedEnv !== 'production', envConfig);
        break;
      }
      
      case "get-all-strains": {
        logInfo(`Fetching all strains, env: ${envConfig.name}`);
        // Use /strains endpoint (not /dapp/strains) with query string signing
        response = await drGreenRequestGet("/strains", { take: 100 }, requestedEnv !== 'production', envConfig);
        break;
      }
      
      case "get-strain": {
        if (!validateStringLength(body.strainId, 100)) {
          throw new Error("Invalid strain ID format");
        }
        // Method A - Body Sign: signs {"strainId": "..."}
        const signBody = { strainId: body.strainId };
        logInfo(`Fetching strain ${body.strainId}, env: ${envConfig.name}`);
        response = await drGreenRequestBody(`/strains/${body.strainId}`, "GET", signBody, false, envConfig);
        break;
      }
      
      case "create-cart": {
        response = await drGreenRequest("/dapp/carts", "POST", body.data);
        break;
      }
      
      case "update-cart": {
        if (!validateStringLength(body.cartId, 100)) {
          throw new Error("Invalid cart ID format");
        }
        response = await drGreenRequest(`/dapp/carts/${body.cartId}`, "PUT", body.data);
        break;
      }
      
      case "get-cart": {
        if (!validateStringLength(body.cartId, 100)) {
          throw new Error("Invalid cart ID format");
        }
        // Use query string signing for GET endpoints (fixes 401)
        response = await drGreenRequestQuery(`/dapp/carts/${body.cartId}`, { orderBy: 'desc', take: 1, page: 1 });
        break;
      }
      
      // Add item to cart - POST /dapp/carts with clientId and items array
      // Updated per API docs: use productId (not strainId), clientId (not clientCartId)
      case "add-to-cart": {
        const cartData = body.data || {};
        const clientId = cartData.clientId || cartData.cartId;
        if (!clientId) {
          throw new Error("clientId or cartId is required");
        }
        if (!cartData.strainId) {
          throw new Error("strainId is required");
        }
        if (!cartData.quantity || cartData.quantity < 1) {
          throw new Error("quantity must be at least 1");
        }
        
        // POST /dapp/carts - API expects clientCartId + items[]
        const cartPayload = {
          clientCartId: clientId,
          items: [{ strainId: cartData.strainId, quantity: cartData.quantity }],
        };
        
        logInfo("Adding to cart", { 
          clientCartId: clientId, 
          strainId: cartData.strainId, 
          quantity: cartData.quantity,
          payload: JSON.stringify(cartPayload),
        });
        
        response = await drGreenRequestBody("/dapp/carts", "POST", cartPayload, false, adminEnvConfig);
        
        // Log the response for debugging
        const cartResponseStatus = response.status;
        if (!response.ok) {
          const errorBody = await response.clone().text();
          logWarn("Cart add failed", { 
            status: cartResponseStatus,
            error: errorBody,
          });
        } else {
          logInfo("Cart add successful", { status: cartResponseStatus });
        }
        break;
      }
      
      // Empty/delete cart - DELETE /dapp/carts/:clientId
      case "empty-cart": {
        const cartId = body.cartId;
        if (!cartId) {
          throw new Error("cartId is required");
        }
        if (!validateStringLength(cartId, 100)) {
          throw new Error("Invalid cart ID format");
        }
        // DELETE /dapp/carts/:clientId clears the cart
        response = await drGreenRequest(`/dapp/carts/${cartId}`, "DELETE", undefined, adminEnvConfig);
        break;
      }
      
      // Place order from cart - POST /dapp/orders with just clientId
      case "place-order": {
        const orderData = body.data || {};
        if (!orderData.clientId) {
          throw new Error("clientId is required");
        }
        if (!validateClientId(orderData.clientId)) {
          throw new Error("Invalid client ID format");
        }
        // POST /dapp/orders creates an order from the cart items
        response = await drGreenRequest("/dapp/orders", "POST", {
          clientId: orderData.clientId,
        }, adminEnvConfig);
        break;
      }
      
      // Create order with items directly (per official API documentation)
      // POST /api/v1/dapp/orders with clientId, items, shippingAddress, notes
      // Create order with items - ATOMIC TRANSACTION
      // The Dr. Green API requires:
      // 1. Client must have a shipping address saved on their record
      // 2. Items must be in the server-side cart (POST /dapp/carts)
      // 3. Then order can be created from cart (POST /dapp/orders)
      // This action performs all 3 steps atomically server-side
      case "create-order": {
        // Generate request ID for traceability
        const requestId = `ord_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
        logInfo(`[${requestId}] create-order: Starting order creation flow`);
        
        const orderData = body.data || {};
        
        // ========== MOCK MODE CHECK ==========
        // When DRGREEN_MOCK_MODE is enabled, bypass the Dr. Green API entirely
        // and return a simulated success response. This is useful for:
        // 1. Testing the checkout flow without API dependencies
        // 2. Development when credentials don't have order creation permission
        // 3. Clients created under different NFT scopes (401 errors)
        if (Deno.env.get('DRGREEN_MOCK_MODE') === 'true') {
          logInfo(`[${requestId}] MOCK MODE: Simulating successful order creation`);
          
          const mockOrderId = `mock_${requestId}`;
          const mockItems = orderData.items || [];
          const mockTotal = mockItems.reduce((sum: number, item: { price?: number; quantity?: number }) => 
            sum + ((item.price || 0) * (item.quantity || 1)), 0);
          
          return new Response(JSON.stringify({
            success: true,
            orderId: mockOrderId,
            message: '[MOCK MODE] Order simulated successfully - no actual order was created in Dr. Green',
            mockMode: true,
            requestId,
            items: mockItems,
            totalAmount: mockTotal,
            status: 'PENDING',
            paymentStatus: 'PENDING',
            createdAt: new Date().toISOString(),
          }), { 
            headers: { ...corsHeaders, 'Content-Type': 'application/json' }, 
            status: 200 
          });
        }
        // ========== END MOCK MODE CHECK ==========
        if (!orderData.clientId) {
          logWarn(`[${requestId}] create-order: Missing clientId`);
          return new Response(JSON.stringify({
            success: false,
            apiStatus: 400,
            errorCode: 'MISSING_CLIENT_ID',
            message: 'Client ID is required to create an order',
            requestId,
            retryable: false,
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
        }
        if (!orderData.items || !Array.isArray(orderData.items) || orderData.items.length === 0) {
          logWarn(`[${requestId}] create-order: Missing or empty items array`);
          return new Response(JSON.stringify({
            success: false,
            apiStatus: 400,
            errorCode: 'MISSING_ITEMS',
            message: 'Items array is required and must not be empty',
            requestId,
            retryable: false,
          }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
        }
        
        const clientId = orderData.clientId;
        logInfo(`[${requestId}] create-order: Processing`, { 
          clientId: clientId.slice(0, 8) + '***',
          itemCount: orderData.items.length,
        });
        
        let shippingVerified = false;
        let stepFailed = '';
        let lastStepError = '';
        let lastStepStatus = 0;
        
        // Step 1: Update client shipping address (if provided)
        // First check if client already has shipping on the API - skip if so
        if (orderData.shippingAddress) {
          // Pre-check: fetch client to see if shipping already exists
          let existingShipping = false;
          try {
          const clientCheckResponse = await drGreenRequestQuery(`/dapp/clients/${clientId}`, {}, false, adminEnvConfig);
            if (clientCheckResponse.ok) {
              const clientData = await clientCheckResponse.clone().json();
              const innerClientData = clientData?.data || clientData;
              // Check both singular 'shipping' and plural 'shippings[]' — DApp returns either shape
              // Strictly require non-empty address1 — empty shipping objects (country/currency only) must NOT count
              const singularShipping = innerClientData?.shipping as Record<string, unknown> | null;
              const pluralShipping = Array.isArray(innerClientData?.shippings)
                ? (innerClientData.shippings as Record<string, unknown>[]).find(
                    (s) => s?.address1 && String(s.address1).trim().length > 0
                  )
                : null;
              const shipping =
                singularShipping?.address1 && String(singularShipping.address1).trim().length > 0
                  ? singularShipping
                  : pluralShipping;
              if (shipping?.address1) {
                logInfo(`[${requestId}] Step 1: Client has shipping on DApp (singular or shippings[])`, {
                  city: shipping.city,
                });
                existingShipping = true;
                shippingVerified = true;
              }
            }
          } catch (checkErr) {
            logWarn(`[${requestId}] Step 1: Client shipping check failed, will attempt PATCH`, { error: String(checkErr).slice(0, 100) });
          }

          if (!existingShipping) {
            const addr = orderData.shippingAddress;
            // Fix 1: Always normalise countryCode to Alpha-3 before sending to Dr. Green API
            const normalisedCountryCode = toAlpha3(addr.countryCode) || toAlpha3(addr.country) || 'ZAF';
            const shippingPayload = {
              shipping: {
                address1: addr.street || addr.address1 || '',
                address2: addr.address2 || '',
                landmark: addr.landmark || '',
                city: addr.city || '',
                state: addr.state || addr.city || '',
                country: addr.country || '',
                countryCode: normalisedCountryCode,
                postalCode: addr.zipCode || addr.postalCode || '',
              }
            };
            
            logInfo(`[${requestId}] Step 1: Updating client shipping address`, { 
              city: addr.city, 
              country: addr.country 
            });
            
            try {
              const shippingResponse = await drGreenRequestBody(`/dapp/clients/${clientId}`, "PATCH", shippingPayload, false, adminEnvConfig);
              if (!shippingResponse.ok) {
                const shippingError = await shippingResponse.clone().text();
                logWarn(`[${requestId}] Step 1: Shipping PATCH failed`, { 
                  status: shippingResponse.status,
                  errorBody: shippingError.slice(0, 500),
                });
                
                // PUT retry fallback
                logInfo(`[${requestId}] Step 1: Retrying shipping update with PUT method`);
                try {
                  const putResponse = await drGreenRequestBody(`/dapp/clients/${clientId}`, "PUT", shippingPayload, false, adminEnvConfig);
                  if (putResponse.ok) {
                    const putData = await putResponse.clone().json();
                    const putShipping = putData?.data?.shipping || putData?.shipping;
                    if (putShipping && putShipping.address1) {
                      logInfo(`[${requestId}] Step 1: Shipping verified via PUT fallback`);
                      shippingVerified = true;
                    }
                  } else {
                    logWarn(`[${requestId}] Step 1: PUT fallback also failed`, { status: putResponse.status });
                  }
                } catch (putErr) {
                  logWarn(`[${requestId}] Step 1: PUT fallback exception`, { error: String(putErr).slice(0, 200) });
                }
              } else {
                const responseData = await shippingResponse.clone().json();
                const returnedShipping = responseData?.data?.shipping || responseData?.shipping;
                if (returnedShipping && returnedShipping.address1) {
                  shippingVerified = true;
                }
              }
            } catch (shippingErr) {
              logWarn(`[${requestId}] Step 1: Shipping PATCH exception`, { error: String(shippingErr).slice(0, 100) });
            }
          }
          
          // Always save shipping locally as fallback
          try {
            const supabaseAdmin = createClient(
              Deno.env.get('SUPABASE_URL')!,
              Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
            );
            const addr = orderData.shippingAddress;
            await supabaseAdmin
              .from('drgreen_clients')
              .update({ 
                shipping_address: {
                  address1: addr.street || addr.address1 || '',
                  address2: addr.address2 || '',
                  landmark: addr.landmark || '',
                  city: addr.city || '',
                  state: addr.state || addr.city || '',
                  country: addr.country || '',
                  // Fix 3: Store Alpha-3 in local DB to keep consistent with API expectations
                  countryCode: toAlpha3(addr.countryCode) || toAlpha3(addr.country) || getCountryCodeFromName(addr.country) || 'ZAF',
                  postalCode: addr.zipCode || addr.postalCode || '',
                },
                updated_at: new Date().toISOString(),
              })
              .eq('drgreen_client_id', clientId);
          } catch (localSaveErr) {
            logWarn(`[${requestId}] Step 1: Local shipping save failed`, { error: String(localSaveErr).slice(0, 100) });
          }

          if (!existingShipping) {
            logInfo(`[${requestId}] Step 1: Waiting 1500ms for propagation`);
            await sleep(1500);
          }
        }
        
        // Step 1.5: Clear any stale cart to prevent 409 conflicts
        // Correct endpoint: DELETE /dapp/carts/client/{clientId} — wipes ENTIRE cart for a client
        // (NOT /dapp/carts/{cartItemId} which only deletes a single cart item by its UUID)
        logInfo(`[${requestId}] Step 1.5: Clearing existing cart to prevent 409 conflict`);
        try {
          const emptyCartResponse = await drGreenRequest(`/dapp/carts/client/${clientId}`, "DELETE", undefined, adminEnvConfig);
          logInfo(`[${requestId}] Step 1.5: Cart clear result`, { status: emptyCartResponse.status });
          if (emptyCartResponse.status === 404) {
            logInfo(`[${requestId}] Step 1.5: No existing cart found (404), proceeding`);
          }
        } catch (clearErr) {
          logWarn(`[${requestId}] Step 1.5: Cart clear failed (non-blocking)`, { error: String(clearErr).slice(0, 100) });
        }
        await sleep(1000); // Increased from 500ms — give API time to process cart deletion
        
        // Step 2: Add items to server-side cart INDIVIDUALLY
        // API: POST /dapp/carts with { clientId, strainId, quantity } per item
        const cartItems = orderData.items.map((item: { strainId?: string; productId?: string; quantity: number; price?: number }) => ({
          strainId: item.strainId || item.productId,
          quantity: item.quantity,
        }));
        
        logInfo(`[${requestId}] Step 2: Adding ${cartItems.length} items to cart individually`, { 
          clientId: clientId.slice(0, 8) + '***',
        });
        
        // Add items individually with retry logic
        let cartSuccess = false;
        let cartAttempts = 0;
        const maxCartAttempts = 3;
        let lastCartError = "";
        let lastCartStatus = 0;
        
        while (!cartSuccess && cartAttempts < maxCartAttempts) {
          cartAttempts++;
          let allItemsAdded = true;
          
          for (let i = 0; i < cartItems.length; i++) {
            const item = cartItems[i];
          // Flat format per API spec: POST /dapp/carts { clientId, strainId, quantity }
          const itemPayload = {
              clientId: clientId,
              strainId: item.strainId,
              quantity: item.quantity,
            };
            
            try {
              logInfo(`[${requestId}] Step 2: Adding item ${i + 1}/${cartItems.length}`, { 
                strainId: item.strainId?.slice(0, 8) + '***',
                quantity: item.quantity,
                attempt: cartAttempts,
              });
              
              const cartResponse = await drGreenRequestBody("/dapp/carts", "POST", itemPayload, true, adminEnvConfig);
              lastCartStatus = cartResponse.status;
              
              if (!cartResponse.ok) {
                lastCartError = await cartResponse.clone().text();
                logWarn(`[${requestId}] Step 2: Cart item ${i + 1} failed`, { 
                  status: cartResponse.status,
                  error: lastCartError.slice(0, 500),
                });
                
                // On 409 Conflict, clear cart and retry full sequence
                if (lastCartStatus === 409 && cartAttempts < maxCartAttempts) {
                  logInfo(`[${requestId}] Step 2: 409 conflict on item ${i + 1} - clearing cart and retrying all`);
                  try {
                    await drGreenRequest(`/dapp/carts/client/${clientId}`, "DELETE", undefined, adminEnvConfig);
                  } catch (clearErr) {
                    logWarn(`[${requestId}] Step 2: Cart clear failed`, { error: String(clearErr).slice(0, 100) });
                  }
                  await sleep(1000);
                  allItemsAdded = false;
                  break; // Break inner loop, retry from outer while
                } else if (lastCartError.includes("shipping address not found") && cartAttempts < maxCartAttempts) {
                  const delay = cartAttempts * 1500;
                  logInfo(`[${requestId}] Step 2: Retry in ${delay}ms (shipping propagation)`);
                  await sleep(delay);
                  allItemsAdded = false;
                  break;
                } else if (lastCartStatus === 400 && !lastCartError.includes("shipping")) {
                  logWarn(`[${requestId}] Step 2: Non-retryable 400 error, stopping`);
                  allItemsAdded = false;
                  break;
                } else {
                  allItemsAdded = false;
                  break;
                }
              } else {
                logInfo(`[${requestId}] Step 2: Item ${i + 1} added successfully`);
              }
              
              // Small delay between items to avoid rate limiting
              if (i < cartItems.length - 1) {
                await sleep(300);
              }
            } catch (cartErr) {
              logError(`[${requestId}] Step 2: Cart item ${i + 1} exception`, { error: String(cartErr).slice(0, 100) });
              lastCartError = String(cartErr);
              allItemsAdded = false;
              break;
            }
          }
          
          if (allItemsAdded) {
            logInfo(`[${requestId}] Step 2: All ${cartItems.length} items added successfully`, { attempt: cartAttempts });
            cartSuccess = true;
          } else if (cartAttempts < maxCartAttempts) {
            await sleep(1000);
          }
        }
        
        // If cart succeeded, create order from cart
        if (cartSuccess) {
          logInfo(`[${requestId}] Step 3: Creating order from cart`);
          
          const orderPayload = { clientId: clientId };
          
          try {
            response = await drGreenRequestBody("/dapp/orders", "POST", orderPayload, false, adminEnvConfig);
            
            if (response.ok) {
              logInfo(`[${requestId}] Step 3: Order created successfully via cart flow`);
              // Record api_key_scope on success so future operations skip scope checks
              try {
                const supabaseAdmin = createClient(
                  Deno.env.get('SUPABASE_URL')!,
                  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
                );
                const apiKey = Deno.env.get(adminEnvConfig.apiKeyEnv) || '';
                await supabaseAdmin
                  .from('drgreen_clients')
                  .update({ api_key_scope: apiKey.slice(0, 8), updated_at: new Date().toISOString() })
                  .eq('drgreen_client_id', clientId);
                logInfo(`[${requestId}] Recorded api_key_scope for client`);
              } catch (scopeErr) {
                logWarn(`[${requestId}] Failed to record api_key_scope`, { error: String(scopeErr).slice(0, 100) });
              }
              // Normalise and return orderId so frontend can use it directly
              const rawOrderData = await response.clone().json();
              const orderId =
                rawOrderData?.data?.id ||
                rawOrderData?.data?.orderId ||
                rawOrderData?.orderId ||
                rawOrderData?.id ||
                null;
              logInfo(`[${requestId}] Extracted orderId: ${orderId}`);
              return new Response(JSON.stringify({
                success: true,
                orderId,
                status: rawOrderData?.data?.status || 'PENDING',
                totalAmount: rawOrderData?.data?.totalAmount || rawOrderData?.data?.total || 0,
                createdAt: rawOrderData?.data?.createdAt || new Date().toISOString(),
                requestId,
              }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
            } else {
              const orderError = await response.clone().text();
              lastStepError = orderError;
              lastStepStatus = response.status;
              stepFailed = 'cart-order';
              logError(`[${requestId}] Step 3: Cart-order creation failed`, { 
                status: response.status,
                error: orderError.slice(0, 150),
              });
              // Fall through to return wrapped error
            }
          } catch (orderErr) {
            lastStepError = String(orderErr);
            lastStepStatus = 500;
            stepFailed = 'cart-order-exception';
            logError(`[${requestId}] Step 3: Cart-order exception`, { error: lastStepError.slice(0, 100) });
          }
        } else {
          stepFailed = 'cart-add';
          lastStepError = lastCartError;
          lastStepStatus = lastCartStatus;
        }
        
        // FALLBACK: Retry the cart flow after clearing and a longer delay
        // Per Postman spec, POST /dapp/orders only accepts { clientId } - items must be in cart
        if (!cartSuccess || stepFailed) {
          logInfo(`[${requestId}] Step 3 (Fallback): Retrying cart flow after full clear`, { 
            cartFailed: !cartSuccess,
            previousStep: stepFailed,
          });
          
          // Clear cart completely — use correct endpoint: DELETE /dapp/carts/client/{clientId}
          try {
            await drGreenRequest(`/dapp/carts/client/${clientId}`, "DELETE", undefined, adminEnvConfig);
          } catch (clearErr) {
            logWarn(`[${requestId}] Fallback: Cart clear failed`, { error: String(clearErr).slice(0, 100) });
          }
          await sleep(2000);
          
          // Re-add all items individually
          let fallbackAllAdded = true;
          for (let i = 0; i < cartItems.length; i++) {
            const item = cartItems[i];
            try {
              // Flat format per API spec: POST /dapp/carts { clientId, strainId, quantity }
              const itemPayload = { clientId: clientId, strainId: item.strainId, quantity: item.quantity };
              const resp = await drGreenRequestBody("/dapp/carts", "POST", itemPayload, true, adminEnvConfig);
              if (!resp.ok) {
                const errText = await resp.clone().text();
                logWarn(`[${requestId}] Fallback: Item ${i + 1} failed`, { status: resp.status, error: errText.slice(0, 200) });
                fallbackAllAdded = false;
                lastCartError = errText;
                lastCartStatus = resp.status;
                break;
              }
              if (i < cartItems.length - 1) await sleep(300);
            } catch (err) {
              logError(`[${requestId}] Fallback: Item ${i + 1} exception`, { error: String(err).slice(0, 100) });
              fallbackAllAdded = false;
              lastCartError = String(err);
              break;
            }
          }
          
          if (fallbackAllAdded) {
            await sleep(500);
            try {
              response = await drGreenRequestBody("/dapp/orders", "POST", { clientId }, false, adminEnvConfig);
              if (response.ok) {
                logInfo(`[${requestId}] Fallback: Order created successfully`);
                try {
                  const supabaseAdmin2 = createClient(
                    Deno.env.get('SUPABASE_URL')!,
                    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
                  );
                  const apiKey2 = Deno.env.get(adminEnvConfig.apiKeyEnv) || '';
                  await supabaseAdmin2
                    .from('drgreen_clients')
                    .update({ api_key_scope: apiKey2.slice(0, 8), updated_at: new Date().toISOString() })
                    .eq('drgreen_client_id', clientId);
                } catch (scopeErr2) {
                  logWarn(`[${requestId}] Failed to record api_key_scope (fallback)`, { error: String(scopeErr2).slice(0, 100) });
                }
                // Normalise and return orderId from fallback path
                const rawOrderDataFb = await response.clone().json();
                const orderIdFb =
                  rawOrderDataFb?.data?.id ||
                  rawOrderDataFb?.data?.orderId ||
                  rawOrderDataFb?.orderId ||
                  rawOrderDataFb?.id ||
                  null;
                logInfo(`[${requestId}] Fallback extracted orderId: ${orderIdFb}`);
                return new Response(JSON.stringify({
                  success: true,
                  orderId: orderIdFb,
                  status: rawOrderDataFb?.data?.status || 'PENDING',
                  totalAmount: rawOrderDataFb?.data?.totalAmount || rawOrderDataFb?.data?.total || 0,
                  createdAt: rawOrderDataFb?.data?.createdAt || new Date().toISOString(),
                  requestId,
                }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
              } else {
                const directError = await response.clone().text();
                lastStepError = directError;
                lastStepStatus = response.status;
                stepFailed = 'fallback-order';
                logError(`[${requestId}] Fallback: Order creation failed`, { status: response.status, error: directError.slice(0, 200) });
              }
            } catch (orderErr) {
              lastStepError = String(orderErr);
              lastStepStatus = 500;
              stepFailed = 'fallback-order-exception';
            }
          } else {
            stepFailed = 'fallback-cart-add';
          }
        }
        
        // If we reach here, all attempts failed - return 200-wrapped error for observability
        const isShippingError = lastStepError.includes("shipping");
        const isAuthError = lastStepStatus === 401 || lastStepStatus === 403;
        const isClientInactive = lastStepError.includes("not active") || lastStepError.includes("inactive");
        
        let userMessage = 'Order creation failed. Please try again or contact support.';
        let errorCode = 'ORDER_CREATION_FAILED';
        let retryable = lastStepStatus >= 500;
        
        if (isShippingError) {
          userMessage = 'Shipping address could not be verified. Please update your address and try again.';
          errorCode = 'SHIPPING_ADDRESS_REQUIRED';
          retryable = false;
        } else if (isAuthError) {
          userMessage = 'Authorization failed. Your session may have expired or credentials are invalid.';
          errorCode = 'AUTH_FAILED';
          retryable = false;
        } else if (isClientInactive) {
          userMessage = 'Your account is not active. Please wait for verification or contact support.';
          errorCode = 'CLIENT_INACTIVE';
          retryable = false;
        }
        
        logError(`[${requestId}] create-order: All attempts failed`, {
          stepFailed,
          lastStepStatus,
          errorCode,
          retryable,
        });
        
        return new Response(JSON.stringify({
          success: false,
          apiStatus: lastStepStatus || 500,
          errorCode,
          message: userMessage,
          requestId,
          stepFailed,
          retryable,
          upstream: lastStepError.slice(0, 300),
        }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
      }
      
      case "get-order": {
        if (!validateStringLength(body.orderId, 100)) {
          throw new Error("Invalid order ID format");
        }
        // Method A - Body Sign: signs {"orderId": "..."}
        const signBody = { orderId: body.orderId };
        response = await drGreenRequestBody(`/orders/${body.orderId}`, "GET", signBody);
        break;
      }
      
      case "update-order": {
        if (!validateStringLength(body.orderId, 100)) {
          throw new Error("Invalid order ID format");
        }
        response = await drGreenRequest(`/dapp/orders/${body.orderId}`, "PATCH", body.data);
        break;
      }
      
      case "get-orders": {
        if (!validateClientId(body.clientId)) {
          throw new Error("Invalid client ID format");
        }
        // Primary: Use /dapp/orders with clientId as query param
        response = await drGreenRequestQuery("/dapp/orders", {
          clientId: body.clientId,
          orderBy: 'desc',
          take: 50,
          page: 1,
        }, false, adminEnvConfig);
        
        // Fallback: If primary returns empty, try /dapp/client/{clientId}/orders
        if (response.ok) {
          try {
            const ordersData = await response.clone().json();
            const orders = ordersData?.data?.data || ordersData?.data || [];
            if (Array.isArray(orders) && orders.length === 0) {
              logInfo(`[get-orders] Primary returned empty, trying client-orders endpoint`);
              const fallbackResp = await drGreenRequestQuery(`/dapp/client/${body.clientId}/orders`, {
                orderBy: 'desc',
                take: 50,
                page: 1,
              }, false, adminEnvConfig);
              if (fallbackResp.ok) {
                response = fallbackResp;
              }
            }
          } catch (parseErr) {
            logWarn(`[get-orders] Could not parse primary response for fallback check`);
          }
        }
        break;
      }
      
      case "create-payment": {
        response = await drGreenRequest("/dapp/payments", "POST", body.data);
        break;
      }
      
      case "get-payment": {
        if (!validateStringLength(body.paymentId, 100)) {
          throw new Error("Invalid payment ID format");
        }
        // Use query string signing for GET endpoints (fixes 401)
        response = await drGreenRequestQuery(`/dapp/payments/${body.paymentId}`, {});
        break;
      }
      
      // ==========================================
      // NEW ENDPOINTS FROM POSTMAN COLLECTION
      // ==========================================
      
      case "get-user-me": {
        // GET /user/me - Get current authenticated user details
        response = await drGreenRequestQuery("/user/me", {});
        break;
      }
      
      // Secure self-lookup: find existing Dr. Green client by authenticated user's email
      // This action uses the JWT email from the token - request body email is IGNORED
      // This prevents privacy leaks (users cannot probe other emails)
      case "get-client-by-auth-email": {
        // Get user email from the authenticated token
        const authResult = await verifyAuthentication(req);
        if (!authResult) {
          return new Response(
            JSON.stringify({ error: 'Authentication required' }),
            { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        const userEmail = authResult.user.email;
        if (!userEmail) {
          return new Response(
            JSON.stringify({ success: false, error: 'No email found in auth token', found: false }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        logInfo("Looking up Dr. Green client by auth email", { emailPrefix: userEmail.slice(0, 5) + '***' });
        
        // Search Dr. Green API by email
        // Note: The API 'search' param only works with clientName, so we need to 
        // fetch clients and filter by email server-side
        try {
          // Strategy: Multi-page fetch to ensure we don't miss clients
          // Fetch up to 3 pages (300 clients) to improve discovery rate
          const MAX_PAGES = 3;
          const PAGE_SIZE = 100;
          let allClients: any[] = [];
          let foundClient: any = null;
          let foundOnPage = 0;
          
          for (let page = 1; page <= MAX_PAGES; page++) {
            const queryParams: Record<string, string | number> = {
              take: PAGE_SIZE,
              page,
              orderBy: 'desc',
            };
            
            logInfo(`Querying Dr. Green clients page ${page}/${MAX_PAGES}`, { take: PAGE_SIZE });
            const searchResponse = await drGreenRequestQuery("/dapp/clients", queryParams);
            
            if (!searchResponse.ok) {
              const errorBody = await searchResponse.text();
              logWarn("Dr. Green client list failed", { 
                status: searchResponse.status,
                page,
                errorBody: errorBody.slice(0, 200),
              });
              break; // Stop pagination on error
            }
            
            const searchData = await searchResponse.json();
            
            // API might return { data: { items: [...] } } or { data: [...] } or { clients: [...] }
            let clients: any[] | null = null;
            if (Array.isArray(searchData.data)) {
              clients = searchData.data;
            } else if (searchData.data?.items && Array.isArray(searchData.data.items)) {
              clients = searchData.data.items;
            } else if (Array.isArray(searchData.clients)) {
              clients = searchData.clients;
            } else if (searchData.data?.clients && Array.isArray(searchData.data.clients)) {
              clients = searchData.data.clients;
            } else if (Array.isArray(searchData)) {
              clients = searchData;
            }
            
            if (!clients || clients.length === 0) {
              logInfo(`No more clients on page ${page}, stopping pagination`);
              break;
            }
            
            // Log email prefixes for debugging (masked for privacy)
            const emailPrefixes = clients.map((c: any) => 
              c.email ? c.email.slice(0, 3).toLowerCase() + '***' : 'no-email'
            );
            logInfo(`Page ${page} client emails (masked)`, { 
              clientCount: clients.length, 
              emailPrefixes: emailPrefixes.slice(0, 15),
              searchingFor: userEmail.slice(0, 3).toLowerCase() + '***',
            });
            
            allClients = [...allClients, ...clients];
            
            // Check for match on this page
            const match = clients.find((c: any) => 
              c.email && c.email.toLowerCase() === userEmail.toLowerCase()
            );
            
            if (match) {
              foundClient = match;
              foundOnPage = page;
              logInfo(`Found matching client on page ${page}!`);
              break; // Found the client, no need to continue
            }
            
            // If fewer than PAGE_SIZE returned, we've reached the end
            if (clients.length < PAGE_SIZE) {
              logInfo(`Last page reached (page ${page} had ${clients.length} clients)`);
              break;
            }
          }
          
          if (foundClient) {
            // Normalize the response to a consistent format
            const normalizedClient = {
              success: true,
              found: true,
              clientId: foundClient.id || foundClient.clientId || foundClient.client_id,
              email: foundClient.email,
              firstName: foundClient.firstName || foundClient.first_name,
              lastName: foundClient.lastName || foundClient.last_name,
              isKYCVerified: foundClient.isKYCVerified ?? foundClient.is_kyc_verified ?? false,
              adminApproval: foundClient.adminApproval || foundClient.admin_approval || 'PENDING',
              kycLink: foundClient.kycLink || foundClient.kyc_link || null,
              countryCode: toAlpha2(foundClient.shipping?.countryCode)
                || toAlpha2(foundClient.shippings?.[0]?.countryCode)
                || toAlpha2(getCountryCodeFromName(foundClient.shipping?.country || foundClient.shippings?.[0]?.country))
                || foundClient.phoneCountryCode 
                || null,
              foundOnPage,
              totalClientsChecked: allClients.length,
            };
            
            logInfo("Found existing Dr. Green client by email match", { 
              hasClientId: !!normalizedClient.clientId,
              isVerified: normalizedClient.isKYCVerified,
              adminApproval: normalizedClient.adminApproval,
              foundOnPage,
            });
            
            return new Response(JSON.stringify(normalizedClient), {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          } else {
            logInfo("No Dr. Green client found matching email after multi-page search", { 
              totalClientsChecked: allClients.length,
              pagesSearched: Math.min(MAX_PAGES, Math.ceil(allClients.length / PAGE_SIZE) || 1),
            });
            return new Response(
              JSON.stringify({ 
                success: true, 
                found: false, 
                message: 'No client found for this email',
                totalClientsChecked: allClients.length,
              }),
              { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
        } catch (e) {
          logError("Error searching for client by email", { error: e instanceof Error ? e.message : 'Unknown' });
          return new Response(
            JSON.stringify({ success: false, found: false, error: 'Search failed' }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }
      
      // Admin action: Search clients by name (for finding spelling variations)
      case "admin-search-clients-by-name": {
        const searchTerm = body.search || body.name || '';
        if (!searchTerm) {
          return new Response(
            JSON.stringify({ success: false, error: 'Search term required' }),
            { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
        
        logInfo("Admin searching clients by name", { searchTerm: searchTerm.slice(0, 3) + '***' });
        
        try {
          // Fetch ALL clients and filter by name (search supports clientName)
          const queryParams: Record<string, string | number> = {
            take: 100,
            page: 1,
            orderBy: 'desc',
            search: searchTerm,
            searchBy: 'clientName',
          };
          
          const searchResponse = await drGreenRequestQuery("/dapp/clients", queryParams);
          
          if (!searchResponse.ok) {
            const errorBody = await searchResponse.text();
            logWarn("Name search failed", { status: searchResponse.status, errorBody: errorBody.slice(0, 200) });
            return new Response(
              JSON.stringify({ success: false, error: 'Search failed', status: searchResponse.status }),
              { status: searchResponse.status, headers: { ...corsHeaders, "Content-Type": "application/json" } }
            );
          }
          
          const searchData = await searchResponse.json();
          
          // Parse response
          let clients: any[] = [];
          if (Array.isArray(searchData.data)) {
            clients = searchData.data;
          } else if (searchData.data?.items) {
            clients = searchData.data.items;
          } else if (Array.isArray(searchData)) {
            clients = searchData;
          }
          
          // Return full client details for admin debugging
          const results = clients.map((c: any) => ({
            id: c.id || c.clientId,
            firstName: c.firstName || c.first_name,
            lastName: c.lastName || c.last_name,
            email: c.email,
            isKYCVerified: c.isKYCVerified ?? c.is_kyc_verified,
            adminApproval: c.adminApproval || c.admin_approval,
          }));
          
          logInfo(`Found ${results.length} clients matching "${searchTerm}"`, {
            resultCount: results.length,
            emails: results.map((r: any) => r.email?.slice(0, 5) + '***'),
          });
          
          return new Response(
            JSON.stringify({ 
              success: true, 
              results, 
              count: results.length,
              searchTerm,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        } catch (e) {
          logError("Name search error", { error: String(e) });
          return new Response(
            JSON.stringify({ success: false, error: String(e) }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }
      
      // Admin action: List ALL clients for debugging
      case "admin-list-all-clients": {
        logInfo("Admin listing all clients for debugging");
        
        try {
          const allClients: any[] = [];
          const MAX_PAGES = 5;
          const PAGE_SIZE = 100;
          
          for (let page = 1; page <= MAX_PAGES; page++) {
            const queryParams: Record<string, string | number> = {
              take: PAGE_SIZE,
              page,
              orderBy: 'desc',
            };
            
            const response = await drGreenRequestQuery("/dapp/clients", queryParams, false, adminEnvConfig);
            
            if (!response.ok) {
              logWarn(`Failed to fetch page ${page}`, { status: response.status });
              break;
            }
            
            const data = await response.json();
            let clients: any[] = [];
            
            if (Array.isArray(data.data)) {
              clients = data.data;
            } else if (data.data?.items) {
              clients = data.data.items;
            } else if (Array.isArray(data)) {
              clients = data;
            }
            
            if (clients.length === 0) break;
            
            allClients.push(...clients);
            
            if (clients.length < PAGE_SIZE) break;
          }
          
          const results = allClients.map((c: any) => ({
            id: c.id || c.clientId,
            firstName: c.firstName || c.first_name || '(no first name)',
            lastName: c.lastName || c.last_name || '(no last name)',
            email: c.email || '(no email)',
            isKYCVerified: c.isKYCVerified ?? c.is_kyc_verified,
            adminApproval: c.adminApproval || c.admin_approval,
            createdAt: c.createdAt || c.created_at,
          }));
          
          logInfo(`Listed ${results.length} total clients`);
          
          return new Response(
            JSON.stringify({ 
              success: true, 
              clients: results, 
              totalCount: results.length,
            }),
            { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        } catch (e) {
          logError("List all clients error", { error: String(e) });
          return new Response(
            JSON.stringify({ success: false, error: String(e) }),
            { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }
      }
      
      // debug-list-all-clients REMOVED — security risk (unauthenticated PII exposure)
      // Use admin-list-all-clients instead (requires admin role)
      
      case "delete-client": {
        // DELETE /dapp/clients/:clientId - Delete a client
        if (!validateClientId(body.clientId)) {
          throw new Error("Invalid client ID format");
        }
        response = await drGreenRequest(`/dapp/clients/${body.clientId}`, "DELETE");
        break;
      }
      
      case "patch-client": {
        // PATCH /dapp/clients/:clientId - Partial update client details
        if (!validateClientId(body.clientId)) {
          throw new Error("Invalid client ID format");
        }
        response = await drGreenRequest(`/dapp/clients/${body.clientId}`, "PATCH", body.data);
        break;
      }
      
      // Update shipping address specifically for a client (ownership-verified action)
      case "update-shipping-address": {
        if (!validateClientId(body.clientId)) {
          throw new Error("Invalid client ID format");
        }
        
        const shipping = body.shipping;
        if (!shipping || !shipping.address1 || !shipping.city || !shipping.postalCode || !shipping.countryCode) {
          throw new Error("Invalid shipping address: address1, city, postalCode, and countryCode are required");
        }
        
        // Use top-level getCountryCodeFromName for Alpha-2 to Alpha-3 conversion
        let alpha3CountryCode = shipping.countryCode;
        const converted = getCountryCodeFromName(shipping.countryCode);
        if (converted) alpha3CountryCode = converted;
        
        // Build the shipping object per Dr. Green API spec
        const shippingPayload = {
          shipping: {
            address1: String(shipping.address1).slice(0, 200),
            address2: String(shipping.address2 || '').slice(0, 200),
            landmark: String(shipping.landmark || '').slice(0, 100),
            city: String(shipping.city).slice(0, 100),
            state: String(shipping.state || shipping.city).slice(0, 100),
            country: String(shipping.country || '').slice(0, 100),
            countryCode: alpha3CountryCode,
            postalCode: String(shipping.postalCode).slice(0, 20),
          }
        };
        
        logInfo("Updating client shipping address", {
          clientId: body.clientId,
          city: shippingPayload.shipping.city,
          countryCode: shippingPayload.shipping.countryCode,
        });
        
        response = await drGreenRequest(`/dapp/clients/${body.clientId}`, "PATCH", shippingPayload);
        break;
      }
      
      // Admin: Update any client's shipping address (bypasses ownership check)
      case "admin-update-shipping-address": {
        if (!validateClientId(body.clientId)) {
          throw new Error("Invalid client ID format");
        }
        
        const shipping = body.shipping;
        if (!shipping || !shipping.address1 || !shipping.city || !shipping.postalCode || !shipping.countryCode) {
          throw new Error("Invalid shipping address: address1, city, postalCode, and countryCode are required");
        }
        
        // Use top-level getCountryCodeFromName for Alpha-2 to Alpha-3 conversion
        let alpha3CountryCode = shipping.countryCode;
        const converted = getCountryCodeFromName(shipping.countryCode);
        if (converted) alpha3CountryCode = converted;
        
        // Build the shipping object per Dr. Green API spec
        const shippingPayload = {
          shipping: {
            address1: String(shipping.address1).slice(0, 200),
            address2: String(shipping.address2 || '').slice(0, 200),
            landmark: String(shipping.landmark || '').slice(0, 100),
            city: String(shipping.city).slice(0, 100),
            state: String(shipping.state || shipping.city).slice(0, 100),
            country: String(shipping.country || '').slice(0, 100),
            countryCode: alpha3CountryCode,
            postalCode: String(shipping.postalCode).slice(0, 20),
          }
        };
        
        logInfo("Admin updating client shipping address", {
          clientId: body.clientId,
          city: shippingPayload.shipping.city,
          countryCode: shippingPayload.shipping.countryCode,
        });
        
        response = await drGreenRequest(`/dapp/clients/${body.clientId}`, "PATCH", shippingPayload);
        break;
      }
      
      // Admin: Re-register a client with the current API key pair
      // This is used when clients were created with a different API key and need fresh IDs
      case "admin-reregister-client": {
        const { email, firstName, lastName, countryCode, phoneCode, phoneCountryCode, contactNumber, shipping } = body || {};
        
        if (!email || !validateEmail(email)) {
          throw new Error("Valid email is required for re-registration");
        }
        if (!firstName || !lastName) {
          throw new Error("firstName and lastName are required for re-registration");
        }
        
        logInfo("[admin-reregister-client] Starting re-registration", {
          email: String(email).slice(0, 5) + '***',
          hasShipping: !!shipping,
          countryCode: countryCode || 'not provided',
        });
        
        // Use top-level getCountryCodeFromName for Alpha-2 to Alpha-3 conversion
        const shippingData = shipping || {};
        const shippingCountryCode = shippingData.countryCode || countryCode || 'ZAF';
        const alpha3CountryCode = getCountryCodeFromName(shippingCountryCode) || shippingCountryCode;
        
        const reregisterPayload: Record<string, unknown> = {
          firstName: String(firstName).trim(),
          lastName: String(lastName).trim(),
          email: String(email).toLowerCase().trim(),
          phoneCode: String(phoneCode || '+27'),
          phoneCountryCode: String(phoneCountryCode || 'ZA').toUpperCase(),
          contactNumber: String(contactNumber || '000000000'),
          
          shipping: {
            address1: String(shippingData.address1 || 'Address Pending').trim(),
            address2: String(shippingData.address2 || '').trim(),
            city: String(shippingData.city || 'City').trim(),
            state: String(shippingData.state || shippingData.city || 'State').trim(),
            country: String(shippingData.country || 'South Africa').trim(),
            countryCode: alpha3CountryCode,
            postalCode: String(shippingData.postalCode || '0000').trim(),
            landmark: String(shippingData.landmark || '').trim(),
          },
          
          // Minimal medical record with safe defaults (required by Dr. Green API)
          medicalRecord: {
            dob: '1990-01-01',
            gender: 'prefer_not_to_say',
            medicalHistory0: false,
            medicalHistory1: false,
            medicalHistory2: false,
            medicalHistory3: false,
            medicalHistory4: false,
            medicalHistory5: ['none'],
            medicalHistory8: false,
            medicalHistory9: false,
            medicalHistory10: false,
            medicalHistory12: false,
            medicalHistory13: 'never',
            medicalHistory14: ['never'],
          },
        };
        
        console.log("[admin-reregister-client] Calling Dr. Green API with payload for:", String(email).slice(0, 5) + '***');
        
        console.log("[admin-reregister-client] Using environment:", envConfig.name, `(${envConfig.apiKeyEnv})`);
        
        // Call the Dr. Green API to create the client under current env key pair
        response = await drGreenRequestBody("/dapp/clients", "POST", reregisterPayload, true, envConfig);
        
        const clonedResp = response.clone();
        const respBody = await clonedResp.text();
        
        console.log("[admin-reregister-client] API Response status:", response.status);
        console.log("[admin-reregister-client] API Response body:", respBody.slice(0, 500));
        
        if (response.ok) {
          try {
            const rawData = JSON.parse(respBody);
            
            // Extract clientId and kycLink from response
            const newClientId = rawData.client?.id || rawData.data?.id || rawData.clientId || rawData.id;
            const newKycLink = rawData.client?.kycLink || rawData.data?.kycLink || rawData.kycLink;
            
            console.log("[admin-reregister-client] Success! New client ID:", newClientId);
            
            // Look up user by email and update their drgreen_clients record
            const { data: userLookup, error: lookupError } = await supabaseClient
              .from('profiles')
              .select('id')
              .ilike('full_name', `%${firstName}%`)
              .limit(1);
            
            // Also try to find by checking auth.users via the drgreen_clients email
            // Since we can't query auth.users directly, we'll upsert based on email matching
            const { data: existingClient, error: existingError } = await supabaseClient
              .from('drgreen_clients')
              .select('user_id')
              .eq('email', String(email).toLowerCase().trim())
              .maybeSingle();
            
            if (existingClient?.user_id) {
              // Preserve old client ID for audit trail
              const { data: currentRecord } = await supabaseClient
                .from('drgreen_clients')
                .select('drgreen_client_id')
                .eq('user_id', existingClient.user_id)
                .maybeSingle();

              const apiKey = Deno.env.get(envConfig.apiKeyEnv) || '';

              // Update existing record with new Dr. Green IDs + rehome tracking
              const { error: updateError } = await supabaseClient
                .from('drgreen_clients')
                .update({
                  old_drgreen_client_id: currentRecord?.drgreen_client_id || null,
                  drgreen_client_id: newClientId,
                  kyc_link: newKycLink,
                  is_kyc_verified: false, // Reset - they need to re-verify
                  admin_approval: 'PENDING',
                  rehome_status: 'success',
                  rehome_error: null,
                  rehomed_at: new Date().toISOString(),
                  api_key_scope: apiKey.slice(0, 8),
                  updated_at: new Date().toISOString(),
                  shipping_address: reregisterPayload.shipping,
                })
                .eq('user_id', existingClient.user_id);
              
              if (updateError) {
                console.error("[admin-reregister-client] Failed to update local record:", updateError);
              }
            }
            
            return new Response(JSON.stringify({
              success: true,
              clientId: newClientId,
              kycLink: newKycLink,
              message: `Client re-registered successfully. New KYC verification required.`,
            }), {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          } catch (parseError) {
            console.error("[admin-reregister-client] Failed to parse success response:", parseError);
          }
        } else {
          console.error("[admin-reregister-client] API returned error status:", response.status);
        }
        
        break;
      }

      // Auto re-home: ownership-verified action for checkout flow
      // Detects if the current client ID is broken (404/401) and re-registers automatically
      case "auto-rehome-client": {
        const { clientId } = body || {};
        if (!clientId) {
          throw new Error("clientId is required");
        }

        // Verify user owns this client record
        const { data: clientRecord, error: lookupErr } = await supabaseClient
          .from('drgreen_clients')
          .select('*')
          .eq('drgreen_client_id', clientId)
          .maybeSingle();

        if (lookupErr || !clientRecord) {
          throw new Error("Client record not found");
        }

        // Verify the client ID is actually broken by calling the Dr. Green API
        let isBroken = false;
        try {
          const checkResp = await drGreenRequest(`/dapp/clients/${clientId}`, "GET", envConfig);
          if (!checkResp.ok) {
            const status = checkResp.status;
            if (status === 404 || status === 401 || status === 403) {
              isBroken = true;
            }
          }
        } catch {
          isBroken = true; // Network error = assume broken
        }

        if (!isBroken) {
          return new Response(JSON.stringify({
            success: true,
            clientId,
            message: 'Client ID is valid, no re-homing needed',
            rehomed: false,
          }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        // Client is broken — re-register
        const nameParts = (clientRecord.full_name || '').split(' ');
        const autoFirstName = nameParts[0] || 'Unknown';
        const autoLastName = nameParts.slice(1).join(' ') || 'Patient';
        const autoShipping = clientRecord.shipping_address as Record<string, string> | null;

        // Use top-level getCountryCodeFromName
        const autoShippingCC = autoShipping?.countryCode || clientRecord.country_code || 'ZAF';
        const autoAlpha3 = getCountryCodeFromName(autoShippingCC) || autoShippingCC;

        const autoPayload: Record<string, unknown> = {
          firstName: autoFirstName,
          lastName: autoLastName,
          email: (clientRecord.email || '').toLowerCase().trim(),
          phoneCode: '+27',
          phoneCountryCode: 'ZA',
          contactNumber: '000000000',
          shipping: {
            address1: autoShipping?.address1 || 'Address Pending',
            address2: autoShipping?.address2 || '',
            city: autoShipping?.city || 'City',
            state: autoShipping?.state || autoShipping?.city || 'State',
            country: autoShipping?.country || 'South Africa',
            countryCode: autoAlpha3,
            postalCode: autoShipping?.postalCode || '0000',
            landmark: autoShipping?.landmark || '',
          },
          medicalRecord: {
            dob: '1990-01-01',
            gender: 'prefer_not_to_say',
            medicalHistory0: false, medicalHistory1: false, medicalHistory2: false,
            medicalHistory3: false, medicalHistory4: false,
            medicalHistory5: ['none'],
            medicalHistory8: false, medicalHistory9: false, medicalHistory10: false,
            medicalHistory12: false, medicalHistory13: 'never', medicalHistory14: ['never'],
          },
        };

        const autoResp = await drGreenRequestBody("/dapp/clients", "POST", autoPayload, true, envConfig);
        const autoRespBody = await autoResp.clone().text();

        if (autoResp.ok) {
          const rawData = JSON.parse(autoRespBody);
          const newAutoClientId = rawData.client?.id || rawData.data?.id || rawData.clientId || rawData.id;
          const newAutoKycLink = rawData.client?.kycLink || rawData.data?.kycLink || rawData.kycLink;
          const apiKey = Deno.env.get(envConfig.apiKeyEnv) || '';

          // Update local record
          await supabaseClient
            .from('drgreen_clients')
            .update({
              old_drgreen_client_id: clientId,
              drgreen_client_id: newAutoClientId,
              kyc_link: newAutoKycLink,
              is_kyc_verified: false,
              admin_approval: 'PENDING',
              rehome_status: 'success',
              rehome_error: null,
              rehomed_at: new Date().toISOString(),
              api_key_scope: apiKey.slice(0, 8),
              updated_at: new Date().toISOString(),
            })
            .eq('id', clientRecord.id);

          return new Response(JSON.stringify({
            success: true,
            clientId: newAutoClientId,
            kycLink: newAutoKycLink,
            oldClientId: clientId,
            message: 'Client auto-rehomed successfully',
            rehomed: true,
          }), {
            status: 200,
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        } else {
          const errMsg = `Auto-rehome failed: API returned ${autoResp.status}`;
          await supabaseClient
            .from('drgreen_clients')
            .update({
              rehome_status: 'failed',
              rehome_error: errMsg,
              updated_at: new Date().toISOString(),
            })
            .eq('id', clientRecord.id);

          throw new Error(errMsg);
        }
      }
      
      // TEMPORARY: Public bootstrap endpoint for test client creation
      // This allows creating clients without authentication for development testing
      case "bootstrap-test-client": {
        const { email, firstName, lastName, countryCode, phoneCode, phoneCountryCode, contactNumber, shipping, environment } = body || {};
        
        if (!email || !validateEmail(email)) {
          throw new Error("Valid email is required");
        }
        if (!firstName || !lastName) {
          throw new Error("firstName and lastName are required");
        }
        
        // Get the environment configuration
        const bootstrapEnvConfig = getEnvironment(environment);
        console.log("[bootstrap-test-client] Using environment:", bootstrapEnvConfig.name, `(${bootstrapEnvConfig.apiKeyEnv})`);
        console.log("[bootstrap-test-client] Creating client for:", String(email).slice(0, 5) + '***');
        
        // Use top-level getCountryCodeFromName
        const shippingData = shipping || {};
        const shippingCountryCode = shippingData.countryCode || countryCode || 'ZAF';
        const alpha3CountryCode = getCountryCodeFromName(shippingCountryCode) || shippingCountryCode;
        
        const bootstrapPayload: Record<string, unknown> = {
          firstName: String(firstName).trim(),
          lastName: String(lastName).trim(),
          email: String(email).toLowerCase().trim(),
          phoneCode: String(phoneCode || '+27'),
          phoneCountryCode: String(phoneCountryCode || 'ZA').toUpperCase(),
          contactNumber: String(contactNumber || '000000000'),
          shipping: {
            address1: String(shippingData.address1 || 'Address Pending').trim(),
            address2: String(shippingData.address2 || '').trim(),
            city: String(shippingData.city || 'City').trim(),
            state: String(shippingData.state || shippingData.city || 'State').trim(),
            country: String(shippingData.country || 'South Africa').trim(),
            countryCode: alpha3CountryCode,
            postalCode: String(shippingData.postalCode || '0000').trim(),
            landmark: String(shippingData.landmark || '').trim(),
          },
          medicalRecord: {
            dob: '1990-01-01',
            gender: 'prefer_not_to_say',
            medicalHistory0: false,
            medicalHistory1: false,
            medicalHistory2: false,
            medicalHistory3: false,
            medicalHistory4: false,
            medicalHistory5: ['none'],
            medicalHistory8: false,
            medicalHistory9: false,
            medicalHistory10: false,
            medicalHistory12: false,
            medicalHistory13: 'never',
            medicalHistory14: ['never'],
          },
        };
        
        // Use the selected environment for the API call
        response = await drGreenRequestBody("/dapp/clients", "POST", bootstrapPayload, true, bootstrapEnvConfig);
        
        const clonedResp = response.clone();
        const respBody = await clonedResp.text();
        
        console.log("[bootstrap-test-client] API Response status:", response.status);
        console.log("[bootstrap-test-client] API Response body:", respBody.slice(0, 500));
        
        if (response.ok) {
          try {
            const rawData = JSON.parse(respBody);
            const newClientId = rawData.client?.id || rawData.data?.id || rawData.clientId || rawData.id;
            const newKycLink = rawData.client?.kycLink || rawData.data?.kycLink || rawData.kycLink;
            
            console.log("[bootstrap-test-client] Success! Client ID:", newClientId);
            
            // Update local drgreen_clients record if exists
            const { data: existingClient } = await supabaseClient
              .from('drgreen_clients')
              .select('user_id')
              .eq('email', String(email).toLowerCase().trim())
              .maybeSingle();
            
            if (existingClient?.user_id) {
              await supabaseClient
                .from('drgreen_clients')
                .update({
                  drgreen_client_id: newClientId,
                  kyc_link: newKycLink,
                  updated_at: new Date().toISOString(),
                  shipping_address: bootstrapPayload.shipping,
                })
                .eq('user_id', existingClient.user_id);
            }
            
            return new Response(JSON.stringify({
              success: true,
              clientId: newClientId,
              kycLink: newKycLink,
              email: String(email).toLowerCase().trim(),
              message: `Client created successfully under current API key.`,
            }), {
              status: 200,
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          } catch (parseError) {
            console.error("[bootstrap-test-client] Parse error:", parseError);
          }
        }
        
        break;
      }
      
      case "activate-client": {
        // PATCH /dapp/clients/:clientId/activate - Activate a client
        if (!validateClientId(body.clientId)) {
          throw new Error("Invalid client ID format");
        }
        response = await drGreenRequest(`/dapp/clients/${body.clientId}/activate`, "PATCH", {});
        break;
      }
      
      case "deactivate-client": {
        // PATCH /dapp/clients/:clientId/deactivate - Deactivate a client
        if (!validateClientId(body.clientId)) {
          throw new Error("Invalid client ID format");
        }
        response = await drGreenRequest(`/dapp/clients/${body.clientId}/deactivate`, "PATCH", {});
        break;
      }
      
      case "bulk-delete-clients": {
        // Bulk delete clients - DELETE /dapp/clients/bulk with { ids: [...] }
        const clientIds = body.ids || body.clientIds;
        if (!Array.isArray(clientIds) || clientIds.length === 0) {
          throw new Error("Invalid ids - must be non-empty array");
        }
        if (clientIds.length > 50) {
          throw new Error("Cannot delete more than 50 clients at once");
        }
        response = await drGreenRequest("/dapp/clients/bulk", "DELETE", { ids: clientIds }, adminEnvConfig);
        break;
      }
      
      // ==========================================
      // NEW ENDPOINTS FROM OFFICIAL DOCUMENTATION
      // ==========================================
      
      case "get-clients-summary": {
        // GET /dapp/clients/summary - Get client summary stats
        response = await drGreenRequestQuery("/dapp/clients/summary", {}, false, adminEnvConfig);
        break;
      }
      
      case "get-sales": {
        // GET /dapp/sales - Get sales data with filtering
        const { page, take, orderBy, search, searchBy, stage } = body || {};
        
        if (!validatePagination(page, take)) {
          throw new Error("Invalid pagination parameters");
        }
        
        const queryParams: Record<string, string | number> = {
          orderBy: orderBy || 'desc',
          take: take || 10,
          page: page || 1,
        };
        if (search) queryParams.search = String(search).slice(0, 100);
        if (searchBy) queryParams.searchBy = searchBy;
        if (stage && ['LEADS', 'ONGOING', 'CLOSED'].includes(stage)) {
          queryParams.stage = stage;
        }
        
        response = await drGreenRequestQuery("/dapp/sales", queryParams, false, adminEnvConfig);
        break;
      }
      
      case "get-sales-summary": {
        // GET /dapp/sales/summary - Get sales summary by stage
        response = await drGreenRequestQuery("/dapp/sales/summary", {}, false, adminEnvConfig);
        break;
      }
      
      // ==========================================
      // ADMIN CLIENT SYNC/IMPORT ENDPOINTS
      // ==========================================
      
      case "sync-client-by-email": {
        // Search Dr Green API for client by email and sync to local database
        const { email, localUserId } = body || {};
        
        if (!email || !validateEmail(email)) {
          throw new Error("Valid email is required for client sync");
        }
        
        logInfo(`Syncing client by email: ${email.slice(0,3)}***`);
        
        // Use list-and-filter approach (search/searchBy params not supported, 
        // and drGreenRequest signs body not query string for GET → 401)
        // Fetch all clients and filter by email locally, same as get-client-by-auth-email
        const PAGE_SIZE = 200;
        const MAX_PAGES = 3;
        let allClients: any[] = [];
        let matchedClient: any = null;
        
        for (let page = 1; page <= MAX_PAGES; page++) {
          const listResponse = await drGreenRequestQuery('/dapp/clients', { take: PAGE_SIZE, page, orderBy: 'desc' }, false, adminEnvConfig);
          
          if (!listResponse.ok) {
            const errorText = await listResponse.text();
            logError("Dr Green API client list failed", { status: listResponse.status, error: errorText.slice(0, 200) });
            return new Response(
              JSON.stringify({ 
                success: false, 
                error: `Dr Green API error: ${listResponse.status}`,
                message: "Could not search for client on Dr Green. Check API permissions.",
                apiStatus: listResponse.status
              }),
              { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
            );
          }
          
          const listData = await listResponse.json();
          // Handle various response shapes
          let clients: any[] = [];
          if (Array.isArray(listData.data)) {
            clients = listData.data;
          } else if (listData.data?.items && Array.isArray(listData.data.items)) {
            clients = listData.data.items;
          } else if (Array.isArray(listData.clients)) {
            clients = listData.clients;
          } else if (listData.data?.clients && Array.isArray(listData.data.clients)) {
            clients = listData.data.clients;
          }
          
          if (!clients.length) break;
          allClients = [...allClients, ...clients];
          
          // Check for match on this page
          const match = clients.find((c: any) => 
            c.email?.toLowerCase() === email.toLowerCase()
          );
          if (match) {
            matchedClient = match;
            logInfo(`Found client on page ${page}`, { clientId: match.id });
            break;
          }
          
          // Stop if we got fewer than PAGE_SIZE (last page)
          if (clients.length < PAGE_SIZE) break;
        }
        
        if (!matchedClient) {
          return new Response(
            JSON.stringify({ 
              success: false, 
              error: 'not_found',
              message: `No client found with email: ${email}`,
              searchResults: allClients.length
            }),
            { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
        
        logInfo("Found client on Dr Green", { 
          clientId: matchedClient.id || matchedClient.clientId,
          isKycVerified: matchedClient.isKYCVerified,
          adminApproval: matchedClient.adminApproval
        });
        
        // If localUserId provided, sync to local database
        if (localUserId) {
          const supabaseAdmin = createClient(
            Deno.env.get('SUPABASE_URL')!,
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
          );
          
          const clientId = matchedClient.id || matchedClient.clientId;
          const fullName = matchedClient.fullName || 
            `${matchedClient.firstName || ''} ${matchedClient.lastName || ''}`.trim();
          
          // Upsert to local drgreen_clients table
          const syncFields = {
            email: matchedClient.email,
            full_name: fullName || null,
            country_code: matchedClient.countryCode || matchedClient.country || 'PT',
            is_kyc_verified: matchedClient.isKYCVerified || false,
            admin_approval: matchedClient.adminApproval || 'PENDING',
            kyc_link: matchedClient.kycLink || null,
            updated_at: new Date().toISOString(),
          };
          
          // Check if record exists by drgreen_client_id
          const { data: existing } = await supabaseAdmin
            .from('drgreen_clients')
            .select('id, user_id')
            .eq('drgreen_client_id', clientId)
            .maybeSingle();
          
          let upsertError: any = null;
          let synced = true;
          if (existing) {
            // Update existing record — don't change user_id to avoid unique constraint violations
            const { error } = await supabaseAdmin
              .from('drgreen_clients')
              .update(syncFields)
              .eq('drgreen_client_id', clientId);
            upsertError = error;
          } else {
            // Check if this user_id already has a different client record (unique constraint on user_id)
            const { data: existingByUser } = await supabaseAdmin
              .from('drgreen_clients')
              .select('id, drgreen_client_id')
              .eq('user_id', localUserId)
              .maybeSingle();
            
            if (existingByUser) {
              // Admin already has a client linked — skip DB insert, just return API data
              // This happens during admin bulk-link where one admin verifies multiple clients
              logInfo("User already has a client record, skipping DB insert for this client", { 
                existingClientId: existingByUser.drgreen_client_id, newClientId: clientId 
              });
              synced = false;
            } else {
              // Insert new record
              const { error } = await supabaseAdmin
                .from('drgreen_clients')
                .insert({ ...syncFields, user_id: localUserId, drgreen_client_id: clientId });
              upsertError = error;
            }
          }
          
          if (upsertError) {
            logError("Failed to upsert client to local DB", { error: upsertError.message });
            return new Response(
              JSON.stringify({
                success: false,
                error: 'db_error',
                message: `Found client on Dr Green but failed to sync locally: ${upsertError.message}`,
                drGreenClient: matchedClient
              }),
              { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
            );
          }
          
          if (synced) {
            logInfo("Client synced to local database", { clientId, localUserId });
          }
          
          return new Response(
            JSON.stringify({
              success: true,
              message: synced ? "Client found and synced to local database" : "Client found on Dr Green (DB sync skipped — admin already has a linked client)",
              client: matchedClient,
              synced
            }),
            { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
          );
        }
        
        // No localUserId provided — just return API data
        return new Response(
          JSON.stringify({
            success: true,
            message: "Client found on Dr Green",
            client: matchedClient,
            synced: false
          }),
          { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders } }
        );
      }
      
      case "search-clients-drgreen": {
        // Search clients on Dr Green API without syncing
        // Uses list-and-filter approach (search/searchBy params cause 401)
        const { search: searchTerm, page: searchPage, take: searchTake } = body || {};
        
        if (!searchTerm || !validateStringLength(searchTerm, 100)) {
          throw new Error("Search term is required");
        }
        
        logInfo(`Searching Dr Green clients: ${searchTerm.slice(0,10)}***`);
        
        // Fetch all clients and filter locally
        const searchListResponse = await drGreenRequestQuery('/dapp/clients', { 
          take: 200, page: 1, orderBy: 'desc' 
        }, false, adminEnvConfig);
        
        if (!searchListResponse.ok) {
          response = searchListResponse;
          break;
        }
        
        const searchListData = await searchListResponse.json();
        let searchClients: any[] = [];
        if (Array.isArray(searchListData.data)) {
          searchClients = searchListData.data;
        } else if (searchListData.data?.items) {
          searchClients = searchListData.data.items;
        } else if (searchListData.data?.clients) {
          searchClients = searchListData.data.clients;
        } else if (Array.isArray(searchListData.clients)) {
          searchClients = searchListData.clients;
        }
        
        // Filter by search term (email or name)
        const searchLower = searchTerm.toLowerCase();
        const filtered = searchClients.filter((c: any) => 
          c.email?.toLowerCase().includes(searchLower) ||
          c.firstName?.toLowerCase().includes(searchLower) ||
          c.lastName?.toLowerCase().includes(searchLower) ||
          `${c.firstName} ${c.lastName}`.toLowerCase().includes(searchLower)
        );
        
        // Paginate results
        const startIdx = ((Number(searchPage) || 1) - 1) * (Number(searchTake) || 20);
        const endIdx = startIdx + (Number(searchTake) || 20);
        const paginatedResults = filtered.slice(startIdx, endIdx);
        
        response = new Response(JSON.stringify({
          data: { clients: paginatedResults, total: filtered.length }
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
        break;
      }
      
      case "get-client-orders": {
        // GET /dapp/orders with clientId query param (fixes 404 from old path-based endpoint)
        if (!validateClientId(body.clientId)) {
          throw new Error("Invalid client ID format");
        }
        const { page, take, orderBy } = body || {};
        
        if (!validatePagination(page, take)) {
          throw new Error("Invalid pagination parameters");
        }
        
        const queryParams: Record<string, string | number> = {
          clientId: body.clientId,
          orderBy: orderBy || 'desc',
          take: take || 10,
          page: page || 1,
        };
        
        response = await drGreenRequestQuery("/dapp/orders", queryParams, false, adminEnvConfig);
        break;
      }
      
      case "get-user-nfts": {
        // GET /dapp/users/nfts - Get user's owned NFTs
        response = await drGreenRequestQuery("/dapp/users/nfts", {}, false, adminEnvConfig);
        break;
      }
      
      // Diagnostic endpoint to compare all key formats across environments
      case "debug-compare-keys": {
        const envResults: Record<string, unknown> = {};
        
        for (const [envName, envConfig] of Object.entries(ENV_CONFIG)) {
          const envApiKey = Deno.env.get(envConfig.apiKeyEnv);
          const envPrivateKey = Deno.env.get(envConfig.privateKeyEnv);
          
          if (!envApiKey || !envPrivateKey) {
            envResults[envName] = { 
              configured: false, 
              apiKeyEnv: envConfig.apiKeyEnv,
              privateKeyEnv: envConfig.privateKeyEnv 
            };
            continue;
          }
          
          // Analyze key format
          let apiKeyFormat = 'unknown';
          let isPem = false;
          
          try {
            const decoded = base64ToBytes(envApiKey);
            const pemText = new TextDecoder().decode(decoded);
            isPem = pemText.includes('-----BEGIN');
            apiKeyFormat = isPem ? 'base64-encoded-pem' : 'raw-base64';
          } catch {
            apiKeyFormat = 'decode-error';
          }
          
          // Try a GET request with HMAC-SHA256 signing (the correct method)
          let testResult = 'untested';
          try {
            const testResp = await drGreenRequestGet(
              '/strains',
              { countryCode: 'ZAF', take: 1 },
              false,
              envConfig
            );
            testResult = testResp.ok ? 'SUCCESS' : `FAIL:${testResp.status}`;
          } catch (e) {
            testResult = `ERROR:${String(e).slice(0, 50)}`;
          }
          
          envResults[envName] = {
            configured: true,
            apiKeyEnv: envConfig.apiKeyEnv,
            apiKeyLength: envApiKey.length,
            apiKeyPrefix: envApiKey.slice(0, 12) + '...',
            isPem,
            apiKeyFormat,
            signingMethod: 'HMAC-SHA256',
            privateKeyLength: envPrivateKey.length,
            privateKeyPrefix: envPrivateKey.slice(0, 12) + '...',
            testResult,
          };
        }
        
        return new Response(JSON.stringify({
          action: 'debug-compare-keys',
          signingMethod: 'HMAC-SHA256',
          environments: envResults,
          timestamp: new Date().toISOString(),
        }, null, 2), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      
      // Diagnostic: test both signing methods side by side
      case "debug-signing-test": {
        const testEnv = body?.environment || 'production';
        const envConfig = ENV_CONFIG[testEnv] || ENV_CONFIG.production;
        const envApiKey = Deno.env.get(envConfig.apiKeyEnv);
        const envPrivateKey = Deno.env.get(envConfig.privateKeyEnv);
        
        if (!envApiKey || !envPrivateKey) {
          return new Response(JSON.stringify({
            error: `Credentials not configured for ${envConfig.name}`,
          }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
        }
        
        const queryParams = "orderBy=desc&take=1&page=1";
        const testUrl = `${envConfig.apiUrl}/strains?${queryParams}`;
        const results: Record<string, unknown> = {};
        
        // Method A: HMAC-SHA256 + raw apiKey + sign query string (health check approach)
        try {
          const hmacSig = await signWithHmac(queryParams, envPrivateKey);
          const hmacResp = await fetch(testUrl, {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              "x-auth-apikey": envApiKey,
              "x-auth-signature": hmacSig,
            },
          });
          const hmacBody = await hmacResp.text();
          results.methodA_hmac_querystring = {
            status: hmacResp.status,
            ok: hmacResp.ok,
            bodyPreview: hmacBody.slice(0, 200),
            signingData: queryParams,
            apiKeyUsed: 'raw',
          };
        } catch (e) {
          results.methodA_hmac_querystring = { error: String(e) };
        }
        
        // Method B: secp256k1 ECDSA + raw apiKey + sign "{}" (current proxy approach)
        try {
          const ecdsaSig = await generatePrivateKeySignature("{}", envPrivateKey);
          const ecdsaResp = await fetch(testUrl, {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              "x-auth-apikey": envApiKey,
              "x-auth-signature": ecdsaSig,
            },
          });
          const ecdsaBody = await ecdsaResp.text();
          results.methodB_ecdsa_empty = {
            status: ecdsaResp.status,
            ok: ecdsaResp.ok,
            bodyPreview: ecdsaBody.slice(0, 200),
            signingData: '{}',
            apiKeyUsed: 'raw',
          };
        } catch (e) {
          results.methodB_ecdsa_empty = { error: String(e) };
        }
        
        return new Response(JSON.stringify({
          action: 'debug-signing-test',
          environment: envConfig.name,
          testUrl,
          results,
          recommendation: 'Method A (HMAC-SHA256) is the correct approach per WordPress reference',
          timestamp: new Date().toISOString(),
        }, null, 2), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      default:
        return new Response(
          JSON.stringify({ error: "Unknown action", action }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
    }
    
    // NOTE: Supabase functions client treats non-2xx as an error and surfaces
    // "Edge function returned <status>". For admin dApp endpoints, a Dr. Green
    // upstream 401 is a *permissions/config* issue (not the user's session) and
    // should be returned as 200 with an explicit apiStatus so the UI can render
    // a stable message instead of erroring.
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      data = { raw: await response.text().catch(() => '') };
    }

    logInfo(`Response status: ${response.status}`);

    if (response.status === 401) {
      // Wrap upstream Dr. Green API 401s in a 200 response so the Supabase JS
      // client doesn't treat it as an edge function error. The UI can inspect
      // apiStatus to show a meaningful message.
      const usedEnv = envConfig;
      return new Response(
        JSON.stringify({
          success: false,
          apiStatus: 401,
          error: 'drgreen_unauthorized',
          message:
            `Dr. Green API credentials (${usedEnv.name}: ${usedEnv.apiKeyEnv}) are not authorized for this endpoint. The API key may lack permissions for this operation.`,
          upstream: data,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(JSON.stringify(data), {
      status: response.status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
    
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logError("Proxy error", { message });
    
    // Determine appropriate status code
    let statusCode = 500;
    if (message.includes('timed out')) {
      statusCode = 504; // Gateway Timeout
    } else if (message.includes('required') || message.includes('Invalid')) {
      statusCode = 400; // Bad Request
    } else if (message.includes('Unprocessable') || message.includes('422')) {
      statusCode = 422; // Unprocessable Entity (e.g., blurry ID)
    }
    
    return new Response(
      JSON.stringify({ 
        error: message,
        errorCode: statusCode === 422 ? 'DOCUMENT_QUALITY' : statusCode === 504 ? 'TIMEOUT' : 'SERVER_ERROR',
        retryable: statusCode !== 400,
        success: false
      }),
      { status: statusCode, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
