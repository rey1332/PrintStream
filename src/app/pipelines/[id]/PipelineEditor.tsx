'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  Controls,
  MiniMap,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  type Connection,
  type Edge,
  type Node,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { useAuth } from '@/contexts/AuthContext';
import { NODE_REGISTRY } from '@/lib/workflow/registry';
import type { NodeResultMap } from '@/lib/workflow/executor';
import { analyzeGraph, canConnect } from '@/lib/workflow/schema';
import { cleanGraph, stableStringify } from '@/lib/workflow/graph';
import {
  WorkflowApiError,
  cancelRun,
  duplicateWorkflow,
  getVersion,
  getWorkflow,
  publishVersion,
  runWorkflow,
  saveVersion,
  saveWorkflow,
  type WorkflowDetail,
} from '@/lib/workflow/storage';
import type { WorkflowGraph } from '@/lib/workflow/types';
import WorkflowNodeView from '../components/WorkflowNodeView';
import NodePalette from '../components/NodePalette';
import NodeInspector, { issueText } from '../components/NodeInspector';
import RunHistoryPanel from '../components/RunHistoryPanel';
import VersionBar from '../components/VersionBar';
import {
  AutoRefreshButton,
  AutoRefreshStatus,
  type AutoRefreshPause,
} from '../components/AutoRefresh';
import {
  Save,
  Play,
  ArrowLeft,
  Loader2,
  Trash2,
  Copy,
  Settings,
  Square,
  History,
  CopyPlus,
  Plus,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n/I18nProvider';
import { tr } from '@/lib/i18n/translate';
import { useUiMode } from '@/lib/ui/UiModeProvider';
import { nodeDisplayLabel } from '@/lib/workflow/i18n';

const nodeTypes = { workflowNode: WorkflowNodeView };

/**
 * The graph without positions, the same object while only positions change:
 * dragging a step (a change every frame) does not check the whole pipeline
 * again or draw every other step again.
 */
function useStructure(nodes: any[], edges: any[]): WorkflowGraph {
  const last = useRef<WorkflowGraph | null>(null);
  const prev = last.current;
  const same =
    prev !== null &&
    prev.edges === edges &&
    prev.nodes.length === nodes.length &&
    prev.nodes.every((n, i) => n.id === nodes[i].id && n.data === nodes[i].data);
  if (!same) last.current = { nodes, edges } as WorkflowGraph;
  return last.current!;
}

let nodeIdCounter = 0;
const nextId = () => `n_${Date.now()}_${++nodeIdCounter}`;

interface ContextMenu {
  x: number;
  y: number;
  nodeId: string;
}

const snapshot = (graph: WorkflowGraph, name: string) =>
  stableStringify({ graph: cleanGraph(graph), name });

function EditorInner() {
  const params = useParams();
  const router = useRouter();
  const { user } = useAuth();
  const { t, fmt } = useI18n();
  const workflowId = params.id as string;

  const [nodes, setNodes, onNodesChange] = useNodesState<any>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<any>([]);
  const [name, setName] = useState('Untitled Workflow');
  const [detail, setDetail] = useState<WorkflowDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [runResults, setRunResults] = useState<NodeResultMap>({});
  const [savedSnapshot, setSavedSnapshot] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyKey, setHistoryKey] = useState(0);
  const [contextMenu, setContextMenu] = useState<ContextMenu | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [runTarget, setRunTarget] = useState<{ target: 'draft' | 'published' }>({
    target: 'draft',
  });
  // Auto-refresh: re-run the last run's target every minute while the page is open.
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [autoRunning, setAutoRunning] = useState(false);
  const [lastRunAt, setLastRunAt] = useState<number | null>(null);
  const autoFailures = useRef(0);
  // Phones and tablets: palette, step settings and history open as bottom sheets.
  const { isDesktop } = useUiMode();
  const { screenToFlowPosition } = useReactFlow();

  const wrapperRef = useRef<HTMLDivElement>(null);
  const runRequest = useRef<string | null>(null);

  const canEdit = detail?.canEdit ?? false;
  const graph = useMemo(() => ({ nodes, edges }) as WorkflowGraph, [nodes, edges]);
  const dirty = !loading && canEdit && snapshot(graph, name) !== savedSnapshot;
  const structure = useStructure(nodes, edges);
  const analysis = useMemo(() => analyzeGraph(structure), [structure]);
  const blockingIssues = analysis.issues.filter((i) => i.severity === 'error');

  // ─── LOAD ───────────────────────────────────────────────────────────────
  const applyDetail = useCallback(
    (wf: WorkflowDetail, replaceGraph: boolean) => {
      setDetail(wf);
      if (replaceGraph) {
        setName(wf.name);
        setNodes(wf.graph.nodes);
        setEdges(wf.graph.edges);
        setSavedSnapshot(snapshot(wf.graph, wf.name));
      }
    },
    [setNodes, setEdges]
  );

  useEffect(() => {
    if (!workflowId || !user?.id) return;
    (async () => {
      try {
        const wf = await getWorkflow(workflowId);
        if (!wf) {
          toast.error(tr('wf.notFound'));
          router.push('/terminal?tab=pipelines');
          return;
        }
        applyDetail(wf, true);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : tr('wf.notFound'));
        router.push('/terminal?tab=pipelines');
        return;
      }
      setLoading(false);
    })();
  }, [workflowId, user?.id, router, applyDetail]);

  const refreshDetail = useCallback(async () => {
    const wf = await getWorkflow(workflowId);
    if (wf) applyDetail(wf, false);
    return wf;
  }, [workflowId, applyDetail]);

  // Warn before closing or reloading the tab with unsaved changes.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  const confirmLeave = (e: React.MouseEvent) => {
    if (dirty && !window.confirm(t('wf.ver.leaveConfirm'))) e.preventDefault();
  };

  // ─── ACTIONS ────────────────────────────────────────────────────────────
  const clearRunState = useCallback(() => {
    setRunResults({});
    setNodes((nds) =>
      nds.map((n) => ({
        ...n,
        data: { ...n.data, status: 'idle', error: undefined, preview: undefined },
      }))
    );
  }, [setNodes]);

  const deleteNode = useCallback(
    (nodeId: string) => {
      setNodes((nds) => nds.filter((n) => n.id !== nodeId));
      setEdges((eds) => eds.filter((e) => e.source !== nodeId && e.target !== nodeId));
      setSelectedNodeId((cur) => (cur === nodeId ? null : cur));
      setRunResults((prev) => {
        const next = { ...prev };
        delete next[nodeId];
        return next;
      });
    },
    [setNodes, setEdges]
  );

  const duplicateNode = useCallback(
    (nodeId: string) => {
      const src = nodes.find((n) => n.id === nodeId);
      if (!src) return;
      const newId = nextId();
      const newNode: Node<any> = {
        ...src,
        id: newId,
        position: { x: src.position.x + 40, y: src.position.y + 40 },
        selected: false,
        data: {
          ...src.data,
          config: structuredClone(src.data.config || {}),
          status: 'idle',
          preview: undefined,
          error: undefined,
        },
      };
      setNodes((nds) => [...nds, newNode]);
      setSelectedNodeId(newId);
    },
    [nodes, setNodes]
  );

  const onNodeContextMenu = useCallback((e: React.MouseEvent, node: Node<any>) => {
    e.preventDefault();
    e.stopPropagation();
    const bounds = wrapperRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setSelectedNodeId(node.id);
    setContextMenu({ x: e.clientX - bounds.left, y: e.clientY - bounds.top, nodeId: node.id });
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('scroll', close, true);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [contextMenu]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.tagName === 'SELECT' ||
        target?.isContentEditable
      )
        return;
      if (canEdit && (e.key === 'Delete' || e.key === 'Backspace') && selectedNodeId) {
        e.preventDefault();
        deleteNode(selectedNodeId);
        toast.success(tr('wf.nodeDeleted'));
      }
      if (e.key === 'Escape') {
        setSelectedNodeId(null);
        setContextMenu(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectedNodeId, deleteNode, canEdit]);

  const isValidConnection = useCallback(
    (conn: Connection | Edge) =>
      Boolean(conn.source && conn.target) && canConnect(graph, conn.source!, conn.target!),
    [graph]
  );

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!isValidConnection(conn)) {
        toast.error(t('wf.issue.invalidConnection'));
        return;
      }
      setEdges((eds) => addEdge({ ...conn, animated: true }, eds));
    },
    [setEdges, isValidConnection, t]
  );

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  }, []);

  const addNodeAt = useCallback(
    (type: string, clientX: number, clientY: number) => {
      const def = NODE_REGISTRY[type];
      if (!canEdit || !def) return null;
      const at = screenToFlowPosition({ x: clientX, y: clientY });
      const id = nextId();
      const newNode: Node<any> = {
        id,
        type: 'workflowNode',
        position: { x: at.x - 100, y: at.y - 40 },
        data: {
          type,
          label: def.label,
          config: structuredClone(def.defaultConfig),
          status: 'idle',
        },
      };
      setNodes((nds) => [...nds, newNode]);
      return id;
    },
    [setNodes, canEdit, screenToFlowPosition]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      addNodeAt(e.dataTransfer.getData('application/reactflow'), e.clientX, e.clientY);
    },
    [addNodeAt]
  );

  const addNodeInView = useCallback(
    (type: string) => {
      const bounds = wrapperRef.current?.getBoundingClientRect();
      if (!bounds) return;
      const offset = (nodes.length % 5) * 24;
      const id = addNodeAt(
        type,
        bounds.left + bounds.width / 2 + offset,
        bounds.top + Math.min(bounds.height / 3, 200) + offset
      );
      if (id) {
        setPaletteOpen(false);
        setHistoryOpen(false);
        setSelectedNodeId(id);
      }
    },
    [addNodeAt, nodes.length]
  );

  const onNodeClick = useCallback((_: any, node: Node<any>) => {
    setSelectedNodeId(node.id);
    setContextMenu(null);
  }, []);

  const onPaneClick = useCallback(() => {
    setSelectedNodeId(null);
    setContextMenu(null);
  }, []);

  const handleConfigChange = (nodeId: string, config: Record<string, any>) => {
    if (!canEdit) return;
    setNodes((nds) =>
      nds.map((n) => (n.id === nodeId ? { ...n, data: { ...n.data, config } } : n))
    );
  };

  // ─── SAVE / VERSIONS ────────────────────────────────────────────────────
  const save = async (quiet = false): Promise<boolean> => {
    if (!canEdit) return true;
    setSaving(true);
    try {
      const clean = cleanGraph(graph);
      const { updated_at } = await saveWorkflow(workflowId, clean, name, detail?.updated_at);
      setSavedSnapshot(snapshot(clean, name));
      setDetail((d) => (d ? { ...d, updated_at, graph: clean, name } : d));
      await refreshDetail();
      if (!quiet) toast.success(t('wf.saved'));
      return true;
    } catch (e) {
      toast.error(e instanceof WorkflowApiError && e.code ? e.message : t('wf.saveFailed'));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const handleSaveVersion = async (note: string, publish: boolean) => {
    if (dirty && !(await save(true))) return;
    try {
      const v = await saveVersion(workflowId, note, publish);
      toast.success(
        publish
          ? t('wf.ver.publishedVersion', { version: v.version })
          : t('wf.ver.savedVersion', { version: v.version })
      );
      await refreshDetail();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('wf.saveFailed'));
    }
  };

  const handlePublish = async (versionId: string, version: number) => {
    try {
      await publishVersion(workflowId, versionId);
      toast.success(t('wf.ver.publishedVersion', { version }));
      await refreshDetail();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('wf.saveFailed'));
    }
  };

  const handleRestore = async (versionId: string, version: number) => {
    if (!window.confirm(t('wf.ver.restoreConfirm', { version }))) return;
    try {
      const v = await getVersion(workflowId, versionId);
      setName(v.name);
      setNodes(v.graph.nodes);
      setEdges(v.graph.edges);
      clearRunState();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('wf.notFound'));
    }
  };

  const handleDuplicate = async () => {
    if (dirty && !window.confirm(t('wf.ver.leaveConfirm'))) return;
    try {
      const copy = await duplicateWorkflow(workflowId, t('wf.ver.copyName', { name }));
      toast.success(t('wf.ver.duplicated'));
      router.push(`/pipelines/${copy.id}`);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('wf.createFailed'));
    }
  };

  const autoPause: AutoRefreshPause =
    runTarget.target === 'draft'
      ? dirty
        ? 'unsaved'
        : blockingIssues.length
          ? 'issues'
          : null
      : null;

  const stopAutoRefresh = (message?: string) => {
    setAutoRefresh(false);
    autoFailures.current = 0;
    if (message) toast.error(message);
  };

  const autoRunFailed = () => {
    autoFailures.current += 1;
    if (autoFailures.current >= 3) stopAutoRefresh(t('wf.auto.stopped'));
  };

  const handleAutoRun = async () => {
    const target = runTarget.target;
    if (autoPause) return;
    const requestId = crypto.randomUUID();
    runRequest.current = requestId;
    setRunning(true);
    setAutoRunning(true);
    setCancelling(false);
    try {
      // The previous results stay on screen until the new ones arrive.
      const res = await runWorkflow(workflowId, { target }, requestId, undefined, 'auto_refresh');
      if (res.reused) return;
      applyRunResults(res.results ?? {});
      if (res.status === 'success') autoFailures.current = 0;
      else if (res.status !== 'cancelled') autoRunFailed();
    } catch (e) {
      // Another tab refreshed this workflow moments ago: wait for the next minute.
      if (e instanceof WorkflowApiError && e.code === 'tooSoon') return;
      autoRunFailed();
    } finally {
      runRequest.current = null;
      setLastRunAt(Date.now());
      setRunning(false);
      setAutoRunning(false);
      setCancelling(false);
      setHistoryKey((k) => k + 1);
    }
  };

  const applyRunResults = (results: NodeResultMap) => {
    setRunResults(results);
    setNodes((nds) =>
      nds.map((n) => {
        const r = results[n.id];
        const out: any = r?.output;
        const count =
          out && Array.isArray(out.rows) ? (out.meta?.count ?? out.rows.length) : undefined;
        return {
          ...n,
          data: {
            ...n.data,
            status: !r ? 'idle' : r.ok ? 'success' : r.skipped ? 'skipped' : 'error',
            error: r && !r.ok && !r.skipped ? r.error : undefined,
            preview: count === undefined ? undefined : { count },
          },
        };
      })
    );
  };

  const handleRun = async (target: 'draft' | 'published') => {
    if (target === 'draft') {
      if (blockingIssues.length) {
        toast.error(t('wf.run.fixFirst'));
        return;
      }
      // The server runs the saved draft, so unsaved changes are saved first.
      if (dirty && !(await save(true))) return;
    }
    const requestId = crypto.randomUUID();
    runRequest.current = requestId;
    // Drill-down reads the same graph (draft or published version) as this run.
    setRunTarget({ target });
    setRunning(true);
    setCancelling(false);
    setRunResults({});
    setNodes((nds) =>
      nds.map((n) => ({
        ...n,
        data: { ...n.data, status: 'running', error: undefined, preview: undefined },
      }))
    );
    try {
      const res = await runWorkflow(workflowId, { target }, requestId);
      if (res.reused) {
        toast.info(t('wf.run.alreadyRecorded'));
        clearRunState();
        return;
      }
      applyRunResults(res.results ?? {});
      if (res.status === 'success')
        toast.success(t('wf.run.succeeded', { ms: fmt.number(res.durationMs ?? 0) }));
      else if (res.status === 'cancelled') toast.info(t('wf.run.cancelled'));
      else if (res.errorCode === 'timeout') toast.error(t('wf.run.timedOut'));
      else if (res.errorCode === 'invalidGraph')
        toast.error(res.issues?.[0] ? issueText(res.issues[0], t) : t('wf.run.failed'));
      else toast.error(t('wf.run.failed'));
    } catch (e) {
      clearRunState();
      toast.error(e instanceof Error ? e.message : t('wf.executionFailed'));
    } finally {
      runRequest.current = null;
      // The next automatic run is a minute after any run.
      setLastRunAt(Date.now());
      setRunning(false);
      setCancelling(false);
      setHistoryKey((k) => k + 1);
    }
  };

  const handleCancel = async () => {
    const requestId = runRequest.current;
    if (!requestId) return;
    setCancelling(true);
    try {
      await cancelRun(workflowId, { requestId });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t('wf.executionFailed'));
      setCancelling(false);
    }
  };

  // A step keeps its drawn object while it and its check are unchanged, so
  // only the steps that changed are drawn again.
  const viewCache = useRef(new Map<string, { n: any; info: unknown; t: unknown; view: any }>());
  const viewNodes = useMemo(() => {
    const cache = viewCache.current;
    const next = nodes.map((n) => {
      const info = analysis.nodes[n.id];
      const hit = cache.get(n.id);
      if (hit && hit.n === n && hit.info === info && hit.t === t) return hit.view;
      const errors = (info?.issues ?? []).filter((i) => i.severity === 'error');
      const out = info?.outputs.out;
      // The same data while only the position changed (the step's view is memoized on it).
      const data =
        hit && hit.n.data === n.data && hit.info === info && hit.t === t
          ? hit.view.data
          : {
              ...n.data,
              issueCount: errors.length,
              issueText: errors[0] ? issueText(errors[0], t) : undefined,
              fieldCount: out ? out.length : undefined,
            };
      const view = { ...n, data };
      cache.set(n.id, { n, info, t, view });
      return view;
    });
    if (cache.size > nodes.length * 2)
      for (const id of [...cache.keys()]) if (!nodes.some((n) => n.id === id)) cache.delete(id);
    return next;
  }, [nodes, analysis, t]);

  const viewEdges = useMemo(
    () =>
      edges.map((e) => {
        const schema = analysis.nodes[e.source]?.outputs[e.sourceHandle ?? 'out'];
        return schema
          ? {
              ...e,
              label: t('wf.fieldsCount', { count: fmt.number(schema.length) }),
              labelStyle: { fontSize: 9, fill: 'var(--muted-foreground)' },
              labelBgStyle: { fill: 'var(--card)' },
            }
          : e;
      }),
    [edges, analysis, t, fmt]
  );

  const selectedNode = nodes.find((n) => n.id === selectedNodeId) || null;
  const nodeLabels = useMemo(
    () => Object.fromEntries(nodes.map((n) => [n.id, nodeDisplayLabel(n.data, t)])),
    [nodes, t]
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <Loader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  const btn =
    'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[0.75rem] font-medium border border-border hover:bg-[var(--surface-3)] transition-colors disabled:opacity-50 max-lg:min-h-11';

  return (
    <div className="flex flex-col h-[100dvh]">
      <div
        className="min-h-12 border-b flex flex-wrap items-center px-4 py-1.5 gap-2 flex-shrink-0 bg-card"
        style={{ borderColor: 'var(--border)' }}
      >
        <Link
          href="/terminal?tab=pipelines"
          onClick={confirmLeave}
          aria-label={t('wf.back')}
          title={t('wf.back')}
          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft size={14} />
        </Link>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          readOnly={!canEdit}
          aria-label={t('wf.name')}
          className="text-[0.85rem] font-semibold text-foreground bg-transparent outline-none border-none min-w-[160px] flex-shrink"
        />
        <VersionBar
          detail={detail}
          dirty={dirty}
          canEdit={canEdit}
          onSaveVersion={handleSaveVersion}
          onPublish={handlePublish}
          onRestore={handleRestore}
        />
        <div className="flex-1" />
        <span
          className={`text-[0.65rem] ${blockingIssues.length ? 'text-red-600 dark:text-red-400' : 'text-muted-foreground'}`}
          title={blockingIssues.map((i) => issueText(i, t)).join('\n')}
        >
          {blockingIssues.length
            ? t('wf.issue.count', { count: blockingIssues.length })
            : t('wf.issue.none')}
        </span>
        {canEdit && !isDesktop && (
          <button
            onClick={() => {
              setPaletteOpen(true);
              setHistoryOpen(false);
              setSelectedNodeId(null);
            }}
            className={btn}
          >
            <Plus size={12} />
            {t('wf.palette.add')}
          </button>
        )}
        <AutoRefreshButton
          enabled={autoRefresh}
          onToggle={() => {
            autoFailures.current = 0;
            setAutoRefresh((on) => !on);
          }}
          className={btn}
        />
        <button
          onClick={() => {
            setHistoryOpen((o) => !o);
            setPaletteOpen(false);
          }}
          className={btn}
          aria-pressed={historyOpen}
          title={t('wf.run.history')}
        >
          <History size={12} />
          <span className="max-sm:sr-only">{t('wf.run.history')}</span>
        </button>
        <button onClick={handleDuplicate} className={btn} title={t('wf.duplicate')}>
          <CopyPlus size={12} />
          <span className="max-sm:sr-only">{t('wf.duplicate')}</span>
        </button>
        {canEdit && (
          <button
            onClick={() => save()}
            disabled={saving || !dirty}
            className={btn}
            title={t('wf.save')}
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : <Save size={12} />}
            <span className="max-sm:sr-only">{t('wf.save')}</span>
          </button>
        )}
        {detail?.published && (
          <button
            onClick={() => handleRun('published')}
            disabled={running}
            className={btn}
            title={t('wf.run.preview')}
          >
            <Play size={12} />
            <span className="max-sm:sr-only">{t('wf.ver.runPublished')}</span>
          </button>
        )}
        {running ? (
          <button onClick={handleCancel} disabled={cancelling} className={btn}>
            {cancelling ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}
            {cancelling ? t('wf.run.cancelling') : t('wf.run.cancel')}
          </button>
        ) : (
          <button
            onClick={() => handleRun('draft')}
            title={t('wf.run.preview')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[0.75rem] font-medium bg-primary text-primary-foreground disabled:opacity-50 max-lg:min-h-11"
          >
            <Play size={12} />
            {t('wf.run')}
          </button>
        )}
      </div>
      {!canEdit && (
        <p className="px-4 py-1 text-[0.68rem] text-muted-foreground border-b border-border bg-[var(--surface-2)]">
          {t('wf.ver.readOnly')}
        </p>
      )}
      {autoRefresh && (
        <AutoRefreshStatus
          lastRunAt={lastRunAt}
          busy={running || saving}
          refreshing={autoRunning}
          paused={autoPause}
          onDue={handleAutoRun}
        />
      )}
      {running && !autoRunning && (
        <p
          className="px-4 py-1 text-[0.68rem] text-muted-foreground border-b border-border"
          role="status"
        >
          <Loader2 size={10} className="inline animate-spin mr-1" />
          {t('wf.run.onServer')}
        </p>
      )}

      <div className="flex-1 flex overflow-hidden relative">
        {canEdit && isDesktop && <NodePalette onAdd={addNodeInView} />}

        <div ref={wrapperRef} className="flex-1 relative min-w-0">
          <ReactFlow
            nodes={viewNodes}
            edges={viewEdges}
            onNodesChange={onNodesChange}
            onEdgesChange={canEdit ? onEdgesChange : undefined}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            onDrop={onDrop}
            onDragOver={onDragOver}
            onNodeClick={onNodeClick}
            onNodeContextMenu={canEdit ? onNodeContextMenu : undefined}
            onPaneClick={onPaneClick}
            nodesDraggable={canEdit}
            nodesConnectable={canEdit}
            nodeTypes={nodeTypes}
            fitView
            proOptions={{ hideAttribution: true }}
            deleteKeyCode={null}
            onContextMenu={(e) => e.preventDefault()}
          >
            <Background gap={16} size={1} color="var(--border)" />
            <Controls />
            {isDesktop && (
              <MiniMap
                nodeColor={(n: any) => NODE_REGISTRY[n.data?.type]?.color || '#888'}
                maskColor="rgba(0,0,0,0.1)"
                style={{ background: 'var(--card)' }}
              />
            )}
          </ReactFlow>

          {nodes.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none px-6">
              <div className="text-center">
                <p className="text-[0.85rem] text-muted-foreground mb-1">
                  {t(isDesktop ? 'wf.dragHint' : 'wf.palette.emptyTouch')}
                </p>
                <p className="text-[0.7rem] text-muted-foreground opacity-60">
                  {t('wf.connectHint')}
                </p>
              </div>
            </div>
          )}

          {canEdit && isDesktop && selectedNodeId && !contextMenu && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-md bg-card border border-border shadow-lg pointer-events-none">
              <p className="text-[0.68rem]" style={{ color: 'var(--muted-foreground)' }}>
                <kbd className="px-1 py-0.5 rounded bg-[var(--surface-3)] font-mono text-[0.62rem]">
                  RMB
                </kbd>
                {' · '}
                <kbd className="px-1 py-0.5 rounded bg-[var(--surface-3)] font-mono text-[0.62rem]">
                  Del
                </kbd>
                {' · '}
                <kbd className="px-1 py-0.5 rounded bg-[var(--surface-3)] font-mono text-[0.62rem]">
                  ⌫
                </kbd>
                {t('wf.toManage')}
              </p>
            </div>
          )}

          {contextMenu && (
            <div
              className="absolute z-50 min-w-[160px] rounded-lg border border-border bg-card shadow-xl overflow-hidden py-1"
              style={{ left: contextMenu.x, top: contextMenu.y }}
              onMouseDown={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <button
                onClick={() => {
                  setSelectedNodeId(contextMenu.nodeId);
                  setContextMenu(null);
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[0.75rem] text-foreground hover:bg-[var(--surface-3)] transition-colors"
              >
                <Settings size={12} className="text-muted-foreground" />
                {t('wf.configure')}
              </button>
              <button
                onClick={() => {
                  duplicateNode(contextMenu.nodeId);
                  setContextMenu(null);
                  toast.success(t('wf.nodeDuplicated'));
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[0.75rem] text-foreground hover:bg-[var(--surface-3)] transition-colors"
              >
                <Copy size={12} className="text-muted-foreground" />
                {t('wf.duplicate')}
              </button>
              <div className="my-1 h-px bg-[var(--border)]" />
              <button
                onClick={() => {
                  deleteNode(contextMenu.nodeId);
                  setContextMenu(null);
                  toast.success(t('wf.nodeDeleted'));
                }}
                className="w-full flex items-center gap-2 px-3 py-1.5 text-[0.75rem] text-red-500 hover:bg-red-500/10 transition-colors"
              >
                <Trash2 size={12} />
                {t('wf.delete')}
              </button>
            </div>
          )}
        </div>

        {(() => {
          const inspector = (
            <NodeInspector
              node={selectedNode as any}
              runResult={selectedNodeId ? runResults[selectedNodeId] : undefined}
              schema={selectedNodeId ? analysis.nodes[selectedNodeId] : undefined}
              readOnly={!canEdit}
              onChange={handleConfigChange}
              onClose={() => setSelectedNodeId(null)}
              onDuplicate={
                canEdit ? () => selectedNodeId && duplicateNode(selectedNodeId) : undefined
              }
              onDelete={
                canEdit
                  ? () => {
                      if (selectedNodeId) {
                        deleteNode(selectedNodeId);
                        toast.success(t('wf.nodeDeleted'));
                      }
                    }
                  : undefined
              }
              workflowId={workflowId}
              runTarget={runTarget}
            />
          );
          const history = (
            <RunHistoryPanel
              workflowId={workflowId}
              refreshKey={historyKey}
              onClose={() => setHistoryOpen(false)}
              nodeLabels={nodeLabels}
            />
          );
          if (isDesktop) return historyOpen ? history : inspector;
          const content =
            paletteOpen && canEdit ? (
              <>
                <div className="flex justify-end border-b border-border px-2 pt-1">
                  <button
                    onClick={() => setPaletteOpen(false)}
                    className="inline-flex h-11 w-11 items-center justify-center text-muted-foreground"
                    aria-label={t('wf.close')}
                  >
                    <X size={16} />
                  </button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto">
                  <NodePalette onAdd={addNodeInView} sheet />
                </div>
              </>
            ) : historyOpen ? (
              history
            ) : selectedNode ? (
              inspector
            ) : null;
          return content ? (
            <div
              role="dialog"
              aria-label={
                paletteOpen ? t('wf.nodes') : historyOpen ? t('wf.run.history') : t('wf.configure')
              }
              className="absolute inset-x-0 bottom-0 z-30 flex h-[72%] flex-col overflow-hidden rounded-t-xl border-t border-border bg-card shadow-2xl"
              style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
            >
              {content}
            </div>
          ) : null;
        })()}
      </div>
    </div>
  );
}

export default function PipelineEditor() {
  return (
    <ReactFlowProvider>
      <EditorInner />
    </ReactFlowProvider>
  );
}
