-- Company profile per ERP (Settings → Company profile): the letterhead on
-- printed invoices, purchase orders and payslips.
--
-- Every member reads it (it is printed on their documents); the Owner and
-- Admins change it. The logo is stored inline as a small image data URL
-- (PNG, JPEG or WebP, at most 300 KB) so a backup of the database holds it.
-- Changes are in the audit trail.
--
-- Rollback: db/rollback/rollback_20261012000007_erp_company_profile.sql

CREATE TABLE IF NOT EXISTS public.erp_company_profiles (
  workspace_id UUID PRIMARY KEY REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  legal_name TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  website TEXT NOT NULL DEFAULT '',
  tax_id TEXT NOT NULL DEFAULT '',
  bank_details TEXT NOT NULL DEFAULT '',
  footer_note TEXT NOT NULL DEFAULT '',
  logo TEXT,
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (logo IS NULL OR (logo ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$' AND length(logo) <= 409600))
);
ALTER TABLE public.erp_company_profiles ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.erp_company_profiles FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.erp_company_profile_get(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := COALESCE(p_workspace_id, public.erp_personal_workspace_id(auth.uid()));
  v_role TEXT := public.erp_workspace_role(ws);
  p public.erp_company_profiles%ROWTYPE;
  v_name TEXT;
BEGIN
  IF v_role IS NULL OR NOT public.erp_workspace_mfa_ok(ws) THEN
    RAISE EXCEPTION 'Workspace not found' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO p FROM public.erp_company_profiles x WHERE x.workspace_id = ws;
  SELECT w.name INTO v_name FROM public.erp_workspaces w WHERE w.id = ws;
  RETURN jsonb_build_object(
    'can_edit', v_role IN ('owner', 'admin'),
    'erp_name', v_name,
    'legal_name', COALESCE(p.legal_name, ''), 'address', COALESCE(p.address, ''), 'city', COALESCE(p.city, ''),
    'phone', COALESCE(p.phone, ''), 'email', COALESCE(p.email, ''), 'website', COALESCE(p.website, ''),
    'tax_id', COALESCE(p.tax_id, ''), 'bank_details', COALESCE(p.bank_details, ''),
    'footer_note', COALESCE(p.footer_note, ''), 'logo', p.logo);
END;
$$;

CREATE OR REPLACE FUNCTION public.erp_company_profile_set(p_workspace_id UUID, p_profile JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID := COALESCE(p_workspace_id, public.erp_personal_workspace_id(auth.uid()));
  v_logo TEXT := NULLIF(p_profile ->> 'logo', '');
  v_email TEXT := lower(btrim(COALESCE(p_profile ->> 'email', '')));
BEGIN
  IF NOT COALESCE(public.erp_workspace_role(ws) IN ('owner', 'admin'), false) OR NOT public.erp_workspace_mfa_ok(ws) THEN
    RAISE EXCEPTION 'Only an owner or admin can change the company profile' USING ERRCODE = '42501';
  END IF;
  IF v_email <> '' AND v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' THEN
    RAISE EXCEPTION 'Not an e-mail address: %', v_email USING ERRCODE = 'P0001', HINT = 'email';
  END IF;
  IF v_logo IS NOT NULL AND (v_logo !~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$' OR length(v_logo) > 409600) THEN
    RAISE EXCEPTION 'The logo must be a PNG, JPEG or WebP image of at most 300 KB' USING ERRCODE = 'P0001', HINT = 'logo';
  END IF;
  INSERT INTO public.erp_company_profiles AS c
    (workspace_id, legal_name, address, city, phone, email, website, tax_id, bank_details, footer_note, logo, updated_by, updated_at)
  VALUES (ws,
    left(btrim(COALESCE(p_profile ->> 'legal_name', '')), 200), left(btrim(COALESCE(p_profile ->> 'address', '')), 500),
    left(btrim(COALESCE(p_profile ->> 'city', '')), 100), left(btrim(COALESCE(p_profile ->> 'phone', '')), 50),
    left(v_email, 200), left(btrim(COALESCE(p_profile ->> 'website', '')), 200),
    left(btrim(COALESCE(p_profile ->> 'tax_id', '')), 50), left(btrim(COALESCE(p_profile ->> 'bank_details', '')), 500),
    left(btrim(COALESCE(p_profile ->> 'footer_note', '')), 500), v_logo, auth.uid(), now())
  ON CONFLICT (workspace_id) DO UPDATE SET
    legal_name = EXCLUDED.legal_name, address = EXCLUDED.address, city = EXCLUDED.city, phone = EXCLUDED.phone,
    email = EXCLUDED.email, website = EXCLUDED.website, tax_id = EXCLUDED.tax_id, bank_details = EXCLUDED.bank_details,
    footer_note = EXCLUDED.footer_note, logo = EXCLUDED.logo, updated_by = EXCLUDED.updated_by, updated_at = now();
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (ws, auth.uid(), 'company.profile_changed', jsonb_build_object('logo', v_logo IS NOT NULL));
END;
$$;

REVOKE ALL ON FUNCTION public.erp_company_profile_get(UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_company_profile_set(UUID, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_company_profile_get(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_company_profile_set(UUID, JSONB) TO authenticated;

-- Emptying an ERP (20261012000004_erp_empty_own_erp.sql) clears its profile too.
DO $$
DECLARE def TEXT := pg_get_functiondef('public.erp_empty_erp(uuid)'::regprocedure);
BEGIN
  IF position('erp_company_profiles' IN def) = 0 THEN
    IF position('  DELETE FROM public.erp_documents x WHERE x.workspace_id = w.id;' IN def) = 0 THEN
      RAISE EXCEPTION 'erp_empty_erp changed; company profile not added';
    END IF;
    EXECUTE replace(def, '  DELETE FROM public.erp_documents x WHERE x.workspace_id = w.id;',
      '  DELETE FROM public.erp_documents x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_company_profiles x WHERE x.workspace_id = w.id;');
  END IF;
END;
$$;
