-- Rollback for 20261012000039_terminal_module.sql.
-- TERMINAL becomes available to every ERP again (as before this change).

BEGIN;
DO $$
DECLARE
  def TEXT;
BEGIN
  def := pg_get_functiondef('ps_worker.due_schedules(integer)'::regprocedure);
  EXECUTE replace(def, ' AND public.ps__terminal_on(s.workspace_id)', '');
  FOREACH def IN ARRAY ARRAY[
    pg_get_functiondef('public.ps_enqueue_job(uuid,text,jsonb,text,timestamptz)'::regprocedure),
    pg_get_functiondef('public.ps__writable(uuid,text)'::regprocedure)] LOOP
    EXECUTE regexp_replace(def, E'\\n  IF NOT public\\.ps__terminal_on\\([a-z_.]+\\) THEN\\n[^\\n]*\\n  END IF;', '');
  END LOOP;
END;
$$;
DROP FUNCTION IF EXISTS public.erp_set_terminal(UUID, BOOLEAN);
DROP FUNCTION IF EXISTS public.erp_my_terminals();
DROP FUNCTION IF EXISTS public.ps__terminal_on(UUID);
ALTER TABLE public.erp_workspaces DROP COLUMN IF EXISTS terminal_enabled;
COMMIT;
