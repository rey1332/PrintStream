-- Numbers for deliveries and goods receipts (surat jalan).
--
-- Goods left the quarry without a numbered delivery note: a delivery was an
-- event on the sales order, identified only by its id. Every delivery now
-- gets a gap-free number per ERP and year, SJ/2026/0001 (surat jalan), and
-- every goods receipt GR/2026/0001, assigned like invoice and order numbers
-- (20261012000006) and never changed. Existing events are numbered in the
-- order they happened. The app prints a delivery note from it
-- (/erp/print/delivery/<event>).
--
-- Rollback: db/rollback/rollback_20261012000021_erp_delivery_notes.sql

ALTER TABLE public.erp_doc_sequences DROP CONSTRAINT IF EXISTS erp_doc_sequences_doc_type_check;
ALTER TABLE public.erp_doc_sequences ADD CONSTRAINT erp_doc_sequences_doc_type_check
  CHECK (doc_type IN ('INV', 'SO', 'PO', 'RCV', 'PAY', 'SJ', 'GR'));

ALTER TABLE public.erp_fulfillment_events ADD COLUMN IF NOT EXISTS doc_no TEXT;

-- As in 20261012000006_erp_document_numbers.sql, plus 'fulfillment': SJ for a
-- delivery, GR for a receipt, dated by when it was recorded.
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
  ELSIF v_type = 'fulfillment' THEN
    v_type := CASE WHEN (to_jsonb(NEW) ->> 'kind') = 'sales_delivery' THEN 'SJ' ELSE 'GR' END;
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

-- Existing deliveries and receipts, in the order they happened (triggers off:
-- no ledger or audit side effects).
ALTER TABLE public.erp_fulfillment_events DISABLE TRIGGER USER;
WITH typed AS (
  SELECT e.id, e.workspace_id, e.created_at,
         CASE WHEN e.kind = 'sales_delivery' THEN 'SJ' ELSE 'GR' END AS doc_type,
         extract(year FROM e.created_at)::INTEGER AS yr
    FROM public.erp_fulfillment_events e
   WHERE e.workspace_id IS NOT NULL AND e.doc_no IS NULL
), numbered AS (
  SELECT id, workspace_id, doc_type, yr,
         (SELECT COALESCE(max(s.last_no), 0) FROM public.erp_doc_sequences s
           WHERE s.workspace_id = typed.workspace_id AND s.doc_type = typed.doc_type AND s.year = typed.yr)
         + row_number() OVER (PARTITION BY workspace_id, doc_type, yr ORDER BY created_at, id) AS n
    FROM typed
), updated AS (
  UPDATE public.erp_fulfillment_events e SET doc_no = public.erp_doc__format(numbered.doc_type, numbered.yr, numbered.n::INTEGER)
    FROM numbered WHERE e.id = numbered.id
  RETURNING numbered.workspace_id, numbered.doc_type, numbered.yr, numbered.n
)
INSERT INTO public.erp_doc_sequences AS s (workspace_id, doc_type, year, last_no)
SELECT workspace_id, doc_type, yr, max(n)::INTEGER FROM updated GROUP BY workspace_id, doc_type, yr
ON CONFLICT (workspace_id, doc_type, year) DO UPDATE SET last_no = GREATEST(s.last_no, EXCLUDED.last_no);
ALTER TABLE public.erp_fulfillment_events ENABLE TRIGGER USER;

CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_fulfillment_events_doc_no
  ON public.erp_fulfillment_events (workspace_id, doc_no) WHERE doc_no IS NOT NULL;
DROP TRIGGER IF EXISTS trg_erp_doc_no ON public.erp_fulfillment_events;
CREATE TRIGGER trg_erp_doc_no BEFORE INSERT OR UPDATE OF doc_no ON public.erp_fulfillment_events
  FOR EACH ROW EXECUTE FUNCTION public.erp_doc__assign('fulfillment', 'created_at');
