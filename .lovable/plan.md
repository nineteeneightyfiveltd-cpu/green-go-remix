## ✅ COMPLETED — Cart Payload + Shipping Address Fix

All three root causes fixed and deployed. All 4 Deno tests pass.

### Changes Made

| File | Change |
|---|---|
| `supabase/functions/drgreen-proxy/index.ts` | Fix 1: Cart payload primary loop → flat `{ clientId, strainId, quantity }`. Fix 2: Cart payload fallback loop → same flat format. Fix 3: `existingShipping` check now requires non-empty `address1` (previously matched empty `{country, currency}` objects). |
| `supabase/functions/drgreen-proxy/index.test.ts` | New: 4 Deno tests — cart payload shape, patient action whitelist exclusion, shipping address check logic, localStorage isolation. |

### Test Results (all passing)
- ✅ `cart payload uses flat format — no clientCartId or items[]`
- ✅ `patient actions are excluded from ADMIN_DEBUG_ONLY_ACTIONS whitelist`
- ✅ `existingShipping check requires non-empty address1`
- ✅ `useDrGreenApi.ts does not read environment from localStorage`

### Expected Order Flow (post-fix)
1. PATCH `/dapp/clients/{clientId}` with full shipping — now runs (was previously skipped due to false positive on empty shippings[])
2. DELETE `/dapp/carts/client/{clientId}` — clears cart
3. POST `/dapp/carts` with `{ clientId, strainId, quantity }` — now correct flat format
4. POST `/dapp/orders` with `{ clientId }` — succeeds, returns real `DG_177XXXXXX` order ID
