-- Weighbridge module: trucks, weigh tickets, credit limits, invoicing from tickets.
--
-- A quarry sells by the truckload: a truck is weighed coming in (empty) and
-- going out (loaded); the difference is what was sold. Each weighing is a
-- weigh ticket (tiket timbang) with its own gap-free number WB/2026/0001,
-- printed as ticket and delivery note.
--
--   erp_weigh_in      first weighing: truck, driver, customer, product, weight
--   erp_weigh_out     second weighing: net weight → quantity in the product's
--                     unit (kg, ton, m³ or liter through the product's density,
--                     or 1 truckload), stock goes out, cost of goods is posted
--   erp_weigh_cancel  an open ticket by its operator; a completed one by the
--                     Owner or an Admin (stock and cost are reversed)
--   erp_weigh_tickets_invoice  one invoice for a customer's tickets in a
--                     period (lines per product and price); voiding that
--                     invoice frees the tickets again
--
-- Trucks (erp_vehicles) are registered by plate the first time they are
-- weighed and remember their last empty weight, so a known truck can be
-- weighed once (loaded) using its stored tare.
--
-- Customers get an optional credit limit. Open invoices plus tickets not yet
-- invoiced may not go above it; the Owner or an Admin can let a truck through
-- with a reason, which stays on the ticket.
--
-- Price: the last price this customer paid for the product, else the
-- product's selling price; only roles with sales rights may change it.
-- Weighing needs the fulfillment right (Owner, Admin, Inventory).
--
-- Every function checks that the weighbridge module is on (20261012000023).
--
-- Rollback: db/rollback/rollback_20261012000024_erp_weighbridge.sql

-- ─── Credit limit ────────────────────────────────────────────────────────────
ALTER TABLE public.erp_customers
  ADD COLUMN IF NOT EXISTS credit_limit NUMERIC(15, 2) CHECK (credit_limit IS NULL OR credit_limit >= 0);

-- ─── Tables ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.erp_vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  plate_no TEXT NOT NULL CHECK (char_length(btrim(plate_no)) BETWEEN 2 AND 20),
  plate_key TEXT GENERATED ALWAYS AS (upper(regexp_replace(plate_no, '[^A-Za-z0-9]', '', 'g'))) STORED,
  kind TEXT NOT NULL DEFAULT 'dump_truck' CHECK (kind IN ('dump_truck', 'trailer', 'pickup', 'other')),
  owner_name TEXT NOT NULL DEFAULT '' CHECK (char_length(owner_name) <= 120),
  customer_id UUID REFERENCES public.erp_customers(id) ON DELETE SET NULL,
  driver_name TEXT NOT NULL DEFAULT '' CHECK (char_length(driver_name) <= 120),
  tare_kg NUMERIC(10, 1) CHECK (tare_kg IS NULL OR tare_kg > 0),
  tare_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_vehicles_plate ON public.erp_vehicles (workspace_id, plate_key);

CREATE TABLE IF NOT EXISTS public.erp_weigh_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  doc_no TEXT,
  ticket_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'cancelled')),
  vehicle_id UUID REFERENCES public.erp_vehicles(id) ON DELETE SET NULL,
  plate_no TEXT NOT NULL CHECK (char_length(plate_no) BETWEEN 2 AND 20),
  driver_name TEXT NOT NULL DEFAULT '' CHECK (char_length(driver_name) <= 120),
  customer_id UUID REFERENCES public.erp_customers(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL CHECK (char_length(customer_name) BETWEEN 1 AND 200),
  product_id UUID REFERENCES public.erp_products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL,
  unit TEXT NOT NULL CHECK (unit IN ('kg', 'ton', 'm3', 'l', 'rit')),
  first_kg NUMERIC(10, 1) NOT NULL CHECK (first_kg > 0),
  first_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  second_kg NUMERIC(10, 1) CHECK (second_kg IS NULL OR second_kg > 0),
  second_at TIMESTAMPTZ,
  net_kg NUMERIC GENERATED ALWAYS AS (abs(second_kg - first_kg)) STORED,
  qty NUMERIC(14, 3) CHECK (qty IS NULL OR qty > 0),
  price NUMERIC(15, 2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  amount NUMERIC GENERATED ALWAYS AS (round(COALESCE(qty, 0) * price, 2)) STORED,
  invoice_id UUID REFERENCES public.erp_invoices(id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  credit_override TEXT NOT NULL DEFAULT '' CHECK (char_length(credit_override) <= 500),
  cancel_reason TEXT NOT NULL DEFAULT '' CHECK (char_length(cancel_reason) <= 500),
  created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  completed_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ,
  cancelled_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  cancelled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (status <> 'completed' OR (second_kg IS NOT NULL AND qty IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_erp_weigh_tickets_ws_date ON public.erp_weigh_tickets (workspace_id, ticket_date DESC);
CREATE INDEX IF NOT EXISTS idx_erp_weigh_tickets_customer_open
  ON public.erp_weigh_tickets (customer_id) WHERE status = 'completed' AND invoice_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_erp_weigh_tickets_invoice ON public.erp_weigh_tickets (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_weigh_tickets_doc_no
  ON public.erp_weigh_tickets (workspace_id, doc_no) WHERE doc_no IS NOT NULL;
-- One open ticket per truck.
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_weigh_tickets_open_vehicle
  ON public.erp_weigh_tickets (vehicle_id) WHERE status = 'open' AND vehicle_id IS NOT NULL;

-- Workspace from the owner, audit trail, document number (as other documents).
DO $$
DECLARE target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['erp_vehicles', 'erp_weigh_tickets'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_erp_assign_workspace ON public.%I', target);
    EXECUTE format('CREATE TRIGGER trg_erp_assign_workspace BEFORE INSERT OR UPDATE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION public.erp_assign_workspace()', target);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_%s ON public.%I', target, target);
    EXECUTE format('CREATE TRIGGER trg_audit_%s AFTER INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION public.erp_audit_trigger_fn()', target, target);
  END LOOP;
END;
$$;

ALTER TABLE public.erp_doc_sequences DROP CONSTRAINT IF EXISTS erp_doc_sequences_doc_type_check;
ALTER TABLE public.erp_doc_sequences ADD CONSTRAINT erp_doc_sequences_doc_type_check
  CHECK (doc_type IN ('INV', 'SO', 'PO', 'RCV', 'PAY', 'SJ', 'GR', 'WB'));
DROP TRIGGER IF EXISTS trg_erp_doc_no ON public.erp_weigh_tickets;
CREATE TRIGGER trg_erp_doc_no BEFORE INSERT OR UPDATE OF doc_no ON public.erp_weigh_tickets
  FOR EACH ROW EXECUTE FUNCTION public.erp_doc__assign('WB', 'ticket_date');

ALTER TABLE public.erp_journal_entries DROP CONSTRAINT IF EXISTS erp_journal_entries_source_type_check;
ALTER TABLE public.erp_journal_entries ADD CONSTRAINT erp_journal_entries_source_type_check CHECK (source_type IN (
  'invoice', 'invoice_void', 'invoice_adjust', 'payment', 'payment_void', 'payment_adjust', 'transaction',
  'purchase_receipt', 'sales_delivery', 'stock_adjustment', 'opening_stock', 'manual', 'manual_reversal',
  'fx_settlement', 'payroll', 'payroll_reversal', 'weigh_ticket', 'weigh_ticket_cancel'));

-- ─── Access: read like sales orders; writes only through the functions ──────
ALTER TABLE public.erp_vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_weigh_tickets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_vehicles, public.erp_weigh_tickets FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.erp_vehicles, public.erp_weigh_tickets TO authenticated;

DO $$
DECLARE target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['erp_vehicles', 'erp_weigh_tickets'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', target || '_member_read', target);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated '
                   'USING (workspace_id IS NOT NULL AND public.erp_can_read(workspace_id, %L))',
                   target || '_member_read', target, 'sales_orders');
    -- As on every table with a workspace (20261012000012): nothing of a suspended workspace.
    EXECUTE format('DROP POLICY IF EXISTS erp_workspace_not_suspended ON public.%I', target);
    EXECUTE format('CREATE POLICY erp_workspace_not_suspended ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
                   'USING (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[])) '
                   'WITH CHECK (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]))',
                   target);
  END LOOP;
END;
$$;

-- ─── Helpers ─────────────────────────────────────────────────────────────────

-- The ERP, after checking the caller's right and that the module is on.
CREATE OR REPLACE FUNCTION public.erp__weigh_ws(p_workspace_id UUID, p_permission TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE ws UUID;
BEGIN
  ws := public.erp__resolve_workspace(p_workspace_id, p_permission);
  PERFORM public.erp__require_module(ws, 'weighbridge');
  RETURN ws;
END;
$$;

-- What a customer owes or will owe: open invoices plus completed tickets not
-- yet invoiced, in the base currency.
CREATE OR REPLACE FUNCTION public.erp__customer_exposure(p_customer_id UUID)
RETURNS NUMERIC
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT sum(round(GREATEST(i.total - i.amount_paid, 0) * COALESCE(NULLIF(i.fx_rate, 0), 1), 2))
                     FROM public.erp_invoices i
                    WHERE i.customer_id = p_customer_id AND i.status <> 'void' AND i.voided_at IS NULL), 0)
       + COALESCE((SELECT sum(t.amount) FROM public.erp_weigh_tickets t
                    WHERE t.customer_id = p_customer_id AND t.status = 'completed' AND t.invoice_id IS NULL), 0);
$$;

-- Raises when p_extra would take the customer above the credit limit, unless
-- the Owner or an Admin gives a reason. Returns the reason used ('' if none).
CREATE OR REPLACE FUNCTION public.erp__weigh_credit_check(p_ws UUID, p_customer_id UUID, p_extra NUMERIC, p_override TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  c RECORD;
  exposure NUMERIC;
  reason TEXT := btrim(COALESCE(p_override, ''));
BEGIN
  IF p_customer_id IS NULL THEN RETURN ''; END IF;
  SELECT name, credit_limit INTO c FROM public.erp_customers WHERE id = p_customer_id;
  IF c.credit_limit IS NULL THEN RETURN ''; END IF;
  exposure := public.erp__customer_exposure(p_customer_id);
  -- At the first weighing the amount is not known yet: the limit must not be reached already.
  IF (p_extra IS NULL AND exposure < c.credit_limit) OR (p_extra IS NOT NULL AND exposure + p_extra <= c.credit_limit) THEN
    RETURN '';
  END IF;
  IF char_length(reason) >= 3 AND public.erp_workspace_role(p_ws) IN ('owner', 'admin') THEN
    RETURN left(reason, 500);
  END IF;
  RAISE EXCEPTION 'Credit limit of % reached for % (owed and not yet invoiced: %)',
    trim_scale(c.credit_limit), c.name, trim_scale(exposure + COALESCE(p_extra, 0))
    USING ERRCODE = 'P0001', HINT = 'credit_limit';
END;
$$;

-- The quantity in the product's unit for a net weight in kg, or NULL.
CREATE OR REPLACE FUNCTION public.erp__weigh_qty(p_net_kg NUMERIC, p_unit TEXT, p_density NUMERIC)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN p_unit = 'rit' THEN 1
              ELSE round(public.erp_unit_convert(p_net_kg, 'kg', p_unit, p_density), 3) END;
$$;

-- ─── Trucks ──────────────────────────────────────────────────────────────────

-- Creates or updates a truck. p_vehicle: {id?, plate_no, kind?, owner_name?,
-- customer_id?, driver_name?, tare_kg?, active?}.
CREATE OR REPLACE FUNCTION public.erp_vehicle_save(p_workspace_id UUID, p_vehicle JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp__weigh_ws(p_workspace_id, 'fulfillment');
  v_owner UUID := (SELECT owner_id FROM public.erp_workspaces WHERE id = ws);
  v_id UUID;
  v_customer UUID;
  v_tare NUMERIC;
BEGIN
  BEGIN
    v_id := NULLIF(p_vehicle ->> 'id', '')::UUID;
    v_customer := NULLIF(p_vehicle ->> 'customer_id', '')::UUID;
    v_tare := NULLIF(p_vehicle ->> 'tare_kg', '')::NUMERIC;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Invalid truck' USING ERRCODE = '22023';
  END;
  IF v_customer IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.erp_customers WHERE id = v_customer AND workspace_id = ws) THEN
    RAISE EXCEPTION 'Customer not found for this account';
  END IF;
  IF v_id IS NULL THEN
    INSERT INTO public.erp_vehicles (user_id, workspace_id, plate_no, kind, owner_name, customer_id, driver_name, tare_kg, tare_at, active, created_by)
    VALUES (v_owner, ws, btrim(COALESCE(p_vehicle ->> 'plate_no', '')), COALESCE(NULLIF(p_vehicle ->> 'kind', ''), 'dump_truck'),
            btrim(COALESCE(p_vehicle ->> 'owner_name', '')), v_customer, btrim(COALESCE(p_vehicle ->> 'driver_name', '')),
            v_tare, CASE WHEN v_tare IS NOT NULL THEN now() END, COALESCE((p_vehicle ->> 'active')::BOOLEAN, true), auth.uid())
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.erp_vehicles v
       SET plate_no = btrim(COALESCE(p_vehicle ->> 'plate_no', v.plate_no)),
           kind = COALESCE(NULLIF(p_vehicle ->> 'kind', ''), v.kind),
           owner_name = btrim(COALESCE(p_vehicle ->> 'owner_name', v.owner_name)),
           customer_id = v_customer,
           driver_name = btrim(COALESCE(p_vehicle ->> 'driver_name', v.driver_name)),
           tare_at = CASE WHEN v_tare IS DISTINCT FROM v.tare_kg THEN now() ELSE v.tare_at END,
           tare_kg = v_tare,
           active = COALESCE((p_vehicle ->> 'active')::BOOLEAN, v.active),
           updated_at = now()
     WHERE v.id = v_id AND v.workspace_id = ws;
    IF NOT FOUND THEN RAISE EXCEPTION 'Truck not found'; END IF;
  END IF;
  RETURN v_id;
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'A truck with this plate number already exists' USING ERRCODE = 'P0001', HINT = 'plate_taken';
END;
$$;

-- ─── Weighing ────────────────────────────────────────────────────────────────

-- First weighing. p_ticket: {vehicle_id?, plate_no?, driver_name?,
-- customer_id?, customer_name?, product_id, first_kg, price?, note?,
-- credit_override?}. Returns the ticket.
CREATE OR REPLACE FUNCTION public.erp_weigh_in(p_workspace_id UUID, p_ticket JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp__weigh_ws(p_workspace_id, 'fulfillment');
  v_owner UUID := (SELECT owner_id FROM public.erp_workspaces WHERE id = ws);
  v_vehicle public.erp_vehicles%ROWTYPE;
  v_vehicle_id UUID;
  v_customer UUID;
  v_customer_name TEXT;
  v_product UUID;
  p public.erp_products%ROWTYPE;
  v_first NUMERIC;
  v_price NUMERIC;
  v_plate TEXT := btrim(COALESCE(p_ticket ->> 'plate_no', ''));
  v_driver TEXT := btrim(COALESCE(p_ticket ->> 'driver_name', ''));
  v_override TEXT;
  open_no TEXT;
  new_id UUID;
BEGIN
  BEGIN
    v_vehicle_id := NULLIF(p_ticket ->> 'vehicle_id', '')::UUID;
    v_customer := NULLIF(p_ticket ->> 'customer_id', '')::UUID;
    v_product := NULLIF(p_ticket ->> 'product_id', '')::UUID;
    v_first := round((p_ticket ->> 'first_kg')::NUMERIC, 1);
    v_price := round(NULLIF(p_ticket ->> 'price', '')::NUMERIC, 2);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Invalid weigh ticket' USING ERRCODE = '22023';
  END;
  IF v_first IS NULL OR v_first <= 0 OR v_first > 200000 THEN
    RAISE EXCEPTION 'Enter the weight in kg (more than 0, at most 200,000)' USING ERRCODE = '22023', HINT = 'weight';
  END IF;

  SELECT * INTO p FROM public.erp_products WHERE id = v_product AND workspace_id = ws;
  IF NOT FOUND THEN RAISE EXCEPTION 'Product not found for this account'; END IF;
  IF p.unit NOT IN ('kg', 'ton', 'm3', 'l', 'rit') THEN
    RAISE EXCEPTION '% is sold in % and cannot be weighed; use kg, ton, m³, liter or truckload', p.name, p.unit
      USING ERRCODE = 'P0001', HINT = 'unit';
  END IF;
  IF p.unit IN ('m3', 'l') AND (p.density IS NULL OR p.density <= 0) THEN
    RAISE EXCEPTION 'Set the density of % (ton per m³) to sell it by weight', p.name USING ERRCODE = 'P0001', HINT = 'density';
  END IF;

  IF v_customer IS NOT NULL THEN
    SELECT name INTO v_customer_name FROM public.erp_customers WHERE id = v_customer AND workspace_id = ws;
    IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found for this account'; END IF;
  ELSE
    v_customer_name := btrim(COALESCE(p_ticket ->> 'customer_name', ''));
    IF v_customer_name = '' THEN
      RAISE EXCEPTION 'Choose a customer or type a name' USING ERRCODE = '22023', HINT = 'customer';
    END IF;
  END IF;
  v_override := public.erp__weigh_credit_check(ws, v_customer, NULL, p_ticket ->> 'credit_override');

  -- The truck: chosen, or found / registered by its plate.
  IF v_vehicle_id IS NOT NULL THEN
    SELECT * INTO v_vehicle FROM public.erp_vehicles WHERE id = v_vehicle_id AND workspace_id = ws;
    IF NOT FOUND THEN RAISE EXCEPTION 'Truck not found'; END IF;
  ELSE
    IF char_length(v_plate) < 2 THEN
      RAISE EXCEPTION 'Enter the plate number' USING ERRCODE = '22023', HINT = 'plate';
    END IF;
    SELECT * INTO v_vehicle FROM public.erp_vehicles
     WHERE workspace_id = ws AND plate_key = upper(regexp_replace(v_plate, '[^A-Za-z0-9]', '', 'g'));
    IF NOT FOUND THEN
      INSERT INTO public.erp_vehicles (user_id, workspace_id, plate_no, driver_name, customer_id, created_by)
      VALUES (v_owner, ws, v_plate, v_driver, v_customer, auth.uid())
      RETURNING * INTO v_vehicle;
    END IF;
  END IF;
  IF NOT v_vehicle.active THEN
    RAISE EXCEPTION 'Truck % is blocked', v_vehicle.plate_no USING ERRCODE = 'P0001', HINT = 'vehicle_blocked';
  END IF;
  SELECT doc_no INTO open_no FROM public.erp_weigh_tickets WHERE vehicle_id = v_vehicle.id AND status = 'open';
  IF FOUND THEN
    RAISE EXCEPTION 'Truck % already has an open ticket (%)', v_vehicle.plate_no, open_no USING ERRCODE = 'P0001', HINT = 'open_ticket';
  END IF;
  IF v_driver = '' THEN v_driver := v_vehicle.driver_name; END IF;

  IF v_price IS NULL THEN
    SELECT t.price INTO v_price FROM public.erp_weigh_tickets t
     WHERE t.workspace_id = ws AND t.customer_id = v_customer AND v_customer IS NOT NULL
       AND t.product_id = p.id AND t.status = 'completed'
     ORDER BY t.completed_at DESC LIMIT 1;
    v_price := COALESCE(v_price, p.selling_price, 0);
  ELSIF NOT public.erp_has_permission(ws, 'sales') THEN
    RAISE EXCEPTION 'Your workspace role does not allow changing prices' USING ERRCODE = '42501';
  END IF;
  IF v_price < 0 THEN RAISE EXCEPTION 'Price cannot be negative' USING ERRCODE = '22023'; END IF;

  INSERT INTO public.erp_weigh_tickets
    (user_id, workspace_id, vehicle_id, plate_no, driver_name, customer_id, customer_name, product_id, product_name,
     unit, first_kg, price, note, credit_override, created_by)
  VALUES
    (v_owner, ws, v_vehicle.id, v_vehicle.plate_no, left(v_driver, 120), v_customer, left(v_customer_name, 200), p.id, p.name,
     p.unit, v_first, v_price, left(btrim(COALESCE(p_ticket ->> 'note', '')), 500), v_override, auth.uid())
  RETURNING id INTO new_id;
  RETURN new_id;
END;
$$;

-- Second weighing: completes the ticket. p_second_kg NULL = the truck's
-- stored empty weight. p_price NULL keeps the ticket's price.
CREATE OR REPLACE FUNCTION public.erp_weigh_out(p_ticket_id UUID, p_second_kg NUMERIC, p_price NUMERIC DEFAULT NULL,
                                               p_credit_override TEXT DEFAULT NULL)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.erp_weigh_tickets%ROWTYPE;
  p public.erp_products%ROWTYPE;
  ws UUID;
  v_second NUMERIC := round(p_second_kg, 1);
  v_net NUMERIC;
  v_qty NUMERIC;
  v_price NUMERIC;
  v_override TEXT;
  v_cost NUMERIC;
BEGIN
  SELECT * INTO t FROM public.erp_weigh_tickets WHERE id = p_ticket_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Weigh ticket not found'; END IF;
  ws := public.erp__weigh_ws(t.workspace_id, 'fulfillment');
  IF t.status <> 'open' THEN
    RAISE EXCEPTION 'Ticket % is already %', t.doc_no, t.status USING ERRCODE = 'P0001', HINT = 'not_open';
  END IF;
  IF v_second IS NULL THEN
    SELECT tare_kg INTO v_second FROM public.erp_vehicles WHERE id = t.vehicle_id;
    IF v_second IS NULL THEN
      RAISE EXCEPTION 'This truck has no stored empty weight; weigh it' USING ERRCODE = 'P0001', HINT = 'no_tare';
    END IF;
  END IF;
  IF v_second <= 0 OR v_second > 200000 THEN
    RAISE EXCEPTION 'Enter the weight in kg (more than 0, at most 200,000)' USING ERRCODE = '22023', HINT = 'weight';
  END IF;
  v_net := abs(v_second - t.first_kg);
  IF v_net = 0 THEN
    RAISE EXCEPTION 'The two weights are the same: nothing was loaded' USING ERRCODE = 'P0001', HINT = 'net_zero';
  END IF;

  SELECT * INTO p FROM public.erp_products WHERE id = t.product_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Order product not found'; END IF;
  v_qty := public.erp__weigh_qty(v_net, t.unit, p.density);
  IF v_qty IS NULL OR v_qty <= 0 THEN
    RAISE EXCEPTION 'Set the density of % (ton per m³) to sell it by weight', p.name USING ERRCODE = 'P0001', HINT = 'density';
  END IF;

  v_price := round(COALESCE(p_price, t.price), 2);
  IF v_price < 0 THEN RAISE EXCEPTION 'Price cannot be negative' USING ERRCODE = '22023'; END IF;
  IF v_price IS DISTINCT FROM t.price AND NOT public.erp_has_permission(ws, 'sales') THEN
    RAISE EXCEPTION 'Your workspace role does not allow changing prices' USING ERRCODE = '42501';
  END IF;
  v_override := public.erp__weigh_credit_check(ws, t.customer_id, round(v_qty * v_price, 2),
                                               COALESCE(p_credit_override, NULLIF(t.credit_override, '')));

  -- As deliveries: never more than is on hand.
  IF p.current_stock < v_qty THEN
    RAISE EXCEPTION 'Insufficient stock for % (available %, required %)', p.name, trim_scale(p.current_stock), trim_scale(v_qty);
  END IF;
  PERFORM public.erp__change_stock(p.id, -v_qty);
  INSERT INTO public.erp_stock_movements
    (user_id, product_id, product_name, movement_type, quantity, movement_date, note, source_type, source_id, created_by)
  VALUES (t.user_id, p.id, p.name, 'out', v_qty, CURRENT_DATE, 'Weigh ticket ' || t.doc_no, 'weigh_ticket', t.id, auth.uid());
  v_cost := round(v_qty * COALESCE(public.erp__unit_cost(p.id), 0), 2);
  IF v_cost > 0 THEN
    PERFORM public.erp_gl__post(t.user_id, CURRENT_DATE, 'Goods delivered (cost): ' || t.doc_no, 'weigh_ticket', t.id,
                                'ticket:' || t.id, public.erp_gl__pair('cogs', 'inventory', v_cost));
  END IF;

  -- The truck remembers its empty weight.
  UPDATE public.erp_vehicles SET tare_kg = LEAST(v_second, t.first_kg), tare_at = now(), updated_at = now()
   WHERE id = t.vehicle_id;

  UPDATE public.erp_weigh_tickets
     SET second_kg = v_second, second_at = now(), qty = v_qty, price = v_price, status = 'completed',
         ticket_date = CURRENT_DATE, credit_override = v_override, completed_by = auth.uid(), completed_at = now(),
         updated_at = now()
   WHERE id = t.id;
  RETURN t.id;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_weigh_cancel(p_ticket_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  t public.erp_weigh_tickets%ROWTYPE;
  ws UUID;
  v_reason TEXT := btrim(COALESCE(p_reason, ''));
BEGIN
  SELECT * INTO t FROM public.erp_weigh_tickets WHERE id = p_ticket_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Weigh ticket not found'; END IF;
  ws := public.erp__weigh_ws(t.workspace_id, 'fulfillment');
  IF char_length(v_reason) < 3 THEN
    RAISE EXCEPTION 'Give a reason (at least 3 characters)' USING ERRCODE = '22023', HINT = 'reason';
  END IF;
  IF t.status = 'cancelled' THEN RETURN; END IF;
  IF t.status = 'completed' THEN
    IF public.erp_workspace_role(ws) NOT IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'Only the Owner or an Admin can cancel a completed ticket' USING ERRCODE = '42501';
    END IF;
    IF t.invoice_id IS NOT NULL THEN
      RAISE EXCEPTION 'Ticket % is invoiced; void the invoice first', t.doc_no USING ERRCODE = 'P0001', HINT = 'invoiced';
    END IF;
    IF t.product_id IS NOT NULL THEN
      PERFORM 1 FROM public.erp_products WHERE id = t.product_id FOR UPDATE;
      PERFORM public.erp__change_stock(t.product_id, t.qty);
      INSERT INTO public.erp_stock_movements
        (user_id, product_id, product_name, movement_type, quantity, movement_date, note, source_type, source_id, created_by)
      VALUES (t.user_id, t.product_id, t.product_name, 'in', t.qty, CURRENT_DATE, 'Cancelled weigh ticket ' || t.doc_no,
              'weigh_ticket_cancel', t.id, auth.uid());
    END IF;
    PERFORM public.erp_gl__reverse(t.user_id, 'ticket:' || t.id, CURRENT_DATE, 'Cancelled weigh ticket ' || t.doc_no,
                                   'weigh_ticket_cancel', t.id, 'ticket_cancel:' || t.id);
  END IF;
  UPDATE public.erp_weigh_tickets
     SET status = 'cancelled', cancel_reason = left(v_reason, 500), cancelled_by = auth.uid(), cancelled_at = now(),
         updated_at = now()
   WHERE id = t.id;
END;
$$;

-- ─── Invoicing ───────────────────────────────────────────────────────────────

-- One invoice for a customer's completed, not yet invoiced tickets dated
-- p_from … p_to: a line per product, unit and price.
CREATE OR REPLACE FUNCTION public.erp_weigh_tickets_invoice(p_workspace_id UUID, p_customer_id UUID, p_from DATE, p_to DATE,
                                                           p_tax_rate NUMERIC, p_due_date DATE)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp__weigh_ws(p_workspace_id, 'invoicing');
  v_name TEXT;
  v_lines JSONB;
  v_ids UUID[];
  new_id UUID;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to < p_from THEN
    RAISE EXCEPTION 'Choose a period' USING ERRCODE = '22023';
  END IF;
  SELECT name INTO v_name FROM public.erp_customers WHERE id = p_customer_id AND workspace_id = ws;
  IF NOT FOUND THEN RAISE EXCEPTION 'Customer not found for this account'; END IF;

  SELECT array_agg(t.id) INTO v_ids FROM (
    SELECT id FROM public.erp_weigh_tickets
     WHERE workspace_id = ws AND customer_id = p_customer_id AND status = 'completed' AND invoice_id IS NULL
       AND ticket_date BETWEEN p_from AND p_to
     ORDER BY id FOR UPDATE) t;
  IF v_ids IS NULL THEN
    RAISE EXCEPTION 'No tickets to invoice for % in this period', v_name USING ERRCODE = 'P0001', HINT = 'no_tickets';
  END IF;

  SELECT jsonb_agg(jsonb_build_object('product_id', g.product_id, 'description', g.product_name, 'qty', g.qty,
                                      'unit', g.unit, 'price', g.price) ORDER BY g.product_name, g.price)
    INTO v_lines
    FROM (SELECT t.product_id, t.product_name, t.unit, t.price, sum(t.qty) AS qty
            FROM public.erp_weigh_tickets t WHERE t.id = ANY (v_ids)
           GROUP BY t.product_id, t.product_name, t.unit, t.price) g;

  new_id := public.erp_create_invoice_v6(ws, p_customer_id, v_name, CURRENT_DATE, COALESCE(p_due_date, CURRENT_DATE + 30),
                                         v_lines, COALESCE(p_tax_rate, 0), NULL, NULL);
  UPDATE public.erp_weigh_tickets SET invoice_id = new_id, updated_at = now() WHERE id = ANY (v_ids);
  RETURN new_id;
END;
$$;

-- A voided invoice frees its tickets so they can be invoiced again.
CREATE OR REPLACE FUNCTION public.erp_weigh__release_on_void()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.erp_weigh_tickets SET invoice_id = NULL, updated_at = now() WHERE invoice_id = NEW.id;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_erp_weigh_release_on_void ON public.erp_invoices;
CREATE TRIGGER trg_erp_weigh_release_on_void
  AFTER UPDATE OF status, voided_at ON public.erp_invoices
  FOR EACH ROW WHEN (NEW.voided_at IS NOT NULL AND OLD.voided_at IS NULL OR NEW.status = 'void' AND OLD.status <> 'void')
  EXECUTE FUNCTION public.erp_weigh__release_on_void();

-- ─── Reports ─────────────────────────────────────────────────────────────────

-- Completed tickets per product in a period (row-level security decides).
CREATE OR REPLACE FUNCTION public.erp_weighbridge_summary(p_workspace_id UUID, p_from DATE, p_to DATE)
RETURNS TABLE (product_id UUID, product_name TEXT, unit TEXT, tickets INTEGER, net_kg NUMERIC, qty NUMERIC, amount NUMERIC)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT t.product_id, t.product_name, t.unit, count(*)::INTEGER, sum(t.net_kg), sum(t.qty), sum(t.amount)
    FROM public.erp_weigh_tickets t
   WHERE t.workspace_id = p_workspace_id AND t.status = 'completed' AND t.ticket_date BETWEEN p_from AND p_to
   GROUP BY t.product_id, t.product_name, t.unit
   ORDER BY t.product_name;
$$;

-- Customers for the ticket screen, with credit limit and what they owe or
-- will owe. Weighbridge operators (Inventory) cannot read the customer list
-- itself, so this gives them names only.
CREATE OR REPLACE FUNCTION public.erp_weigh_customers(p_workspace_id UUID)
RETURNS TABLE (id UUID, name TEXT, credit_limit NUMERIC, exposure NUMERIC)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  ws UUID := COALESCE(p_workspace_id, public.erp_personal_workspace_id(auth.uid()));
BEGIN
  IF auth.uid() IS NULL OR public.erp_workspace_role(ws) IS NULL
     OR NOT (public.erp_has_permission(ws, 'fulfillment') OR public.erp_has_permission(ws, 'sales')
             OR public.erp_has_permission(ws, 'read')) THEN
    RAISE EXCEPTION 'Your workspace role does not allow this action' USING ERRCODE = '42501';
  END IF;
  PERFORM public.erp__require_module(ws, 'weighbridge');
  RETURN QUERY
  SELECT c.id, c.name, c.credit_limit,
         CASE WHEN c.credit_limit IS NOT NULL THEN public.erp__customer_exposure(c.id) END
    FROM public.erp_customers c WHERE c.workspace_id = ws ORDER BY c.name LIMIT 2000;
END;
$$;

-- ─── Reset: tickets go with the documents, trucks with the master data ─────
CREATE OR REPLACE FUNCTION public.erp__reset_modules(p_workspace_id UUID, p_scope TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.erp_weigh_tickets x WHERE x.workspace_id = p_workspace_id;
  IF p_scope = 'all' THEN
    DELETE FROM public.erp_vehicles x WHERE x.workspace_id = p_workspace_id;
  END IF;
END;
$$;

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
      RAISE EXCEPTION 'erp_patch: % does not contain %', p_fn, p_pairs[i];
    END IF;
    body := replace(body, p_pairs[i], p_pairs[i + 1]);
  END LOOP;
  RETURN body;
END;
$$;
DO $$
BEGIN
  EXECUTE pg_temp.erp_patch('public.erp_reset_workspace(uuid, text)'::regprocedure, ARRAY[
    '  DELETE FROM public.erp_stock_movements x WHERE x.workspace_id = ws;',
    '  -- Industry modules first (20261012000024).
  PERFORM public.erp__reset_modules(ws, p_scope);
  DELETE FROM public.erp_stock_movements x WHERE x.workspace_id = ws;']);
END;
$$;

-- ─── Grants ──────────────────────────────────────────────────────────────────
REVOKE ALL ON FUNCTION public.erp__weigh_ws(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp__customer_exposure(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp__weigh_credit_check(UUID, UUID, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp__weigh_qty(NUMERIC, TEXT, NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_weigh__release_on_void() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp__reset_modules(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_vehicle_save(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_weigh_in(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_weigh_out(UUID, NUMERIC, NUMERIC, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_weigh_cancel(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_weigh_tickets_invoice(UUID, UUID, DATE, DATE, NUMERIC, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_weighbridge_summary(UUID, DATE, DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_weigh_customers(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_vehicle_save(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_weigh_in(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_weigh_out(UUID, NUMERIC, NUMERIC, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_weigh_cancel(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_weigh_tickets_invoice(UUID, UUID, DATE, DATE, NUMERIC, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_weighbridge_summary(UUID, DATE, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_weigh_customers(UUID) TO authenticated;
