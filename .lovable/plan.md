
## Fix: Consistent Currency Display Across All Pages and Admin

### Root Cause Analysis

The screenshot shows "R 10,00" (ZAR) in the patient dashboard cart — this is actually **correct** for this user (South Africa). The system-wide currency problem is not about the patient cart but about:

1. **Admin pages hardcode `'ZA'`** as the country in every `formatPrice()` call, ignoring the order's own `country_code`.
2. **Admin "Total Sales" KPI** renders in ZAR regardless of context.
3. **Strain price in Admin Strains table** always shows ZAR (R) even when the admin may be operating in a different region.
4. **ApiComparisonDashboard** always renders prices as ZAR.
5. **AdminOrderDetail** uses `order.country_code || 'ZA'` which is already correct but has no label to indicate the currency being shown.

The fix should make **order-related amounts always display in the currency of that order**, and **global admin KPIs use a clear currency indicator** (EUR, since the DApp API prices are denominated in EUR).

### Changes

#### 1. `src/pages/AdminDashboard.tsx` — Fix "Total Sales" KPI

- The `dappTotalSales` value is a count (number of sales), not a monetary amount — confirmed by the `SalesSummary` interface in `SalesDashboard.tsx` which only has `ONGOING`, `LEADS`, `CLOSED`, `totalCount`.
- **Action**: Change `formatPrice(stats?.dappTotalSales || 0, 'ZA')` to simply display the number, or if it is a monetary value, use `'EUR'` (the API's base currency) with a label "EUR (DApp base)".

#### 2. `src/components/admin/AdminOrdersTable.tsx` — Fix per-order currency

Currently: `formatPrice(order.total_amount ?? 0, order.country_code || 'ZA')`

This is already nearly correct — `order.country_code` is used when available. No change needed here, but we need to confirm the fallback is `DEFAULT_COUNTRY` (from `countries.ts`) rather than the hardcoded string `'ZA'`.

- Replace `|| 'ZA'` with `|| DEFAULT_COUNTRY` imported from `@/lib/countries`.

#### 3. `src/components/admin/AdminOrderDetail.tsx` — Fix per-order currency

Same pattern: replace `|| 'ZA'` fallback with `|| DEFAULT_COUNTRY` from countries.ts.

#### 4. `src/pages/AdminStrains.tsx` — Fix strain price display

Strain prices from the DApp API are denominated in **EUR**. Showing them as ZAR/R is misleading.

- Change `formatPrice(strain.retail_price, 'ZA')` to `formatPrice(strain.retail_price, 'EUR')` with a small "EUR" label, since strain base prices are API EUR amounts.
- Add a column header indicator: "Price (EUR)" instead of just "Price".

#### 5. `src/components/admin/ApiComparisonDashboard.tsx` — Fix comparison prices

The comparison dashboard compares prices from multiple API environments. These should be shown in EUR (the DApp base currency), not ZAR.

- Replace all `formatPrice(..., 'ZA')` → `formatPrice(..., 'EUR')` or display the raw EUR value with an "€" prefix.

#### 6. `src/pages/AdminDashboard.tsx` — Fix the order detail in the activity feed

Activity feed detail: `formatPrice(o.total_amount ?? 0, o.country_code || 'ZA')` — replace `'ZA'` with `DEFAULT_COUNTRY`.

### Technical Details

**Files to edit:**

| File | Change |
|---|---|
| `src/pages/AdminDashboard.tsx` | Import `DEFAULT_COUNTRY` from `@/lib/countries`; replace hardcoded `'ZA'` fallbacks; fix "Total Sales" to show EUR or raw count |
| `src/components/admin/AdminOrdersTable.tsx` | Import `DEFAULT_COUNTRY`; replace `\|\| 'ZA'` with `\|\| DEFAULT_COUNTRY` |
| `src/components/admin/AdminOrderDetail.tsx` | Import `DEFAULT_COUNTRY`; replace `\|\| 'ZA'` with `\|\| DEFAULT_COUNTRY` |
| `src/pages/AdminStrains.tsx` | Change strain price column to display EUR; update column header to "Price (EUR)" |
| `src/components/admin/ApiComparisonDashboard.tsx` | Replace `formatPrice(..., 'ZA')` → `formatPrice(..., 'EUR')` |

**Key principle applied:**
- Order amounts → use order's own `country_code` (with `DEFAULT_COUNTRY` as fallback, not raw `'ZA'`)
- Strain/product base prices → always EUR (DApp API denomination)
- Global totals/KPIs → EUR with clear label, or unitless counts

This ensures the currency always accurately reflects either the order's jurisdiction or the API's base denomination, and no hardcoded `'ZA'` survives in the codebase.
