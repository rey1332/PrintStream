-- ─── ERP Settings Migration ───────────────────────────────────────────────────
-- Table: erp_settings (alert thresholds and preferences per user)

CREATE TABLE IF NOT EXISTS public.erp_settings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  cash_low_threshold NUMERIC(15,2) NOT NULL DEFAULT 5000,
  expense_spike_ratio NUMERIC(5,2) NOT NULL DEFAULT 85,
  inventory_low_threshold NUMERIC(15,2) NOT NULL DEFAULT 10000,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_erp_settings_user_id ON public.erp_settings(user_id);

ALTER TABLE public.erp_settings ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "users_manage_own_erp_settings" ON public.erp_settings;
CREATE POLICY "users_manage_own_erp_settings" ON public.erp_settings
FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP TRIGGER IF EXISTS update_erp_settings_updated_at ON public.erp_settings;
CREATE TRIGGER update_erp_settings_updated_at
  BEFORE UPDATE ON public.erp_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
