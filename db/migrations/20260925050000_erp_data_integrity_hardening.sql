-- Secure destructive ERP RPCs and provide the complete account-data reset RPC
-- used by Settings. Both functions run atomically inside PostgreSQL.

-- Profiles are provisioned by the auth trigger; clients only need to read their
-- own profile and must not be able to rewrite the identity/email record.
DO $$
DECLARE existing_policy RECORD;
BEGIN
  FOR existing_policy IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'user_profiles'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.user_profiles', existing_policy.policyname);
  END LOOP;
END;
$$;
ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_profiles_read_own
  ON public.user_profiles FOR SELECT TO authenticated
  USING (id = (SELECT auth.uid()));
GRANT SELECT ON public.user_profiles TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.user_profiles FROM PUBLIC, anon, authenticated;

-- Audit rows are append-only to normal users. SECURITY DEFINER triggers and
-- the guarded reset RPC remain responsible for writes/deletions.
DO $$
DECLARE existing_policy RECORD;
BEGIN
  FOR existing_policy IN
    SELECT policyname FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'erp_audit_log'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.erp_audit_log', existing_policy.policyname);
  END LOOP;
END;
$$;
ALTER TABLE public.erp_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY erp_audit_log_read_own
  ON public.erp_audit_log FOR SELECT TO authenticated
  USING (user_id = (SELECT auth.uid()));
GRANT SELECT ON public.erp_audit_log TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.erp_audit_log FROM PUBLIC, anon, authenticated;

-- Orders contain derived totals and trigger approval/inventory side effects.
-- Do not let clients bypass those rules with direct table writes. All supported
-- mutations below validate ownership and commit the parent + lines atomically.
REVOKE INSERT, UPDATE, DELETE ON public.erp_purchase_orders,
  public.erp_purchase_order_items, public.erp_sales_orders,
  public.erp_sales_order_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.erp_purchase_orders, public.erp_purchase_order_items,
  public.erp_sales_orders, public.erp_sales_order_items TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.erp_invoices FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.erp_invoices TO authenticated;

CREATE OR REPLACE FUNCTION public.erp_create_invoice(
  p_customer_id UUID,
  p_customer_name TEXT,
  p_invoice_date DATE,
  p_due_date DATE,
  p_total NUMERIC(15,2)
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  canonical_customer_name TEXT;
  new_invoice_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_total IS NULL OR p_total < 0 THEN RAISE EXCEPTION 'Invoice total cannot be negative'; END IF;

  IF p_customer_id IS NOT NULL THEN
    SELECT name INTO canonical_customer_name FROM public.erp_customers
    WHERE id = p_customer_id AND user_id = auth.uid();
    IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found for this account'; END IF;
  ELSE
    canonical_customer_name := left(trim(COALESCE(p_customer_name, '')), 200);
    IF canonical_customer_name = '' THEN RAISE EXCEPTION 'Customer name is required'; END IF;
  END IF;

  INSERT INTO public.erp_invoices
    (user_id, customer_id, customer_name, invoice_date, due_date, status, total)
  VALUES
    (auth.uid(), p_customer_id, canonical_customer_name,
     COALESCE(p_invoice_date, CURRENT_DATE), COALESCE(p_due_date, CURRENT_DATE), 'unpaid', p_total)
  RETURNING id INTO new_invoice_id;
  RETURN new_invoice_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_create_purchase_order(
  p_supplier_id UUID,
  p_supplier_name TEXT,
  p_order_date DATE,
  p_notes TEXT,
  p_items JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_order_id UUID;
  canonical_supplier_name TEXT;
  item JSONB;
  product_id UUID;
  canonical_product_name TEXT;
  item_qty INTEGER;
  item_price NUMERIC(15,2);
  order_total NUMERIC(15,2) := 0;
  config public.erp_approval_settings%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Order items must be an array'; END IF;
  IF jsonb_array_length(p_items) < 1 OR jsonb_array_length(p_items) > 200 THEN
    RAISE EXCEPTION 'An order must contain between 1 and 200 items';
  END IF;

  IF p_supplier_id IS NOT NULL THEN
    SELECT name INTO canonical_supplier_name FROM public.erp_suppliers
    WHERE id = p_supplier_id AND user_id = auth.uid();
    IF NOT FOUND THEN RAISE EXCEPTION 'Supplier not found for this account'; END IF;
  ELSE
    canonical_supplier_name := left(trim(COALESCE(p_supplier_name, '')), 200);
    IF canonical_supplier_name = '' THEN RAISE EXCEPTION 'Supplier name is required'; END IF;
  END IF;

  INSERT INTO public.erp_purchase_orders
    (user_id, supplier_id, supplier_name, order_date, status, total, notes)
  VALUES
    (auth.uid(), p_supplier_id, canonical_supplier_name, COALESCE(p_order_date, CURRENT_DATE), 'pending', 0, left(COALESCE(p_notes, ''), 2000))
  RETURNING id INTO new_order_id;

  FOR item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    BEGIN
      item_qty := (item->>'qty')::INTEGER;
      item_price := (item->>'price')::NUMERIC(15,2);
      product_id := NULLIF(item->>'product_id', '')::UUID;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid purchase order item';
    END;
    IF item_qty IS NULL OR item_qty <= 0 OR item_price IS NULL OR item_price < 0 THEN
      RAISE EXCEPTION 'Item quantity must be positive and price cannot be negative';
    END IF;
    IF product_id IS NOT NULL THEN
      SELECT name INTO canonical_product_name FROM public.erp_products
      WHERE id = product_id AND user_id = auth.uid();
      IF NOT FOUND THEN RAISE EXCEPTION 'Product not found for this account'; END IF;
    ELSE
      canonical_product_name := left(trim(COALESCE(item->>'product_name', '')), 200);
      IF canonical_product_name = '' THEN RAISE EXCEPTION 'Product name is required'; END IF;
    END IF;
    order_total := order_total + item_qty * item_price;
    INSERT INTO public.erp_purchase_order_items
      (purchase_order_id, product_id, product_name, qty, price)
    VALUES (new_order_id, product_id, canonical_product_name, item_qty, item_price);
  END LOOP;

  UPDATE public.erp_purchase_orders SET total = order_total WHERE id = new_order_id;

  -- The regular insert trigger sees the initial total of zero. Create the
  -- threshold-based approval using the validated total after item calculation.
  SELECT * INTO config FROM public.erp_approval_settings WHERE owner_id = auth.uid();
  IF FOUND AND config.po_approval_threshold > 0
     AND order_total >= config.po_approval_threshold
     AND cardinality(config.approver_emails) > 0 THEN
    INSERT INTO public.erp_approval_requests
      (owner_id, requested_by, purchase_order_id, supplier_name, admin_email, amount, approver_emails)
    VALUES
      (auth.uid(), auth.uid(), new_order_id, canonical_supplier_name,
       config.admin_email, order_total, config.approver_emails)
    ON CONFLICT (purchase_order_id) DO NOTHING;
  END IF;
  RETURN new_order_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_create_sales_order(
  p_customer_id UUID,
  p_customer_name TEXT,
  p_order_date DATE,
  p_notes TEXT,
  p_items JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_order_id UUID;
  canonical_customer_name TEXT;
  item JSONB;
  product_id UUID;
  canonical_product_name TEXT;
  item_qty INTEGER;
  item_price NUMERIC(15,2);
  order_total NUMERIC(15,2) := 0;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Order items must be an array'; END IF;
  IF jsonb_array_length(p_items) < 1 OR jsonb_array_length(p_items) > 200 THEN
    RAISE EXCEPTION 'An order must contain between 1 and 200 items';
  END IF;

  IF p_customer_id IS NOT NULL THEN
    SELECT name INTO canonical_customer_name FROM public.erp_customers
    WHERE id = p_customer_id AND user_id = auth.uid();
    IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found for this account'; END IF;
  ELSE
    canonical_customer_name := left(trim(COALESCE(p_customer_name, '')), 200);
    IF canonical_customer_name = '' THEN RAISE EXCEPTION 'Customer name is required'; END IF;
  END IF;

  INSERT INTO public.erp_sales_orders
    (user_id, customer_id, customer_name, order_date, status, total, notes)
  VALUES
    (auth.uid(), p_customer_id, canonical_customer_name, COALESCE(p_order_date, CURRENT_DATE), 'draft', 0, left(COALESCE(p_notes, ''), 2000))
  RETURNING id INTO new_order_id;

  FOR item IN SELECT value FROM jsonb_array_elements(p_items)
  LOOP
    BEGIN
      item_qty := (item->>'qty')::INTEGER;
      item_price := (item->>'price')::NUMERIC(15,2);
      product_id := NULLIF(item->>'product_id', '')::UUID;
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'Invalid sales order item';
    END;
    IF item_qty IS NULL OR item_qty <= 0 OR item_price IS NULL OR item_price < 0 THEN
      RAISE EXCEPTION 'Item quantity must be positive and price cannot be negative';
    END IF;
    IF product_id IS NOT NULL THEN
      SELECT name INTO canonical_product_name FROM public.erp_products
      WHERE id = product_id AND user_id = auth.uid();
      IF NOT FOUND THEN RAISE EXCEPTION 'Product not found for this account'; END IF;
    ELSE
      canonical_product_name := left(trim(COALESCE(item->>'product_name', '')), 200);
      IF canonical_product_name = '' THEN RAISE EXCEPTION 'Product name is required'; END IF;
    END IF;
    order_total := order_total + item_qty * item_price;
    INSERT INTO public.erp_sales_order_items
      (sales_order_id, product_id, product_name, qty, price)
    VALUES (new_order_id, product_id, canonical_product_name, item_qty, item_price);
  END LOOP;

  UPDATE public.erp_sales_orders SET total = order_total WHERE id = new_order_id;
  RETURN new_order_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_update_purchase_order_status(
  p_purchase_order_id UUID,
  p_status TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE current_status public.po_status;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  IF p_status NOT IN ('approved', 'received') THEN RAISE EXCEPTION 'Invalid purchase order transition'; END IF;
  SELECT status INTO current_status FROM public.erp_purchase_orders
  WHERE id = p_purchase_order_id AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order not found'; END IF;
  IF (p_status = 'approved' AND current_status <> 'pending')
     OR (p_status = 'received' AND current_status <> 'approved') THEN
    RAISE EXCEPTION 'Invalid purchase order transition';
  END IF;
  UPDATE public.erp_purchase_orders SET status = p_status::public.po_status
  WHERE id = p_purchase_order_id AND user_id = auth.uid();
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_deliver_sales_order(p_sales_order_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE current_status public.so_status;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required'; END IF;
  SELECT status INTO current_status FROM public.erp_sales_orders
  WHERE id = p_sales_order_id AND user_id = auth.uid() FOR UPDATE;
  IF NOT FOUND OR current_status <> 'invoiced' THEN
    RAISE EXCEPTION 'Only invoiced sales orders can be delivered';
  END IF;
  UPDATE public.erp_sales_orders SET status = 'delivered'
  WHERE id = p_sales_order_id AND user_id = auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.erp_create_purchase_order(UUID, TEXT, DATE, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_create_sales_order(UUID, TEXT, DATE, TEXT, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_create_invoice(UUID, TEXT, DATE, DATE, NUMERIC) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_update_purchase_order_status(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_deliver_sales_order(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_create_purchase_order(UUID, TEXT, DATE, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_create_sales_order(UUID, TEXT, DATE, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_create_invoice(UUID, TEXT, DATE, DATE, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_update_purchase_order_status(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_deliver_sales_order(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.erp_delete_all_transactions(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  DELETE FROM public.erp_stock_movements WHERE user_id = p_user_id;
  DELETE FROM public.erp_transactions WHERE user_id = p_user_id;
  DELETE FROM public.erp_payments WHERE user_id = p_user_id;
  DELETE FROM public.erp_invoices WHERE user_id = p_user_id;
  DELETE FROM public.erp_purchase_order_items
    WHERE purchase_order_id IN (SELECT id FROM public.erp_purchase_orders WHERE user_id = p_user_id);
  DELETE FROM public.erp_purchase_orders WHERE user_id = p_user_id;
  DELETE FROM public.erp_sales_order_items
    WHERE sales_order_id IN (SELECT id FROM public.erp_sales_orders WHERE user_id = p_user_id);
  DELETE FROM public.erp_sales_orders WHERE user_id = p_user_id;
  DELETE FROM public.erp_audit_log WHERE user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_delete_all_transactions(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_delete_all_transactions(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.erp_delete_all_data(p_user_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL OR p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Unauthorized';
  END IF;

  -- Clear dependent and derived rows first. Trigger-created audit entries are
  -- removed last so the reset is all-or-nothing and leaves no stale history.
  DELETE FROM public.erp_approval_requests WHERE owner_id = p_user_id;
  DELETE FROM public.workflow_runs WHERE user_id = p_user_id;
  DELETE FROM public.workflows WHERE user_id = p_user_id;
  DELETE FROM public.erp_stock_movements WHERE user_id = p_user_id;
  DELETE FROM public.erp_transactions WHERE user_id = p_user_id;
  DELETE FROM public.erp_payments WHERE user_id = p_user_id;
  DELETE FROM public.erp_invoices WHERE user_id = p_user_id;
  DELETE FROM public.erp_purchase_order_items
    WHERE purchase_order_id IN (SELECT id FROM public.erp_purchase_orders WHERE user_id = p_user_id);
  DELETE FROM public.erp_purchase_orders WHERE user_id = p_user_id;
  DELETE FROM public.erp_sales_order_items
    WHERE sales_order_id IN (SELECT id FROM public.erp_sales_orders WHERE user_id = p_user_id);
  DELETE FROM public.erp_sales_orders WHERE user_id = p_user_id;
  DELETE FROM public.erp_products WHERE user_id = p_user_id;
  DELETE FROM public.erp_suppliers WHERE user_id = p_user_id;
  DELETE FROM public.erp_customers WHERE user_id = p_user_id;
  DELETE FROM public.erp_settings WHERE user_id = p_user_id;
  DELETE FROM public.erp_approval_settings WHERE owner_id = p_user_id;
  DELETE FROM public.erp_audit_log WHERE user_id = p_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_delete_all_data(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_delete_all_data(UUID) TO authenticated;
