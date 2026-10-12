-- Invoice lines.
--
-- A manual invoice was one amount and a tax rate; e-Faktur (and any customer)
-- needs what was sold: product, quantity, unit, price. erp_invoice_lines holds
-- the lines of every invoice:
--   * manual invoices are created with lines (erp_create_invoice_v6); the
--     subtotal is their sum, rounded per line to cents;
--   * invoices issued from a sales order get the order's lines copied when
--     they are created (and existing ones are backfilled here).
-- Lines cannot be changed or deleted through the app: like the invoice, they
-- are a record of what was billed (a voided invoice keeps its lines).
--
-- Rollback: db/rollback/rollback_20261012000018_erp_invoice_lines.sql

CREATE TABLE IF NOT EXISTS public.erp_invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES public.erp_invoices(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  position SMALLINT NOT NULL CHECK (position BETWEEN 1 AND 500),
  product_id UUID REFERENCES public.erp_products(id) ON DELETE SET NULL,
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 200),
  qty NUMERIC(14, 3) NOT NULL CHECK (qty > 0),
  unit TEXT NOT NULL DEFAULT 'pcs' CHECK (unit IN ('m3', 'l', 'ton', 'kg', 'rit', 'pcs', 'hour', 'day')),
  price NUMERIC(15, 2) NOT NULL CHECK (price >= 0),
  subtotal NUMERIC GENERATED ALWAYS AS (round(qty * price, 2)) STORED,
  UNIQUE (invoice_id, position)
);
CREATE INDEX IF NOT EXISTS idx_erp_invoice_lines_workspace ON public.erp_invoice_lines (workspace_id);
CREATE INDEX IF NOT EXISTS idx_erp_invoice_lines_product ON public.erp_invoice_lines (product_id) WHERE product_id IS NOT NULL;

ALTER TABLE public.erp_invoice_lines ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_invoice_lines FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.erp_invoice_lines TO authenticated;

-- Whoever may read the invoice may read its lines (the invoice's own policies decide).
DROP POLICY IF EXISTS erp_invoice_lines_read ON public.erp_invoice_lines;
CREATE POLICY erp_invoice_lines_read ON public.erp_invoice_lines FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.erp_invoices i WHERE i.id = erp_invoice_lines.invoice_id));
-- As on every table with a workspace (20261012000012): nothing of a suspended workspace.
DROP POLICY IF EXISTS erp_workspace_not_suspended ON public.erp_invoice_lines;
CREATE POLICY erp_workspace_not_suspended ON public.erp_invoice_lines AS RESTRICTIVE FOR ALL TO authenticated
  USING (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]));

-- Lines of an invoice issued from a sales order: the order's lines.
CREATE OR REPLACE FUNCTION public.erp_invoice_lines_from_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.erp_invoice_lines (invoice_id, workspace_id, position, product_id, description, qty, unit, price)
  SELECT NEW.id, NEW.workspace_id, row_number() OVER (ORDER BY i.id)::SMALLINT, i.product_id,
         left(COALESCE(NULLIF(trim(i.product_name), ''), '-'), 200), i.qty, i.unit, i.price
    FROM public.erp_sales_order_items i
   WHERE i.sales_order_id = NEW.sales_order_id AND i.qty > 0;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_erp_invoice_lines_from_order ON public.erp_invoices;
CREATE TRIGGER trg_erp_invoice_lines_from_order
  AFTER INSERT ON public.erp_invoices
  FOR EACH ROW WHEN (NEW.sales_order_id IS NOT NULL AND NEW.workspace_id IS NOT NULL)
  EXECUTE FUNCTION public.erp_invoice_lines_from_order();

-- Existing invoices issued from orders.
INSERT INTO public.erp_invoice_lines (invoice_id, workspace_id, position, product_id, description, qty, unit, price)
SELECT inv.id, inv.workspace_id, row_number() OVER (PARTITION BY inv.id ORDER BY i.id)::SMALLINT, i.product_id,
       left(COALESCE(NULLIF(trim(i.product_name), ''), '-'), 200), i.qty, i.unit, i.price
  FROM public.erp_invoices inv
  JOIN public.erp_sales_order_items i ON i.sales_order_id = inv.sales_order_id AND i.qty > 0
 WHERE inv.sales_order_id IS NOT NULL AND inv.workspace_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM public.erp_invoice_lines l WHERE l.invoice_id = inv.id);

-- A manual invoice with lines. p_lines: [{product_id?, description?, qty, unit?, price}]
-- (1 to 200). A line with a product takes its name (when no description is
-- given) and, when no valid unit is given, its unit.
CREATE OR REPLACE FUNCTION public.erp_create_invoice_v6(
  p_workspace_id UUID, p_customer_id UUID, p_customer_name TEXT, p_invoice_date DATE, p_due_date DATE,
  p_lines JSONB, p_tax_rate NUMERIC, p_currency TEXT, p_fx_rate NUMERIC)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  workspace UUID := public.erp__resolve_workspace(p_workspace_id, 'invoicing');
  line JSONB;
  parsed JSONB := '[]'::jsonb;
  subtotal NUMERIC := 0;
  v_qty NUMERIC;
  v_price NUMERIC;
  v_product UUID;
  v_desc TEXT;
  v_unit TEXT;
  product_name TEXT;
  product_unit TEXT;
  new_id UUID;
BEGIN
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' OR jsonb_array_length(p_lines) NOT BETWEEN 1 AND 200 THEN
    RAISE EXCEPTION 'An invoice needs between 1 and 200 lines' USING ERRCODE = '22023';
  END IF;
  FOR line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    BEGIN
      v_qty := round((line ->> 'qty')::NUMERIC, 3);
      v_price := round((line ->> 'price')::NUMERIC, 2);
      v_product := NULLIF(line ->> 'product_id', '')::UUID;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Invalid invoice line' USING ERRCODE = '22023';
    END;
    IF v_qty IS NULL OR v_qty <= 0 OR v_price IS NULL OR v_price < 0 THEN
      RAISE EXCEPTION 'Line quantity must be positive and price cannot be negative' USING ERRCODE = '22023';
    END IF;
    v_desc := left(trim(COALESCE(line ->> 'description', '')), 200);
    v_unit := line ->> 'unit';
    IF v_product IS NOT NULL THEN
      SELECT p.name, p.unit INTO product_name, product_unit
        FROM public.erp_products p WHERE p.id = v_product AND p.workspace_id = workspace;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Product not found for this account';
      END IF;
      IF v_desc = '' THEN v_desc := left(product_name, 200); END IF;
      IF NOT COALESCE(public.erp_unit_valid(v_unit), false) THEN v_unit := product_unit; END IF;
    ELSE
      IF v_desc = '' THEN
        RAISE EXCEPTION 'Each invoice line needs a description' USING ERRCODE = '22023';
      END IF;
      IF NOT COALESCE(public.erp_unit_valid(v_unit), false) THEN v_unit := 'pcs'; END IF;
    END IF;
    subtotal := subtotal + round(v_qty * v_price, 2);
    parsed := parsed || jsonb_build_array(jsonb_build_object(
      'product_id', v_product, 'description', v_desc, 'qty', v_qty, 'unit', v_unit, 'price', v_price));
  END LOOP;

  new_id := public.erp_create_invoice_v5(workspace, p_customer_id, p_customer_name, p_invoice_date, p_due_date,
                                         subtotal, p_tax_rate, p_currency, p_fx_rate);
  INSERT INTO public.erp_invoice_lines (invoice_id, workspace_id, position, product_id, description, qty, unit, price)
  SELECT new_id, workspace, x.ord::SMALLINT, NULLIF(x.v ->> 'product_id', '')::UUID, x.v ->> 'description',
         (x.v ->> 'qty')::NUMERIC, x.v ->> 'unit', (x.v ->> 'price')::NUMERIC
    FROM jsonb_array_elements(parsed) WITH ORDINALITY AS x(v, ord);
  RETURN new_id;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_invoice_lines_from_order() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_create_invoice_v6(UUID, UUID, TEXT, DATE, DATE, JSONB, NUMERIC, TEXT, NUMERIC) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_create_invoice_v6(UUID, UUID, TEXT, DATE, DATE, JSONB, NUMERIC, TEXT, NUMERIC) TO authenticated;
