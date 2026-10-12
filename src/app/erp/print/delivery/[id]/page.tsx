'use client';

import React, { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { createClient } from '@/lib/data/client';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { loadCompanyProfile, type CompanyProfile } from '../../../lib/companyProfile';
import { PrintMessage, PrintSheet, useQtyText } from '../../PrintSheet';

interface EventRow {
  id: string;
  workspace_id: string | null;
  doc_no: string | null;
  kind: string;
  is_reversal: boolean;
  created_at: string;
  note: string;
  sales_order_id: string | null;
  lines: {
    product_name: string;
    quantity: number;
    item: { unit: string | null } | null;
    product: { sku: string | null } | null;
  }[];
}

interface Loaded {
  event: EventRow;
  order: { doc_no: string | null; customer_id: string | null; customer_name: string } | null;
  customer: { address?: string; city?: string; phone?: string } | null;
  profile: CompanyProfile;
  erpName: string;
}

// Delivery note (surat jalan) for one delivery of a sales order.
export default function PrintDeliveryNotePage() {
  const { id } = useParams<{ id: string }>();
  const { t, fmt } = useI18n();
  const qtyText = useQtyText();
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const db = createClient();
      const { data: event, error } = await db
        .from('erp_fulfillment_events')
        .select(
          'id, workspace_id, doc_no, kind, is_reversal, created_at, note, sales_order_id, ' +
            'lines:erp_fulfillment_event_lines(product_name, quantity, item:erp_sales_order_items(unit), product:erp_products(sku))'
        )
        .eq('id', id)
        .maybeSingle();
      if (error || !event || event.kind !== 'sales_delivery') throw new Error();
      const { data: order } = event.sales_order_id
        ? await db
            .from('erp_sales_orders')
            .select('doc_no, customer_id, customer_name')
            .eq('id', event.sales_order_id)
            .maybeSingle()
        : { data: null };
      const [customer, company] = await Promise.all([
        order?.customer_id
          ? db
              .from('erp_customers')
              .select('address, city, phone')
              .eq('id', order.customer_id)
              .maybeSingle()
          : Promise.resolve({ data: null }),
        loadCompanyProfile(event.workspace_id),
      ]);
      if (cancelled) return;
      setData({
        event: event as EventRow,
        order: order ?? null,
        customer: customer.data ?? null,
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

  const { event, order, customer, profile, erpName } = data;
  const title = event.is_reversal
    ? `${t('print.deliveryNote')} (${t('print.reversal')})`
    : t('print.deliveryNote');

  return (
    <PrintSheet
      profile={profile}
      erpName={erpName}
      title={title}
      docNo={event.doc_no}
      meta={[
        [t('print.date'), fmt.dateTime(event.created_at)],
        ...(order?.doc_no ? ([[t('print.salesOrder'), order.doc_no]] as [string, string][]) : []),
        // Filled in by hand until vehicles and drivers are recorded in ETNA.
        [t('print.vehicle'), '________________'],
        [t('print.driver'), '________________'],
      ]}
      party={{
        heading: t('print.deliverTo'),
        name: order?.customer_name ?? '—',
        lines: [customer?.address ?? '', customer?.city ?? '', customer?.phone ?? ''],
      }}
      columns={[
        { label: '#' },
        { label: t('print.description') },
        { label: t('print.qty'), align: 'right' },
      ]}
      rows={event.lines.map((l, i) => [
        String(i + 1),
        l.product?.sku ? `${l.product_name} (${l.product.sku})` : l.product_name,
        qtyText(l.quantity, l.item?.unit),
      ])}
      notes={event.note || undefined}
      showBank={false}
      signatures={[t('print.shippedBy'), t('print.driver'), t('print.customerAck')]}
    />
  );
}
