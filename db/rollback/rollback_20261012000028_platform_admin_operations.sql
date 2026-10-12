-- Rollback for 20261012000028_platform_admin_operations.sql.
-- Run only after redeploying an app version from before this change.
-- Companies already created stay (they are ordinary created ERPs). Limits
-- per account and announcements are removed; every account has the default
-- ERP limit again.

BEGIN;
CREATE OR REPLACE FUNCTION pg_temp.erp_patch(p_fn REGPROCEDURE, p_pairs TEXT[])
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  body TEXT := pg_get_functiondef(p_fn);
  i INTEGER;
BEGIN
  FOR i IN 1 .. COALESCE(array_length(p_pairs, 1), 0) BY 2 LOOP
    IF position(p_pairs[i] IN body) = 0 THEN
      RAISE EXCEPTION 'erp_patch: % does not contain %', p_fn, p_pairs[i];
    END IF;
    body := replace(body, p_pairs[i], p_pairs[i + 1]);
  END LOOP;
  RETURN body;
END;
$$;
DO $$
BEGIN
  EXECUTE pg_temp.erp_patch('public.erp_enforce_workspace_limit()'::regprocedure,
    ARRAY['public.erp__workspace_limit_for(NEW.user_id)', 'public.erp_workspace_limit()']);
  EXECUTE pg_temp.erp_patch('public.erp_my_workspace_quota()'::regprocedure,
    ARRAY['public.erp__workspace_limit_for(auth.uid())', 'public.erp_workspace_limit()']);
  EXECUTE pg_temp.erp_patch('public.erp_create_erp(text)'::regprocedure,
    ARRAY['public.erp__workspace_limit_for(actor)', 'public.erp_workspace_limit()']);
  EXECUTE pg_temp.erp_patch('public.erp_redeem_workspace_invitation(text)'::regprocedure,
    ARRAY['public.erp__workspace_limit_for(actor)', 'public.erp_workspace_limit()']);
END;
$$;
DROP FUNCTION IF EXISTS public.erp_my_announcements();
DROP FUNCTION IF EXISTS etna_platform.admin_authorize(TEXT, JSONB);
DROP FUNCTION IF EXISTS etna_platform.admin_cancel_announcement(UUID);
DROP FUNCTION IF EXISTS etna_platform.admin_save_announcement(JSONB);
DROP FUNCTION IF EXISTS etna_platform.admin_announcements();
DROP FUNCTION IF EXISTS etna_platform.admin_set_workspace_modules(UUID, TEXT, TEXT[], TEXT);
DROP FUNCTION IF EXISTS etna_platform.admin_workspace_usage(UUID);
DROP FUNCTION IF EXISTS etna_platform.admin_create_company(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS etna_platform.admin_set_account_limit(UUID, INTEGER, TEXT);
DROP FUNCTION IF EXISTS etna_platform.admin_account_limit(UUID);
DROP FUNCTION IF EXISTS public.erp__workspace_limit_for(UUID);
DROP TABLE IF EXISTS etna_platform.announcements;
DROP TABLE IF EXISTS etna_platform.account_limits;
COMMIT;
