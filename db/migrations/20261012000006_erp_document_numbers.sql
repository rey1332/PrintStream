-- Document numbers per ERP.
--
-- Invoices, sales orders, purchase orders and payments get a number when they
-- are created, per ERP and per year of the document's date, without gaps:
--   INV/2026/0001   invoices          SO/2026/0001   sales orders
--   PO/2026/0001    purchase orders   RCV/2026/0001  payments received
--   PAY/2026/0001   payments made
-- A number never changes and is unique within its ERP. The counter row is
-- locked until the document commits, so a rolled-back document gives its
-- number back. Existing documents are numbered in date order.
--
-- Rollback: db/rollback/rollback_20261012000006_erp_document_numbers.sql

CREATE TABLE IF NOT EXISTS public.erp_doc_sequences (
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  doc_type TEXT NOT NULL CHECK (doc_type IN ('INV', 'SO', 'PO', 'RCV', 'PAY')),
  year INTEGER NOT NULL,
  last_no INTEGER NOT NULL CHECK (last_no > 0),
  PRIMARY KEY (workspace_id, doc_type, year)
);
ALTER TABLE public.erp_doc_sequences ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_doc_sequences FROM PUBLIC, anon, authenticated;

ALTER TABLE public.erp_invoices ADD COLUMN IF NOT EXISTS doc_no TEXT;
ALTER TABLE public.erp_sales_orders ADD COLUMN IF NOT EXISTS doc_no TEXT;
ALTER TABLE public.erp_purchase_orders ADD COLUMN IF NOT EXISTS doc_no TEXT;
ALTER TABLE public.erp_payments ADD COLUMN IF NOT EXISTS doc_no TEXT;

CREATE OR REPLACE FUNCTION public.erp_doc__format(p_type TEXT, p_year INTEGER, p_no INTEGER)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT p_type || '/' || p_year || '/' || CASE WHEN p_no < 10000 THEN lpad(p_no::TEXT, 4, '0') ELSE p_no::TEXT END;
$$;

-- Numbers a new document (BEFORE INSERT, after the ERP is assigned) and keeps
-- the number fixed afterwards. TG_ARGV: document type, date column.
CREATE OR REPLACE FUNCTION public.erp_doc__assign()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_type TEXT := TG_ARGV[0];
  v_year INTEGER;
  v_no INTEGER;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.doc_no IS NOT NULL AND NEW.doc_no IS DISTINCT FROM OLD.doc_no THEN
      RAISE EXCEPTION 'Document numbers cannot be changed' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.doc_no IS NOT NULL OR NEW.workspace_id IS NULL THEN RETURN NEW; END IF;
  IF v_type = 'payment' THEN
    v_type := CASE WHEN (to_jsonb(NEW) ->> 'payment_type') = 'outgoing' THEN 'PAY' ELSE 'RCV' END;
  END IF;
  v_year := extract(year FROM COALESCE((to_jsonb(NEW) ->> TG_ARGV[1])::DATE, CURRENT_DATE))::INTEGER;
  INSERT INTO public.erp_doc_sequences AS s (workspace_id, doc_type, year, last_no)
  VALUES (NEW.workspace_id, v_type, v_year, 1)
  ON CONFLICT (workspace_id, doc_type, year) DO UPDATE SET last_no = s.last_no + 1
  RETURNING s.last_no INTO v_no;
  NEW.doc_no := public.erp_doc__format(v_type, v_year, v_no);
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.erp_doc__assign() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_doc__format(TEXT, INTEGER, INTEGER) FROM PUBLIC, anon, authenticated;

-- ─── Existing documents, in date order ───────────────────────────────────────
-- Triggers are off while numbering (no audit entries, no updated_at change).

DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN SELECT * FROM (VALUES
    ('erp_invoices', 'invoice_date', 'INV'),
    ('erp_sales_orders', 'order_date', 'SO'),
    ('erp_purchase_orders', 'order_date', 'PO'),
    ('erp_payments', 'payment_date', 'payment')
  ) AS x(tbl, date_col, doc_type)
  LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER USER', t.tbl);
    EXECUTE format($q$
      WITH typed AS (
        SELECT d.id, d.workspace_id, d.%2$I AS doc_date, d.created_at,
               CASE WHEN %3$L = 'payment'
                    THEN CASE WHEN (to_jsonb(d) ->> 'payment_type') = 'outgoing' THEN 'PAY' ELSE 'RCV' END
                    ELSE %3$L END AS doc_type
        FROM public.%1$I d
        WHERE d.workspace_id IS NOT NULL AND d.doc_no IS NULL
      ), numbered AS (
        SELECT id, workspace_id, doc_type, extract(year FROM doc_date)::INTEGER AS yr,
               (SELECT COALESCE(max(s.last_no), 0) FROM public.erp_doc_sequences s
                 WHERE s.workspace_id = typed.workspace_id AND s.doc_type = typed.doc_type
                   AND s.year = extract(year FROM typed.doc_date)::INTEGER)
               + row_number() OVER (PARTITION BY workspace_id, doc_type, extract(year FROM doc_date)
                                    ORDER BY doc_date, created_at, id) AS n
        FROM typed
      ), updated AS (
        UPDATE public.%1$I d SET doc_no = public.erp_doc__format(numbered.doc_type, numbered.yr, numbered.n::INTEGER)
        FROM numbered WHERE d.id = numbered.id
        RETURNING numbered.workspace_id, numbered.doc_type, numbered.yr, numbered.n
      )
      INSERT INTO public.erp_doc_sequences AS s (workspace_id, doc_type, year, last_no)
      SELECT workspace_id, doc_type, yr, max(n)::INTEGER FROM updated GROUP BY workspace_id, doc_type, yr
      ON CONFLICT (workspace_id, doc_type, year) DO UPDATE SET last_no = GREATEST(s.last_no, EXCLUDED.last_no)
    $q$, t.tbl, t.date_col, t.doc_type);
    EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER USER', t.tbl);

    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON public.%I (workspace_id, doc_no) WHERE doc_no IS NOT NULL',
                   'uq_' || t.tbl || '_doc_no', t.tbl);
    EXECUTE format('DROP TRIGGER IF EXISTS trg_erp_doc_no ON public.%I', t.tbl);
    -- Named to run after trg_erp_assign_workspace (same timing runs in name order).
    EXECUTE format('CREATE TRIGGER trg_erp_doc_no BEFORE INSERT OR UPDATE OF doc_no ON public.%I '
                   'FOR EACH ROW EXECUTE FUNCTION public.erp_doc__assign(%L, %L)',
                   t.tbl, t.doc_type, t.date_col);
  END LOOP;
END;
$$;

-- ─── Search finds documents by number ────────────────────────────────────────
-- Same definition (20261005000000_erp_ontology_search.sql), with the number
-- added to the searched text of orders, invoices and payments.

DO $$
DECLARE
  fn REGPROCEDURE;
  def TEXT;
  patches TEXT[][] := ARRAY[
    [$p$txt := $x$(coalesce(t.customer_name, '') || ' ' || coalesce(t.notes, '')$p$,
     $p$txt := $x$(coalesce(t.doc_no, '') || ' ' || coalesce(t.customer_name, '') || ' ' || coalesce(t.notes, '')$p$],
    [$p$txt := $x$(coalesce(t.supplier_name, '') || ' ' || coalesce(t.notes, '')$p$,
     $p$txt := $x$(coalesce(t.doc_no, '') || ' ' || coalesce(t.supplier_name, '') || ' ' || coalesce(t.notes, '')$p$],
    [$p$txt := $x$(coalesce(t.customer_name, '') || ' ' || coalesce(t.void_reason, ''))$x$;$p$,
     $p$txt := $x$(coalesce(t.doc_no, '') || ' ' || coalesce(t.customer_name, '') || ' ' || coalesce(t.void_reason, ''))$x$;$p$],
    [$p$txt := $x$(coalesce(t.party, '') ||$p$,
     $p$txt := $x$(coalesce(t.doc_no, '') || ' ' || coalesce(t.party, '') ||$p$]
  ];
  i INTEGER;
BEGIN
  FOR fn IN SELECT p.oid::REGPROCEDURE FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'public' AND p.proname = 'erp_ontology_search'
  LOOP
    def := pg_get_functiondef(fn);
    IF position('coalesce(t.doc_no' IN def) > 0 THEN CONTINUE; END IF;
    FOR i IN 1 .. array_length(patches, 1) LOOP
      IF position(patches[i][1] IN def) = 0 THEN
        RAISE EXCEPTION 'erp_ontology_search changed; search by document number not applied (%)', i;
      END IF;
      def := replace(def, patches[i][1], patches[i][2]);
    END LOOP;
    EXECUTE def;
  END LOOP;
END;
$$;
