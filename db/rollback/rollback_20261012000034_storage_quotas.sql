-- Rollback for 20261012000034_storage_quotas.sql.
-- Run only after redeploying an app version from before this change.
-- Quotas, company storage folders and measurements are removed; files stay
-- where they are (move company folders back into ETNA_DATA_ROOT\documents
-- with ETNA.bat first if any were assigned).

BEGIN;
DROP FUNCTION IF EXISTS public.erp_workspace_storage_dir(UUID);
DROP FUNCTION IF EXISTS etna_admin.set_workspace_storage_dir(UUID, TEXT);
DROP FUNCTION IF EXISTS etna_platform.admin_set_storage_defaults(BIGINT, BIGINT, BIGINT);
DROP FUNCTION IF EXISTS etna_platform.admin_storage_defaults();
DROP FUNCTION IF EXISTS etna_platform.admin_set_workspace_quota(UUID, BIGINT, BOOLEAN, BIGINT, TEXT);
DROP FUNCTION IF EXISTS etna_platform.admin_workspace_storage(UUID);
DROP FUNCTION IF EXISTS public.erp_request_storage(UUID, TEXT);
DROP FUNCTION IF EXISTS etna_platform.measure_erp_estimate();
DROP FUNCTION IF EXISTS etna_platform.record_storage_measure(UUID, BIGINT, BIGINT, BIGINT);
DROP FUNCTION IF EXISTS public.erp_release_storage(UUID, BIGINT);
DROP FUNCTION IF EXISTS public.erp_reserve_storage(UUID, BIGINT, TEXT, TEXT);
DROP FUNCTION IF EXISTS etna_platform._check_storage_warning(UUID);
DROP FUNCTION IF EXISTS public.erp_upload_limits(UUID);
DROP FUNCTION IF EXISTS public.erp_storage_usage(UUID);
DROP FUNCTION IF EXISTS etna_platform.storage_state(UUID);
DROP TABLE IF EXISTS etna_platform.storage_requests;
DROP TABLE IF EXISTS etna_platform.storage_reservations;
DROP TABLE IF EXISTS etna_platform.workspace_storage;
ALTER TABLE etna_platform.settings DROP COLUMN IF EXISTS xlsx_max_upload_bytes;
ALTER TABLE etna_platform.settings DROP COLUMN IF EXISTS default_max_upload_bytes;
ALTER TABLE etna_platform.settings DROP COLUMN IF EXISTS default_quota_bytes;
COMMIT;
