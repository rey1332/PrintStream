-- Rollback for 20261012000021_erp_delivery_notes.sql.
-- Run only after redeploying an app version from before this change.
-- DROPS the delivery and receipt numbers (SJ/…, GR/…) and their counters.

BEGIN;
DROP TRIGGER IF EXISTS trg_erp_doc_no ON public.erp_fulfillment_events;
DROP INDEX IF EXISTS public.uq_erp_fulfillment_events_doc_no;
ALTER TABLE public.erp_fulfillment_events DROP COLUMN IF EXISTS doc_no;
DELETE FROM public.erp_doc_sequences WHERE doc_type IN ('SJ', 'GR');
ALTER TABLE public.erp_doc_sequences DROP CONSTRAINT IF EXISTS erp_doc_sequences_doc_type_check;
ALTER TABLE public.erp_doc_sequences ADD CONSTRAINT erp_doc_sequences_doc_type_check
  CHECK (doc_type IN ('INV', 'SO', 'PO', 'RCV', 'PAY'));

CREATE OR REPLACE FUNCTION public.erp_doc__assign()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_type TEXT := TG_ARGV[0];
  v_year INTEGER;
  v_no INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.doc_no IS NOT NULL AND NEW.doc_no IS DISTINCT FROM OLD.doc_no THEN
      RAISE EXCEPTION 'Document numbers cannot be changed' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.doc_no IS NOT NULL OR NEW.workspace_id IS NULL THEN RETURN NEW; END IF;
  IF v_type = 'payment' THEN
    v_type := CASE WHEN (to_jsonb(NEW) ->> 'payment_type') = 'outgoing' THEN 'PAY' ELSE 'RCV' END;
  END IF;
  v_year := extract(year FROM COALESCE((to_jsonb(NEW) ->> TG_ARGV[1])::DATE, CURRENT_DATE))::INTEGER;
  INSERT INTO public.erp_doc_sequences AS s (workspace_id, doc_type, year, last_no)
  VALUES (NEW.workspace_id, v_type, v_year, 1)
  ON CONFLICT (workspace_id, doc_type, year) DO UPDATE SET last_no = s.last_no + 1
  RETURNING s.last_no INTO v_no;
  NEW.doc_no := public.erp_doc__format(v_type, v_year, v_no);
  RETURN NEW;
END;
$$;
COMMIT;
