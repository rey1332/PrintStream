import type { Node, Edge } from '@xyflow/react';
import type { EntityKey, FieldType } from '@/lib/analytics/catalog';
import type { QualityIssue, QualityReport } from './runtime';

export type NodeCategory =
  | 'source'
  | 'transform'
  | 'combine'
  | 'match'
  | 'reshape'
  | 'quality'
  | 'analysis'
  | 'output';

export interface ColumnLineage {
  entity: EntityKey;
  field?: string;
  relation?: string;
  op?: string;
  bucket?: string;
}

export interface DataWarning {
  key: string;
  vars?: Record<string, string | number>;
}

export interface DataTable {
  columns: string[];
  rows: Record<string, any>[];
  meta?: {
    source?: string;
    count?: number;
    columnTypes?: Record<string, FieldType>;
    fetchedAt?: string;
    warnings?: DataWarning[];
    quality?: QualityReport;
    issues?: QualityIssue[];
    dataset?: string;
    preAggregated?: boolean;
    sourceRows?: number;
    displayTruncated?: boolean;
    lineage?: Record<string, ColumnLineage>;
    repeated?: string[];
    truncated?: boolean;
    partial?: boolean;
    summary?: { entity: EntityKey; recordCount: number };
  };
}

export interface PickerConfig {
  loadRecords: (userId: string) => Promise<any[]>;
  valueField: string;
  displayField: string;
  secondaryField?: string;
  searchFields?: string[];
  placeholder?: string;
}

export interface WorkflowNodeData {
  type: string;
  label: string;
  config: Record<string, any>;
  status?: 'idle' | 'running' | 'success' | 'error';
  preview?: any;
  error?: string;
  [key: string]: any;
}

export type WorkflowNode = Node<WorkflowNodeData>;
export type WorkflowEdge = Edge;

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface Workflow {
  id: string;
  user_id: string;
  name: string;
  description?: string;
  graph: WorkflowGraph;
  /** The ERP or TERMINAL it belongs to (null: a personal one from before workspaces). */
  workspace_id?: string | null;
  created_at: string;
  updated_at: string;
}
