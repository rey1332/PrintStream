-- Rollback for 20261012000033_data_access_log.sql.
-- Run only after redeploying an app version from before this change.
-- The data-access log and its partitions are dropped (export them first if
-- they must be kept). The ontology search log keeps its own table.

BEGIN;
DROP FUNCTION IF EXISTS etna_platform.admin_data_access_log(UUID, UUID, TIMESTAMPTZ, INTEGER, TEXT);
DROP FUNCTION IF EXISTS public.erp_data_access_log(UUID, TIMESTAMPTZ, INTEGER, UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_log_data_access(UUID, TEXT, TEXT, TEXT, INTEGER, TEXT[], TEXT, JSONB);
DROP FUNCTION IF EXISTS etna_platform.log_data_access_system(UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, JSONB);

-- erp_log_access as before (without the copy into the data-access log).
CREATE OR REPLACE FUNCTION public.erp_log_access(p_workspace_id uuid, p_action text, p_object_types text[], p_object_id uuid, p_result_count integer)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Not signed in' USING ERRCODE = '42501';
  END IF;
  IF p_workspace_id IS NOT NULL AND NOT public.erp_is_member(p_workspace_id) THEN
    RAISE EXCEPTION 'Not allowed' USING ERRCODE = '42501';
  END IF;
  IF p_action NOT IN ('search', 'view')
     OR COALESCE(cardinality(p_object_types), 0) > 20
     OR EXISTS (SELECT 1 FROM unnest(p_object_types) x WHERE x !~ '^[a-zA-Z]{1,40}$') THEN
    RAISE EXCEPTION 'Invalid access log entry' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.erp_access_log (workspace_id, actor_id, action, object_types, object_id, result_count)
  VALUES (p_workspace_id, auth.uid(), p_action, COALESCE(p_object_types, '{}'), p_object_id, p_result_count);
END;
$function$;

-- purge_by_retention as in 20261012000032 (without the data-access part).
CREATE OR REPLACE FUNCTION etna_platform.purge_by_retention()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, public, pg_temp
AS $$
DECLARE
  security_removed INTEGER := 0;
  audit_removed INTEGER := 0;
  runs_removed INTEGER := 0;
  platform_days INTEGER := etna_platform.effective_retention_days(NULL, 'security');
BEGIN
  PERFORM set_config('etna.security_log_purge', 'on', true);
  DELETE FROM etna_platform.security_events e
   WHERE NOT etna_platform.on_legal_hold(e.workspace_id)
     AND e.occurred_at < now() - make_interval(days => COALESCE(
           CASE WHEN e.workspace_id IS NULL THEN platform_days ELSE etna_platform.effective_retention_days(e.workspace_id, 'security') END,
           365000));
  GET DIAGNOSTICS security_removed = ROW_COUNT;
  PERFORM set_config('etna.security_log_purge', 'off', true);
  DELETE FROM public.erp_workspace_audit_log a
   WHERE NOT etna_platform.on_legal_hold(a.workspace_id)
     AND a.created_at < now() - make_interval(days => COALESCE(etna_platform.effective_retention_days(a.workspace_id, 'workspace_audit'), 365000));
  GET DIAGNOSTICS audit_removed = ROW_COUNT;
  DELETE FROM public.workflow_runs r
   WHERE r.workspace_id IS NOT NULL AND r.status <> 'running'
     AND NOT etna_platform.on_legal_hold(r.workspace_id)
     AND r.started_at < now() - make_interval(days => COALESCE(etna_platform.effective_retention_days(r.workspace_id, 'run_history'), 365000));
  GET DIAGNOSTICS runs_removed = ROW_COUNT;
  PERFORM etna_platform._log('RETENTION_PURGED', 'success', 'system', NULL, NULL, NULL,
    jsonb_build_object('security_events', security_removed, 'workspace_audit', audit_removed, 'runs', runs_removed));
  RETURN jsonb_build_object('security_events', security_removed, 'workspace_audit', audit_removed, 'runs', runs_removed);
END;
$$;
REVOKE ALL ON FUNCTION etna_platform.purge_by_retention() FROM PUBLIC, anon, authenticated;

DROP FUNCTION IF EXISTS etna_platform._data_access_insert(UUID, UUID, TEXT, TEXT, TEXT, TEXT, INTEGER, TEXT[], TEXT, JSONB);
DROP TABLE IF EXISTS etna_platform.data_access_log;
DROP FUNCTION IF EXISTS etna_platform._data_access_log_immutable();
DROP FUNCTION IF EXISTS etna_platform.ensure_data_access_partitions(INTEGER);
COMMIT;
