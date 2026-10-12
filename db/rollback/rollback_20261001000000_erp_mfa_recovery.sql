-- Rollback for 20261001000000_erp_mfa_recovery.sql.
-- Deletes every recovery code; users keep their authenticator devices.
BEGIN;

-- Pre-request check without the recovery exception (as in 20260928010000).
CREATE OR REPLACE FUNCTION public.erp_check_request()
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, auth
AS $$
BEGIN
  IF NOT public.erp_mfa_satisfied() THEN
    RAISE EXCEPTION 'Two-factor verification required' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.erp_mfa_use_recovery_code(TEXT);
DROP FUNCTION IF EXISTS public.erp_mfa_clear_recovery_codes();
DROP FUNCTION IF EXISTS public.erp_mfa_recovery_status();
DROP FUNCTION IF EXISTS public.erp_mfa_generate_recovery_codes();
DROP FUNCTION IF EXISTS public.erp__mfa_recovery_hash(UUID, TEXT);
DROP TABLE IF EXISTS public.erp_mfa_recovery_codes;
COMMIT;
