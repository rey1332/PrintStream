'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Loader2 } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { getWorkflow } from '@/lib/workflow/storage';
import { WorkspaceProvider } from '@/app/erp/lib/WorkspaceContext';
import { SuspendedNotice } from '@/app/erp/components/shell/SuspendedNotice';
import { rememberTerminalSpace } from '@/lib/workspaces/terminalSpaces';
import PipelineEditor from './PipelineEditor';

/**
 * A TERMINAL pipeline in its own window: the whole screen is the editor, in
 * the TERMINAL (or ERP) the pipeline belongs to. No ERP is opened or chosen.
 */
export default function PipelinePage() {
  const { t } = useI18n();
  const params = useParams();
  const id = String(params.id ?? '');
  const [workspaceId, setWorkspaceId] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    getWorkflow(id)
      .then((wf) => {
        if (cancelled) return;
        const ws = wf?.workspace_id ?? null;
        // Back in TERMINAL, the pipeline's TERMINAL is the one shown.
        if (ws) rememberTerminalSpace(ws);
        setWorkspaceId(ws);
      })
      .catch(() => !cancelled && setWorkspaceId(null));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (workspaceId === undefined)
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-background">
        <Loader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  if (workspaceId === null)
    return (
      <div className="flex h-[100dvh] flex-col items-center justify-center gap-3 bg-background text-[0.85rem] text-foreground">
        <p>{t('wf.notFound')}</p>
        <Link href="/terminal?tab=pipelines" className="underline">
          {t('wf.back')}
        </Link>
      </div>
    );
  return (
    <div className="ui-refined bg-background text-foreground">
      <WorkspaceProvider key={workspaceId} workspaceId={workspaceId}>
        <SuspendedNotice pathname={`/pipelines/${id}`}>
          <PipelineEditor />
        </SuspendedNotice>
      </WorkspaceProvider>
    </div>
  );
}
