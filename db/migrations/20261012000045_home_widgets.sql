-- Widgets on a person's Home page: a figure or a short list from one of
-- their ERPs. Each person has their own; a widget names the ERP it reads.
--
-- * Only the person sees and changes their widgets (row-level security).
-- * A widget is added only for an ERP the person is an active member of
--   (not a TERMINAL on its own). Its data is always read again with the
--   person's rights at that moment: after leaving an ERP, the widget stays
--   but shows nothing from it.
-- * At most 24 widgets a person.
--
-- Rollback: db/rollback/rollback_20261012000045_home_widgets.sql

CREATE TABLE IF NOT EXISTS public.home_widgets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('kpi', 'list')),
  title TEXT NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 80),
  config JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object' AND pg_column_size(config) <= 4096),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS home_widgets_user ON public.home_widgets (user_id, position);

-- A new widget: the person's own, for an ERP they belong to, within the limit.
CREATE OR REPLACE FUNCTION public.home_widgets_check()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Widgets belong to the person who adds them' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'INSERT' OR NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    IF NOT EXISTS (SELECT 1 FROM public.erp_workspace_members m JOIN public.erp_workspaces w ON w.id = m.workspace_id
                    WHERE m.workspace_id = NEW.workspace_id AND m.user_id = NEW.user_id AND m.status = 'active' AND w.kind = 'erp') THEN
      RAISE EXCEPTION 'Widgets read an ERP you belong to' USING ERRCODE = '42501', HINT = 'not_member';
    END IF;
  END IF;
  IF TG_OP = 'INSERT' THEN
    PERFORM pg_advisory_xact_lock(hashtext('home_widgets'), hashtext(NEW.user_id::TEXT));
    IF (SELECT count(*) FROM public.home_widgets WHERE user_id = NEW.user_id) >= 24 THEN
      RAISE EXCEPTION 'At most 24 widgets' USING ERRCODE = 'P0001', HINT = 'widget_limit';
    END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.home_widgets_check() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS home_widgets_check ON public.home_widgets;
CREATE TRIGGER home_widgets_check BEFORE INSERT OR UPDATE ON public.home_widgets
  FOR EACH ROW EXECUTE FUNCTION public.home_widgets_check();

ALTER TABLE public.home_widgets ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.home_widgets FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.home_widgets TO authenticated;
DROP POLICY IF EXISTS home_widgets_own ON public.home_widgets;
CREATE POLICY home_widgets_own ON public.home_widgets FOR ALL TO authenticated
  USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());
-- Like every table of a workspace: nothing while the ERP is suspended.
DROP POLICY IF EXISTS erp_workspace_not_suspended ON public.home_widgets;
CREATE POLICY erp_workspace_not_suspended ON public.home_widgets AS RESTRICTIVE FOR ALL TO authenticated
  USING (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]))
  WITH CHECK (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]));
