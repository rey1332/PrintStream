'use client';

import React, { useCallback, useEffect, useState } from 'react';
import { Loader2, ShieldCheck, Smartphone, Trash2 } from 'lucide-react';
import { createClient } from '@/lib/data/client';
import { useI18n } from '@/lib/i18n/I18nProvider';

const MAX_DEVICES = 10;

interface Device {
  id: string;
  name: string;
  createdAt: string;
}

interface Enrollment {
  factorId: string;
  qr: string;
  secret: string;
  first: boolean;
}

interface RecoveryStatus {
  remaining: number;
}

type Message = { ok: boolean; text: string } | null;

const buttonCls =
  'px-3 py-2 rounded-lg text-[0.78rem] border border-border text-foreground hover:bg-[var(--surface-3)] disabled:opacity-50';
const primaryCls =
  'flex items-center gap-2 px-3 py-2 rounded-lg text-[0.78rem] font-medium bg-primary text-primary-foreground disabled:opacity-50';

export function TwoFactorSettings() {
  const { t, fmt } = useI18n();
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null);
  const [deviceName, setDeviceName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [recovery, setRecovery] = useState<RecoveryStatus | null>(null);
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    const db = createClient();
    const { data } = await db.auth.mfa.listFactors();
    const verified = (data?.totp ?? [])
      .filter((f) => f.status === 'verified')
      .map((f) => ({
        id: f.id,
        name: f.friendly_name || 'Authenticator',
        createdAt: f.created_at,
      }));
    setDevices(verified);
    if (verified.length > 0) {
      const { data: status } = await db.rpc('erp_mfa_recovery_status');
      const row = Array.isArray(status) ? status[0] : status;
      setRecovery({ remaining: Number(row?.remaining ?? 0) });
    } else {
      setRecovery(null);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
    // Arriving from the sign-in page after using a recovery code.
    if (new URLSearchParams(window.location.search).get('mfa') === 'recovered') {
      setMessage({ ok: false, text: t('mfa.settings.recovered') });
    }
  }, [refresh, t]);

  const verifiedSession = async () => {
    const { data } = await createClient().auth.mfa.getAuthenticatorAssuranceLevel();
    if (data?.currentLevel === 'aal2') return true;
    setMessage({ ok: false, text: t('mfa.settings.needsVerify') });
    return false;
  };

  const generateCodes = async (): Promise<boolean> => {
    const { data, error } = await createClient().rpc('erp_mfa_generate_recovery_codes');
    if (error || !Array.isArray(data)) return false;
    setFreshCodes(data.map((r: { code: string }) => r.code));
    setCopied(false);
    return true;
  };

  const start = async () => {
    const first = devices.length === 0;
    const name =
      deviceName.trim().slice(0, 60) ||
      `ETNA ${new Date().toISOString().slice(0, 10)}${first ? '' : ` #${devices.length + 1}`}`;
    if (devices.some((d) => d.name.toLowerCase() === name.toLowerCase())) {
      setMessage({ ok: false, text: t('mfa.settings.nameTaken') });
      return;
    }
    setBusy(true);
    setMessage(null);
    if (!first && !(await verifiedSession())) {
      setBusy(false);
      return;
    }
    const db = createClient();
    try {
      // Remove half-finished enrollments so a new one can be created.
      const { data: existing } = await db.auth.mfa.listFactors();
      for (const f of existing?.all ?? []) {
        if (f.status !== 'verified') await db.auth.mfa.unenroll({ factorId: f.id });
      }
      const { data, error } = await db.auth.mfa.enroll({ factorType: 'totp', friendlyName: name });
      if (error || !data) throw error;
      setEnrollment({ factorId: data.id, qr: data.totp.qr_code, secret: data.totp.secret, first });
    } catch (error) {
      const text = String((error as { message?: string })?.message ?? '');
      setMessage({
        ok: false,
        text: /friendly name/i.test(text) ? t('mfa.settings.nameTaken') : t('mfa.settings.failed'),
      });
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!enrollment || code.length !== 6) return;
    setBusy(true);
    const { error } = await createClient().auth.mfa.challengeAndVerify({
      factorId: enrollment.factorId,
      code,
    });
    if (error) {
      setBusy(false);
      setMessage({
        ok: false,
        text: t(
          error.code === 'over_request_rate_limit' ? 'password.err.rateLimited' : 'mfa.invalidCode'
        ),
      });
      return;
    }
    // Verifying upgrades the session, so codes can be issued right away.
    const codesIssued = enrollment.first ? await generateCodes() : true;
    setBusy(false);
    setMessage(
      codesIssued
        ? {
            ok: true,
            text: enrollment.first ? t('mfa.settings.enabled') : t('mfa.settings.deviceAdded'),
          }
        : { ok: false, text: t('mfa.settings.failed') }
    );
    setEnrollment(null);
    setCode('');
    setDeviceName('');
    await refresh();
  };

  const cancel = async () => {
    if (enrollment)
      await createClient()
        .auth.mfa.unenroll({ factorId: enrollment.factorId })
        .catch(() => undefined);
    setEnrollment(null);
    setCode('');
  };

  const remove = async (device: Device) => {
    const last = devices.length === 1;
    const question = last
      ? t('mfa.settings.disableConfirm')
      : t('mfa.settings.removeConfirm', { name: device.name });
    if (!window.confirm(question)) return;
    setBusy(true);
    setMessage(null);
    if (!(await verifiedSession())) {
      setBusy(false);
      return;
    }
    const db = createClient();
    const { error } = await db.auth.mfa.unenroll({ factorId: device.id });
    // Codes belong to the setup being removed.
    if (!error && last) await db.rpc('erp_mfa_clear_recovery_codes');
    setBusy(false);
    setMessage(
      error
        ? { ok: false, text: t('mfa.settings.failed') }
        : { ok: true, text: last ? t('mfa.settings.disabled') : t('mfa.settings.deviceRemoved') }
    );
    if (last) setFreshCodes(null);
    await refresh();
  };

  const regenerate = async () => {
    if (!window.confirm(t('mfa.recovery.generateConfirm'))) return;
    setBusy(true);
    setMessage(null);
    if (await verifiedSession()) {
      if (!(await generateCodes())) setMessage({ ok: false, text: t('mfa.settings.failed') });
      await refresh();
    }
    setBusy(false);
  };

  const copyCodes = async () => {
    if (!freshCodes) return;
    try {
      await navigator.clipboard.writeText(freshCodes.join('\n'));
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const downloadCodes = async () => {
    if (!freshCodes) return;
    const { data } = await createClient().auth.getUser();
    const header = t('mfa.recovery.fileHeader', { email: data.user?.email ?? '' });
    const blob = new Blob([`${header}\n\n${freshCodes.join('\n')}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'etna-recovery-codes.txt';
    link.click();
    URL.revokeObjectURL(url);
  };

  const enabled = devices.length > 0;

  return (
    <section
      className="rounded-xl border border-border bg-card p-5 space-y-4"
      aria-labelledby="mfa-settings-title"
    >
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck size={16} className="text-foreground" />
          <h2 id="mfa-settings-title" className="text-[0.9rem] font-semibold text-foreground">
            {t('mfa.settings.title')}
          </h2>
        </div>
        {!loading && (
          <span
            className={`px-2 py-0.5 rounded-full text-[0.65rem] font-medium ${enabled ? 'bg-green-100 text-green-800 dark:bg-green-950/40 dark:text-green-300' : 'bg-[var(--surface-3)] text-muted-foreground'}`}
          >
            {enabled ? t('mfa.settings.on') : t('mfa.settings.off')}
          </span>
        )}
      </div>
      <p className="text-[0.78rem] text-muted-foreground">{t('mfa.settings.desc')}</p>

      {loading ? (
        <Loader2 size={14} className="animate-spin text-muted-foreground" />
      ) : enrollment ? (
        <form onSubmit={confirm} className="space-y-3">
          <p className="text-[0.78rem] text-foreground">{t('mfa.settings.scan')}</p>
          <img
            src={enrollment.qr}
            alt={t('mfa.settings.qrAlt')}
            width={176}
            height={176}
            className="rounded-md border border-border bg-white p-2"
          />
          <p className="text-[0.72rem] text-muted-foreground">
            {t('mfa.settings.secret')}{' '}
            <code className="select-all break-all text-foreground">{enrollment.secret}</code>
          </p>
          <label htmlFor="mfa-enroll-code" className="block text-[0.72rem] text-muted-foreground">
            {t('mfa.code')}
          </label>
          <input
            id="mfa-enroll-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="w-40 rounded-lg border border-border bg-input px-3 py-2 text-[0.95rem] tracking-[0.3em] font-mono text-foreground outline-none focus:border-foreground/40"
          />
          <div className="flex gap-2">
            <button type="submit" disabled={busy || code.length !== 6} className={primaryCls}>
              {busy && <Loader2 size={12} className="animate-spin" />}
              {t('mfa.settings.confirm')}
            </button>
            <button
              type="button"
              onClick={cancel}
              className="px-3 py-2 rounded-lg text-[0.78rem] border border-border text-muted-foreground"
            >
              {t('mfa.settings.cancel')}
            </button>
          </div>
        </form>
      ) : (
        <>
          {enabled && (
            <div className="space-y-2">
              <h3 className="text-[0.75rem] font-semibold text-foreground">
                {t('mfa.settings.devices')}
              </h3>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {devices.map((device) => (
                  <li key={device.id} className="flex items-center justify-between gap-3 px-3 py-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <Smartphone size={14} className="shrink-0 text-muted-foreground" />
                      <div className="min-w-0">
                        <p className="text-[0.78rem] text-foreground truncate">{device.name}</p>
                        <p className="text-[0.65rem] text-muted-foreground">
                          {t('mfa.settings.deviceAddedOn', { date: fmt.date(device.createdAt) })}
                        </p>
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => remove(device)}
                      disabled={busy}
                      className="flex items-center gap-1 px-2 py-1 rounded-md text-[0.72rem] text-muted-foreground hover:text-red-600 hover:bg-[var(--surface-3)] disabled:opacity-50"
                    >
                      <Trash2 size={12} />
                      {devices.length === 1 ? t('mfa.settings.disable') : t('mfa.settings.remove')}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {devices.length < MAX_DEVICES ? (
            <div className="space-y-2">
              {enabled && (
                <p className="text-[0.72rem] text-muted-foreground">
                  {t('mfa.settings.addDeviceDesc')}
                </p>
              )}
              <div className="flex flex-wrap items-end gap-2">
                <div>
                  <label
                    htmlFor="mfa-device-name"
                    className="block text-[0.7rem] text-muted-foreground mb-1"
                  >
                    {t('mfa.settings.deviceName')}
                  </label>
                  <input
                    id="mfa-device-name"
                    maxLength={60}
                    value={deviceName}
                    placeholder={t('mfa.settings.deviceNamePlaceholder')}
                    onChange={(e) => setDeviceName(e.target.value)}
                    className="w-52 rounded-lg border border-border bg-input px-3 py-2 text-[0.78rem] text-foreground outline-none focus:border-foreground/40"
                  />
                </div>
                <button
                  type="button"
                  onClick={start}
                  disabled={busy}
                  className={enabled ? buttonCls : primaryCls}
                >
                  {busy && !enabled && <Loader2 size={12} className="animate-spin" />}
                  {enabled ? t('mfa.settings.addDevice') : t('mfa.settings.enable')}
                </button>
              </div>
            </div>
          ) : (
            <p className="text-[0.72rem] text-muted-foreground">{t('mfa.settings.maxDevices')}</p>
          )}
        </>
      )}

      {freshCodes && (
        <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-950/30">
          <h3 className="text-[0.78rem] font-semibold text-foreground">
            {t('mfa.recovery.title')}
          </h3>
          <p className="text-[0.72rem] text-foreground">{t('mfa.recovery.saveNow')}</p>
          <ul className="grid grid-cols-2 gap-x-6 gap-y-1 font-mono text-[0.85rem] text-foreground select-all">
            {freshCodes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={copyCodes} className={buttonCls}>
              {copied ? t('mfa.recovery.copied') : t('mfa.recovery.copy')}
            </button>
            <button type="button" onClick={downloadCodes} className={buttonCls}>
              {t('mfa.recovery.download')}
            </button>
            <button type="button" onClick={() => setFreshCodes(null)} className={primaryCls}>
              {t('mfa.recovery.done')}
            </button>
          </div>
        </div>
      )}

      {enabled && !enrollment && !freshCodes && recovery && (
        <div className="space-y-2 border-t border-border pt-3">
          <h3 className="text-[0.75rem] font-semibold text-foreground">
            {t('mfa.recovery.title')}
          </h3>
          <p className="text-[0.72rem] text-muted-foreground">{t('mfa.recovery.desc')}</p>
          <p
            className={`text-[0.72rem] ${recovery.remaining <= 2 ? 'text-amber-700 dark:text-amber-400' : 'text-foreground'}`}
          >
            {recovery.remaining === 0
              ? t('mfa.recovery.none')
              : `${t('mfa.recovery.remaining', { count: fmt.number(recovery.remaining) })}${recovery.remaining <= 2 ? ` · ${t('mfa.recovery.low')}` : ''}`}
          </p>
          <button type="button" onClick={regenerate} disabled={busy} className={buttonCls}>
            {t('mfa.recovery.generate')}
          </button>
        </div>
      )}

      {message && (
        <p
          role="status"
          className={`text-[0.75rem] ${message.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}
        >
          {message.text}
        </p>
      )}
    </section>
  );
}
