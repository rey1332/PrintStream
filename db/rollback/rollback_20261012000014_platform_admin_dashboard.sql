-- Rollback for 20261012000014_platform_admin_dashboard.sql.
-- Run only after redeploying an app version from before this change.
--
-- Removes the dashboard, workspace access from the admin panel and the copying
-- of access changes into the security log (entries already copied stay).
-- Memberships granted by admins stay; remove them in the ERP if needed.
--
-- The audit tables get their foreign keys back, NOT VALID so that entries of
-- accounts and ERPs deleted in the meantime are kept. From then on, deleting a
-- created ERP removes its audit trail again, as before.

BEGIN;

DROP TRIGGER IF EXISTS erp_workspace_audit_to_security_log ON public.erp_workspace_audit_log;
DROP FUNCTION IF EXISTS etna_platform._mirror_workspace_audit();
DROP FUNCTION IF EXISTS etna_platform.admin_workspace_grant(UUID, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS etna_platform.admin_workspace_remove(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS etna_platform.admin_dashboard(INTEGER, TEXT);

ALTER TABLE public.erp_audit_log
  ADD CONSTRAINT erp_audit_log_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES public.user_profiles(id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT erp_audit_log_workspace_id_fkey FOREIGN KEY (workspace_id)
    REFERENCES public.erp_workspaces(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.erp_currency_audit
  ADD CONSTRAINT erp_currency_audit_user_id_fkey FOREIGN KEY (user_id)
    REFERENCES public.user_profiles(id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT erp_currency_audit_workspace_id_fkey FOREIGN KEY (workspace_id)
    REFERENCES public.erp_workspaces(id) ON DELETE SET NULL NOT VALID;

ALTER TABLE public.erp_workspace_audit_log
  ADD CONSTRAINT erp_workspace_audit_log_workspace_id_fkey FOREIGN KEY (workspace_id)
    REFERENCES public.erp_workspaces(id) ON DELETE CASCADE NOT VALID,
  ADD CONSTRAINT erp_workspace_audit_log_actor_id_fkey FOREIGN KEY (actor_id)
    REFERENCES public.user_profiles(id) ON DELETE SET NULL NOT VALID,
  ADD CONSTRAINT erp_workspace_audit_log_target_user_id_fkey FOREIGN KEY (target_user_id)
    REFERENCES public.user_profiles(id) ON DELETE SET NULL NOT VALID;

COMMIT;
