'use client';

import React, { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { createClient } from '@/lib/data/client';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { loadCompanyProfile, type CompanyProfile } from '../../../lib/companyProfile';
import {
  PRINT_LINE_SELECT,
  PrintMessage,
  PrintSheet,
  lineAmount,
  lineDescription,
  useQtyText,
  type PrintLine,
} from '../../PrintSheet';

interface OrderRow {
  id: string;
  workspace_id: string | null;
  doc_no: string | null;
  customer_id: string | null;
  customer_name: string;
  order_date: string;
  status: string;
  total: number | string;
  currency: string | null;
  notes: string;
}

interface Loaded {
  order: OrderRow;
  customer: { address?: string; city?: string; email?: string; phone?: string } | null;
  lines: PrintLine[];
  profile: CompanyProfile;
  erpName: string;
}

export default function PrintSalesOrderPage() {
  const { id } = useParams<{ id: string }>();
  const { t, fmt } = useI18n();
  const qtyText = useQtyText();
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const db = createClient();
      const { data: order, error } = await db
        .from('erp_sales_orders')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error || !order) throw new Error();
      const [customer, lines, company] = await Promise.all([
        order.customer_id
          ? db
              .from('erp_customers')
              .select('address, city, email, phone')
              .eq('id', order.customer_id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        db
          .from('erp_sales_order_items')
          .select(PRINT_LINE_SELECT)
          .eq('sales_order_id', order.id)
          .order('id'),
        loadCompanyProfile(order.workspace_id),
      ]);
      if (cancelled) return;
      setData({
        order: order as OrderRow,
        customer: customer.data ?? null,
        lines: (lines.data ?? []) as Loaded['lines'],
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

  const { order, customer, lines, profile, erpName } = data;
  const money = (v: number | string) => fmt.moneyIn(Number(v), order.currency);
  // Show the delivered column once anything went out.
  const delivered = lines.some((l) => Number(l.qty_delivered ?? 0) > 0);

  return (
    <PrintSheet
      profile={profile}
      erpName={erpName}
      title={
        order.status === 'cancelled'
          ? `${t('print.salesOrder')} (${t('print.cancelled')})`
          : t('print.salesOrder')
      }
      docNo={order.doc_no}
      meta={[
        [t('print.date'), fmt.date(order.order_date)],
        ...(order.currency ? ([[t('print.currency'), order.currency]] as [string, string][]) : []),
      ]}
      party={{
        heading: t('print.customer'),
        name: order.customer_name,
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
        ...(delivered ? [{ label: t('print.delivered'), align: 'right' as const }] : []),
        { label: t('print.price'), align: 'right' },
        { label: t('print.amount'), align: 'right' },
      ]}
      rows={lines.map((l, i) => [
        String(i + 1),
        lineDescription(l),
        qtyText(l.qty, l.unit),
        ...(delivered ? [qtyText(l.qty_delivered, l.unit)] : []),
        money(l.price),
        money(lineAmount(l)),
      ])}
      totals={[{ label: t('print.total'), value: money(order.total), strong: true }]}
      notes={order.notes || undefined}
      showBank={false}
      signatures={[t('print.authorizedBy'), t('print.customerAck')]}
    />
  );
}
