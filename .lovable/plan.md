
## Fix Plan: Order 400 Error + Infinite Re-render Loop + Product Skeleton

### Three Confirmed Root Causes

**Bug 1 — Wrong Cart Clear Endpoint (Causes Status 400 on Orders)**

The Postman workspace and the API endpoint reference both confirm:
- `DELETE /dapp/carts/{cartItemId}` — deletes ONE specific cart item by its item UUID
- `DELETE /dapp/carts/client/{clientId}` — wipes the ENTIRE cart for a client

The proxy currently calls `DELETE /dapp/carts/${clientId}` in **three places**. The Dr. Green client ID (e.g. `a4357132-7e8c-4c8a-b005-6f818b3f173e`) is NOT a cart item ID, so the API either 404s or ignores it silently. The cart is never cleared. When Step 2 then fires `POST /dapp/carts` with the new strain, the API finds a stale item already in the cart and returns **400** (duplicate/conflict).

Locations in `drgreen-proxy/index.ts`:
- Line 3167: Step 1.5 initial clear
- Line 3228: 409 conflict retry clear
- Line 3349: Fallback flow clear

All three must change from `/dapp/carts/${clientId}` to `/dapp/carts/client/${clientId}`.

**Bug 2 — Infinite Re-render Loop in Checkout (Causes Product Skeleton & Edge Function Flood)**

In `src/pages/Checkout.tsx` line 241:
```tsx
useEffect(() => {
  checkShippingAddress();
}, [drGreenClient, getClientDetails, addressManuallySaved, countryCode]);
```

`getClientDetails` is a function created inside `useDrGreenApi()`. Every re-render creates a new function reference. React sees the dependency changed → runs the effect → sets state (`setSavedAddress`) → triggers re-render → new `getClientDetails` reference → runs effect again. Infinite loop.

The console screenshots (image-3, image-4) confirm `[Checkout] Full shipping address from DApp API` firing dozens of times per second between 18:10:27 and 18:10:32. This floods the Edge Function with `get-my-details` calls, saturating cold-start capacity and starving the `get-strains-legacy` call — which is why products sit on a skeleton.

Fix: Remove `getClientDetails` and `countryCode` from deps. Depend only on `drGreenClient?.drgreen_client_id` and `addressManuallySaved`. Add a `hasFetchedAddressRef` to ensure the effect only runs once per mount, not once per render.

**Bug 3 — No Timeout on Product Fetch (Infinite Skeleton UX)**

`useProducts.ts` has no timeout. If the Edge Function is slow (due to Bug 2 flooding it) or cold-starting, `isLoading` stays `true` forever. Add a 15-second `Promise.race` timeout so the user gets a "Try Again" button instead of a stuck skeleton.

---

### Postman Knowledge Applied

From the Postman workspace screenshots and the Orders collection:

**Create an Order** — `POST /dapp/orders`
- Payload: `{ "clientId": "..." }` only — items must already be in the server-side cart
- Response 201: `{ data: { id, status, createdAt, totalAmount } }`
- Common 400 causes confirmed: cart not cleared before add, stale items, signature mismatch, inactive client

**Cart operations** (confirmed by Postman):
- Add item: `POST /dapp/carts` with `{ clientId, strainId, quantity }`
- Clear client cart: `DELETE /dapp/carts/client/{clientId}` — this is the correct wipe endpoint
- Delete single item: `DELETE /dapp/carts/{cartItemId}` — takes the cart ITEM UUID, not client UUID

**Get All Cart Items** — `GET /dapp/carts?orderBy=desc&take=10&page=1&search=&searchBy=clientName`

**Get All Orders** — `GET /dapp/orders?orderBy=desc&take=10&page=1&adminApproval=PENDING&clientIds=[]`

The `clientIds=[]` as a literal empty array in the query string is a known 400 cause confirmed by Postman — the proxy should omit this param when empty.

---

### Fix Implementation

#### File 1: `supabase/functions/drgreen-proxy/index.ts`

**Change 1 — Line 3164 comment (cosmetic, for correctness):**
Remove the wrong comment that says `Correct endpoint: DELETE /dapp/carts/{clientId}` — it is incorrect.

**Change 2 — Line 3167 (Step 1.5):**
```typescript
// BEFORE (wrong — treats clientId as a cart item ID):
const emptyCartResponse = await drGreenRequest(`/dapp/carts/${clientId}`, "DELETE", undefined, adminEnvConfig);

// AFTER (correct — wipes entire cart for this client):
const emptyCartResponse = await drGreenRequest(`/dapp/carts/client/${clientId}`, "DELETE", undefined, adminEnvConfig);
```

Increase the sleep after Step 1.5 from 500ms to 1000ms to give the API time to process the deletion.

**Change 3 — Line 3228 (409 conflict retry):**
```typescript
// BEFORE:
await drGreenRequest(`/dapp/carts/${clientId}`, "DELETE", undefined, adminEnvConfig);

// AFTER:
await drGreenRequest(`/dapp/carts/client/${clientId}`, "DELETE", undefined, adminEnvConfig);
```

**Change 4 — Line 3349 (fallback flow):**
```typescript
// BEFORE:
await drGreenRequest(`/dapp/carts/${clientId}`, "DELETE", undefined, adminEnvConfig);

// AFTER:
await drGreenRequest(`/dapp/carts/client/${clientId}`, "DELETE", undefined, adminEnvConfig);
```

#### File 2: `src/pages/Checkout.tsx`

**Change 1 — Add `hasFetchedAddressRef` and fix the useEffect dependency array (lines 165-241):**

```tsx
// Add at top of component, with other state/refs:
const hasFetchedAddressRef = useRef(false);

// Replace the useEffect:
useEffect(() => {
  // Only run once per mount / per clientId change
  if (hasFetchedAddressRef.current) return;
  if (addressManuallySaved) {
    setIsLoadingAddress(false);
    return;
  }
  if (!drGreenClient?.drgreen_client_id) {
    setIsLoadingAddress(false);
    return;
  }
  hasFetchedAddressRef.current = true;
  checkShippingAddress();
}, [drGreenClient?.drgreen_client_id, addressManuallySaved]);
// ^^^^ KEY: depend on the string VALUE only, not the function reference
```

Also add `useRef` to the imports on line 1.

**Change 2 — Reset the ref when address is manually saved** so re-fetching still works after the user saves a new address:

In `handleShippingAddressSaved`, add:
```tsx
hasFetchedAddressRef.current = false;
```

#### File 3: `src/hooks/useProducts.ts`

**Change 1 — Add 15-second Promise.race timeout:**

```typescript
const PRODUCT_FETCH_TIMEOUT_MS = 15000;

// Wrap the supabase.functions.invoke call:
const fetchPromise = supabase.functions.invoke('drgreen-proxy', {
  body: {
    action: 'get-strains-legacy',
    countryCode: alpha3Code,
    orderBy: 'desc',
    take: 100,
    page: 1,
  },
});

const timeoutPromise = new Promise<{ data: null; error: { message: string } }>((_, reject) =>
  setTimeout(() => reject(new Error('Product loading timed out. Please tap "Try Again".')), PRODUCT_FETCH_TIMEOUT_MS)
);

const { data, error: fnError } = await Promise.race([fetchPromise, timeoutPromise]);
```

---

### Expected Outcome After All Three Fixes

**Order creation:**
```
User places order
  → Step 1: DApp has shipping — skip PATCH (confirmed by pre-check)
  → Step 1.5: DELETE /dapp/carts/client/{clientId} → 200 OK (cart wiped)
              sleep(1000ms)
  → Step 2: POST /dapp/carts { clientId, strainId, quantity } → 201 Created
  → Step 3: POST /dapp/orders { clientId } → real orderId returned
  → Order saved with real Dr. Green ID (not LOCAL-*)
```

**Checkout page:**
```
User arrives at /checkout
  → useEffect fires once (hasFetchedAddressRef = true)
  → checkShippingAddress() called once
  → savedAddress set from DApp API (one call)
  → No further re-renders triggered by getClientDetails reference change
  → Zero repeated API calls
```

**Products:**
```
User loads /shop
  → get-strains-legacy fires immediately with countryCode
  → If responds in < 15s: products render normally
  → If takes > 15s: user sees "Try Again" button (not infinite skeleton)
  → With checkout loop fixed, Edge Function is no longer flooded
  → Products should load in 2-5s normally
```

### Files to Change Summary

| File | Lines | Change |
|---|---|---|
| `supabase/functions/drgreen-proxy/index.ts` | 3163-3168 | Fix Step 1.5 cart clear: `/dapp/carts/${clientId}` → `/dapp/carts/client/${clientId}`, sleep 500→1000 |
| `supabase/functions/drgreen-proxy/index.ts` | 3225-3232 | Fix 409 retry cart clear: same endpoint fix |
| `supabase/functions/drgreen-proxy/index.ts` | 3347-3352 | Fix fallback cart clear: same endpoint fix |
| `src/pages/Checkout.tsx` | 1, ~167, 241 | Add `useRef` import, `hasFetchedAddressRef`, fix dependency array |
| `src/pages/Checkout.tsx` | ~258 | Reset ref in `handleShippingAddressSaved` |
| `src/hooks/useProducts.ts` | ~128-141 | Add 15-second Promise.race timeout |
