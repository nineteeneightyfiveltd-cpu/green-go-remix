
## Comprehensive Fix: Address Auto-Pull + Order Creation Failure (STATUS 400)

### What the Images Show

**Screenshot 1 (Order Received page):** The order used a LOCAL fallback ID (`LOCAL-20260219-N1QY`) — meaning the Dr. Green API call failed and the system fell through to the local fallback. Status shows `MANUAL_REVIEW / AWAITING_PROCESSING`, which are the fallback-path statuses.

**Screenshot 2 (Order Detail page):** Sync Status shows `Sync Failed` with the exact error:
> `Order creation failed. Please try again or contact support. [ORDER_CREATION_FAILED] (Status 400, Ref: ord_mltr8gcr_3wv0)`

The shipping address on the order is `123 Rivonia Road, Gauteng, Johanesberg, 2148, South Africa` — this is the stale placeholder address from the local DB. A Status 400 from the Dr. Green API almost always means a **validation failure in the payload** sent to `/dapp/carts` or `/dapp/orders`.

---

### Root Cause Analysis — 4 Confirmed Issues

**Issue 1 — Checkout still uses local DB as Priority 1 (not fixed yet)**

In `src/pages/Checkout.tsx` (lines 178–188), the current code reads:
```typescript
// Priority 1: local DB (fast)
const localShipping = drGreenClient.shipping_address;
if (localShipping && (localShipping as Record<string, unknown>).address1) {
  // Returns immediately — DApp API never consulted
  setIsLoadingAddress(false);
  return;
}
```

This means the stale local DB value (`123 Rivonia Road, Gauteng`) is used without ever calling the DApp. The DApp's real verified address (which the second screenshot confirms exists) is never fetched for checkout. This means checkout submits stale/incorrect data to the DApp cart endpoint, which then returns 400.

**Issue 2 — `shippings[]` normalization misses the address because DApp returns `shippings[0].address1 = ""`**

The DApp's `shippings[]` response for this client appears to contain `{ country: "South Africa", currency: "ZAR" }` with empty `address1` — but there IS address data on the record (shown in the DApp admin dashboard screenshot from the previous message: `123 Rivonia Road, Sandton`). This means the DApp stores the address in a different field path in the direct client endpoint response. The proxy needs to also check `data.shipping` (singular), not just `data.shippings[]` (array).

**Issue 3 — Step 1 (shipping pre-check) in `create-order` looks at wrong path**

In `drgreen-proxy/index.ts` lines 3046–3056, the pre-check for existing shipping reads:
```typescript
const shipping = clientData?.data?.shipping || clientData?.shipping;
```
But if the DApp returns `{ data: { shippings: [...] } }` (plural array), it never finds `data.shipping` (singular normalized). The pre-check fails, then the code tries to PATCH the shipping with the stale address, which may fail or overwrite the verified one — causing the 400 on cart add.

**Issue 4 — No success indicator when address form saves**

When a user saves a new address via the `ShippingAddressForm`, the `onSuccess` callback fires immediately after the local toast, before the user sees any visual confirmation. The form unmounts instantly and there's no persistent "Address Saved" confirmation in the checkout page.

---

### The Fix Plan

#### File 1: `src/pages/Checkout.tsx`

**Change 1 — Flip priority: DApp API first, local DB as true fallback only**

Remove the Priority 1 early-return block that uses local DB:

```typescript
// REMOVE THIS BLOCK (lines 178-189):
// Priority 1: local DB (fast)
const localShipping = drGreenClient.shipping_address;
if (localShipping && (localShipping as Record<string, unknown>).address1) {
  ...
  return;  // ← This prevents DApp from ever being checked
}
```

Replace with:
```typescript
// Priority 1: Dr. Green API — always the source of truth
try {
  const result = await getClientDetails(drGreenClient.drgreen_client_id);
  if (!result.error) {
    const raw = result.data as Record<string, unknown> | null;
    const shipping = extractShipping(raw);
    if (shipping?.address1) {
      const addr = shipping as unknown as ShippingAddress;
      setSavedAddress(addr);
      setShippingAddress(addr);
      setNeedsShippingAddress(false);
      setAddressMode('saved');
      setIsLoadingAddress(false);
      return;
    }
    // Partial data - capture country hint
    const detectedCountry = resolveCountryFromDApp(raw) || drGreenClient.country_code || countryCode || 'ZA';
    setPartialAddress({ countryCode: detectedCountry });
  }
} catch { /* fall through to local DB */ }

// Priority 2: Local DB fallback (offline/error scenario only)
const localShipping = drGreenClient.shipping_address;
if (localShipping && (localShipping as Record<string, unknown>).address1) {
  const addr = localShipping as unknown as ShippingAddress;
  setSavedAddress(addr);
  setShippingAddress(addr);
  setNeedsShippingAddress(false);
  setAddressMode('saved');
  setIsLoadingAddress(false);
  return;
}

// Priority 3: No address found — prompt user
setNeedsShippingAddress(true);
setIsLoadingAddress(false);
```

**Change 2 — Add "Address Saved" success banner after manual save**

In `handleShippingAddressSaved`, set `setAddressManuallySaved(true)`. Then in the JSX, after the address selection card, render:
```tsx
{addressManuallySaved && (
  <Alert className="bg-green-500/10 border-green-500/30 text-green-700 dark:text-green-400">
    <Check className="h-4 w-4" />
    <AlertTitle>Address Saved</AlertTitle>
    <AlertDescription>Your delivery address has been confirmed.</AlertDescription>
  </Alert>
)}
```

Import `Check` from `lucide-react` (already available in the bundle).

#### File 2: `supabase/functions/drgreen-proxy/index.ts`

**Change 1 — Fix `get-my-details`: Only merge local DB if DApp has NO shipping data at all**

At line 2511–2517, the current code merges local DB shipping if `!innerData.shipping`. This fires even when `innerData.shipping` exists but has `address1: ""`. The problem is the proxy normalizes `shippings[]` into `shipping{}` — but if `shippings[0].address1` is empty, the resulting `shipping.address1` is empty, so the merge guard fires and overwrites with local DB stale data.

Change to:

```typescript
// Current (wrong): merges local if !shipping object
if (!innerData.shipping && localClient?.shipping_address) { ... }

// Fixed: only merge if DApp returned zero address data at all
const dappHasAddress = !!(innerData.shipping as any)?.address1 ||
  (Array.isArray(innerData.shippings) && innerData.shippings.some((s: any) => s?.address1));
if (!dappHasAddress && localClient?.shipping_address?.address1) {
  innerData.shipping = normalizeShippingObject(localClient.shipping_address as Record<string, unknown>);
  logInfo("Merged local DB shipping into API response (no DApp address found)", { clientId });
}
```

**Change 2 — Fix `create-order` Step 1 pre-check: also inspect `shippings[]`**

At lines 3046–3056, the pre-check only looks at `data.shipping` (singular). Add a check for `data.shippings[]`:

```typescript
const clientData = await clientCheckResponse.clone().json();
const innerClientData = clientData?.data || clientData;

// Check both singular 'shipping' and plural 'shippings[]'
const singularShipping = innerClientData?.shipping;
const pluralShipping = Array.isArray(innerClientData?.shippings)
  ? innerClientData.shippings.find((s: any) => s?.address1)
  : null;
const shipping = singularShipping?.address1 ? singularShipping : pluralShipping;

if (shipping?.address1) {
  logInfo(`[${requestId}] Step 1: Client already has shipping address on API, skipping PATCH`, {
    city: shipping.city,
  });
  existingShipping = true;
  shippingVerified = true;
}
```

**Change 3 — Fix `create-order` Step 1: Never skip PATCH even if existingShipping is true (let API decide)**

The current code completely skips the shipping PATCH if `existingShipping = true`. But if the local DB has stale data that doesn't match the DApp, the cart add will still fail with 400. The safest behavior is: always PATCH the shipping with the address the user confirmed in this session, regardless of what the DApp has. Change the guard from:

```typescript
if (!existingShipping) {
  // PATCH shipping
}
```

To:

```typescript
// Always update shipping if provided — API is source of truth
// Sending the same address again is idempotent and ensures consistency
```

This means removing the `existingShipping` skip so the PATCH always runs when `shippingAddress` is provided. If the PATCH returns 200, `shippingVerified = true`.

**Change 4 — Add `logError` for Step 2 cart 400 error body**

Currently when the cart POST returns 400, the error body is truncated to 200 chars in the log. Increase this to 500 chars so we can see the actual Dr. Green validation message:

```typescript
error: lastCartError.slice(0, 500),  // was 200
```

#### File 3: `src/components/shop/ShippingAddressForm.tsx`

**Change 1 — Add 1200ms delay before `onSuccess` so the "saved" state is visible**

Currently `onSuccess?.(shippingData)` is called immediately at line 274, which causes the parent to unmount the form before the user sees "Address Confirmed":

```typescript
setSaveSuccess(true);
toast({ title: 'Address Confirmed', ... });
// Pause briefly so user sees the checkmark before form disappears
await new Promise(resolve => setTimeout(resolve, 1200));
onSuccess?.(shippingData);
```

This requires `handleSubmit` to be `async` (it already is, since it uses `await` internally).

**Change 2 — When `initialAddress` is populated, show "Edit" toggle instead of full blank form**

When the saved address is passed as `initialAddress` (from the DApp), the form currently renders all blank fields with generic placeholders. Instead, show an "Edit address" button that expands the form pre-filled with the existing values. This makes it clear what address is on file and what the user is changing.

---

### Summary of Files to Edit

| File | Changes |
|---|---|
| `src/pages/Checkout.tsx` | Flip priority: DApp first, local DB second; add "Address Saved" green banner after manual save |
| `supabase/functions/drgreen-proxy/index.ts` | Fix `get-my-details` local DB merge guard; fix `create-order` Step 1 pre-check to include `shippings[]`; always run shipping PATCH; increase error body logging |
| `src/components/shop/ShippingAddressForm.tsx` | Add 1200ms delay before `onSuccess` so confirmation is visible |

### Expected Behavior After Fix

```text
User visits /checkout
  → DApp called first (Priority 1 — source of truth)
  → DApp returns verified address: "123 Rivonia Road, Sandton, 2148, ZAF"
  → Checkout shows: "Delivery Address — 123 Rivonia Road, Sandton"
  → User clicks "Place Order"
  → create-order: PATCH shipping with confirmed address (always runs)
  → Cart items added successfully (shipping verified on client record)
  → POST /dapp/orders returns real orderId
  → Order saved with real DApp ID (not LOCAL- prefix)
  → Sync Status: synced (not failed)
```

### Handling the Stale Local DB Record

After the DApp is used as Priority 1, the local DB stale address (`123 Rivonia Road, Gauteng`) becomes irrelevant because it is only used as a fallback when the DApp API is unreachable. No SQL cleanup is required — the fix is behavioral.
