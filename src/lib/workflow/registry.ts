import {
  Braces,
  PieChart,
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
import { RUNTIME } from './runtime';
import { CORE_NODE_INFO, type NodeInfo } from './nodeCatalog';
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

const ICONS: Record<string, any> = {
  'src.erp': Database,
  'src.erpSummary': Layers,
  'src.psDataset': TableIcon,
  'src.customers': Users,
  'src.suppliers': Truck,
  'src.products': Package,
  'src.invoices': FileText,
  'src.payments': CreditCard,
  'src.transactions': TrendingUp,
  'src.inventory': Warehouse,
  'src.salesOrders': ShoppingCart,
  'src.purchaseOrders': ClipboardList,
  'tf.filter': Filter,
  'tf.sort': ArrowDownUp,
  'tf.limit': Slice,
  'tf.select': Columns3,
  'tf.aggregate': Calculator,
  'tf.calc': FunctionSquare,
  'tf.mapColumn': Hash,
  'tf.join': TableIcon,
  'tf.validate': ShieldCheck,
  'tf.code': Braces,
  'tf.branch': GitFork,
  'an.describe': Sigma,
  'an.fitDistribution': TrendingUp,
  'out.table': TableIcon,
  'out.barChart': BarChart3,
  'out.lineChart': LineChart,
  'out.chart': PieChart,
  'out.kpi': Hash,
  'out.csv': Download,
  'out.psDataset': Database,
  'out.erpList': Users,
  'out.dataset': PackageCheck,
};

const COLORS: Partial<Record<NodeCategory, string>> = {
  source: SOURCE,
  transform: TRANSFORM,
  analysis: ANALYSIS,
  output: OUTPUT,
};
const withLook = (m: NodeInfo): Meta => ({ ...m, icon: ICONS[m.type], color: COLORS[m.category]! });

// In the palette's order: the unified-data nodes between Transform and Analysis.
const META: Meta[] = [
  ...CORE_NODE_INFO.filter((m) => m.category === 'source' || m.category === 'transform').map(
    withLook
  ),
  ...UNIFY_META,
  ...CORE_NODE_INFO.filter((m) => m.category === 'analysis' || m.category === 'output').map(
    withLook
  ),
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
