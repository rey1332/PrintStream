-- TERMINAL as a module an ERP adds (Dashboard → Add modules), per ERP.
--
-- * erp_workspaces.terminal_enabled: the Owner or an Admin adds or removes
--   TERMINAL for their ERP (erp_set_terminal). It does not count toward the
--   ERP limit.
-- * Removing it hides TERMINAL and stops new work: no new jobs
--   (ps_enqueue_job), no writes to datasets (ps__writable), no scheduled runs
--   (ps_worker.due_schedules). Nothing recorded is deleted; adding it again
--   brings everything back.
-- * ERPs that already have workflows (now pipelines) start with it added.
--
-- Rollback: db/rollback/rollback_20261012000039_terminal_module.sql

ALTER TABLE public.erp_workspaces ADD COLUMN IF NOT EXISTS terminal_enabled BOOLEAN NOT NULL DEFAULT false;

UPDATE public.erp_workspaces w SET terminal_enabled = true
 WHERE NOT w.terminal_enabled AND EXISTS (SELECT 1 FROM public.workflows f WHERE f.workspace_id = w.id);

CREATE OR REPLACE FUNCTION public.ps__terminal_on(p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT w.terminal_enabled FROM public.erp_workspaces w WHERE w.id = p_workspace_id), false);
$$;

-- The caller's ERPs: whether TERMINAL is added, and whether they may change that.
CREATE OR REPLACE FUNCTION public.erp_my_terminals()
RETURNS TABLE (workspace_id UUID, enabled BOOLEAN, can_manage BOOLEAN)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT w.id, w.terminal_enabled, public.erp_workspace_role(w.id) IN ('owner', 'admin')
    FROM public.erp_workspaces w
   WHERE public.erp_workspace_role(w.id) IS NOT NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_set_terminal(p_workspace_id UUID, p_enabled BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w public.erp_workspaces;
BEGIN
  SELECT * INTO w FROM public.erp_workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR COALESCE(public.erp_workspace_role(w.id), '') NOT IN ('owner', 'admin')
     OR NOT public.erp_workspace_mfa_ok(w.id) THEN
    RAISE EXCEPTION 'Only the Owner or an Admin can add or remove TERMINAL' USING ERRCODE = '42501';
  END IF;
  IF w.terminal_enabled IS DISTINCT FROM COALESCE(p_enabled, false) THEN
    UPDATE public.erp_workspaces SET terminal_enabled = COALESCE(p_enabled, false), updated_at = now() WHERE id = w.id;
    INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
    VALUES (w.id, auth.uid(), CASE WHEN p_enabled THEN 'terminal.added' ELSE 'terminal.removed' END, '{}'::jsonb);
  END IF;
END;
$$;

-- New work only while TERMINAL is added.
DO $$
DECLARE
  def TEXT;
  anchor TEXT;
  check_sql TEXT := $q$
  IF NOT public.ps__terminal_on(%s) THEN
    RAISE EXCEPTION 'TERMINAL is not added to this ERP (Dashboard → Add modules)' USING ERRCODE = 'P0001', HINT = 'terminal_off';
  END IF;$q$;
BEGIN
  def := pg_get_functiondef('public.ps_enqueue_job(uuid,text,jsonb,text,timestamptz)'::regprocedure);
  IF position('ps__terminal_on' IN def) = 0 THEN
    anchor := $q$    RAISE EXCEPTION 'You are not allowed to do that in this workspace' USING ERRCODE = '42501';
  END IF;$q$;
    IF position(anchor IN def) = 0 THEN RAISE EXCEPTION 'ps_enqueue_job has changed; update this migration'; END IF;
    EXECUTE replace(def, anchor, anchor || format(check_sql, 'p_workspace_id'));
  END IF;

  def := pg_get_functiondef('public.ps__writable(uuid,text)'::regprocedure);
  IF position('ps__terminal_on' IN def) = 0 THEN
    anchor := $q$    RAISE EXCEPTION 'You are not allowed to write this dataset' USING ERRCODE = '42501';
  END IF;$q$;
    IF position(anchor IN def) = 0 THEN RAISE EXCEPTION 'ps__writable has changed; update this migration'; END IF;
    EXECUTE replace(def, anchor, anchor || format(check_sql, 'd.workspace_id'));
  END IF;

  def := pg_get_functiondef('ps_worker.due_schedules(integer)'::regprocedure);
  IF position('ps__terminal_on' IN def) = 0 THEN
    IF position('s.next_run_at IS NOT NULL' IN def) = 0 THEN RAISE EXCEPTION 'due_schedules has changed; update this migration'; END IF;
    EXECUTE replace(def, 's.next_run_at IS NOT NULL', 's.next_run_at IS NOT NULL AND public.ps__terminal_on(s.workspace_id)');
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.ps__terminal_on(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_my_terminals() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_set_terminal(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_my_terminals() TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_set_terminal(UUID, BOOLEAN) TO authenticated;
