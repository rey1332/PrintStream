-- Industry templates and modules per ERP.
--
-- ETNA is used by more than quarries, so features for one industry
-- (weighbridge, production, equipment) are modules an ERP switches on; an
-- ERP that does not use them never sees them. Every ERP has an industry:
--
--   general        no extra modules (the default, and every existing ERP)
--   quarry         weighbridge, production, equipment
--   trading        no extra modules (purchasing, warehouses and deliveries are core)
--   manufacturing  production, equipment
--
-- The industry picks the modules when an ERP is created (erp_create_erp_v2)
-- or when the Owner or an Admin changes it in Settings; they can then switch
-- single modules on or off (erp_set_workspace_industry). Switching a module
-- off hides it and stops new records; nothing recorded is deleted.
-- Functions of a module check erp__module_on before they change anything.
--
-- Rollback: db/rollback/rollback_20261012000023_erp_industry_modules.sql

ALTER TABLE public.erp_workspaces
  ADD COLUMN IF NOT EXISTS industry TEXT NOT NULL DEFAULT 'general'
    CHECK (industry IN ('general', 'quarry', 'trading', 'manufacturing')),
  ADD COLUMN IF NOT EXISTS modules TEXT[] NOT NULL DEFAULT '{}'
    CHECK (modules <@ ARRAY['weighbridge', 'production', 'equipment']::TEXT[]);

-- The modules an industry starts with.
CREATE OR REPLACE FUNCTION public.erp__industry_modules(p_industry TEXT)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_industry
    WHEN 'quarry' THEN ARRAY['weighbridge', 'production', 'equipment']
    WHEN 'manufacturing' THEN ARRAY['production', 'equipment']
    ELSE ARRAY[]::TEXT[] END;
$$;

-- Is this module switched on in the ERP?
CREATE OR REPLACE FUNCTION public.erp__module_on(p_workspace_id UUID, p_module TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT p_module = ANY (w.modules) FROM public.erp_workspaces w WHERE w.id = p_workspace_id), false);
$$;

-- Raises unless the module is on (for the module's own functions).
CREATE OR REPLACE FUNCTION public.erp__require_module(p_workspace_id UUID, p_module TEXT)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.erp__module_on(p_workspace_id, p_module) THEN
    RAISE EXCEPTION 'The % module is switched off for this ERP (Settings → Industry and modules)', p_module
      USING ERRCODE = 'P0001', HINT = 'module_off';
  END IF;
END;
$$;

-- The industry and modules of the caller's ERPs.
CREATE OR REPLACE FUNCTION public.erp_my_workspace_modules()
RETURNS TABLE (workspace_id UUID, industry TEXT, modules TEXT[])
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT w.id, w.industry, w.modules
    FROM public.erp_workspace_members m
    JOIN public.erp_workspaces w ON w.id = m.workspace_id
   WHERE m.user_id = auth.uid() AND m.status = 'active';
END;
$$;

-- Owner and Admins change the industry and modules. p_modules NULL = the
-- industry's own modules.
CREATE OR REPLACE FUNCTION public.erp_set_workspace_industry(p_workspace_id UUID, p_industry TEXT, p_modules TEXT[] DEFAULT NULL)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  w public.erp_workspaces;
  v_modules TEXT[];
BEGIN
  SELECT * INTO w FROM public.erp_workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR public.erp_workspace_role(w.id) NOT IN ('owner', 'admin')
     OR NOT public.erp_workspace_mfa_ok(w.id) THEN
    RAISE EXCEPTION 'Only the Owner or an Admin can change the industry and modules' USING ERRCODE = '42501';
  END IF;
  IF p_industry IS NULL OR p_industry NOT IN ('general', 'quarry', 'trading', 'manufacturing') THEN
    RAISE EXCEPTION 'Unknown industry' USING ERRCODE = '22023';
  END IF;
  v_modules := COALESCE(p_modules, public.erp__industry_modules(p_industry));
  IF NOT v_modules <@ ARRAY['weighbridge', 'production', 'equipment']::TEXT[] THEN
    RAISE EXCEPTION 'Unknown module' USING ERRCODE = '22023';
  END IF;
  SELECT COALESCE(array_agg(DISTINCT x ORDER BY x), '{}') INTO v_modules FROM unnest(v_modules) x;
  IF w.industry IS DISTINCT FROM p_industry OR w.modules IS DISTINCT FROM v_modules THEN
    UPDATE public.erp_workspaces SET industry = p_industry, modules = v_modules, updated_at = now() WHERE id = w.id;
    INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
    VALUES (w.id, auth.uid(), 'workspace.modules', jsonb_build_object(
      'industry', p_industry, 'modules', to_jsonb(v_modules),
      'previous_industry', w.industry, 'previous_modules', to_jsonb(w.modules)));
  END IF;
END;
$$;

-- Create an ERP with an industry (as erp_create_erp, 20261012000001).
CREATE OR REPLACE FUNCTION public.erp_create_erp_v2(p_name TEXT, p_industry TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ws UUID;
BEGIN
  IF p_industry IS NULL OR p_industry NOT IN ('general', 'quarry', 'trading', 'manufacturing') THEN
    RAISE EXCEPTION 'Unknown industry' USING ERRCODE = '22023';
  END IF;
  ws := public.erp_create_erp(p_name);
  UPDATE public.erp_workspaces
     SET industry = p_industry, modules = public.erp__industry_modules(p_industry)
   WHERE id = ws;
  RETURN ws;
END;
$$;

REVOKE ALL ON FUNCTION public.erp__industry_modules(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp__module_on(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp__require_module(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_my_workspace_modules() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_set_workspace_industry(UUID, TEXT, TEXT[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.erp_create_erp_v2(TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_my_workspace_modules() TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_set_workspace_industry(UUID, TEXT, TEXT[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.erp_create_erp_v2(TEXT, TEXT) TO authenticated;
