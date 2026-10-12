-- Rollback for 20261012000024_erp_weighbridge.sql.
-- Run only after redeploying an app version from before this change.
-- Weigh tickets, trucks and credit limits are removed. Stock movements and
-- journal entries of completed tickets stay (they explain the stock and the
-- books); their source no longer exists.

BEGIN;
CREATE OR REPLACE FUNCTION pg_temp.erp_patch(p_fn REGPROCEDURE, p_pairs TEXT[])
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  body TEXT := pg_get_functiondef(p_fn);
  i INTEGER;
BEGIN
  FOR i IN 1 .. COALESCE(array_length(p_pairs, 1), 0) BY 2 LOOP
    IF position(p_pairs[i] IN body) = 0 THEN
      RAISE EXCEPTION 'erp_patch: % does not contain %', p_fn, p_pairs[i];
    END IF;
    body := replace(body, p_pairs[i], p_pairs[i + 1]);
  END LOOP;
  RETURN body;
END;
$$;
DO $$
BEGIN
  EXECUTE pg_temp.erp_patch('public.erp_reset_workspace(uuid, text)'::regprocedure, ARRAY[
    '  -- Industry modules first (20261012000024).
  PERFORM public.erp__reset_modules(ws, p_scope);
', '']);
END;
$$;

DROP TRIGGER IF EXISTS trg_erp_weigh_release_on_void ON public.erp_invoices;
DROP FUNCTION IF EXISTS public.erp_weigh__release_on_void();
DROP FUNCTION IF EXISTS public.erp__reset_modules(UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_weigh_customers(UUID);
DROP FUNCTION IF EXISTS public.erp_weighbridge_summary(UUID, DATE, DATE);
DROP FUNCTION IF EXISTS public.erp_weigh_tickets_invoice(UUID, UUID, DATE, DATE, NUMERIC, DATE);
DROP FUNCTION IF EXISTS public.erp_weigh_cancel(UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_weigh_out(UUID, NUMERIC, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS public.erp_weigh_in(UUID, JSONB);
DROP FUNCTION IF EXISTS public.erp_vehicle_save(UUID, JSONB);
DROP FUNCTION IF EXISTS public.erp__weigh_qty(NUMERIC, TEXT, NUMERIC);
DROP FUNCTION IF EXISTS public.erp__weigh_credit_check(UUID, UUID, NUMERIC, TEXT);
DROP FUNCTION IF EXISTS public.erp__customer_exposure(UUID);
DROP FUNCTION IF EXISTS public.erp__weigh_ws(UUID, TEXT);
DROP TABLE IF EXISTS public.erp_weigh_tickets;
DROP TABLE IF EXISTS public.erp_vehicles;
DELETE FROM public.erp_doc_sequences WHERE doc_type = 'WB';
ALTER TABLE public.erp_doc_sequences DROP CONSTRAINT IF EXISTS erp_doc_sequences_doc_type_check;
ALTER TABLE public.erp_doc_sequences ADD CONSTRAINT erp_doc_sequences_doc_type_check
  CHECK (doc_type IN ('INV', 'SO', 'PO', 'RCV', 'PAY', 'SJ', 'GR'));
-- The journal keeps allowing weigh_ticket sources: entries already posted stay.
ALTER TABLE public.erp_customers DROP COLUMN IF EXISTS credit_limit;
COMMIT;
