'use client';

import React, { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { NODE_REGISTRY } from '@/lib/workflow/registry';
import { AlertCircle, AlertTriangle, Check, Loader2, MinusCircle } from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { hasMessage } from '@/lib/i18n/labels';
import type { MessageKey } from '@/lib/i18n/messages';
import { nodeDisplayLabel } from '@/lib/workflow/i18n';
import { errorText } from './NodeInspector';

const handleStyle = (background: string) => ({
  background,
  width: 8,
  height: 8,
  border: '2px solid var(--card)',
});

function WorkflowNodeView({ data, selected }: NodeProps) {
  const { t, fmt } = useI18n();
  const def = NODE_REGISTRY[data.type as string];
  if (!def) return null;
  const Icon = def.icon;

  const status = data.status as string | undefined;
  const issueCount = Number(data.issueCount ?? 0);
  const statusColor =
    status === 'success'
      ? 'var(--positive)'
      : status === 'error'
        ? 'var(--negative)'
        : status === 'skipped'
          ? 'var(--muted-foreground)'
          : status === 'running'
            ? 'var(--muted-foreground)'
            : null;

  return (
    <div
      className="rounded-lg border bg-card min-w-[180px] max-w-[220px] shadow-md transition-all"
      style={{
        borderColor: selected
          ? 'var(--foreground)'
          : issueCount
            ? 'var(--negative)'
            : 'var(--border)',
        borderWidth: selected || issueCount ? 2 : 1,
      }}
    >
      {def.inputs > 0 && (
        <Handle
          type="target"
          position={Position.Left}
          style={handleStyle('var(--muted-foreground)')}
        />
      )}
      {def.outputHandles.length > 1
        ? def.outputHandles.map((handle, i) => (
            <Handle
              key={handle}
              id={handle}
              type="source"
              position={Position.Right}
              style={{
                ...handleStyle(i === 0 ? 'var(--positive)' : 'var(--foreground)'),
                top: `${35 + i * 35}%`,
              }}
            />
          ))
        : def.outputs > 0 && (
            <Handle
              type="source"
              position={Position.Right}
              style={handleStyle('var(--foreground)')}
            />
          )}

      <div
        className="px-3 py-2.5 flex items-center gap-2"
        style={{ borderBottom: '1px solid var(--border)' }}
      >
        <div
          className="w-6 h-6 rounded flex items-center justify-center flex-shrink-0"
          style={{ background: def.color + '22' }}
        >
          <Icon size={12} style={{ color: def.color }} />
        </div>
        <p className="text-[0.78rem] font-semibold text-foreground truncate flex-1">
          {nodeDisplayLabel(data, t)}
        </p>
        {issueCount > 0 && (
          <span
            title={String(data.issueText ?? '')}
            aria-label={t('wf.issue.count', { count: issueCount })}
          >
            <AlertTriangle size={11} style={{ color: 'var(--negative)' }} />
          </span>
        )}
        {status && status !== 'idle' && (
          <span
            className="w-4 h-4 rounded-full flex items-center justify-center flex-shrink-0"
            style={{ background: statusColor + '22' }}
          >
            {status === 'running' && (
              <Loader2 size={9} className="animate-spin" style={{ color: statusColor! }} />
            )}
            {status === 'success' && <Check size={9} style={{ color: statusColor! }} />}
            {status === 'error' && <AlertCircle size={9} style={{ color: statusColor! }} />}
            {status === 'skipped' && <MinusCircle size={9} style={{ color: statusColor! }} />}
          </span>
        )}
      </div>

      {(Boolean(data.preview) || data.fieldCount != null) && (
        <div className="px-3 py-1.5 text-[0.65rem] text-muted-foreground truncate">
          {data.preview && typeof data.preview === 'object' && (data.preview as any).count != null
            ? t('wf.rowsCount', { count: fmt.number((data.preview as any).count) })
            : null}
          {data.preview && data.fieldCount != null ? ' · ' : null}
          {data.fieldCount != null
            ? t('wf.fieldsCount', { count: fmt.number(Number(data.fieldCount)) })
            : null}
        </div>
      )}
      {def.outputHandles.length > 1 && (
        <div className="px-3 pb-1.5 flex flex-col items-end gap-0.5 text-[0.58rem] text-muted-foreground">
          {def.outputHandles.map((h) => (
            <span key={h}>
              {hasMessage(`wf.handle.${h}`) ? t(`wf.handle.${h}` as MessageKey) : h} →
            </span>
          ))}
        </div>
      )}
      {Boolean(data.error) && (
        <div
          className="px-3 py-1.5 text-[0.65rem] truncate"
          style={{ color: 'var(--negative)' }}
          title={errorText(data.error, t)}
        >
          {errorText(data.error, t)}
        </div>
      )}
    </div>
  );
}

export default memo(WorkflowNodeView);
