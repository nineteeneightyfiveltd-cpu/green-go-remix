
## Locale-Aware Placeholders + Edit Mode for Saved DApp Address

### Current State (What's Wrong)

**Problem 1 — Placeholder data is in `ShippingAddressForm.tsx` but is disconnected from `COUNTRY_REGISTRY`**

`src/lib/countries.ts` already has rich per-country data: `postalCodeLabel`, `postalCodePlaceholder`, `postalCodePattern`. But `ShippingAddressForm.tsx` duplicates this into its own local `countryPlaceholders`, `countryLabels`, and `postalCodePatterns` objects that are NOT driven from the registry. If a country is added or updated in `countries.ts`, the form gets stale.

The fix: derive everything from `COUNTRY_REGISTRY` so there is one single source of truth.

**Problem 2 — No Edit Mode when address comes from DApp**

When `savedAddress` is populated (from DApp or local DB), the checkout shows the address in a read-only radio card. If the user clicks "Ship to a different address", they get a **blank** `ShippingAddressForm` with `initialAddress={null}`.

But there is no way to **edit the existing verified address in-place** — the user can only replace it with a brand-new one. For a returning patient who just wants to fix a typo in their city, there is no path to do that in the current UI. The correct UX is:

- Saved address card shows the verified address
- An "Edit address" button/link on that card opens the form **pre-filled** with the existing values
- On save, the new address replaces the old one and the card updates
- A visible success banner confirms the change persisted

**Problem 3 — `ShippingAddressForm` placeholders use generic strings, not locale-aware registry data**

`countryPlaceholders.PT.address1` is `"ex. Rua das Flores, 25"` — hardcoded. The `COUNTRY_REGISTRY` already has `postalCodePlaceholder`, `postalCodeLabel`, and `contactAddress` per country. The form should read postal data from `getCountryConfig(countryCode)` and extend the registry with address-level hints rather than maintaining a parallel data structure.

---

### Solution Design

#### Part 1 — Drive placeholders from `COUNTRY_REGISTRY` (no parallel maps)

Add `addressPlaceholders` to `CountryConfig` in `src/lib/countries.ts`. Each supported country gets a structured hints object:

```typescript
interface AddressHints {
  address1: string;   // "e.g. 45 Main Street"
  address2: string;   // "e.g. Unit 5B (optional)"
  city: string;       // "e.g. Cape Town"
  state: string;      // "e.g. Western Cape"
  stateLabel: string; // "Province" / "Distrito" / "County"
  landmark: string;   // "e.g. near the shopping centre"
}
```

In `ShippingAddressForm.tsx`, replace `countryPlaceholders`, `countryLabels`, and the duplicated `postalCodePatterns` with calls to `getCountryConfig(selectedCountry)`. The field labels (`postalCodeLabel`, `stateLabel`) and format hints (`postalCodePlaceholder`) come directly from the registry:

```typescript
const cfg = getCountryConfig(selectedCountry);
// Postal code label: cfg.postalCodeLabel
// Postal code placeholder: cfg.postalCodePlaceholder
// Postal code regex pattern: cfg.postalCodePattern (already a string — compile to RegExp)
// Address placeholder: cfg.addressHints.address1
```

This eliminates all duplicate data and makes adding a new country a single-file change in `countries.ts`.

#### Part 2 — Edit Mode for Saved Address

**`src/components/shop/ShippingAddressForm.tsx` changes:**

Add `mode` prop: `'new' | 'edit'` (defaults to `'new'`).

- `mode='new'`: current behavior — form starts with empty fields and generic placeholder hints.
- `mode='edit'`: form is pre-filled with `initialAddress` values. Header says "Edit Address". Submit button says "Update Address". On success, the `onSuccess` callback is called with the updated data, and the parent replaces the displayed address.

Add internal `isEditing` state toggled by an "Edit" button shown in the card header when `mode='edit'` and `initialAddress` is provided. Initially collapsed (shows a summary); expands inline on click.

**`src/pages/Checkout.tsx` changes:**

In the "Delivery Address" card, change the saved address radio option to include an "Edit" button:

```tsx
<div className="flex items-start gap-3 p-4 rounded-lg border ...">
  <RadioGroupItem value="saved" id="addr-saved" className="mt-1" />
  <Label htmlFor="addr-saved" className="flex-1 cursor-pointer">
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-2 font-medium">
        <Home className="h-4 w-4" /> Use saved address
      </span>
      <Button variant="ghost" size="sm" onClick={() => setIsEditingAddress(true)}>
        <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
      </Button>
    </div>
    <div className="text-sm text-muted-foreground mt-1">
      {savedAddress.address1}<br />
      {savedAddress.city}, {savedAddress.postalCode}<br />
      {savedAddress.country}
    </div>
  </Label>
</div>

{isEditingAddress && (
  <div className="pt-4 border-t border-border/50">
    <ShippingAddressForm
      clientId={drGreenClient.drgreen_client_id}
      initialAddress={savedAddress}   // pre-filled with real verified data
      defaultCountry={...}
      onSuccess={handleShippingAddressSaved}  // replaces savedAddress on save
      onCancel={() => setIsEditingAddress(false)}
      submitLabel="Update Address"
      variant="inline"
    />
  </div>
)}
```

When `handleShippingAddressSaved` fires with the updated address:
- `setSavedAddress(updatedAddress)` — card immediately shows new values
- `setShippingAddress(updatedAddress)` — order will use new address
- `setIsEditingAddress(false)` — collapse the edit form
- `setAddressManuallySaved(true)` — suppress re-fetch from DApp
- Green "Address Updated" banner appears for 3 seconds then auto-dismisses

---

### Files to Edit

| File | What Changes |
|---|---|
| `src/lib/countries.ts` | Add `addressHints` field to `CountryConfig` interface and fill in values for PT, GB, ZA, TH. Keep existing fields untouched. |
| `src/components/shop/ShippingAddressForm.tsx` | (1) Remove `countryPlaceholders`, `countryLabels`, `postalCodePatterns` local maps. (2) Derive all labels/hints from `getCountryConfig`. (3) The postal regex is already a string in registry — compile with `new RegExp(cfg.postalCodePattern, 'i')`. (4) No `mode` prop needed — the `isEditing` logic stays in Checkout. |
| `src/pages/Checkout.tsx` | (1) Add `isEditingAddress` state. (2) Add "Edit" button + inline edit form in the saved address card. (3) `handleShippingAddressSaved` updates `savedAddress` and collapses edit mode. (4) Import `Pencil` from lucide-react. |

---

### Locale-Aware Address Hints (data to add to `countries.ts`)

```text
PT (Portugal)
  address1:   "ex. Rua das Flores, 25"
  address2:   "ex. Andar 3, Fração B"
  city:       "ex. Lisboa"
  state:      "ex. Setúbal"
  stateLabel: "Distrito"
  landmark:   "ex. perto da Estação do Oriente"

GB (United Kingdom)
  address1:   "e.g. 12 High Street"
  address2:   "e.g. Flat 2A"
  city:       "e.g. London"
  state:      "e.g. Surrey"
  stateLabel: "County"
  landmark:   "e.g. near the post office"

ZA (South Africa)
  address1:   "e.g. 45 Main Road"
  address2:   "e.g. Unit 5B"
  city:       "e.g. Cape Town"
  state:      "e.g. Western Cape"
  stateLabel: "Province"
  landmark:   "e.g. near the shopping centre"

TH (Thailand)
  address1:   "e.g. 88 Charoen Krung Rd"
  address2:   "e.g. Room 4B"
  city:       "e.g. Bangkok"
  state:      "e.g. Chiang Rai"
  stateLabel: "Changwat (Province)"
  landmark:   "e.g. near BTS station"
```

---

### Edit Flow UX (Step by Step)

```text
User visits /checkout
  → DApp returns full address: "123 Rivonia Road, Sandton, 2148, ZAF"
  → Checkout shows "Use saved address" card with address details
  → User sees "Edit" button on the card

User clicks "Edit"
  → isEditingAddress = true
  → Inline ShippingAddressForm expands BELOW the address card
  → Form is pre-filled: address1="123 Rivonia Road", city="Sandton", postalCode="2148", country=ZA
  → Placeholders are locale-aware ZA hints (shown in empty fields only, e.g. address2)
  → User changes city from "Sandton" to "Sandton City"
  → Clicks "Update Address"

On save:
  → Form shows "Saving..." spinner
  → Address PATCHed to DApp API + saved to local DB
  → 1200ms delay so user sees "Saved!" tick
  → onSuccess fires with new address
  → savedAddress card updates immediately to: "123 Rivonia Road, Sandton City, 2148"
  → Edit form collapses
  → Green "Address Updated" banner appears
  → shippingAddress updated — Place Order will use new address
```

### No Changes Needed In

- `supabase/functions/drgreen-proxy/index.ts` — address PATCH logic already correct from previous fix
- `src/hooks/useDrGreenApi.ts` — `updateShippingAddress` already works
- Any i18n files — placeholders are in code, not translation files (they are format examples, not translated strings)
