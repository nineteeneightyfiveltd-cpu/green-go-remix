
## Fix: Add to Cart Button Click Not Working

### Root Cause

The entire `ProductCard` is wrapped in a `motion.div` with `onClick={() => navigate('/shop/strain/${product.id}')}`. Every click anywhere inside the card — including the Add to Cart, +/- quantity buttons — bubbles up to this handler.

The buttons call `e.stopPropagation()` which *should* work, but there are two compounding problems:

**Problem 1 — The content `div` has no `onClick` of its own, so the bubble path goes:**
```
Button click → e.stopPropagation() → should stop here
```
This works in desktop browsers but on touch/mobile devices, Framer Motion's `whileHover` and animation layer can cause synthetic touch events to bypass `stopPropagation` in certain cases.

**Problem 2 — The Add to Cart `onClick` on line 280 calls `handleAddToCart()` without `await`:**
```tsx
onClick={(e) => { e.stopPropagation(); handleAddToCart(); }}
```
Since `handleAddToCart` is `async`, calling it without `await` means any exception is silently swallowed. The function starts running (sets `isAdding = true`) but if an error occurs, `setIsAdding(false)` in `finally` is still called — the issue is that **without `await`, the browser event loop moves on and may re-render before the state update lands**, causing the button to appear unresponsive.

**Problem 3 — The outer `motion.div` is `cursor-pointer` with `onClick={navigate}`:**
The entire card area including the bottom action strip fires navigation. On mobile, a tap registers a full click event that races with the button's `stopPropagation`. This is why the cart add appears to do nothing — it navigates away before the Supabase write even starts.

### The Fix

**Remove `onClick` from the outer `motion.div`.** Instead, only the image section and product name should trigger navigation. The content area (effects, quantity, CTA) becomes a non-navigating zone:

```tsx
// BEFORE (wrong — entire card navigates on click):
<motion.div
  className="h-full cursor-pointer"
  onClick={() => navigate(`/shop/strain/${product.id}`)}
>

// AFTER (only image + title navigate):
<motion.div className="h-full">
  {/* Image — navigates on click */}
  <div 
    className="relative aspect-square ... cursor-pointer"
    onClick={() => navigate(`/shop/strain/${product.id}`)}
  >
    ...image/video...
  </div>

  {/* Content — does NOT navigate */}
  <div className="relative p-5 space-y-3">
    <div className="flex items-start justify-between gap-3">
      <h3 
        className="font-bold ... cursor-pointer"
        onClick={() => navigate(`/shop/strain/${product.id}`)}
      >
        {product.name}
      </h3>
      ...price, effects, qty, CTA...
    </div>
  </div>
```

This makes the navigation intent explicit and unambiguous — the image and title are clickable links to the detail page, while the action area (quantity stepper + Add to Cart) is fully independent.

**Additionally, remove the `cursor-pointer` from the outer wrapper** since it would make the whole card look clickable even in the action zone. The image and title will each get `cursor-pointer` individually.

### Files to Edit

| File | Change |
|---|---|
| `src/components/shop/ProductCard.tsx` | Remove `onClick` and `cursor-pointer` from outer `motion.div`. Add `onClick={() => navigate(...)}` and `cursor-pointer` to the image `div` and product name `h3`. Remove `e.stopPropagation()` from Add to Cart button (no longer needed). |

### What This Fixes

- Add to Cart button click reliably adds to cart with spinner/success state visible
- Quantity +/- buttons work without accidentally navigating
- Product image and name still navigate to detail page as expected
- Mobile touch events work correctly (no competing `onClick` handlers)
- Quick View eye button still works (it already has its own `stopPropagation`)

### No Other Files Need Changing

- `ShopContext.addToCart` is correct — the fix from the previous change (quantity increment) stays
- `FloatingCartButton` correctly reflects cart state from context
- `Cart.tsx` is unchanged
