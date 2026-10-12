-- Rollback for 20261012000020_erp_workspace_limit_admins.sql.
-- Platform admins are limited to three ERPs again (memberships they already
-- have stay).

BEGIN;
CREATE OR REPLACE FUNCTION public.erp_enforce_workspace_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status <> 'active' OR NEW.role = 'owner' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'active' THEN RETURN NEW; END IF;

  -- Same lock as invitation redemption: parallel joins are counted one by one.
  PERFORM pg_advisory_xact_lock(hashtext('erp_invite_redeem'), hashtext(NEW.user_id::TEXT));
  IF (SELECT count(*) FROM public.erp_workspace_members m
      WHERE m.user_id = NEW.user_id AND m.status = 'active' AND m.workspace_id <> NEW.workspace_id)
     >= public.erp_workspace_limit() THEN
    RAISE EXCEPTION 'This account already belongs to the maximum of % ERPs.', public.erp_workspace_limit()
      USING ERRCODE = 'P0001', HINT = 'workspace_limit';
  END IF;
  RETURN NEW;
END;
$$;
COMMIT;
