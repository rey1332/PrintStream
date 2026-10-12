-- Rollback for 20261012000043_terminal_spaces.sql.
-- TERMINALs created on their own stay, as workspaces with TERMINAL added
-- (they then count toward their members' ERP limit).

BEGIN;
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
  EXECUTE pg_temp.ps_patch('public.erp_redeem_workspace_invitation(text)'::regprocedure, ARRAY[
    $c$  IF (SELECT w.kind FROM public.erp_workspaces w WHERE w.id = invitation.workspace_id) = 'terminal' THEN
    IF public.ps__terminal_space_count(actor) >= public.ps__terminal_space_limit()
       AND NOT EXISTS (SELECT 1 FROM public.erp_workspace_members x
                        WHERE x.workspace_id = invitation.workspace_id AND x.user_id = actor AND x.status = 'active') THEN
      RETURN jsonb_build_object('ok', false, 'error', 'terminal_limit', 'limit', public.ps__terminal_space_limit());
    END IF;
  ELSIF public.erp__active_workspace_count(actor) >= public.erp__workspace_limit_for(actor) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'workspace_limit', 'limit', public.erp__workspace_limit_for(actor));
  END IF;

$c$, '',
    '  normalized := public.erp_normalize_access_code(p_code);',
    $a$  IF public.erp__active_workspace_count(actor) >= public.erp__workspace_limit_for(actor) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'workspace_limit', 'limit', public.erp__workspace_limit_for(actor));
  END IF;

  normalized := public.erp_normalize_access_code(p_code);$a$
  ]);

  EXECUTE pg_temp.ps_patch('public.erp_enforce_workspace_limit()'::regprocedure, ARRAY[
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
     >= public.erp__workspace_limit_for(NEW.user_id) THEN$b$,
    $a$  IF (SELECT count(*) FROM public.erp_workspace_members m
      WHERE m.user_id = NEW.user_id AND m.status = 'active' AND m.workspace_id <> NEW.workspace_id)
     >= public.erp__workspace_limit_for(NEW.user_id) THEN$a$
  ]);

  EXECUTE pg_temp.ps_patch('public.erp_set_terminal(uuid,boolean)'::regprocedure, ARRAY[
    $b$  IF w.kind = 'terminal' THEN
    RAISE EXCEPTION 'A TERMINAL cannot be switched off; delete it instead' USING ERRCODE = 'P0001', HINT = 'terminal_space';
  END IF;
$b$, ''
  ]);
END;
$$;

CREATE OR REPLACE FUNCTION public.erp__active_workspace_count(p_user_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT count(*)::INTEGER
  FROM public.erp_workspace_members m
  WHERE m.user_id = p_user_id AND m.status = 'active';
$$;

DROP FUNCTION IF EXISTS public.ps_my_spaces();
DROP FUNCTION IF EXISTS public.erp_create_terminal(TEXT);
DROP FUNCTION IF EXISTS public.ps__terminal_space_count(UUID);
DROP FUNCTION IF EXISTS public.ps__terminal_space_limit();
ALTER TABLE public.erp_workspaces DROP COLUMN IF EXISTS kind;
COMMIT;
