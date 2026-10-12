-- Rollback for 20261012000026_erp_equipment.sql.
-- Run only after redeploying an app version from before this change.
-- Machines and their logs are removed. Stock movements and journal entries
-- of fuel issues stay (they explain the stock and the books).

BEGIN;
-- As in 20261012000025.
CREATE OR REPLACE FUNCTION public.erp__reset_modules(p_workspace_id UUID, p_scope TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.erp_weigh_tickets x WHERE x.workspace_id = p_workspace_id;
  DELETE FROM public.erp_production_runs x WHERE x.workspace_id = p_workspace_id;
  IF p_scope = 'all' THEN
    DELETE FROM public.erp_vehicles x WHERE x.workspace_id = p_workspace_id;
  END IF;
END;
$$;
DROP FUNCTION IF EXISTS public.erp_equipment_overview(UUID, DATE, DATE);
DROP FUNCTION IF EXISTS public.erp_equipment_log_reverse(UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_equipment_log(UUID, JSONB);
DROP FUNCTION IF EXISTS public.erp_equipment_save(UUID, JSONB);
DROP FUNCTION IF EXISTS public.erp__equipment_refresh(UUID);
DROP TABLE IF EXISTS public.erp_equipment_logs;
DROP TABLE IF EXISTS public.erp_equipment;
-- The journal keeps allowing fuel sources: entries already posted stay.
COMMIT;
