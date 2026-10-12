'use client';

import React from 'react';
import { useRouter } from 'next/navigation';
import { ArrowLeft, Printer } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import type { CompanyProfile } from '../lib/companyProfile';
import { UNIT_LABEL, isUnit } from '@/lib/units';

/** An order line as printed: product code and unit included. */
export interface PrintLine {
  product_name: string;
  qty: number | string;
  price: number | string;
  unit?: string | null;
  subtotal?: number | string | null;
  qty_delivered?: number | string | null;
  product?: { sku?: string | null } | null;
}

/** Columns to load for printed order lines (with the product's code). */
export const PRINT_LINE_SELECT =
  'product_name, qty, price, unit, subtotal, qty_delivered, product:erp_products(sku)';
export const PRINT_PO_LINE_SELECT =
  'product_name, qty, price, unit, subtotal, product:erp_products(sku)';
export const PRINT_INVOICE_LINE_SELECT =
  'description, qty, price, unit, subtotal, product:erp_products(sku)';

export function lineDescription(l: PrintLine): string {
  const sku = l.product?.sku?.trim();
  return sku ? `${l.product_name} (${sku})` : l.product_name;
}

/** "12.5 m³": the quantity with its unit. */
export function useQtyText() {
  const { t, fmt } = useI18n();
  return (qty: number | string | null | undefined, unit?: string | null) =>
    `${fmt.number(Number(qty ?? 0))}${isUnit(unit) ? ` ${t(UNIT_LABEL[unit])}` : ''}`;
}

/** The line amount as stored (rounded to cents), or quantity × price. */
export const lineAmount = (l: PrintLine) =>
  l.subtotal !== null && l.subtotal !== undefined
    ? Number(l.subtotal)
    : Number(l.price) * Number(l.qty);

export interface PrintParty {
  heading: string;
  name: string;
  lines: string[];
}

export interface PrintColumn {
  label: string;
  align?: 'left' | 'right';
}

export interface PrintSheetProps {
  profile: CompanyProfile;
  erpName: string;
  title: string;
  docNo: string | null;
  meta: [string, string][];
  party?: PrintParty;
  columns?: PrintColumn[];
  rows?: string[][];
  totals?: { label: string; value: string; strong?: boolean }[];
  notes?: string;
  signatures?: string[];
  showBank?: boolean;
  children?: React.ReactNode;
}

export const PRINT_CSS = `@page { size: A4; margin: 14mm; }
@media print { html, body { background: #fff !important; } }`;

export function PrintToolbar() {
  const { t } = useI18n();
  const router = useRouter();
  return (
    <div className="print:hidden sticky top-0 z-10 flex items-center justify-between gap-2 border-b border-border bg-card px-4 py-2">
      <button
        type="button"
        onClick={() => router.back()}
        className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-[0.8rem] text-foreground hover:bg-[var(--surface-3)] max-lg:min-h-11"
      >
        <ArrowLeft size={14} /> {t('print.back')}
      </button>
      <span className="hidden text-[0.75rem] text-muted-foreground sm:block">
        {t('print.hint')}
      </span>
      <button
        type="button"
        onClick={() => window.print()}
        className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[0.8rem] font-medium text-primary-foreground max-lg:min-h-11"
      >
        <Printer size={14} /> {t('print.print')}
      </button>
    </div>
  );
}

export function PrintMessage({ text }: { text: string }) {
  return (
    <div className="min-h-[100dvh] bg-background">
      <PrintToolbar />
      <p className="p-8 text-center text-[0.85rem] text-muted-foreground">{text}</p>
    </div>
  );
}

export function PrintSheet(props: PrintSheetProps) {
  const { profile, erpName, title, docNo, meta, party, columns, rows, totals, notes, signatures } =
    props;
  const showBank = props.showBank ?? true;
  const { t } = useI18n();
  const company = profile.legal_name || erpName;
  const contact = [profile.phone, profile.email, profile.website].filter(Boolean).join(' · ');
  return (
    <div className="min-h-[100dvh] bg-[var(--surface-2)] print:bg-white">
      <style>{PRINT_CSS}</style>
      <PrintToolbar />
      <article className="mx-auto my-6 w-full max-w-[210mm] bg-white p-[14mm] text-[11px] leading-relaxed text-black shadow print:m-0 print:max-w-none print:p-0 print:shadow-none">
        <header className="flex items-start justify-between gap-6 border-b-2 border-black pb-4">
          <div className="flex items-start gap-4">
            {profile.logo && (
              // eslint-disable-next-line @next/next/no-img-element -- a data URL, not a remote image
              <img src={profile.logo} alt="" className="max-h-16 max-w-[45mm] object-contain" />
            )}
            <div>
              <p className="text-[15px] font-bold">{company}</p>
              {profile.address && <p className="whitespace-pre-line">{profile.address}</p>}
              {profile.city && <p>{profile.city}</p>}
              {contact && <p>{contact}</p>}
              {profile.tax_id && (
                <p>
                  {t('print.taxId')}: {profile.tax_id}
                </p>
              )}
            </div>
          </div>
          <div className="text-right">
            <p className="text-[18px] font-bold uppercase tracking-wide">{title}</p>
            {docNo && <p className="font-mono text-[12px]">{docNo}</p>}
          </div>
        </header>

        <section className="mt-5 flex justify-between gap-6">
          {party ? (
            <div className="max-w-[55%]">
              <p className="text-[9px] font-semibold uppercase tracking-wider text-neutral-600">
                {party.heading}
              </p>
              <p className="font-semibold">{party.name}</p>
              {party.lines.filter(Boolean).map((line, i) => (
                <p key={i} className="whitespace-pre-line">
                  {line}
                </p>
              ))}
            </div>
          ) : (
            <div />
          )}
          <table className="text-right">
            <tbody>
              {meta.map(([label, value]) => (
                <tr key={label}>
                  <td className="pr-3 text-neutral-600">{label}</td>
                  <td className="font-medium">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>

        {columns && rows && (
          <table className="mt-6 w-full border-collapse">
            <thead>
              <tr className="border-y border-black">
                {columns.map((c) => (
                  <th
                    key={c.label}
                    className={`px-2 py-1.5 font-semibold ${c.align === 'right' ? 'text-right' : 'text-left'}`}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-b border-neutral-300">
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className={`px-2 py-1.5 align-top ${columns[j]?.align === 'right' ? 'text-right tabular-nums' : ''}`}
                    >
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {props.children}

        {totals && totals.length > 0 && (
          <table className="ml-auto mt-4 min-w-[45%]">
            <tbody>
              {totals.map((row) => (
                <tr key={row.label} className={row.strong ? 'border-t border-black font-bold' : ''}>
                  <td className="py-1 pr-4">{row.label}</td>
                  <td className="py-1 text-right tabular-nums">{row.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {notes && (
          <section className="mt-6">
            <p className="text-[9px] font-semibold uppercase tracking-wider text-neutral-600">
              {t('print.notes')}
            </p>
            <p className="whitespace-pre-line">{notes}</p>
          </section>
        )}

        {showBank && profile.bank_details && (
          <section className="mt-4">
            <p className="text-[9px] font-semibold uppercase tracking-wider text-neutral-600">
              {t('print.payTo')}
            </p>
            <p className="whitespace-pre-line">{profile.bank_details}</p>
          </section>
        )}

        {signatures && signatures.length > 0 && (
          <section className="mt-12 flex justify-between gap-6 break-inside-avoid">
            {signatures.map((label) => (
              <div key={label} className="w-[45mm] text-center">
                <p>{label}</p>
                <div className="mt-16 border-t border-black" />
              </div>
            ))}
          </section>
        )}

        {profile.footer_note && (
          <footer className="mt-8 border-t border-neutral-300 pt-2 text-center text-[9px] text-neutral-600 whitespace-pre-line">
            {profile.footer_note}
          </footer>
        )}
      </article>
    </div>
  );
}
