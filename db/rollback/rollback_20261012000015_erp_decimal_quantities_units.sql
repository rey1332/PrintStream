-- Rollback for 20261012000015_erp_decimal_quantities_units.sql.
-- Run only after redeploying an app version from before this change.
--
-- Quantities become whole numbers again: every fractional quantity is ROUNDED
-- (stock, order lines, receipts, deliveries, movements). Export them first if
-- they matter. Units and densities are dropped.

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
      RAISE EXCEPTION 'erp_patch: % does not contain: %', p_fn, p_pairs[i];
    END IF;
    body := replace(body, p_pairs[i], p_pairs[i + 1]);
  END LOOP;
  RETURN body;
END;
$$;

DO $$
BEGIN
  EXECUTE pg_temp.erp_patch('public.erp__apply_purchase_receipt(public.erp_purchase_orders, jsonb, uuid, text, text)'::regprocedure,
    ARRAY['l(item_id UUID, qty NUMERIC)', 'l(item_id UUID, qty INTEGER)']);
  EXECUTE pg_temp.erp_patch('public.erp__apply_sales_delivery(public.erp_sales_orders, jsonb, uuid, text, text)'::regprocedure,
    ARRAY['l(item_id UUID, qty NUMERIC)', 'l(item_id UUID, qty INTEGER)',
          'stock_now NUMERIC;', 'stock_now INTEGER;',
          'line.product_name, trim_scale(stock_now), trim_scale(line.qty);', 'line.product_name, stock_now, line.qty;']);
  EXECUTE pg_temp.erp_patch('public.erp__reserve_sales_order(uuid)'::regprocedure,
    ARRAY['reserved_elsewhere NUMERIC;', 'reserved_elsewhere INTEGER;',
          'available NUMERIC;', 'available INTEGER;',
          'i.qty_delivered, 0)) AS qty', 'i.qty_delivered, 0))::INTEGER AS qty',
          'need.name, trim_scale(GREATEST(available, 0)), trim_scale(need.qty);', 'need.name, GREATEST(available, 0), need.qty;']);
  EXECUTE pg_temp.erp_patch('public.erp__validate_fulfillment_lines(text, uuid, jsonb)'::regprocedure,
    ARRAY['line_qty NUMERIC;', 'line_qty INTEGER;',
          'remaining NUMERIC;', 'remaining INTEGER;',
          'round((line->>''qty'')::NUMERIC, 3)', '(line->>''qty'')::INTEGER',
          'item_name, trim_scale(GREATEST(remaining, 0));', 'item_name, GREATEST(remaining, 0);']);
  EXECUTE pg_temp.erp_patch('public.erp_products_stock_ledger()'::regprocedure,
    ARRAY['DECLARE delta NUMERIC;', 'DECLARE delta INTEGER;']);
  EXECUTE pg_temp.erp_patch('public.erp_reverse_fulfillment_event(uuid, text, uuid)'::regprocedure,
    ARRAY['stock_now NUMERIC;', 'stock_now INTEGER;',
          'line.product_name, trim_scale(stock_now);', 'line.product_name, stock_now;']);
  EXECUTE pg_temp.erp_patch('public.erp_wh__resync(uuid)'::regprocedure,
    ARRAY['placed NUMERIC;', 'placed INTEGER;']);
  EXECUTE pg_temp.erp_patch('public.erp_gl__post_fulfillment(uuid)'::regprocedure,
    ARRAY['stock_value := round(stock_value, 2); other_value := round(other_value, 2); ', '',
          'round(stock_value, 2)),', 'stock_value),',
          'round(stock_value, 2)));', 'stock_value));']);
  EXECUTE pg_temp.erp_patch('public.erp__insert_order_items(text, uuid, uuid, jsonb)'::regprocedure,
    ARRAY['item_qty NUMERIC;', 'item_qty INTEGER;',
          'item_unit TEXT;', '',
          'round((item->>''qty'')::NUMERIC, 3)', '(item->>''qty'')::INTEGER',
          'SELECT name, unit INTO canonical_product_name, item_unit FROM public.erp_products', 'SELECT name INTO canonical_product_name FROM public.erp_products',
          'item_unit := CASE WHEN public.erp_unit_valid(item->>''unit'') THEN item->>''unit'' ELSE ''pcs'' END;', '',
          'order_total := order_total + round(item_qty * item_price, 2);', 'order_total := order_total + item_qty * item_price;',
          ', qty, price, unit)', ', qty, price)',
          'item_qty, item_price, item_unit);', 'item_qty, item_price);']);

  EXECUTE pg_temp.erp_patch('public.erp__change_stock(uuid, numeric)'::regprocedure,
    ARRAY['p_delta numeric)', 'p_delta integer)',
          ' RETURNS numeric', ' RETURNS integer',
          'DECLARE next_stock NUMERIC;', 'DECLARE next_stock INTEGER;']);
  EXECUTE pg_temp.erp_patch('public.erp_wh__apply(uuid, uuid, numeric)'::regprocedure,
    ARRAY['p_delta numeric)', 'p_delta integer)',
          'remaining NUMERIC :=', 'remaining INTEGER :=',
          'take NUMERIC;', 'take INTEGER;']);
  EXECUTE pg_temp.erp_patch('public.erp_sync__set_stock(public.erp_products, numeric, text, timestamp with time zone)'::regprocedure,
    ARRAY['p_level numeric,', 'p_level integer,',
          'DECLARE delta NUMERIC :=', 'DECLARE delta INTEGER :=']);
  EXECUTE pg_temp.erp_patch('public.erp_transfer_stock(uuid, uuid, uuid, numeric, text)'::regprocedure,
    ARRAY['p_quantity numeric,', 'p_quantity integer,',
          'available NUMERIC;', 'available INTEGER;',
          'trim_scale(COALESCE(available, 0)), p.name;', 'COALESCE(available, 0), p.name;',
          'p_quantity := round(p_quantity, 3);', '']);
  EXECUTE pg_temp.erp_patch('public.erp_adjust_stock(uuid, public.stock_movement_type, numeric, text)'::regprocedure,
    ARRAY['p_quantity numeric,', 'p_quantity integer,',
          'p_quantity := round(p_quantity, 3);', '']);
END;
$$;

DROP FUNCTION public.erp__change_stock(UUID, NUMERIC);
DROP FUNCTION public.erp_wh__apply(UUID, UUID, NUMERIC);
DROP FUNCTION public.erp_sync__set_stock(public.erp_products, NUMERIC, TEXT, TIMESTAMPTZ);
DROP FUNCTION public.erp_transfer_stock(UUID, UUID, UUID, NUMERIC, TEXT);
DROP FUNCTION public.erp_adjust_stock(UUID, public.stock_movement_type, NUMERIC, TEXT);
REVOKE ALL ON FUNCTION public.erp_transfer_stock(UUID, UUID, UUID, INTEGER, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_adjust_stock(UUID, public.stock_movement_type, INTEGER, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp__change_stock(UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_wh__apply(UUID, UUID, INTEGER) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_sync__set_stock(public.erp_products, INTEGER, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.erp_transfer_stock(UUID, UUID, UUID, INTEGER, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_adjust_stock(UUID, public.stock_movement_type, INTEGER, TEXT) TO authenticated;

CREATE OR REPLACE FUNCTION public.erp_sync__fields(p_entity TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_entity
    WHEN 'customers' THEN ARRAY['name', 'email', 'phone', 'address', 'city']
    WHEN 'suppliers' THEN ARRAY['name', 'email', 'phone', 'address', 'city']
    WHEN 'products' THEN ARRAY['name', 'sku', 'category', 'purchase_price', 'selling_price', 'min_stock', 'max_stock']
  END;
$$;

DROP VIEW IF EXISTS public.erp_inventory_stock;
DROP VIEW IF EXISTS public.erp_product_availability;
DROP TRIGGER trg_erp_products_stock_guard ON public.erp_products;
DROP TRIGGER trg_erp_products_stock_ledger ON public.erp_products;
DROP TRIGGER trg_erp_wh_product_stock ON public.erp_products;
ALTER TABLE public.erp_sales_order_items DROP COLUMN subtotal;
ALTER TABLE public.erp_purchase_order_items DROP COLUMN subtotal;

ALTER TABLE public.erp_products
  ALTER COLUMN current_stock TYPE INTEGER USING round(current_stock)::INTEGER,
  ALTER COLUMN min_stock TYPE INTEGER USING round(min_stock)::INTEGER,
  ALTER COLUMN max_stock TYPE INTEGER USING round(max_stock)::INTEGER;
ALTER TABLE public.erp_sales_order_items
  ALTER COLUMN qty TYPE INTEGER USING GREATEST(round(qty), 1)::INTEGER,
  ALTER COLUMN qty_delivered TYPE INTEGER USING LEAST(round(qty_delivered), GREATEST(round(qty), 1))::INTEGER;
ALTER TABLE public.erp_purchase_order_items
  ALTER COLUMN qty TYPE INTEGER USING GREATEST(round(qty), 1)::INTEGER,
  ALTER COLUMN qty_received TYPE INTEGER USING LEAST(round(qty_received), GREATEST(round(qty), 1))::INTEGER;
ALTER TABLE public.erp_stock_movements ALTER COLUMN quantity TYPE INTEGER USING round(quantity)::INTEGER;
ALTER TABLE public.erp_stock_reservations
  ALTER COLUMN qty_reserved TYPE INTEGER USING GREATEST(round(qty_reserved), 1)::INTEGER,
  ALTER COLUMN qty_open TYPE INTEGER USING LEAST(round(qty_open), GREATEST(round(qty_reserved), 1))::INTEGER;
ALTER TABLE public.erp_fulfillment_event_lines ALTER COLUMN quantity TYPE INTEGER USING GREATEST(round(quantity), 1)::INTEGER;
ALTER TABLE public.erp_warehouse_stock ALTER COLUMN quantity TYPE INTEGER USING round(quantity)::INTEGER;
ALTER TABLE public.erp_stock_transfers ALTER COLUMN quantity TYPE INTEGER USING GREATEST(round(quantity), 1)::INTEGER;

CREATE TRIGGER trg_erp_products_stock_guard BEFORE INSERT OR UPDATE OF current_stock ON public.erp_products
  FOR EACH ROW EXECUTE FUNCTION public.erp_products_stock_guard();
CREATE TRIGGER trg_erp_products_stock_ledger AFTER INSERT OR UPDATE OF current_stock ON public.erp_products
  FOR EACH ROW EXECUTE FUNCTION public.erp_products_stock_ledger();
CREATE TRIGGER trg_erp_wh_product_stock AFTER INSERT OR UPDATE OF current_stock ON public.erp_products
  FOR EACH ROW EXECUTE FUNCTION public.erp_wh__on_product_stock();

ALTER TABLE public.erp_sales_order_items ADD COLUMN subtotal NUMERIC GENERATED ALWAYS AS ((qty)::numeric * price) STORED;
ALTER TABLE public.erp_purchase_order_items ADD COLUMN subtotal NUMERIC GENERATED ALWAYS AS ((qty)::numeric * price) STORED;

ALTER TABLE public.erp_sales_order_items DROP COLUMN unit;
ALTER TABLE public.erp_purchase_order_items DROP COLUMN unit;
ALTER TABLE public.erp_products DROP COLUMN unit, DROP COLUMN density;

CREATE VIEW public.erp_product_availability WITH (security_invoker = true) AS
SELECT p.id AS product_id, p.user_id, p.workspace_id, p.current_stock AS on_hand,
       COALESCE(r.reserved, 0)::INTEGER AS reserved,
       (p.current_stock - COALESCE(r.reserved, 0))::INTEGER AS available
  FROM public.erp_products p
  LEFT JOIN (SELECT s.product_id, sum(s.qty_open) AS reserved FROM public.erp_stock_reservations s
              WHERE s.status = 'active' GROUP BY s.product_id) r ON r.product_id = p.id;

CREATE VIEW public.erp_inventory_stock WITH (security_invoker = true) AS
SELECT p.id, p.user_id, p.workspace_id, p.name, p.sku, p.category, p.created_at,
       p.current_stock, p.min_stock, p.max_stock,
       COALESCE(NULLIF(p.avg_cost, 0), NULLIF(p.purchase_price, 0), 0)::NUMERIC(15, 4) AS unit_cost,
       COALESCE(r.reserved, 0)::INTEGER AS reserved,
       (p.current_stock - COALESCE(r.reserved, 0))::INTEGER AS available,
       round(p.current_stock::NUMERIC * COALESCE(NULLIF(p.avg_cost, 0), NULLIF(p.purchase_price, 0), 0), 2) AS stock_value,
       (p.current_stock - COALESCE(r.reserved, 0)) <= p.min_stock AS needs_reorder,
       GREATEST(0, p.max_stock - p.current_stock + COALESCE(r.reserved, 0))::INTEGER AS suggested_qty
  FROM public.erp_products p
  LEFT JOIN (SELECT s.product_id, sum(s.qty_open) AS reserved FROM public.erp_stock_reservations s
              WHERE s.status = 'active' GROUP BY s.product_id) r ON r.product_id = p.id;

REVOKE ALL ON public.erp_product_availability, public.erp_inventory_stock FROM PUBLIC, anon;
GRANT SELECT ON public.erp_product_availability, public.erp_inventory_stock TO authenticated;

DROP FUNCTION public.erp_unit_convert(NUMERIC, TEXT, TEXT, NUMERIC);
DROP FUNCTION public.erp_unit_valid(TEXT);

COMMIT;
