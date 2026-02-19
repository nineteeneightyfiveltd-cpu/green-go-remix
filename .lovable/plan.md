

## Fix: Shipping Address Pre-Population and Country-Relevant Placeholders

### Problem 1: Shipping Address Not Pulled from DApp

The `sync-clients` edge function has two bugs preventing full address data from syncing:

**Bug A -- Strict `address1` guard (line ~284):** The code `dappShipping?.address1 ? {...} : null` only builds a shipping object when `address1` is truthy. If the DApp API returns the street under a slightly different key, or if there is partial data (city, country but no street yet), it skips the entire object. The guard should be relaxed: build the object if *any* shipping entry exists.

**Bug B -- Update condition too narrow (line ~300):** `needsShippingUpdate = shippingAddress && !existing.shipping_address` evaluates to `false` when a partial record already exists in the DB (e.g. `{country: "South Africa", address2: "", state: ""}`). It should check whether the local record is missing `address1` specifically, and overwrite if the DApp has a richer version.

Additionally, debug logging will be added to capture the raw `client.shippings` array from the API so we can confirm the exact field names returned.

### Problem 2: Hardcoded Placeholders Not Country-Relevant

The `ShippingAddressForm` currently shows generic placeholders like "123 Main Street", "Lisbon", "Apt 4B" regardless of which country is selected. These should change dynamically based on the country dropdown selection.

### Changes

#### 1. `supabase/functions/sync-clients/index.ts`

- Relax the `address1` guard: build `shippingAddress` object whenever `dappShipping` exists (not only when `address1` is present)
- Fix the update condition: update if local `shipping_address` is null OR if its `address1` is empty/missing while the DApp has a non-empty `address1`
- Add field name fallbacks (`addressLine1`, `zipCode`, etc.) for robustness
- Add `console.log` for first 3 clients to dump raw `shippings` array for debugging
- Deploy and re-sync

#### 2. `src/components/shop/ShippingAddressForm.tsx`

Add a country-specific placeholder map that updates dynamically when the country dropdown changes:

| Field | PT (Portugal) | ZA (South Africa) | GB (United Kingdom) | TH (Thailand) |
|---|---|---|---|---|
| Street Address | Rua Augusta 100 | 123 Rivonia Road | 10 Downing Street | 123 Sukhumvit Road |
| Apartment | Andar 3 | Unit 5B | Flat 2A | Room 4B |
| City | Lisbon | Johannesburg | London | Bangkok |
| State/Province | Lisboa | Gauteng | England | Krung Thep |
| Postal Code | 1000-001 | 2196 | SW1A 1AA | 10110 |
| Landmark | Perto da Praca | Near Sandton City | Near Westminster | Near BTS Asok |

The postal code placeholder already adapts via `postalCodePatterns[selectedCountry]?.example`. The remaining fields (street, city, state, apartment, landmark) will use the same `selectedCountry` watch value.

### Technical Details

**Files to edit:**

| File | Change |
|---|---|
| `supabase/functions/sync-clients/index.ts` | Fix address guard, fix update condition, add debug logging, add field fallbacks |
| `src/components/shop/ShippingAddressForm.tsx` | Add country-specific placeholder map, update all Input placeholders to be dynamic |

