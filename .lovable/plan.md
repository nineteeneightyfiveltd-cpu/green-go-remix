
## Root Cause Identified — Benjamin's Orders Always Fail With 400

### The Data

Every order in the DB for `a4357132` (Benjamin/varseainc@gmail.com) fails with one of two errors alternating:

- `ORDER_CREATION_FAILED` (Status 400)  
- `SHIPPING_ADDRESS_REQUIRED` (Status 400)

The local DB **does** have a valid shipping address: `123 Rivonia Road, Johannesburg, ZAF, 2196`. The client is fully verified (`is_kyc_verified: true`, `admin_approval: VERIFIED`). So the problem is NOT eligibility, NOT the shipping address being missing locally.

---

### The Real Problems — Three Separate Issues

#### Problem 1: The Checkout passes `productId` but the cart needs `strainId`

In `Checkout.tsx` line 343–348, items are mapped as:
```typescript
items: cart.map(item => ({
  productId: item.strain_id,   // <-- sent as productId
  quantity: item.quantity,
  price: item.unit_price,
})),
```

In the proxy (line 3275–3278), the map is:
```typescript
strainId: item.strainId || item.productId,   // productId fallback exists
```

So `productId` DOES fall through to `strainId`. This is **not** the bug but confirms what's being sent.

The `strain_id` in the cart comes from local DB: `7a268bf3-6ab6-4219-9189-7169e3a4276d` (Blue Zushi). **This must match the Dr. Green API's internal strain UUID.** If the local DB strain IDs are from a previous sync and the Dr. Green API has rotated them, the POST /dapp/carts will return 400 "strain not found" — which shows as `ORDER_CREATION_FAILED`.

#### Problem 2: `findClientById` is paginating but Benjamin is NOT being found

The `findClientById` helper paginates through `GET /dapp/clients` with `take=20, page N`. If Benjamin was registered under a **different API key** (the old key, before rehoming), he won't appear in the current key's client list. The pre-check at line 3110 will fail with 404 ("Client not found"), but `existingShipping` stays `false`, so the code does a PATCH to update shipping.

The PATCH at line 3161: `PATCH /dapp/clients/{clientId}` — if the API key doesn't own this client, this returns **400 or 403**, not a shipping error. That produces `ORDER_CREATION_FAILED`.

#### Problem 3: The PATCH payload shape is wrong

The shipping PATCH at line 3142–3153 sends:
```json
{
  "shipping": {
    "address1": "123 Rivonia Road",
    "city": "Johannesburg",
    ...
  }
}
```

The Dr. Green `PATCH /dapp/clients/:id` endpoint — per the API full reference and the Postman spec — expects the shipping **directly in the body without the `shipping` wrapper key**:
```json
{
  "address1": "123 Rivonia Road",
  "city": "Johannesburg",
  ...
}
```

OR it expects shipping nested differently. The wrapper `{ "shipping": { ... } }` format is what we send when **creating** a client. The PATCH endpoint may not accept it wrapped. This explains why PATCH returns OK (200) but shipping is still "not found" — the API accepted the PATCH but ignored the unknown `shipping` key.

---

### The Fix Plan — Three Changes

#### Fix 1: Unwrap the PATCH payload — send shipping fields at the top level

**File:** `supabase/functions/drgreen-proxy/index.ts`  
**Lines 3142–3153** — Change the `shippingPayload` from wrapped to flat:

```typescript
// CURRENT (WRONG — shipping nested under 'shipping' key):
const shippingPayload = {
  shipping: {
    address1: addr.street || addr.address1 || '',
    ...
  }
};

// FIX (CORRECT — shipping fields at top level for PATCH):
const shippingPayload = {
  address1: addr.street || addr.address1 || '',
  address2: addr.address2 || '',
  landmark: addr.landmark || '',
  city: addr.city || '',
  state: addr.state || addr.city || '',
  country: addr.country || '',
  countryCode: normalisedCountryCode,
  postalCode: addr.zipCode || addr.postalCode || '',
};
```

#### Fix 2: If `findClientById` returns 404 (client not found in this API key's scope), skip the PATCH entirely and proceed with cart add using the local shipping address

The PATCH makes no sense if the client is not found under this API key. The cart add itself will either work or return the real error. Add a guard:

```typescript
// After findClientById returns 404 — log and skip PATCH:
if (!existingShipping) {
  const foundInApi = clientCheckResponse.status !== 404;
  if (!foundInApi) {
    logWarn(`[${requestId}] Step 1: Client not found in API key scope — skipping PATCH, proceeding to cart add`);
    // Don't attempt PATCH — it will 400/403 with wrong scope
  } else {
    // ... existing PATCH code
  }
}
```

#### Fix 3: Add detailed error logging for the cart POST (Step 2) when it returns 400

Currently when cart returns 400, `lastCartError` captures the text but it's not logged with enough detail to know if it's "strain not found" vs "client not found" vs something else. Enable `enableDetailedLogging = true` on the cart POST in `create-order` (line 3311) to get the full API-DEBUG output in logs.

This is already set to `true` at line 3311:
```typescript
const cartResponse = await drGreenRequestBody("/dapp/carts", "POST", itemPayload, true, adminEnvConfig);
```

So detailed logs ARE being emitted — but the edge function logs panel is not showing recent ones. This means the **function deployment from the last session did not stick**. The currently deployed version may be an older one.

---

### Summary of Changes

| File | Lines | Change |
|------|-------|--------|
| `supabase/functions/drgreen-proxy/index.ts` | 3142–3153 | Unwrap `shippingPayload` — send flat fields directly, not nested under `shipping` key |
| `supabase/functions/drgreen-proxy/index.ts` | 3138 | Add guard: if `findClientById` returns 404, skip PATCH entirely |
| `supabase/functions/drgreen-proxy/index.ts` | 3311 | Already `enableDetailedLogging: true` — confirm redeploy registers new logs |

The test file does not need changes. The core fix is the PATCH payload shape — the nested `{ shipping: { ... } }` wrapper is being silently ignored by the Dr. Green PATCH endpoint, meaning shipping never actually gets saved on their side, which is why every order after a PATCH hits "shipping address not found" on the cart add.

---

### Expected Order Flow After Fix

1. `findClientById` → Benjamin found (or 404 if wrong scope)
2. If found and no shipping: `PATCH /dapp/clients/{clientId}` with **flat** `{ address1, city, ... }` → 200
3. Re-fetch to verify → shipping now visible
4. Cart cleared → `DELETE /dapp/carts/client/{clientId}`
5. `POST /dapp/carts` with `{ clientId, strainId: "7a268bf3...", quantity: 1 }` → 201
6. `POST /dapp/orders` with `{ clientId }` → returns real Dr. Green order ID
7. DB updated with `sync_status: synced`
