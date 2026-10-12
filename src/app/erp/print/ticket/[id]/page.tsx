'use client';

import React, { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { loadCompanyProfile, type CompanyProfile } from '../../../lib/companyProfile';
import { weighbridgeService, type WeighTicket } from '../../../lib/weighbridgeService';
import { PrintMessage, PrintSheet, useQtyText } from '../../PrintSheet';

interface Loaded {
  ticket: WeighTicket;
  profile: CompanyProfile;
  erpName: string;
}

// Weigh ticket, which is also the delivery note (surat jalan) of the load.
export default function PrintWeighTicketPage() {
  const { id } = useParams<{ id: string }>();
  const { t, fmt } = useI18n();
  const qtyText = useQtyText();
  const [data, setData] = useState<Loaded | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ticket = await weighbridgeService.ticket(id);
      if (!ticket) throw new Error();
      const company = await loadCompanyProfile(ticket.workspaceId);
      if (!cancelled) setData({ ticket, profile: company.profile, erpName: company.erpName });
    })().catch(() => !cancelled && setFailed(true));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (failed) return <PrintMessage text={t('print.notFound')} />;
  if (!data) return <PrintMessage text={t('common.loading')} />;

  const { ticket, profile, erpName } = data;
  const kg = (value: number | null) =>
    value === null ? '—' : t('wb.kg', { value: fmt.number(value) });
  const gross = ticket.secondKg === null ? null : Math.max(ticket.firstKg, ticket.secondKg);
  const tare = ticket.secondKg === null ? null : Math.min(ticket.firstKg, ticket.secondKg);
  const title =
    ticket.status === 'cancelled'
      ? `${t('print.weighTicket')} (${t('wb.status.cancelled')})`
      : t('print.weighTicket');

  return (
    <PrintSheet
      profile={profile}
      erpName={erpName}
      title={title}
      docNo={ticket.docNo}
      meta={[
        [t('print.date'), fmt.dateTime(ticket.secondAt ?? ticket.firstAt)],
        [t('print.vehicle'), ticket.plateNo],
        [t('print.driver'), ticket.driverName || '________________'],
        [t('print.firstWeight'), `${kg(ticket.firstKg)} · ${fmt.dateTime(ticket.firstAt)}`],
        ...(ticket.secondAt
          ? ([
              [
                t('print.secondWeight'),
                `${kg(ticket.secondKg)} · ${fmt.dateTime(ticket.secondAt)}`,
              ],
            ] as [string, string][])
          : []),
      ]}
      party={{ heading: t('print.deliverTo'), name: ticket.customerName, lines: [] }}
      columns={[
        { label: t('print.description') },
        { label: t('print.gross'), align: 'right' },
        { label: t('print.tare'), align: 'right' },
        { label: t('print.net'), align: 'right' },
        { label: t('print.qty'), align: 'right' },
      ]}
      rows={[
        [
          ticket.productName,
          kg(gross),
          kg(tare),
          kg(ticket.netKg),
          ticket.qty === null ? '—' : qtyText(ticket.qty, ticket.unit),
        ],
      ]}
      notes={[ticket.note, ticket.cancelReason].filter(Boolean).join('\n') || undefined}
      showBank={false}
      signatures={[t('print.operator'), t('print.driver'), t('print.customerAck')]}
    />
  );
}
