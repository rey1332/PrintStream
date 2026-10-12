-- Creating more ERPs (Add modules → Create a new ERP), within the limit of
-- three ERPs per account (its own, created and joined ones together).
--
-- How: every created ERP gets its own internal owner account that can never
-- sign in (no password, blocked forever, an .invalid address). The ERP is
-- that account's personal workspace, and the person who created it joins as
-- a member with the Owner role. All of ETNA's per-owner bookkeeping (ledger,
-- account codes, journal numbers, warehouses, exchange rates, settings) is
-- keyed by the workspace owner, so each created ERP has its own books with no
-- change to the accounting code — exactly like a workspace shared by
-- someone else, which ETNA already supports.
--
-- Also:
--   * erp_my_workspaces reports Owner by role (so the creator is the owner),
--     "personal" only for the caller's own workspace, the creator's email as
--     the owner, and whether the caller may delete the ERP;
--   * the Owner role can require two-factor in any ERP it owns;
--   * created ERPs can be deleted by their Owner from the server's delete
--     route (password checked there); personal ERPs cannot;
--   * etna_admin.users leaves the internal accounts out.
--
-- Rollback: db/rollback/rollback_20261012000001_erp_create_own_erps.sql

ALTER TABLE public.erp_workspaces
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.erp_workspaces.created_by IS
  'Set for ERPs created with erp_create_erp: the person who created it (owner_id is its internal account).';

-- ─── Create ──────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.erp_create_erp(p_name TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  actor UUID := auth.uid();
  v_name TEXT := btrim(COALESCE(p_name, ''));
  container UUID := gen_random_uuid();
  ws UUID;
BEGIN
  IF actor IS NULL OR NOT EXISTS (SELECT 1 FROM public.user_profiles WHERE id = actor) THEN
    RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.erp_mfa_satisfied() THEN
    RAISE EXCEPTION 'Two-factor verification required' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
  IF char_length(v_name) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Give the ERP a name (at most 120 characters)' USING ERRCODE = 'P0001', HINT = 'name';
  END IF;

  -- Same lock as joining: an account's ERPs are counted one change at a time.
  PERFORM pg_advisory_xact_lock(hashtext('erp_invite_redeem'), hashtext(actor::TEXT));
  IF public.erp__active_workspace_count(actor) >= public.erp_workspace_limit() THEN
    RAISE EXCEPTION 'This account already belongs to the maximum of % ERPs.', public.erp_workspace_limit()
      USING ERRCODE = 'P0001', HINT = 'workspace_limit';
  END IF;

  -- The internal owner. It cannot sign in: no password, blocked forever.
  INSERT INTO auth.users (id, email, encrypted_password, raw_user_meta_data, banned_until)
  VALUES (container, 'erp-' || container || '@container.etna.invalid', NULL,
          jsonb_build_object('full_name', v_name, 'etna_kind', 'erp_container', 'created_by', actor),
          'infinity');
  -- Its profile and personal workspace come from the existing triggers.
  INSERT INTO public.user_profiles (id, email, full_name)
  VALUES (container, 'erp-' || container || '@container.etna.invalid', v_name)
  ON CONFLICT (id) DO NOTHING;
  ws := public.erp_personal_workspace_id(container);

  UPDATE public.erp_workspaces SET name = v_name, created_by = actor, updated_at = now() WHERE id = ws;
  -- The internal account is not a member; the creator is the Owner.
  DELETE FROM public.erp_workspace_members WHERE workspace_id = ws AND user_id = container;
  INSERT INTO public.erp_workspace_members (workspace_id, user_id, role, invited_by)
  VALUES (ws, actor, 'owner', actor);

  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, target_user_id, details)
  VALUES (ws, actor, 'workspace.created', actor, jsonb_build_object('source', 'created', 'name', v_name));
  RETURN ws;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_create_erp(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_create_erp(TEXT) TO authenticated;

-- ─── Delete (created ERPs only) ──────────────────────────────────────────────

-- Removes a created ERP with everything in it. Only the server's delete route
-- may call it (request.path), after checking the password. Returns the ERP's
-- name for the confirmation.
CREATE OR REPLACE FUNCTION public.erp_delete_erp(p_workspace_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE
  actor UUID := auth.uid();
  w public.erp_workspaces%ROWTYPE;
  personal UUID;
BEGIN
  IF current_setting('request.path', true) IS DISTINCT FROM '/account/delete-erp' THEN
    RAISE EXCEPTION 'An ERP is deleted from Settings, with your password' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO w FROM public.erp_workspaces x WHERE x.id = p_workspace_id FOR UPDATE;
  IF NOT FOUND OR public.erp_workspace_role(w.id) IS DISTINCT FROM 'owner' OR NOT public.erp_workspace_mfa_ok(w.id) THEN
    RAISE EXCEPTION 'Only the owner can delete this ERP' USING ERRCODE = '42501';
  END IF;
  IF NOT public.erp_mfa_satisfied() THEN
    RAISE EXCEPTION 'Two-factor verification required' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
  IF w.created_by IS NULL OR w.owner_id = actor OR NOT EXISTS (
    SELECT 1 FROM auth.users u WHERE u.id = w.owner_id AND u.raw_user_meta_data ->> 'etna_kind' = 'erp_container'
  ) THEN
    RAISE EXCEPTION 'Your own ERP cannot be deleted; reset it in Settings instead' USING ERRCODE = 'P0001', HINT = 'personal';
  END IF;

  -- Kept in the deleting person's own ERP trail, which outlives this one.
  personal := public.erp_personal_workspace_id(actor);
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (personal, actor, 'erp.deleted', jsonb_build_object('workspace_id', w.id, 'name', w.name));

  -- Audited records are removed while the internal owner still exists (their
  -- audit entries name it), dependent rows first, as in erp_reset_workspace.
  DELETE FROM public.workflow_runs x WHERE x.workspace_id = w.id;
  DELETE FROM public.workflows x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_stock_movements x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_transactions x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_payments x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_invoices x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_purchase_order_items i
    WHERE i.purchase_order_id IN (SELECT po.id FROM public.erp_purchase_orders po WHERE po.workspace_id = w.id);
  DELETE FROM public.erp_purchase_orders x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_sales_order_items i
    WHERE i.sales_order_id IN (SELECT so.id FROM public.erp_sales_orders so WHERE so.workspace_id = w.id);
  DELETE FROM public.erp_sales_orders x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_journal_entries x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_stock_transfers x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_products x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_suppliers x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_customers x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_warehouses x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_gl_accounts x WHERE x.workspace_id = w.id;
  DELETE FROM public.erp_accounting_settings x WHERE x.workspace_id = w.id;
  -- Attendance keeps its employee (ON DELETE RESTRICT), so both go explicitly.
  DELETE FROM public.erp_attendance a WHERE a.workspace_id = w.id;
  DELETE FROM public.erp_employees e WHERE e.workspace_id = w.id;
  -- The internal owner goes, and with it (ON DELETE CASCADE) the workspace,
  -- its members, invitations, audit entries and everything else in the ERP.
  DELETE FROM auth.users u WHERE u.id = w.owner_id;
  RETURN w.name;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_delete_erp(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_delete_erp(UUID) TO authenticated;

-- ─── My workspaces ───────────────────────────────────────────────────────────

-- Same columns as before (older migrations re-create it with this signature).
-- Owner of an ERP that is not the caller's personal one = an ERP they created,
-- which they may delete.
CREATE OR REPLACE FUNCTION public.erp_my_workspaces()
RETURNS TABLE (workspace_id UUID, name TEXT, role TEXT, is_owner BOOLEAN, is_personal BOOLEAN, owner_id UUID, owner_email TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501'; END IF;
  PERFORM public.erp_personal_workspace_id(auth.uid());
  RETURN QUERY
  SELECT w.id, w.name, m.role,
         m.role = 'owner',
         w.is_personal AND w.owner_id = auth.uid(),
         -- Rows are written on behalf of this account (the app's writeOwner).
         w.owner_id,
         COALESCE(creator.email, owner_profile.email)
  FROM public.erp_workspace_members m
  JOIN public.erp_workspaces w ON w.id = m.workspace_id
  LEFT JOIN public.user_profiles owner_profile ON owner_profile.id = w.owner_id
  LEFT JOIN public.user_profiles creator ON creator.id = w.created_by
  WHERE m.user_id = auth.uid() AND m.status = 'active'
  ORDER BY (w.owner_id = auth.uid()) DESC, (m.role = 'owner') DESC, w.name;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_my_workspaces() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_my_workspaces() TO authenticated;

-- ─── Two-factor requirement: the Owner role decides ──────────────────────────

CREATE OR REPLACE FUNCTION public.erp_set_workspace_require_mfa(p_workspace_id UUID, p_required BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, auth
AS $$
DECLARE w public.erp_workspaces;
BEGIN
  SELECT * INTO w FROM public.erp_workspaces WHERE id = p_workspace_id FOR UPDATE;
  IF NOT FOUND OR auth.uid() IS NULL OR public.erp_workspace_role(w.id) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only the workspace owner can change this setting' USING ERRCODE = '42501';
  END IF;
  IF p_required AND public.erp_session_aal() <> 'aal2' THEN
    RAISE EXCEPTION 'Turn on two-factor authentication for your own account first' USING ERRCODE = 'P0001';
  END IF;
  IF w.require_mfa IS DISTINCT FROM p_required THEN
    UPDATE public.erp_workspaces SET require_mfa = p_required, updated_at = now() WHERE id = w.id;
    INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
    VALUES (w.id, auth.uid(), CASE WHEN p_required THEN 'workspace.mfa_required' ELSE 'workspace.mfa_optional' END, '{}'::jsonb);
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.erp_set_workspace_require_mfa(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_set_workspace_require_mfa(UUID, BOOLEAN) TO authenticated;

-- ─── Base currency: the Owner role decides ───────────────────────────────────
-- Changing or confirming an ERP's base currency was allowed only to the
-- workspace's owner account, which for a created ERP is the internal one.

CREATE OR REPLACE FUNCTION public.erp__is_erp_owner(p_owner UUID, p_workspace_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(
    p_owner = auth.uid()
    OR (p_workspace_id IS NOT NULL
        AND public.erp_workspace_role(p_workspace_id) = 'owner'
        AND public.erp_workspace_mfa_ok(p_workspace_id)
        AND EXISTS (SELECT 1 FROM public.erp_workspaces w WHERE w.id = p_workspace_id AND w.owner_id = p_owner)),
    false);
$$;

REVOKE ALL ON FUNCTION public.erp__is_erp_owner(UUID, UUID) FROM PUBLIC, anon, authenticated;

-- Patched in place (the rest of each function is unchanged); safe to re-run.
DO $$
DECLARE
  patches TEXT[][] := ARRAY[
    ['public.erp_fx__change_base(uuid,uuid,text)', 'IF p_owner IS DISTINCT FROM auth.uid() THEN',
     'IF NOT public.erp__is_erp_owner(p_owner, p_workspace_id) THEN'],
    ['public.erp_confirm_base_currency(uuid,text,bigint)', 'IF owner IS DISTINCT FROM auth.uid() THEN',
     'IF NOT public.erp__is_erp_owner(owner, p_workspace_id) THEN'],
    ['public.erp_currency_settings_get(uuid)', 'owner = auth.uid()',
     'public.erp__is_erp_owner(owner, p_workspace_id)']
  ];
  i INTEGER;
  body TEXT;
BEGIN
  FOR i IN 1 .. array_length(patches, 1) LOOP
    body := pg_get_functiondef(patches[i][1]::regprocedure);
    CONTINUE WHEN position('erp__is_erp_owner' IN body) > 0;
    IF position(patches[i][2] IN body) = 0 THEN
      RAISE EXCEPTION 'Cannot patch %: expected text not found', patches[i][1];
    END IF;
    EXECUTE replace(body, patches[i][2], patches[i][3]);
  END LOOP;
END;
$$;

-- ─── Administrator overview without the internal accounts ────────────────────

DO $$
BEGIN
  IF to_regclass('auth.sessions') IS NULL OR to_regclass('etna_admin.users') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE $view$
    CREATE OR REPLACE VIEW etna_admin.users AS
    SELECT u.email,
           u.raw_user_meta_data ->> 'full_name' AS full_name,
           u.created_at,
           u.last_sign_in_at,
           COALESCE(u.banned_until > now(), false) AS locked,
           (SELECT count(*) FROM auth.mfa_factors f WHERE f.user_id = u.id AND f.status = 'verified')::int AS devices_2fa,
           (SELECT count(*) FROM auth.sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now())::int AS active_sessions
      FROM auth.users u
     WHERE COALESCE(u.raw_user_meta_data ->> 'etna_kind', '') <> 'erp_container'
     ORDER BY u.created_at
  $view$;
  REVOKE ALL ON etna_admin.users FROM PUBLIC;
END;
$$;
