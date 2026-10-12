-- A TERMINAL on its own, linked to ERPs (optional): its pipelines may read an
-- ERP's data and add to an ERP's customers, suppliers and products.
--
-- * Linking needs both sides: managing connections in the TERMINAL (with
--   two-factor) and being the ERP's Owner or an Admin.
-- * A link only says which ERPs a TERMINAL's pipelines may name. Every read
--   and write still happens as the person running the pipeline, with that
--   person's rights in the ERP (row-level security, the ERP's permissions):
--   a member of the TERMINAL who is not a member of the ERP gets nothing.
-- * Either side can remove a link; both activity logs record it.
--
-- Rollback: db/rollback/rollback_20261012000044_terminal_erp_links.sql

CREATE TABLE IF NOT EXISTS public.ps_erp_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  erp_workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  -- The ERP's name when it was linked (members of the TERMINAL may not see the ERP).
  erp_name TEXT NOT NULL CHECK (char_length(erp_name) BETWEEN 1 AND 120),
  created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, erp_workspace_id),
  CHECK (workspace_id <> erp_workspace_id)
);

ALTER TABLE public.ps_erp_links ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ps_erp_links FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.ps_erp_links TO authenticated;
DROP POLICY IF EXISTS ps_erp_links_read ON public.ps_erp_links;
CREATE POLICY ps_erp_links_read ON public.ps_erp_links FOR SELECT TO authenticated USING (
  public.erp_workspace_role(workspace_id) IS NOT NULL
  OR COALESCE(public.erp_workspace_role(erp_workspace_id), '') IN ('owner', 'admin'));
DROP POLICY IF EXISTS erp_workspace_not_suspended ON public.ps_erp_links;
CREATE POLICY erp_workspace_not_suspended ON public.ps_erp_links AS RESTRICTIVE FOR ALL TO authenticated
  USING (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]));

CREATE OR REPLACE FUNCTION public.ps_link_erp(p_workspace_id UUID, p_erp_workspace_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.erp_workspaces;
  e public.erp_workspaces;
  link UUID;
BEGIN
  PERFORM public.ps__require_connection_manager(p_workspace_id);
  SELECT * INTO t FROM public.erp_workspaces WHERE id = p_workspace_id;
  SELECT * INTO e FROM public.erp_workspaces WHERE id = p_erp_workspace_id;
  IF t.kind IS DISTINCT FROM 'terminal' THEN
    RAISE EXCEPTION 'Only a TERMINAL on its own is linked to ERPs' USING ERRCODE = 'P0001', HINT = 'not_terminal';
  END IF;
  IF e.id IS NULL OR e.kind <> 'erp' OR COALESCE(public.erp_workspace_role(e.id), '') NOT IN ('owner', 'admin')
     OR NOT public.erp_workspace_mfa_ok(e.id) THEN
    RAISE EXCEPTION 'Only the ERP''s Owner or an Admin can link it' USING ERRCODE = '42501', HINT = 'erp_admin';
  END IF;
  INSERT INTO public.ps_erp_links (workspace_id, erp_workspace_id, erp_name, created_by)
  VALUES (t.id, e.id, left(e.name, 120), auth.uid())
  ON CONFLICT (workspace_id, erp_workspace_id) DO UPDATE SET erp_name = EXCLUDED.erp_name
  RETURNING id INTO link;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details) VALUES
    (t.id, auth.uid(), 'erp_link.added', jsonb_build_object('link_id', link, 'erp_workspace_id', e.id, 'erp_name', e.name)),
    (e.id, auth.uid(), 'terminal_link.added', jsonb_build_object('link_id', link, 'terminal_workspace_id', t.id, 'terminal_name', t.name));
  RETURN link;
END;
$$;

CREATE OR REPLACE FUNCTION public.ps_unlink_erp(p_link_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  l public.ps_erp_links;
BEGIN
  SELECT * INTO l FROM public.ps_erp_links WHERE id = p_link_id;
  IF l.id IS NULL THEN RAISE EXCEPTION 'Link not found' USING ERRCODE = 'P0002'; END IF;
  -- The TERMINAL's managers, or the ERP's Owner or an Admin.
  IF NOT ((public.erp_has_permission(l.workspace_id, 'integrations.manage') AND public.erp_session_aal() = 'aal2')
          OR (COALESCE(public.erp_workspace_role(l.erp_workspace_id), '') IN ('owner', 'admin')
              AND public.erp_workspace_mfa_ok(l.erp_workspace_id))) THEN
    RAISE EXCEPTION 'You are not allowed to remove this link' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
  DELETE FROM public.ps_erp_links WHERE id = l.id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details) VALUES
    (l.workspace_id, auth.uid(), 'erp_link.removed', jsonb_build_object('link_id', l.id, 'erp_workspace_id', l.erp_workspace_id, 'erp_name', l.erp_name)),
    (l.erp_workspace_id, auth.uid(), 'terminal_link.removed', jsonb_build_object('link_id', l.id, 'terminal_workspace_id', l.workspace_id));
END;
$$;

REVOKE ALL ON FUNCTION public.ps_link_erp(UUID, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.ps_unlink_erp(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ps_link_erp(UUID, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ps_unlink_erp(UUID) TO authenticated;
