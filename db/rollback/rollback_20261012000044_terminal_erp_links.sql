-- Rollback for 20261012000044_terminal_erp_links.sql.
-- Links between TERMINALs and ERPs are removed; pipelines that name an ERP
-- then fail until the node is changed.

BEGIN;
DROP FUNCTION IF EXISTS public.ps_unlink_erp(UUID);
DROP FUNCTION IF EXISTS public.ps_link_erp(UUID, UUID);
DROP TABLE IF EXISTS public.ps_erp_links;
COMMIT;
