-- Rollback for 20260929000000_erp_general_ledger.sql. Removes the ledger
-- (chart of accounts, journals, accounting settings) and its posting triggers.
-- ERP documents are not touched. The reset functions keep a call to
-- erp_gl__clear, so a no-op stub is left in its place.
BEGIN;
DROP TRIGGER IF EXISTS trg_erp_gl_invoice ON public.erp_invoices;
DROP TRIGGER IF EXISTS trg_erp_gl_payment ON public.erp_payments;
DROP TRIGGER IF EXISTS trg_erp_gl_transaction ON public.erp_transactions;
DROP TRIGGER IF EXISTS trg_erp_gl_fulfillment ON public.erp_fulfillment_events;
DROP TRIGGER IF EXISTS trg_erp_gl_stock ON public.erp_stock_movements;

DROP FUNCTION IF EXISTS public.erp_set_gl_account_active(UUID, BOOLEAN);
DROP FUNCTION IF EXISTS public.erp_create_gl_account(UUID, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.erp_reverse_journal(UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_post_journal(UUID, DATE, TEXT, JSONB);
DROP FUNCTION IF EXISTS public.erp_journal_list(UUID, DATE, DATE, UUID, INTEGER, INTEGER);
DROP FUNCTION IF EXISTS public.erp_trial_balance(UUID, DATE, DATE);
DROP FUNCTION IF EXISTS public.erp_accounting_settings_set(UUID, TEXT, DATE);
DROP FUNCTION IF EXISTS public.erp_accounting_settings_get(UUID);
DROP FUNCTION IF EXISTS public.erp_gl__scope(UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_gl__on_stock_movement();
DROP FUNCTION IF EXISTS public.erp_gl__on_fulfillment();
DROP FUNCTION IF EXISTS public.erp_gl__post_fulfillment(UUID);
DROP FUNCTION IF EXISTS public.erp_gl__on_transaction();
DROP FUNCTION IF EXISTS public.erp_gl__on_payment();
DROP FUNCTION IF EXISTS public.erp_gl__payment_lines(public.erp_payments, NUMERIC);
DROP FUNCTION IF EXISTS public.erp_gl__on_invoice();

DROP TABLE IF EXISTS public.erp_journal_lines;
DROP TABLE IF EXISTS public.erp_journal_entries;
DROP TABLE IF EXISTS public.erp_gl_accounts;
DROP TABLE IF EXISTS public.erp_accounting_settings;

DROP FUNCTION IF EXISTS public.erp_gl__check_balanced();
DROP FUNCTION IF EXISTS public.erp_gl__pair(TEXT, TEXT, NUMERIC);
DROP FUNCTION IF EXISTS public.erp_gl__reverse(UUID, TEXT, DATE, TEXT, TEXT, UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_gl__post(UUID, DATE, TEXT, TEXT, UUID, TEXT, JSONB, UUID);
DROP FUNCTION IF EXISTS public.erp_gl__account(UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_gl__seed(UUID);

CREATE OR REPLACE FUNCTION public.erp_gl__clear(p_user_id UUID, p_accounts BOOLEAN)
RETURNS VOID LANGUAGE sql AS $$ SELECT NULL::VOID $$;
REVOKE ALL ON FUNCTION public.erp_gl__clear(UUID, BOOLEAN) FROM PUBLIC, anon, authenticated;
COMMIT;
