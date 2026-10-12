'use client';

import React, { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { loadCompanyProfile, type CompanyProfile } from '../../../lib/companyProfile';
import { hrService, type Payslip } from '../../../lib/hrService';
import { PRINT_CSS, PrintMessage, PrintToolbar } from '../../PrintSheet';

// One payslip per page.
const PAYSLIP_CSS = `${PRINT_CSS}
@media print { .payslip { break-after: page; } .payslip:last-child { break-after: auto; } }`;

export default function PrintPayslipsPage() {
  const { runId } = useParams<{ runId: string }>();
  const { t, fmt } = useI18n();
  const [slips, setSlips] = useState<Payslip[] | null>(null);
  const [company, setCompany] = useState<{ profile: CompanyProfile; erpName: string } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const list = await hrService.payslips(runId);
      if (list.length === 0) throw new Error();
      const c = await loadCompanyProfile(list[0].workspaceId);
      if (cancelled) return;
      setSlips(list);
      setCompany({ profile: c.profile, erpName: c.erpName });
    })().catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (failed) return <PrintMessage text={t('print.notFound')} />;
  if (!slips || !company) return <PrintMessage text={t('common.loading')} />;

  const { profile, erpName } = company;
  const hours = (minutes: number) => fmt.number(minutes / 60, { maximumFractionDigits: 2 });
  const regularMinutes = (s: Payslip) => Math.max(0, s.workedMinutes - s.overtimeMinutes);

  return (
    <div className="min-h-[100dvh] bg-[var(--surface-2)] print:bg-white">
      <style>{PAYSLIP_CSS}</style>
      <PrintToolbar />
      {slips.map((s) => {
        const earnings: [string, number][] = [
          [t('print.regularPay', { hours: hours(regularMinutes(s)) }), s.regular],
          ...(s.overtime > 0
            ? ([[t('print.overtimePay', { hours: hours(s.overtimeMinutes) }), s.overtime]] as [
                string,
                number,
              ][])
            : []),
          ...(s.leavePay > 0
            ? ([[t('print.leavePay', { days: s.leaveDays }), s.leavePay]] as [string, number][])
            : []),
          ...(s.holidayPay > 0
            ? ([[t('print.holidayPay', { days: s.holidayDays }), s.holidayPay]] as [
                string,
                number,
              ][])
            : []),
          ...s.items
            .filter((i) => i.kind === 'allowance')
            .map((i): [string, number] => [
              i.method === 'percent' ? `${i.name} (${fmt.number(i.rate)}%)` : i.name,
              i.amount,
            ]),
        ];
        const deductions = s.items
          .filter((i) => i.kind === 'deduction')
          .map((i): [string, number] => [
            i.method === 'percent' ? `${i.name} (${fmt.number(i.rate)}%)` : i.name,
            i.amount,
          ]);
        const employer = s.items.filter((i) => i.kind === 'employer');
        return (
          <article
            key={s.employeeId}
            className="payslip mx-auto my-6 w-full max-w-[210mm] bg-white p-[14mm] text-[11px] leading-relaxed text-black shadow print:m-0 print:max-w-none print:p-0 print:shadow-none"
          >
            <header className="flex items-start justify-between gap-6 border-b-2 border-black pb-4">
              <div className="flex items-start gap-4">
                {profile.logo && (
                  // eslint-disable-next-line @next/next/no-img-element -- a data URL, not a remote image
                  <img src={profile.logo} alt="" className="max-h-14 max-w-[40mm] object-contain" />
                )}
                <div>
                  <p className="text-[14px] font-bold">{profile.legal_name || erpName}</p>
                  {profile.address && <p className="whitespace-pre-line">{profile.address}</p>}
                  {profile.city && <p>{profile.city}</p>}
                </div>
              </div>
              <div className="text-right">
                <p className="text-[18px] font-bold uppercase tracking-wide">
                  {t('print.payslip')}
                  {s.status === 'reversed' ? ` (${t('print.reversed')})` : ''}
                </p>
                <p>
                  {t('print.period')}: {fmt.date(s.periodFrom)} – {fmt.date(s.periodTo)}
                </p>
                <p>
                  {t('print.payDate')}: {fmt.date(s.payDate)}
                </p>
              </div>
            </header>

            <section className="mt-4">
              <p className="text-[9px] font-semibold uppercase tracking-wider text-neutral-600">
                {t('print.employee')}
              </p>
              <p className="text-[13px] font-semibold">{s.name}</p>
              <p>{[s.employeeCode, s.position].filter(Boolean).join(' · ')}</p>
            </section>

            <div className="mt-5 grid grid-cols-2 gap-6">
              <table className="w-full self-start">
                <thead>
                  <tr className="border-y border-black">
                    <th className="px-1 py-1 text-left font-semibold">{t('print.earnings')}</th>
                    <th className="px-1 py-1 text-right font-semibold">{t('print.amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {earnings.map(([label, value]) => (
                    <tr key={label} className="border-b border-neutral-300">
                      <td className="px-1 py-1">{label}</td>
                      <td className="px-1 py-1 text-right tabular-nums">{fmt.money(value)}</td>
                    </tr>
                  ))}
                  <tr className="font-bold">
                    <td className="px-1 py-1">{t('print.grossPay')}</td>
                    <td className="px-1 py-1 text-right tabular-nums">{fmt.money(s.gross)}</td>
                  </tr>
                </tbody>
              </table>
              <table className="w-full self-start">
                <thead>
                  <tr className="border-y border-black">
                    <th className="px-1 py-1 text-left font-semibold">
                      {t('print.deductionsHead')}
                    </th>
                    <th className="px-1 py-1 text-right font-semibold">{t('print.amount')}</th>
                  </tr>
                </thead>
                <tbody>
                  {deductions.map(([label, value]) => (
                    <tr key={label} className="border-b border-neutral-300">
                      <td className="px-1 py-1">{label}</td>
                      <td className="px-1 py-1 text-right tabular-nums">{fmt.money(value)}</td>
                    </tr>
                  ))}
                  <tr className="font-bold">
                    <td className="px-1 py-1">{t('print.totalDeductions')}</td>
                    <td className="px-1 py-1 text-right tabular-nums">{fmt.money(s.deductions)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="mt-6 flex items-center justify-between border-y-2 border-black py-2 text-[14px] font-bold">
              <span>{t('print.netPay')}</span>
              <span className="tabular-nums">{fmt.money(s.net)}</span>
            </div>

            {employer.length > 0 && (
              <p className="mt-3 text-[10px] text-neutral-600">
                {t('print.employerNote', {
                  items: employer.map((i) => `${i.name} ${fmt.money(i.amount)}`).join(', '),
                })}
              </p>
            )}

            <section className="mt-12 flex justify-between gap-6 break-inside-avoid">
              {[t('print.authorizedBy'), t('print.employeeSign')].map((label) => (
                <div key={label} className="w-[45mm] text-center">
                  <p>{label}</p>
                  <div className="mt-16 border-t border-black" />
                </div>
              ))}
            </section>

            {profile.footer_note && (
              <footer className="mt-8 border-t border-neutral-300 pt-2 text-center text-[9px] text-neutral-600 whitespace-pre-line">
                {profile.footer_note}
              </footer>
            )}
          </article>
        );
      })}
    </div>
  );
}
