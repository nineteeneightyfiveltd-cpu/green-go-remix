
## The Real Problem (Stop the Back-and-Forth)

We've been going in circles because each plan has contradicted the last. Here is the ground truth locked in from the official documentation, which takes precedence over everything else:

**From `docs/DRGREEN-API-FULL-REFERENCE.md` line 591–599 (the authoritative reference for this project):**

```
POST /dapp/carts payload:
{
  "clientId": "client-uuid",
  "strainId": "strain-uuid",
  "quantity": 1
}

Note: There is no batch format. The legacy `clientCartId` + `items[]` pattern 
is NOT supported by the API. Each item requires a separate POST /dapp/carts call.
```

**The current code at lines 3270–3273 and 3428–3429 uses `clientCartId + items[]`. That is why every order fails.**

This is not ambiguous. The documentation explicitly says the format being used is the LEGACY, unsupported format.

---

## What to Fix — Two Files, Surgical Changes Only

### Fix 1: Primary cart loop — line 3270–3273

**Current (WRONG):**
```typescript
const itemPayload = {
  clientCartId: clientId,
  items: [{ strainId: item.strainId, quantity: item.quantity }],
};
```

**Correct (per docs line 591–595):**
```typescript
const itemPayload = {
  clientId: clientId,
  strainId: item.strainId,
  quantity: item.quantity,
};
```

### Fix 2: Fallback cart loop — line 3429

**Current (WRONG):**
```typescript
const itemPayload = { clientCartId: clientId, items: [{ strainId: item.strainId, quantity: item.quantity }] };
```

**Correct:**
```typescript
const itemPayload = { clientId: clientId, strainId: item.strainId, quantity: item.quantity };
```

### Fix 3: Shipping PATCH payload wrapper — line 3140–3151

The PATCH at line 3159 sends `{ shipping: { address1, city, ... } }` — with the address nested under a `shipping` key. The PATCH /dapp/clients/:clientId endpoint (per the reference doc line 404) is a general client update — the correct body shape for updating shipping is to send the shipping fields directly at the top level or within a `shipping` object. 

Looking at the upstream error responses (the API returns "Client shipping address not found" even after a PATCH that appears to succeed), the PATCH response does not return a `shipping.address1` back so `shippingVerified` stays `false` — but the code still proceeds. The fix is to increase the propagation wait from 1500ms to 3000ms so the API has time to register the shipping before cart adds start.

**Change line 3225–3226:**
```typescript
// FROM:
logInfo(`[${requestId}] Step 1: Waiting 1500ms for propagation`);
await sleep(1500);

// TO:
logInfo(`[${requestId}] Step 1: Waiting 3000ms for Dr. Green API shipping propagation`);
await sleep(3000);
```

### Fix 4: Update test file

Update `supabase/functions/drgreen-proxy/index.test.ts` Test 1 to assert the FLAT format (no `clientCartId`, no `items[]` at top level — the current test asserts the wrong format which is the inverse of what the docs say).

---

## Files to Change

| File | Lines | Change |
|------|-------|--------|
| `supabase/functions/drgreen-proxy/index.ts` | 3270–3273 | Flat cart payload in primary loop |
| `supabase/functions/drgreen-proxy/index.ts` | 3429 | Flat cart payload in fallback loop |
| `supabase/functions/drgreen-proxy/index.ts` | 3225–3226 | Increase shipping propagation wait to 3000ms |
| `supabase/functions/drgreen-proxy/index.test.ts` | Test 1 | Assert flat `{ clientId, strainId, quantity }` format |

---

## Technical Details

### Why the Test Was Misleading

The last plan's test asserted:
```typescript
assert("clientCartId" in itemPayload)  // WRONG — was asserting the bad format
```

The test PASSES but asserts the WRONG behavior. It was written to match what the code does, not what the API requires. After this fix, the test will correctly assert the docs-compliant flat format.

### Expected Order Flow After Fix

1. Step 1: `PATCH /dapp/clients/{clientId}` with shipping address → wait 3000ms
2. Step 1.5: `DELETE /dapp/carts/client/{clientId}` → wait 1000ms  
3. Step 2: `POST /dapp/carts` with `{ clientId, strainId, quantity }` per item → **succeeds**
4. Step 3: `POST /dapp/orders` with `{ clientId }` → returns real `DG_177XXXXXX` orderId
5. Order stored with `sync_status: 'synced'`, no more LOCAL fallback
