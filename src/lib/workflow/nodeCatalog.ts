// What each core pipeline node is (type, palette group, name, description,
// starting configuration), without the editor's icons and pickers: shared by
// the editor's registry (registry.ts) and the server (MCP, src/server/mcp).
// The combine / match / reshape / quality nodes are in unifyNodes.ts.

import { defaultSummary } from '@/lib/analytics/summary';
import { QUERY_LIMITS } from '@/lib/analytics/query';
import type { ErpSourceConfig } from './runtime';
import type { NodeCategory } from './types';

export interface NodeInfo {
  type: string;
  category: NodeCategory;
  label: string;
  description: string;
  defaultConfig: Record<string, any>;
}

const legacySource = (type: string, label: string, description: string): NodeInfo => ({
  type,
  category: 'source',
  label,
  description,
  defaultConfig: { selectedId: '', erpId: '' },
});

export const CORE_NODE_INFO: NodeInfo[] = [
  {
    type: 'src.erp',
    category: 'source',
    label: 'ERP Data',
    description: 'Fields from any ERP module and its related records',
    defaultConfig: {
      entity: 'invoices',
      fields: ['invoice_date', 'customer_name', 'status', 'total', 'amount_paid', 'balance_due'],
      related: [],
      filters: [],
      sort: null,
      limit: QUERY_LIMITS.defaultRows,
      erpId: '',
    } satisfies ErpSourceConfig,
  },
  {
    type: 'src.erpSummary',
    category: 'source',
    label: 'ERP Summary',
    description: 'Group and total ERP records in the database, over every matching record',
    defaultConfig: { ...defaultSummary('invoices'), erpId: '' },
  },
  {
    type: 'src.psDataset',
    category: 'source',
    label: 'Dataset',
    description: 'Rows of a Terminal dataset',
    defaultConfig: { datasetId: '', limit: 10_000 },
  },
  legacySource('src.customers', 'Customers', 'Load customers (all or pick one)'),
  legacySource('src.suppliers', 'Suppliers', 'Load suppliers (all or pick one)'),
  legacySource('src.products', 'Products', 'Load products (all or pick one)'),
  legacySource('src.invoices', 'Invoices', 'Load invoices (all or pick one)'),
  legacySource('src.payments', 'Payments', 'Load payments (all or pick one)'),
  legacySource('src.transactions', 'Transactions', 'Load transactions (all or pick one)'),
  legacySource('src.inventory', 'Inventory Items', 'Load inventory items (all or pick one)'),
  legacySource('src.salesOrders', 'Sales Orders', 'Load sales orders (all or pick one)'),
  legacySource('src.purchaseOrders', 'Purchase Orders', 'Load purchase orders (all or pick one)'),

  {
    type: 'tf.filter',
    category: 'transform',
    label: 'Filter Rows',
    description: 'Keep rows where column matches condition',
    defaultConfig: { column: '', operator: '=', value: '' },
  },
  {
    type: 'tf.sort',
    category: 'transform',
    label: 'Sort',
    description: 'Sort rows by a column',
    defaultConfig: { column: '', direction: 'asc' },
  },
  {
    type: 'tf.limit',
    category: 'transform',
    label: 'Limit Rows',
    description: 'Keep first N rows',
    defaultConfig: { n: 100 },
  },
  {
    type: 'tf.select',
    category: 'transform',
    label: 'Select & Rename',
    description: 'Keep some columns and rename them',
    defaultConfig: { columns: '', rename: '' },
  },
  {
    type: 'tf.aggregate',
    category: 'transform',
    label: 'Aggregate',
    description: 'Group by column and aggregate another',
    defaultConfig: { groupBy: '', aggregateColumn: '', operation: 'sum' },
  },
  {
    type: 'tf.calc',
    category: 'transform',
    label: 'Calculated Field',
    description: 'New column from a formula over other columns',
    defaultConfig: { newColumn: 'result', formula: '' },
  },
  {
    type: 'tf.mapColumn',
    category: 'transform',
    label: 'Compute Column',
    description: 'Create a new column from a formula',
    defaultConfig: { newColumn: 'result', formula: 'a + b', colA: '', colB: '' },
  },
  {
    type: 'tf.join',
    category: 'transform',
    label: 'Join Tables',
    description: 'Join two tables on a key',
    defaultConfig: { leftKey: 'id', rightKey: 'id', joinType: 'inner' },
  },
  {
    type: 'tf.validate',
    category: 'transform',
    label: 'Validate Data',
    description: 'Check required values, types and duplicate keys',
    defaultConfig: {
      requiredColumns: '',
      numericColumns: '',
      dateColumns: '',
      uniqueKey: '',
      action: 'report',
    },
  },
  {
    type: 'tf.branch',
    category: 'transform',
    label: 'Branch',
    description: 'Split rows into matching and other rows',
    defaultConfig: { column: '', operator: '=', value: '' },
  },

  {
    type: 'an.describe',
    category: 'analysis',
    label: 'Describe Column',
    description: 'Compute stats for a numeric column',
    defaultConfig: { column: '' },
  },
  {
    type: 'an.fitDistribution',
    category: 'analysis',
    label: 'Fit Distribution',
    description: 'Fit normal/exponential/lognormal',
    defaultConfig: { column: '' },
  },

  {
    type: 'out.table',
    category: 'output',
    label: 'Table View',
    description: 'Display full data table',
    defaultConfig: { maxRows: 200 },
  },
  {
    type: 'out.barChart',
    category: 'output',
    label: 'Bar Chart',
    description: 'Bar chart of category vs value',
    defaultConfig: { categoryColumn: '', valueColumn: '', aggregation: 'sum' },
  },
  {
    type: 'out.lineChart',
    category: 'output',
    label: 'Line Chart',
    description: 'Line chart of x vs y',
    defaultConfig: { xColumn: '', yColumn: '' },
  },
  {
    type: 'out.kpi',
    category: 'output',
    label: 'KPI Value',
    description: 'Single aggregated value',
    defaultConfig: { column: '', label: 'KPI', operation: 'sum' },
  },
  {
    type: 'out.csv',
    category: 'output',
    label: 'Export CSV',
    description: 'Download data as CSV',
    defaultConfig: { filename: 'export.csv' },
  },
  {
    type: 'out.psDataset',
    category: 'output',
    label: 'Write to dataset',
    description: 'Store the rows in a Terminal dataset (background runs only)',
    defaultConfig: { datasetId: '', mode: 'append' },
  },
  {
    type: 'out.erpList',
    category: 'output',
    label: 'Add to ERP list',
    description: 'Add the rows to an ERP’s customers, suppliers or products (background runs only)',
    defaultConfig: { erpId: '', list: 'customers', erpMode: 'add_new' },
  },
  {
    type: 'out.dataset',
    category: 'output',
    label: 'Output Dataset',
    description: 'Name the result of this workflow',
    defaultConfig: { name: 'dataset' },
  },
];
