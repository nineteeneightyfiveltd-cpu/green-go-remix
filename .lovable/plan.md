
# Checkout Endpoint Fixes — Combined Implementation Plan

## What the Audit Found

### Issue 1 — `orderId` is never extracted from the Dr. Green response (CRITICAL)

**Where:** `supabase/functions/drgreen-proxy/index.ts`, lines 3272 and 3355

**What happens:** When the order creation succeeds (`response.ok` is true), the code executes `break`, which exits the switch and falls to the generic bottom handler at line 4801. That handler calls `response.json()` and returns the raw Dr. Green JSON unchanged. The Dr. Green API response shape is:

```json
{ "data": { "id": "real-uuid", "status": "PENDING", ... } }
```

But `Checkout.tsx` line 277 checks:
```typescript
orderResult.data?.orderId  // → undefined (raw response has no top-level orderId)
```

Since `orderId` is always `undefined`, the condition `if (orderResult.error || !orderResult.data?.orderId)` always throws `"Failed to create order"`, even when Dr. Green actually created the order successfully. This is why every order has a `LOCAL-*` ID despite the API call completing.

**Fix:** Replace `break` at lines 3272 and 3355 with an explicit `return new Response(...)` that extracts `orderId` from the Dr. Green response before sending it to the frontend:

```typescript
// Extract orderId from Dr. Green's nested response
const rawOrderData = await response.clone().json();
const orderId = 
  rawOrderData?.data?.id || 
  rawOrderData?.data?.orderId || 
  rawOrderData?.orderId || 
  rawOrderData?.id || 
  null;

return new Response(JSON.stringify({
  success: true,
  orderId,
  status: rawOrderData?.data?.status || 'PENDING',
  totalAmount: rawOrderData?.data?.totalAmount || rawOrderData?.data?.total || 0,
  createdAt: rawOrderData?.data?.createdAt || new Date().toISOString(),
  requestId,
}), { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 });
```

This applies at **both** success exit points (main path line 3272 and fallback path line 3355).

---

### Issue 2 — `create-payment` and `get-payment` always fail (CRITICAL)

**Where:** `supabase/functions/drgreen-proxy/index.ts` lines 3468–3479; `src/pages/Checkout.tsx` lines 284–325

**What happens:** After order creation, the checkout immediately calls `createPayment()` which sends `POST /dapp/payments` to the Dr. Green API. This endpoint is not in the Dr. Green API. It returns a 404 or 405 — causing `paymentResult.error` to be set, which throws `"Failed to initiate payment"` and triggers the `LOCAL-*` fallback.

Even if the payment call somehow passed, there is a polling loop (lines 305–325) that waits up to 15 seconds checking `/dapp/payments/{id}` — another non-existent endpoint.

**Fix:** Remove `createPayment` and `getPayment` from `Checkout.tsx`. After order creation returns a real `orderId`, complete the checkout immediately:
- Save the order locally with `status: 'PENDING'` and `payment_status: 'AWAITING_PAYMENT'`
- Clear the cart
- Show the order confirmation

Payment confirmation will arrive via webhook (`drgreen-webhook` edge function already handles this) or via admin action in the Dr. Green portal.

---

## Files to Change

| # | File | Change |
|---|------|--------|
| 1 | `supabase/functions/drgreen-proxy/index.ts` | Replace `break` at line 3272 with explicit `return new Response(...)` that extracts `orderId` |
| 2 | `supabase/functions/drgreen-proxy/index.ts` | Replace `break` at line 3355 with the same explicit `return new Response(...)` |
| 3 | `src/pages/Checkout.tsx` | Remove `createPayment` / `getPayment` polling block (lines 284–325); complete checkout at order creation |

---

## Technical Details

### What the proxy returns today vs what it should return

**Today (broken):**
```
Dr. Green API response → break → generic bottom handler → returns raw JSON as-is
{ "data": { "id": "real-uuid", "status": "PENDING" } }
```

**After fix:**
```
Dr. Green API response → normalised return directly from case block
{ "success": true, "orderId": "real-uuid", "status": "PENDING", ... }
```

### Checkout flow after fix

```text
handlePlaceOrder()
  → createOrder() via proxy   ← 3-step atomic: shipping + cart + order
      → returns { success: true, orderId: "real-uuid" }
  → saveOrder() locally       ← status: PENDING, payment_status: AWAITING_PAYMENT
  → clearCart()
  → setOrderComplete(true)    ← confirmation screen shown
  → sendOrderConfirmationEmail() (fire-and-forget)
```

No payment polling. No blocking. Order confirmed immediately when Dr. Green returns success.

---

## What Stays the Same

- The 3-step atomic order flow (shipping PATCH → cart add → order POST) is correct and stays unchanged
- The `LOCAL-*` fallback logic remains for genuine failures (network errors, 500s)
- The `retryOperation` wrapper stays — it handles transient errors gracefully
- The `useShopSafe` fix in Header stays (already applied, no change needed)
- The `toAlpha3()` normalisation in the shipping payload stays (already applied, no change needed)

---

## Expected Outcome After Fix

1. `create-order` succeeds → proxy returns `{ success: true, orderId: "real-uuid" }`
2. `Checkout.tsx` reads `orderResult.data.orderId` → it is now set → no `"Failed to create order"` exception
3. Order is saved to `drgreen_orders` with the real `drgreen_order_id` (not `LOCAL-*`)
4. User sees "Order Submitted" confirmation immediately
5. `drgreen_orders` table will show real Dr. Green order IDs for all new orders

The edge function is redeployed automatically after the proxy change.
