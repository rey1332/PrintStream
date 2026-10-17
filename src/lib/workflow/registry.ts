import {
  Users,
  Truck,
  Package,
  FileText,
  CreditCard,
  TrendingUp,
  Warehouse,
  ShoppingCart,
  ClipboardList,
  Filter,
  ArrowDownUp,
  Slice,
  Calculator,
  Table as TableIcon,
  BarChart3,
  LineChart,
  Hash,
  Download,
  Sigma,
  Database,
  Columns3,
  FunctionSquare,
  ShieldCheck,
  GitFork,
  PackageCheck,
  Layers,
} from 'lucide-react';
import { defaultSummary } from '@/lib/analytics/summary';
import { createClient } from '@/lib/data/client';
import {
  customerService,
  supplierService,
  productService,
  invoiceService,
  paymentService,
  transactionService,
} from '@/app/erp/lib/erpService';
import { readScope } from '@/app/erp/lib/workspace';
import { QUERY_LIMITS } from '@/lib/analytics/query';
import { RUNTIME, type ErpSourceConfig } from './runtime';
import { UNIFY_COLORS, UNIFY_META } from './unifyNodes';
import type { NodeCategory, PickerConfig } from './types';
import { tr } from '@/lib/i18n/translate';

export type { ErpSourceConfig } from './runtime';
export { erpSourceSpec } from './runtime';

export interface NodeDefinition {
  type: string;
  category: NodeCategory;
  label: string;
  description: string;
  icon: any;
  color: string;
  inputs: number;
  outputs: number;
  outputHandles: readonly string[];
  defaultConfig: Record<string, any>;
  picker?: PickerConfig;
}

// ─── PICKERS (list records to choose one; read in the browser like ERP pages) ─
const loadAll = async (table: string, userId: string) => {
  const scope = readScope(userId);
  const { data, error } = await createClient()
    .from(table)
    .select('*')
    .eq(scope.column, scope.value);
  if (error)
    throw new Error(
      tr('wf.err.loadTable', { table: table.replace(/^erp_/, '').replaceAll('_', ' ') })
    );
  return data || [];
};

const picker = (
  loadRecords: PickerConfig['loadRecords'],
  displayField: string,
  secondaryField: string,
  searchFields: string[],
  placeholder: string
): PickerConfig => ({
  loadRecords,
  valueField: 'id',
  displayField,
  secondaryField,
  searchFields,
  placeholder,
});

const PICKERS: Record<string, PickerConfig> = {
  'src.customers': picker(
    (u) => customerService.getAll(u) as any,
    'name',
    'email',
    ['name', 'email', 'city'],
    'All customers'
  ),
  'src.suppliers': picker(
    (u) => supplierService.getAll(u) as any,
    'name',
    'email',
    ['name', 'email', 'city'],
    'All suppliers'
  ),
  'src.products': picker(
    (u) => productService.getAll(u) as any,
    'name',
    'sku',
    ['name', 'sku', 'category'],
    'All products'
  ),
  'src.invoices': picker(
    (u) => invoiceService.getAll(u) as any,
    'id',
    'customer_name',
    ['id', 'customer_name', 'status'],
    'All invoices'
  ),
  'src.payments': picker(
    (u) => paymentService.getAll(u) as any,
    'id',
    'party',
    ['party', 'note', 'method'],
    'All payments'
  ),
  'src.transactions': picker(
    (u) => transactionService.getAll(u) as any,
    'description',
    'category',
    ['description', 'category', 'type'],
    'All transactions'
  ),
  'src.inventory': picker(
    (u) => productService.getAll(u) as any,
    'name',
    'sku',
    ['name', 'sku', 'category'],
    'All inventory items'
  ),
  'src.salesOrders': picker(
    (u) => loadAll('erp_sales_orders', u),
    'id',
    'customer_name',
    ['id', 'customer_name', 'status'],
    'All sales orders'
  ),
  'src.purchaseOrders': picker(
    (u) => loadAll('erp_purchase_orders', u),
    'id',
    'supplier_name',
    ['id', 'supplier_name', 'status'],
    'All purchase orders'
  ),
};

// ─── DEFINITIONS ─────────────────────────────────────────────────────────────
type Meta = Omit<NodeDefinition, 'inputs' | 'outputs' | 'outputHandles' | 'picker'>;

const SOURCE = '#3b82f6';
const TRANSFORM = '#a855f7';
const ANALYSIS = '#f59e0b';
const OUTPUT = '#10b981';

const legacySource = (type: string, label: string, description: string, icon: any): Meta => ({
  type,
  category: 'source',
  label,
  description,
  icon,
  color: SOURCE,
  defaultConfig: { selectedId: '', erpId: '' },
});

const META: Meta[] = [
  {
    type: 'src.erp',
    category: 'source',
    label: 'ERP Data',
    description: 'Fields from any ERP module and its related records',
    icon: Database,
    color: SOURCE,
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
    icon: Layers,
    color: SOURCE,
    defaultConfig: { ...defaultSummary('invoices'), erpId: '' },
  },
  {
    type: 'src.psDataset',
    category: 'source',
    label: 'Dataset',
    description: 'Rows of a Terminal dataset',
    icon: TableIcon,
    color: SOURCE,
    defaultConfig: { datasetId: '', limit: 10_000 },
  },
  legacySource('src.customers', 'Customers', 'Load customers (all or pick one)', Users),
  legacySource('src.suppliers', 'Suppliers', 'Load suppliers (all or pick one)', Truck),
  legacySource('src.products', 'Products', 'Load products (all or pick one)', Package),
  legacySource('src.invoices', 'Invoices', 'Load invoices (all or pick one)', FileText),
  legacySource('src.payments', 'Payments', 'Load payments (all or pick one)', CreditCard),
  legacySource(
    'src.transactions',
    'Transactions',
    'Load transactions (all or pick one)',
    TrendingUp
  ),
  legacySource(
    'src.inventory',
    'Inventory Items',
    'Load inventory items (all or pick one)',
    Warehouse
  ),
  legacySource(
    'src.salesOrders',
    'Sales Orders',
    'Load sales orders (all or pick one)',
    ShoppingCart
  ),
  legacySource(
    'src.purchaseOrders',
    'Purchase Orders',
    'Load purchase orders (all or pick one)',
    ClipboardList
  ),

  {
    type: 'tf.filter',
    category: 'transform',
    label: 'Filter Rows',
    description: 'Keep rows where column matches condition',
    icon: Filter,
    color: TRANSFORM,
    defaultConfig: { column: '', operator: '=', value: '' },
  },
  {
    type: 'tf.sort',
    category: 'transform',
    label: 'Sort',
    description: 'Sort rows by a column',
    icon: ArrowDownUp,
    color: TRANSFORM,
    defaultConfig: { column: '', direction: 'asc' },
  },
  {
    type: 'tf.limit',
    category: 'transform',
    label: 'Limit Rows',
    description: 'Keep first N rows',
    icon: Slice,
    color: TRANSFORM,
    defaultConfig: { n: 100 },
  },
  {
    type: 'tf.select',
    category: 'transform',
    label: 'Select & Rename',
    description: 'Keep some columns and rename them',
    icon: Columns3,
    color: TRANSFORM,
    defaultConfig: { columns: '', rename: '' },
  },
  {
    type: 'tf.aggregate',
    category: 'transform',
    label: 'Aggregate',
    description: 'Group by column and aggregate another',
    icon: Calculator,
    color: TRANSFORM,
    defaultConfig: { groupBy: '', aggregateColumn: '', operation: 'sum' },
  },
  {
    type: 'tf.calc',
    category: 'transform',
    label: 'Calculated Field',
    description: 'New column from a formula over other columns',
    icon: FunctionSquare,
    color: TRANSFORM,
    defaultConfig: { newColumn: 'result', formula: '' },
  },
  {
    type: 'tf.mapColumn',
    category: 'transform',
    label: 'Compute Column',
    description: 'Create a new column from a formula',
    icon: Hash,
    color: TRANSFORM,
    defaultConfig: { newColumn: 'result', formula: 'a + b', colA: '', colB: '' },
  },
  {
    type: 'tf.join',
    category: 'transform',
    label: 'Join Tables',
    description: 'Join two tables on a key',
    icon: TableIcon,
    color: TRANSFORM,
    defaultConfig: { leftKey: 'id', rightKey: 'id', joinType: 'inner' },
  },
  {
    type: 'tf.validate',
    category: 'transform',
    label: 'Validate Data',
    description: 'Check required values, types and duplicate keys',
    icon: ShieldCheck,
    color: TRANSFORM,
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
    icon: GitFork,
    color: TRANSFORM,
    defaultConfig: { column: '', operator: '=', value: '' },
  },

  ...UNIFY_META,

  {
    type: 'an.describe',
    category: 'analysis',
    label: 'Describe Column',
    description: 'Compute stats for a numeric column',
    icon: Sigma,
    color: ANALYSIS,
    defaultConfig: { column: '' },
  },
  {
    type: 'an.fitDistribution',
    category: 'analysis',
    label: 'Fit Distribution',
    description: 'Fit normal/exponential/lognormal',
    icon: TrendingUp,
    color: ANALYSIS,
    defaultConfig: { column: '' },
  },

  {
    type: 'out.table',
    category: 'output',
    label: 'Table View',
    description: 'Display full data table',
    icon: TableIcon,
    color: OUTPUT,
    defaultConfig: { maxRows: 200 },
  },
  {
    type: 'out.barChart',
    category: 'output',
    label: 'Bar Chart',
    description: 'Bar chart of category vs value',
    icon: BarChart3,
    color: OUTPUT,
    defaultConfig: { categoryColumn: '', valueColumn: '', aggregation: 'sum' },
  },
  {
    type: 'out.lineChart',
    category: 'output',
    label: 'Line Chart',
    description: 'Line chart of x vs y',
    icon: LineChart,
    color: OUTPUT,
    defaultConfig: { xColumn: '', yColumn: '' },
  },
  {
    type: 'out.kpi',
    category: 'output',
    label: 'KPI Value',
    description: 'Single aggregated value',
    icon: Hash,
    color: OUTPUT,
    defaultConfig: { column: '', label: 'KPI', operation: 'sum' },
  },
  {
    type: 'out.csv',
    category: 'output',
    label: 'Export CSV',
    description: 'Download data as CSV',
    icon: Download,
    color: OUTPUT,
    defaultConfig: { filename: 'export.csv' },
  },
  {
    type: 'out.psDataset',
    category: 'output',
    label: 'Write to dataset',
    description: 'Store the rows in a Terminal dataset (background runs only)',
    icon: Database,
    color: OUTPUT,
    defaultConfig: { datasetId: '', mode: 'append' },
  },
  {
    type: 'out.erpList',
    category: 'output',
    label: 'Add to ERP list',
    description: 'Add the rows to an ERP’s customers, suppliers or products (background runs only)',
    icon: Users,
    color: OUTPUT,
    defaultConfig: { erpId: '', list: 'customers', erpMode: 'add_new' },
  },
  {
    type: 'out.dataset',
    category: 'output',
    label: 'Output Dataset',
    description: 'Name the result of this workflow',
    icon: PackageCheck,
    color: OUTPUT,
    defaultConfig: { name: 'dataset' },
  },
];

export const NODE_DEFINITIONS: NodeDefinition[] = META.map((m) => {
  const runtime = RUNTIME[m.type];
  return {
    ...m,
    inputs: runtime.inputs,
    outputs: runtime.outputs.length,
    outputHandles: runtime.outputs.length > 1 ? runtime.outputs : [],
    picker: PICKERS[m.type],
  };
});

export const NODE_REGISTRY: Record<string, NodeDefinition> = Object.fromEntries(
  NODE_DEFINITIONS.map((d) => [d.type, d])
);

export const CATEGORIES: { id: NodeCategory; label: string; color: string }[] = [
  { id: 'source', label: 'Data Sources', color: SOURCE },
  { id: 'transform', label: 'Transform', color: TRANSFORM },
  { id: 'combine', label: 'Combine & Clean', color: UNIFY_COLORS.combine },
  { id: 'match', label: 'Match Records', color: UNIFY_COLORS.match },
  { id: 'reshape', label: 'Reshape', color: UNIFY_COLORS.reshape },
  { id: 'quality', label: 'Data Quality', color: UNIFY_COLORS.quality },
  { id: 'analysis', label: 'Analysis', color: ANALYSIS },
  { id: 'output', label: 'Outputs', color: OUTPUT },
];
