-- Rollback for 20261012000045_home_widgets.sql. Home widgets are removed.

BEGIN;
DROP TABLE IF EXISTS public.home_widgets;
DROP FUNCTION IF EXISTS public.home_widgets_check();
COMMIT;
