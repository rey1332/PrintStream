-- Repair customer access for authenticated ERP users.
-- Rebuild all policies so stale restrictive policies cannot block valid writes.
DO $$
DECLARE
  existing_policy RECORD;
BEGIN
  FOR existing_policy IN
    SELECT policyname
    FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'erp_customers'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.erp_customers', existing_policy.policyname);
  END LOOP;
END;
$$;

ALTER TABLE public.erp_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_customers ALTER COLUMN user_id SET DEFAULT auth.uid();

CREATE POLICY erp_customers_manage_own
  ON public.erp_customers
  AS PERMISSIVE
  FOR ALL
  TO authenticated
  USING (user_id = (SELECT auth.uid()))
  WITH CHECK (user_id = (SELECT auth.uid()));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.erp_customers TO authenticated;
