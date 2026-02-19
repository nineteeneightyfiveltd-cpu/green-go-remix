
## RESOLVED: Cart Payload Format — `clientCartId + items[]`

The Dr. Green API `POST /dapp/carts` requires the nested format:

```json
{
  "clientCartId": "client-uuid",
  "items": [{ "strainId": "strain-uuid", "quantity": 1 }]
}
```

All three call sites in `drgreen-proxy/index.ts` have been updated to use this format:
1. Primary `create-order` cart loop (was flat `{ clientId, strainId, quantity }`)
2. Fallback cart loop (same fix)
3. `add-to-cart` action — clientId extraction fixed to also check `body.clientId`

Tests: 4/4 passing. Deployed to production.

## Expected Order Flow

1. `DELETE /dapp/carts/client/{clientId}` — clears stale cart ✅
2. `POST /dapp/carts` with `{ clientCartId, items: [{ strainId, quantity }] }` — **now correct** ✅
3. `POST /dapp/orders` with `{ clientId }` — succeeds ✅
4. Order gets real `DG_177XXXXXX` orderId, no LOCAL fallback ✅
