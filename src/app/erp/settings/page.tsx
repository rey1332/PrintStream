'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { createClient } from '@/lib/data/client';
import { useWorkspace } from '../lib/WorkspaceContext';
import { rpcWorkspaceId } from '../lib/workspace';
import { LanguageSettings } from '../components/LanguageSettings';
import { InterfaceSettings } from '../components/InterfaceSettings';
import { TwoFactorSettings } from '../components/TwoFactorSettings';
import { ChangePasswordSettings } from '../components/ChangePasswordSettings';
import { CurrencySettingsPanel } from '../components/CurrencySettings';
import { DeleteErpSection } from '../components/DeleteErpSection';
import { CompanyProfileSettings } from '../components/CompanyProfileSettings';
import { IndustrySettings } from '../components/IndustrySettings';
import { GovernanceSettings } from '../components/GovernanceSettings';
import { BackupSettings } from '../components/BackupSettings';
import { UserAdminSettings } from '../components/UserAdminSettings';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { MessageKey } from '@/lib/i18n/messages';
import {
  Check,
  Settings,
  AlertTriangle,
  DollarSign,
  TrendingDown,
  Package,
  Trash2,
  Lock,
} from 'lucide-react';

interface ERPSettings {
  cashLowThreshold: number;
  expenseSpikeRatio: number;
  inventoryLowThreshold: number;
}

interface ApprovalRequest {
  id: string;
  owner_id: string;
  purchase_order_id: string;
  supplier_name: string;
  amount: number;
  approver_emails: string[];
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
}

const DEFAULTS: ERPSettings = {
  cashLowThreshold: 5000,
  expenseSpikeRatio: 85,
  inventoryLowThreshold: 10000,
};

export default function ERPSettingsPage() {
  const { user } = useAuth();
  const { active } = useWorkspace();
  const { t, fmt } = useI18n();
  const viewingSharedWorkspace = !!active && !active.isOwner;
  const [settings, setSettings] = useState<ERPSettings>(DEFAULTS);
  const [adminEmail, setAdminEmail] = useState('');
  const [isApprovalAdmin, setIsApprovalAdmin] = useState(false);
  // Owner and Admins change this ERP's settings; other members read the thresholds.
  const [canEdit, setCanEdit] = useState(false);
  const [approverEmailsText, setApproverEmailsText] = useState('');
  const [poApprovalThreshold, setPoApprovalThreshold] = useState(0);
  const [approvalRequests, setApprovalRequests] = useState<ApprovalRequest[]>([]);
  const [approvalLoading, setApprovalLoading] = useState(false);
  const [approvalError, setApprovalError] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  const [deleteConfirm, setDeleteConfirm] = useState('');
  const [deletePassword, setDeletePassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const [deleteSuccess, setDeleteSuccess] = useState(false);

  const [wipeConfirm, setWipeConfirm] = useState('');
  const [wipePassword, setWipePassword] = useState('');
  const [wiping, setWiping] = useState(false);
  const [wipeError, setWipeError] = useState('');
  const [wipeSuccess, setWipeSuccess] = useState(false);

  const CONFIRM_PHRASE = 'DELETE ALL';
  const WIPE_CONFIRM_PHRASE = 'DELETE EVERYTHING';

  const loadSettings = useCallback(async () => {
    if (!user?.id) return;
    setLoading(true);
    try {
      // The settings of the open ERP (db/migrations/20261012000005_erp_workspace_settings.sql).
      const { data, error: loadError } = await createClient().rpc('erp_workspace_settings_get', {
        p_workspace_id: rpcWorkspaceId(),
      });
      if (loadError) throw loadError;
      setSettings({
        cashLowThreshold: Number(data.cash_low_threshold),
        expenseSpikeRatio: Number(data.expense_spike_ratio),
        inventoryLowThreshold: Number(data.inventory_low_threshold),
      });
      setCanEdit(data.can_edit === true);
      const approvalData = data.approval;
      setIsApprovalAdmin(Boolean(approvalData));
      setAdminEmail(approvalData?.admin_email || user.email || '');
      setApproverEmailsText((approvalData?.approver_emails || []).join('\n'));
      setPoApprovalThreshold(Number(approvalData?.po_approval_threshold || 0));
      setApprovalLoading(true);
      const owner = active?.ownerId ? `&owner=${encodeURIComponent(active.ownerId)}` : '';
      const response = await fetch(`/api/erp/workflows?resource=approvals${owner}`, {
        cache: 'no-store',
      });
      const result = await response.json();
      if (response.ok && result.success) setApprovalRequests(result.data || []);
      else setApprovalError(result.error || t('settings.loadApprovalsFailed'));
    } catch {
      // No settings yet — use defaults
    } finally {
      setLoading(false);
      setApprovalLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t only formats the fallback message
  }, [user?.id, user?.email, active?.id, active?.ownerId]);

  useEffect(() => {
    loadSettings();
  }, [loadSettings]);

  async function decideApproval(requestId: string, decision: 'approved' | 'rejected') {
    setApprovalError('');
    const response = await fetch('/api/erp/workflows', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'decide', requestId, decision }),
    });
    const result = await response.json();
    if (!response.ok || !result.success) {
      setApprovalError(result.error || t('settings.decisionFailed'));
      return;
    }
    await loadSettings();
  }

  async function handleSave() {
    if (!user?.id || !canEdit) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const approverEmails = Array.from(
        new Set(
          approverEmailsText
            .split(/[\s,;]+/)
            .map((email) => email.trim().toLowerCase())
            .filter(Boolean)
        )
      );
      const invalidEmail = approverEmails.find(
        (email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      );
      if (invalidEmail) throw new Error(t('settings.invalidApprover', { email: invalidEmail }));
      const normalizedAdminEmail = adminEmail.trim().toLowerCase() || user.email || '';
      if (normalizedAdminEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedAdminEmail))
        throw new Error(t('settings.invalidAdminEmail'));
      if (poApprovalThreshold > 0 && approverEmails.length === 0) {
        throw new Error(t('settings.needApprover'));
      }
      const { error: saveError } = await createClient().rpc('erp_workspace_settings_set', {
        p_workspace_id: rpcWorkspaceId(),
        p_settings: {
          cash_low_threshold: settings.cashLowThreshold,
          expense_spike_ratio: settings.expenseSpikeRatio,
          inventory_low_threshold: settings.inventoryLowThreshold,
          admin_email: normalizedAdminEmail,
          approver_emails: approverEmails,
          po_approval_threshold: poApprovalThreshold,
        },
      });
      if (saveError) throw new Error(t('settings.saveFailed'));
      setApproverEmailsText(approverEmails.join('\n'));
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err: any) {
      setError(err?.message || t('settings.saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  function handleReset() {
    setSettings(DEFAULTS);
    setSaved(false);
    setError('');
  }

  async function resetErp(
    scope: 'transactions' | 'all',
    password: string
  ): Promise<MessageKey | null> {
    try {
      const response = await fetch('/api/erp/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope, password, workspaceId: rpcWorkspaceId() }),
      });
      const result = await response.json().catch(() => null);
      if (response.ok && result?.success) return null;
      switch (result?.error) {
        case 'wrong_password':
          return 'settings.wrongPassword';
        case 'rate_limited':
          return 'password.err.rateLimited';
        case 'forbidden':
          return 'settings.resetForbidden';
        default:
          return scope === 'all' ? 'settings.wipeFailed' : 'settings.deleteTxFailed';
      }
    } catch {
      return scope === 'all' ? 'settings.wipeFailed' : 'settings.deleteTxFailed';
    }
  }

  async function handleDeleteAllTransactions() {
    if (!user?.id || deleteConfirm !== CONFIRM_PHRASE || !deletePassword) return;
    setDeleting(true);
    setDeleteError('');
    setDeleteSuccess(false);
    const failure = await resetErp('transactions', deletePassword);
    setDeleting(false);
    if (failure) {
      setDeleteError(t(failure));
      return;
    }
    setDeleteSuccess(true);
    setDeleteConfirm('');
    setDeletePassword('');
    setTimeout(() => setDeleteSuccess(false), 5000);
  }

  async function handleDeleteAllData() {
    if (!user?.id || wipeConfirm !== WIPE_CONFIRM_PHRASE || !wipePassword) return;
    setWiping(true);
    setWipeError('');
    setWipeSuccess(false);
    const failure = await resetErp('all', wipePassword);
    setWiping(false);
    if (failure) {
      setWipeError(t(failure));
      return;
    }
    setWipeSuccess(true);
    setWipeConfirm('');
    setWipePassword('');
    setTimeout(() => setWipeSuccess(false), 5000);
  }

  // ✅ Solid colors — kontras di light & dark mode
  const inputCls =
    'w-full rounded-lg border border-zinc-200 dark:border-border bg-white dark:bg-input px-3 py-2 text-[0.85rem] text-zinc-900 dark:text-foreground placeholder:text-zinc-400 dark:placeholder:text-muted-foreground outline-none focus:border-zinc-400 dark:focus:border-foreground/40 transition-colors';

  // ✅ Khusus danger zone (border merah pas focus)
  const dangerInputCls =
    'w-full rounded-lg border border-zinc-200 dark:border-border bg-white dark:bg-input px-3 py-2 text-[0.85rem] text-zinc-900 dark:text-foreground placeholder:text-zinc-400 dark:placeholder:text-muted-foreground outline-none focus:border-red-500 dark:focus:border-red-500 transition-colors';

  const thresholdCards: {
    key: keyof ERPSettings;
    icon: React.ElementType;
    label: MessageKey;
    description: MessageKey;
    hint: MessageKey;
    unit: string;
    unitPos: 'prefix' | 'suffix';
    min: number;
    max?: number;
    step: number;
  }[] = [
    {
      key: 'cashLowThreshold',
      icon: DollarSign,
      label: 'settings.cashAlert',
      description: 'settings.cashAlertDesc',
      unit: '$',
      unitPos: 'prefix',
      min: 0,
      step: 500,
      hint: 'settings.cashAlertHint',
    },
    {
      key: 'expenseSpikeRatio',
      icon: TrendingDown,
      label: 'settings.expenseAlert',
      description: 'settings.expenseAlertDesc',
      unit: '%',
      unitPos: 'suffix',
      min: 1,
      max: 100,
      step: 1,
      hint: 'settings.expenseAlertHint',
    },
    {
      key: 'inventoryLowThreshold',
      icon: Package,
      label: 'settings.inventoryAlert',
      description: 'settings.inventoryAlertDesc',
      unit: '$',
      unitPos: 'prefix',
      min: 0,
      step: 500,
      hint: 'settings.inventoryAlertHint',
    },
  ];
  const withUnit = (value: number, unit: string, unitPos: 'prefix' | 'suffix') =>
    `${unitPos === 'prefix' ? unit : ''}${fmt.number(value)}${unitPos === 'suffix' ? unit : ''}`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-[1.25rem] font-bold text-foreground flex items-center gap-2">
            <Settings size={18} className="text-muted-foreground" />
            {t('settings.title')}
          </h1>
          <p className="text-[0.8rem] text-muted-foreground mt-0.5">{t('settings.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleReset}
            disabled={!canEdit}
            className="px-3 py-2 rounded-lg text-[0.8rem] text-muted-foreground border border-border bg-transparent hover:text-foreground transition-colors"
          >
            {t('settings.resetDefaults')}
          </button>
          <button
            onClick={handleSave}
            disabled={saving || !canEdit}
            className="flex items-center gap-2 px-4 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground disabled:opacity-50 transition-all"
          >
            {saving ? (
              t('common.saving')
            ) : saved ? (
              <>
                <Check size={13} /> {t('common.saved')}
              </>
            ) : (
              t('settings.save')
            )}
          </button>
        </div>
      </div>

      <LanguageSettings />
      <InterfaceSettings />
      <CurrencySettingsPanel />
      <ChangePasswordSettings />
      <TwoFactorSettings />

      {loading ? (
        <div className="flex items-center justify-center py-20">
          <div className="w-6 h-6 border-2 border-border border-t-foreground/60 rounded-full animate-spin" />
        </div>
      ) : (
        <>
          <CompanyProfileSettings inputClassName={inputCls} />
          <IndustrySettings />
          <GovernanceSettings />
          <UserAdminSettings inputClassName={inputCls} />
          <BackupSettings inputClassName={inputCls} />

          <div className="rounded-xl border border-border overflow-hidden bg-card">
            <div className="px-5 py-4 border-b border-border flex items-center gap-2">
              <AlertTriangle size={14} className="text-muted-foreground" />
              <h2 className="text-[0.85rem] font-semibold text-foreground">
                {t('settings.thresholds')}
              </h2>
            </div>
            <div className="divide-y" style={{ borderColor: 'var(--border)' }}>
              {thresholdCards.map(
                ({ key, icon: Icon, label, description, unit, unitPos, min, max, step, hint }) => (
                  <div
                    key={key}
                    className="px-5 py-5 flex flex-col sm:flex-row sm:items-start gap-4"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Icon size={14} className="text-muted-foreground flex-shrink-0" />
                        <span className="text-[0.85rem] font-medium text-foreground">
                          {t(label)}
                        </span>
                      </div>
                      <p className="text-[0.75rem] text-muted-foreground leading-relaxed">
                        {t(description)}
                      </p>
                      <p className="text-[0.7rem] text-muted-foreground opacity-70 mt-1.5 italic">
                        {t(hint)}
                      </p>
                    </div>
                    <div className="sm:w-48 flex-shrink-0">
                      <div className="relative">
                        {unitPos === 'prefix' && (
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[0.8rem] text-zinc-500 dark:text-muted-foreground">
                            {unit}
                          </span>
                        )}
                        <input
                          type="number"
                          min={min}
                          max={max}
                          step={step}
                          className={inputCls}
                          style={{
                            paddingLeft: unitPos === 'prefix' ? '1.75rem' : undefined,
                            paddingRight: unitPos === 'suffix' ? '2rem' : undefined,
                          }}
                          value={settings[key]}
                          disabled={!canEdit}
                          onChange={(e) =>
                            setSettings((prev) => ({ ...prev, [key]: Number(e.target.value) }))
                          }
                        />
                        {unitPos === 'suffix' && (
                          <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[0.8rem] text-zinc-500 dark:text-muted-foreground">
                            {unit}
                          </span>
                        )}
                      </div>
                      <div className="mt-2 flex items-center justify-between text-[0.68rem] text-muted-foreground">
                        <span>
                          {t('settings.current', { value: withUnit(settings[key], unit, unitPos) })}
                        </span>
                        <span>
                          {t('settings.default', { value: withUnit(DEFAULTS[key], unit, unitPos) })}
                        </span>
                      </div>
                    </div>
                  </div>
                )
              )}
            </div>
          </div>

          {isApprovalAdmin && (
            <section className="rounded-xl border border-border overflow-hidden bg-card">
              <div className="px-5 py-4 border-b border-border">
                <h2 className="text-[0.85rem] font-semibold text-foreground">
                  {t('settings.approvals')}
                </h2>
                <p className="text-[0.75rem] text-muted-foreground mt-1">
                  {t('settings.approvalsDesc')}
                </p>
              </div>
              <div className="p-5 grid gap-4 md:grid-cols-2">
                <div className="space-y-2">
                  <label className="block text-[0.72rem] font-medium text-foreground">
                    {t('settings.adminEmail')}
                  </label>
                  <input
                    type="email"
                    value={adminEmail}
                    onChange={(e) => setAdminEmail(e.target.value)}
                    className={inputCls}
                    placeholder={user?.email || 'admin@business.com'}
                  />
                  <p className="text-[0.68rem] text-muted-foreground">
                    {t('settings.adminEmailHint')}
                  </p>
                </div>
                <div className="space-y-2">
                  <label className="block text-[0.72rem] font-medium text-foreground">
                    {t('settings.poThreshold')}
                  </label>
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[0.8rem] text-muted-foreground">
                      $
                    </span>
                    <input
                      type="number"
                      min={0}
                      step="100"
                      value={poApprovalThreshold}
                      onChange={(e) => setPoApprovalThreshold(Math.max(0, Number(e.target.value)))}
                      className={inputCls}
                      style={{ paddingLeft: '1.75rem' }}
                    />
                  </div>
                  <p className="text-[0.68rem] text-muted-foreground">
                    {t('settings.poThresholdHint')}
                  </p>
                </div>
                <div className="md:col-span-2 space-y-2">
                  <label className="block text-[0.72rem] font-medium text-foreground">
                    {t('settings.approverEmails')}
                  </label>
                  <textarea
                    rows={4}
                    value={approverEmailsText}
                    onChange={(e) => setApproverEmailsText(e.target.value)}
                    className={inputCls}
                    placeholder={'finance@business.com\nmanager@business.com'}
                  />
                  <p className="text-[0.68rem] text-muted-foreground">
                    {t('settings.approverEmailsHint')}{' '}
                    <span className="font-mono">RESEND_API_KEY</span> {t('settings.and')}{' '}
                    <span className="font-mono">EMAIL_FROM</span>.
                  </p>
                </div>
              </div>
            </section>
          )}

          <section className="rounded-xl border border-border overflow-hidden bg-card">
            <div className="px-5 py-4 border-b border-border">
              <h2 className="text-[0.85rem] font-semibold text-foreground">
                {t('settings.inbox')}
              </h2>
              <p className="text-[0.75rem] text-muted-foreground mt-1">{t('settings.inboxDesc')}</p>
            </div>
            {approvalError && (
              <p className="mx-5 mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-[0.75rem] text-red-700 dark:border-red-900/50 dark:bg-red-950/20 dark:text-red-300">
                {approvalError}
              </p>
            )}
            {approvalLoading ? (
              <div className="px-5 py-6 text-[0.78rem] text-muted-foreground">
                {t('settings.loadingApprovals')}
              </div>
            ) : approvalRequests.length === 0 ? (
              <div className="px-5 py-6 text-[0.78rem] text-muted-foreground">
                {t('settings.noApprovals')}
              </div>
            ) : (
              <div className="divide-y divide-border">
                {approvalRequests.map((request) => {
                  const canDecide =
                    request.status === 'pending' &&
                    Boolean(user?.email) &&
                    request.approver_emails.includes(user.email.toLowerCase());
                  return (
                    <div
                      key={request.id}
                      className="flex flex-wrap items-center justify-between gap-3 px-5 py-4"
                    >
                      <div>
                        <p className="text-[0.8rem] font-medium text-foreground">
                          {request.supplier_name} · PO {request.purchase_order_id.slice(0, 8)}
                        </p>
                        <p className="text-[0.72rem] text-muted-foreground">
                          {fmt.money(Number(request.amount))} · {fmt.dateTime(request.created_at)}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="rounded-full border border-border px-2.5 py-1 text-[0.68rem] text-muted-foreground">
                          {t(`status.${request.status}`)}
                        </span>
                        {canDecide && (
                          <>
                            <button
                              onClick={() => decideApproval(request.id, 'rejected')}
                              className="rounded-lg border border-border px-3 py-1.5 text-[0.72rem] text-muted-foreground hover:text-foreground"
                            >
                              {t('settings.reject')}
                            </button>
                            <button
                              onClick={() => decideApproval(request.id, 'approved')}
                              className="rounded-lg bg-primary px-3 py-1.5 text-[0.72rem] font-medium text-primary-foreground"
                            >
                              {t('settings.approve')}
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <div className="rounded-xl border border-border bg-card p-5 space-y-3">
            <h2 className="text-[0.85rem] font-semibold text-foreground">
              {t('settings.preview')}
            </h2>
            <p className="text-[0.75rem] text-muted-foreground">{t('settings.previewDesc')}</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[
                {
                  label: t('settings.cashAlert'),
                  value: t('settings.below', { value: fmt.money(settings.cashLowThreshold) }),
                  color: '#ef4444',
                },
                {
                  label: t('settings.expenseAlert'),
                  value: t('settings.aboveOfCashIn', {
                    value: fmt.number(settings.expenseSpikeRatio),
                  }),
                  color: '#f59e0b',
                },
                {
                  label: t('settings.inventoryAlert'),
                  value: t('settings.below', { value: fmt.money(settings.inventoryLowThreshold) }),
                  color: '#f59e0b',
                },
              ].map((item) => (
                <div key={item.label} className="rounded-lg p-3 border border-border bg-background">
                  <div className="flex items-center gap-1.5 mb-1">
                    <div className="w-1.5 h-1.5 rounded-full" style={{ background: item.color }} />
                    <span className="text-[0.68rem] text-muted-foreground uppercase tracking-wider">
                      {item.label}
                    </span>
                  </div>
                  <p className="text-[0.8rem] font-medium text-foreground">{item.value}</p>
                </div>
              ))}
            </div>
          </div>

          {error && (
            <div className="rounded-lg px-4 py-3 text-[0.8rem] text-muted-foreground border border-border bg-muted">
              {error}
            </div>
          )}

          {viewingSharedWorkspace && (
            <p className="text-[0.75rem] text-muted-foreground rounded-lg border border-border px-4 py-3">
              {t('settings.sharedWorkspaceNote')}
            </p>
          )}
          <div
            className={`rounded-xl border overflow-hidden bg-card ${viewingSharedWorkspace ? 'hidden' : ''}`}
            style={{ borderColor: 'rgba(220,38,38,0.3)' }}
          >
            <div
              className="px-5 py-4 border-b flex items-center gap-2"
              style={{ borderColor: 'rgba(220,38,38,0.3)' }}
            >
              <Trash2 size={14} className="text-red-600 dark:text-red-400" />
              <h2 className="text-[0.85rem] font-semibold text-red-600 dark:text-red-400">
                {t('settings.danger')}
              </h2>
            </div>
            <div className="px-5 py-5 space-y-6">
              <div className="space-y-4">
                <div>
                  <p className="text-[0.85rem] font-medium text-foreground mb-1">
                    {t('settings.deleteTx')}
                  </p>
                  <p className="text-[0.75rem] text-muted-foreground leading-relaxed">
                    {t('settings.deleteTxDesc')}
                  </p>
                </div>

                <div
                  className="rounded-lg border p-4 space-y-3 bg-background"
                  style={{ borderColor: 'rgba(220,38,38,0.2)' }}
                >
                  <p className="text-[0.75rem] text-muted-foreground">
                    {t('settings.typeToConfirm', { phrase: CONFIRM_PHRASE })}
                  </p>
                  <input
                    type="text"
                    placeholder={CONFIRM_PHRASE}
                    value={deleteConfirm}
                    onChange={(e) => {
                      setDeleteConfirm(e.target.value);
                      setDeleteError('');
                      setDeleteSuccess(false);
                    }}
                    className={`${dangerInputCls} font-mono`}
                  />
                  <div>
                    <p className="text-[0.75rem] text-muted-foreground mb-1.5 flex items-center gap-1.5">
                      <Lock size={11} />
                      {t('settings.enterPassword')}
                    </p>
                    <input
                      type="password"
                      placeholder={t('auth.password')}
                      autoComplete="current-password"
                      value={deletePassword}
                      onChange={(e) => {
                        setDeletePassword(e.target.value);
                        setDeleteError('');
                        setDeleteSuccess(false);
                      }}
                      className={dangerInputCls}
                    />
                  </div>
                  <button
                    onClick={handleDeleteAllTransactions}
                    disabled={deleteConfirm !== CONFIRM_PHRASE || !deletePassword || deleting}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-[0.8rem] font-medium transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                    style={{
                      background:
                        deleteConfirm === CONFIRM_PHRASE && deletePassword
                          ? '#7f1d1d'
                          : 'var(--muted)',
                      color:
                        deleteConfirm === CONFIRM_PHRASE && deletePassword
                          ? '#fca5a5'
                          : 'var(--muted-foreground)',
                      border: '1px solid',
                      borderColor:
                        deleteConfirm === CONFIRM_PHRASE && deletePassword
                          ? '#991b1b'
                          : 'var(--border)',
                    }}
                  >
                    <Trash2 size={13} />
                    {deleting ? t('common.deleting') : t('settings.deleteTx')}
                  </button>
                </div>

                {deleteSuccess && (
                  <div className="flex items-center gap-2 rounded-lg px-4 py-3 text-[0.8rem] bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 text-emerald-700 dark:text-emerald-400">
                    <Check size={14} />
                    {t('settings.deleteTxDone')}
                  </div>
                )}
                {deleteError && (
                  <div className="rounded-lg px-4 py-3 text-[0.8rem] text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50">
                    {deleteError}
                  </div>
                )}
              </div>

              <div className="h-px" style={{ background: 'rgba(220,38,38,0.2)' }} />

              <div className="space-y-4">
                <div>
                  <p className="text-[0.85rem] font-medium text-foreground mb-1">
                    {t('settings.wipe')}
                  </p>
                  <p className="text-[0.75rem] text-muted-foreground leading-relaxed">
                    {t('settings.wipeDesc')}
                  </p>
                </div>

                <div
                  className="rounded-lg border p-4 space-y-3 bg-background"
                  style={{ borderColor: 'rgba(220,38,38,0.2)' }}
                >
                  <p className="text-[0.75rem] text-muted-foreground">
                    {t('settings.typeToConfirm', { phrase: WIPE_CONFIRM_PHRASE })}
                  </p>
                  <input
                    type="text"
                    placeholder={WIPE_CONFIRM_PHRASE}
                    value={wipeConfirm}
                    onChange={(e) => {
                      setWipeConfirm(e.target.value);
                      setWipeError('');
                      setWipeSuccess(false);
                    }}
                    className={`${dangerInputCls} font-mono`}
                  />

                  <div>
                    <p className="text-[0.75rem] text-muted-foreground mb-1.5 flex items-center gap-1.5">
                      <Lock size={11} />
                      {t('settings.enterPassword')}
                    </p>
                    <input
                      type="password"
                      placeholder={t('auth.password')}
                      autoComplete="current-password"
                      value={wipePassword}
                      onChange={(e) => {
                        setWipePassword(e.target.value);
                        setWipeError('');
                        setWipeSuccess(false);
                      }}
                      className={dangerInputCls}
                    />
                  </div>

                  <button
                    onClick={handleDeleteAllData}
                    disabled={wipeConfirm !== WIPE_CONFIRM_PHRASE || !wipePassword || wiping}
                    className="flex items-center gap-2 px-4 py-2 rounded-lg text-[0.8rem] font-medium transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                    style={{
                      background:
                        wipeConfirm === WIPE_CONFIRM_PHRASE && wipePassword
                          ? '#7f1d1d'
                          : 'var(--muted)',
                      color:
                        wipeConfirm === WIPE_CONFIRM_PHRASE && wipePassword
                          ? '#fca5a5'
                          : 'var(--muted-foreground)',
                      border: '1px solid',
                      borderColor:
                        wipeConfirm === WIPE_CONFIRM_PHRASE && wipePassword
                          ? '#991b1b'
                          : 'var(--border)',
                    }}
                  >
                    <Trash2 size={13} />
                    {wiping ? t('settings.wiping') : t('settings.wipe')}
                  </button>
                </div>

                {wipeSuccess && (
                  <div className="flex items-center gap-2 rounded-lg px-4 py-3 text-[0.8rem] bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-900/50 text-emerald-700 dark:text-emerald-400">
                    <Check size={14} />
                    {t('settings.wipeDone')}
                  </div>
                )}
                {wipeError && (
                  <div className="rounded-lg px-4 py-3 text-[0.8rem] text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-900/50">
                    {wipeError}
                  </div>
                )}
              </div>

              {active?.isOwner && !active.isPersonal && (
                <>
                  <div className="h-px" style={{ background: 'rgba(220,38,38,0.2)' }} />
                  <DeleteErpSection
                    workspaceId={active.id}
                    name={active.name}
                    inputClassName={dangerInputCls}
                  />
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
