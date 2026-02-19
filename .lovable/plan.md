
## Debug Logs for Shippings + Dynamic Country Placeholders

### What's Already Done
- `countryPlaceholders` map exists in `ShippingAddressForm.tsx` for PT, ZA, GB, TH
- `getPlaceholder(selectedCountry, field)` helper is already used in all Input elements
- The form watches `country` via `form.watch('country')`

### What's Missing

#### 1. Debug Logs in `sync-clients` Edge Function

No `console.log` for raw shipping data exists yet. Add structured logging immediately after the DApp client list is received, outputting the raw `client.shippings` array for each client being processed. This is the only way to verify what field names the DApp API actually returns.

Log format (per client):
```
[sync-clients] Client shipping raw data { email, shippings: [...] }
```

#### 2. Dynamic Validation Schema on Country Change

The form schema is created once on mount using `initialCountry` and never updates. When the user picks a different country in the dropdown, the postal code regex stays locked to the original country. Fix: use `useEffect` watching `selectedCountry` to call `form.trigger('postalCode')` so the live field value is re-validated against the correct pattern immediately.

Also add a `key` or call `form.clearErrors('postalCode')` when country switches to avoid stale error messages.

#### 3. Dynamic Field Labels Per Country

Currently all labels are hardcoded strings regardless of country:
- "State / Province" — should be "County" for GB, "Province" for ZA, "Distrito" for PT, "Changwat" for TH
- "Postal Code" — should be "Post Code" for GB, "Código Postal" for PT

Add a `countryLabels` map alongside `countryPlaceholders` and bind all form labels to `selectedCountry`.

#### 4. Re-run Sync After Deploy

After deploying `sync-clients` with debug logs, trigger a manual re-sync from the Admin Strains Sync page so the logs appear in the edge function console. This will confirm the exact DApp field names for `shippings`.

### Files to Edit

| File | Change |
|---|---|
| `supabase/functions/sync-clients/index.ts` | Add `console.log` for raw `client.shippings` data per client |
| `src/components/shop/ShippingAddressForm.tsx` | Add `countryLabels` map, bind labels to `selectedCountry`, add `useEffect` to re-validate postal code on country change |
