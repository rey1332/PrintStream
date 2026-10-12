-- Rollback for 20261012000006_erp_document_numbers.sql.
-- Run only after redeploying an app version from before document numbers.
-- The numbers are removed from the documents.

BEGIN;

-- Search without the number (as in 20261005000000_erp_ontology_search.sql).
DO $$
DECLARE fn REGPROCEDURE;
BEGIN
  FOR fn IN SELECT p.oid::REGPROCEDURE FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'erp_ontology_search'
  LOOP
    EXECUTE replace(pg_get_functiondef(fn), $p$coalesce(t.doc_no, '') || ' ' || $p$, '');
  END LOOP;
END;
$$;

DROP TRIGGER IF EXISTS trg_erp_doc_no ON public.erp_invoices;
DROP TRIGGER IF EXISTS trg_erp_doc_no ON public.erp_sales_orders;
DROP TRIGGER IF EXISTS trg_erp_doc_no ON public.erp_purchase_orders;
DROP TRIGGER IF EXISTS trg_erp_doc_no ON public.erp_payments;
DROP INDEX IF EXISTS public.uq_erp_invoices_doc_no;
DROP INDEX IF EXISTS public.uq_erp_sales_orders_doc_no;
DROP INDEX IF EXISTS public.uq_erp_purchase_orders_doc_no;
DROP INDEX IF EXISTS public.uq_erp_payments_doc_no;
ALTER TABLE public.erp_invoices DROP COLUMN IF EXISTS doc_no;
ALTER TABLE public.erp_sales_orders DROP COLUMN IF EXISTS doc_no;
ALTER TABLE public.erp_purchase_orders DROP COLUMN IF EXISTS doc_no;
ALTER TABLE public.erp_payments DROP COLUMN IF EXISTS doc_no;
DROP FUNCTION IF EXISTS public.erp_doc__assign();
DROP FUNCTION IF EXISTS public.erp_doc__format(TEXT, INTEGER, INTEGER);
DROP TABLE IF EXISTS public.erp_doc_sequences;

COMMIT;
