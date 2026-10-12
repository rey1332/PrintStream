-- Equipment module: machines, hour meters, fuel issued, services due.
--
-- A quarry runs excavators, wheel loaders, dump trucks, crushers and
-- gensets. Each machine (erp_equipment) has an hour meter and a service
-- interval. Its log (erp_equipment_logs) records:
--
--   hours    a meter reading; the hours worked since the last reading
--   fuel     liters issued from a fuel product in stock (unit liter): stock
--            goes out and its cost is posted Dr Operating expenses,
--            Cr Inventory (optionally with a meter reading)
--   service  maintenance done (what, at which reading, what it cost — the
--            cost is for the record; paying it is a purchase or expense)
--
-- The machine's meter and last service follow from its posted log entries,
-- so reversing an entry (Owner or Admin, with a reason) puts them back; a
-- reversed fuel issue returns the fuel to stock and reverses its cost.
-- Service is due every service_interval_hours after the last service.
--
-- Recording needs the inventory right (Owner, Admin, Inventory) and the
-- equipment module (20261012000023).
--
-- Rollback: db/rollback/rollback_20261012000026_erp_equipment.sql

CREATE TABLE IF NOT EXISTS public.erp_equipment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  code TEXT NOT NULL CHECK (char_length(btrim(code)) BETWEEN 1 AND 30),
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  kind TEXT NOT NULL DEFAULT 'other'
    CHECK (kind IN ('excavator', 'wheel_loader', 'dump_truck', 'bulldozer', 'crusher', 'genset', 'vehicle', 'other')),
  initial_hour_meter NUMERIC(10, 1) NOT NULL DEFAULT 0 CHECK (initial_hour_meter >= 0),
  hour_meter NUMERIC(10, 1) NOT NULL DEFAULT 0,
  service_interval_hours NUMERIC(8, 1) CHECK (service_interval_hours IS NULL OR service_interval_hours > 0),
  last_service_hours NUMERIC(10, 1),
  last_service_date DATE,
  note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  active BOOLEAN NOT NULL DEFAULT true,
  created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_equipment_code ON public.erp_equipment (workspace_id, upper(btrim(code)));

CREATE TABLE IF NOT EXISTS public.erp_equipment_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  workspace_id UUID REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  equipment_id UUID NOT NULL REFERENCES public.erp_equipment(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('hours', 'fuel', 'service')),
  log_date DATE NOT NULL DEFAULT CURRENT_DATE,
  hour_meter NUMERIC(10, 1) CHECK (hour_meter IS NULL OR hour_meter >= 0),
  hours_worked NUMERIC(10, 1),
  liters NUMERIC(12, 3) CHECK (liters IS NULL OR liters > 0),
  fuel_product_id UUID REFERENCES public.erp_products(id) ON DELETE SET NULL,
  fuel_product_name TEXT NOT NULL DEFAULT '',
  unit_cost NUMERIC(15, 4),
  amount NUMERIC(15, 2),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 300),
  operator TEXT NOT NULL DEFAULT '' CHECK (char_length(operator) <= 120),
  note TEXT NOT NULL DEFAULT '' CHECK (char_length(note) <= 500),
  status TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted', 'reversed')),
  reverse_reason TEXT NOT NULL DEFAULT '' CHECK (char_length(reverse_reason) <= 500),
  reversed_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  reversed_at TIMESTAMPTZ,
  created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (kind <> 'hours' OR hour_meter IS NOT NULL),
  CHECK (kind <> 'fuel' OR (liters IS NOT NULL AND fuel_product_name <> '')),
  CHECK (kind <> 'service' OR description <> '')
);
CREATE INDEX IF NOT EXISTS idx_erp_equipment_logs_eq ON public.erp_equipment_logs (equipment_id, log_date DESC);
CREATE INDEX IF NOT EXISTS idx_erp_equipment_logs_ws_date ON public.erp_equipment_logs (workspace_id, log_date DESC);

DO $$
DECLARE target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['erp_equipment', 'erp_equipment_logs'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_erp_assign_workspace ON public.%I', target);
    EXECUTE format('CREATE TRIGGER trg_erp_assign_workspace BEFORE INSERT OR UPDATE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION public.erp_assign_workspace()', target);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_audit_%s ON public.%I', target, target);
    EXECUTE format('CREATE TRIGGER trg_audit_%s AFTER INSERT OR UPDATE OR DELETE ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION public.erp_audit_trigger_fn()', target, target);
  END LOOP;
END;
$$;

ALTER TABLE public.erp_journal_entries DROP CONSTRAINT IF EXISTS erp_journal_entries_source_type_check;
ALTER TABLE public.erp_journal_entries ADD CONSTRAINT erp_journal_entries_source_type_check CHECK (source_type IN (
  'invoice', 'invoice_void', 'invoice_adjust', 'payment', 'payment_void', 'payment_adjust', 'transaction',
  'purchase_receipt', 'sales_delivery', 'stock_adjustment', 'opening_stock', 'manual', 'manual_reversal',
  'fx_settlement', 'payroll', 'payroll_reversal', 'weigh_ticket', 'weigh_ticket_cancel',
  'production', 'production_reversal', 'fuel_issue', 'fuel_issue_reversal'));

-- Read like stock; written only through the functions below.
ALTER TABLE public.erp_equipment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_equipment_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_equipment, public.erp_equipment_logs FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.erp_equipment, public.erp_equipment_logs TO authenticated;
DO $$
DECLARE target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['erp_equipment', 'erp_equipment_logs'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', target || '_member_read', target);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated '
                   'USING (workspace_id IS NOT NULL AND public.erp_can_read(workspace_id, %L))',
                   target || '_member_read', target, 'stock');
    EXECUTE format('DROP POLICY IF EXISTS erp_workspace_not_suspended ON public.%I', target);
    EXECUTE format('CREATE POLICY erp_workspace_not_suspended ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
                   'USING (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[])) '
                   'WITH CHECK (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]))',
                   target);
  END LOOP;
END;
$$;

-- ─── Helpers ─────────────────────────────────────────────────────────────────

-- The machine's meter and last service, from its posted log entries.
CREATE OR REPLACE FUNCTION public.erp__equipment_refresh(p_equipment_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  svc RECORD;
BEGIN
  SELECT l.hour_meter, l.log_date INTO svc FROM public.erp_equipment_logs l
   WHERE l.equipment_id = p_equipment_id AND l.kind = 'service' AND l.status = 'posted'
   ORDER BY l.log_date DESC, l.created_at DESC LIMIT 1;
  UPDATE public.erp_equipment e
     SET hour_meter = GREATEST(e.initial_hour_meter, COALESCE((
           SELECT max(l.hour_meter) FROM public.erp_equipment_logs l
            WHERE l.equipment_id = e.id AND l.status = 'posted'), 0)),
         last_service_hours = svc.hour_meter,
         last_service_date = svc.log_date,
         updated_at = now()
   WHERE e.id = p_equipment_id;
END;
$$;

-- ─── Machines ────────────────────────────────────────────────────────────────

-- p_equipment: {id?, code, name, kind?, initial_hour_meter?, service_interval_hours?, note?, active?}
CREATE OR REPLACE FUNCTION public.erp_equipment_save(p_workspace_id UUID, p_equipment JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp__resolve_workspace(p_workspace_id, 'inventory');
  v_owner UUID := (SELECT owner_id FROM public.erp_workspaces WHERE id = ws);
  v_id UUID;
  v_initial NUMERIC;
  v_interval NUMERIC;
BEGIN
  PERFORM public.erp__require_module(ws, 'equipment');
  BEGIN
    v_id := NULLIF(p_equipment ->> 'id', '')::UUID;
    v_initial := round(COALESCE(NULLIF(p_equipment ->> 'initial_hour_meter', '')::NUMERIC, 0), 1);
    v_interval := round(NULLIF(p_equipment ->> 'service_interval_hours', '')::NUMERIC, 1);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Invalid equipment' USING ERRCODE = '22023';
  END;
  IF v_initial < 0 OR (v_interval IS NOT NULL AND v_interval <= 0) THEN
    RAISE EXCEPTION 'Hour meter and service interval cannot be negative' USING ERRCODE = '22023', HINT = 'numbers';
  END IF;
  IF v_id IS NULL THEN
    INSERT INTO public.erp_equipment (user_id, workspace_id, code, name, kind, initial_hour_meter, hour_meter,
                                      service_interval_hours, note, active, created_by)
    VALUES (v_owner, ws, btrim(COALESCE(p_equipment ->> 'code', '')), btrim(COALESCE(p_equipment ->> 'name', '')),
            COALESCE(NULLIF(p_equipment ->> 'kind', ''), 'other'), v_initial, v_initial, v_interval,
            left(btrim(COALESCE(p_equipment ->> 'note', '')), 500), COALESCE((p_equipment ->> 'active')::BOOLEAN, true), auth.uid())
    RETURNING id INTO v_id;
  ELSE
    UPDATE public.erp_equipment e
       SET code = btrim(COALESCE(p_equipment ->> 'code', e.code)),
           name = btrim(COALESCE(p_equipment ->> 'name', e.name)),
           kind = COALESCE(NULLIF(p_equipment ->> 'kind', ''), e.kind),
           initial_hour_meter = v_initial,
           service_interval_hours = v_interval,
           note = left(btrim(COALESCE(p_equipment ->> 'note', e.note)), 500),
           active = COALESCE((p_equipment ->> 'active')::BOOLEAN, e.active),
           updated_at = now()
     WHERE e.id = v_id AND e.workspace_id = ws;
    IF NOT FOUND THEN RAISE EXCEPTION 'Equipment not found'; END IF;
    PERFORM public.erp__equipment_refresh(v_id);
  END IF;
  RETURN v_id;
EXCEPTION
  WHEN unique_violation THEN
    RAISE EXCEPTION 'Another machine already has this code' USING ERRCODE = 'P0001', HINT = 'code_taken';
  WHEN check_violation THEN
    RAISE EXCEPTION 'Enter a code and a name' USING ERRCODE = '22023', HINT = 'name';
END;
$$;

-- ─── Log ─────────────────────────────────────────────────────────────────────

-- p_log: {equipment_id, kind: hours|fuel|service, log_date?, hour_meter?,
--   liters?, fuel_product_id?, description?, amount?, operator?, note?}
CREATE OR REPLACE FUNCTION public.erp_equipment_log(p_workspace_id UUID, p_log JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := public.erp__resolve_workspace(p_workspace_id, 'inventory');
  e public.erp_equipment%ROWTYPE;
  fuel public.erp_products%ROWTYPE;
  v_kind TEXT := p_log ->> 'kind';
  v_date DATE;
  v_meter NUMERIC;
  v_liters NUMERIC;
  v_amount NUMERIC;
  v_cost NUMERIC;
  v_desc TEXT := left(btrim(COALESCE(p_log ->> 'description', '')), 300);
  new_id UUID;
BEGIN
  PERFORM public.erp__require_module(ws, 'equipment');
  BEGIN
    SELECT * INTO e FROM public.erp_equipment
     WHERE id = (p_log ->> 'equipment_id')::UUID AND workspace_id = ws FOR UPDATE;
    v_date := COALESCE(NULLIF(p_log ->> 'log_date', '')::DATE, CURRENT_DATE);
    v_meter := round(NULLIF(p_log ->> 'hour_meter', '')::NUMERIC, 1);
    v_liters := round(NULLIF(p_log ->> 'liters', '')::NUMERIC, 3);
    v_amount := round(NULLIF(p_log ->> 'amount', '')::NUMERIC, 2);
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Invalid equipment log' USING ERRCODE = '22023';
  END;
  IF e.id IS NULL THEN RAISE EXCEPTION 'Equipment not found'; END IF;
  IF NOT e.active THEN RAISE EXCEPTION 'This machine is retired' USING ERRCODE = 'P0001', HINT = 'inactive'; END IF;
  IF v_kind IS NULL OR v_kind NOT IN ('hours', 'fuel', 'service') THEN
    RAISE EXCEPTION 'Invalid equipment log' USING ERRCODE = '22023';
  END IF;
  IF v_date > CURRENT_DATE THEN
    RAISE EXCEPTION 'The date cannot be in the future' USING ERRCODE = '22023', HINT = 'future';
  END IF;
  IF v_kind = 'hours' AND v_meter IS NULL THEN
    RAISE EXCEPTION 'Enter the hour meter reading' USING ERRCODE = '22023', HINT = 'meter';
  END IF;
  IF v_meter IS NOT NULL AND v_meter < e.hour_meter AND v_kind <> 'service' THEN
    RAISE EXCEPTION 'The hour meter reading is lower than the last one (%)', trim_scale(e.hour_meter)
      USING ERRCODE = 'P0001', HINT = 'meter_back';
  END IF;
  IF v_meter IS NOT NULL AND v_meter - e.hour_meter > 1000 AND v_kind = 'hours' THEN
    RAISE EXCEPTION 'More than 1,000 hours since the last reading; check the meter' USING ERRCODE = 'P0001', HINT = 'meter_jump';
  END IF;
  IF v_amount IS NOT NULL AND v_amount < 0 THEN
    RAISE EXCEPTION 'Cost cannot be negative' USING ERRCODE = '22023';
  END IF;

  IF v_kind = 'fuel' THEN
    IF v_liters IS NULL OR v_liters <= 0 THEN
      RAISE EXCEPTION 'Enter the liters issued' USING ERRCODE = '22023', HINT = 'liters';
    END IF;
    BEGIN
      SELECT * INTO fuel FROM public.erp_products
       WHERE id = (p_log ->> 'fuel_product_id')::UUID AND workspace_id = ws FOR UPDATE;
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION 'Choose the fuel' USING ERRCODE = '22023', HINT = 'fuel';
    END;
    IF fuel.id IS NULL THEN RAISE EXCEPTION 'Choose the fuel' USING ERRCODE = '22023', HINT = 'fuel'; END IF;
    IF fuel.unit <> 'l' THEN
      RAISE EXCEPTION 'Fuel must be a product counted in liters' USING ERRCODE = 'P0001', HINT = 'fuel_unit';
    END IF;
    IF fuel.current_stock < v_liters THEN
      RAISE EXCEPTION 'Insufficient stock for % (available %, required %)', fuel.name, trim_scale(fuel.current_stock), trim_scale(v_liters);
    END IF;
    v_cost := COALESCE(public.erp__unit_cost(fuel.id), 0);
    v_amount := round(v_liters * v_cost, 2);
  ELSIF v_kind = 'service' THEN
    IF v_desc = '' THEN
      RAISE EXCEPTION 'Describe the service' USING ERRCODE = '22023', HINT = 'description';
    END IF;
    v_meter := COALESCE(v_meter, e.hour_meter);
  END IF;

  INSERT INTO public.erp_equipment_logs
    (user_id, workspace_id, equipment_id, kind, log_date, hour_meter, hours_worked, liters, fuel_product_id, fuel_product_name,
     unit_cost, amount, description, operator, note, created_by)
  VALUES
    (e.user_id, ws, e.id, v_kind, v_date, v_meter,
     CASE WHEN v_meter IS NOT NULL AND v_kind <> 'service' THEN v_meter - e.hour_meter END,
     CASE WHEN v_kind = 'fuel' THEN v_liters END, fuel.id, COALESCE(fuel.name, ''), v_cost, v_amount,
     CASE WHEN v_kind = 'service' THEN v_desc ELSE '' END,
     left(btrim(COALESCE(p_log ->> 'operator', '')), 120), left(btrim(COALESCE(p_log ->> 'note', '')), 500), auth.uid())
  RETURNING id INTO new_id;

  IF v_kind = 'fuel' THEN
    PERFORM public.erp__change_stock(fuel.id, -v_liters);
    INSERT INTO public.erp_stock_movements
      (user_id, product_id, product_name, movement_type, quantity, movement_date, note, source_type, source_id, created_by)
    VALUES (e.user_id, fuel.id, fuel.name, 'out', v_liters, v_date, 'Fuel for ' || e.code, 'fuel_issue', new_id, auth.uid());
    IF v_amount > 0 THEN
      PERFORM public.erp_gl__post(e.user_id, v_date, 'Fuel for ' || e.code || ' ' || e.name, 'fuel_issue', new_id,
                                  'fuel:' || new_id, public.erp_gl__pair('expenses', 'inventory', v_amount));
    END IF;
  END IF;
  PERFORM public.erp__equipment_refresh(e.id);
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_equipment_log_reverse(p_log_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  l public.erp_equipment_logs%ROWTYPE;
  v_reason TEXT := btrim(COALESCE(p_reason, ''));
BEGIN
  SELECT * INTO l FROM public.erp_equipment_logs WHERE id = p_log_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Log entry not found'; END IF;
  PERFORM public.erp__resolve_workspace(l.workspace_id, 'inventory');
  PERFORM public.erp__require_module(l.workspace_id, 'equipment');
  IF public.erp_workspace_role(l.workspace_id) NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only the Owner or an Admin can reverse a log entry' USING ERRCODE = '42501';
  END IF;
  IF char_length(v_reason) < 3 THEN
    RAISE EXCEPTION 'Give a reason (at least 3 characters)' USING ERRCODE = '22023', HINT = 'reason';
  END IF;
  IF l.status = 'reversed' THEN RETURN; END IF;
  PERFORM 1 FROM public.erp_equipment WHERE id = l.equipment_id FOR UPDATE;
  IF l.kind = 'fuel' AND l.fuel_product_id IS NOT NULL THEN
    PERFORM 1 FROM public.erp_products WHERE id = l.fuel_product_id FOR UPDATE;
    PERFORM public.erp__change_stock(l.fuel_product_id, l.liters);
    INSERT INTO public.erp_stock_movements
      (user_id, product_id, product_name, movement_type, quantity, movement_date, note, source_type, source_id, created_by)
    VALUES (l.user_id, l.fuel_product_id, l.fuel_product_name, 'in', l.liters, CURRENT_DATE, 'Fuel issue reversed',
            'fuel_issue_reversal', l.id, auth.uid());
    PERFORM public.erp_gl__reverse(l.user_id, 'fuel:' || l.id, CURRENT_DATE, 'Fuel issue reversed', 'fuel_issue_reversal',
                                   l.id, 'fuel_reversal:' || l.id);
  END IF;
  UPDATE public.erp_equipment_logs
     SET status = 'reversed', reverse_reason = left(v_reason, 500), reversed_by = auth.uid(), reversed_at = now()
   WHERE id = l.id;
  PERFORM public.erp__equipment_refresh(l.equipment_id);
END;
$$;

-- ─── Overview ────────────────────────────────────────────────────────────────
-- Per machine for a period: hours worked, liters, fuel cost, liters per hour,
-- and hours until the next service (negative = overdue).
CREATE OR REPLACE FUNCTION public.erp_equipment_overview(p_workspace_id UUID, p_from DATE, p_to DATE)
RETURNS TABLE (equipment_id UUID, code TEXT, name TEXT, kind TEXT, hour_meter NUMERIC, service_interval_hours NUMERIC,
               last_service_hours NUMERIC, last_service_date DATE, service_due_in NUMERIC, active BOOLEAN,
               hours NUMERIC, liters NUMERIC, fuel_cost NUMERIC, liters_per_hour NUMERIC, services INTEGER)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT e.id, e.code, e.name, e.kind, e.hour_meter, e.service_interval_hours, e.last_service_hours, e.last_service_date,
         CASE WHEN e.service_interval_hours IS NOT NULL
              THEN COALESCE(e.last_service_hours, e.initial_hour_meter) + e.service_interval_hours - e.hour_meter END,
         e.active,
         COALESCE(s.hours, 0), COALESCE(s.liters, 0), COALESCE(s.fuel_cost, 0),
         CASE WHEN COALESCE(s.hours, 0) > 0 THEN round(COALESCE(s.liters, 0) / s.hours, 2) END,
         COALESCE(s.services, 0)
    FROM public.erp_equipment e
    LEFT JOIN LATERAL (
      SELECT sum(l.hours_worked) FILTER (WHERE l.hours_worked IS NOT NULL) AS hours,
             sum(l.liters) FILTER (WHERE l.kind = 'fuel') AS liters,
             sum(l.amount) FILTER (WHERE l.kind = 'fuel') AS fuel_cost,
             count(*) FILTER (WHERE l.kind = 'service')::INTEGER AS services
        FROM public.erp_equipment_logs l
       WHERE l.equipment_id = e.id AND l.status = 'posted' AND l.log_date BETWEEN p_from AND p_to
    ) s ON true
   WHERE e.workspace_id = p_workspace_id
   ORDER BY e.active DESC, e.code;
$$;

-- ─── Reset: logs go with the documents, machines with the master data ──────
-- As in 20261012000025, plus equipment.
CREATE OR REPLACE FUNCTION public.erp__reset_modules(p_workspace_id UUID, p_scope TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  DELETE FROM public.erp_weigh_tickets x WHERE x.workspace_id = p_workspace_id;
  DELETE FROM public.erp_production_runs x WHERE x.workspace_id = p_workspace_id;
  DELETE FROM public.erp_equipment_logs x WHERE x.workspace_id = p_workspace_id;
  UPDATE public.erp_equipment x SET hour_meter = x.initial_hour_meter, last_service_hours = NULL, last_service_date = NULL
   WHERE x.workspace_id = p_workspace_id;
  IF p_scope = 'all' THEN
    DELETE FROM public.erp_vehicles x WHERE x.workspace_id = p_workspace_id;
    DELETE FROM public.erp_equipment x WHERE x.workspace_id = p_workspace_id;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.erp__equipment_refresh(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_equipment_save(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_equipment_log(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_equipment_log_reverse(UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_equipment_overview(UUID, DATE, DATE) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_equipment_save(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_equipment_log(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_equipment_log_reverse(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_equipment_overview(UUID, DATE, DATE) TO authenticated;
