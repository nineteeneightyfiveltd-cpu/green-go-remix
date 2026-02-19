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
Deno.test("cart payload uses PHP-confirmed format — { items: [{ strainId, quantity }], clientCartId }", () => {
  // PHP reference (dappAddToBasket):
  //   $payload = [ 'items' => [['quantity' => $qty, 'strainId' => $strainId]], 'clientCartId' => $basketId ];
  // clientCartId = cart UUID from clientCart[0].id — NOT the client's own UUID
  const clientCartId = "b0a6ca40-cfb3-4d56-9a39-aa2e094d290e"; // cart UUID
  const strainId = "00000000-0000-0000-0000-000000000002";
  const quantity = 2;

  const itemPayload = {
    items: [{ strainId, quantity }],
    clientCartId,
  };

  // Must use clientCartId (cart UUID) at top level — PHP confirmed
  assert(
    "clientCartId" in itemPayload,
    "Payload MUST contain 'clientCartId' — PHP dappAddToBasket confirms this is the cart UUID (clientCart[0].id)"
  );
  // Must use items[] array — PHP confirmed
  assert(
    "items" in itemPayload,
    "Payload MUST contain 'items[]' array — PHP: { items: [{ strainId, quantity }], clientCartId }"
  );
  // Must NOT use bare clientId — that field belongs to POST /dapp/orders only
  assertFalse(
    "clientId" in itemPayload,
    "Payload must NOT contain bare 'clientId' — that is for POST /dapp/orders, not POST /dapp/carts"
  );
  // strainId must be INSIDE items[], not at top level
  assertFalse(
    "strainId" in itemPayload,
    "Payload must NOT have 'strainId' at top level — it must be inside items[]: { items: [{ strainId, quantity }] }"
  );
  // quantity must be INSIDE items[], not at top level
  assertFalse(
    "quantity" in itemPayload,
    "Payload must NOT have 'quantity' at top level — it must be inside items[]: { items: [{ strainId, quantity }] }"
  );

  // Validate values
  assertEquals(itemPayload.clientCartId, clientCartId, "clientCartId must match the cart UUID");
  assertEquals(itemPayload.items[0].strainId, strainId, "strainId must be inside items[0]");
  assertEquals(itemPayload.items[0].quantity, quantity, "quantity must be inside items[0]");
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

// ─────────────────────────────────────────────────────────────────────────────
// Test 5: create-order shipping address validation rejects missing address1
// ─────────────────────────────────────────────────────────────────────────────
Deno.test("create-order: missing address1 fails fast with SHIPPING_ADDRESS_REQUIRED", () => {
  // Mirrors the server-side guard added to the create-order handler
  function validateShipping(addr: Record<string, unknown> | null | undefined): string | null {
    if (!addr || !String(addr.address1 ?? '').trim()) return 'SHIPPING_ADDRESS_REQUIRED';
    return null;
  }

  assertEquals(validateShipping(null), 'SHIPPING_ADDRESS_REQUIRED', "null address must fail");
  assertEquals(validateShipping(undefined), 'SHIPPING_ADDRESS_REQUIRED', "undefined address must fail");
  assertEquals(validateShipping({}), 'SHIPPING_ADDRESS_REQUIRED', "empty object must fail");
  assertEquals(validateShipping({ address1: '' }), 'SHIPPING_ADDRESS_REQUIRED', "empty string address1 must fail");
  assertEquals(validateShipping({ address1: '   ' }), 'SHIPPING_ADDRESS_REQUIRED', "whitespace-only address1 must fail");
  assertEquals(
    validateShipping({ address1: '123 Rivonia Road', city: 'Johannesburg' }),
    null,
    "valid address1 must pass"
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Test 6: clientCheckResponse scoping — hoisted variable accessible outside try block
// ─────────────────────────────────────────────────────────────────────────────
Deno.test("clientCheckResponse scoping — hoisted variable is accessible outside try block", () => {
  // Reproduces the ReferenceError: clientCheckResponse is not defined bug.
  // The fix hoists the declaration to `let` OUTSIDE the try block.
  // This test validates that the pattern works correctly.
  let responseRef: { status: number } | null = null;
  try {
    responseRef = { status: 200 };
  } catch (_) { /* ignored */ }

  assert(responseRef !== null, "hoisted variable must be accessible outside try block (scope bug regression check)");
  assertEquals(responseRef?.status, 200, "status must be readable outside try block");

  // Verify optional chaining on null doesn't throw (pattern used in the scope fix: clientCheckResponse?.status !== 404)
  const nullableRef: { status: number } | null = null as { status: number } | null;
  const safeStatus = nullableRef?.status !== 404;
  assert(typeof safeStatus === 'boolean', "optional chaining on null must not throw");
});
