'use client';

import React, { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { createClient } from '@/lib/data/client';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { hasMessage } from '@/lib/i18n/labels';
import { loadCompanyProfile, type CompanyProfile } from '../../../lib/companyProfile';
import { PrintMessage, PrintSheet } from '../../PrintSheet';

interface PaymentRow {
  id: string;
  workspace_id: string | null;
  doc_no: string | null;
  payment_type: 'incoming' | 'outgoing';
  party: string;
  amount: number | string;
  payment_date: string;
  method: string;
  note: string;
  invoice_id: string | null;
  purchase_order_id: string | null;
  voided_at: string | null;
  currency: string | null;
}

interface Loaded {
  payment: PaymentRow;
  documentNo: string | null;
  profile: CompanyProfile;
  erpName: string;
}

export default function PrintPaymentPage() {
  const { id } = useParams<{ id: string }>();
  const { t, fmt } = useI18n();
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const db = createClient();
      const { data: payment, error } = await db
        .from('erp_payments')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error || !payment) throw new Error();
      const [document, company] = await Promise.all([
        payment.invoice_id
          ? db.from('erp_invoices').select('doc_no').eq('id', payment.invoice_id).maybeSingle()
          : payment.purchase_order_id
            ? db
                .from('erp_purchase_orders')
                .select('doc_no')
                .eq('id', payment.purchase_order_id)
                .maybeSingle()
            : Promise.resolve({ data: null }),
        loadCompanyProfile(payment.workspace_id),
      ]);
      if (cancelled) return;
      setData({
        payment: payment as PaymentRow,
        documentNo: (document.data as { doc_no?: string | null } | null)?.doc_no ?? null,
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

  const { payment, documentNo, profile, erpName } = data;
  const incoming = payment.payment_type === 'incoming';
  const money = (v: number | string) => fmt.moneyIn(Number(v), payment.currency);
  // Stored method values stay English; only their label is translated.
  const methodKey = `pay.method.${payment.method}`;
  const method = hasMessage(methodKey) ? t(methodKey) : payment.method;
  const title = incoming ? t('print.receipt') : t('print.paymentVoucher');
  const description = documentNo
    ? t(incoming ? 'print.paymentForInvoice' : 'print.paymentForPo', { ref: documentNo })
    : payment.note || t('print.paymentLine');

  return (
    <PrintSheet
      profile={profile}
      erpName={erpName}
      title={payment.voided_at ? `${title} (${t('print.void')})` : title}
      docNo={payment.doc_no}
      meta={[
        [t('print.date'), fmt.date(payment.payment_date)],
        [t('print.method'), method],
        ...(payment.currency
          ? ([[t('print.currency'), payment.currency]] as [string, string][])
          : []),
      ]}
      party={{
        heading: incoming ? t('print.receivedFrom') : t('print.paidTo'),
        name: payment.party,
        lines: [],
      }}
      columns={[{ label: t('print.description') }, { label: t('print.amount'), align: 'right' }]}
      rows={[[description, money(payment.amount)]]}
      totals={[{ label: t('print.total'), value: money(payment.amount), strong: true }]}
      notes={documentNo && payment.note ? payment.note : undefined}
      showBank={false}
      signatures={
        incoming
          ? [t('print.payer'), t('print.receivedBy')]
          : [t('print.approvedBy'), t('print.paidBy'), t('print.receivedBy')]
      }
    />
  );
}
