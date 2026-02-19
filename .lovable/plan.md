
## Root Cause: Definitive — The Dr. Green API Requires `clientCartId + items[]`, NOT Flat Format

The direct API test call just revealed the exact upstream error:

```
"items must contain at least 1 elements, clientCartId must be a UUID, 
clientCartId must be a string, clientCartId should not be empty"
```

This means all previous "fixes" were wrong. The DRGREEN_API_FULL_REFERENCE.md doc said to use `{ clientId, strainId, quantity }` but the **actual live Dr. Green API** requires the older format:

```json
{
  "clientCartId": "client-uuid",
  "items": [{ "strainId": "strain-uuid", "quantity": 1 }]
}
```

The previous plan inverted the format, and every fix since has made it worse. The original (pre-fix) `add-to-cart` case was actually closer to correct.

---

## Two Changes Needed

### Change 1: `create-order` cart payload — revert to `clientCartId + items[]`

In `supabase/functions/drgreen-proxy/index.ts`:

**Primary loop (lines 3269-3274):** Change back from flat to nested:
```typescript
// WRONG (current):
const itemPayload = {
  clientId: clientId,
  strainId: item.strainId,
  quantity: item.quantity,
};

// CORRECT (what the real API demands):
const itemPayload = {
  clientCartId: clientId,
  items: [{ strainId: item.strainId, quantity: item.quantity }],
};
```

**Fallback loop (line 3430):** Same fix:
```typescript
// WRONG (current):
const itemPayload = { clientId: clientId, strainId: item.strainId, quantity: item.quantity };

// CORRECT:
const itemPayload = { clientCartId: clientId, items: [{ strainId: item.strainId, quantity: item.quantity }] };
```

### Change 2: `add-to-cart` standalone action — also uses `clientCartId + items[]`

The `add-to-cart` case at line 2963-2967 already uses the right format (`clientCartId + items[]`) but has a bug in how `clientId` is extracted from the request — it reads from `body.data.clientId`, but `body.clientId` is passed. Fix the extraction to also check `body.clientId`:

```typescript
const clientId = cartData.clientId || cartData.cartId || body.clientId;
```

### Change 3: Log the upstream error body for `fallback-cart-add`

Currently the proxy logs `lastCartError` which is the raw text, but the final error message sent to the frontend doesn't include the upstream detail. The `upstream` field is already returned in the JSON response (`lastStepError.slice(0, 300)`). No code change needed here — the upstream error is already visible in the response.

### Change 4: Update the test file to reflect the real API format

`supabase/functions/drgreen-proxy/index.test.ts` — update the cart payload test to assert the correct `clientCartId + items[]` format (the test was asserting the opposite and would have been misleading).

---

## Files to Change

| File | Change |
|---|---|
| `supabase/functions/drgreen-proxy/index.ts` | Revert cart payload in `create-order` primary loop and fallback loop to `{ clientCartId, items: [{strainId, quantity}] }`. Fix `add-to-cart` clientId extraction. |
| `supabase/functions/drgreen-proxy/index.test.ts` | Update cart payload test to assert `clientCartId + items[]` format. |

---

## Why This Will Work

The `upstream` field in the API response proves beyond doubt what format the API requires. The secp256k1 signing is working (production 200s come back). The cart clear (`DELETE /dapp/carts/client/{clientId}`) works. The order creation (`POST /dapp/orders { clientId }`) will work once items are in the cart. The only blocker is the cart add payload format.

After this fix:
1. `DELETE /dapp/carts/client/{clientId}` — clears stale cart (already working)
2. `POST /dapp/carts` with `{ clientCartId: clientId, items: [{ strainId, quantity }] }` — **will now succeed**
3. `POST /dapp/orders` with `{ clientId }` — will succeed
4. Order gets a real `DG_177XXXXXX` orderId
5. No more LOCAL fallback
