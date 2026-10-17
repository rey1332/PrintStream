'use client';

// Which ERP an ERP node reads or writes (20261012000044): the pipeline's own
// workspace, or an ERP its Terminal is linked to.

import React, { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { terminalApi } from '@/lib/terminal/client';
import { useWorkspace } from '@/app/erp/lib/WorkspaceContext';

interface Link {
  id: string;
  erpId: string;
  name: string;
  member: boolean;
}

export function ErpTargetSelect({
  value,
  onChange,
  disabled,
  className,
}: {
  value: string;
  onChange: (erpId: string) => void;
  disabled?: boolean;
  className: string;
}) {
  const { t } = useI18n();
  const { active } = useWorkspace();
  const [links, setLinks] = useState<Link[] | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    terminalApi<Link[]>('erpLinks.list', { workspaceId: active.id })
      .then((rows) => !cancelled && setLinks(rows))
      .catch(() => !cancelled && setLinks([]));
    return () => {
      cancelled = true;
    };
  }, [active]);

  const chosen = links?.find((l) => l.erpId === value);
  return (
    <div>
      <label htmlFor="erp-target" className="block text-[0.7rem] text-muted-foreground mb-1">
        {t('wf.field.erpId')}
      </label>
      <select
        id="erp-target"
        className={className}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        style={{ colorScheme: 'light dark' }}
      >
        <option value="">{t('wf.erp.own')}</option>
        {value && links && !chosen && <option value={value}>{t('wf.erp.unlinked')}</option>}
        {links?.map((l) => (
          <option key={l.id} value={l.erpId}>
            {l.name}
          </option>
        ))}
      </select>
      {chosen && !chosen.member && (
        <p className="mt-1 text-[0.6rem] text-amber-700 dark:text-amber-400">
          {t('wf.erp.notMember')}
        </p>
      )}
      {links && links.length === 0 && (
        <p className="mt-1 text-[0.6rem] text-muted-foreground">{t('wf.erp.noLinks')}</p>
      )}
    </div>
  );
}
