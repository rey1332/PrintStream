'use client';

import React, { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { createClient } from '@/lib/data/client';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { loadCompanyProfile, type CompanyProfile } from '../../../lib/companyProfile';
import {
  PRINT_INVOICE_LINE_SELECT,
  PrintMessage,
  PrintSheet,
  lineAmount,
  lineDescription,
  useQtyText,
  type PrintLine,
} from '../../PrintSheet';

interface InvoiceRow {
  id: string;
  workspace_id: string | null;
  doc_no: string | null;
  customer_id: string | null;
  customer_name: string;
  invoice_date: string;
  due_date: string;
  total: number | string;
  tax_rate: number | string;
  tax_amount: number | string;
  amount_paid: number | string;
  currency: string | null;
  voided_at: string | null;
  sales_order_id: string | null;
}

interface Loaded {
  invoice: InvoiceRow;
  customer: { address?: string; city?: string; email?: string; phone?: string } | null;
  lines: PrintLine[];
  profile: CompanyProfile;
  erpName: string;
}

export default function PrintInvoicePage() {
  const { id } = useParams<{ id: string }>();
  const { t, fmt } = useI18n();
  const qtyText = useQtyText();
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const db = createClient();
      const { data: invoice, error } = await db
        .from('erp_invoices')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error || !invoice) throw new Error();
      const [customer, lines, company] = await Promise.all([
        invoice.customer_id
          ? db
              .from('erp_customers')
              .select('address, city, email, phone')
              .eq('id', invoice.customer_id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        // The invoice's own lines (erp_invoice_lines); older manual invoices have none.
        db
          .from('erp_invoice_lines')
          .select(PRINT_INVOICE_LINE_SELECT)
          .eq('invoice_id', invoice.id)
          .order('position'),
        loadCompanyProfile(invoice.workspace_id),
      ]);
      if (cancelled) return;
      setData({
        invoice: invoice as InvoiceRow,
        customer: customer.data ?? null,
        lines: ((lines.data ?? []) as (PrintLine & { description: string })[]).map((l) => ({
          ...l,
          product_name: l.description,
        })),
        profile: company.profile,
        erpName: company.erpName,
      });
    })().catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (failed) return <PrintMessage text={t('print.notFound')} />;
  if (!data) return <PrintMessage text={t('common.loading')} />;

  const { invoice, customer, lines, profile, erpName } = data;
  const money = (v: number | string) => fmt.moneyIn(Number(v), invoice.currency);
  const total = Number(invoice.total);
  const tax = Number(invoice.tax_amount);
  const paid = Number(invoice.amount_paid);
  const rows =
    lines.length > 0
      ? lines.map((l, i) => [
          String(i + 1),
          lineDescription(l),
          qtyText(l.qty, l.unit),
          money(l.price),
          money(lineAmount(l)),
        ])
      : [['1', t('print.invoiceLine'), '1', money(total - tax), money(total - tax)]];

  return (
    <PrintSheet
      profile={profile}
      erpName={erpName}
      title={invoice.voided_at ? `${t('print.invoice')} (${t('print.void')})` : t('print.invoice')}
      docNo={invoice.doc_no}
      meta={[
        [t('print.date'), fmt.date(invoice.invoice_date)],
        [t('print.dueDate'), fmt.date(invoice.due_date)],
        ...(invoice.currency
          ? ([[t('print.currency'), invoice.currency]] as [string, string][])
          : []),
      ]}
      party={{
        heading: t('print.billTo'),
        name: invoice.customer_name,
        lines: [
          customer?.address ?? '',
          customer?.city ?? '',
          [customer?.phone, customer?.email].filter(Boolean).join(' · '),
        ],
      }}
      columns={[
        { label: '#' },
        { label: t('print.description') },
        { label: t('print.qty'), align: 'right' },
        { label: t('print.price'), align: 'right' },
        { label: t('print.amount'), align: 'right' },
      ]}
      rows={rows}
      totals={[
        { label: t('print.subtotal'), value: money(total - tax) },
        ...(tax > 0
          ? [
              {
                label: t('print.tax', { rate: fmt.number(Number(invoice.tax_rate)) }),
                value: money(tax),
              },
            ]
          : []),
        { label: t('print.total'), value: money(total), strong: true },
        ...(paid > 0
          ? [
              { label: t('print.paid'), value: money(paid) },
              {
                label: t('print.balanceDue'),
                value: money(Math.max(0, total - paid)),
                strong: true,
              },
            ]
          : []),
      ]}
      signatures={[t('print.receivedBy'), t('print.authorizedBy')]}
    />
  );
}
