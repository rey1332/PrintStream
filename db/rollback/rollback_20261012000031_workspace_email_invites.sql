-- Rollback for 20261012000031_workspace_email_invites.sql.
-- Run only after redeploying an app version from before this change.
-- Accounts created through e-mail invitations stay (they are ordinary
-- accounts); the invitations keep their codes but lose the address.

BEGIN;
DROP FUNCTION IF EXISTS public.erp_invitation_mail_result(UUID, BOOLEAN);
DROP FUNCTION IF EXISTS public.erp_invite_by_email(UUID, TEXT, TEXT, UUID, INTEGER, TEXT);
DROP INDEX IF EXISTS public.idx_erp_workspace_invitations_email;
ALTER TABLE public.erp_workspace_invitations DROP COLUMN IF EXISTS created_account;
ALTER TABLE public.erp_workspace_invitations DROP COLUMN IF EXISTS email;
COMMIT;
