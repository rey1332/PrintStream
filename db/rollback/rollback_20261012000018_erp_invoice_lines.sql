-- Rollback for 20261012000018_erp_invoice_lines.sql.
-- Run only after redeploying an app version from before this change.
--
-- DROPS every invoice line. Invoices keep their totals; manual invoices then
-- show one amount again. Export the lines first if they are needed:
--   \copy (select * from public.erp_invoice_lines order by invoice_id, position) to 'invoice_lines.csv' csv header

BEGIN;
DROP FUNCTION IF EXISTS public.erp_create_invoice_v6(UUID, UUID, TEXT, DATE, DATE, JSONB, NUMERIC, TEXT, NUMERIC);
DROP TRIGGER IF EXISTS trg_erp_invoice_lines_from_order ON public.erp_invoices;
DROP FUNCTION IF EXISTS public.erp_invoice_lines_from_order();
DROP TABLE IF EXISTS public.erp_invoice_lines;
COMMIT;
