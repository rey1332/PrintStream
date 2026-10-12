import type { MessageKey } from '@/lib/i18n/messages';

export type AdminRole = 'super_admin' | 'support' | 'auditor' | 'security_officer';
export const ADMIN_ROLES: readonly AdminRole[] = [
  'super_admin',
  'support',
  'auditor',
  'security_officer',
];

export const ROLE_LABEL: Record<AdminRole, MessageKey> = {
  super_admin: 'padmin.role.super_admin',
  support: 'padmin.role.support',
  auditor: 'padmin.role.auditor',
  security_officer: 'padmin.role.security_officer',
};

export const ROLE_DESCRIPTION: Record<AdminRole, MessageKey> = {
  super_admin: 'padmin.roleDesc.super_admin',
  support: 'padmin.roleDesc.support',
  auditor: 'padmin.roleDesc.auditor',
  security_officer: 'padmin.roleDesc.security_officer',
};

// Every event the security log can hold (etna_platform.security_events).
export const EVENT_LABEL: Record<string, MessageKey> = {
  LOGIN_SUCCEEDED: 'padmin.event.LOGIN_SUCCEEDED',
  LOGIN_FAILED: 'padmin.event.LOGIN_FAILED',
  LOGIN_RATE_LIMITED: 'padmin.event.LOGIN_RATE_LIMITED',
  LOGOUT: 'padmin.event.LOGOUT',
  PASSWORD_CHANGED: 'padmin.event.PASSWORD_CHANGED',
  PASSWORD_CHANGE_FAILED: 'padmin.event.PASSWORD_CHANGE_FAILED',
  PASSWORD_CHECK_FAILED: 'padmin.event.PASSWORD_CHECK_FAILED',
  MFA_FACTOR_ADDED: 'padmin.event.MFA_FACTOR_ADDED',
  MFA_FACTOR_REMOVED: 'padmin.event.MFA_FACTOR_REMOVED',
  MFA_CHALLENGE_SUCCEEDED: 'padmin.event.MFA_CHALLENGE_SUCCEEDED',
  MFA_CHALLENGE_FAILED: 'padmin.event.MFA_CHALLENGE_FAILED',
  MFA_RATE_LIMITED: 'padmin.event.MFA_RATE_LIMITED',
  ADMIN_REAUTHENTICATED: 'padmin.event.ADMIN_REAUTHENTICATED',
  ADMIN_REAUTH_FAILED: 'padmin.event.ADMIN_REAUTH_FAILED',
  ADMIN_ROLE_GRANTED: 'padmin.event.ADMIN_ROLE_GRANTED',
  ADMIN_ROLE_CHANGED: 'padmin.event.ADMIN_ROLE_CHANGED',
  ADMIN_ROLE_REVOKED: 'padmin.event.ADMIN_ROLE_REVOKED',
  USER_CREATED: 'padmin.event.USER_CREATED',
  ADMIN_PASSWORD_SET: 'padmin.event.ADMIN_PASSWORD_SET',
  SESSIONS_REVOKED: 'padmin.event.SESSIONS_REVOKED',
  MFA_RESET: 'padmin.event.MFA_RESET',
  USER_DISABLED: 'padmin.event.USER_DISABLED',
  USER_ENABLED: 'padmin.event.USER_ENABLED',
  SECURITY_LOG_RETENTION_CHANGED: 'padmin.event.SECURITY_LOG_RETENTION_CHANGED',
  SECURITY_LOG_PURGED: 'padmin.event.SECURITY_LOG_PURGED',
  ADMIN_PASSWORD_RESET_INITIATED: 'padmin.event.ADMIN_PASSWORD_RESET_INITIATED',
  PASSWORD_RESET_COMPLETED: 'padmin.event.PASSWORD_RESET_COMPLETED',
  PASSWORD_RESET_FAILED: 'padmin.event.PASSWORD_RESET_FAILED',
  WORKSPACE_SUSPENDED: 'padmin.event.WORKSPACE_SUSPENDED',
  WORKSPACE_REACTIVATED: 'padmin.event.WORKSPACE_REACTIVATED',
  TERMS_DRAFT_SAVED: 'padmin.event.TERMS_DRAFT_SAVED',
  TERMS_DRAFT_DELETED: 'padmin.event.TERMS_DRAFT_DELETED',
  TERMS_PUBLISHED: 'padmin.event.TERMS_PUBLISHED',
  TERMS_ACCEPTED: 'padmin.event.TERMS_ACCEPTED',
  TERMS_DECLINED: 'padmin.event.TERMS_DECLINED',
  WORKSPACE_MEMBER_ADDED: 'padmin.event.WORKSPACE_MEMBER_ADDED',
  WORKSPACE_ROLE_CHANGED: 'padmin.event.WORKSPACE_ROLE_CHANGED',
  WORKSPACE_MEMBER_REMOVED: 'padmin.event.WORKSPACE_MEMBER_REMOVED',
  WORKSPACE_MEMBER_LEFT: 'padmin.event.WORKSPACE_MEMBER_LEFT',
  ERP_RESET: 'padmin.event.ERP_RESET',
  ERP_EMPTIED: 'padmin.event.ERP_EMPTIED',
  ERP_DELETED: 'padmin.event.ERP_DELETED',
  COMPANY_CREATED: 'padmin.event.COMPANY_CREATED',
  ACCOUNT_ERP_LIMIT_CHANGED: 'padmin.event.ACCOUNT_ERP_LIMIT_CHANGED',
  WORKSPACE_MODULES_CHANGED: 'padmin.event.WORKSPACE_MODULES_CHANGED',
  ANNOUNCEMENT_CREATED: 'padmin.event.ANNOUNCEMENT_CREATED',
  ANNOUNCEMENT_CANCELLED: 'padmin.event.ANNOUNCEMENT_CANCELLED',
  BACKUP_STARTED: 'padmin.event.BACKUP_STARTED',
  EMAIL_TEST_SENT: 'padmin.event.EMAIL_TEST_SENT',
  ADMIN_EXPORT: 'padmin.event.ADMIN_EXPORT',
  INVITE_EMAILED: 'padmin.event.INVITE_EMAILED',
  ACCOUNT_CLOSED: 'padmin.event.ACCOUNT_CLOSED',
  STAFF_ACCESS_STARTED: 'padmin.event.STAFF_ACCESS_STARTED',
  STAFF_ACCESS_ENDED: 'padmin.event.STAFF_ACCESS_ENDED',
  RETENTION_POLICY_CHANGED: 'padmin.event.RETENTION_POLICY_CHANGED',
  WORKSPACE_RETENTION_CHANGED: 'padmin.event.WORKSPACE_RETENTION_CHANGED',
  RETENTION_PURGED: 'padmin.event.RETENTION_PURGED',
  LEGAL_HOLD_SET: 'padmin.event.LEGAL_HOLD_SET',
  LEGAL_HOLD_RELEASED: 'padmin.event.LEGAL_HOLD_RELEASED',
  WORKSPACE_TERMINATION_STARTED: 'padmin.event.WORKSPACE_TERMINATION_STARTED',
  WORKSPACE_TERMINATION_CANCELLED: 'padmin.event.WORKSPACE_TERMINATION_CANCELLED',
  WORKSPACE_TERMINATION_CONFIRMED: 'padmin.event.WORKSPACE_TERMINATION_CONFIRMED',
  WORKSPACE_DATA_DELETED: 'padmin.event.WORKSPACE_DATA_DELETED',
  STORAGE_WARNING: 'padmin.event.STORAGE_WARNING',
  CONNECTOR_NETWORKS_CHANGED: 'padmin.event.CONNECTOR_NETWORKS_CHANGED',
  COMPANY_EXPORT_REQUESTED: 'padmin.event.COMPANY_EXPORT_REQUESTED',
  COMPANY_EXPORT_READY: 'padmin.event.COMPANY_EXPORT_READY',
  COMPANY_EXPORT_FAILED: 'padmin.event.COMPANY_EXPORT_FAILED',
  STORAGE_REQUESTED: 'padmin.event.STORAGE_REQUESTED',
  STORAGE_QUOTA_CHANGED: 'padmin.event.STORAGE_QUOTA_CHANGED',
  STORAGE_DEFAULTS_CHANGED: 'padmin.event.STORAGE_DEFAULTS_CHANGED',
  STORAGE_DIR_CHANGED: 'padmin.event.STORAGE_DIR_CHANGED',
  WORKSPACE_OWNER_CHANGED: 'padmin.event.WORKSPACE_OWNER_CHANGED',
};

export const ACTOR_KIND_LABEL: Record<string, MessageKey> = {
  user: 'padmin.log.actorKind.user',
  admin: 'padmin.log.actorKind.admin',
  cli: 'padmin.log.actorKind.cli',
  system: 'padmin.log.actorKind.system',
};

const ERROR_KEYS: Record<string, MessageKey> = {
  not_allowed: 'padmin.err.not_allowed',
  mfa_required: 'padmin.err.mfa_required',
  self: 'padmin.err.self',
  not_found: 'padmin.err.not_found',
  invalid: 'padmin.err.invalid',
  exists: 'padmin.err.exists',
  already: 'padmin.err.already',
  placeholder: 'padmin.err.placeholder',
  owner: 'padmin.err.owner',
  workspace_limit: 'padmin.err.workspace_limit',
  busy: 'padmin.err.busy',
  mail_off: 'padmin.err.mail_off',
  mail_failed: 'padmin.err.mail_failed',
  closed: 'padmin.err.closed',
  confirm: 'padmin.err.confirm',
  is_admin: 'padmin.err.is_admin',
  owns_workspace: 'padmin.err.owns_workspace',
  personal: 'padmin.err.personal',
  not_member: 'padmin.err.not_member',
  too_early: 'padmin.err.too_early',
  legal_hold: 'padmin.err.legal_hold',
  not_confirmed: 'padmin.err.not_confirmed',
  blocked: 'padmin.err.blocked',
};

export const errorKey = (code: string): MessageKey => ERROR_KEYS[code] ?? 'padmin.err.failed';

// Workspace roles (owner, admin, finance, ...): the ERP's own labels.
const WORKSPACE_ROLES = ['owner', 'admin', 'finance', 'sales', 'inventory', 'viewer'] as const;
export const workspaceRoleKey = (role: string): MessageKey | null =>
  (WORKSPACE_ROLES as readonly string[]).includes(role) ? (`role.${role}` as MessageKey) : null;

// Roles an admin may give in a workspace (never Owner).
export const GRANTABLE_WORKSPACE_ROLES = ['admin', 'finance', 'sales', 'inventory'] as const;
