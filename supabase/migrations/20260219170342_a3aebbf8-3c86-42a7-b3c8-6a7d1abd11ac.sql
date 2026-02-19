-- 1. Re-create the missing trigger on auth.users for auto admin role assignment
DROP TRIGGER IF EXISTS on_auth_user_created_assign_admin ON auth.users;
CREATE TRIGGER on_auth_user_created_assign_admin
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_assign_admin_role();

-- 2. Re-create trigger for handle_new_user (profile creation) if missing
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();

-- 3. Re-create trigger for auto_link_drgreen_client if missing
DROP TRIGGER IF EXISTS on_auth_user_created_link_client ON auth.users;
CREATE TRIGGER on_auth_user_created_link_client
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.auto_link_drgreen_client();

-- 4. Normalize country_code values from full country names to ISO Alpha-2
UPDATE public.drgreen_clients SET country_code = 'ZA' WHERE country_code IN ('South Africa', 'south africa', 'ZAF');
UPDATE public.drgreen_clients SET country_code = 'GB' WHERE country_code IN ('United Kingdom', 'UK', 'GBR');
UPDATE public.drgreen_clients SET country_code = 'PT' WHERE country_code IN ('Portugal', 'PRT');
UPDATE public.drgreen_clients SET country_code = 'TH' WHERE country_code IN ('Thailand', 'THA');
UPDATE public.drgreen_clients SET country_code = 'DE' WHERE country_code IN ('Germany', 'DEU');
UPDATE public.drgreen_clients SET country_code = 'US' WHERE country_code IN ('United States', 'USA');

-- 5. Fix the sync-clients function to also normalize country codes on insert
-- (handled in edge function code)