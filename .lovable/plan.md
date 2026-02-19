
## Fix: Provision Auth Accounts for All Synced Clients

### The Problem

9 clients were synced from the Dr. Green API into `public.drgreen_clients` but have no corresponding login accounts (`user_id = null`). Without an auth account, those clients cannot log in. The `admin-update-user` edge function already exists and is capable of creating auth users using the Service Role Key.

### What Will Be Done

#### 1. Create a new `admin-provision-users` edge function

A dedicated Supabase Edge Function that:

- Fetches all `drgreen_clients` records where `user_id IS NULL`
- For each, calls the Supabase Admin API to create an auth user with:
  - Their email from `drgreen_clients`
  - Password: `12345678`
  - Email pre-confirmed (`email_confirm: true`)
- After creating the auth user:
  - Updates `drgreen_clients.user_id` to link the record
  - Inserts a `profiles` row with their full name
  - If the email is `scott@healingbuds.global` or `healingbudsglobal@gmail.com`, inserts an admin role into `user_roles`
- Returns a detailed summary: created / skipped (already exists) / failed
- Uses the built-in `SUPABASE_SERVICE_ROLE_KEY` (already available)

#### 2. Add a "Provision All Users" button to the Admin Clients page

In `src/pages/AdminClients.tsx`, add a prominent button that:

- Calls the new `admin-provision-users` edge function
- Shows a loading state during provisioning
- Displays the result (e.g. "9 accounts created, 0 skipped, 0 failed") as a toast

#### 3. Update `sync-clients` to auto-provision on future syncs

Inside `supabase/functions/sync-clients/index.ts`, after inserting a new unlinked client (where no auth user was found by email), automatically attempt to create the auth account in the same pass. This prevents the gap from recurring on future syncs.

### Technical Notes

- Uses `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` — both already set as built-in secrets
- No database migrations required — existing `drgreen_clients`, `profiles`, and `user_roles` tables are sufficient
- The `auto_link_drgreen_client` trigger is bypassed intentionally here since we are linking in the same operation
- Clients provisioned: `varseainc@gmail.com`, `maykendaal23@gmail.com`, `scott.k1@outlook.com`, `kayliegh.sm@gmail.com`, `scott@healingbuds.global`, `testhb@yopmail.com`, `test9876@yopmail.com`, `wwe2xjhickei@drewzen.com`, `testflow3@healingbuds.test`
- `scott@healingbuds.global` and `healingbudsglobal@gmail.com` will be assigned admin roles

### Files to Create/Edit

| File | Action |
|---|---|
| `supabase/functions/admin-provision-users/index.ts` | Create new edge function |
| `src/pages/AdminClients.tsx` | Add "Provision All Users" button |
| `supabase/functions/sync-clients/index.ts` | Add auto-provision logic for future syncs |
