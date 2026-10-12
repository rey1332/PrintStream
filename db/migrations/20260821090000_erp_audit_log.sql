-- ─── ERP Audit Log Migration ──────────────────────────────────────────────────
-- Creates erp_audit_log table auto-populated by triggers on all ERP tables.
-- Also creates a delete_all_transactions function for the Settings page.

-- 1. Create audit log table
CREATE TABLE IF NOT EXISTS public.erp_audit_log (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  table_name    TEXT NOT NULL DEFAULT '',
  record_id     UUID,
  action        TEXT NOT NULL DEFAULT '',   -- INSERT | UPDATE | DELETE
  changed_by    TEXT NOT NULL DEFAULT '',   -- email or user id
  before_data   JSONB,
  after_data    JSONB,
  created_at    TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_erp_audit_log_user_id    ON public.erp_audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_erp_audit_log_table_name ON public.erp_audit_log(table_name);
CREATE INDEX IF NOT EXISTS idx_erp_audit_log_created_at ON public.erp_audit_log(created_at DESC);

-- 2. Enable RLS
ALTER TABLE public.erp_audit_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_manage_own_erp_audit_log" ON public.erp_audit_log;
CREATE POLICY "users_manage_own_erp_audit_log"
  ON public.erp_audit_log
  FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- 3. Generic audit trigger function
CREATE OR REPLACE FUNCTION public.erp_audit_trigger_fn()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $func$
DECLARE
  v_user_id   UUID;
  v_record_id UUID;
  v_action    TEXT;
  v_before    JSONB;
  v_after     JSONB;
  v_email     TEXT;
BEGIN
  -- Determine action
  v_action := TG_OP;

  -- Resolve user_id and record_id from the row
  IF TG_OP = 'DELETE' THEN
    v_user_id   := OLD.user_id;
    v_record_id := OLD.id;
    v_before    := to_jsonb(OLD);
    v_after     := NULL;
  ELSIF TG_OP = 'INSERT' THEN
    v_user_id   := NEW.user_id;
    v_record_id := NEW.id;
    v_before    := NULL;
    v_after     := to_jsonb(NEW);
  ELSE
    -- UPDATE
    v_user_id   := NEW.user_id;
    v_record_id := NEW.id;
    v_before    := to_jsonb(OLD);
    v_after     := to_jsonb(NEW);
  END IF;

  -- Resolve email for changed_by
  SELECT email INTO v_email FROM auth.users WHERE id = v_user_id LIMIT 1;
  IF v_email IS NULL THEN
    v_email := COALESCE(v_user_id::TEXT, 'system');
  END IF;

  INSERT INTO public.erp_audit_log (user_id, table_name, record_id, action, changed_by, before_data, after_data)
  VALUES (v_user_id, TG_TABLE_NAME, v_record_id, v_action, v_email, v_before, v_after);

  RETURN COALESCE(NEW, OLD);
END;
$func$;

-- 4. Attach audit triggers to all ERP tables

-- erp_transactions
DROP TRIGGER IF EXISTS trg_audit_erp_transactions ON public.erp_transactions;
CREATE TRIGGER trg_audit_erp_transactions
  AFTER INSERT OR UPDATE OR DELETE ON public.erp_transactions
  FOR EACH ROW EXECUTE FUNCTION public.erp_audit_trigger_fn();

-- erp_invoices
DROP TRIGGER IF EXISTS trg_audit_erp_invoices ON public.erp_invoices;
CREATE TRIGGER trg_audit_erp_invoices
  AFTER INSERT OR UPDATE OR DELETE ON public.erp_invoices
  FOR EACH ROW EXECUTE FUNCTION public.erp_audit_trigger_fn();

-- erp_payments
DROP TRIGGER IF EXISTS trg_audit_erp_payments ON public.erp_payments;
CREATE TRIGGER trg_audit_erp_payments
  AFTER INSERT OR UPDATE OR DELETE ON public.erp_payments
  FOR EACH ROW EXECUTE FUNCTION public.erp_audit_trigger_fn();

-- erp_purchase_orders
DROP TRIGGER IF EXISTS trg_audit_erp_purchase_orders ON public.erp_purchase_orders;
CREATE TRIGGER trg_audit_erp_purchase_orders
  AFTER INSERT OR UPDATE OR DELETE ON public.erp_purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.erp_audit_trigger_fn();

-- erp_sales_orders
DROP TRIGGER IF EXISTS trg_audit_erp_sales_orders ON public.erp_sales_orders;
CREATE TRIGGER trg_audit_erp_sales_orders
  AFTER INSERT OR UPDATE OR DELETE ON public.erp_sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.erp_audit_trigger_fn();

-- erp_products
DROP TRIGGER IF EXISTS trg_audit_erp_products ON public.erp_products;
CREATE TRIGGER trg_audit_erp_products
  AFTER INSERT OR UPDATE OR DELETE ON public.erp_products
  FOR EACH ROW EXECUTE FUNCTION public.erp_audit_trigger_fn();

-- erp_customers
DROP TRIGGER IF EXISTS trg_audit_erp_customers ON public.erp_customers;
CREATE TRIGGER trg_audit_erp_customers
  AFTER INSERT OR UPDATE OR DELETE ON public.erp_customers
  FOR EACH ROW EXECUTE FUNCTION public.erp_audit_trigger_fn();

-- erp_suppliers
DROP TRIGGER IF EXISTS trg_audit_erp_suppliers ON public.erp_suppliers;
CREATE TRIGGER trg_audit_erp_suppliers
  AFTER INSERT OR UPDATE OR DELETE ON public.erp_suppliers
  FOR EACH ROW EXECUTE FUNCTION public.erp_audit_trigger_fn();

-- erp_stock_movements
DROP TRIGGER IF EXISTS trg_audit_erp_stock_movements ON public.erp_stock_movements;
CREATE TRIGGER trg_audit_erp_stock_movements
  AFTER INSERT OR UPDATE OR DELETE ON public.erp_stock_movements
  FOR EACH ROW EXECUTE FUNCTION public.erp_audit_trigger_fn();

-- 5. Delete-all-transactions function (used by Settings page)
-- Deletes all transaction-related data for a user in correct dependency order
-- and clears the audit log entries for those tables.
CREATE OR REPLACE FUNCTION public.erp_delete_all_transactions(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $func$
BEGIN
  -- NULL auth.uid() must fail closed; SQL comparisons with NULL don't evaluate true.
  IF auth.uid() IS NULL OR p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- Delete in dependency order (children first)
  DELETE FROM public.erp_stock_movements   WHERE user_id = p_user_id;
  DELETE FROM public.erp_transactions      WHERE user_id = p_user_id;
  DELETE FROM public.erp_payments          WHERE user_id = p_user_id;
  DELETE FROM public.erp_invoices          WHERE user_id = p_user_id;
  DELETE FROM public.erp_purchase_order_items
    WHERE purchase_order_id IN (
      SELECT id FROM public.erp_purchase_orders WHERE user_id = p_user_id
    );
  DELETE FROM public.erp_purchase_orders   WHERE user_id = p_user_id;
  DELETE FROM public.erp_sales_order_items
    WHERE sales_order_id IN (
      SELECT id FROM public.erp_sales_orders WHERE user_id = p_user_id
    );
  DELETE FROM public.erp_sales_orders      WHERE user_id = p_user_id;

  -- Also clear audit log entries for this user so the log stays consistent
  DELETE FROM public.erp_audit_log WHERE user_id = p_user_id;
END;
$func$;

REVOKE ALL ON FUNCTION public.erp_delete_all_transactions(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_delete_all_transactions(UUID) TO authenticated;
