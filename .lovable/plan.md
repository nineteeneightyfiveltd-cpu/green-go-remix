
# Real-Time Order Confirmation + Webhook-Driven Status Updates

## What We're Building

Two things that work together:

1. **Enhanced Order Confirmation Screen** — After checkout, instead of a static "Order Confirmed" card, the user sees a live status panel showing the real Dr. Green `orderId`, the current status (`PENDING → PROCESSING → PAID`), and a real-time status tracker that updates automatically when the Dr. Green webhook fires.

2. **Realtime Status Subscription in OrderDetail** — The existing `/orders/:orderId` page gets a live Supabase Realtime subscription so status badges and the timeline update in-place the moment the webhook updates the database row — no refresh needed.

---

## Why This Works End-to-End

The pipeline already exists:

```text
Dr. Green API fires webhook
  → drgreen-webhook edge function (already written)
      → updates drgreen_orders.status / payment_status in DB
          → Supabase Realtime broadcasts the DB change
              → UI receives UPDATE event → re-renders status instantly
```

The only missing pieces are:
- Realtime is not enabled for `drgreen_orders` (no `ALTER PUBLICATION` migration)
- The checkout confirmation screen is static (no live subscription)
- `OrderDetail` uses one-shot `useQuery` with no realtime listener

---

## Changes Required

### 1. Database Migration — Enable Realtime on `drgreen_orders`

A new migration that adds `drgreen_orders` to the Supabase Realtime publication:

```sql
ALTER PUBLICATION supabase_realtime ADD TABLE public.drgreen_orders;
```

This is the single enabler. Without it, no amount of frontend subscription code will receive live updates. The existing RLS policies already protect per-user visibility, so realtime inherits those rules safely.

---

### 2. New Component — `OrderConfirmation.tsx`

**File:** `src/components/shop/OrderConfirmation.tsx`

A self-contained component that:

- Accepts `orderId` (Dr. Green ID or `LOCAL-*`) and `isLocalOrder` as props
- Subscribes to `postgres_changes` on `drgreen_orders` filtered to `drgreen_order_id = orderId`
- Displays:
  - Animated success icon (green checkmark for real orders, amber clock for local)
  - Dr. Green order ID in monospace, clearly labelled
  - Live status badge that updates when webhook fires: `PENDING → PROCESSING → PAID → SHIPPED → DELIVERED`
  - Live payment status badge
  - A minimal inline timeline (4 steps: Placed → Processing → Payment → Delivered)
  - "View Full Order Details" button linking to `/orders/{localRowId}`
  - "Continue Shopping" button
- Shows a subtle "Status updated just now" pulse animation when status changes
- Handles `LOCAL-*` orders gracefully (no live subscription, shows manual review messaging)

The component uses the same `postgres_changes` pattern already in `useOrderTracking.ts`, making it consistent with existing patterns.

---

### 3. Update `Checkout.tsx` — Replace Static Confirmation with `OrderConfirmation`

**File:** `src/pages/Checkout.tsx`

Current state (lines 421–498): Static card with orderId text and two buttons.

Changes:
- Store the local DB row `id` (UUID from `saveOrder` return value) in addition to `drgreen_order_id` — needed to link to `/orders/:id`
- Replace the entire static `orderComplete` JSX block with `<OrderConfirmation>` — the component handles both real and local orders
- Pass `orderId`, `localRowId`, and `isLocalOrder` to the component

`saveOrder` already returns the inserted row including the UUID `id`. We just need to capture it: `const savedOrder = await saveOrder(...)` then `setLocalRowId(savedOrder.id)`.

---

### 4. Update `OrderDetail.tsx` — Add Realtime Subscription

**File:** `src/pages/OrderDetail.tsx`

Current state: Uses `useQuery` (one-time fetch, no live updates).

Changes:
- Add a `useEffect` that subscribes to `postgres_changes` on `drgreen_orders` with filter `id=eq.${orderId}`
- On UPDATE event, call `queryClient.invalidateQueries(['order-detail', orderId])` to refetch and re-render
- Show a subtle "Live" indicator dot (green pulse) next to the order ID when the subscription is active
- Add a `useQueryClient` import
- Clean up the subscription on unmount

This makes the timeline and status badges update automatically when Dr. Green sends a `payment.completed` or `order.shipped` webhook — the user sees it live without refreshing.

---

### 5. Update `drgreen-webhook/index.ts` — Broadcast Realtime on Order Updates

**File:** `supabase/functions/drgreen-webhook/index.ts`

Current state (lines 702–713): Updates `drgreen_orders` but does NOT broadcast to Realtime channel.

The `ALTER PUBLICATION` migration in step 1 handles DB-level realtime for `postgres_changes`. However, the webhook also sends inventory updates via a Supabase Realtime broadcast channel (`stock-updates`). We should add a matching broadcast for order updates so that any component listening on a channel (not just `postgres_changes`) also gets notified:

```typescript
// After the DB update succeeds (line 714):
const orderChannel = supabase.channel('order-updates');
await orderChannel.send({
  type: 'broadcast',
  event: 'order-change',
  payload: {
    orderId: payload.orderId,
    status: updates.status || null,
    payment_status: updates.payment_status || null,
    event: payload.event,
  },
});
```

This is additive — it does not change existing behavior, it just adds a broadcast that the `OrderConfirmation` component can also listen to as a fallback.

---

## Component Design — `OrderConfirmation`

```text
┌─────────────────────────────────────────┐
│  ✅  Order Confirmed                    │
│                                         │
│  Order ID                               │
│  ┌─────────────────────────────────┐    │
│  │  3f8a-c2b1-...  [PENDING] [AWAITING] │
│  └─────────────────────────────────┘    │
│                                         │
│  ──●────────────────────────────────    │
│  Placed  Processing  Payment  Delivered │
│                                         │
│  ℹ Payment is handled by our team.     │
│    You'll receive an email when         │
│    your payment is confirmed.           │
│                                         │
│  [View Order Details]  [Continue Shopping] │
└─────────────────────────────────────────┘
```

Status badges use the same color system as `OrderDetail` (green/blue/amber/red). The timeline dots animate forward automatically when status changes are received from Realtime.

---

## Files Changed

| # | File | Type | Change |
|---|------|------|--------|
| 1 | `supabase/migrations/` | New migration | `ALTER PUBLICATION supabase_realtime ADD TABLE drgreen_orders` |
| 2 | `src/components/shop/OrderConfirmation.tsx` | New component | Live order status panel with Realtime subscription |
| 3 | `src/pages/Checkout.tsx` | Edit | Capture `localRowId` from `saveOrder`, replace static confirmation with `<OrderConfirmation>` |
| 4 | `src/pages/OrderDetail.tsx` | Edit | Add `postgres_changes` subscription + "Live" indicator |
| 5 | `supabase/functions/drgreen-webhook/index.ts` | Edit | Broadcast `order-change` event after DB update |

No new secrets, no new tables, no auth changes required.
