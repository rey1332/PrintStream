'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Banknote, Contact, Loader2, Pencil, Plus, Search, Trash2, Wallet, X } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { useWorkspace } from '../../lib/WorkspaceContext';
import { HrError, hrService, type Employee, type EmployeeInput } from '../../lib/hrService';
import { PayItemsDialog } from '../../components/PayItemsDialog';
import { PayTermsDialog } from '../../components/PayTermsDialog';

const emptyInput = (): EmployeeInput => ({
  employee_code: '',
  name: '',
  position: '',
  phone: '',
  hourly_rate: 0,
  overtime_rate: 0,
  normal_hours: 8,
  is_active: true,
});

const inputCls =
  'w-full rounded-lg border border-border bg-[var(--input,transparent)] px-3 py-2 text-[0.8rem] text-foreground outline-none focus:border-foreground/40';

export default function EmployeesPage() {
  const { t, fmt } = useI18n();
  const { active, hrReady } = useWorkspace();
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState<{ id: string | null; data: EmployeeInput } | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [payFor, setPayFor] = useState<Employee | null>(null);
  const [termsFor, setTermsFor] = useState<Employee | null>(null);

  const errorText = useCallback(
    (error: unknown) => t(error instanceof HrError ? error.key : 'hr.err.failed'),
    [t]
  );

  const load = useCallback(async () => {
    try {
      setEmployees(await hrService.employees(showInactive));
    } catch (error) {
      toast.error(errorText(error));
    } finally {
      setLoading(false);
    }
  }, [showInactive, errorText]);

  useEffect(() => {
    if (!hrReady) return;
    setLoading(true);
    void load();
  }, [hrReady, active?.id, load]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return employees;
    return employees.filter((e) =>
      [e.name, e.employeeCode, e.position, e.phone].some((v) => v.toLowerCase().includes(q))
    );
  }, [employees, query]);

  const openEdit = (e: Employee) => {
    setFormError('');
    setModal({
      id: e.id,
      data: {
        employee_code: e.employeeCode,
        name: e.name,
        position: e.position,
        phone: e.phone,
        hourly_rate: e.hourlyRate ?? 0,
        overtime_rate: e.overtimeRate ?? 0,
        normal_hours: e.normalHours,
        is_active: e.isActive,
      },
    });
  };

  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (!modal || saving) return;
    setSaving(true);
    setFormError('');
    try {
      await hrService.saveEmployee(modal.id, {
        ...modal.data,
        name: modal.data.name.trim(),
        employee_code: modal.data.employee_code.trim(),
      });
      toast.success(
        t(modal.id ? 'hr.emp.updated' : 'hr.emp.added', { name: modal.data.name.trim() })
      );
      setModal(null);
      await load();
    } catch (error) {
      setFormError(errorText(error));
    } finally {
      setSaving(false);
    }
  }

  async function setActive(e: Employee, isActive: boolean) {
    try {
      await hrService.saveEmployee(e.id, {
        employee_code: e.employeeCode,
        name: e.name,
        position: e.position,
        phone: e.phone,
        hourly_rate: e.hourlyRate ?? 0,
        overtime_rate: e.overtimeRate ?? 0,
        normal_hours: e.normalHours,
        is_active: isActive,
      });
      await load();
    } catch (error) {
      toast.error(errorText(error));
    }
  }

  async function remove(e: Employee) {
    if (e.hasAttendance) {
      if (window.confirm(t('hr.emp.confirmDeactivate', { name: e.name })))
        await setActive(e, false);
      return;
    }
    if (!window.confirm(t('hr.emp.confirmDelete', { name: e.name }))) return;
    try {
      await hrService.deleteEmployee(e.id);
      toast.success(t('hr.emp.deleted'));
      await load();
    } catch (error) {
      toast.error(errorText(error));
    }
  }

  const set = <K extends keyof EmployeeInput>(key: K, value: EmployeeInput[K]) =>
    setModal((m) => (m ? { ...m, data: { ...m.data, [key]: value } } : m));
  const money = (value: number | null) => (value === null ? '—' : fmt.money(value));

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-[1.25rem] font-bold text-foreground">{t('erp.nav.employees')}</h1>
          <p className="text-[0.8rem] text-muted-foreground mt-0.5">
            {loading
              ? t('common.loading')
              : t('hr.emp.count', { count: employees.filter((e) => e.isActive).length })}
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setFormError('');
            setModal({ id: null, data: emptyInput() });
          }}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground max-lg:min-h-11"
        >
          <Plus size={14} /> {t('hr.emp.add')}
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border border-border bg-card px-3 sm:max-w-xs">
          <Search size={14} className="shrink-0 text-muted-foreground" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('hr.emp.searchPlaceholder')}
            aria-label={t('hr.emp.searchPlaceholder')}
            className="min-w-0 flex-1 bg-transparent text-[0.8rem] text-foreground outline-none"
          />
        </div>
        <label className="flex items-center gap-2 text-[0.78rem] text-muted-foreground">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          {t('hr.emp.showInactive')}
        </label>
      </div>

      {loading ? (
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 rounded-lg animate-pulse bg-[var(--surface-3)]" />
          ))}
        </div>
      ) : employees.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-12 text-center">
          <Contact size={32} className="mx-auto text-muted-foreground mb-3 opacity-40" />
          <p className="text-[0.85rem] text-foreground font-medium mb-1">{t('hr.emp.empty')}</p>
          <p className="text-[0.75rem] text-muted-foreground">{t('hr.emp.emptyHint')}</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full text-[0.8rem]">
            <thead className="bg-[var(--surface-2)] text-left text-[0.7rem] text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">{t('hr.emp.name')}</th>
                <th className="px-4 py-2 font-medium max-md:hidden">{t('hr.emp.position')}</th>
                <th className="px-4 py-2 font-medium text-right">{t('hr.emp.hourlyRate')}</th>
                <th className="px-4 py-2 font-medium text-right">{t('hr.emp.overtimeRate')}</th>
                <th className="px-4 py-2 font-medium text-right max-sm:hidden">
                  {t('hr.emp.normalHours')}
                </th>
                <th className="px-4 py-2 font-medium">{t('common.status')}</th>
                <th className="px-4 py-2">
                  <span className="sr-only">{t('common.actions')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((e) => (
                <tr key={e.id} className="border-t border-border">
                  <td className="px-4 py-2">
                    <p className="font-medium text-foreground">{e.name}</p>
                    <p className="text-[0.7rem] text-muted-foreground">
                      {[e.employeeCode, e.phone].filter(Boolean).join(' · ')}
                    </p>
                  </td>
                  <td className="px-4 py-2 text-muted-foreground max-md:hidden">
                    {e.position || '—'}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{money(e.hourlyRate)}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{money(e.overtimeRate)}</td>
                  <td className="px-4 py-2 text-right tabular-nums max-sm:hidden">
                    {t('hr.hoursValue', { hours: fmt.number(e.normalHours) })}
                  </td>
                  <td className="px-4 py-2">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[0.68rem] font-medium ${e.isActive ? 'bg-green-100 text-green-700 dark:bg-green-950/30 dark:text-green-400' : 'bg-[var(--surface-3)] text-muted-foreground'}`}
                    >
                      {t(e.isActive ? 'hr.emp.active' : 'hr.emp.inactive')}
                    </span>
                  </td>
                  <td className="px-2 py-1 text-right whitespace-nowrap">
                    <button
                      type="button"
                      onClick={() => setTermsFor(e)}
                      title={t('hr.terms.open')}
                      aria-label={`${t('hr.terms.open')}: ${e.name}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--surface-3)] hover:text-foreground max-lg:h-11 max-lg:w-11"
                    >
                      <Banknote size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setPayFor(e)}
                      title={t('hr.items.open')}
                      aria-label={`${t('hr.items.open')}: ${e.name}`}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--surface-3)] hover:text-foreground max-lg:h-11 max-lg:w-11"
                    >
                      <Wallet size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => openEdit(e)}
                      title={t('common.edit')}
                      aria-label={t('common.edit')}
                      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--surface-3)] hover:text-foreground max-lg:h-11 max-lg:w-11"
                    >
                      <Pencil size={14} />
                    </button>
                    {e.isActive ? (
                      <button
                        type="button"
                        onClick={() => void remove(e)}
                        title={t(e.hasAttendance ? 'hr.emp.deactivate' : 'common.delete')}
                        aria-label={t(e.hasAttendance ? 'hr.emp.deactivate' : 'common.delete')}
                        className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-[var(--surface-3)] hover:text-red-600 max-lg:h-11 max-lg:w-11"
                      >
                        <Trash2 size={14} />
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => void setActive(e, true)}
                        className="rounded-md border border-border px-2 py-1 text-[0.72rem] text-foreground hover:bg-[var(--surface-3)] max-lg:min-h-11"
                      >
                        {t('hr.emp.reactivate')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal && (
        <div
          className="overlay-mobile fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <form
            onSubmit={save}
            role="dialog"
            aria-modal="true"
            aria-labelledby="employee-title"
            className="w-full max-w-lg max-h-[90dvh] overflow-y-auto rounded-2xl border border-border bg-card p-5 space-y-4"
          >
            <div className="flex items-center justify-between">
              <h2 id="employee-title" className="text-[1rem] font-semibold text-foreground">
                {t(modal.id ? 'hr.emp.editTitle' : 'hr.emp.addTitle')}
              </h2>
              <button
                type="button"
                onClick={() => setModal(null)}
                aria-label={t('common.close')}
                className="p-1 text-muted-foreground hover:text-foreground"
              >
                <X size={16} />
              </button>
            </div>

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                  {t('hr.emp.name')} *
                </span>
                <input
                  autoFocus
                  required
                  maxLength={120}
                  value={modal.data.name}
                  onChange={(e) => set('name', e.target.value)}
                  className={inputCls}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                  {t('hr.emp.code')}
                </span>
                <input
                  maxLength={40}
                  value={modal.data.employee_code}
                  onChange={(e) => set('employee_code', e.target.value)}
                  className={inputCls}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                  {t('hr.emp.position')}
                </span>
                <input
                  maxLength={120}
                  value={modal.data.position}
                  onChange={(e) => set('position', e.target.value)}
                  className={inputCls}
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                  {t('hr.emp.phone')}
                </span>
                <input
                  maxLength={40}
                  inputMode="tel"
                  value={modal.data.phone}
                  onChange={(e) => set('phone', e.target.value)}
                  className={inputCls}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                  {t('hr.emp.hourlyRate')}
                </span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  required
                  value={modal.data.hourly_rate}
                  onChange={(e) => set('hourly_rate', Number(e.target.value))}
                  className={inputCls}
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                  {t('hr.emp.overtimeRate')}
                </span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  required
                  value={modal.data.overtime_rate}
                  onChange={(e) => set('overtime_rate', Number(e.target.value))}
                  className={inputCls}
                />
              </label>
              <label className="block sm:col-span-2">
                <span className="mb-1 block text-[0.7rem] text-muted-foreground">
                  {t('hr.emp.normalHours')}
                </span>
                <input
                  type="number"
                  min={0.5}
                  max={24}
                  step="0.5"
                  required
                  value={modal.data.normal_hours}
                  onChange={(e) => set('normal_hours', Number(e.target.value))}
                  className={inputCls}
                />
                <span className="mt-1 block text-[0.7rem] text-muted-foreground">
                  {t('hr.emp.normalHoursHint')}
                </span>
              </label>
              {modal.id && (
                <label className="flex items-center gap-2 text-[0.78rem] text-foreground sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={modal.data.is_active}
                    onChange={(e) => set('is_active', e.target.checked)}
                  />
                  {t('hr.emp.active')}
                </label>
              )}
            </div>

            {formError && (
              <p className="text-[0.78rem] text-red-600 dark:text-red-400" role="alert">
                {formError}
              </p>
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setModal(null)}
                className="flex-1 py-2 rounded-lg text-[0.8rem] text-muted-foreground border border-border"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={saving || !modal.data.name.trim()}
                className="flex flex-1 items-center justify-center gap-2 py-2 rounded-lg text-[0.8rem] font-medium bg-primary text-primary-foreground disabled:opacity-50"
              >
                {saving && <Loader2 size={13} className="animate-spin" />}
                {saving ? t('common.saving') : t('common.save')}
              </button>
            </div>
          </form>
        </div>
      )}
      {termsFor && (
        <PayTermsDialog
          employeeId={termsFor.id}
          employeeName={termsFor.name}
          onClose={() => setTermsFor(null)}
        />
      )}
      {payFor && (
        <PayItemsDialog
          employeeId={payFor.id}
          employeeName={payFor.name}
          onClose={() => setPayFor(null)}
        />
      )}
    </div>
  );
}
