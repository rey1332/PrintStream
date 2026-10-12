-- Platform admins are not limited to three ERPs.
--
-- An account may belong to at most erp_workspace_limit() ERPs (three). That
-- is right for clients, but ETNA's own admins are given access to the ERPs of
-- the clients they support (admin panel, 20261012000014) and would hit the
-- limit after a few clients. Accounts with a platform admin role are exempt;
-- everyone else is unchanged.
--
-- Rollback: db/rollback/rollback_20261012000020_erp_workspace_limit_admins.sql

-- As in 20261008000000_erp_workspace_limit_documents.sql, plus the exemption.
CREATE OR REPLACE FUNCTION public.erp_enforce_workspace_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.status <> 'active' OR NEW.role = 'owner' THEN RETURN NEW; END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'active' THEN RETURN NEW; END IF;
  IF etna_platform._role_of(NEW.user_id) IS NOT NULL THEN RETURN NEW; END IF;

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
