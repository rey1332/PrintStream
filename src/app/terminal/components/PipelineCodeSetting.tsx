'use client';

// Whether this workspace's pipelines may have JavaScript steps (tf.code),
// switched by the Owner with two-factor (20261012000061). Everyone sees the
// state; who may write code is the "Write pipeline code" permission.

import React, { useCallback, useEffect, useState } from 'react';
import { Braces } from 'lucide-react';
import { toast } from 'sonner';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { terminalApi } from '@/lib/terminal/client';
import { errorMessage } from './shared';

export function PipelineCodeSetting({
  workspaceId,
  isOwner,
}: {
  workspaceId: string;
  isOwner: boolean;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<{ enabled: boolean; canWrite: boolean } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setState(await terminalApi('pipelineCode.get', { workspaceId }));
    } catch {
      setState(null);
    }
  }, [workspaceId]);
  useEffect(() => {
    load();
  }, [load]);

  if (!state) return null;
  async function toggle() {
    if (!state) return;
    const next = !state.enabled;
    if (next && !confirm(t('ps.code.enableConfirm'))) return;
    setBusy(true);
    try {
      await terminalApi('pipelineCode.set', { workspaceId, enabled: next });
      toast.success(t(next ? 'ps.code.enabled' : 'ps.code.disabled'));
      await load();
    } catch (e) {
      toast.error(errorMessage(e, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-start gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
      <Braces size={15} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-[0.78rem] font-medium text-foreground">
          {t(state.enabled ? 'ps.code.onTitle' : 'ps.code.offTitle')}
        </p>
        <p className="text-[0.68rem] text-muted-foreground">
          {state.enabled
            ? t(state.canWrite ? 'ps.code.onYouCan' : 'ps.code.onYouCannot')
            : t('ps.code.offHint')}
        </p>
      </div>
      {isOwner && (
        <button
          type="button"
          disabled={busy}
          onClick={toggle}
          className="shrink-0 rounded-md border border-border px-2.5 py-1 text-[0.72rem] text-foreground hover:bg-[var(--surface-3)] disabled:opacity-50"
        >
          {t(state.enabled ? 'ps.code.turnOff' : 'ps.code.turnOn')}
        </button>
      )}
    </div>
  );
}
