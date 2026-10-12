-- ─── ERP Module Migration ─────────────────────────────────────────────────────
-- Tables: user_profiles, erp_customers, erp_suppliers, erp_products,
--         erp_purchase_orders, erp_purchase_order_items,
--         erp_sales_orders, erp_sales_order_items,
--         erp_invoices, erp_payments, erp_transactions, erp_stock_movements

-- ─── 1. TYPES ─────────────────────────────────────────────────────────────────

-- Keep this migration safe to reapply: DROP TYPE ... CASCADE can silently
-- delete populated table columns and their dependent data.
DO $$ BEGIN CREATE TYPE public.po_status AS ENUM ('pending', 'approved', 'received');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.so_status AS ENUM ('draft', 'invoiced', 'delivered');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.invoice_status AS ENUM ('paid', 'unpaid', 'overdue');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.payment_type AS ENUM ('incoming', 'outgoing');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.transaction_type AS ENUM ('income', 'expense');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.stock_movement_type AS ENUM ('in', 'out');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── 2. CORE TABLES ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.user_profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.erp_customers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  balance NUMERIC(15,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.erp_suppliers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  balance NUMERIC(15,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.erp_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  sku TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '',
  purchase_price NUMERIC(15,2) NOT NULL DEFAULT 0,
  selling_price NUMERIC(15,2) NOT NULL DEFAULT 0,
  current_stock INTEGER NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 0,
  max_stock INTEGER NOT NULL DEFAULT 100,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.erp_purchase_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  supplier_id UUID REFERENCES public.erp_suppliers(id) ON DELETE SET NULL,
  supplier_name TEXT NOT NULL DEFAULT '',
  order_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status public.po_status NOT NULL DEFAULT 'pending',
  total NUMERIC(15,2) NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.erp_purchase_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_order_id UUID NOT NULL REFERENCES public.erp_purchase_orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.erp_products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL DEFAULT 1,
  price NUMERIC(15,2) NOT NULL DEFAULT 0,
  subtotal NUMERIC(15,2) GENERATED ALWAYS AS (qty * price) STORED
);

CREATE TABLE IF NOT EXISTS public.erp_sales_orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES public.erp_customers(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  order_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status public.so_status NOT NULL DEFAULT 'draft',
  total NUMERIC(15,2) NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.erp_sales_order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id UUID NOT NULL REFERENCES public.erp_sales_orders(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.erp_products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL DEFAULT 1,
  price NUMERIC(15,2) NOT NULL DEFAULT 0,
  subtotal NUMERIC(15,2) GENERATED ALWAYS AS (qty * price) STORED
);

CREATE TABLE IF NOT EXISTS public.erp_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  customer_id UUID REFERENCES public.erp_customers(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL DEFAULT '',
  invoice_date DATE NOT NULL DEFAULT CURRENT_DATE,
  due_date DATE NOT NULL DEFAULT CURRENT_DATE,
  status public.invoice_status NOT NULL DEFAULT 'unpaid',
  total NUMERIC(15,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.erp_payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  payment_type public.payment_type NOT NULL DEFAULT 'incoming',
  party TEXT NOT NULL DEFAULT '',
  amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  payment_date DATE NOT NULL DEFAULT CURRENT_DATE,
  method TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.erp_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  transaction_type public.transaction_type NOT NULL DEFAULT 'income',
  category TEXT NOT NULL DEFAULT '',
  amount NUMERIC(15,2) NOT NULL DEFAULT 0,
  transaction_date DATE NOT NULL DEFAULT CURRENT_DATE,
  description TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS public.erp_stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES public.user_profiles(id) ON DELETE CASCADE,
  product_id UUID REFERENCES public.erp_products(id) ON DELETE SET NULL,
  product_name TEXT NOT NULL DEFAULT '',
  movement_type public.stock_movement_type NOT NULL DEFAULT 'in',
  quantity INTEGER NOT NULL DEFAULT 0,
  movement_date DATE NOT NULL DEFAULT CURRENT_DATE,
  note TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- ─── 3. INDEXES ───────────────────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_erp_customers_user_id ON public.erp_customers(user_id);
CREATE INDEX IF NOT EXISTS idx_erp_suppliers_user_id ON public.erp_suppliers(user_id);
CREATE INDEX IF NOT EXISTS idx_erp_products_user_id ON public.erp_products(user_id);
CREATE INDEX IF NOT EXISTS idx_erp_purchase_orders_user_id ON public.erp_purchase_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_erp_purchase_orders_supplier_id ON public.erp_purchase_orders(supplier_id);
CREATE INDEX IF NOT EXISTS idx_erp_purchase_order_items_po_id ON public.erp_purchase_order_items(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_erp_sales_orders_user_id ON public.erp_sales_orders(user_id);
CREATE INDEX IF NOT EXISTS idx_erp_sales_orders_customer_id ON public.erp_sales_orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_erp_sales_order_items_so_id ON public.erp_sales_order_items(sales_order_id);
CREATE INDEX IF NOT EXISTS idx_erp_invoices_user_id ON public.erp_invoices(user_id);
CREATE INDEX IF NOT EXISTS idx_erp_payments_user_id ON public.erp_payments(user_id);
CREATE INDEX IF NOT EXISTS idx_erp_transactions_user_id ON public.erp_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_erp_stock_movements_user_id ON public.erp_stock_movements(user_id);

-- ─── 4. FUNCTIONS ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.user_profiles (id, email, full_name)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data->>'full_name', split_part(NEW.email, '@', 1))
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

-- ─── 5. ENABLE RLS ────────────────────────────────────────────────────────────

ALTER TABLE public.user_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_customers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_purchase_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_purchase_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_sales_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_sales_order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.erp_stock_movements ENABLE ROW LEVEL SECURITY;

-- ─── 6. RLS POLICIES ──────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "users_manage_own_user_profiles" ON public.user_profiles;
CREATE POLICY "users_manage_own_user_profiles" ON public.user_profiles
FOR ALL TO authenticated USING (id = auth.uid()) WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS "users_manage_own_erp_customers" ON public.erp_customers;
CREATE POLICY "users_manage_own_erp_customers" ON public.erp_customers
FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "users_manage_own_erp_suppliers" ON public.erp_suppliers;
CREATE POLICY "users_manage_own_erp_suppliers" ON public.erp_suppliers
FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "users_manage_own_erp_products" ON public.erp_products;
CREATE POLICY "users_manage_own_erp_products" ON public.erp_products
FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "users_manage_own_erp_purchase_orders" ON public.erp_purchase_orders;
CREATE POLICY "users_manage_own_erp_purchase_orders" ON public.erp_purchase_orders
FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "users_manage_own_erp_purchase_order_items" ON public.erp_purchase_order_items;
CREATE POLICY "users_manage_own_erp_purchase_order_items" ON public.erp_purchase_order_items
FOR ALL TO authenticated
USING (
  purchase_order_id IN (
    SELECT id FROM public.erp_purchase_orders WHERE user_id = auth.uid()
  )
)
WITH CHECK (
  purchase_order_id IN (
    SELECT id FROM public.erp_purchase_orders WHERE user_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "users_manage_own_erp_sales_orders" ON public.erp_sales_orders;
CREATE POLICY "users_manage_own_erp_sales_orders" ON public.erp_sales_orders
FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "users_manage_own_erp_sales_order_items" ON public.erp_sales_order_items;
CREATE POLICY "users_manage_own_erp_sales_order_items" ON public.erp_sales_order_items
FOR ALL TO authenticated
USING (
  sales_order_id IN (
    SELECT id FROM public.erp_sales_orders WHERE user_id = auth.uid()
  )
)
WITH CHECK (
  sales_order_id IN (
    SELECT id FROM public.erp_sales_orders WHERE user_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "users_manage_own_erp_invoices" ON public.erp_invoices;
CREATE POLICY "users_manage_own_erp_invoices" ON public.erp_invoices
FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "users_manage_own_erp_payments" ON public.erp_payments;
CREATE POLICY "users_manage_own_erp_payments" ON public.erp_payments
FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "users_manage_own_erp_transactions" ON public.erp_transactions;
CREATE POLICY "users_manage_own_erp_transactions" ON public.erp_transactions
FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

DROP POLICY IF EXISTS "users_manage_own_erp_stock_movements" ON public.erp_stock_movements;
CREATE POLICY "users_manage_own_erp_stock_movements" ON public.erp_stock_movements
FOR ALL TO authenticated USING (user_id = auth.uid()) WITH CHECK (user_id = auth.uid());

-- ─── 7. TRIGGERS ──────────────────────────────────────────────────────────────

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

DROP TRIGGER IF EXISTS update_erp_customers_updated_at ON public.erp_customers;
CREATE TRIGGER update_erp_customers_updated_at
  BEFORE UPDATE ON public.erp_customers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS update_erp_suppliers_updated_at ON public.erp_suppliers;
CREATE TRIGGER update_erp_suppliers_updated_at
  BEFORE UPDATE ON public.erp_suppliers
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS update_erp_products_updated_at ON public.erp_products;
CREATE TRIGGER update_erp_products_updated_at
  BEFORE UPDATE ON public.erp_products
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS update_erp_purchase_orders_updated_at ON public.erp_purchase_orders;
CREATE TRIGGER update_erp_purchase_orders_updated_at
  BEFORE UPDATE ON public.erp_purchase_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS update_erp_sales_orders_updated_at ON public.erp_sales_orders;
CREATE TRIGGER update_erp_sales_orders_updated_at
  BEFORE UPDATE ON public.erp_sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS update_erp_invoices_updated_at ON public.erp_invoices;
CREATE TRIGGER update_erp_invoices_updated_at
  BEFORE UPDATE ON public.erp_invoices
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();

-- ─── 8. DEMO USER ─────────────────────────────────────────────────────────────

DO $$
DECLARE
  demo_uuid UUID := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (
    id, instance_id, aud, role, email, encrypted_password, email_confirmed_at,
    created_at, updated_at, raw_user_meta_data, raw_app_meta_data,
    is_sso_user, is_anonymous, confirmation_token, confirmation_sent_at,
    recovery_token, recovery_sent_at, email_change_token_new, email_change,
    email_change_sent_at, email_change_token_current, email_change_confirm_status,
    reauthentication_token, reauthentication_sent_at, phone, phone_change,
    phone_change_token, phone_change_sent_at
  ) VALUES (
    demo_uuid, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated',
    'demo@etna-erp.com', crypt('demo1234', gen_salt('bf', 10)), now(), now(), now(),
    jsonb_build_object('full_name', 'Demo User'),
    jsonb_build_object('provider', 'email', 'providers', ARRAY['email']::TEXT[]),
    false, false, '', null, '', null, '', '', null, '', 0, '', null, null, '', '', null
  )
  ON CONFLICT (id) DO NOTHING;
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'Demo user creation skipped: %', SQLERRM;
END $$;
