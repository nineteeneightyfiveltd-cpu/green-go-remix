
## Definitive Root Cause — Now Confirmed

### Problem 1: The shipping pre-check uses `GET /dapp/clients/:clientId` which returns 401

At line 3108, the proxy calls:
```typescript
const clientCheckResponse = await drGreenRequestQuery(`/dapp/clients/${clientId}`, {}, false, adminEnvConfig);
```

But the comment at line 2502 in the SAME file says: **"GET /dapp/clients/{id} returns 401"** — which is why `findClientById()` exists as an alternative that pages through the client list.

When `clientCheckResponse.ok` is false (401), the catch at line 3132 fires with "will attempt PATCH". That's correct behavior. But then the PATCH at line 3159 runs. Let's trace what the PATCH response looks like.

### Problem 2: The PATCH response shape doesn't match what the code expects

The code at line 3185-3189 expects:
```typescript
const returnedShipping = responseData?.data?.shipping || responseData?.shipping;
if (returnedShipping && returnedShipping.address1) {
  shippingVerified = true;
}
```

If the PATCH returns `{ success: true, data: { id: "...", ... } }` without a `shipping` field echoed back, `shippingVerified` stays `false`. The code still proceeds to cart add. If the PATCH actually worked, there'd be a propagation delay before the API registers the shipping.

### Problem 3: `shippingVerified = false` + "shipping address not found" triggers the wrong error

Because `shippingVerified` stays `false` AND the cart add fails with "shipping address not found", the code enters the retry loop at line 3304-3308 with progressively longer waits (1.5s, 3s) — still against an API that may not have propagated the shipping yet.

### Problem 4: No verification that PATCH actually registered on Dr. Green's side

After the PATCH, there is no second call to confirm the shipping was stored. The code assumes the PATCH worked (even if response body doesn't confirm it) and proceeds. If the Dr. Green API has a propagation delay for PATCH → cart add, the retries are not waiting long enough.

### Problem 5: `add-to-cart` standalone case still uses `clientCartId + items[]`

Line 2964-2966:
```typescript
const cartPayload = {
  clientCartId: clientId,
  items: [{ strainId: cartData.strainId, quantity: cartData.quantity }],
};
```

This is the standalone action (not `create-order`). The `create-order` flow correctly uses flat format. But `add-to-cart` standalone is wrong. This is a secondary issue — it doesn't block order placement but should be fixed for consistency.

---

## The Fix — Four Targeted Changes to `drgreen-proxy/index.ts`

### Fix 1: Replace the broken `GET /dapp/clients/:clientId` pre-check with `findClientById()`

**Current code (line 3107-3131) — broken:**
```typescript
const clientCheckResponse = await drGreenRequestQuery(`/dapp/clients/${clientId}`, {}, false, adminEnvConfig);
if (clientCheckResponse.ok) {
  const clientData = await clientCheckResponse.clone().json();
  ...
}
```

**Replace with `findClientById()` which paginates through client list (the correct approach):**
```typescript
const clientCheckResponse = await findClientById(clientId, adminEnvConfig);
if (clientCheckResponse.ok) {
  const clientData = await clientCheckResponse.clone().json();
  ...
}
```

This is a one-line change. `findClientById` returns the same response shape (`{ success: true, data: client }`), so the `clientData?.data` parsing at line 3111 works identically.

### Fix 2: After the PATCH succeeds, re-verify shipping via `findClientById()` instead of trusting the PATCH response body

After line 3184 (PATCH returned ok), instead of just checking `responseData?.data?.shipping`, do a re-fetch:
```typescript
} else {
  // PATCH returned 200 — verify shipping was registered by re-fetching client
  logInfo(`[${requestId}] Step 1: PATCH returned 200, verifying shipping was registered...`);
  try {
    const verifyResponse = await findClientById(clientId, adminEnvConfig);
    if (verifyResponse.ok) {
      const verifyData = await verifyResponse.clone().json();
      const innerData = verifyData?.data || verifyData;
      const verifiedShipping = innerData?.shipping || 
        (Array.isArray(innerData?.shippings) 
          ? innerData.shippings.find((s: any) => s?.address1?.trim()) 
          : null);
      if (verifiedShipping?.address1?.trim()) {
        logInfo(`[${requestId}] Step 1: Shipping CONFIRMED on Dr. Green side`, { city: verifiedShipping.city });
        shippingVerified = true;
      } else {
        logWarn(`[${requestId}] Step 1: PATCH 200 but shipping NOT yet visible on Dr. Green — will wait`);
      }
    }
  } catch (verifyErr) {
    logWarn(`[${requestId}] Step 1: Post-PATCH verify failed`, { error: String(verifyErr).slice(0, 100) });
  }
}
```

### Fix 3: Increase the shipping wait from 1.5–3s to 5s when shipping is NOT verified

The current wait is:
```typescript
const shippingWait = existingShipping ? 1500 : 3000;
```

Change to:
```typescript
const shippingWait = shippingVerified ? 0 : (existingShipping ? 2000 : 5000);
```

- If shipping was verified on Dr. Green: no extra wait (we confirmed it's there)
- If shipping already existed: 2s wait
- If PATCH was done but not confirmed: 5s wait to let the API propagate

### Fix 4: Fix `add-to-cart` standalone payload (line 2964-2966)

Change:
```typescript
const cartPayload = {
  clientCartId: clientId,
  items: [{ strainId: cartData.strainId, quantity: cartData.quantity }],
};
```

To (matching the `create-order` flow and the official docs):
```typescript
const cartPayload = {
  clientId: clientId,
  strainId: cartData.strainId,
  quantity: cartData.quantity,
};
```

---

## Files to Change

| File | Lines | Change |
|------|-------|--------|
| `supabase/functions/drgreen-proxy/index.ts` | 3107-3108 | Replace `drGreenRequestQuery(/dapp/clients/:id)` with `findClientById()` |
| `supabase/functions/drgreen-proxy/index.ts` | 3184-3189 | Replace PATCH response trust with `findClientById()` re-verification |
| `supabase/functions/drgreen-proxy/index.ts` | 3225 | Increase shipping wait: 0ms if verified, 2s if existed, 5s if unconfirmed |
| `supabase/functions/drgreen-proxy/index.ts` | 2964-2966 | Fix `add-to-cart` standalone payload to flat format |
| `supabase/functions/drgreen-proxy/index.test.ts` | Test 1 | Update to assert flat format for `add-to-cart` |

---

## Why This Will Work

The core loop has been: PATCH fires → response doesn't confirm shipping → code proceeds immediately → Dr. Green rejects cart add with "shipping not found" → shipping error displayed.

With the fix:
1. `findClientById()` pre-check correctly determines whether shipping exists (no more 401)
2. After PATCH 200, re-fetch confirms shipping is live on Dr. Green side
3. If confirmed: no wait needed, cart add proceeds with verified shipping
4. If not confirmed: 5s wait gives the API more propagation time

The cart payload format in `create-order` is already correct (flat `{ clientId, strainId, quantity }`). The only secondary fix needed is the standalone `add-to-cart` case.

---

## Technical Note: No Frontend Changes Required

The `Checkout.tsx` correctly passes `shippingAddress` with `address1`, `city`, `postalCode`, `countryCode`. The DB record for `a4357132` shows the correct address. The fix is purely in the edge function.
