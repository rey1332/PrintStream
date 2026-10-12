-- Sync between ERPs.
--
-- An Owner or Admin of two or more ERPs copies data between them: a source
-- ERP, one or more targets, a direction (push = source → targets, pull =
-- targets → source, both) and the kinds of data:
--   customers, suppliers, products  master data, kept in step column by column
--   stock                           product stock levels (as stock adjustments)
--   sales_orders, purchase_orders   copied once, as a draft / pending order
--   invoices, payments              copied once into the target's sync inbox,
--                                   posted there by a person (no journal until then)
--
-- Isolation stays as it is: one database, every row scoped to its ERP
-- (workspace_id and the ERP's owner account), enforced by RLS and by these
-- functions, which check the caller's role in every ERP they touch.
--
-- Matching: a row is paired with a row in the other ERP the first time by its
-- business key (customers / suppliers: e-mail, else name; products: SKU, else
-- name; case-insensitive), and the pair is stored (erp_sync_links). Later syncs
-- use the stored pair, so renaming or changing a code does not duplicate rows.
--
-- Conflicts (master data and stock): last write wins per column. Every
-- change to a synced column records when it happened (erp_sync_field_clock);
-- for each column the side changed most recently wins, in the directions the
-- sync allows (a push never overwrites a newer change in the target). A copied
-- value keeps the time of the change it copies.
--
-- Deletions are not synced. Prices are in each ERP's base currency: they are
-- converted with the target ERP's stored rate (at most 7 days old), or the
-- row is skipped. Orders, invoices and payments keep their own currency; the
-- target ERP uses its own rates for them, as for any foreign-currency document.
--
-- When an ERP is deleted, its links, sync state and runs go with it; data
-- copied into other ERPs stays (inbox items there remain and can be posted
-- without a link back).
--
-- Rollback: db/rollback/rollback_20261012000003_erp_sync.sql

-- ─── 1. Tables ───────────────────────────────────────────────────────────────

-- Whether the ERP can be chosen as a sync source or target.
ALTER TABLE public.erp_workspaces ADD COLUMN IF NOT EXISTS sync_enabled BOOLEAN NOT NULL DEFAULT true;

-- Pairs of rows that are the same record in two ERPs (stored once, ws_a < ws_b).
CREATE TABLE IF NOT EXISTS public.erp_sync_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity TEXT NOT NULL CHECK (entity IN (
    'customers', 'suppliers', 'products', 'sales_orders', 'purchase_orders', 'invoices', 'payments')),
  ws_a UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  row_a UUID NOT NULL,
  ws_b UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  row_b UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ws_a < ws_b)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_sync_links_a ON public.erp_sync_links(entity, ws_a, row_a, ws_b);
CREATE UNIQUE INDEX IF NOT EXISTS uq_erp_sync_links_b ON public.erp_sync_links(entity, ws_b, row_b, ws_a);
CREATE INDEX IF NOT EXISTS idx_erp_sync_links_row_a ON public.erp_sync_links(row_a);
CREATE INDEX IF NOT EXISTS idx_erp_sync_links_row_b ON public.erp_sync_links(row_b);

-- When each synced column of a row last changed.
CREATE TABLE IF NOT EXISTS public.erp_sync_field_clock (
  row_id UUID NOT NULL,
  field TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (row_id, field)
);

-- One run: what the person asked for and what happened, per target and kind.
CREATE TABLE IF NOT EXISTS public.erp_sync_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_ws UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  targets UUID[] NOT NULL,
  direction TEXT NOT NULL CHECK (direction IN ('push', 'pull', 'both')),
  entities TEXT[] NOT NULL,
  since DATE,
  started_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'partial', 'failed')),
  result JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_erp_sync_runs_source ON public.erp_sync_runs(source_ws, started_at DESC);

-- The last sync per (source, target, kind of data); source → target is the
-- direction the data went.
CREATE TABLE IF NOT EXISTS public.erp_sync_state (
  source_ws UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  target_ws UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  last_sync_at TIMESTAMPTZ NOT NULL,
  last_status TEXT NOT NULL CHECK (last_status IN ('success', 'partial', 'failed')),
  last_counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_run_id UUID REFERENCES public.erp_sync_runs(id) ON DELETE SET NULL,
  PRIMARY KEY (source_ws, target_ws, entity)
);

-- Invoices and payments from another ERP, waiting to be posted (or dismissed).
CREATE TABLE IF NOT EXISTS public.erp_sync_inbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  source_ws UUID NOT NULL,
  source_name TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL CHECK (kind IN ('invoice', 'payment')),
  source_id UUID NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted', 'dismissed')),
  posted_id UUID,
  decided_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, kind, source_id)
);
CREATE INDEX IF NOT EXISTS idx_erp_sync_inbox_ws ON public.erp_sync_inbox(workspace_id, status, created_at DESC);

ALTER TABLE public.erp_sync_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_sync_field_clock ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_sync_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_sync_inbox ENABLE ROW LEVEL SECURITY;
-- No policies: only the functions below read and write these tables.
REVOKE ALL ON public.erp_sync_links, public.erp_sync_field_clock, public.erp_sync_runs,
  public.erp_sync_state, public.erp_sync_inbox FROM PUBLIC, anon, authenticated;

-- ─── 2. What is synced ───────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.erp_sync__table(p_entity TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_entity
    WHEN 'customers' THEN 'erp_customers' WHEN 'suppliers' THEN 'erp_suppliers'
    WHEN 'products' THEN 'erp_products' WHEN 'sales_orders' THEN 'erp_sales_orders'
    WHEN 'purchase_orders' THEN 'erp_purchase_orders' WHEN 'invoices' THEN 'erp_invoices'
    WHEN 'payments' THEN 'erp_payments' END;
$$;

-- Master-data columns kept in step (stock is its own kind: current_stock).
CREATE OR REPLACE FUNCTION public.erp_sync__fields(p_entity TEXT)
RETURNS TEXT[] LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_entity
    WHEN 'customers' THEN ARRAY['name', 'email', 'phone', 'address', 'city']
    WHEN 'suppliers' THEN ARRAY['name', 'email', 'phone', 'address', 'city']
    WHEN 'products' THEN ARRAY['name', 'sku', 'category', 'purchase_price', 'selling_price', 'min_stock', 'max_stock']
  END;
$$;

-- Business key (row alias t), used to pair rows the first time.
CREATE OR REPLACE FUNCTION public.erp_sync__key_sql(p_entity TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN p_entity IN ('customers', 'suppliers') THEN
      $k$CASE WHEN btrim(t.email) <> '' THEN 'e:' || lower(btrim(t.email)) ELSE 'n:' || lower(btrim(t.name)) END$k$
    WHEN p_entity = 'products' THEN
      $k$CASE WHEN btrim(t.sku) <> '' THEN 's:' || lower(btrim(t.sku)) ELSE 'n:' || lower(btrim(t.name)) END$k$
  END;
$$;

REVOKE ALL ON FUNCTION public.erp_sync__table(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_sync__fields(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_sync__key_sql(TEXT) FROM PUBLIC, anon, authenticated;

-- ─── 3. Change times per column ──────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.erp_sync__clock()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f TEXT;
  n JSONB;
  o JSONB;
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM public.erp_sync_field_clock c WHERE c.row_id = OLD.id;
    DELETE FROM public.erp_sync_links l WHERE l.row_a = OLD.id OR l.row_b = OLD.id;
    RETURN NULL;
  END IF;
  -- A sync writes the time of the change it copies itself.
  IF current_setting('erp.sync_apply', true) = 'on' THEN RETURN NULL; END IF;
  n := to_jsonb(NEW);
  o := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END;
  FOREACH f IN ARRAY public.erp_sync__fields(TG_ARGV[0])
    || CASE WHEN TG_ARGV[0] = 'products' THEN ARRAY['current_stock'] ELSE ARRAY[]::TEXT[] END
  LOOP
    IF TG_OP = 'INSERT' OR n -> f IS DISTINCT FROM o -> f THEN
      INSERT INTO public.erp_sync_field_clock (row_id, field, changed_at) VALUES (NEW.id, f, now())
      ON CONFLICT (row_id, field) DO UPDATE SET changed_at = EXCLUDED.changed_at;
    END IF;
  END LOOP;
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_sync__clock() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_erp_sync_clock ON public.erp_customers;
CREATE TRIGGER trg_erp_sync_clock AFTER INSERT OR UPDATE OR DELETE ON public.erp_customers
  FOR EACH ROW EXECUTE FUNCTION public.erp_sync__clock('customers');
DROP TRIGGER IF EXISTS trg_erp_sync_clock ON public.erp_suppliers;
CREATE TRIGGER trg_erp_sync_clock AFTER INSERT OR UPDATE OR DELETE ON public.erp_suppliers
  FOR EACH ROW EXECUTE FUNCTION public.erp_sync__clock('suppliers');
DROP TRIGGER IF EXISTS trg_erp_sync_clock ON public.erp_products;
CREATE TRIGGER trg_erp_sync_clock AFTER INSERT OR UPDATE OR DELETE ON public.erp_products
  FOR EACH ROW EXECUTE FUNCTION public.erp_sync__clock('products');

-- Existing rows: every column as of the row's last update.
INSERT INTO public.erp_sync_field_clock (row_id, field, changed_at)
SELECT t.id, f, COALESCE(t.updated_at, t.created_at, now())
FROM public.erp_customers t CROSS JOIN unnest(public.erp_sync__fields('customers')) f
ON CONFLICT DO NOTHING;
INSERT INTO public.erp_sync_field_clock (row_id, field, changed_at)
SELECT t.id, f, COALESCE(t.updated_at, t.created_at, now())
FROM public.erp_suppliers t CROSS JOIN unnest(public.erp_sync__fields('suppliers')) f
ON CONFLICT DO NOTHING;
INSERT INTO public.erp_sync_field_clock (row_id, field, changed_at)
SELECT t.id, f, COALESCE(t.updated_at, t.created_at, now())
FROM public.erp_products t CROSS JOIN unnest(public.erp_sync__fields('products') || ARRAY['current_stock']) f
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.erp_sync__clock_at(p_row UUID, p_field TEXT)
RETURNS TIMESTAMPTZ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE((SELECT c.changed_at FROM public.erp_sync_field_clock c WHERE c.row_id = p_row AND c.field = p_field),
                  '-infinity'::TIMESTAMPTZ);
$$;

CREATE OR REPLACE FUNCTION public.erp_sync__set_clock(p_row UUID, p_field TEXT, p_at TIMESTAMPTZ)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  INSERT INTO public.erp_sync_field_clock (row_id, field, changed_at) VALUES (p_row, p_field, p_at)
  ON CONFLICT (row_id, field) DO UPDATE SET changed_at = EXCLUDED.changed_at;
$$;
REVOKE ALL ON FUNCTION public.erp_sync__clock_at(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_sync__set_clock(UUID, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

-- ─── 4. Links ────────────────────────────────────────────────────────────────

-- The row in p_to that is the same record as p_row in p_from (stale links,
-- whose row is gone, are dropped).
CREATE OR REPLACE FUNCTION public.erp_sync__linked(p_entity TEXT, p_from UUID, p_row UUID, p_to UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_link UUID;
  v_other UUID;
  v_exists BOOLEAN;
BEGIN
  IF p_row IS NULL THEN RETURN NULL; END IF;
  SELECT l.id, CASE WHEN l.ws_a = p_from THEN l.row_b ELSE l.row_a END INTO v_link, v_other
  FROM public.erp_sync_links l
  WHERE l.entity = p_entity
    AND ((l.ws_a = p_from AND l.row_a = p_row AND l.ws_b = p_to) OR (l.ws_b = p_from AND l.row_b = p_row AND l.ws_a = p_to));
  IF v_link IS NULL THEN RETURN NULL; END IF;
  EXECUTE format('SELECT EXISTS (SELECT 1 FROM public.%I t WHERE t.id = $1 AND t.workspace_id = $2)', public.erp_sync__table(p_entity))
    INTO v_exists USING v_other, p_to;
  IF NOT v_exists THEN
    DELETE FROM public.erp_sync_links l WHERE l.id = v_link;
    RETURN NULL;
  END IF;
  RETURN v_other;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_sync__link(p_entity TEXT, p_ws1 UUID, p_row1 UUID, p_ws2 UUID, p_row2 UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO public.erp_sync_links (entity, ws_a, row_a, ws_b, row_b)
  SELECT p_entity,
         CASE WHEN p_ws1 < p_ws2 THEN p_ws1 ELSE p_ws2 END, CASE WHEN p_ws1 < p_ws2 THEN p_row1 ELSE p_row2 END,
         CASE WHEN p_ws1 < p_ws2 THEN p_ws2 ELSE p_ws1 END, CASE WHEN p_ws1 < p_ws2 THEN p_row2 ELSE p_row1 END
  WHERE EXISTS (SELECT 1 FROM public.erp_workspaces w WHERE w.id = p_ws1)
    AND EXISTS (SELECT 1 FROM public.erp_workspaces w WHERE w.id = p_ws2)
  ON CONFLICT DO NOTHING;
$$;

-- The master-data row in p_to for p_row in p_from: its link, or (first time)
-- an unpaired row with the same business key, which is then linked.
CREATE OR REPLACE FUNCTION public.erp_sync__match(p_entity TEXT, p_from UUID, p_row UUID, p_to UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tbl TEXT := public.erp_sync__table(p_entity);
  v_key TEXT;
  v_found UUID;
BEGIN
  IF p_row IS NULL THEN RETURN NULL; END IF;
  v_found := public.erp_sync__linked(p_entity, p_from, p_row, p_to);
  IF v_found IS NOT NULL OR p_entity NOT IN ('customers', 'suppliers', 'products') THEN RETURN v_found; END IF;
  EXECUTE format('SELECT %s FROM public.%I t WHERE t.id = $1 AND t.workspace_id = $2', public.erp_sync__key_sql(p_entity), tbl)
    INTO v_key USING p_row, p_from;
  IF v_key IS NULL THEN RETURN NULL; END IF;
  EXECUTE format(
    'SELECT t.id FROM public.%I t WHERE t.workspace_id = $1 AND %s = $2
       AND NOT EXISTS (SELECT 1 FROM public.erp_sync_links l WHERE l.entity = $3
         AND ((l.ws_a = $1 AND l.row_a = t.id AND l.ws_b = $4) OR (l.ws_b = $1 AND l.row_b = t.id AND l.ws_a = $4)))
     ORDER BY t.created_at, t.id LIMIT 1', tbl, public.erp_sync__key_sql(p_entity))
    INTO v_found USING p_to, v_key, p_entity, p_from;
  IF v_found IS NOT NULL THEN PERFORM public.erp_sync__link(p_entity, p_from, p_row, p_to, v_found); END IF;
  RETURN v_found;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_sync__linked(TEXT, UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_sync__link(TEXT, UUID, UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_sync__match(TEXT, UUID, UUID, UUID) FROM PUBLIC, anon, authenticated;

-- ─── 5. Helpers ──────────────────────────────────────────────────────────────

-- Owner or Admin of the ERP, meeting its two-factor requirement.
CREATE OR REPLACE FUNCTION public.erp_sync__can(p_workspace_id UUID)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(public.erp_workspace_role(p_workspace_id) IN ('owner', 'admin'), false)
     AND public.erp_workspace_mfa_ok(p_workspace_id);
$$;

-- Factor from one ERP's base currency to another's, from the target's stored
-- rates (at most erp_fx__max_age_days old); NULL when there is none.
CREATE OR REPLACE FUNCTION public.erp_sync__price_rate(p_from_owner UUID, p_to_owner UUID)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  base_from TEXT := public.erp_fx__base(p_from_owner);
  base_to TEXT := public.erp_fx__base(p_to_owner);
  v_rate NUMERIC;
BEGIN
  IF base_from = base_to THEN RETURN 1; END IF;
  SELECT f.rate INTO v_rate FROM public.erp_fx__find_rate(p_to_owner, base_from, base_to, CURRENT_DATE) f
  WHERE CURRENT_DATE - f.rate_date <= public.erp_fx__max_age_days();
  RETURN v_rate;
END;
$$;

-- Adds one outcome to a step's counts (at most 50 messages are kept).
CREATE OR REPLACE FUNCTION public.erp_sync__count(p_counts JSONB, p_kind TEXT, p_item TEXT, p_message TEXT)
RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_set(
    CASE WHEN p_message IS NULL OR jsonb_array_length(p_counts -> 'messages') >= 50 THEN p_counts
         ELSE jsonb_set(p_counts, '{messages}', (p_counts -> 'messages')
              || jsonb_build_array(jsonb_build_object('kind', p_kind, 'item', left(COALESCE(p_item, ''), 200),
                                                      'message', left(p_message, 500)))) END,
    ARRAY[p_kind], to_jsonb(COALESCE((p_counts ->> p_kind)::INTEGER, 0) + 1));
$$;

CREATE OR REPLACE FUNCTION public.erp_sync__empty()
RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT '{"ok": 0, "skipped": 0, "failed": 0, "messages": []}'::jsonb;
$$;

-- Two step results added together.
CREATE OR REPLACE FUNCTION public.erp_sync__add(p_a JSONB, p_b JSONB)
RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'ok', (p_a ->> 'ok')::INTEGER + (p_b ->> 'ok')::INTEGER,
    'skipped', (p_a ->> 'skipped')::INTEGER + (p_b ->> 'skipped')::INTEGER,
    'failed', (p_a ->> 'failed')::INTEGER + (p_b ->> 'failed')::INTEGER,
    'messages', (SELECT COALESCE(jsonb_agg(m), '[]'::jsonb) FROM (
       SELECT m FROM jsonb_array_elements((p_a -> 'messages') || (p_b -> 'messages')) m LIMIT 50) x));
$$;

REVOKE ALL ON FUNCTION public.erp_sync__can(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_sync__price_rate(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_sync__count(JSONB, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_sync__empty() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_sync__add(JSONB, JSONB) FROM PUBLIC, anon, authenticated;

-- ─── 6. Master data ──────────────────────────────────────────────────────────

-- Customers, suppliers or products between ERP a (source) and b (target).
-- p_ab: changes may go a → b; p_ba: b → a.
CREATE OR REPLACE FUNCTION public.erp_sync__master(p_entity TEXT, p_a UUID, p_b UUID, p_ab BOOLEAN, p_ba BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tbl TEXT := public.erp_sync__table(p_entity);
  fields TEXT[] := public.erp_sync__fields(p_entity);
  prices TEXT[] := CASE WHEN p_entity = 'products' THEN ARRAY['purchase_price', 'selling_price'] ELSE ARRAY[]::TEXT[] END;
  owner_a UUID;
  owner_b UUID;
  rate_ab NUMERIC;
  rate_ba NUMERIC;
  counts JSONB := public.erp_sync__empty();
  rec RECORD;
  rb JSONB;
  v_b UUID;
  f TEXT;
  va JSONB;
  vb JSONB;
  ta TIMESTAMPTZ;
  tb TIMESTAMPTZ;
  patch_a JSONB;
  patch_b JSONB;
  clocks_a JSONB;
  clocks_b JSONB;
  no_rate BOOLEAN;
  label TEXT;
BEGIN
  SELECT w.owner_id INTO owner_a FROM public.erp_workspaces w WHERE w.id = p_a;
  SELECT w.owner_id INTO owner_b FROM public.erp_workspaces w WHERE w.id = p_b;
  IF p_entity = 'products' THEN
    rate_ab := public.erp_sync__price_rate(owner_a, owner_b);
    rate_ba := public.erp_sync__price_rate(owner_b, owner_a);
  END IF;
  PERFORM set_config('erp.sync_apply', 'on', true);

  -- Rows of a: pair, create in b, or bring the pair in step.
  FOR rec IN EXECUTE format('SELECT t.id, to_jsonb(t) AS j FROM public.%I t WHERE t.workspace_id = $1 ORDER BY t.created_at, t.id', tbl)
    USING p_a
  LOOP
    label := rec.j ->> 'name';
    BEGIN
      v_b := public.erp_sync__match(p_entity, p_a, rec.id, p_b);
      IF v_b IS NULL THEN
        IF NOT p_ab THEN CONTINUE; END IF;
        IF p_entity = 'products' AND rate_ab IS NULL THEN
          counts := public.erp_sync__count(counts, 'skipped', label, 'No exchange rate for the prices');
          CONTINUE;
        END IF;
        v_b := public.erp_sync__insert(p_entity, rec.j, p_b, owner_b, rate_ab);
        PERFORM public.erp_sync__link(p_entity, p_a, rec.id, p_b, v_b);
        counts := public.erp_sync__count(counts, 'ok', label, NULL);
        CONTINUE;
      END IF;

      EXECUTE format('SELECT to_jsonb(t) FROM public.%I t WHERE t.id = $1', tbl) INTO rb USING v_b;
      patch_a := '{}'; patch_b := '{}'; clocks_a := '{}'; clocks_b := '{}'; no_rate := false;
      FOREACH f IN ARRAY fields LOOP
        va := rec.j -> f;
        vb := rb -> f;
        ta := public.erp_sync__clock_at(rec.id, f);
        tb := public.erp_sync__clock_at(v_b, f);
        IF f = ANY(prices) THEN
          -- Compare in b's currency; a missing rate leaves prices as they are.
          IF rate_ab IS NULL OR rate_ba IS NULL THEN
            IF (ta >= tb AND p_ab) OR (tb > ta AND p_ba) THEN no_rate := true; END IF;
            CONTINUE;
          END IF;
          IF to_jsonb(round((va #>> '{}')::NUMERIC * rate_ab, 2)) = vb THEN CONTINUE; END IF;
          IF ta >= tb AND p_ab THEN
            patch_b := patch_b || jsonb_build_object(f, round((va #>> '{}')::NUMERIC * rate_ab, 2));
            clocks_b := clocks_b || jsonb_build_object(f, ta);
          ELSIF tb > ta AND p_ba THEN
            patch_a := patch_a || jsonb_build_object(f, round((vb #>> '{}')::NUMERIC * rate_ba, 2));
            clocks_a := clocks_a || jsonb_build_object(f, tb);
          END IF;
          CONTINUE;
        END IF;
        IF va = vb THEN CONTINUE; END IF;
        -- Newest change wins; on a tie the source wins.
        IF ta >= tb AND p_ab THEN
          patch_b := patch_b || jsonb_build_object(f, va);
          clocks_b := clocks_b || jsonb_build_object(f, ta);
        ELSIF tb > ta AND p_ba THEN
          patch_a := patch_a || jsonb_build_object(f, vb);
          clocks_a := clocks_a || jsonb_build_object(f, tb);
        END IF;
      END LOOP;

      IF patch_a = '{}' AND patch_b = '{}' THEN
        counts := public.erp_sync__count(counts, 'skipped', label,
          CASE WHEN no_rate THEN 'No exchange rate for the prices' END);
        CONTINUE;
      END IF;
      IF patch_b <> '{}' THEN PERFORM public.erp_sync__apply(p_entity, v_b, patch_b, clocks_b); END IF;
      IF patch_a <> '{}' THEN PERFORM public.erp_sync__apply(p_entity, rec.id, patch_a, clocks_a); END IF;
      counts := public.erp_sync__count(counts, 'ok', label,
        CASE WHEN no_rate THEN 'Prices not synced: no exchange rate' END);
    EXCEPTION WHEN OTHERS THEN
      counts := public.erp_sync__count(counts, 'failed', label, SQLERRM);
    END;
  END LOOP;

  -- Rows only in b come to a.
  IF p_ba THEN
    FOR rec IN EXECUTE format(
      'SELECT t.id, to_jsonb(t) AS j FROM public.%I t WHERE t.workspace_id = $1
         AND NOT EXISTS (SELECT 1 FROM public.erp_sync_links l WHERE l.entity = $2
           AND ((l.ws_a = $1 AND l.row_a = t.id AND l.ws_b = $3) OR (l.ws_b = $1 AND l.row_b = t.id AND l.ws_a = $3)))
       ORDER BY t.created_at, t.id', tbl)
      USING p_b, p_entity, p_a
    LOOP
      label := rec.j ->> 'name';
      BEGIN
        IF p_entity = 'products' AND rate_ba IS NULL THEN
          counts := public.erp_sync__count(counts, 'skipped', label, 'No exchange rate for the prices');
          CONTINUE;
        END IF;
        v_b := public.erp_sync__match(p_entity, p_b, rec.id, p_a);
        IF v_b IS NULL THEN
          v_b := public.erp_sync__insert(p_entity, rec.j, p_a, owner_a, rate_ba);
          PERFORM public.erp_sync__link(p_entity, p_b, rec.id, p_a, v_b);
          counts := public.erp_sync__count(counts, 'ok', label, NULL);
        ELSE
          counts := public.erp_sync__count(counts, 'skipped', label, NULL);
        END IF;
      EXCEPTION WHEN OTHERS THEN
        counts := public.erp_sync__count(counts, 'failed', label, SQLERRM);
      END;
    END LOOP;
  END IF;

  PERFORM set_config('erp.sync_apply', 'off', true);
  RETURN counts;
END;
$$;

-- A copy of a master-data row in another ERP, keeping the source's change times.
CREATE OR REPLACE FUNCTION public.erp_sync__insert(p_entity TEXT, p_row JSONB, p_ws UUID, p_owner UUID, p_rate NUMERIC)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tbl TEXT := public.erp_sync__table(p_entity);
  fields TEXT[] := public.erp_sync__fields(p_entity);
  data JSONB := p_row;
  f TEXT;
  new_id UUID;
BEGIN
  IF p_entity = 'products' THEN
    data := data || jsonb_build_object(
      'purchase_price', round((p_row ->> 'purchase_price')::NUMERIC * p_rate, 2),
      'selling_price', round((p_row ->> 'selling_price')::NUMERIC * p_rate, 2));
  END IF;
  EXECUTE format('INSERT INTO public.%I (user_id, workspace_id, %s) SELECT $2, $3, %s FROM jsonb_populate_record(NULL::public.%I, $1) r RETURNING id',
    tbl,
    (SELECT string_agg(quote_ident(x), ', ') FROM unnest(fields) x),
    (SELECT string_agg('r.' || quote_ident(x), ', ') FROM unnest(fields) x),
    tbl)
    INTO new_id USING data, p_owner, p_ws;
  FOREACH f IN ARRAY fields LOOP
    PERFORM public.erp_sync__set_clock(new_id, f, public.erp_sync__clock_at((p_row ->> 'id')::UUID, f));
  END LOOP;
  RETURN new_id;
END;
$$;

-- Writes the changed columns of one row and the times of the changes copied.
CREATE OR REPLACE FUNCTION public.erp_sync__apply(p_entity TEXT, p_id UUID, p_patch JSONB, p_clocks JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  tbl TEXT := public.erp_sync__table(p_entity);
  f TEXT;
BEGIN
  EXECUTE format('UPDATE public.%I t SET %s FROM jsonb_populate_record(NULL::public.%I, $1) r WHERE t.id = $2',
    tbl,
    (SELECT string_agg(format('%I = r.%I', k, k), ', ') FROM jsonb_object_keys(p_patch) k),
    tbl)
    USING p_patch, p_id;
  FOR f IN SELECT jsonb_object_keys(p_clocks) LOOP
    PERFORM public.erp_sync__set_clock(p_id, f, (p_clocks ->> f)::TIMESTAMPTZ);
  END LOOP;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_sync__master(TEXT, UUID, UUID, BOOLEAN, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_sync__insert(TEXT, JSONB, UUID, UUID, NUMERIC) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_sync__apply(TEXT, UUID, JSONB, JSONB) FROM PUBLIC, anon, authenticated;

-- ─── 7. Stock ────────────────────────────────────────────────────────────────

-- Stock levels of paired products: the most recently changed level wins and
-- the other side gets a stock adjustment (movement and journal as usual).
-- Products not in the other ERP are skipped (sync products first).
CREATE OR REPLACE FUNCTION public.erp_sync__stock(p_a UUID, p_b UUID, p_ab BOOLEAN, p_ba BOOLEAN)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  counts JSONB := public.erp_sync__empty();
  name_a TEXT;
  name_b TEXT;
  pa public.erp_products%ROWTYPE;
  pb public.erp_products%ROWTYPE;
  v_b UUID;
  ta TIMESTAMPTZ;
  tb TIMESTAMPTZ;
BEGIN
  SELECT w.name INTO name_a FROM public.erp_workspaces w WHERE w.id = p_a;
  SELECT w.name INTO name_b FROM public.erp_workspaces w WHERE w.id = p_b;
  PERFORM set_config('erp.sync_apply', 'on', true);
  FOR pa IN SELECT * FROM public.erp_products p WHERE p.workspace_id = p_a ORDER BY p.created_at, p.id LOOP
    BEGIN
      v_b := public.erp_sync__match('products', p_a, pa.id, p_b);
      IF v_b IS NULL THEN
        IF p_ab THEN
          counts := public.erp_sync__count(counts, 'skipped', pa.name, 'Product is not in the other ERP; sync products first');
        END IF;
        CONTINUE;
      END IF;
      SELECT * INTO pb FROM public.erp_products p WHERE p.id = v_b FOR UPDATE;
      SELECT * INTO pa FROM public.erp_products p WHERE p.id = pa.id FOR UPDATE;
      IF pa.current_stock = pb.current_stock THEN
        counts := public.erp_sync__count(counts, 'skipped', pa.name, NULL);
        CONTINUE;
      END IF;
      ta := public.erp_sync__clock_at(pa.id, 'current_stock');
      tb := public.erp_sync__clock_at(pb.id, 'current_stock');
      IF ta >= tb AND p_ab THEN
        PERFORM public.erp_sync__set_stock(pb, pa.current_stock, name_a, ta);
        counts := public.erp_sync__count(counts, 'ok', pa.name, NULL);
      ELSIF tb > ta AND p_ba THEN
        PERFORM public.erp_sync__set_stock(pa, pb.current_stock, name_b, tb);
        counts := public.erp_sync__count(counts, 'ok', pa.name, NULL);
      ELSE
        counts := public.erp_sync__count(counts, 'skipped', pa.name, 'The other ERP changed this stock more recently');
      END IF;
    EXCEPTION WHEN OTHERS THEN
      counts := public.erp_sync__count(counts, 'failed', pa.name, SQLERRM);
    END;
  END LOOP;
  PERFORM set_config('erp.sync_apply', 'off', true);
  RETURN counts;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_sync__set_stock(p public.erp_products, p_level INTEGER, p_from_name TEXT, p_at TIMESTAMPTZ)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE delta INTEGER := p_level - p.current_stock;
BEGIN
  PERFORM public.erp__change_stock(p.id, delta);
  INSERT INTO public.erp_stock_movements
    (user_id, product_id, product_name, movement_type, quantity, movement_date, note, source_type, created_by)
  VALUES
    (p.user_id, p.id, p.name, CASE WHEN delta > 0 THEN 'in'::public.stock_movement_type ELSE 'out'::public.stock_movement_type END,
     abs(delta), CURRENT_DATE, left('Stock synced from ' || COALESCE(p_from_name, 'another ERP'), 500), 'manual_adjustment', auth.uid());
  PERFORM public.erp_sync__set_clock(p.id, 'current_stock', p_at);
END;
$$;

REVOKE ALL ON FUNCTION public.erp_sync__stock(UUID, UUID, BOOLEAN, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_sync__set_stock(public.erp_products, INTEGER, TEXT, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;

-- ─── 8. Orders, invoices and payments ────────────────────────────────────────

-- Documents of p_from since p_since that are not in p_to yet: orders are
-- created there (draft / pending), invoices and payments go to its inbox.
-- Each document is copied once; copies are never copied back.
CREATE OR REPLACE FUNCTION public.erp_sync__docs(p_entity TEXT, p_from UUID, p_to UUID, p_since DATE)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  counts JSONB := public.erp_sync__empty();
  owner_from UUID;
  name_from TEXT;
  base_from TEXT;
  doc RECORD;
  item RECORD;
  items JSONB;
  v_party UUID;
  v_product UUID;
  new_id UUID;
  label TEXT;
  hint TEXT;
BEGIN
  SELECT w.owner_id, w.name INTO owner_from, name_from FROM public.erp_workspaces w WHERE w.id = p_from;
  base_from := public.erp_fx__base(owner_from);

  IF p_entity = 'sales_orders' THEN
    FOR doc IN SELECT * FROM public.erp_sales_orders s
      WHERE s.workspace_id = p_from AND s.order_date >= p_since AND s.status <> 'cancelled'
        AND public.erp_sync__linked('sales_orders', p_from, s.id, p_to) IS NULL
      ORDER BY s.order_date, s.created_at, s.id
    LOOP
      label := doc.customer_name || ' · ' || doc.order_date;
      BEGIN
        v_party := public.erp_sync__match('customers', p_from, doc.customer_id, p_to);
        IF doc.customer_id IS NOT NULL AND v_party IS NULL THEN
          RAISE EXCEPTION 'Customer % is not in this ERP; sync customers first', doc.customer_name USING HINT = 'sync_skip';
        END IF;
        items := '[]';
        FOR item IN SELECT * FROM public.erp_sales_order_items i WHERE i.sales_order_id = doc.id ORDER BY i.id LOOP
          v_product := public.erp_sync__match('products', p_from, item.product_id, p_to);
          IF item.product_id IS NOT NULL AND v_product IS NULL THEN
            RAISE EXCEPTION 'Product % is not in this ERP; sync products first', item.product_name USING HINT = 'sync_skip';
          END IF;
          items := items || jsonb_build_array(jsonb_build_object(
            'product_id', v_product, 'product_name', item.product_name, 'qty', item.qty, 'price', item.price));
        END LOOP;
        new_id := public.erp_create_sales_order_v3(p_to, v_party, doc.customer_name, doc.order_date,
          left(btrim(doc.notes || E'\nSynced from ' || name_from), 2000), items, COALESCE(doc.currency, base_from), NULL);
        PERFORM public.erp_sync__link('sales_orders', p_from, doc.id, p_to, new_id);
        counts := public.erp_sync__count(counts, 'ok', label, NULL);
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS hint = PG_EXCEPTION_HINT;
        counts := public.erp_sync__count(counts,
          CASE WHEN hint IN ('sync_skip', 'fx_missing', 'fx_stale') THEN 'skipped' ELSE 'failed' END, label, SQLERRM);
      END;
    END LOOP;

  ELSIF p_entity = 'purchase_orders' THEN
    FOR doc IN SELECT * FROM public.erp_purchase_orders po
      WHERE po.workspace_id = p_from AND po.order_date >= p_since AND po.status <> 'cancelled'
        AND public.erp_sync__linked('purchase_orders', p_from, po.id, p_to) IS NULL
      ORDER BY po.order_date, po.created_at, po.id
    LOOP
      label := doc.supplier_name || ' · ' || doc.order_date;
      BEGIN
        v_party := public.erp_sync__match('suppliers', p_from, doc.supplier_id, p_to);
        IF doc.supplier_id IS NOT NULL AND v_party IS NULL THEN
          RAISE EXCEPTION 'Supplier % is not in this ERP; sync suppliers first', doc.supplier_name USING HINT = 'sync_skip';
        END IF;
        items := '[]';
        FOR item IN SELECT * FROM public.erp_purchase_order_items i WHERE i.purchase_order_id = doc.id ORDER BY i.id LOOP
          v_product := public.erp_sync__match('products', p_from, item.product_id, p_to);
          IF item.product_id IS NOT NULL AND v_product IS NULL THEN
            RAISE EXCEPTION 'Product % is not in this ERP; sync products first', item.product_name USING HINT = 'sync_skip';
          END IF;
          items := items || jsonb_build_array(jsonb_build_object(
            'product_id', v_product, 'product_name', item.product_name, 'qty', item.qty, 'price', item.price));
        END LOOP;
        new_id := public.erp_create_purchase_order_v3(p_to, v_party, doc.supplier_name, doc.order_date,
          left(btrim(doc.notes || E'\nSynced from ' || name_from), 2000), items, COALESCE(doc.currency, base_from), NULL);
        PERFORM public.erp_sync__link('purchase_orders', p_from, doc.id, p_to, new_id);
        counts := public.erp_sync__count(counts, 'ok', label, NULL);
      EXCEPTION WHEN OTHERS THEN
        GET STACKED DIAGNOSTICS hint = PG_EXCEPTION_HINT;
        counts := public.erp_sync__count(counts,
          CASE WHEN hint IN ('sync_skip', 'fx_missing', 'fx_stale') THEN 'skipped' ELSE 'failed' END, label, SQLERRM);
      END;
    END LOOP;

  ELSIF p_entity = 'invoices' THEN
    FOR doc IN SELECT * FROM public.erp_invoices inv
      WHERE inv.workspace_id = p_from AND inv.invoice_date >= p_since AND inv.voided_at IS NULL
        AND public.erp_sync__linked('invoices', p_from, inv.id, p_to) IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.erp_sync_inbox x WHERE x.workspace_id = p_to AND x.kind = 'invoice' AND x.source_id = inv.id)
      ORDER BY inv.invoice_date, inv.created_at, inv.id
    LOOP
      INSERT INTO public.erp_sync_inbox (workspace_id, source_ws, source_name, kind, source_id, payload)
      VALUES (p_to, p_from, name_from, 'invoice', doc.id, jsonb_build_object(
        'customer_id', doc.customer_id, 'customer_name', doc.customer_name,
        'invoice_date', doc.invoice_date, 'due_date', doc.due_date,
        'subtotal', doc.total - doc.tax_amount, 'tax_rate', doc.tax_rate, 'total', doc.total,
        'currency', COALESCE(doc.currency, base_from)));
      counts := public.erp_sync__count(counts, 'ok', doc.customer_name || ' · ' || doc.invoice_date, NULL);
    END LOOP;

  ELSIF p_entity = 'payments' THEN
    FOR doc IN SELECT * FROM public.erp_payments pay
      WHERE pay.workspace_id = p_from AND pay.payment_date >= p_since AND pay.voided_at IS NULL
        AND public.erp_sync__linked('payments', p_from, pay.id, p_to) IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.erp_sync_inbox x WHERE x.workspace_id = p_to AND x.kind = 'payment' AND x.source_id = pay.id)
      ORDER BY pay.payment_date, pay.created_at, pay.id
    LOOP
      INSERT INTO public.erp_sync_inbox (workspace_id, source_ws, source_name, kind, source_id, payload)
      VALUES (p_to, p_from, name_from, 'payment', doc.id, jsonb_build_object(
        'payment_type', doc.payment_type, 'party', doc.party, 'amount', doc.amount,
        'payment_date', doc.payment_date, 'method', doc.method, 'note', doc.note,
        'invoice_id', doc.invoice_id, 'purchase_order_id', doc.purchase_order_id,
        'currency', COALESCE(doc.currency, base_from)));
      counts := public.erp_sync__count(counts, 'ok', doc.party || ' · ' || doc.payment_date, NULL);
    END LOOP;
  END IF;
  RETURN counts;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_sync__docs(TEXT, UUID, UUID, DATE) FROM PUBLIC, anon, authenticated;

-- ─── 9. Runs ─────────────────────────────────────────────────────────────────

-- Starts a sync. The client then calls erp_sync_step for each target and kind
-- (in the order of erp_sync_start's result) and erp_sync_finish at the end.
CREATE OR REPLACE FUNCTION public.erp_sync_start(
  p_source UUID, p_targets UUID[], p_direction TEXT, p_entities TEXT[], p_since DATE
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  all_kinds CONSTANT TEXT[] := ARRAY['customers', 'suppliers', 'products', 'stock',
                                     'sales_orders', 'purchase_orders', 'invoices', 'payments'];
  kinds TEXT[];
  targets UUID[];
  ws UUID;
  w public.erp_workspaces%ROWTYPE;
  run_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  IF p_direction IS NULL OR p_direction NOT IN ('push', 'pull', 'both') THEN
    RAISE EXCEPTION 'Choose push, pull or both' USING ERRCODE = '22023';
  END IF;
  -- Known kinds, in dependency order (master data before documents).
  SELECT array_agg(k ORDER BY array_position(all_kinds, k)) INTO kinds
  FROM (SELECT DISTINCT unnest(p_entities) k) x WHERE k = ANY(all_kinds);
  IF kinds IS NULL OR cardinality(kinds) <> (SELECT count(DISTINCT e) FROM unnest(p_entities) e) THEN
    RAISE EXCEPTION 'Choose what to sync' USING ERRCODE = 'P0001', HINT = 'entities';
  END IF;
  SELECT array_agg(DISTINCT t) INTO targets FROM unnest(p_targets) t WHERE t IS NOT NULL AND t IS DISTINCT FROM p_source;
  IF targets IS NULL OR cardinality(targets) = 0 THEN
    RAISE EXCEPTION 'Choose at least one other ERP' USING ERRCODE = 'P0001', HINT = 'targets';
  END IF;

  FOREACH ws IN ARRAY p_source || targets LOOP
    SELECT * INTO w FROM public.erp_workspaces x WHERE x.id = ws;
    IF NOT FOUND OR NOT public.erp_sync__can(ws) THEN
      RAISE EXCEPTION 'Only an owner or admin of every ERP in a sync can run it' USING ERRCODE = '42501';
    END IF;
    IF NOT w.sync_enabled THEN
      RAISE EXCEPTION 'ERP % is not included in sync', w.name USING ERRCODE = 'P0001', HINT = 'disabled';
    END IF;
  END LOOP;

  -- Runs that never finished (closed browser) are closed after an hour.
  UPDATE public.erp_sync_runs r SET status = 'failed', finished_at = now()
  WHERE r.status = 'running' AND r.started_at < now() - interval '1 hour';

  INSERT INTO public.erp_sync_runs (source_ws, targets, direction, entities, since, started_by)
  VALUES (p_source, targets, p_direction, kinds,
          CASE WHEN kinds && ARRAY['sales_orders', 'purchase_orders', 'invoices', 'payments']
               THEN COALESCE(p_since, CURRENT_DATE - 30) END,
          auth.uid())
  RETURNING id INTO run_id;
  RETURN run_id;
END;
$$;

-- One target and one kind of data, in its own transaction.
CREATE OR REPLACE FUNCTION public.erp_sync_step(p_run_id UUID, p_target UUID, p_entity TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  run public.erp_sync_runs%ROWTYPE;
  ab BOOLEAN;
  ba BOOLEAN;
  counts JSONB;
  v_status TEXT;
BEGIN
  SELECT * INTO run FROM public.erp_sync_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND OR run.started_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Sync not found' USING ERRCODE = 'P0002';
  END IF;
  IF run.status <> 'running' THEN RAISE EXCEPTION 'This sync has finished' USING ERRCODE = 'P0001'; END IF;
  IF NOT p_target = ANY(run.targets) OR NOT p_entity = ANY(run.entities) THEN
    RAISE EXCEPTION 'Not part of this sync' USING ERRCODE = '22023';
  END IF;
  IF NOT public.erp_sync__can(run.source_ws) OR NOT public.erp_sync__can(p_target) THEN
    RAISE EXCEPTION 'Only an owner or admin of every ERP in a sync can run it' USING ERRCODE = '42501';
  END IF;
  IF NOT (SELECT bool_and(w.sync_enabled) FROM public.erp_workspaces w WHERE w.id IN (run.source_ws, p_target)) THEN
    RAISE EXCEPTION 'An ERP in this sync is no longer included in sync' USING ERRCODE = 'P0001', HINT = 'disabled';
  END IF;
  -- One sync at a time per pair of ERPs.
  PERFORM pg_advisory_xact_lock(hashtext('erp_sync:' || LEAST(run.source_ws, p_target)::TEXT || GREATEST(run.source_ws, p_target)::TEXT));

  ab := run.direction IN ('push', 'both');
  ba := run.direction IN ('pull', 'both');
  IF p_entity IN ('customers', 'suppliers', 'products') THEN
    counts := public.erp_sync__master(p_entity, run.source_ws, p_target, ab, ba);
  ELSIF p_entity = 'stock' THEN
    counts := public.erp_sync__stock(run.source_ws, p_target, ab, ba);
  ELSE
    counts := public.erp_sync__empty();
    IF ab THEN counts := public.erp_sync__docs(p_entity, run.source_ws, p_target, run.since); END IF;
    IF ba THEN counts := public.erp_sync__add(counts, public.erp_sync__docs(p_entity, p_target, run.source_ws, run.since)); END IF;
  END IF;

  UPDATE public.erp_sync_runs r
  SET result = jsonb_set(CASE WHEN r.result ? p_target::TEXT THEN r.result
                              ELSE r.result || jsonb_build_object(p_target::TEXT, '{}'::jsonb) END,
                         ARRAY[p_target::TEXT, p_entity], counts)
  WHERE r.id = run.id;

  v_status := CASE WHEN (counts ->> 'failed')::INTEGER = 0 THEN 'success'
                   WHEN (counts ->> 'ok')::INTEGER > 0 THEN 'partial' ELSE 'failed' END;
  IF ab THEN
    INSERT INTO public.erp_sync_state (source_ws, target_ws, entity, last_sync_at, last_status, last_counts, last_run_id)
    VALUES (run.source_ws, p_target, p_entity, now(), v_status, counts - 'messages', run.id)
    ON CONFLICT (source_ws, target_ws, entity) DO UPDATE
    SET last_sync_at = EXCLUDED.last_sync_at, last_status = EXCLUDED.last_status,
        last_counts = EXCLUDED.last_counts, last_run_id = EXCLUDED.last_run_id;
  END IF;
  IF ba THEN
    INSERT INTO public.erp_sync_state (source_ws, target_ws, entity, last_sync_at, last_status, last_counts, last_run_id)
    VALUES (p_target, run.source_ws, p_entity, now(), v_status, counts - 'messages', run.id)
    ON CONFLICT (source_ws, target_ws, entity) DO UPDATE
    SET last_sync_at = EXCLUDED.last_sync_at, last_status = EXCLUDED.last_status,
        last_counts = EXCLUDED.last_counts, last_run_id = EXCLUDED.last_run_id;
  END IF;
  RETURN counts;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_sync_finish(p_run_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  run public.erp_sync_runs%ROWTYPE;
  totals JSONB;
  v_status TEXT;
  ws UUID;
BEGIN
  SELECT * INTO run FROM public.erp_sync_runs r WHERE r.id = p_run_id FOR UPDATE;
  IF NOT FOUND OR run.started_by IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Sync not found' USING ERRCODE = 'P0002';
  END IF;
  IF run.status <> 'running' THEN RETURN jsonb_build_object('status', run.status); END IF;
  SELECT jsonb_build_object(
           'ok', COALESCE(sum((s.value ->> 'ok')::INTEGER), 0),
           'skipped', COALESCE(sum((s.value ->> 'skipped')::INTEGER), 0),
           'failed', COALESCE(sum((s.value ->> 'failed')::INTEGER), 0))
    INTO totals
  FROM jsonb_each(run.result) t, jsonb_each(t.value) s;
  v_status := CASE WHEN (totals ->> 'failed')::INTEGER = 0 THEN 'success'
                   WHEN (totals ->> 'ok')::INTEGER > 0 THEN 'partial' ELSE 'failed' END;
  UPDATE public.erp_sync_runs r SET status = v_status, finished_at = now() WHERE r.id = run.id;
  FOREACH ws IN ARRAY run.source_ws || run.targets LOOP
    INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
    SELECT ws, auth.uid(), 'sync.run', jsonb_build_object(
      'run_id', run.id, 'source', run.source_ws, 'targets', to_jsonb(run.targets),
      'direction', run.direction, 'entities', to_jsonb(run.entities), 'status', v_status, 'totals', totals)
    WHERE EXISTS (SELECT 1 FROM public.erp_workspaces w WHERE w.id = ws);
  END LOOP;
  RETURN jsonb_build_object('status', v_status, 'totals', totals);
END;
$$;

-- ─── 10. ERPs, pairs and runs for the sync page ─────────────────────────────

CREATE OR REPLACE FUNCTION public.erp_sync_overview()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE mine UUID[];
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  SELECT COALESCE(array_agg(m.workspace_id), '{}') INTO mine
  FROM public.erp_workspace_members m WHERE m.user_id = auth.uid() AND m.status = 'active';
  RETURN jsonb_build_object(
    'erps', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'id', w.id, 'name', w.name, 'role', public.erp_workspace_role(w.id),
        'sync_enabled', w.sync_enabled, 'can_sync', public.erp_sync__can(w.id),
        'base_currency', public.erp_fx__base(w.owner_id),
        'members', (SELECT count(*) FROM public.erp_workspace_members x WHERE x.workspace_id = w.id AND x.status = 'active'),
        'pending_inbox', (SELECT count(*) FROM public.erp_sync_inbox i WHERE i.workspace_id = w.id AND i.status = 'pending'))
        ORDER BY (w.owner_id = auth.uid()) DESC, w.name), '[]'::jsonb)
      FROM public.erp_workspaces w WHERE w.id = ANY(mine)),
    'pairs', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
        'source', s.source_ws, 'target', s.target_ws, 'entity', s.entity, 'last_sync_at', s.last_sync_at,
        'last_status', s.last_status, 'counts', s.last_counts) ORDER BY s.last_sync_at DESC), '[]'::jsonb)
      FROM public.erp_sync_state s WHERE s.source_ws = ANY(mine) AND s.target_ws = ANY(mine)),
    'runs', (SELECT COALESCE(jsonb_agg(x ORDER BY (x ->> 'started_at') DESC), '[]'::jsonb) FROM (
      SELECT jsonb_build_object(
        'id', r.id, 'source', r.source_ws, 'targets', to_jsonb(r.targets), 'direction', r.direction,
        'entities', to_jsonb(r.entities), 'since', r.since, 'status', r.status, 'started_at', r.started_at,
        'finished_at', r.finished_at, 'started_by', p.email, 'result', r.result) AS x
      FROM public.erp_sync_runs r
      LEFT JOIN public.user_profiles p ON p.id = r.started_by
      WHERE r.source_ws = ANY(mine) AND r.targets <@ mine
      ORDER BY r.started_at DESC LIMIT 20) y));
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_sync_set_enabled(p_workspace_id UUID, p_enabled BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE w public.erp_workspaces%ROWTYPE;
BEGIN
  SELECT * INTO w FROM public.erp_workspaces x WHERE x.id = p_workspace_id FOR UPDATE;
  IF NOT FOUND OR NOT public.erp_sync__can(w.id) THEN
    RAISE EXCEPTION 'Only an owner or admin can change this' USING ERRCODE = '42501';
  END IF;
  IF p_enabled IS NULL OR w.sync_enabled = p_enabled THEN RETURN; END IF;
  UPDATE public.erp_workspaces x SET sync_enabled = p_enabled, updated_at = now() WHERE x.id = w.id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (w.id, auth.uid(), CASE WHEN p_enabled THEN 'sync.enabled' ELSE 'sync.disabled' END, '{}'::jsonb);
END;
$$;

-- ─── 11. Sync inbox ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.erp_sync_inbox_list(p_workspace_id UUID)
RETURNS TABLE (
  id UUID, kind TEXT, source_name TEXT, payload JSONB, status TEXT, posted_id UUID,
  decided_by_email TEXT, decided_at TIMESTAMPTZ, note TEXT, created_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (public.erp_has_permission(p_workspace_id, 'invoicing') OR public.erp_has_permission(p_workspace_id, 'payments')) THEN
    RAISE EXCEPTION 'Your workspace role does not allow this action' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT i.id, i.kind, i.source_name, i.payload, i.status, i.posted_id, p.email, i.decided_at, i.note, i.created_at
  FROM public.erp_sync_inbox i
  LEFT JOIN public.user_profiles p ON p.id = i.decided_by
  WHERE i.workspace_id = p_workspace_id
  ORDER BY (i.status = 'pending') DESC, i.created_at DESC
  LIMIT 500;
END;
$$;

-- Posts an inbox item through the usual flows (journal, currency, checks).
-- p_fx_rate: the rate to use for a foreign-currency document; NULL uses the
-- stored rate for its date.
CREATE OR REPLACE FUNCTION public.erp_sync_inbox_post(p_item_id UUID, p_fx_rate NUMERIC)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  item public.erp_sync_inbox%ROWTYPE;
  p JSONB;
  v_owner UUID;
  v_party UUID;
  v_invoice UUID;
  v_order UUID;
  new_id UUID;
BEGIN
  SELECT * INTO item FROM public.erp_sync_inbox i WHERE i.id = p_item_id FOR UPDATE;
  IF NOT FOUND OR public.erp_workspace_role(item.workspace_id) IS NULL THEN
    RAISE EXCEPTION 'Item not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.erp_has_permission(item.workspace_id, CASE WHEN item.kind = 'invoice' THEN 'invoicing' ELSE 'payments' END) THEN
    RAISE EXCEPTION 'Your workspace role does not allow this action' USING ERRCODE = '42501';
  END IF;
  IF item.status <> 'pending' THEN RAISE EXCEPTION 'This item was already handled' USING ERRCODE = 'P0001', HINT = 'handled'; END IF;
  p := item.payload;
  SELECT w.owner_id INTO v_owner FROM public.erp_workspaces w WHERE w.id = item.workspace_id;

  IF item.kind = 'invoice' THEN
    v_party := public.erp_sync__match('customers', item.source_ws, NULLIF(p ->> 'customer_id', '')::UUID, item.workspace_id);
    new_id := public.erp_create_invoice_v5(item.workspace_id, v_party, p ->> 'customer_name',
      (p ->> 'invoice_date')::DATE, (p ->> 'due_date')::DATE, (p ->> 'subtotal')::NUMERIC,
      (p ->> 'tax_rate')::NUMERIC, p ->> 'currency', p_fx_rate);
    PERFORM public.erp_sync__link('invoices', item.source_ws, item.source_id, item.workspace_id, new_id);
  ELSE
    IF p ->> 'invoice_id' IS NOT NULL THEN
      v_invoice := public.erp_sync__linked('invoices', item.source_ws, (p ->> 'invoice_id')::UUID, item.workspace_id);
      IF v_invoice IS NULL THEN
        RAISE EXCEPTION 'Post the invoice of this payment first' USING ERRCODE = 'P0001', HINT = 'invoice_first';
      END IF;
    END IF;
    IF p ->> 'purchase_order_id' IS NOT NULL THEN
      v_order := public.erp_sync__linked('purchase_orders', item.source_ws, (p ->> 'purchase_order_id')::UUID, item.workspace_id);
      IF v_order IS NULL THEN
        RAISE EXCEPTION 'Sync the purchase order of this payment first' USING ERRCODE = 'P0001', HINT = 'order_first';
      END IF;
    END IF;
    INSERT INTO public.erp_payments
      (user_id, workspace_id, created_by, payment_type, party, amount, payment_date, method, note,
       invoice_id, purchase_order_id, currency, fx_rate, fx_rate_source)
    VALUES
      (v_owner, item.workspace_id, auth.uid(), (p ->> 'payment_type')::public.payment_type, p ->> 'party',
       (p ->> 'amount')::NUMERIC, (p ->> 'payment_date')::DATE, COALESCE(p ->> 'method', ''),
       left(btrim(COALESCE(p ->> 'note', '') || E'\nSynced from ' || item.source_name), 2000),
       v_invoice, v_order,
       CASE WHEN v_invoice IS NULL AND v_order IS NULL THEN p ->> 'currency' END,
       COALESCE(p_fx_rate, 1), CASE WHEN p_fx_rate IS NOT NULL THEN 'manual' END)
    RETURNING id INTO new_id;
    PERFORM public.erp_sync__link('payments', item.source_ws, item.source_id, item.workspace_id, new_id);
  END IF;

  UPDATE public.erp_sync_inbox i
  SET status = 'posted', posted_id = new_id, decided_by = auth.uid(), decided_at = now()
  WHERE i.id = item.id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (item.workspace_id, auth.uid(), 'sync.inbox_posted', jsonb_build_object(
    'item_id', item.id, 'kind', item.kind, 'source', item.source_name, 'posted_id', new_id));
  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_sync_inbox_dismiss(p_item_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE item public.erp_sync_inbox%ROWTYPE;
BEGIN
  SELECT * INTO item FROM public.erp_sync_inbox i WHERE i.id = p_item_id FOR UPDATE;
  IF NOT FOUND OR public.erp_workspace_role(item.workspace_id) IS NULL THEN
    RAISE EXCEPTION 'Item not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.erp_has_permission(item.workspace_id, CASE WHEN item.kind = 'invoice' THEN 'invoicing' ELSE 'payments' END) THEN
    RAISE EXCEPTION 'Your workspace role does not allow this action' USING ERRCODE = '42501';
  END IF;
  IF item.status <> 'pending' THEN RAISE EXCEPTION 'This item was already handled' USING ERRCODE = 'P0001', HINT = 'handled'; END IF;
  UPDATE public.erp_sync_inbox i
  SET status = 'dismissed', decided_by = auth.uid(), decided_at = now(), note = left(btrim(COALESCE(p_reason, '')), 500)
  WHERE i.id = item.id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (item.workspace_id, auth.uid(), 'sync.inbox_dismissed', jsonb_build_object(
    'item_id', item.id, 'kind', item.kind, 'source', item.source_name, 'reason', left(btrim(COALESCE(p_reason, '')), 500)));
END;
$$;

-- ─── 12. Privileges ──────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.erp_sync__docs(TEXT, UUID, UUID, DATE) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_sync_start(UUID, UUID[], TEXT, TEXT[], DATE) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_sync_step(UUID, UUID, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_sync_finish(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_sync_overview() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_sync_set_enabled(UUID, BOOLEAN) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_sync_inbox_list(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_sync_inbox_post(UUID, NUMERIC) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_sync_inbox_dismiss(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_sync_start(UUID, UUID[], TEXT, TEXT[], DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_sync_step(UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_sync_finish(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_sync_overview() TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_sync_set_enabled(UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_sync_inbox_list(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_sync_inbox_post(UUID, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_sync_inbox_dismiss(UUID, TEXT) TO authenticated;
