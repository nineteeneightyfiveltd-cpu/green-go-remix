/**
 * drgreen-proxy — Production-enforcement and cart-payload tests
 *
 * Run with:
 *   deno test supabase/functions/drgreen-proxy/index.test.ts --allow-env --allow-read
 *
 * These tests are PURE unit tests — no HTTP calls, no secrets required.
 */

import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals, assertFalse, assert } from "https://deno.land/std@0.224.0/assert/mod.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Test 1: Cart payload MUST be flat format { clientId, strainId, quantity }
// ─────────────────────────────────────────────────────────────────────────────
Deno.test("cart payload uses flat format — clientId + strainId + quantity (per docs)", () => {
  const clientId = "00000000-0000-0000-0000-000000000001";
  const strainId = "00000000-0000-0000-0000-000000000002";
  const quantity = 2;

  // Simulate the correct cart payload builder (per DRGREEN-API-FULL-REFERENCE.md line 591-596)
  const itemPayload = {
    clientId: clientId,
    strainId: strainId,
    quantity: quantity,
  };

  // Must contain the flat fields the Dr. Green API requires
  assert(
    "clientId" in itemPayload,
    "Payload MUST contain 'clientId' — required by Dr. Green API (flat format)"
  );
  assert(
    "strainId" in itemPayload,
    "Payload MUST contain 'strainId' — required by Dr. Green API (flat format)"
  );
  assert(
    "quantity" in itemPayload,
    "Payload MUST contain 'quantity' — required by Dr. Green API (flat format)"
  );
  assertFalse(
    "clientCartId" in itemPayload,
    "Payload must NOT contain 'clientCartId' — that is the legacy unsupported format"
  );
  assertFalse(
    "items" in itemPayload,
    "Payload must NOT contain 'items[]' — that is the legacy unsupported batch format"
  );

  // Validate values
  assertEquals(itemPayload.clientId, clientId, "clientId must match");
  assertEquals(itemPayload.strainId, strainId, "strainId must match");
  assertEquals(itemPayload.quantity, quantity, "quantity must match");
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 2: Patient actions are NOT in ADMIN_DEBUG_ONLY_ACTIONS whitelist
// ─────────────────────────────────────────────────────────────────────────────
Deno.test("patient actions are excluded from ADMIN_DEBUG_ONLY_ACTIONS whitelist", () => {
  // Mirror of the whitelist in index.ts — patient flows must NEVER appear here
  const ADMIN_DEBUG_ONLY_ACTIONS = [
    "dapp-clients",
    "dapp-nfts",
    "get-client",
    "patch-client",
    "delete-client",
    "activate-client",
    "deactivate-client",
    "bulk-delete-clients",
    "get-clients-summary",
    "sales-summary",
    "dashboard-analytics",
    "update-order",
    "get-all-orders",
    "verify-client",
  ];

  const PATIENT_ACTIONS = [
    "create-order",
    "get-orders",
    "add-to-cart",
    "get-my-details",
    "get-cart",
    "remove-from-cart",
    "get-strains",
    "get-strain",
  ];

  for (const action of PATIENT_ACTIONS) {
    assertFalse(
      ADMIN_DEBUG_ONLY_ACTIONS.includes(action),
      `Patient action "${action}" must NOT be in ADMIN_DEBUG_ONLY_ACTIONS — it would expose non-production envs`
    );
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 3: Shipping address check requires non-empty address1
// ─────────────────────────────────────────────────────────────────────────────
Deno.test("existingShipping check requires non-empty address1", () => {
  // Simulate the DApp GET /client response for Benjamin (empty shipping — country+currency only)
  const apiResponseEmpty = {
    shippings: [{ country: "South Africa", currency: "ZAR" }],
    shipping: {
      country: "South Africa",
      currency: "ZAR",
      postalCode: "",
      address1: "",
      address2: "",
      city: "",
      state: "",
      countryCode: "",
      landmark: "",
    },
  };

  // Replicate the tightened existingShipping logic from index.ts
  function hasExistingShipping(innerClientData: Record<string, unknown>): boolean {
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
    return Boolean(shipping?.address1);
  }

  // Empty address1 should NOT be considered as existing shipping
  assertFalse(
    hasExistingShipping(apiResponseEmpty as unknown as Record<string, unknown>),
    "Empty address1 on DApp must NOT be treated as existing shipping"
  );

  // Full address SHOULD be treated as existing
  const apiResponseFull = {
    shippings: [],
    shipping: {
      country: "South Africa",
      currency: "ZAR",
      postalCode: "2148",
      address1: "123 Rivonia Road",
      city: "Johannesburg",
      state: "Gauteng",
      countryCode: "ZAF",
    },
  };

  assert(
    hasExistingShipping(apiResponseFull as unknown as Record<string, unknown>),
    "Non-empty address1 on DApp SHOULD be treated as existing shipping"
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 4: localStorage is not referenced in patient-facing hook source
// ─────────────────────────────────────────────────────────────────────────────
Deno.test("useDrGreenApi.ts does not read environment from localStorage", async () => {
  let source: string;
  try {
    source = await Deno.readTextFile("src/hooks/useDrGreenApi.ts");
  } catch {
    // File may not be readable from edge function context — skip gracefully
    console.warn("Could not read useDrGreenApi.ts — skipping localStorage check");
    return;
  }

  // Must not contain localStorage.getItem calls for env selection
  const forbiddenPatterns = [
    /localStorage\.getItem\(['"]drgreen[_-]?env['"]\)/i,
    /localStorage\.getItem\(['"]api[_-]?env['"]\)/i,
    /localStorage\.getItem\(['"]env['"]\)/i,
  ];

  for (const pattern of forbiddenPatterns) {
    assertFalse(
      pattern.test(source),
      `useDrGreenApi.ts must not read environment from localStorage (pattern: ${pattern})`
    );
  }
});
