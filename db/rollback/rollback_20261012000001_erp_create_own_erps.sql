-- Rollback for 20261012000001_erp_create_own_erps.sql.
-- Run only after redeploying an app version from before created ERPs.
--
-- Restores erp_my_workspaces and erp_set_workspace_require_mfa as before and
-- removes creating / deleting ERPs. Not restored: ERPs already created stay
-- (with their data and internal owner accounts); their creators keep the
-- Owner role in them. Delete them first (Settings → Delete this ERP) if they
-- should go.

BEGIN;

DROP FUNCTION IF EXISTS public.erp_create_erp(TEXT);
DROP FUNCTION IF EXISTS public.erp_delete_erp(UUID);


CREATE OR REPLACE FUNCTION public.erp_my_workspaces()
RETURNS TABLE (workspace_id UUID, name TEXT, role TEXT, is_owner BOOLEAN, is_personal BOOLEAN, owner_id UUID, owner_email TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  PERFORM public.erp_personal_workspace_id(auth.uid());
  RETURN QUERY
  SELECT w.id, w.name, m.role, w.owner_id = auth.uid(), w.is_personal, w.owner_id, owner_profile.email
  FROM public.erp_workspace_members m
  JOIN public.erp_workspaces w ON w.id = m.workspace_id
  LEFT JOIN public.user_profiles owner_profile ON owner_profile.id = w.owner_id
  WHERE m.user_id = auth.uid() AND m.status = 'active'
  ORDER BY (w.owner_id = auth.uid()) DESC, w.name;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_my_workspaces() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_my_workspaces() TO authenticated;

CREATE OR REPLACE FUNCTION public.erp_set_workspace_require_mfa(p_workspace_id UUID, p_required BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE w public.erp_workspaces;
BEGIN
  SELECT * INTO w FROM public.erp_workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR w.owner_id <> auth.uid() THEN
    RAISE EXCEPTION 'Only the workspace owner can change this setting' USING ERRCODE = '42501';
  END IF;
  IF p_required AND public.erp_session_aal() <> 'aal2' THEN
    RAISE EXCEPTION 'Turn on two-factor authentication for your own account first' USING ERRCODE = 'P0001';
  END IF;
  IF w.require_mfa IS DISTINCT FROM p_required THEN
    UPDATE public.erp_workspaces SET require_mfa = p_required, updated_at = now() WHERE id = w.id;
    INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
    VALUES (w.id, auth.uid(), CASE WHEN p_required THEN 'workspace.mfa_required' ELSE 'workspace.mfa_optional' END, '{}'::jsonb);
  END IF;
END;
$$;

DO $$
DECLARE
  patches TEXT[][] := ARRAY[
    ['public.erp_fx__change_base(uuid,uuid,text)', 'IF NOT public.erp__is_erp_owner(p_owner, p_workspace_id) THEN',
     'IF p_owner IS DISTINCT FROM auth.uid() THEN'],
    ['public.erp_confirm_base_currency(uuid,text,bigint)', 'IF NOT public.erp__is_erp_owner(owner, p_workspace_id) THEN',
     'IF owner IS DISTINCT FROM auth.uid() THEN'],
    ['public.erp_currency_settings_get(uuid)', 'public.erp__is_erp_owner(owner, p_workspace_id)',
     'owner = auth.uid()']
  ];
  i INTEGER;
BEGIN
  FOR i IN 1 .. array_length(patches, 1) LOOP
    EXECUTE replace(pg_get_functiondef(patches[i][1]::regprocedure), patches[i][2], patches[i][3]);
  END LOOP;
END;
$$;
DROP FUNCTION IF EXISTS public.erp__is_erp_owner(UUID, UUID);

ALTER TABLE public.erp_workspaces DROP COLUMN IF EXISTS created_by;

COMMIT;
