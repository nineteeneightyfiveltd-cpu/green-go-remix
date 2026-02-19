
## Root Cause: Wrong Environment Key Poisons All Order Calls

### What Is Actually Happening

The logs show the error is not the cart endpoint URL — it is a key parsing failure that prevents any API call from being made at all:

```
[Error] secp256k1: Failed to extract private key { error: "Error: Expected SEQUENCE" }
[Error] Proxy error { message: "Failed to parse secp256k1 private key: Error: Expected SEQUENCE" }
```

The decoded key is only **24 bytes** (`decodedLength: 24`). A valid secp256k1 private key requires 32 raw bytes minimum, or ~88 bytes for SEC1 DER format, or ~138 bytes for PKCS#8 DER. 24 bytes is not a parseable key structure.

### Why It Is Using the Wrong Key

The `ApiEnvironmentContext` stores the user-selected environment in `localStorage` under `hb-api-environment`. Admin settings let you switch between `production` and `railway`. 

`useDrGreenApi.ts` line 39:
```typescript
const env = overrideEnv || getCurrentEnvironment(); // reads localStorage
```

Then line 42:
```typescript
body: { action, env, ...data }  // sends env: "railway" to proxy
```

The proxy line 379–382:
```typescript
railway: {
  apiUrl: 'https://budstack-backend-main-development.up.railway.app/api/v1',
  apiKeyEnv: 'DRGREEN_STAGING_API_KEY',
  privateKeyEnv: 'DRGREEN_STAGING_PRIVATE_KEY',  // ← broken key, 24 bytes
}
```

So when the browser has `railway` in localStorage (set by whoever last touched Admin Settings), **every** patient-facing action — including cart clear, cart add, and order creation — uses the staging private key. That key is corrupted/truncated and throws before even making an HTTP request to Dr. Green.

The `sync-strains` function works because it is a separate Edge Function that reads `DRGREEN_API_KEY` + `DRGREEN_PRIVATE_KEY` directly, bypassing the environment selector entirely.

### The Fix: Two-Layer Isolation

**Layer 1 — Force `production` on all patient-facing proxy calls (the fast fix)**

In `src/hooks/useDrGreenApi.ts`, the `callProxy` function currently passes whatever is in localStorage as `env`. Patient-facing actions (`create-order`, `add-to-cart`, `get-orders`, `create-payment`, `get-my-details`, `update-shipping`, etc.) must always run against `production` regardless of what the admin selector has set.

Change: pass `overrideEnv: 'production'` as the third argument to `callProxy` for all non-admin actions. Admin comparison/testing tools can continue using the context value.

**Layer 2 — Proxy-side guard: never use railway for order/cart/payment actions**

In `supabase/functions/drgreen-proxy/index.ts`, add an explicit safeguard in the `create-order`, `add-to-cart`, and `create-payment` case blocks: if `requestedEnv === 'railway'`, override to `production` and log a warning. This means even if client-side code ever passes railway again, the proxy rejects it for transactional operations.

**Layer 3 — Admin Settings UI: warn that railway is for admin tools only**

In `src/pages/AdminSettings.tsx`, add a visible notice that the environment selector only affects Admin Tools (test runner, comparison dashboard) and has no effect on patient checkout or orders.

---

### Files to Change

| File | Change |
|---|---|
| `src/hooks/useDrGreenApi.ts` | All patient-facing `callProxy` calls: pass `'production'` as `overrideEnv` explicitly. Only the admin comparison calls should read the context env. |
| `supabase/functions/drgreen-proxy/index.ts` | In `create-order`, `add-to-cart`, `create-payment` case blocks: if `requestedEnv === 'railway'`, force `production` and log `[SECURITY] Forcing production for transactional action`. |
| `src/pages/AdminSettings.tsx` | Add an info banner: "Environment selector applies to Admin Tools only. Patient checkout always uses Production." |

---

### Technical Detail: useDrGreenApi.ts Changes

Currently every method calls `callProxy(action, data)` with no `overrideEnv`. The fix tags each call:

```typescript
// Patient-facing actions — ALWAYS production
const createOrder = (orderData) =>
  callProxy('create-order', { data: orderData }, 'production');

const createPayment = (paymentData) =>
  callProxy('create-payment', paymentData, 'production');

const getOrders = (clientId) =>
  callProxy('get-orders', { clientId }, 'production');

const getMyDetails = () =>
  callProxy('get-my-details', {}, 'production');

const updateShipping = (data) =>
  callProxy('update-shipping', data, 'production');

// Admin-only actions — use context env (caller must pass it explicitly)
// getDappClients, getClientsSummary, getStrains — these remain flexible
```

### Technical Detail: Proxy Guard

At line ~1971 in the proxy, after `const envConfig = getEnvironment(requestedEnv)`, add:

```typescript
const PATIENT_TRANSACTIONAL_ACTIONS = [
  'create-order', 'add-to-cart', 'create-payment', 
  'get-payment', 'update-shipping', 'get-my-details', 'get-orders'
];

let adminEnvConfig = envConfig;
if (PATIENT_TRANSACTIONAL_ACTIONS.includes(action) && requestedEnv === 'railway') {
  console.warn(`[drgreen-proxy] SAFETY: Forcing production for transactional action "${action}" (requested: railway)`);
  adminEnvConfig = ENV_CONFIG.production;
}
```

### Expected Outcome

After these changes:
- Patient places order → proxy uses `DRGREEN_API_KEY` + `DRGREEN_PRIVATE_KEY` (production, valid keys) → signing succeeds → cart cleared → items added → order created → real `orderId` returned
- Admin tests railway in API Test Runner → still uses staging keys (that tool passes explicit env)
- Browser localStorage `hb-api-environment = "railway"` no longer breaks patient checkout
- Even if `railway` leaks into a proxy call for a transactional action, the proxy guard catches it

### Deploy Step

After editing the proxy, redeploy `drgreen-proxy`. The `useDrGreenApi.ts` change is frontend-only (no deploy needed beyond the normal build).
