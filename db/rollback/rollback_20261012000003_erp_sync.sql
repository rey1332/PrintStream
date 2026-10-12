-- Rollback for 20261012000003_erp_sync.sql.
-- Run only after redeploying an app version from before sync between ERPs.
--
-- Removes sync: links, change times, runs, state and the sync inbox (pending
-- inbox items are lost; post them first). Data already copied between ERPs
-- stays where it is.

BEGIN;

DROP FUNCTION IF EXISTS public.erp_sync_inbox_dismiss(UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_sync_inbox_post(UUID, NUMERIC);
DROP FUNCTION IF EXISTS public.erp_sync_inbox_list(UUID);
DROP FUNCTION IF EXISTS public.erp_sync_set_enabled(UUID, BOOLEAN);
DROP FUNCTION IF EXISTS public.erp_sync_overview();
DROP FUNCTION IF EXISTS public.erp_sync_finish(UUID);
DROP FUNCTION IF EXISTS public.erp_sync_step(UUID, UUID, TEXT);
DROP FUNCTION IF EXISTS public.erp_sync_start(UUID, UUID[], TEXT, TEXT[], DATE);
DROP FUNCTION IF EXISTS public.erp_sync__docs(TEXT, UUID, UUID, DATE);
DROP FUNCTION IF EXISTS public.erp_sync__set_stock(public.erp_products, INTEGER, TEXT, TIMESTAMPTZ);
-- With decimal quantities (20261012000015).
DROP FUNCTION IF EXISTS public.erp_sync__set_stock(public.erp_products, NUMERIC, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.erp_sync__stock(UUID, UUID, BOOLEAN, BOOLEAN);
DROP FUNCTION IF EXISTS public.erp_sync__apply(TEXT, UUID, JSONB, JSONB);
DROP FUNCTION IF EXISTS public.erp_sync__insert(TEXT, JSONB, UUID, UUID, NUMERIC);
DROP FUNCTION IF EXISTS public.erp_sync__master(TEXT, UUID, UUID, BOOLEAN, BOOLEAN);
DROP FUNCTION IF EXISTS public.erp_sync__add(JSONB, JSONB);
DROP FUNCTION IF EXISTS public.erp_sync__empty();
DROP FUNCTION IF EXISTS public.erp_sync__count(JSONB, TEXT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.erp_sync__price_rate(UUID, UUID);
DROP FUNCTION IF EXISTS public.erp_sync__can(UUID);
DROP FUNCTION IF EXISTS public.erp_sync__match(TEXT, UUID, UUID, UUID);
DROP FUNCTION IF EXISTS public.erp_sync__link(TEXT, UUID, UUID, UUID, UUID);
DROP FUNCTION IF EXISTS public.erp_sync__linked(TEXT, UUID, UUID, UUID);
DROP FUNCTION IF EXISTS public.erp_sync__set_clock(UUID, TEXT, TIMESTAMPTZ);
DROP FUNCTION IF EXISTS public.erp_sync__clock_at(UUID, TEXT);

DROP TRIGGER IF EXISTS trg_erp_sync_clock ON public.erp_customers;
DROP TRIGGER IF EXISTS trg_erp_sync_clock ON public.erp_suppliers;
DROP TRIGGER IF EXISTS trg_erp_sync_clock ON public.erp_products;
DROP FUNCTION IF EXISTS public.erp_sync__clock();
DROP FUNCTION IF EXISTS public.erp_sync__key_sql(TEXT);
DROP FUNCTION IF EXISTS public.erp_sync__fields(TEXT);
DROP FUNCTION IF EXISTS public.erp_sync__table(TEXT);

DROP TABLE IF EXISTS public.erp_sync_inbox;
DROP TABLE IF EXISTS public.erp_sync_state;
DROP TABLE IF EXISTS public.erp_sync_runs;
DROP TABLE IF EXISTS public.erp_sync_field_clock;
DROP TABLE IF EXISTS public.erp_sync_links;

ALTER TABLE public.erp_workspaces DROP COLUMN IF EXISTS sync_enabled;

COMMIT;
