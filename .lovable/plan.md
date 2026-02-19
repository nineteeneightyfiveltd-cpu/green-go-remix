
## Diagnosis: Two Simultaneous Failures Causing Every Order to Fail

### What the Network Data Reveals

The order `779b03b4` has `sync_error: "Shipping address could not be verified. [SHIPPING_ADDRESS_REQUIRED] (Status 400)"`.

The `GET /client` API response (from the network log) shows:
```json
"shipping": {
  "country": "South Africa",
  "currency": "ZAR",
  "postalCode": "",
  "address1": "",
  "address2": "",
  "city": "",
  "state": "",
  "countryCode": "",
  "landmark": ""
}
```

The local DB has the correct full address (`123 Rivonia Road, Johannesburg, ZAF, 2148`). The DApp API has an empty shipping record. Dr. Green's API requires a verified shipping address to accept cart adds and order creation.

The reference WordPress site (`ricardo.drgreennft.com`) works because it successfully updates the client shipping address via PATCH before placing orders.

---

### Root Cause 1: Cart Payload Still Uses Wrong Format

Despite the previous plan claiming this was fixed, the proxy at lines 3264-3265 and 3421 still uses the old format:

```typescript
// CURRENT (wrong — from line 3264):
const itemPayload = {
  clientCartId: clientId,
  items: [{ strainId: item.strainId, quantity: item.quantity }],
};

// FALLBACK (also wrong — line 3421):
const itemPayload = { clientCartId: clientId, items: [{ strainId: item.strainId, quantity: item.quantity }] };
```

The Dr. Green API `POST /dapp/carts` requires the flat format:
```typescript
// CORRECT (per API docs and knowledge file):
{
  clientId: clientId,
  strainId: item.strainId,
  quantity: item.quantity,
}
```

This causes every cart add to return 400, preventing any order from being created.

### Root Cause 2: Shipping PATCH Silently Failing

The proxy Step 1 (`if (orderData.shippingAddress)`) does attempt a PATCH but the PATCH endpoint for updating client shipping is likely `PATCH /dapp/clients/{clientId}` with a specific body shape. If the body shape is wrong, the PATCH fails silently (logged as a warning but not blocking), the cart add then fails because shipping is still empty on Dr. Green's side, and the order is rejected with `SHIPPING_ADDRESS_REQUIRED`.

The shipping payload being sent (lines 3132–3154) needs to be verified and the endpoint may need to be `PATCH /dapp/clients/{clientId}/shipping` rather than `PATCH /dapp/clients/{clientId}`.

### Root Cause 3: The Checkout Correctly Detects Empty DApp Shipping and Falls Back to Local DB

The checkout `checkShippingAddress` flow:
- Priority 1: Calls `getClientDetails` → gets DApp shipping → empty address1 → FALLS THROUGH
- Priority 2: Uses local DB shipping (`123 Rivonia Road`) → sets as saved address

So the user SEES the correct address, passes it into `createOrder`, but the proxy PATCH to DApp fails → cart add fails → order fails.

---

### The Fix: Three Changes to `drgreen-proxy/index.ts`

**Fix 1: Cart payload — primary loop (line 3263-3266)**

```typescript
// BEFORE:
const itemPayload = {
  clientCartId: clientId,
  items: [{ strainId: item.strainId, quantity: item.quantity }],
};

// AFTER:
const itemPayload = {
  clientId: clientId,
  strainId: item.strainId,
  quantity: item.quantity,
};
```

**Fix 2: Cart payload — fallback loop (line 3421)**

```typescript
// BEFORE:
const itemPayload = { clientCartId: clientId, items: [{ strainId: item.strainId, quantity: item.quantity }] };

// AFTER:
const itemPayload = { clientId: clientId, strainId: item.strainId, quantity: item.quantity };
```

**Fix 3: Make shipping PATCH non-skippable when DApp shipping is empty**

Currently Step 1 pre-fetches the client and sets `existingShipping = true` if `shipping.address1` exists — which then SKIPS the PATCH. But the DApp has an empty shipping. The pre-check logic at line 3118 evaluates whether to skip the PATCH based on the response from `GET /dapp/clients/{clientId}`.

Since the DApp currently has empty shipping (`address1: ""`), the pre-check should NOT set `existingShipping = true`. However the logic at line 3115 checks `shippings[]` (an array from the API) and finds `{"country":"South Africa","currency":"ZAR"}` — which has no `address1` but IS truthy as an object — meaning the array-find might still match. We need to strictly check that `address1` is non-empty.

Change the existingShipping check to require a non-empty `address1`:
```typescript
// The shippings[] array check must also require address1 to be non-empty
const pluralShipping = Array.isArray(innerClientData.shippings)
  ? innerClientData.shippings.find((s: Record<string, unknown>) => s?.address1 && String(s.address1).trim())
  : null;
// Same for singular shipping
const singularShipping = innerClientData.shipping as Record<string, unknown> | null;
const shipping = (singularShipping?.address1 && String(singularShipping.address1).trim())
  ? singularShipping
  : pluralShipping;
```

**Fix 4: Add Deno test file for production enforcement and correct cart payload**

Create `supabase/functions/drgreen-proxy/index.test.ts` with tests that:
- Verify the cart payload shape is `{ clientId, strainId, quantity }` (no `clientCartId`, no `items[]`)
- Verify the `ADMIN_DEBUG_ONLY_ACTIONS` whitelist does NOT include patient actions (`create-order`, `get-orders`, `add-to-cart`, `get-my-details`)
- Verify all patient-facing proxy calls send `env: 'production'`

---

### Files to Change

| File | Change |
|---|---|
| `supabase/functions/drgreen-proxy/index.ts` | Fix 1: cart payload primary loop (line 3264-3265). Fix 2: cart payload fallback loop (line 3421). Fix 3: tighten existingShipping check to require non-empty address1. |
| `supabase/functions/drgreen-proxy/index.test.ts` | New: Deno test suite for production enforcement and cart payload assertions. |

### Expected Outcome After Fix

1. Patient clicks Place Order
2. Proxy Step 1: PATCH `/dapp/clients/{clientId}` with `{ address1: "123 Rivonia Road", city: "Johannesburg", ... }` — succeeds (was silently skipped before due to the pre-check truthy match on an address-less shippings[] entry)
3. Proxy Step 1.5: DELETE `/dapp/carts/client/{clientId}` — clears cart
4. Proxy Step 2: POST `/dapp/carts` with `{ clientId, strainId, quantity }` (flat format) — succeeds
5. Proxy Step 3: POST `/dapp/orders` with `{ clientId }` — succeeds, returns real `orderId` like `DG_177XXXXXX`
6. Order stored in DB with `sync_status: 'synced'`, `drgreen_order_id: 'DG_177...'`
7. Patient sees Order Confirmation, order appears in history matching the reference site format
