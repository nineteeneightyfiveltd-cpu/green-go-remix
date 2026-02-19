
## PHP Reference Analysis — Definitive Fix for Cart Payload

### What the PHP Source Code Proves

The working WordPress `dappAddToBasket` function sends this exact payload to `POST /dapp/carts`:

```php
$payload = [
  'items' => [
    ['quantity' => $qty, 'strainId' => $strainId]
  ],
  'clientCartId' => $basketId,   // <-- cart UUID from clientCart[0].id
];
```

And `dappEmptyBasket` clears with:
```php
// DELETE /dapp/carts/{basketId}     (cart UUID as the path param)
// body: ['cartId' => $basketId]
```

`dappClientRefresh` stores the cart ID as:
```php
update_user_meta($user->ID, "clientCart", $jsonData['data']['clientCart'][0]['id']);
```

And `dappPlaceOrder` creates the order with:
```php
$payload = ['clientId' => $clientID];
// POST /dapp/orders
```

### What the Proxy Currently Does — Three Errors

**Error 1 (Line 3322-3327 and 3485): Wrong cart payload shape**

```typescript
// CURRENT (WRONG):
const itemPayload = {
  clientId: clientId,      // wrong field name — should be clientCartId
  strainId: item.strainId, // wrong shape — items must be in an array
  quantity: item.quantity,
};
```

```typescript
// CORRECT (matching PHP):
const itemPayload = {
  items: [{ strainId: item.strainId, quantity: item.quantity }],
  clientCartId: clientCartId,   // cart UUID from clientCart[0].id
};
```

**Error 2 (Line 3288 and 3473): Wrong cart clear endpoint**

```typescript
// CURRENT (WRONG):
await drGreenRequest(`/dapp/carts/client/${clientId}`, "DELETE", ...)
```

```php
// CORRECT (from PHP):
// DELETE /dapp/carts/{cartUUID}   with body { cartId: basketId }
```

**Error 3 (Lines 3120-3145): `clientCartId` is extracted but never used**

`clientCheckResponse` fetches the client record which contains `clientCart[0].id`. The code reads `existingShipping` from it but never extracts the cart UUID. The cart UUID must be captured here and used in Step 2.

---

### The Fix — Five Changes to `drgreen-proxy/index.ts`

#### Change 1: Extract `clientCartId` from `clientCheckResponse` (after line 3145)

After the existing shipping check block that reads `clientCart` data, add extraction of the cart UUID:

```typescript
// Extract clientCartId from client record (PHP stores this as clientCart[0].id)
let clientCartId: string | null = null;
if (clientCheckResponse?.ok) {
  try {
    const cartData = await clientCheckResponse.clone().json();
    const cInner = cartData?.data || cartData;
    const cartArr = Array.isArray(cInner?.clientCart) ? cInner.clientCart : [];
    if (cartArr.length > 0 && cartArr[0]?.id) {
      clientCartId = cartArr[0].id;
      logInfo(`[${requestId}] Step 1: Got clientCartId from client record`, { 
        cartId: clientCartId.slice(0, 8) + '***' 
      });
    }
  } catch (cartIdErr) {
    logWarn(`[${requestId}] Step 1: Could not extract clientCartId`, { error: String(cartIdErr).slice(0, 100) });
  }
}
```

If `clientCartId` is still null after this (client not found or no cart), log a warning — the cart add will fail with the real API error which is more informative.

#### Change 2: Fix the cart clear endpoint (lines 3287-3295)

From PHP: `DELETE /dapp/carts/{cartUUID}` with body `{ cartId: basketId }`.

```typescript
// CORRECT: PHP uses DELETE /dapp/carts/{cartUUID} with { cartId: cartUUID } in body
if (clientCartId) {
  const emptyCartResponse = await drGreenRequestBody(
    `/dapp/carts/${clientCartId}`, 
    "DELETE", 
    { cartId: clientCartId }, 
    false, 
    adminEnvConfig
  );
  logInfo(`[${requestId}] Step 1.5: Cart clear result`, { status: emptyCartResponse.status });
} else {
  // Fallback: try the client-based endpoint if we don't have cart UUID
  const emptyCartResponse = await drGreenRequest(`/dapp/carts/client/${clientId}`, "DELETE", undefined, adminEnvConfig);
  logInfo(`[${requestId}] Step 1.5: Cart clear (fallback) result`, { status: emptyCartResponse.status });
}
```

#### Change 3: Fix cart payload in primary loop (lines 3322-3327)

```typescript
// CORRECT: PHP sends { items: [{ quantity, strainId }], clientCartId }
const itemPayload = {
  items: [{ strainId: item.strainId, quantity: item.quantity }],
  clientCartId: clientCartId || clientId,  // cart UUID; fallback to clientId if not found
};
```

#### Change 4: Fix cart payload in fallback loop (line 3485)

```typescript
// CORRECT: same shape as primary loop
const itemPayload = { 
  items: [{ strainId: item.strainId, quantity: item.quantity }], 
  clientCartId: clientCartId || clientId 
};
```

#### Change 5: Fix test assertion in `index.test.ts`

The current test at line ~42-44 asserts `clientCartId` must NOT be in payload. This is backwards. Fix to:

```typescript
assert("clientCartId" in itemPayload, "Cart payload must use clientCartId (PHP reference confirms this)");
assert("items" in itemPayload, "Cart payload must use items[] array (PHP: { items: [{ strainId, quantity }], clientCartId })");
assertFalse("clientId" in itemPayload, "Cart payload must NOT use clientId");
assertFalse("strainId" in itemPayload, "Cart payload must NOT have strainId at top level — it goes inside items[]");
```

---

### Files to Change

| File | Lines | Change |
|------|-------|--------|
| `supabase/functions/drgreen-proxy/index.ts` | After 3145 | Extract `clientCartId` from `clientCheckResponse` |
| `supabase/functions/drgreen-proxy/index.ts` | 3287-3295 | Fix cart clear to `DELETE /dapp/carts/{cartUUID}` with `{ cartId }` body |
| `supabase/functions/drgreen-proxy/index.ts` | 3322-3327 | Fix cart payload to `{ items: [{ strainId, quantity }], clientCartId }` |
| `supabase/functions/drgreen-proxy/index.ts` | 3485 | Fix fallback cart payload — same shape |
| `supabase/functions/drgreen-proxy/index.test.ts` | ~42-50 | Fix assertions to require `clientCartId` + `items[]`, reject `clientId` |

---

### Expected Flow After Fix

```text
1. findClientById → Benjamin found → clientCartId = "b0a6ca40-..." extracted
2. PATCH /dapp/clients/{clientId} with { shipping: { address1, city, ... } }
3. DELETE /dapp/carts/b0a6ca40-... with { cartId: "b0a6ca40-..." }
4. POST /dapp/carts with { items: [{ strainId, quantity }], clientCartId: "b0a6ca40-..." }
5. POST /dapp/orders with { clientId: "a4357132-..." }
6. Returns orderId → DB updated → order confirmed
```

This matches the PHP exactly. The cart UUID (`b0a6ca40-cfb3-4d56-9a39-aa2e094d290e`) was already visible in the live `get-client` response from the previous session — it just was never used.
