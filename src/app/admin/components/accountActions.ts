import type { MessageKey } from '@/lib/i18n/messages';
import type { useI18n } from '@/lib/i18n/I18nProvider';
import type { ActionDialogProps } from './ActionDialog';

// The account actions offered on the account list and on an account's page.
// Each mirrors a database rule (etna_platform._target, admin_close_account);
// the database decides.

export type Dialog = Omit<ActionDialogProps, 'onClose'>;
type T = ReturnType<typeof useI18n>['t'];
/** Sends the action to /api/admin/platform/users/:id; resolves to an error message or null. */
export type Act = (body: Record<string, unknown>, done: MessageKey) => Promise<string | null>;

export function enableDialog(t: T, email: string, act: Act): Dialog {
  return {
    title: t('padmin.users.enable'),
    description: t('padmin.users.enableBody', { email }),
    confirmLabel: t('padmin.users.enable'),
    onConfirm: () => act({ action: 'enable' }, 'padmin.users.enabled'),
  };
}

export function disableDialog(t: T, email: string, act: Act): Dialog {
  return {
    title: t('padmin.users.disable'),
    description: t('padmin.users.disableBody', { email }),
    confirmLabel: t('padmin.users.disable'),
    danger: true,
    note: { label: t('padmin.users.reason'), minLength: 3 },
    onConfirm: ({ note }) => act({ action: 'disable', reason: note }, 'padmin.users.disabledDone'),
  };
}

export function closeDialog(t: T, email: string, act: Act): Dialog {
  return {
    title: t('padmin.users.close'),
    description: t('padmin.users.closeBody', { email }),
    confirmLabel: t('padmin.users.close'),
    danger: true,
    note: { label: t('padmin.users.reason'), minLength: 3 },
    confirmText: { label: t('padmin.users.closeConfirm', { email }), expected: email },
    onConfirm: ({ note, typed }) =>
      act({ action: 'close', reason: note, confirmEmail: typed }, 'padmin.users.closedDone'),
  };
}

/** Who may do what to an account, as the database allows it. */
export function accountRights(
  role: string | null,
  target: { admin_role: string | null; closed: boolean },
  self: boolean
) {
  const manage =
    !target.closed &&
    (role === 'super_admin' || role === 'support') &&
    (!target.admin_role || role === 'super_admin');
  return {
    manage,
    toggle: manage && !self,
    resetLink: manage && !self,
    close: !target.closed && role === 'super_admin' && !self && !target.admin_role,
  };
}
