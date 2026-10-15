-- Shorter sessions where they matter (docs/ANALYSIS-QUARRY.md, S7).
--
-- * Accounts that can move money or change who may do what (Owner of a
--   company ERP, Admin, Finance, a custom role with a sensitive permission, a
--   platform admin) are signed out after 8 hours without activity instead of
--   12. Owning only one's personal workspace (every account has one) does not
--   count.
-- * A session opened with "This is a shared computer" (a weighbridge or
--   office PC) is signed out after 15 minutes without activity.
--
-- The sign-in server (src/server/auth/service.ts, resolveSession) asks
-- etna_platform.session_idle_class() on every request, so a new role takes
-- effect at once.
--
-- Only on the plain-PostgreSQL schema (no-op where the auth roles do not
-- exist). Rollback: db/rollback/rollback_20261012000052_session_limits.sql

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etna_auth') AND to_regclass('auth.sessions') IS NOT NULL THEN
    ALTER TABLE auth.sessions ADD COLUMN IF NOT EXISTS shared BOOLEAN NOT NULL DEFAULT false;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.session_idle_class(p_user_id UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, etna_platform
AS $$
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM etna_platform.admins a WHERE a.user_id = p_user_id)
      OR EXISTS (
        SELECT 1
          FROM public.erp_workspace_members m
          JOIN public.erp_workspaces w ON w.id = m.workspace_id
          LEFT JOIN public.erp_custom_roles r ON r.id = m.custom_role_id
         WHERE m.user_id = p_user_id
           AND m.status = 'active'
           AND (m.role IN ('admin', 'finance')
                OR (m.role = 'custom' AND r.permissions && public.erp_sensitive_permissions())
                -- Every account owns a personal workspace: that alone is not a company.
                OR (m.role = 'owner' AND (NOT w.is_personal OR EXISTS (
                      SELECT 1 FROM public.erp_workspace_members o
                       WHERE o.workspace_id = m.workspace_id AND o.status = 'active'
                         AND o.user_id <> p_user_id)))))
    THEN 'privileged'
    ELSE 'standard'
  END;
$$;

REVOKE ALL ON FUNCTION etna_platform.session_idle_class(UUID) FROM PUBLIC, anon, authenticated;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'etna_auth') THEN
    GRANT EXECUTE ON FUNCTION etna_platform.session_idle_class(UUID) TO etna_auth;
  END IF;
END;
$$;
