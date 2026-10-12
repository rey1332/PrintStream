-- PrintStream TERMINAL on its own (no ERP needed): a TERMINAL is a workspace
-- of kind 'terminal', with its own members, roles, invitations, datasets,
-- imports, pipelines and connections. Linking it to ERPs to sync with them
-- is optional (a later migration).
--
-- * erp_workspaces.kind: 'erp' (every existing workspace) or 'terminal'.
-- * erp_create_terminal(name): like creating an ERP (an internal owner
--   account holds it, the creator is its Owner), with TERMINAL always on.
-- * TERMINALs do not use the account's ERP slots: the ERP limit counts ERPs
--   only, and an account belongs to at most ps__terminal_space_limit()
--   TERMINALs.
-- * ps_my_spaces(): what the TERMINAL screen lists — the caller's TERMINALs
--   and the ERPs that have TERMINAL added (Dashboard → Add modules).
--
-- Rollback: db/rollback/rollback_20261012000043_terminal_spaces.sql

ALTER TABLE public.erp_workspaces ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'erp'
  CHECK (kind IN ('erp', 'terminal'));
COMMENT ON COLUMN public.erp_workspaces.kind IS
  'erp: an ERP (counts toward the account''s ERP limit); terminal: a PrintStream TERMINAL on its own.';

CREATE OR REPLACE FUNCTION public.ps__terminal_space_limit()
RETURNS INTEGER
LANGUAGE sql
IMMUTABLE
AS $$ SELECT 10 $$;

CREATE OR REPLACE FUNCTION public.ps__terminal_space_count(p_user_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::INTEGER
    FROM public.erp_workspace_members m JOIN public.erp_workspaces w ON w.id = m.workspace_id
   WHERE m.user_id = p_user_id AND m.status = 'active' AND w.kind = 'terminal';
$$;

-- The ERP limit counts ERPs only.
CREATE OR REPLACE FUNCTION public.erp__active_workspace_count(p_user_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::INTEGER
  FROM public.erp_workspace_members m JOIN public.erp_workspaces w ON w.id = m.workspace_id
  WHERE m.user_id = p_user_id AND m.status = 'active' AND w.kind = 'erp';
$$;

CREATE OR REPLACE FUNCTION pg_temp.ps_patch(p_fn REGPROCEDURE, p_pairs TEXT[])
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  -- Line endings as in the files the functions came from (CRLF on Windows checkouts).
  body TEXT := replace(pg_get_functiondef(p_fn), E'\r\n', E'\n');
  i INTEGER;
BEGIN
  FOR i IN 1 .. COALESCE(array_length(p_pairs, 1), 0) BY 2 LOOP
    p_pairs[i] := replace(p_pairs[i], E'\r\n', E'\n');
    p_pairs[i + 1] := replace(p_pairs[i + 1], E'\r\n', E'\n');
    IF position(p_pairs[i] IN body) = 0 THEN
      RAISE EXCEPTION 'ps_patch: % does not contain %', p_fn, p_pairs[i];
    END IF;
    body := replace(body, p_pairs[i], p_pairs[i + 1]);
  END LOOP;
  RETURN body;
END;
$$;

DO $$
BEGIN
  -- Creating a TERMINAL: as creating an ERP, against the TERMINAL limit, kind 'terminal'.
  EXECUTE pg_temp.ps_patch('public.erp_create_erp(text)'::regprocedure, ARRAY[
    'FUNCTION public.erp_create_erp(', 'FUNCTION public.erp_create_terminal(',
    'Give the ERP a name (at most 120 characters)', 'Give the TERMINAL a name (at most 120 characters)',
    $a$  IF public.erp__active_workspace_count(actor) >= public.erp__workspace_limit_for(actor) THEN
    RAISE EXCEPTION 'This account already belongs to the maximum of % ERPs.', public.erp__workspace_limit_for(actor)
      USING ERRCODE = 'P0001', HINT = 'workspace_limit';
  END IF;$a$,
    $b$  IF public.ps__terminal_space_count(actor) >= public.ps__terminal_space_limit() THEN
    RAISE EXCEPTION 'This account already belongs to the maximum of % TERMINALs.', public.ps__terminal_space_limit()
      USING ERRCODE = 'P0001', HINT = 'terminal_limit';
  END IF;$b$,
    'SET name = v_name, created_by = actor, updated_at = now() WHERE id = ws;',
    'SET name = v_name, created_by = actor, kind = ''terminal'', terminal_enabled = true, updated_at = now() WHERE id = ws;',
    $c$jsonb_build_object('source', 'created', 'name', v_name)$c$,
    $d$jsonb_build_object('source', 'created', 'kind', 'terminal', 'name', v_name)$d$
  ]);

  -- Joining by invitation: the ERP limit for ERPs, the TERMINAL limit for TERMINALs.
  EXECUTE pg_temp.ps_patch('public.erp_redeem_workspace_invitation(text)'::regprocedure, ARRAY[
    $a$  IF public.erp__active_workspace_count(actor) >= public.erp__workspace_limit_for(actor) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'workspace_limit', 'limit', public.erp__workspace_limit_for(actor));
  END IF;
$a$, '',
    $b$  SELECT * INTO membership
  FROM public.erp_workspace_members
  WHERE workspace_id = invitation.workspace_id AND user_id = actor
  FOR UPDATE;$b$,
    $c$  IF (SELECT w.kind FROM public.erp_workspaces w WHERE w.id = invitation.workspace_id) = 'terminal' THEN
    IF public.ps__terminal_space_count(actor) >= public.ps__terminal_space_limit()
       AND NOT EXISTS (SELECT 1 FROM public.erp_workspace_members x
                        WHERE x.workspace_id = invitation.workspace_id AND x.user_id = actor AND x.status = 'active') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'terminal_limit', 'limit', public.ps__terminal_space_limit());
    END IF;
  ELSIF public.erp__active_workspace_count(actor) >= public.erp__workspace_limit_for(actor) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'workspace_limit', 'limit', public.erp__workspace_limit_for(actor));
  END IF;

  SELECT * INTO membership
  FROM public.erp_workspace_members
  WHERE workspace_id = invitation.workspace_id AND user_id = actor
  FOR UPDATE;$c$
  ]);

  -- Every membership is checked against the limit of its kind.
  EXECUTE pg_temp.ps_patch('public.erp_enforce_workspace_limit()'::regprocedure, ARRAY[
    $a$  IF (SELECT count(*) FROM public.erp_workspace_members m
      WHERE m.user_id = NEW.user_id AND m.status = 'active' AND m.workspace_id <> NEW.workspace_id)
     >= public.erp__workspace_limit_for(NEW.user_id) THEN$a$,
    $b$  IF (SELECT w.kind FROM public.erp_workspaces w WHERE w.id = NEW.workspace_id) = 'terminal' THEN
    IF (SELECT count(*) FROM public.erp_workspace_members m JOIN public.erp_workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = NEW.user_id AND m.status = 'active' AND w.kind = 'terminal' AND m.workspace_id <> NEW.workspace_id)
       >= public.ps__terminal_space_limit() THEN
      RAISE EXCEPTION 'This account already belongs to the maximum of % TERMINALs.', public.ps__terminal_space_limit()
        USING ERRCODE = 'P0001', HINT = 'terminal_limit';
    END IF;
    RETURN NEW;
  END IF;
  IF (SELECT count(*) FROM public.erp_workspace_members m JOIN public.erp_workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = NEW.user_id AND m.status = 'active' AND w.kind = 'erp' AND m.workspace_id <> NEW.workspace_id)
     >= public.erp__workspace_limit_for(NEW.user_id) THEN$b$
  ]);

  -- A TERMINAL is always on.
  EXECUTE pg_temp.ps_patch('public.erp_set_terminal(uuid,boolean)'::regprocedure, ARRAY[
    '  IF w.terminal_enabled IS DISTINCT FROM COALESCE(p_enabled, false) THEN',
    $b$  IF w.kind = 'terminal' THEN
    RAISE EXCEPTION 'A TERMINAL cannot be switched off; delete it instead' USING ERRCODE = 'P0001', HINT = 'terminal_space';
  END IF;
  IF w.terminal_enabled IS DISTINCT FROM COALESCE(p_enabled, false) THEN$b$
  ]);
END;
$$;

-- What the TERMINAL screen lists.
CREATE OR REPLACE FUNCTION public.ps_my_spaces()
RETURNS TABLE (workspace_id UUID, name TEXT, kind TEXT, role TEXT, is_owner BOOLEAN, terminal_on BOOLEAN, can_manage BOOLEAN)
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
  SELECT w.id, w.name, w.kind, m.role, m.role = 'owner', w.terminal_enabled, m.role IN ('owner', 'admin')
    FROM public.erp_workspace_members m JOIN public.erp_workspaces w ON w.id = m.workspace_id
   WHERE m.user_id = auth.uid() AND m.status = 'active'
   ORDER BY w.kind DESC, lower(w.name);
END;
$$;

REVOKE ALL ON FUNCTION public.ps__terminal_space_limit() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ps__terminal_space_count(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.erp_create_terminal(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.erp_create_terminal(TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.ps_my_spaces() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ps_my_spaces() TO authenticated;
