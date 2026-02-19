
## Fix: Shipping Address Form — Separate Display from Edit

### What's Happening Now

In checkout's "custom" address mode, the form is rendered with `initialAddress={savedAddress}`, which pre-fills every input field with the user's real address data as **editable values**. This means the user sees their actual address details inside the form fields, which feels like the placeholder text is their personal data — because it is.

The user's expectation is:
- Show the existing address as a **read-only display card** above
- The edit form below should have **empty fields with generic country-specific placeholder text**
- User only touches the form if they want to change something

### Root Cause

In `src/pages/Checkout.tsx` line 637:
```tsx
<ShippingAddressForm
  clientId={drGreenClient.drgreen_client_id}
  initialAddress={savedAddress}   // <-- This pre-fills real data into fields
  ...
/>
```

And in `ShippingAddressForm.tsx`, the `defaultValues` on the form use `initialAddress` to fill the inputs directly:
```tsx
defaultValues: {
  address1: initialAddress?.address1 || '',   // real "10 Downing St" goes into the field
  city: initialAddress?.city || '',
  ...
}
```

### Fix

#### 1. `src/pages/Checkout.tsx` — Remove `initialAddress` from "Ship to different address" form

When the user clicks "Ship to a different address", the form should open **blank** (with generic placeholders) rather than pre-filled with the saved address. The saved address is already shown in the read-only card above it.

Change line 637:
```tsx
// BEFORE
initialAddress={savedAddress}

// AFTER — no initialAddress, just set defaultCountry from saved address
initialAddress={null}
defaultCountry={savedAddress?.countryCode || drGreenClient.country_code || countryCode}
```

This means:
- Form fields start empty with generic placeholder hints (e.g. "10 Downing Street" for GB, "Rua Augusta 100" for PT)
- User types their new address entirely
- On save, the new address replaces the old one

#### 2. `src/components/shop/ShippingAddressForm.tsx` — Make placeholders truly generic

The current placeholders (e.g. "10 Downing Street", "Rua Augusta 100") are specific addresses that could be mistaken for real pre-filled data. Replace them with clearly descriptive, format-hint placeholders:

| Field | Current (GB) | New (GB) |
|---|---|---|
| address1 | "10 Downing Street" | "e.g. 12 High Street" |
| address2 | "Flat 2A" | "e.g. Flat 2A (optional)" |
| city | "London" | "e.g. London" |
| state | "England" | "e.g. Surrey" |
| landmark | "Near Westminster" | "e.g. near the post office" |

| Field | Current (PT) | New (PT) |
|---|---|---|
| address1 | "Rua Augusta 100" | "ex. Rua das Flores, 25" |
| city | "Lisboa" | "ex. Lisboa" |
| state | "Lisboa" | "ex. Setúbal" |

| Field | Current (ZA) | New (ZA) |
|---|---|---|
| address1 | "123 Rivonia Road" | "e.g. 45 Main Street" |
| city | "Johannesburg" | "e.g. Cape Town" |
| state | "Gauteng" | "e.g. Western Cape" |

| Field | Current (TH) | New (TH) |
|---|---|---|
| address1 | "123 Sukhumvit Road" | "e.g. 88 Charoen Krung Rd" |
| city | "Bangkok" | "e.g. Bangkok" |
| state | "Krung Thep" | "e.g. Chiang Rai" |

The postal code placeholder already uses the format pattern (e.g. "SW1A 1AA") which is perfect — no change needed there.

### Files to Edit

| File | Change |
|---|---|
| `src/components/shop/ShippingAddressForm.tsx` | Update all `countryPlaceholders` to use generic descriptive hints prefixed with "e.g." / "ex." instead of real-looking addresses |
| `src/pages/Checkout.tsx` | Remove `initialAddress={savedAddress}` from the "Ship to different address" `ShippingAddressForm` instance; keep `defaultCountry` set to the saved address country so locale-appropriate labels/placeholders still show |
