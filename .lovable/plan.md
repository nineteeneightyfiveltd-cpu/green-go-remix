
## Problem

The `callProxy` function in `useDrGreenApi.ts` reads `localStorage` via `getCurrentEnvironment()` and passes whatever is stored there as `env` to the proxy. If an admin previously set `railway` in the environment selector, ALL API calls — including patient order flows — send `env: "railway"` to the proxy, which uses the broken staging key and causes 400 errors and key parsing failures.

The safety guard added in the last diff only catches `railway` for a hardcoded list of transactional actions. But:
- Any action NOT in that list still leaks to railway
- The root issue — `useDrGreenApi.ts` reading localStorage at all — remains unfixed

## The Fix

The `useDrGreenApi` hook must **never read localStorage**. It is a patient and data-layer hook, not an admin tool. The env selector in Admin Settings is only for explicit admin debug tools (API Test Runner, Comparison Dashboard) which should manage env themselves.

### Changes

**1. `src/hooks/useDrGreenApi.ts`**

- Remove `getCurrentEnvironment()` entirely from the file
- Remove `ENV_STORAGE_KEY` constant
- Change `callProxy` so when no `overrideEnv` is passed, it **always sends `'production'`** — not localStorage
- The function signature stays the same; admin tools that explicitly pass `overrideEnv` (e.g. `callProxy('dapp-clients', params, adminEnv)`) continue to work as before

Before:
```typescript
const env = overrideEnv || getCurrentEnvironment(); // reads localStorage
```

After:
```typescript
const env = overrideEnv || 'production'; // always production unless explicitly overridden
```

**2. `supabase/functions/drgreen-proxy/index.ts`**

Expand the `PATIENT_TRANSACTIONAL_ACTIONS` guard to be a full "default to production" rule: if no env is provided OR env is `'railway'` for any action that isn't explicitly an admin debug action, force `'production'`. This is a server-side belt-and-suspenders guarantee.

Concretely, replace the narrow railway-only guard with:
```typescript
// Any action NOT explicitly admin/debug always uses production
const ADMIN_DEBUG_ONLY_ACTIONS = [
  'dapp-clients', 'dapp-orders', 'dashboard-summary', 
  'get-sales', 'dapp-strains', /* ...other admin test actions */
];
const forceProduction = !ADMIN_DEBUG_ONLY_ACTIONS.includes(action);
const effectiveEnv = forceProduction ? 'production' : (requestedEnv || 'production');
```

This means the only way to ever hit railway is if an admin debug action explicitly requests it.

### Files to Change

| File | Change |
|---|---|
| `src/hooks/useDrGreenApi.ts` | Remove `getCurrentEnvironment()` and `ENV_STORAGE_KEY`. Change `callProxy` default from `getCurrentEnvironment()` to `'production'` |
| `supabase/functions/drgreen-proxy/index.ts` | Replace the narrow transactional-action guard with a whitelist approach: only explicitly-listed admin debug actions can use a non-production env |

### Expected Outcome

- Patient opens shop, adds to cart, places order → always production keys → signing works → order succeeds
- Admin opens API Test Runner with Railway selected → that component passes `overrideEnv = 'railway'` explicitly → still works
- No localStorage read ever affects patient-facing flows again
- Even if something slips through client-side, the proxy's whitelist guard ensures only admin debug actions can use railway
