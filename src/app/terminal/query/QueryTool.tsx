'use client';

// The Terminal's Query Tool, laid out as pgAdmin 4's: the connection bar,
// Query / Query History, the editor's tools, the SQL editor with the Scratch
// Pad beside it, Data Output / Messages / Notifications below, and a status
// bar. Queries are read-only and run by the worker (src/lib/terminal/sql.ts):
// on this Terminal's datasets (a sandbox copy, as the member sees them) or on
// one of its PostgreSQL connections.

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import dynamic from 'next/dynamic';
import {
  CircleHelp,
  Database,
  Download,
  FileDown,
  FileUp,
  FlaskConical,
  ListTree,
  Loader2,
  MessageSquareCode,
  PanelRightClose,
  PanelRightOpen,
  Play,
  RefreshCw,
  Search,
  Square,
  Unplug,
} from 'lucide-react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { hasMessage } from '@/lib/i18n/labels';
import { TerminalApiError, terminalApi } from '@/lib/terminal/client';
import {
  cancelSqlJob,
  runSql,
  sqlHistory,
  sqlTargets,
  type SqlHistoryEntry,
  type SqlMessage,
  type SqlMode,
  type SqlResult,
  type SqlTargets,
} from '@/lib/terminal/sql';
import { statementAt, toCsv } from '@/lib/terminal/sqlText';
import type { SqlEditorHandle } from './SqlEditor';
import { ResultGrid } from './ResultGrid';
import { Splitter, useSplit } from './Splitter';

// CodeMirror only in the browser, and only when the Query Tool opens.
const SqlEditor = dynamic(() => import('./SqlEditor'), {
  ssr: false,
  loading: () => <div className="h-full bg-[var(--wb-editor)]" />,
});

export const DATASETS_TARGET = 'datasets';

export interface QueryToolHandle {
  /** Puts text at the cursor (a table or column name from the browser). */
  insert: (text: string) => void;
  /** Replaces the query, and runs it when asked. */
  open: (sql: string, run?: boolean, target?: string) => void;
  /** Chooses what to query. */
  selectTarget: (id: string) => void;
}

type ResultTab = 'data' | 'messages' | 'notifications';
type QueryTab = 'query' | 'history';
type Cursor = { line: number; col: number; lineBreak: 'LF' | 'CRLF'; selected: number };

const read = (key: string, fallback = '') => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Storage unavailable: the draft is not kept between visits.
  }
};

const icon = (active = false) =>
  `inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-[2px] px-1.5 text-[12px] text-[var(--wb-text-2)] hover:bg-[var(--wb-hover)] hover:text-[var(--wb-text)] disabled:opacity-40 disabled:pointer-events-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-[var(--wb-accent)] ${
    active ? 'bg-[var(--wb-active)] text-[var(--wb-text)]' : ''
  }`;
const tabCls = (active: boolean) =>
  `px-3 h-[28px] text-[12px] border-r border-[var(--wb-border)] ${
    active
      ? 'bg-[var(--wb-editor)] text-[var(--wb-text)] shadow-[inset_0_2px_0_var(--wb-accent)]'
      : 'text-[var(--wb-text-2)] hover:text-[var(--wb-text)] hover:bg-[var(--wb-hover)]'
  }`;
/** A Terminal error's code (generic when the request itself failed). */
const errorCode = (e: unknown) => (e instanceof TerminalApiError ? e.code : FAILED);
const FAILED = 'failed';

const Sep = () => <span aria-hidden className="mx-1 h-4 w-px bg-[var(--wb-border)]" />;

function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** The status bar: its own state, so the cursor moving re-renders only it. */
const StatusBar = forwardRef<
  { setCursor: (c: Cursor) => void },
  {
    rows: number | null;
    truncated: boolean;
    status: string;
    running: boolean;
    startedAt: number | null;
  }
>(function StatusBar({ rows, truncated, status, running, startedAt }, ref) {
  const { t, fmt } = useI18n();
  const [cursor, setCursor] = useState<Cursor>({ line: 1, col: 1, lineBreak: 'LF', selected: 0 });
  const [now, setNow] = useState(Date.now());
  useImperativeHandle(ref, () => ({ setCursor }), []);
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, [running]);
  return (
    <div className="flex h-[24px] shrink-0 items-center gap-4 border-t border-[var(--wb-border)] bg-[var(--wb-toolbar)] px-2 text-[11px] text-[var(--wb-text-2)]">
      <span>
        {rows === null
          ? t('ps.qt.totalRowsNone')
          : t(truncated ? 'ps.qt.totalRowsFirst' : 'ps.qt.totalRows', { n: fmt.number(rows) })}
      </span>
      <span className="min-w-0 truncate">
        {running && startedAt
          ? t('ps.qt.running', { s: ((now - startedAt) / 1000).toFixed(1) })
          : status}
      </span>
      <span className="ml-auto whitespace-nowrap">
        {t('ps.qt.lnCol', { line: cursor.line, col: cursor.col })}
        {cursor.selected > 0 && ` · ${t('ps.qt.selected', { n: cursor.selected })}`}
      </span>
      <span title={t('ps.qt.lineEnding')}>{cursor.lineBreak}</span>
    </div>
  );
});

function messageText(m: SqlMessage, t: ReturnType<typeof useI18n>['t']): string {
  if (m.text) return m.text;
  const key = `ps.qt.msg.${m.key}`;
  return hasMessage(key) ? t(key as any, m.vars as any) : String(m.key ?? '');
}

export const QueryTool = forwardRef<
  QueryToolHandle,
  {
    workspaceId: string;
    workerOnline: boolean;
    /** Datasets and connections changed (the browser shows them). */
    onTargets?: (targets: SqlTargets) => void;
  }
>(function QueryTool({ workspaceId, workerOnline, onTargets }, ref) {
  const { t, fmt } = useI18n();
  const editor = useRef<SqlEditorHandle>(null);
  const status = useRef<{ setCursor: (c: Cursor) => void }>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const draftKey = `ps.qt.draft.${workspaceId}`;
  const scratchKey = `ps.qt.scratch.${workspaceId}`;
  const targetKey = `ps.qt.target.${workspaceId}`;

  const [initialText] = useState(() => read(draftKey, 'select *\nfrom "dataset name"\nlimit 100;'));
  const [scratch, setScratch] = useState(() => read(scratchKey));
  const [targets, setTargets] = useState<SqlTargets | null>(null);
  const [targetsError, setTargetsError] = useState('');
  const [target, setTarget] = useState(() => read(targetKey, DATASETS_TARGET));
  const [queryTab, setQueryTab] = useState<QueryTab>('query');
  const [resultTab, setResultTab] = useState<ResultTab>('data');
  const [history, setHistory] = useState<SqlHistoryEntry[] | null>(null);
  const [historyStale, setHistoryStale] = useState(true);
  const [result, setResult] = useState<SqlResult | null>(null);
  const [clientError, setClientError] = useState('');
  const [running, setRunning] = useState<{
    jobId: string | null;
    startedAt: number;
    queued: boolean;
  } | null>(null);
  const [statusText, setStatusText] = useState('');
  const [scratchWide, setScratchWide] = useState(() => read('ps.wb.scratch', '1') === '1');
  // In a narrow window the Scratch Pad starts hidden (and that is not remembered).
  const [scratchNarrow, setScratchNarrow] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setNarrow(el.clientWidth < 640));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scratchOpen = narrow ? scratchNarrow : scratchWide;
  const setScratchOpen = (next: boolean | ((open: boolean) => boolean)) => {
    const value = typeof next === 'function' ? next(scratchOpen) : next;
    if (narrow) setScratchNarrow(value);
    else setScratchWide(value);
  };
  const [reconnecting, setReconnecting] = useState(false);
  const [editorW, setEditorW] = useSplit('qt.editor', 80, 40, 92);
  const [resultsH, setResultsH] = useSplit('qt.results', 32, 12, 80);

  const loadTargets = useCallback(async () => {
    try {
      const next = await sqlTargets(workspaceId);
      setTargets(next);
      setTargetsError('');
      onTargets?.(next);
    } catch (e) {
      setTargetsError(errorCode(e));
    }
  }, [workspaceId, onTargets]);
  useEffect(() => {
    void loadTargets();
  }, [loadTargets]);

  // A connection that is gone: back to the datasets.
  useEffect(() => {
    if (targets && target !== DATASETS_TARGET && !targets.connections.some((c) => c.id === target))
      setTarget(DATASETS_TARGET);
  }, [targets, target]);
  useEffect(() => write(targetKey, target), [targetKey, target]);
  useEffect(() => write('ps.wb.scratch', scratchWide ? '1' : '0'), [scratchWide]);

  // History: loaded when its tab opens, again only after new runs.
  useEffect(() => {
    if (queryTab !== 'history' || !historyStale) return;
    setHistoryStale(false);
    sqlHistory(workspaceId)
      .then(setHistory)
      .catch(() => setHistory([]));
  }, [queryTab, historyStale, workspaceId]);

  const connection = targets?.connections.find((c) => c.id === target) ?? null;
  const allowedFor = useCallback(
    (id: string) =>
      !!targets &&
      (id === DATASETS_TARGET
        ? targets.canQueryDatasets
        : targets.connections.some((c) => c.id === id) &&
          targets.canQueryConnections &&
          targets.twoFactor),
    [targets]
  );
  const allowed = allowedFor(target);

  // Table and column names for completion (the datasets').
  const schema = useMemo(
    () =>
      Object.fromEntries(
        (targets?.datasets ?? []).map((d) => [
          /^[a-z_][a-z0-9_]*$/.test(d.name) ? d.name : `"${d.name.replace(/"/g, '""')}"`,
          d.columns.map((c) => c.name),
        ])
      ),
    [targets]
  );

  // Draft saved while typing, a moment after the last key.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChange = useCallback(
    (text: string) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => write(draftKey, text), 400);
    },
    [draftKey]
  );
  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    []
  );

  const execute = useCallback(
    async (mode: SqlMode, on: string = target) => {
      if (running || !editor.current) return;
      if (!allowedFor(on)) {
        setResultTab('messages');
        setClientError(t('ps.qt.notAllowed'));
        return;
      }
      const doc = editor.current.getText();
      const selection = editor.current.getSelection();
      const stmt = selection
        ? {
            text: selection.text.trim(),
            from: selection.from + (selection.text.length - selection.text.trimStart().length),
          }
        : statementAt(doc, editor.current.getCursor());
      if (!stmt || !stmt.text.trim()) {
        setResultTab('messages');
        setClientError(t('ps.qt.nothingToRun'));
        return;
      }
      editor.current.markError(null);
      setClientError('');
      setResult(null);
      setStatusText('');
      const startedAt = Date.now();
      setRunning({ jobId: null, startedAt, queued: true });
      try {
        const r = await runSql(
          {
            workspaceId,
            connectionId: on === DATASETS_TARGET ? null : on,
            sql: stmt.text,
            mode,
          },
          {
            onStarted: ({ jobId }) => setRunning({ jobId, startedAt, queued: true }),
            onState: (s) => setRunning((cur) => (cur ? { ...cur, queued: s === 'queued' } : cur)),
          }
        );
        setResult(r);
        setHistoryStale(true);
        if (r.status === 'succeeded') {
          setResultTab(r.columns?.length ? 'data' : 'messages');
          setStatusText(
            t('ps.qt.done', { ms: fmt.number(r.durationMs ?? Date.now() - startedAt) })
          );
        } else {
          setResultTab('messages');
          setStatusText(t(r.status === 'cancelled' ? 'ps.qt.cancelled' : 'ps.qt.failed'));
          const pos = r.error?.position;
          if (pos && pos > 0) {
            // From the position to the end of the word there.
            const at = stmt.from + pos - 1;
            const rest = stmt.text.slice(pos - 1);
            const len = Math.max(1, /^[\w$."]+/.exec(rest)?.[0].length ?? 1);
            editor.current?.markError({ from: at, to: at + len });
          }
        }
      } catch (e) {
        setResultTab('messages');
        const code = errorCode(e);
        const key = `ps.err.${code}`;
        setClientError(hasMessage(key) ? t(key as any) : t('ps.err.failed'));
        setStatusText(t('ps.qt.failed'));
      } finally {
        setRunning(null);
      }
    },
    [running, allowedFor, target, workspaceId, t, fmt]
  );

  const stop = async () => {
    if (!running?.jobId) return;
    try {
      await cancelSqlJob(running.jobId);
      setStatusText(t('ps.qt.cancelling'));
    } catch {
      setStatusText(t('ps.err.failed'));
    }
  };

  const saveFile = useCallback(() => {
    const text = editor.current?.getText() ?? '';
    download('query.sql', text, 'application/sql;charset=utf-8');
  }, []);

  const openFile = async (file: File) => {
    if (file.size > 2_000_000) {
      setResultTab('messages');
      setClientError(t('ps.qt.fileTooLarge'));
      return;
    }
    const text = await file.text();
    editor.current?.setText(text);
    write(draftKey, text);
  };

  const reconnect = async () => {
    setReconnecting(true);
    try {
      if (connection) {
        // Tests the connection (a worker job), then shows its new state.
        const { jobId } = await terminalApi<{ jobId: string }>('connection.test', {
          id: connection.id,
        });
        for (let i = 0; i < 60; i += 1) {
          await new Promise((r) => setTimeout(r, i < 6 ? 500 : 1000));
          const job = await terminalApi<{ status: string }>('job.get', { id: jobId });
          if (!['queued', 'running'].includes(job.status)) break;
        }
      }
      await loadTargets();
    } catch {
      await loadTargets();
    } finally {
      setReconnecting(false);
    }
  };

  useImperativeHandle(
    ref,
    () => ({
      insert: (text) => {
        setQueryTab('query');
        editor.current?.insert(text);
      },
      open: (sql, run = false, on) => {
        setQueryTab('query');
        if (on) setTarget(on);
        editor.current?.setText(sql);
        write(draftKey, sql);
        if (run) setTimeout(() => void execute('run', on ?? target), 0);
      },
      selectTarget: (id) => setTarget(id),
    }),
    [draftKey, execute, target]
  );

  const rows = result?.rows ?? null;
  const columns = result?.columns ?? null;
  const canDownload = !!rows && !!columns && rows.length > 0;
  const connected =
    target === DATASETS_TARGET ? !!targets?.canQueryDatasets : connection?.status === 'ok';

  return (
    <div
      ref={root}
      className="flex h-full min-h-0 flex-col bg-[var(--wb-app)] text-[var(--wb-text)]"
    >
      {/* Connection bar */}
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-[var(--wb-border)] bg-[var(--wb-toolbar)] px-2">
        <Database size={14} className="shrink-0 text-[var(--wb-text-2)]" aria-hidden />
        <label className="sr-only" htmlFor="qt-target">
          {t('ps.qt.connection')}
        </label>
        <select
          id="qt-target"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          className="h-[24px] min-w-0 max-w-[min(420px,50vw)] rounded-[2px] border border-[var(--wb-border)] bg-[var(--wb-editor)] px-1.5 text-[12px] text-[var(--wb-text)] outline-none focus:border-[var(--wb-accent)]"
          style={{ colorScheme: 'light dark' }}
        >
          <option value={DATASETS_TARGET}>
            {t('ps.qt.datasetsTarget', { n: targets?.datasets.length ?? 0 })}
          </option>
          {(targets?.connections ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
              {c.database ? ` · ${c.database}` : ''}
              {c.host ? `@${c.host}` : ''}
            </option>
          ))}
        </select>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-[var(--wb-text-2)]">
          <span
            aria-hidden
            className={`h-2 w-2 shrink-0 rounded-full ${
              !targets
                ? 'bg-[var(--wb-muted)]'
                : connected && allowed
                  ? 'bg-[var(--wb-ok)]'
                  : allowed
                    ? 'bg-[var(--wb-warn)]'
                    : 'bg-[var(--wb-error)]'
            }`}
          />
          <span className="truncate">
            {!targets
              ? targetsError
                ? t('ps.err.failed')
                : t('common.loading')
              : target === DATASETS_TARGET
                ? targets.canQueryDatasets
                  ? t('ps.qt.sandboxReady')
                  : t('ps.qt.noDatasetRight')
                : !targets.canQueryConnections
                  ? t('ps.qt.noConnectionRight')
                  : !targets.twoFactor
                    ? t('ps.qt.needsTwoFactor')
                    : connection?.status === 'ok'
                      ? t('ps.qt.connectionOk', {
                          when: connection.last_tested_at
                            ? fmt.dateTime(connection.last_tested_at)
                            : '—',
                        })
                      : t('ps.qt.connectionState', { status: connection?.status ?? '—' })}
          </span>
        </span>
        <button
          type="button"
          className={icon()}
          onClick={reconnect}
          disabled={reconnecting}
          title={connection ? t('ps.qt.reconnect') : t('ps.qt.refreshTargets')}
          aria-label={connection ? t('ps.qt.reconnect') : t('ps.qt.refreshTargets')}
        >
          {reconnecting ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
        </button>
        {!workerOnline && (
          <span className="ml-auto flex items-center gap-1 truncate text-[11px] text-[var(--wb-warn)]">
            <Unplug size={12} aria-hidden /> {t('ps.qt.workerOffline')}
          </span>
        )}
      </div>

      {/* Query / Query History */}
      <div
        role="tablist"
        className="flex h-[28px] shrink-0 border-b border-[var(--wb-border)] bg-[var(--wb-panel)]"
      >
        <button
          type="button"
          role="tab"
          aria-selected={queryTab === 'query'}
          className={tabCls(queryTab === 'query')}
          onClick={() => setQueryTab('query')}
        >
          {t('ps.qt.query')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={queryTab === 'history'}
          className={tabCls(queryTab === 'history')}
          onClick={() => setQueryTab('history')}
        >
          {t('ps.qt.history')}
        </button>
      </div>

      {/* Editor tools */}
      <div
        role="toolbar"
        aria-label={t('ps.qt.tools')}
        className="flex h-[32px] shrink-0 items-center gap-0.5 overflow-x-auto border-b border-[var(--wb-border)] bg-[var(--wb-toolbar)] px-1"
      >
        <input
          ref={fileInput}
          type="file"
          accept=".sql,.txt,text/plain,application/sql"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void openFile(f);
          }}
        />
        <button
          type="button"
          className={icon()}
          onClick={() => fileInput.current?.click()}
          title={t('ps.qt.openFile')}
          aria-label={t('ps.qt.openFile')}
        >
          <FileUp size={14} />
        </button>
        <button
          type="button"
          className={icon()}
          onClick={saveFile}
          title={t('ps.qt.saveFile')}
          aria-label={t('ps.qt.saveFile')}
        >
          <FileDown size={14} />
        </button>
        <Sep />
        <button
          type="button"
          className={icon()}
          onClick={() => editor.current?.openSearch()}
          title={t('ps.qt.find')}
          aria-label={t('ps.qt.find')}
        >
          <Search size={14} />
        </button>
        <button
          type="button"
          className={icon()}
          onClick={() => editor.current?.toggleComment()}
          title={t('ps.qt.comment')}
          aria-label={t('ps.qt.comment')}
        >
          <MessageSquareCode size={14} />
        </button>
        <Sep />
        <button
          type="button"
          className={icon()}
          onClick={() => void execute('run')}
          disabled={!!running || !allowed}
          title={t('ps.qt.execute')}
          aria-label={t('ps.qt.execute')}
        >
          <Play size={14} className="text-[var(--wb-ok)]" />
        </button>
        <button
          type="button"
          className={icon()}
          onClick={() => void execute('explain')}
          disabled={!!running || !allowed}
          title={t('ps.qt.explain')}
          aria-label={t('ps.qt.explain')}
        >
          <ListTree size={14} />
        </button>
        <button
          type="button"
          className={icon()}
          onClick={() => void execute('analyze')}
          disabled={!!running || !allowed}
          title={t('ps.qt.explainAnalyze')}
          aria-label={t('ps.qt.explainAnalyze')}
        >
          <FlaskConical size={14} />
        </button>
        <button
          type="button"
          className={icon()}
          onClick={stop}
          disabled={!running?.jobId}
          title={t('ps.qt.stop')}
          aria-label={t('ps.qt.stop')}
        >
          <Square size={13} className={running ? 'text-[var(--wb-error)]' : ''} />
        </button>
        <Sep />
        <button
          type="button"
          className={icon()}
          disabled={!canDownload}
          onClick={() =>
            columns &&
            rows &&
            download(
              'result.csv',
              toCsv(
                columns.map((c) => c.name),
                rows
              ),
              'text/csv;charset=utf-8'
            )
          }
          title={t('ps.qt.downloadCsv')}
          aria-label={t('ps.qt.downloadCsv')}
        >
          <Download size={14} />
        </button>
        <Sep />
        <button
          type="button"
          className={icon(scratchOpen)}
          onClick={() => setScratchOpen((o) => !o)}
          title={t('ps.qt.scratchToggle')}
          aria-label={t('ps.qt.scratchToggle')}
          aria-pressed={scratchOpen}
        >
          {scratchOpen ? <PanelRightClose size={14} /> : <PanelRightOpen size={14} />}
        </button>
        <HelpButton />
      </div>

      {/* Editor (and Scratch Pad) above, results below */}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex min-h-0" style={{ height: `${100 - resultsH}%` }}>
          <div
            className="relative min-w-0 flex-1"
            style={scratchOpen ? { flex: `0 0 ${editorW}%` } : undefined}
          >
            <div className={queryTab === 'query' ? 'h-full' : 'hidden'}>
              <SqlEditor
                handle={editor}
                initialText={initialText}
                placeholder={t('ps.qt.placeholder')}
                ariaLabel={t('ps.qt.editor')}
                onChange={onChange}
                onCursor={(c) => status.current?.setCursor(c)}
                onRun={() => void execute('run')}
                onExplain={() => void execute('explain')}
                onSave={saveFile}
                schema={schema}
              />
            </div>
            {queryTab === 'history' && (
              <HistoryList
                entries={history}
                onPick={(h) => {
                  setQueryTab('query');
                  editor.current?.setText(h.sql);
                  write(draftKey, h.sql);
                  if (h.connectionId && targets?.connections.some((c) => c.id === h.connectionId))
                    setTarget(h.connectionId);
                  else if (!h.connectionId) setTarget(DATASETS_TARGET);
                }}
              />
            )}
          </div>
          {scratchOpen && (
            <>
              <Splitter
                direction="vertical"
                size={editorW}
                onSize={setEditorW}
                label={t('ps.qt.resizeScratch')}
              />
              <div className="flex min-w-[140px] flex-1 flex-col bg-[var(--wb-panel)]">
                <div className="flex h-[26px] shrink-0 items-center justify-between border-b border-[var(--wb-border)] px-2 text-[12px] text-[var(--wb-text-2)]">
                  <span>{t('ps.qt.scratch')}</span>
                  <button
                    type="button"
                    className={icon()}
                    onClick={() => setScratchOpen(false)}
                    aria-label={t('ps.qt.scratchHide')}
                    title={t('ps.qt.scratchHide')}
                  >
                    <PanelRightClose size={13} />
                  </button>
                </div>
                <textarea
                  value={scratch}
                  onChange={(e) => {
                    setScratch(e.target.value);
                    write(scratchKey, e.target.value);
                  }}
                  spellCheck={false}
                  aria-label={t('ps.qt.scratch')}
                  placeholder={t('ps.qt.scratchHint')}
                  className="min-h-0 flex-1 resize-none bg-[var(--wb-editor)] p-2 font-mono text-[12px] text-[var(--wb-text)] outline-none placeholder:text-[var(--wb-muted)]"
                />
              </div>
            </>
          )}
        </div>
        <Splitter
          direction="horizontal"
          size={resultsH}
          onSize={setResultsH}
          label={t('ps.qt.resizeResults')}
          invert
        />
        <div className="flex min-h-0 flex-1 flex-col bg-[var(--wb-panel)]">
          <div role="tablist" className="flex h-[28px] shrink-0 border-b border-[var(--wb-border)]">
            {(['data', 'messages', 'notifications'] as ResultTab[]).map((id) => (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={resultTab === id}
                className={tabCls(resultTab === id)}
                onClick={() => setResultTab(id)}
              >
                {t(`ps.qt.tab.${id}` as any)}
                {id === 'notifications' &&
                  !!result?.notifications.length &&
                  ` (${result.notifications.length})`}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1">
            {resultTab === 'data' &&
              (running ? (
                <Waiting queued={running.queued} workerOnline={workerOnline} />
              ) : columns && rows ? (
                <div className="flex h-full flex-col">
                  {result?.truncated && (
                    <p className="shrink-0 border-b border-[var(--wb-border)] px-2 py-1 text-[11px] text-[var(--wb-warn)]">
                      {t(
                        result.truncated === 'size' ? 'ps.qt.truncatedSize' : 'ps.qt.truncatedRows',
                        { n: fmt.number(rows.length) }
                      )}
                    </p>
                  )}
                  {rows.length === 0 ? (
                    <div className="flex-1 overflow-auto">
                      <ResultGrid columns={columns} rows={rows} onCopied={() => undefined} />
                      <p className="px-2 py-1 text-[11px] text-[var(--wb-muted)]">
                        {t('ps.qt.noRows')}
                      </p>
                    </div>
                  ) : (
                    <div className="min-h-0 flex-1">
                      <ResultGrid
                        columns={columns}
                        rows={rows}
                        onCopied={(n) => setStatusText(t('ps.qt.copied', { n: fmt.number(n) }))}
                      />
                    </div>
                  )}
                </div>
              ) : (
                <p className="p-3 text-[12px] text-[var(--wb-muted)]">
                  {result && result.status !== 'succeeded'
                    ? t('ps.qt.seeMessages')
                    : t('ps.qt.noResult')}
                </p>
              ))}
            {resultTab === 'messages' && (
              <Messages result={result} clientError={clientError} running={!!running} />
            )}
            {resultTab === 'notifications' && (
              <div className="h-full overflow-auto p-2 font-mono text-[12px]">
                {result?.notifications.length ? (
                  result.notifications.map((n, i) => (
                    <p key={i}>
                      <span className="text-[var(--wb-text-2)]">{n.channel}</span>: {n.payload}
                    </p>
                  ))
                ) : (
                  <p className="font-sans text-[var(--wb-muted)]">{t('ps.qt.noNotifications')}</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <StatusBar
        ref={status}
        rows={rows ? rows.length : null}
        truncated={!!result?.truncated}
        status={statusText}
        running={!!running}
        startedAt={running?.startedAt ?? null}
      />
    </div>
  );
});

function Waiting({ queued, workerOnline }: { queued: boolean; workerOnline: boolean }) {
  const { t } = useI18n();
  return (
    <p className="flex items-center gap-2 p-3 text-[12px] text-[var(--wb-text-2)]">
      <Loader2 size={13} className="animate-spin" />
      {queued ? t(workerOnline ? 'ps.qt.queued' : 'ps.qt.queuedNoWorker') : t('ps.qt.executing')}
    </p>
  );
}

function Messages({
  result,
  clientError,
  running,
}: {
  result: SqlResult | null;
  clientError: string;
  running: boolean;
}) {
  const { t, fmt } = useI18n();
  if (running)
    return <p className="p-3 text-[12px] text-[var(--wb-text-2)]">{t('ps.qt.executing')}</p>;
  if (clientError)
    return (
      <pre className="h-full overflow-auto whitespace-pre-wrap p-2 font-mono text-[12px] text-[var(--wb-error)]">
        {clientError}
      </pre>
    );
  if (!result)
    return <p className="p-3 text-[12px] text-[var(--wb-muted)]">{t('ps.qt.noMessages')}</p>;
  const e = result.error;
  const lines: { text: string; tone?: 'error' | 'warn' }[] = result.messages.map((m) => ({
    text: `${m.severity}:  ${messageText(m, t)}`,
    tone: /^(WARNING)$/.test(m.severity) ? 'warn' : undefined,
  }));
  if (result.status === 'succeeded') {
    lines.push({
      text: t('ps.qt.msgSuccess', {
        ms: fmt.number(result.durationMs ?? 0),
        n: fmt.number(result.rowCount ?? 0),
      }),
    });
    if (result.truncated)
      lines.push({
        text: t(result.truncated === 'size' ? 'ps.qt.truncatedSize' : 'ps.qt.truncatedRows', {
          n: fmt.number(result.rowCount ?? 0),
        }),
        tone: 'warn',
      });
  } else if (result.status === 'cancelled') {
    lines.push({ text: t('ps.qt.cancelled'), tone: 'warn' });
  } else if (e) {
    if (e.message) {
      lines.push({ text: `ERROR:  ${e.message}`, tone: 'error' });
      if (e.detail) lines.push({ text: `DETAIL:  ${e.detail}`, tone: 'error' });
      if (e.hint) lines.push({ text: `HINT:  ${e.hint}`, tone: 'error' });
      if (e.code) lines.push({ text: t('ps.qt.sqlState', { code: e.code }), tone: 'error' });
      if (e.position) lines.push({ text: t('ps.qt.character', { n: e.position }), tone: 'error' });
    } else {
      const key = `ps.err.${e.key}`;
      lines.push({ text: hasMessage(key) ? t(key as any) : t('ps.err.failed'), tone: 'error' });
    }
  }
  return (
    <pre className="h-full overflow-auto whitespace-pre-wrap p-2 font-mono text-[12px] leading-5">
      {lines.map((l, i) => (
        <div
          key={i}
          className={
            l.tone === 'error'
              ? 'text-[var(--wb-error)]'
              : l.tone === 'warn'
                ? 'text-[var(--wb-warn)]'
                : ''
          }
        >
          {l.text}
        </div>
      ))}
    </pre>
  );
}

function HistoryList({
  entries,
  onPick,
}: {
  entries: SqlHistoryEntry[] | null;
  onPick: (h: SqlHistoryEntry) => void;
}) {
  const { t, fmt } = useI18n();
  if (entries === null)
    return <p className="p-3 text-[12px] text-[var(--wb-muted)]">{t('common.loading')}</p>;
  if (!entries.length)
    return <p className="p-3 text-[12px] text-[var(--wb-muted)]">{t('ps.qt.historyEmpty')}</p>;
  return (
    <ul className="h-full overflow-auto bg-[var(--wb-editor)] text-[12px]">
      {entries.map((h) => (
        <li key={h.id} className="border-b border-[var(--wb-border)]">
          <button
            type="button"
            onClick={() => onPick(h)}
            className="block w-full px-2 py-1.5 text-left hover:bg-[var(--wb-hover)]"
            title={t('ps.qt.historyLoad')}
          >
            <div className="flex items-center gap-2 text-[11px] text-[var(--wb-text-2)]">
              <span
                className={
                  h.status === 'succeeded'
                    ? 'text-[var(--wb-ok)]'
                    : h.status === 'failed'
                      ? 'text-[var(--wb-error)]'
                      : 'text-[var(--wb-warn)]'
                }
              >
                {t(`ps.qt.status.${h.status}` as any)}
              </span>
              <span>{h.createdAt ? fmt.dateTime(h.createdAt) : ''}</span>
              <span className="truncate">
                {h.connectionId ? h.targetName : t('ps.qt.datasetsShort')}
              </span>
              {h.mode !== 'run' && <span>{t(`ps.qt.mode.${h.mode}` as any)}</span>}
              <span className="ml-auto whitespace-nowrap">
                {h.rowCount !== null && t('ps.qt.rowsShort', { n: fmt.number(h.rowCount) })}
                {h.durationMs !== null &&
                  ` · ${t('ps.qt.msShort', { n: fmt.number(h.durationMs) })}`}
              </span>
            </div>
            <pre className="mt-0.5 max-h-[3.2em] overflow-hidden whitespace-pre-wrap font-mono text-[12px] text-[var(--wb-text)]">
              {h.sql}
            </pre>
          </button>
        </li>
      ))}
    </ul>
  );
}

function HelpButton() {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', key);
    };
  }, [open]);
  const keys: [string, string][] = [
    ['Ctrl+Enter / F5', t('ps.qt.helpRun')],
    ['F7', t('ps.qt.helpExplain')],
    ['Ctrl+S', t('ps.qt.helpSave')],
    ['Ctrl+F', t('ps.qt.helpFind')],
    ['Ctrl+/', t('ps.qt.helpComment')],
    ['Ctrl+C', t('ps.qt.helpCopy')],
  ];
  return (
    <div ref={box} className="relative ml-auto">
      <button
        type="button"
        className={icon(open)}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        title={t('ps.qt.help')}
        aria-label={t('ps.qt.help')}
      >
        <CircleHelp size={14} />
      </button>
      {open && (
        <div className="absolute right-0 top-8 z-30 w-[min(360px,90vw)] rounded-[2px] border border-[var(--wb-border)] bg-[var(--wb-panel)] p-3 text-[12px] text-[var(--wb-text)] shadow-lg">
          <p className="mb-2 text-[var(--wb-text-2)]">{t('ps.qt.helpIntro')}</p>
          <table className="w-full">
            <tbody>
              {keys.map(([k, v]) => (
                <tr key={k}>
                  <td className="whitespace-nowrap py-0.5 pr-3 font-mono text-[11px] text-[var(--wb-text-2)]">
                    {k}
                  </td>
                  <td className="py-0.5">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-[11px] text-[var(--wb-muted)]">{t('ps.qt.helpLimits')}</p>
        </div>
      )}
    </div>
  );
}
