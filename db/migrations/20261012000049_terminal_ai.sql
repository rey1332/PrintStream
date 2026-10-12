-- TERMINAL intelligence (P3): AI providers, what they may see, what they may
-- cost, and the analyses (decisions) PrintStream records.
--
-- * Providers (ps_ai_providers): Anthropic, OpenAI, Azure OpenAI, Ollama or
--   any OpenAI-compatible endpoint, each with its model and declared
--   capabilities, added by members with 'integrations.manage' and two-factor.
--   The key is sealed by the app (etna_platform.ai_secrets). Where a provider
--   allows it, a member may add a personal key (etna_platform.ai_personal_keys)
--   used only for runs they start themselves.
-- * Data sharing is denied until allowed (ps_ai_policies): per provider and
--   dataset, with sensitive columns allowed separately and a number of sample
--   rows (none by default: providers see aggregates and profiles only). Set
--   by members with 'policies.manage' and two-factor; kept in the audit log.
-- * Budget (ps_ai_settings): a monthly limit set by the workspace; no limit
--   set means no AI calls with the workspace's keys. Usage is metered
--   (ps_ai_usage). The Owner decides how analyses about people are handled:
--   'review' (always sent for human review, the default) or 'automate'.
-- * Decisions (ps_decisions): every analysis with its inputs, method version,
--   statistical evidence, output, confidence, the AI narrative (labelled AI
--   inference, with provider and model) and its human review status.
-- * Ollama and other local endpoints on ETNA's own server are reached only at
--   addresses a super admin lists (etna_platform.settings.ai_local_endpoints).
-- * Ontology (ps_dataset_entities): a dataset can say what it holds, as one
--   of the ERP's entity types (src/lib/ontology) or a type of its own, with
--   its key column, links to other datasets' entities, and whether it is
--   about people (then its analyses follow the Owner's policy above).
--
-- Rollback: db/rollback/rollback_20261012000049_terminal_ai.sql

ALTER TABLE etna_platform.settings ADD COLUMN IF NOT EXISTS ai_local_endpoints TEXT[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(ai_local_endpoints) <= 10);

CREATE TABLE IF NOT EXISTS public.ps_ai_providers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('anthropic', 'openai', 'azure_openai', 'ollama', 'openai_compatible')),
  name TEXT NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  config JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object' AND pg_column_size(config) <= 4096),
  allow_personal_keys BOOLEAN NOT NULL DEFAULT false,
  enabled BOOLEAN NOT NULL DEFAULT true,
  has_secret BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'untested' CHECK (status IN ('untested', 'ok', 'failed')),
  last_error_key TEXT CHECK (last_error_key IS NULL OR char_length(last_error_key) <= 80),
  last_tested_at TIMESTAMPTZ,
  created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ps_ai_providers_name ON public.ps_ai_providers (workspace_id, lower(btrim(name)));

CREATE TABLE IF NOT EXISTS etna_platform.ai_secrets (
  provider_id UUID PRIMARY KEY REFERENCES public.ps_ai_providers(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL CHECK (ciphertext ~ '^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$' AND char_length(ciphertext) <= 16384),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS etna_platform.ai_personal_keys (
  provider_id UUID NOT NULL REFERENCES public.ps_ai_providers(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  ciphertext TEXT NOT NULL CHECK (ciphertext ~ '^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$' AND char_length(ciphertext) <= 16384),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, user_id)
);
REVOKE ALL ON etna_platform.ai_secrets FROM PUBLIC, anon, authenticated;
REVOKE ALL ON etna_platform.ai_personal_keys FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS public.ps_ai_policies (
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  provider_id UUID NOT NULL REFERENCES public.ps_ai_providers(id) ON DELETE CASCADE,
  dataset_id UUID NOT NULL REFERENCES public.ps_datasets(id) ON DELETE CASCADE,
  allowed BOOLEAN NOT NULL DEFAULT false,
  -- Sensitive columns (by label) the provider may also see.
  sensitive_columns TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(sensitive_columns) <= 200),
  sample_rows INTEGER NOT NULL DEFAULT 0 CHECK (sample_rows BETWEEN 0 AND 200),
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (provider_id, dataset_id)
);

CREATE TABLE IF NOT EXISTS public.ps_ai_settings (
  workspace_id UUID PRIMARY KEY REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  monthly_limit NUMERIC(14, 2) CHECK (monthly_limit IS NULL OR monthly_limit >= 0),
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency ~ '^[A-Z]{3}$'),
  people_decisions TEXT NOT NULL DEFAULT 'review' CHECK (people_decisions IN ('review', 'automate')),
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.ps_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  dataset_id UUID REFERENCES public.ps_datasets(id) ON DELETE SET NULL,
  kind TEXT NOT NULL CHECK (kind IN ('forecast', 'anomalies', 'profile')),
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  error_key TEXT CHECK (error_key IS NULL OR char_length(error_key) <= 80),
  inputs JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(inputs) <= 16384),
  method TEXT CHECK (method IS NULL OR char_length(method) <= 120),
  evidence JSONB CHECK (evidence IS NULL OR pg_column_size(evidence) <= 1048576),
  output JSONB CHECK (output IS NULL OR pg_column_size(output) <= 262144),
  confidence NUMERIC(4, 3) CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  narrative JSONB CHECK (narrative IS NULL OR pg_column_size(narrative) <= 65536),
  narrative_provider TEXT CHECK (narrative_provider IS NULL OR char_length(narrative_provider) <= 120),
  narrative_model TEXT CHECK (narrative_model IS NULL OR char_length(narrative_model) <= 120),
  about_people BOOLEAN NOT NULL DEFAULT false,
  review_status TEXT NOT NULL DEFAULT 'none' CHECK (review_status IN ('none', 'requested', 'reviewed')),
  review_note TEXT CHECK (review_note IS NULL OR char_length(review_note) <= 2000),
  reviewed_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMPTZ,
  created_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ps_decisions_workspace ON public.ps_decisions (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.ps_ai_usage (
  id BIGSERIAL PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  provider_id UUID REFERENCES public.ps_ai_providers(id) ON DELETE SET NULL,
  provider_name TEXT NOT NULL,
  model TEXT,
  user_id UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  decision_id UUID REFERENCES public.ps_decisions(id) ON DELETE SET NULL,
  personal_key BOOLEAN NOT NULL DEFAULT false,
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  cost NUMERIC(14, 6) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  -- What was sent: the dataset, the columns, sensitive columns among them.
  shared JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (pg_column_size(shared) <= 16384),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ps_ai_usage_month ON public.ps_ai_usage (workspace_id, created_at);

CREATE TABLE IF NOT EXISTS public.ps_dataset_entities (
  dataset_id UUID PRIMARY KEY REFERENCES public.ps_datasets(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.erp_workspaces(id) ON DELETE CASCADE,
  entity_type TEXT NOT NULL CHECK (entity_type ~ '^[A-Za-z][A-Za-z0-9_]{1,40}$'),
  label TEXT CHECK (label IS NULL OR char_length(label) <= 80),
  key_column TEXT CHECK (key_column IS NULL OR char_length(key_column) <= 120),
  about_people BOOLEAN NOT NULL DEFAULT false,
  -- [{column, target_dataset, target_type}]: this column refers to that entity.
  relations JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(relations) = 'array' AND pg_column_size(relations) <= 8192),
  updated_by UUID REFERENCES public.user_profiles(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Who may read what.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['ps_ai_providers', 'ps_ai_policies', 'ps_ai_settings', 'ps_decisions', 'ps_ai_usage', 'ps_dataset_entities'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC, anon, authenticated', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_read', t);
    EXECUTE format('DROP POLICY IF EXISTS erp_workspace_not_suspended ON public.%I', t);
    EXECUTE format('CREATE POLICY erp_workspace_not_suspended ON public.%I AS RESTRICTIVE FOR ALL TO authenticated '
                   'USING (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[])) '
                   'WITH CHECK (workspace_id IS NULL OR NOT workspace_id = ANY ((SELECT public.erp_suspended_workspace_ids())::uuid[]))', t);
  END LOOP;
END;
$$;
CREATE POLICY ps_ai_providers_read ON public.ps_ai_providers FOR SELECT TO authenticated
  USING (public.erp_has_permission(workspace_id, 'datasets.query') OR public.erp_has_permission(workspace_id, 'integrations.manage')
         OR public.erp_has_permission(workspace_id, 'policies.manage'));
CREATE POLICY ps_ai_policies_read ON public.ps_ai_policies FOR SELECT TO authenticated
  USING (public.erp_has_permission(workspace_id, 'datasets.query') OR public.erp_has_permission(workspace_id, 'policies.manage'));
CREATE POLICY ps_ai_settings_read ON public.ps_ai_settings FOR SELECT TO authenticated
  USING (public.erp_workspace_role(workspace_id) IS NOT NULL);
CREATE POLICY ps_decisions_read ON public.ps_decisions FOR SELECT TO authenticated
  USING (public.erp_workspace_role(workspace_id) IS NOT NULL
         AND (dataset_id IS NULL OR public.ps_can_access_dataset(dataset_id, 'query') OR created_by = auth.uid()));
CREATE POLICY ps_ai_usage_read ON public.ps_ai_usage FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.erp_has_permission(workspace_id, 'policies.manage'));
CREATE POLICY ps_dataset_entities_read ON public.ps_dataset_entities FOR SELECT TO authenticated
  USING (public.ps_can_access_dataset(dataset_id, 'view'));

-- What a dataset holds (members who may change its columns); NULL type removes it.
CREATE OR REPLACE FUNCTION public.ps_set_dataset_entity(
  p_dataset_id UUID, p_entity_type TEXT, p_label TEXT, p_key_column TEXT, p_about_people BOOLEAN, p_relations JSONB)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ds public.ps_datasets;
BEGIN
  SELECT * INTO ds FROM public.ps_datasets WHERE id = p_dataset_id AND deleted_at IS NULL;
  IF ds.id IS NULL OR NOT public.ps_can_access_dataset(ds.id, 'schema') THEN
    RAISE EXCEPTION 'Dataset not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_entity_type IS NULL THEN
    DELETE FROM public.ps_dataset_entities WHERE dataset_id = ds.id;
    RETURN;
  END IF;
  IF p_key_column IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.ps_dataset_columns c WHERE c.dataset_id = ds.id AND c.label = p_key_column) THEN
    RAISE EXCEPTION 'The key column is not in the dataset' USING ERRCODE = '22023';
  END IF;
  -- Links point at datasets of the same workspace.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(p_relations, '[]'::jsonb)) r
     WHERE NOT EXISTS (SELECT 1 FROM public.ps_dataset_columns c WHERE c.dataset_id = ds.id AND c.label = r ->> 'column')
        OR (r ? 'target_dataset' AND NOT EXISTS (
              SELECT 1 FROM public.ps_datasets t WHERE t.id::text = r ->> 'target_dataset' AND t.workspace_id = ds.workspace_id))) THEN
    RAISE EXCEPTION 'A link names a column or dataset that does not exist' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.ps_dataset_entities (dataset_id, workspace_id, entity_type, label, key_column, about_people, relations, updated_by)
  VALUES (ds.id, ds.workspace_id, p_entity_type, left(btrim(p_label), 80), p_key_column, COALESCE(p_about_people, false),
          COALESCE(p_relations, '[]'::jsonb), auth.uid())
  ON CONFLICT (dataset_id) DO UPDATE
     SET entity_type = EXCLUDED.entity_type, label = EXCLUDED.label, key_column = EXCLUDED.key_column,
         about_people = EXCLUDED.about_people, relations = EXCLUDED.relations, updated_by = auth.uid(), updated_at = now();
END;
$$;

-- ─── Providers and keys ──────────────────────────────────────────────────────

-- Adds or changes a provider. p_secret: the app's ciphertext; NULL keeps the stored one.
CREATE OR REPLACE FUNCTION public.ps_save_ai_provider(
  p_workspace_id UUID, p_id UUID, p_kind TEXT, p_name TEXT, p_config JSONB, p_allow_personal BOOLEAN, p_enabled BOOLEAN, p_secret TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, etna_platform
AS $$
DECLARE
  saved UUID := p_id;
BEGIN
  PERFORM public.ps__require_connection_manager(p_workspace_id);
  IF p_id IS NULL THEN
    INSERT INTO public.ps_ai_providers (workspace_id, kind, name, config, allow_personal_keys, enabled, created_by)
    VALUES (p_workspace_id, p_kind, btrim(p_name), COALESCE(p_config, '{}'::jsonb), COALESCE(p_allow_personal, false), COALESCE(p_enabled, true), auth.uid())
    RETURNING id INTO saved;
  ELSE
    UPDATE public.ps_ai_providers
       SET name = btrim(p_name), config = COALESCE(p_config, config), allow_personal_keys = COALESCE(p_allow_personal, allow_personal_keys),
           enabled = COALESCE(p_enabled, enabled), status = 'untested', last_error_key = NULL, updated_at = now()
     WHERE id = p_id AND workspace_id = p_workspace_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Provider not found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
  IF p_secret IS NOT NULL THEN
    INSERT INTO etna_platform.ai_secrets (provider_id, ciphertext) VALUES (saved, p_secret)
    ON CONFLICT (provider_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now();
    UPDATE public.ps_ai_providers SET has_secret = true WHERE id = saved;
  END IF;
  -- Personal keys go when a provider no longer allows them.
  DELETE FROM etna_platform.ai_personal_keys k
   WHERE k.provider_id = saved AND NOT (SELECT allow_personal_keys FROM public.ps_ai_providers WHERE id = saved);
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (p_workspace_id, auth.uid(), CASE WHEN p_id IS NULL THEN 'ai_provider.added' ELSE 'ai_provider.changed' END,
          jsonb_build_object('provider_id', saved, 'kind', p_kind, 'name', btrim(p_name), 'model', p_config ->> 'model',
                             'personal_keys', p_allow_personal, 'secret_changed', p_secret IS NOT NULL));
  RETURN saved;
END;
$$;

CREATE OR REPLACE FUNCTION public.ps_delete_ai_provider(p_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p public.ps_ai_providers;
BEGIN
  SELECT * INTO p FROM public.ps_ai_providers WHERE id = p_id;
  IF p.id IS NULL THEN
    RAISE EXCEPTION 'Provider not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.ps__require_connection_manager(p.workspace_id);
  DELETE FROM public.ps_ai_providers WHERE id = p.id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (p.workspace_id, auth.uid(), 'ai_provider.removed', jsonb_build_object('provider_id', p.id, 'name', p.name));
END;
$$;

-- A member's own key for a provider that allows it (NULL removes it).
CREATE OR REPLACE FUNCTION public.ps_set_ai_personal_key(p_provider_id UUID, p_secret TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, etna_platform
AS $$
DECLARE
  p public.ps_ai_providers;
BEGIN
  SELECT * INTO p FROM public.ps_ai_providers WHERE id = p_provider_id;
  IF p.id IS NULL OR NOT public.erp_has_permission(p.workspace_id, 'datasets.query') THEN
    RAISE EXCEPTION 'Provider not found' USING ERRCODE = 'P0002';
  END IF;
  IF p_secret IS NULL THEN
    DELETE FROM etna_platform.ai_personal_keys WHERE provider_id = p.id AND user_id = auth.uid();
    RETURN;
  END IF;
  IF NOT p.allow_personal_keys THEN
    RAISE EXCEPTION 'This provider does not take personal keys' USING ERRCODE = 'P0001', HINT = 'personalKeysOff';
  END IF;
  INSERT INTO etna_platform.ai_personal_keys (provider_id, user_id, ciphertext) VALUES (p.id, auth.uid(), p_secret)
  ON CONFLICT (provider_id, user_id) DO UPDATE SET ciphertext = EXCLUDED.ciphertext, updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.ps_has_ai_personal_key(p_provider_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, etna_platform
AS $$
  SELECT EXISTS (SELECT 1 FROM etna_platform.ai_personal_keys WHERE provider_id = p_provider_id AND user_id = auth.uid());
$$;

-- ─── Policies, budget, people decisions ──────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ps__require_policy_manager(p_workspace_id UUID)
RETURNS VOID
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.erp_has_permission(p_workspace_id, 'policies.manage') OR public.erp_session_aal() IS DISTINCT FROM 'aal2' THEN
    RAISE EXCEPTION 'Policies are set by members allowed to, signed in with two-factor' USING ERRCODE = '42501', HINT = 'mfa_required';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.ps_set_ai_policy(
  p_provider_id UUID, p_dataset_id UUID, p_allowed BOOLEAN, p_sensitive_columns TEXT[], p_sample_rows INTEGER)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  p public.ps_ai_providers;
  ds public.ps_datasets;
BEGIN
  SELECT * INTO p FROM public.ps_ai_providers WHERE id = p_provider_id;
  SELECT * INTO ds FROM public.ps_datasets WHERE id = p_dataset_id AND deleted_at IS NULL;
  IF p.id IS NULL OR ds.id IS NULL OR ds.workspace_id <> p.workspace_id THEN
    RAISE EXCEPTION 'Provider or dataset not found' USING ERRCODE = 'P0002';
  END IF;
  PERFORM public.ps__require_policy_manager(p.workspace_id);
  INSERT INTO public.ps_ai_policies (workspace_id, provider_id, dataset_id, allowed, sensitive_columns, sample_rows, updated_by)
  VALUES (p.workspace_id, p.id, ds.id, COALESCE(p_allowed, false), COALESCE(p_sensitive_columns, '{}'), COALESCE(p_sample_rows, 0), auth.uid())
  ON CONFLICT (provider_id, dataset_id) DO UPDATE
     SET allowed = EXCLUDED.allowed, sensitive_columns = EXCLUDED.sensitive_columns, sample_rows = EXCLUDED.sample_rows,
         updated_by = auth.uid(), updated_at = now();
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (p.workspace_id, auth.uid(), 'ai_policy.set',
          jsonb_build_object('provider', p.name, 'dataset_id', ds.id, 'dataset', ds.name, 'allowed', COALESCE(p_allowed, false),
                             'sensitive_columns', to_jsonb(COALESCE(p_sensitive_columns, '{}')), 'sample_rows', COALESCE(p_sample_rows, 0)));
END;
$$;

-- The budget (policies.manage); how analyses about people are handled (the Owner only).
CREATE OR REPLACE FUNCTION public.ps_set_ai_settings(
  p_workspace_id UUID, p_monthly_limit NUMERIC, p_currency TEXT, p_people_decisions TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  current_people TEXT := COALESCE((SELECT people_decisions FROM public.ps_ai_settings WHERE workspace_id = p_workspace_id), 'review');
BEGIN
  PERFORM public.ps__require_policy_manager(p_workspace_id);
  IF p_people_decisions IS NOT NULL AND p_people_decisions <> current_people
     AND public.erp_workspace_role(p_workspace_id) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'Only the Owner decides how analyses about people are handled' USING ERRCODE = 'P0001', HINT = 'ownerOnly';
  END IF;
  INSERT INTO public.ps_ai_settings (workspace_id, monthly_limit, currency, people_decisions, updated_by)
  VALUES (p_workspace_id, p_monthly_limit, COALESCE(p_currency, 'USD'), COALESCE(p_people_decisions, current_people), auth.uid())
  ON CONFLICT (workspace_id) DO UPDATE
     SET monthly_limit = EXCLUDED.monthly_limit, currency = EXCLUDED.currency, people_decisions = EXCLUDED.people_decisions,
         updated_by = auth.uid(), updated_at = now();
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (p_workspace_id, auth.uid(), 'ai_settings.set',
          jsonb_build_object('monthly_limit', p_monthly_limit, 'currency', p_currency, 'people_decisions', COALESCE(p_people_decisions, current_people)));
END;
$$;

-- This month's spending with the workspace's keys, and the limit.
CREATE OR REPLACE FUNCTION public.ps_ai_budget(p_workspace_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN public.erp_workspace_role(p_workspace_id) IS NULL THEN NULL ELSE jsonb_build_object(
    'limit', (SELECT monthly_limit FROM public.ps_ai_settings WHERE workspace_id = p_workspace_id),
    'currency', COALESCE((SELECT currency FROM public.ps_ai_settings WHERE workspace_id = p_workspace_id), 'USD'),
    'people_decisions', COALESCE((SELECT people_decisions FROM public.ps_ai_settings WHERE workspace_id = p_workspace_id), 'review'),
    'spent', COALESCE((SELECT sum(cost) FROM public.ps_ai_usage u
                        WHERE u.workspace_id = p_workspace_id AND NOT u.personal_key
                          AND u.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'Asia/Jakarta'), 0)) END;
$$;

-- ─── Decisions ───────────────────────────────────────────────────────────────

-- A new analysis of a dataset the person may query (the worker fills it in).
CREATE OR REPLACE FUNCTION public.ps_start_decision(p_dataset_id UUID, p_kind TEXT, p_title TEXT, p_inputs JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ds public.ps_datasets;
  saved UUID;
BEGIN
  SELECT * INTO ds FROM public.ps_datasets WHERE id = p_dataset_id AND deleted_at IS NULL;
  IF ds.id IS NULL OR NOT public.ps_can_access_dataset(ds.id, 'query') THEN
    RAISE EXCEPTION 'Dataset not found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.ps__terminal_on(ds.workspace_id) THEN
    RAISE EXCEPTION 'TERMINAL is off' USING ERRCODE = 'P0001', HINT = 'terminal_off';
  END IF;
  INSERT INTO public.ps_decisions (workspace_id, dataset_id, kind, title, inputs, created_by)
  VALUES (ds.workspace_id, ds.id, p_kind, left(btrim(p_title), 200), COALESCE(p_inputs, '{}'::jsonb), auth.uid())
  RETURNING id INTO saved;
  RETURN saved;
END;
$$;

-- The worker's result, written as the person (they must still be able to query the dataset).
CREATE OR REPLACE FUNCTION public.ps_finish_decision(
  p_id UUID, p_ok BOOLEAN, p_error TEXT, p_method TEXT, p_evidence JSONB, p_output JSONB, p_confidence NUMERIC,
  p_narrative JSONB, p_provider TEXT, p_model TEXT, p_about_people BOOLEAN)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.ps_decisions;
  people TEXT;
BEGIN
  SELECT * INTO d FROM public.ps_decisions WHERE id = p_id;
  IF d.id IS NULL OR d.created_by IS DISTINCT FROM auth.uid() OR d.status <> 'running' THEN
    RAISE EXCEPTION 'Decision not found' USING ERRCODE = 'P0002';
  END IF;
  people := COALESCE((SELECT people_decisions FROM public.ps_ai_settings WHERE workspace_id = d.workspace_id), 'review');
  UPDATE public.ps_decisions
     SET status = CASE WHEN p_ok THEN 'done' ELSE 'failed' END, error_key = left(p_error, 80), method = left(p_method, 120),
         evidence = p_evidence, output = p_output, confidence = p_confidence, narrative = p_narrative,
         narrative_provider = left(p_provider, 120), narrative_model = left(p_model, 120),
         about_people = COALESCE(p_about_people, false),
         -- Analyses about people go to a person unless the Owner chose otherwise.
         review_status = CASE WHEN p_ok AND COALESCE(p_about_people, false) AND people = 'review' THEN 'requested' ELSE review_status END,
         finished_at = now()
   WHERE id = d.id;
END;
$$;

-- Anyone who may see a decision can ask a person to review it.
CREATE OR REPLACE FUNCTION public.ps_request_review(p_id UUID, p_note TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.ps_decisions;
BEGIN
  SELECT * INTO d FROM public.ps_decisions WHERE id = p_id;
  IF d.id IS NULL OR public.erp_workspace_role(d.workspace_id) IS NULL
     OR NOT (d.dataset_id IS NULL OR public.ps_can_access_dataset(d.dataset_id, 'query') OR d.created_by = auth.uid()) THEN
    RAISE EXCEPTION 'Decision not found' USING ERRCODE = 'P0002';
  END IF;
  UPDATE public.ps_decisions SET review_status = 'requested', review_note = left(p_note, 2000), reviewed_by = NULL, reviewed_at = NULL WHERE id = d.id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (d.workspace_id, auth.uid(), 'decision.review_requested', jsonb_build_object('decision_id', d.id, 'title', d.title));
END;
$$;

-- A person with 'approvals.decide' (not the one who ran it) records the review.
CREATE OR REPLACE FUNCTION public.ps_review_decision(p_id UUID, p_note TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  d public.ps_decisions;
BEGIN
  SELECT * INTO d FROM public.ps_decisions WHERE id = p_id;
  IF d.id IS NULL OR NOT public.erp_has_permission(d.workspace_id, 'approvals.decide') THEN
    RAISE EXCEPTION 'Decision not found' USING ERRCODE = 'P0002';
  END IF;
  IF d.created_by = auth.uid() THEN
    RAISE EXCEPTION 'Someone other than the person who ran it reviews it' USING ERRCODE = 'P0001', HINT = 'selfReview';
  END IF;
  UPDATE public.ps_decisions SET review_status = 'reviewed', review_note = left(p_note, 2000), reviewed_by = auth.uid(), reviewed_at = now()
   WHERE id = d.id;
  INSERT INTO public.erp_workspace_audit_log (workspace_id, actor_id, action, details)
  VALUES (d.workspace_id, auth.uid(), 'decision.reviewed', jsonb_build_object('decision_id', d.id, 'title', d.title, 'note', left(p_note, 2000)));
END;
$$;

-- ─── The worker ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION ps_worker.ai_provider_get(p_provider_id UUID, p_user_id UUID)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, etna_platform, pg_temp
AS $$
  SELECT to_jsonb(p) || jsonb_build_object(
           'secret', (SELECT s.ciphertext FROM etna_platform.ai_secrets s WHERE s.provider_id = p.id),
           'personal_secret', CASE WHEN p.allow_personal_keys THEN
             (SELECT k.ciphertext FROM etna_platform.ai_personal_keys k WHERE k.provider_id = p.id AND k.user_id = p_user_id) END,
           'private_hosts', COALESCE((SELECT to_jsonb(st.connector_private_hosts) FROM etna_platform.settings st WHERE st.id), '[]'::jsonb)
                            || COALESCE((SELECT jsonb_agg(a.host) FROM etna_platform.network_allowlist a WHERE a.workspace_id = p.workspace_id), '[]'::jsonb),
           'local_endpoints', COALESCE((SELECT to_jsonb(st.ai_local_endpoints) FROM etna_platform.settings st WHERE st.id), '[]'::jsonb),
           'budget', jsonb_build_object(
             'limit', (SELECT monthly_limit FROM public.ps_ai_settings WHERE workspace_id = p.workspace_id),
             'spent', COALESCE((SELECT sum(cost) FROM public.ps_ai_usage u
                                 WHERE u.workspace_id = p.workspace_id AND NOT u.personal_key
                                   AND u.created_at >= date_trunc('month', now() AT TIME ZONE 'Asia/Jakarta') AT TIME ZONE 'Asia/Jakarta'), 0)))
    FROM public.ps_ai_providers p WHERE p.id = p_provider_id;
$$;

CREATE OR REPLACE FUNCTION ps_worker.ai_provider_tested(p_provider_id UUID, p_ok BOOLEAN, p_error TEXT)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  UPDATE public.ps_ai_providers
     SET status = CASE WHEN p_ok THEN 'ok' ELSE 'failed' END, last_error_key = CASE WHEN p_ok THEN NULL ELSE left(p_error, 80) END,
         last_tested_at = now()
   WHERE id = p_provider_id;
$$;

CREATE OR REPLACE FUNCTION ps_worker.ai_usage_record(
  p_provider_id UUID, p_user_id UUID, p_decision_id UUID, p_personal BOOLEAN, p_input INTEGER, p_output INTEGER, p_cost NUMERIC, p_shared JSONB)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  INSERT INTO public.ps_ai_usage (workspace_id, provider_id, provider_name, model, user_id, decision_id, personal_key, input_tokens, output_tokens, cost, shared)
  SELECT p.workspace_id, p.id, p.name, p.config ->> 'model', p_user_id, p_decision_id, COALESCE(p_personal, false),
         GREATEST(COALESCE(p_input, 0), 0), GREATEST(COALESCE(p_output, 0), 0), GREATEST(COALESCE(p_cost, 0), 0), COALESCE(p_shared, '{}'::jsonb)
    FROM public.ps_ai_providers p WHERE p.id = p_provider_id;
$$;

-- ─── Local AI endpoints (super admins) ───────────────────────────────────────

CREATE OR REPLACE FUNCTION etna_platform.admin_set_ai_local_endpoints(p_endpoints TEXT[])
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
DECLARE
  caller_role TEXT := etna_platform._require_admin(ARRAY['super_admin'], true);
  e TEXT;
BEGIN
  FOREACH e IN ARRAY COALESCE(p_endpoints, '{}') LOOP
    IF e !~ '^(localhost|127\.0\.0\.1|\[::1\]):[0-9]{1,5}$' THEN
      RAISE EXCEPTION 'Give local addresses as host:port (localhost, 127.0.0.1 or [::1])' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  UPDATE etna_platform.settings SET ai_local_endpoints = COALESCE(p_endpoints, '{}'), updated_at = now() WHERE id;
  PERFORM etna_platform._log('AI_LOCAL_ENDPOINTS_CHANGED', 'success', 'admin', NULL, NULL, NULL, jsonb_build_object('endpoints', to_jsonb(p_endpoints)));
END;
$$;

CREATE OR REPLACE FUNCTION etna_platform.admin_ai_local_endpoints()
RETURNS TEXT[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = etna_platform, pg_temp
AS $$
BEGIN
  PERFORM etna_platform._require_admin(ARRAY['super_admin', 'support', 'auditor', 'security_officer'], false);
  RETURN (SELECT s.ai_local_endpoints FROM etna_platform.settings s WHERE s.id);
END;
$$;

-- ─── Jobs ────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.ps_job_permission(p_kind TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE p_kind
    WHEN 'dataset.provision' THEN 'datasets.schema'
    WHEN 'dataset.alter' THEN 'datasets.schema'
    WHEN 'dataset.delete' THEN 'datasets.delete'
    WHEN 'dataset.export' THEN 'datasets.export'
    WHEN 'import.analyze' THEN 'datasets.import'
    WHEN 'import.commit' THEN 'datasets.import'
    WHEN 'pipeline.run' THEN 'pipelines.run'
    WHEN 'connector.test' THEN 'integrations.use'
    WHEN 'connector.sync' THEN 'integrations.use'
    WHEN 'connector.oauth' THEN 'integrations.manage'
    WHEN 'connector.describe' THEN 'integrations.use'
    WHEN 'ai.test' THEN 'integrations.manage'
    WHEN 'ai.analyze' THEN 'datasets.query'
    ELSE NULL
  END;
$$;
REVOKE ALL ON FUNCTION public.ps_job_permission(TEXT) FROM PUBLIC, anon, authenticated;

DO $$
DECLARE
  f TEXT;
BEGIN
  FOREACH f IN ARRAY ARRAY['ps_worker.ai_provider_get(uuid,uuid)', 'ps_worker.ai_provider_tested(uuid,boolean,text)',
                           'ps_worker.ai_usage_record(uuid,uuid,uuid,boolean,integer,integer,numeric,jsonb)'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO etna_worker', f);
  END LOOP;
  FOREACH f IN ARRAY ARRAY['public.ps_save_ai_provider(uuid,uuid,text,text,jsonb,boolean,boolean,text)', 'public.ps_delete_ai_provider(uuid)',
                           'public.ps_set_ai_personal_key(uuid,text)', 'public.ps_has_ai_personal_key(uuid)',
                           'public.ps_set_ai_policy(uuid,uuid,boolean,text[],integer)', 'public.ps_set_ai_settings(uuid,numeric,text,text)',
                           'public.ps_ai_budget(uuid)', 'public.ps_start_decision(uuid,text,text,jsonb)',
                           'public.ps_finish_decision(uuid,boolean,text,text,jsonb,jsonb,numeric,jsonb,text,text,boolean)',
                           'public.ps_request_review(uuid,text)', 'public.ps_review_decision(uuid,text)',
                           'public.ps_set_dataset_entity(uuid,text,text,text,boolean,jsonb)',
                           'etna_platform.admin_set_ai_local_endpoints(text[])', 'etna_platform.admin_ai_local_endpoints()'] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f);
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.ps__require_policy_manager(UUID) FROM PUBLIC, anon, authenticated;
