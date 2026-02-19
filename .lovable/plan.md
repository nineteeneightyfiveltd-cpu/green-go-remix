
# Create Admin Account — `healingbudsglobal@gmail.com`

## Current State

The database has no users at all — `auth.users` is empty. The account for `healingbudsglobal@gmail.com` does not exist yet, so login will fail with "Invalid login credentials" (which matches the auth logs you saw).

## What Needs to Happen

1. **Create the user account** via the `admin-update-user` edge function with:
   - Email: `healingbudsglobal@gmail.com`
   - Password: `12345678`
   - Email confirmed: `true` (so login works immediately — no verification email needed)

2. **Admin role assignment** — Already handled automatically. The `auto_assign_admin_role` database trigger fires whenever a new row is inserted into `auth.users`. It checks the email and inserts a row into `public.user_roles` with `role = 'admin'` for both:
   - `scott@healingbuds.global`
   - `healingbudsglobal@gmail.com`

   No manual role assignment needed — it happens in the same transaction as account creation.

3. **Verify the account** by calling `admin-update-user` with `verify: true` so that `email_confirmed_at` is set and the user can log in immediately without needing an inbox.

## Flow

```text
Call admin-update-user edge function
  → createUser(email, password, email_confirm: true)
      → auth.users row created
          → auto_assign_admin_role trigger fires
              → INSERT INTO user_roles (user_id, 'admin')
```

After this, visiting `/auth` and logging in with `healingbudsglobal@gmail.com` / `12345678` will:
- Authenticate successfully
- `useUserRole` hook will detect `isAdmin = true`
- Auth page `useEffect` will redirect to `/admin`

## Technical Details

The `admin-update-user` edge function at `supabase/functions/admin-update-user/index.ts` already supports:
- `action: 'create'` path: if user not found → `createUser()` with `email_confirm: true`
- Update path: if user exists → `updateUserById()` to set password + confirm email

The function uses `SUPABASE_SERVICE_ROLE_KEY` (already configured as a secret) so it can bypass email confirmation requirements and create accounts directly.

## Files to Change

| # | File | Change |
|---|------|--------|
| 1 | `supabase/functions/admin-update-user/index.ts` | No change needed — function already handles create-or-update with `verify: true` |

The only action is **calling the edge function** with the correct payload. No code changes are required.

The plan calls the existing `admin-update-user` function with:
```json
{
  "email": "healingbudsglobal@gmail.com",
  "password": "12345678",
  "verify": true
}
```

This creates the user, sets the password, confirms the email, and lets the existing trigger handle the admin role — all in one operation.
