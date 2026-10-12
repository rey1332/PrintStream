-- Production module: production runs into stockpiles, with a daily report.
--
-- A crusher (or any plant) turns material into products: a production run
-- records, for one day and shift, what came out (products and quantities,
-- each into a stockpile — a warehouse), optionally what went in (a raw
-- material taken from stock), the operating hours and the downtime. Runs are
-- numbered PRD/2026/0001.
--
-- Stock: outputs are added to their stockpile, the input is taken from its
-- stockpile (or the default warehouse first, as for any issue).
--
-- Books (standard cost): every product is valued at its cost (average cost,
-- else its purchase/cost price), as when it is sold. A run posts the outputs
-- at cost less the input at cost to Inventory, against Inventory
-- adjustments (6100), so the inventory account matches stock × cost and the production
-- costs paid (wages, fuel, parts) stay in expenses. For a quarry, set each
-- product's cost price to its production cost per unit.
--
-- A run is reversed (Owner or Admin, with a reason) rather than deleted:
-- stock and books go back. Recording needs the inventory right (Owner,
-- Admin, Inventory) and the production module (20261012000023).
--
-- Rollback: db/rollback/rollback_20261012000025_erp_production.sql

CREATE TABLE IF NOT EXISTS public.erp_production_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  doc_no TEXT,
  run_date DATE NOT NULL DEFAULT CURRENT_DATE,
  shift TEXT NOT NULL DEFAULT '' CHECK (char_length(shift) <= 40),
  plant TEXT NOT NULL DEFAULT '' CHECK (char_length(plant) <= 120),
  hours NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (hours BETWEEN 0 AND 24),
  downtime_hours NUMERIC(5, 2) NOT NULL DEFAULT 0 CHECK (downtime_hours BETWEEN 0 AND 24),
  input_product_id UUID REFERENCES public.erp_products(id) ON DELETE SET NULL,
  input_product_name TEXT NOT NULL DEFAULT '',
  input_qty NUMERIC(14, 3) CHECK (input_qty IS NULL OR input_qty > 0),
  input_unit TEXT,
  input_warehouse_id UUID REFERENCES public.erp_warehouses(id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'reversed')),
  reverse_reason TEXT NOT NULL DEFAULT '' CHECK (char_length(reverse_reason) <= 500),
  reversed_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  reversed_at TIMESTAMPTZ,
  created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_erp_production_runs_ws_date ON public.erp_production_runs (workspace_id, run_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_production_runs_doc_no
  ON public.erp_production_runs (workspace_id, doc_no) WHERE doc_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.erp_production_outputs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES public.erp_production_runs(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.erp_products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  qty NUMERIC(14, 3) NOT NULL CHECK (qty > 0),
  unit TEXT NOT NULL,
  warehouse_id UUID REFERENCES public.erp_warehouses(id) ON DELETE SET NULL,
  unit_cost NUMERIC(15, 4) NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_erp_production_outputs_run ON public.erp_production_outputs (run_id);
CREATE INDEX IF NOT EXISTS idx_erp_production_outputs_product ON public.erp_production_outputs (product_id);

DROP TRIGGER IF EXISTS trg_erp_assign_workspace ON public.erp_production_runs;
CREATE TRIGGER trg_erp_assign_workspace BEFORE INSERT OR UPDATE ON public.erp_production_runs
  FOR EACH ROW EXECUTE FUNCTION public.erp_assign_workspace();
DROP TRIGGER IF EXISTS trg_audit_erp_production_runs ON public.erp_production_runs;
CREATE TRIGGER trg_audit_erp_production_runs AFTER INSERT OR UPDATE OR DELETE ON public.erp_production_runs
  FOR EACH ROW EXECUTE FUNCTION public.erp_audit_trigger_fn();

ALTER TABLE public.erp_doc_sequences DROP CONSTRAINT IF EXISTS erp_doc_sequences_doc_type_check;
ALTER TABLE public.erp_doc_sequences ADD CONSTRAINT erp_doc_sequences_doc_type_check
  CHECK (doc_type IN ('INV', 'SO', 'PO', 'RCV', 'PAY', 'SJ', 'GR', 'WB', 'PRD'));
DROP TRIGGER IF EXISTS trg_erp_doc_no ON public.erp_production_runs;
CREATE TRIGGER trg_erp_doc_no BEFORE INSERT OR UPDATE OF doc_no ON public.erp_production_runs
  FOR EACH ROW EXECUTE FUNCTION public.erp_doc__assign('PRD', 'run_date');

ALTER TABLE public.erp_journal_entries DROP CONSTRAINT IF EXISTS erp_journal_entries_source_type_check;
ALTER TABLE public.erp_journal_entries ADD CONSTRAINT erp_journal_entries_source_type_check CHECK (source_type IN (
  'invoice', 'invoice_void', 'invoice_adjust', 'payment', 'payment_void', 'payment_adjust', 'transaction',
  'purchase_receipt', 'sales_delivery', 'stock_adjustment', 'opening_stock', 'manual', 'manual_reversal',
  'fx_settlement', 'payroll', 'payroll_reversal', 'weigh_ticket', 'weigh_ticket_cancel',
  'production', 'production_reversal'));

-- Read like stock; written only through the functions below.
ALTER TABLE public.erp_production_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_production_outputs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_production_runs, public.erp_production_outputs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.erp_production_runs, public.erp_production_outputs TO authenticated;
DROP POLICY IF EXISTS erp_production_runs_member_read ON public.erp_production_runs;
CREATE POLICY erp_production_runs_member_read ON public.erp_production_runs FOR SELECT TO authenticated
  USING (workspace_id IS NOT NULL AND public.erp_can_read(workspace_id, 'stock'));
DROP POLICY IF EXISTS erp_production_outputs_read ON public.erp_production_outputs;
CREATE POLICY erp_production_outputs_read ON public.erp_production_outputs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.erp_production_runs r WHERE r.id = erp_production_outputs.run_id));
DO $$
DECLARE target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['erp_production_runs', 'erp_production_outputs'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS erp_workspace_not_suspended ON public.%I', target);
    EXECUTE format('CREATE POLICY erp_workspace_not_suspended ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
                   'USING (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[])) '
                   'WITH CHECK (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]))',
                   target);
  END LOOP;
END;
$$;

-- ─── Helpers ─────────────────────────────────────────────────────────────────

-- Moves up to p_qty of a product between two warehouses of the owner (no
-- transfer record: the production run is the record). p_strict: fail when
-- the source holds less.
CREATE OR REPLACE FUNCTION public.erp_wh__move(p_owner UUID, p_product_id UUID, p_from UUID, p_to UUID, p_qty NUMERIC, p_strict BOOLEAN)
RETURNS NUMERIC
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  available NUMERIC;
  moved NUMERIC;
BEGIN
  IF p_from = p_to OR p_qty <= 0 THEN RETURN 0; END IF;
  PERFORM public.erp_wh__resync(p_product_id);
  SELECT quantity INTO available FROM public.erp_warehouse_stock
   WHERE warehouse_id = p_from AND product_id = p_product_id FOR UPDATE;
  moved := LEAST(COALESCE(available, 0), p_qty);
  IF p_strict AND moved < p_qty THEN
    RAISE EXCEPTION 'Only % of % is in that stockpile', trim_scale(COALESCE(available, 0)),
      (SELECT name FROM public.erp_products WHERE id = p_product_id);
  END IF;
  IF moved <= 0 THEN RETURN 0; END IF;
  UPDATE public.erp_warehouse_stock SET quantity = quantity - moved WHERE warehouse_id = p_from AND product_id = p_product_id;
  INSERT INTO public.erp_warehouse_stock (warehouse_id, product_id, quantity) VALUES (p_to, p_product_id, moved)
  ON CONFLICT (warehouse_id, product_id) DO UPDATE SET quantity = erp_warehouse_stock.quantity + moved;
  RETURN moved;
END;
$$;

-- ─── Record ──────────────────────────────────────────────────────────────────

-- p_run: {run_date?, shift?, plant?, hours?, downtime_hours?, note?,
--   input?: {product_id, qty, warehouse_id?},
--   outputs: [{product_id, qty, warehouse_id?}] (1 to 50)}
-- Quantities are in each product's own unit.
CREATE OR REPLACE FUNCTION public.erp_production_record(p_workspace_id UUID, p_run JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp__resolve_workspace(p_workspace_id, 'inventory');
  v_owner UUID;
  default_wh UUID;
  v_date DATE;
  v_hours NUMERIC;
  v_down NUMERIC;
  input JSONB := p_run -> 'input';
  in_product public.erp_products%ROWTYPE;
  in_qty NUMERIC;
  in_wh UUID;
  in_value NUMERIC := 0;
  out_value NUMERIC := 0;
  line JSONB;
  o_product public.erp_products%ROWTYPE;
  o_qty NUMERIC;
  o_wh UUID;
  o_cost NUMERIC;
  o_id UUID;
  seen UUID[] := ARRAY[]::UUID[];
  run_id UUID;
  run_no TEXT;
BEGIN
  PERFORM public.erp__require_module(ws, 'production');
  SELECT owner_id INTO v_owner FROM public.erp_workspaces WHERE id = ws;
  default_wh := public.erp_wh__default(v_owner);
  BEGIN
    v_date := COALESCE(NULLIF(p_run ->> 'run_date', '')::DATE, CURRENT_DATE);
    v_hours := round(COALESCE(NULLIF(p_run ->> 'hours', '')::NUMERIC, 0), 2);
    v_down := round(COALESCE(NULLIF(p_run ->> 'downtime_hours', '')::NUMERIC, 0), 2);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Invalid production run' USING ERRCODE = '22023';
  END;
  IF v_date > CURRENT_DATE THEN
    RAISE EXCEPTION 'A production run cannot be in the future' USING ERRCODE = '22023', HINT = 'future';
  END IF;
  IF v_hours NOT BETWEEN 0 AND 24 OR v_down NOT BETWEEN 0 AND 24 OR v_hours + v_down > 24 THEN
    RAISE EXCEPTION 'Hours and downtime must be between 0 and 24 together' USING ERRCODE = '22023', HINT = 'hours';
  END IF;
  IF jsonb_typeof(p_run -> 'outputs') IS DISTINCT FROM 'array' OR jsonb_array_length(p_run -> 'outputs') NOT BETWEEN 1 AND 50 THEN
    RAISE EXCEPTION 'Enter at least one product made' USING ERRCODE = '22023', HINT = 'outputs';
  END IF;

  INSERT INTO public.erp_production_runs (user_id, workspace_id, run_date, shift, plant, hours, downtime_hours, note, created_by)
  VALUES (v_owner, ws, v_date, left(btrim(COALESCE(p_run ->> 'shift', '')), 40), left(btrim(COALESCE(p_run ->> 'plant', '')), 120),
          v_hours, v_down, left(btrim(COALESCE(p_run ->> 'note', '')), 500), auth.uid())
  RETURNING id, doc_no INTO run_id, run_no;

  -- Input: taken from its stockpile (or the default warehouse first).
  IF input IS NOT NULL AND jsonb_typeof(input) = 'object' AND NULLIF(input ->> 'product_id', '') IS NOT NULL THEN
    BEGIN
      in_qty := round((input ->> 'qty')::NUMERIC, 3);
      in_wh := NULLIF(input ->> 'warehouse_id', '')::UUID;
      SELECT * INTO in_product FROM public.erp_products
       WHERE id = (input ->> 'product_id')::UUID AND workspace_id = ws FOR UPDATE;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Invalid production run' USING ERRCODE = '22023';
    END;
    IF in_product.id IS NULL THEN RAISE EXCEPTION 'Product not found for this account'; END IF;
    IF in_qty IS NULL OR in_qty <= 0 THEN
      RAISE EXCEPTION 'Quantities must be greater than zero' USING ERRCODE = '22023', HINT = 'qty';
    END IF;
    IF in_product.current_stock < in_qty THEN
      RAISE EXCEPTION 'Insufficient stock for % (available %, required %)', in_product.name,
        trim_scale(in_product.current_stock), trim_scale(in_qty);
    END IF;
    IF in_wh IS NOT NULL THEN
      IF NOT EXISTS (SELECT 1 FROM public.erp_warehouses WHERE id = in_wh AND user_id = v_owner AND is_active) THEN
        RAISE EXCEPTION 'Warehouse not found';
      END IF;
      PERFORM public.erp_wh__move(v_owner, in_product.id, in_wh, default_wh, in_qty, true);
    END IF;
    in_value := round(in_qty * COALESCE(public.erp__unit_cost(in_product.id), 0), 2);
    PERFORM public.erp__change_stock(in_product.id, -in_qty);
    INSERT INTO public.erp_stock_movements
      (user_id, product_id, product_name, movement_type, quantity, movement_date, note, source_type, source_id, created_by)
    VALUES (v_owner, in_product.id, in_product.name, 'out', in_qty, v_date, 'Production input ' || run_no, 'production_input', run_id, auth.uid());
    UPDATE public.erp_production_runs
       SET input_product_id = in_product.id, input_product_name = in_product.name, input_qty = in_qty,
           input_unit = in_product.unit, input_warehouse_id = in_wh
     WHERE id = run_id;
  END IF;

  -- Outputs: into their stockpile.
  FOR line IN SELECT value FROM jsonb_array_elements(p_run -> 'outputs') LOOP
    o_product := NULL;
    BEGIN
      o_qty := round((line ->> 'qty')::NUMERIC, 3);
      o_wh := NULLIF(line ->> 'warehouse_id', '')::UUID;
      SELECT * INTO o_product FROM public.erp_products
       WHERE id = (line ->> 'product_id')::UUID AND workspace_id = ws FOR UPDATE;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Invalid production run' USING ERRCODE = '22023';
    END;
    IF o_product.id IS NULL THEN RAISE EXCEPTION 'Product not found for this account'; END IF;
    IF o_qty IS NULL OR o_qty <= 0 THEN
      RAISE EXCEPTION 'Quantities must be greater than zero' USING ERRCODE = '22023', HINT = 'qty';
    END IF;
    IF o_product.id = in_product.id THEN
      RAISE EXCEPTION 'A product cannot be both made and used in the same run' USING ERRCODE = '22023', HINT = 'same_product';
    END IF;
    IF o_product.id = ANY (seen) THEN
      RAISE EXCEPTION 'Each product may appear only once' USING ERRCODE = '22023', HINT = 'duplicate';
    END IF;
    seen := seen || o_product.id;
    IF o_wh IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.erp_warehouses WHERE id = o_wh AND user_id = v_owner AND is_active) THEN
      RAISE EXCEPTION 'Warehouse not found';
    END IF;
    o_cost := COALESCE(public.erp__unit_cost(o_product.id), 0);
    out_value := out_value + round(o_qty * o_cost, 2);
    PERFORM public.erp__change_stock(o_product.id, o_qty);
    IF o_wh IS NOT NULL THEN
      PERFORM public.erp_wh__move(v_owner, o_product.id, default_wh, o_wh, o_qty, false);
    END IF;
    INSERT INTO public.erp_production_outputs (run_id, workspace_id, product_id, product_name, qty, unit, warehouse_id, unit_cost)
    VALUES (run_id, ws, o_product.id, o_product.name, o_qty, o_product.unit, o_wh, o_cost)
    RETURNING id INTO o_id;
    -- One movement per output line (movements are unique per source).
    INSERT INTO public.erp_stock_movements
      (user_id, product_id, product_name, movement_type, quantity, movement_date, note, source_type, source_id, created_by)
    VALUES (v_owner, o_product.id, o_product.name, 'in', o_qty, v_date, 'Production ' || run_no, 'production', o_id, auth.uid());
  END LOOP;

  -- Books: outputs in at cost, input out at cost; the difference is absorbed
  -- by Inventory adjustments (production costs stay in expenses).
  IF out_value <> in_value THEN
    PERFORM public.erp_gl__post(v_owner, v_date, 'Production ' || run_no, 'production', run_id, 'production:' || run_id,
                                public.erp_gl__pair('inventory', 'inventory_adjust', out_value - in_value));
  END IF;
  RETURN run_id;
END;
$$;

-- ─── Reverse ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.erp_production_reverse(p_run_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  r public.erp_production_runs%ROWTYPE;
  o RECORD;
  default_wh UUID;
  v_reason TEXT := btrim(COALESCE(p_reason, ''));
  stock_now NUMERIC;
BEGIN
  SELECT * INTO r FROM public.erp_production_runs WHERE id = p_run_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Production run not found'; END IF;
  PERFORM public.erp__resolve_workspace(r.workspace_id, 'inventory');
  PERFORM public.erp__require_module(r.workspace_id, 'production');
  IF public.erp_workspace_role(r.workspace_id) NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only the Owner or an Admin can reverse a production run' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_reason) < 3 THEN
    RAISE EXCEPTION 'Give a reason (at least 3 characters)' USING ERRCODE = '22023', HINT = 'reason';
  END IF;
  IF r.status = 'reversed' THEN RETURN; END IF;
  default_wh := public.erp_wh__default(r.user_id);

  FOR o IN SELECT * FROM public.erp_production_outputs WHERE run_id = r.id AND product_id IS NOT NULL ORDER BY product_id LOOP
    SELECT current_stock INTO stock_now FROM public.erp_products WHERE id = o.product_id FOR UPDATE;
    IF stock_now < o.qty THEN
      RAISE EXCEPTION 'Insufficient stock for % (available %, required %)', o.product_name, trim_scale(stock_now), trim_scale(o.qty);
    END IF;
    IF o.warehouse_id IS NOT NULL THEN
      PERFORM public.erp_wh__move(r.user_id, o.product_id, o.warehouse_id, default_wh, o.qty, false);
    END IF;
    PERFORM public.erp__change_stock(o.product_id, -o.qty);
    INSERT INTO public.erp_stock_movements
      (user_id, product_id, product_name, movement_type, quantity, movement_date, note, source_type, source_id, created_by)
    VALUES (r.user_id, o.product_id, o.product_name, 'out', o.qty, CURRENT_DATE, 'Reversed production ' || r.doc_no,
            'production_reversal', o.id, auth.uid());
  END LOOP;
  IF r.input_product_id IS NOT NULL THEN
    PERFORM 1 FROM public.erp_products WHERE id = r.input_product_id FOR UPDATE;
    PERFORM public.erp__change_stock(r.input_product_id, r.input_qty);
    IF r.input_warehouse_id IS NOT NULL THEN
      PERFORM public.erp_wh__move(r.user_id, r.input_product_id, default_wh, r.input_warehouse_id, r.input_qty, false);
    END IF;
    INSERT INTO public.erp_stock_movements
      (user_id, product_id, product_name, movement_type, quantity, movement_date, note, source_type, source_id, created_by)
    VALUES (r.user_id, r.input_product_id, r.input_product_name, 'in', r.input_qty, CURRENT_DATE,
            'Reversed production input ' || r.doc_no, 'production_input_reversal', r.id, auth.uid());
  END IF;
  PERFORM public.erp_gl__reverse(r.user_id, 'production:' || r.id, CURRENT_DATE, 'Reversed production ' || r.doc_no,
                                 'production_reversal', r.id, 'production_reversal:' || r.id);
  UPDATE public.erp_production_runs
     SET status = 'reversed', reverse_reason = left(v_reason, 500), reversed_by = auth.uid(), reversed_at = now(), updated_at = now()
   WHERE id = r.id;
END;
$$;

-- ─── Report ──────────────────────────────────────────────────────────────────
-- Posted runs in a period: totals per product made and used, hours, and per
-- day (row-level security decides what the caller sees).
CREATE OR REPLACE FUNCTION public.erp_production_summary(p_workspace_id UUID, p_from DATE, p_to DATE)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH runs AS (
    SELECT * FROM public.erp_production_runs r
     WHERE r.workspace_id = p_workspace_id AND r.status = 'posted' AND r.run_date BETWEEN p_from AND p_to
  ), outs AS (
    SELECT o.*, r.run_date FROM public.erp_production_outputs o JOIN runs r ON r.id = o.run_id
  )
  SELECT jsonb_build_object(
    'runs', (SELECT count(*) FROM runs),
    'hours', (SELECT COALESCE(sum(hours), 0) FROM runs),
    'downtime_hours', (SELECT COALESCE(sum(downtime_hours), 0) FROM runs),
    'outputs', COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id', product_id, 'product_name', product_name,
                                                             'unit', unit, 'qty', qty) ORDER BY product_name)
                           FROM (SELECT product_id, product_name, unit, sum(qty) AS qty FROM outs
                                  GROUP BY product_id, product_name, unit) x), '[]'::jsonb),
    'inputs', COALESCE((SELECT jsonb_agg(jsonb_build_object('product_id', input_product_id, 'product_name', input_product_name,
                                                            'unit', input_unit, 'qty', qty) ORDER BY input_product_name)
                          FROM (SELECT input_product_id, input_product_name, input_unit, sum(input_qty) AS qty FROM runs
                                 WHERE input_qty IS NOT NULL GROUP BY input_product_id, input_product_name, input_unit) x), '[]'::jsonb),
    'days', COALESCE((SELECT jsonb_agg(jsonb_build_object('date', run_date, 'runs', n, 'hours', h, 'downtime_hours', d,
                                                          'outputs', outs_json) ORDER BY run_date)
                        FROM (SELECT r.run_date, count(*) AS n, sum(r.hours) AS h, sum(r.downtime_hours) AS d,
                                     (SELECT COALESCE(jsonb_agg(jsonb_build_object('product_name', product_name, 'unit', unit, 'qty', q)
                                                                ORDER BY product_name), '[]'::jsonb)
                                        FROM (SELECT product_name, unit, sum(qty) AS q FROM outs WHERE outs.run_date = r.run_date
                                               GROUP BY product_name, unit) y) AS outs_json
                                FROM runs r GROUP BY r.run_date) x), '[]'::jsonb));
$$;

-- ─── Reset: runs go with the documents ──────────────────────────────────────
-- As in 20261012000024, plus production runs.
CREATE OR REPLACE FUNCTION public.erp__reset_modules(p_workspace_id UUID, p_scope TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.erp_weigh_tickets x WHERE x.workspace_id = p_workspace_id;
  DELETE FROM public.erp_production_runs x WHERE x.workspace_id = p_workspace_id;
  IF p_scope = 'all' THEN
    DELETE FROM public.erp_vehicles x WHERE x.workspace_id = p_workspace_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_wh__move(UUID, UUID, UUID, UUID, NUMERIC, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_production_record(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_production_reverse(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_production_summary(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_production_record(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_production_reverse(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_production_summary(UUID, DATE, DATE) TO authenticated;
