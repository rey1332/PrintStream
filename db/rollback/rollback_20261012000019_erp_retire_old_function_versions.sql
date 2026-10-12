-- Rollback for 20261012000019_erp_retire_old_function_versions.sql.
-- Makes the superseded versions callable again (needed only for an app
-- version from before this change).

BEGIN;
GRANT EXECUTE ON FUNCTION public.erp_create_invoice(UUID, TEXT, DATE, DATE, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_create_invoice_v2(UUID, UUID, TEXT, DATE, DATE, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_create_invoice_v3(UUID, UUID, TEXT, DATE, DATE, NUMERIC, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_create_invoice_v4(UUID, UUID, TEXT, DATE, DATE, NUMERIC, NUMERIC, TEXT, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_create_purchase_order(UUID, TEXT, DATE, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_create_purchase_order_v2(UUID, UUID, TEXT, DATE, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_create_sales_order(UUID, TEXT, DATE, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_create_sales_order_v2(UUID, UUID, TEXT, DATE, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_issue_invoice_from_sales_order(UUID, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_record_purchase_receipt(UUID, JSONB, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_hr_payroll_runs(UUID) TO authenticated;
COMMIT;
