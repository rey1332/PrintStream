import { tr } from '@/lib/i18n/translate';
import { hasMessage } from '@/lib/i18n/labels';

export class WorkflowError extends Error {
  key: string;
  vars: Record<string, string | number>;
  constructor(key: string, vars: Record<string, string | number> = {}) {
    super(hasMessage(key) ? tr(key, vars) : key);
    this.key = key;
    this.vars = vars;
  }
}

export interface ErrorInfo {
  key?: string;
  vars?: Record<string, string | number>;
  message: string;
}

export function errorInfo(error: unknown): ErrorInfo {
  if (error instanceof WorkflowError)
    return { key: error.key, vars: error.vars, message: error.message };
  return { key: 'wf.err.unexpected', message: tr('wf.err.unexpected') };
}
