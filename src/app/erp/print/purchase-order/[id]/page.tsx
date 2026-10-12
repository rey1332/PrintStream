'use client';

import React, { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { createClient } from '@/lib/data/client';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { loadCompanyProfile, type CompanyProfile } from '../../../lib/companyProfile';
import {
  PRINT_PO_LINE_SELECT,
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
  supplier_id: string | null;
  supplier_name: string;
  order_date: string;
  status: string;
  total: number | string;
  tax_rate: number | string;
  tax_amount: number | string;
  currency: string | null;
  notes: string;
}

interface Loaded {
  order: OrderRow;
  supplier: { address?: string; city?: string; email?: string; phone?: string } | null;
  lines: PrintLine[];
  profile: CompanyProfile;
  erpName: string;
}

export default function PrintPurchaseOrderPage() {
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
        .from('erp_purchase_orders')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error || !order) throw new Error();
      const [supplier, lines, company] = await Promise.all([
        order.supplier_id
          ? db
              .from('erp_suppliers')
              .select('address, city, email, phone')
              .eq('id', order.supplier_id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        db
          .from('erp_purchase_order_items')
          .select(PRINT_PO_LINE_SELECT)
          .eq('purchase_order_id', order.id)
          .order('id'),
        loadCompanyProfile(order.workspace_id),
      ]);
      if (cancelled) return;
      setData({
        order: order as OrderRow,
        supplier: supplier.data ?? null,
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

  const { order, supplier, lines, profile, erpName } = data;
  const money = (v: number | string) => fmt.moneyIn(Number(v), order.currency);
  const total = Number(order.total);
  const tax = Number(order.tax_amount);
  const subtotal = lines.reduce((s, l) => s + lineAmount(l), 0);

  return (
    <PrintSheet
      profile={profile}
      erpName={erpName}
      title={
        order.status === 'cancelled'
          ? `${t('print.purchaseOrder')} (${t('print.cancelled')})`
          : t('print.purchaseOrder')
      }
      docNo={order.doc_no}
      meta={[
        [t('print.date'), fmt.date(order.order_date)],
        ...(order.currency ? ([[t('print.currency'), order.currency]] as [string, string][]) : []),
      ]}
      party={{
        heading: t('print.supplier'),
        name: order.supplier_name,
        lines: [
          supplier?.address ?? '',
          supplier?.city ?? '',
          [supplier?.phone, supplier?.email].filter(Boolean).join(' · '),
        ],
      }}
      columns={[
        { label: '#' },
        { label: t('print.description') },
        { label: t('print.qty'), align: 'right' },
        { label: t('print.price'), align: 'right' },
        { label: t('print.amount'), align: 'right' },
      ]}
      rows={lines.map((l, i) => [
        String(i + 1),
        lineDescription(l),
        qtyText(l.qty, l.unit),
        money(l.price),
        money(lineAmount(l)),
      ])}
      totals={[
        { label: t('print.subtotal'), value: money(subtotal) },
        ...(tax > 0
          ? [
              {
                label: t('print.tax', { rate: fmt.number(Number(order.tax_rate)) }),
                value: money(tax),
              },
            ]
          : []),
        { label: t('print.total'), value: money(total), strong: true },
      ]}
      notes={order.notes || undefined}
      showBank={false}
      signatures={[t('print.orderedBy'), t('print.approvedBy'), t('print.supplierAck')]}
    />
  );
}
