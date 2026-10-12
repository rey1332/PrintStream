-- Email-based purchasing approval settings and decisions.
CREATE TABLE IF NOT EXISTS public.erp_approval_settings (
  owner_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  admin_email TEXT NOT NULL,
  approver_emails TEXT[] NOT NULL DEFAULT '{}',
  po_approval_threshold NUMERIC(15,2) NOT NULL DEFAULT 0 CHECK (po_approval_threshold >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.erp_approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  requested_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  purchase_order_id UUID NOT NULL UNIQUE REFERENCES public.erp_purchase_orders(id) ON DELETE CASCADE,
  supplier_name TEXT NOT NULL DEFAULT '',
  admin_email TEXT NOT NULL DEFAULT '',
  amount NUMERIC(15,2) NOT NULL CHECK (amount >= 0),
  approver_emails TEXT[] NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decision_note TEXT NOT NULL DEFAULT '',
  decided_by_email TEXT,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.erp_approval_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_approval_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "owner manages own approval settings" ON public.erp_approval_settings;
CREATE POLICY "owner manages own approval settings" ON public.erp_approval_settings
  FOR ALL TO authenticated USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid());

DROP POLICY IF EXISTS "owner and named approvers read requests" ON public.erp_approval_requests;
CREATE POLICY "owner and named approvers read requests" ON public.erp_approval_requests
  FOR SELECT TO authenticated
  USING (
    owner_id = auth.uid()
    OR lower(COALESCE(auth.jwt() ->> 'email', '')) = ANY (approver_emails)
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_approval_settings TO authenticated;
GRANT SELECT ON public.erp_approval_requests TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON public.erp_approval_requests FROM authenticated;

CREATE INDEX IF NOT EXISTS idx_erp_approval_requests_owner_status
  ON public.erp_approval_requests(owner_id, status, created_at DESC);

INSERT INTO public.erp_approval_settings(owner_id, admin_email)
SELECT id, lower(email) FROM auth.users
WHERE email IS NOT NULL
ON CONFLICT (owner_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.erp_initialize_approval_settings()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS NOT NULL THEN
    INSERT INTO public.erp_approval_settings(owner_id, admin_email)
    VALUES (NEW.id, lower(NEW.email))
    ON CONFLICT (owner_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_initialize_approval_settings ON auth.users;
CREATE TRIGGER trg_initialize_approval_settings
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.erp_initialize_approval_settings();

CREATE OR REPLACE FUNCTION public.erp_create_po_approval_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  config public.erp_approval_settings%ROWTYPE;
BEGIN
  SELECT * INTO config FROM public.erp_approval_settings WHERE owner_id = NEW.user_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF config.po_approval_threshold <= 0 OR NEW.total < config.po_approval_threshold
     OR cardinality(config.approver_emails) = 0 THEN
    RETURN NEW;
  END IF;

  INSERT INTO public.erp_approval_requests
    (owner_id, requested_by, purchase_order_id, supplier_name, admin_email, amount, approver_emails)
  VALUES
    (NEW.user_id, NEW.user_id, NEW.id, NEW.supplier_name, config.admin_email, NEW.total, config.approver_emails)
  ON CONFLICT (purchase_order_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_create_po_approval_request ON public.erp_purchase_orders;
CREATE TRIGGER trg_create_po_approval_request
  AFTER INSERT ON public.erp_purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.erp_create_po_approval_request();

CREATE OR REPLACE FUNCTION public.erp_guard_po_approval()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE request_status TEXT;
BEGIN
  IF NEW.status IN ('approved', 'received') AND OLD.status IS DISTINCT FROM NEW.status THEN
    SELECT status INTO request_status FROM public.erp_approval_requests
    WHERE purchase_order_id = NEW.id AND owner_id = NEW.user_id;
    IF request_status IS NOT NULL AND request_status <> 'approved' THEN
      RAISE EXCEPTION 'This purchase order is awaiting an assigned approver';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_po_approval ON public.erp_purchase_orders;
CREATE TRIGGER trg_guard_po_approval
  BEFORE UPDATE OF status ON public.erp_purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.erp_guard_po_approval();

CREATE OR REPLACE FUNCTION public.erp_decide_po_approval(
  p_request_id UUID,
  p_decision TEXT,
  p_note TEXT DEFAULT ''
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  request_row public.erp_approval_requests%ROWTYPE;
  current_email TEXT := lower(COALESCE(auth.jwt() ->> 'email', ''));
BEGIN
  IF auth.uid() IS NULL OR current_email = '' THEN RAISE EXCEPTION 'Verified sign-in required'; END IF;
  IF p_decision NOT IN ('approved', 'rejected') THEN RAISE EXCEPTION 'Invalid approval decision'; END IF;

  SELECT * INTO request_row FROM public.erp_approval_requests
  WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Approval request not found'; END IF;
  IF NOT (current_email = ANY(request_row.approver_emails)) THEN
    RAISE EXCEPTION 'This email is not assigned to approve the request';
  END IF;
  IF request_row.status <> 'pending' THEN RAISE EXCEPTION 'This request has already been decided'; END IF;

  UPDATE public.erp_approval_requests
  SET status = p_decision,
      decision_note = left(COALESCE(p_note, ''), 1000),
      decided_by_email = current_email,
      decided_at = now()
  WHERE id = p_request_id;

  IF p_decision = 'approved' THEN
    UPDATE public.erp_purchase_orders
    SET status = 'approved', updated_at = now()
    WHERE id = request_row.purchase_order_id AND user_id = request_row.owner_id AND status = 'pending';
    IF NOT FOUND THEN RAISE EXCEPTION 'Purchase order is no longer pending'; END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_decide_po_approval(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_decide_po_approval(UUID, TEXT, TEXT) TO authenticated;
