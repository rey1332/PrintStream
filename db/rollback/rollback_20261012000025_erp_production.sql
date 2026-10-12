-- Rollback for 20261012000025_erp_production.sql.
-- Run only after redeploying an app version from before this change.
-- Production runs are removed. Their stock movements and journal entries
-- stay (they explain the stock and the books).

BEGIN;
-- As in 20261012000024.
CREATE OR REPLACE FUNCTION public.erp__reset_modules(p_workspace_id UUID, p_scope TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.erp_weigh_tickets x WHERE x.workspace_id = p_workspace_id;
  IF p_scope = 'all' THEN
    DELETE FROM public.erp_vehicles x WHERE x.workspace_id = p_workspace_id;
  END IF;
END;
$$;
DROP FUNCTION IF EXISTS public.erp_production_summary(UUID, DATE, DATE);
DROP FUNCTION IF EXISTS public.erp_production_reverse(UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_production_record(UUID, JSONB);
DROP FUNCTION IF EXISTS public.erp_wh__move(UUID, UUID, UUID, UUID, NUMERIC, BOOLEAN);
DROP TABLE IF EXISTS public.erp_production_outputs;
DROP TABLE IF EXISTS public.erp_production_runs;
DELETE FROM public.erp_doc_sequences WHERE doc_type = 'PRD';
ALTER TABLE public.erp_doc_sequences DROP CONSTRAINT IF EXISTS erp_doc_sequences_doc_type_check;
ALTER TABLE public.erp_doc_sequences ADD CONSTRAINT erp_doc_sequences_doc_type_check
  CHECK (doc_type IN ('INV', 'SO', 'PO', 'RCV', 'PAY', 'SJ', 'GR', 'WB'));
-- The journal keeps allowing production sources: entries already posted stay.
COMMIT;
