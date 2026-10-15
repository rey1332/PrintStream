import {
  Banknote,
  Building2,
  LayoutDashboard,
  Users,
  Truck,
  Package,
  Warehouse,
  ShoppingCart,
  ClipboardList,
  FileText,
  CreditCard,
  TrendingUp,
  BarChart3,
  Settings,
  Landmark,
  Search,
  Paperclip,
  Contact,
  Clock,
  History,
  Wallet,
  ArrowLeftRight,
  Inbox,
  CalendarDays,
  Scale,
  Factory,
  Fuel,
  ReceiptText,
} from 'lucide-react';
import type { ElementType } from 'react';
import type { MessageKey } from '@/lib/i18n/messages';
import type { Capability } from '../../lib/erpRules';
import type { ModuleCode } from '@/lib/industry';

// ERP navigation, shared by the refined and legacy shells.

export interface ERPNavItem {
  icon: ElementType;
  label: MessageKey;
  href: string;
  requires?: readonly Capability[];
  /** Shown only in ERPs with this module switched on. */
  module?: ModuleCode;
}

export interface ERPNavGroup {
  title: MessageKey;
  items: ERPNavItem[];
}

export const ERP_NAV: ERPNavGroup[] = [
  {
    title: 'erp.nav.overview',
    items: [
      { icon: LayoutDashboard, label: 'erp.nav.dashboard', href: '/erp', requires: ['read'] },
      // Every role searches, within the areas it may read.
      { icon: Search, label: 'erp.nav.search', href: '/erp/search' },
    ],
  },
  {
    title: 'erp.nav.masterData',
    items: [
      {
        icon: Users,
        label: 'erp.nav.customers',
        href: '/erp/customers',
        requires: ['read', 'customers'],
      },
      {
        icon: Truck,
        label: 'erp.nav.suppliers',
        href: '/erp/suppliers',
        requires: ['read', 'suppliers'],
      },
      {
        icon: Package,
        label: 'erp.nav.products',
        href: '/erp/products',
        requires: ['read', 'products'],
      },
    ],
  },
  {
    title: 'erp.nav.operations',
    items: [
      {
        icon: Warehouse,
        label: 'erp.nav.inventory',
        href: '/erp/inventory',
        requires: ['read', 'inventory'],
      },
      {
        icon: ShoppingCart,
        label: 'erp.nav.purchaseOrders',
        href: '/erp/purchase-orders',
        requires: ['read', 'purchasing', 'receiving'],
      },
      {
        icon: ClipboardList,
        label: 'erp.nav.salesOrders',
        href: '/erp/sales-orders',
        requires: ['read', 'sales', 'fulfillment'],
      },
      {
        icon: FileText,
        label: 'erp.nav.invoices',
        href: '/erp/invoices',
        requires: ['read', 'invoicing'],
      },
      {
        icon: CreditCard,
        label: 'erp.nav.payments',
        href: '/erp/payments',
        requires: ['read', 'payments'],
      },
      {
        icon: Banknote,
        label: 'erp.nav.cashBank',
        href: '/erp/cash-bank',
        requires: ['payments'],
      },
      { icon: TrendingUp, label: 'erp.nav.cashFlow', href: '/erp/cash-flow', requires: ['read'] },
      {
        icon: Building2,
        label: 'erp.nav.fixedAssets',
        href: '/erp/fixed-assets',
        requires: ['payments'],
      },
      { icon: Landmark, label: 'erp.nav.accounting', href: '/erp/accounting', requires: ['read'] },
      {
        icon: ReceiptText,
        label: 'erp.nav.tax',
        href: '/erp/tax',
        requires: ['read', 'invoicing', 'purchasing', 'payments'],
      },
      { icon: BarChart3, label: 'erp.nav.reports', href: '/erp/reports', requires: ['read'] },
    ],
  },
  // Industry modules (Settings → Industry and modules).
  {
    title: 'erp.nav.site',
    items: [
      {
        icon: Scale,
        label: 'erp.nav.weighbridge',
        href: '/erp/weighbridge',
        requires: ['read', 'sales', 'fulfillment'],
        module: 'weighbridge',
      },
      {
        icon: Factory,
        label: 'erp.nav.production',
        href: '/erp/production',
        requires: ['read', 'inventory'],
        module: 'production',
      },
      {
        icon: Fuel,
        label: 'erp.nav.equipment',
        href: '/erp/equipment',
        requires: ['read', 'inventory'],
        module: 'equipment',
      },
    ],
  },
  // Owner and Admin manage employees; the Owner chooses who else records attendance.
  {
    title: 'erp.nav.hr',
    items: [
      {
        icon: Contact,
        label: 'erp.nav.employees',
        href: '/erp/hr/employees',
        requires: ['hr.manage'],
      },
      {
        icon: Clock,
        label: 'erp.nav.attendance',
        href: '/erp/hr/attendance',
        requires: ['hr.record'],
      },
      {
        icon: History,
        label: 'erp.nav.attendanceHistory',
        href: '/erp/hr/history',
        requires: ['hr.record'],
      },
      {
        icon: CalendarDays,
        label: 'erp.nav.leave',
        href: '/erp/hr/leave',
        requires: ['hr.record'],
      },
      {
        icon: Wallet,
        label: 'erp.nav.payroll',
        href: '/erp/hr/payroll',
        requires: ['hr.manage'],
      },
    ],
  },
  {
    title: 'erp.nav.system',
    items: [
      // Every member; the database checks membership and who may delete.
      { icon: Paperclip, label: 'erp.nav.documents', href: '/erp/documents' },
      // Every member sees their ERPs; the database decides who may sync.
      { icon: ArrowLeftRight, label: 'erp.nav.sync', href: '/erp/sync' },
      {
        icon: Inbox,
        label: 'erp.nav.syncInbox',
        href: '/erp/sync-inbox',
        requires: ['invoicing', 'payments'],
      },
      { icon: Settings, label: 'erp.nav.settings', href: '/erp/settings' },
    ],
  },
];

type Can = (capability: Capability) => boolean;
type HasModule = (module: ModuleCode) => boolean;
const NO_MODULES: HasModule = () => false;

export function navItemAllowed(
  item: ERPNavItem,
  can: Can,
  hasModule: HasModule = NO_MODULES
): boolean {
  if (item.module && !hasModule(item.module)) return false;
  return !item.requires || item.requires.some(can);
}

export function navFor(can: Can, hasModule: HasModule = NO_MODULES): ERPNavGroup[] {
  return ERP_NAV.map((group) => ({
    ...group,
    items: group.items.filter((item) => navItemAllowed(item, can, hasModule)),
  })).filter((group) => group.items.length > 0);
}

export function firstAllowedHref(can: Can, hasModule: HasModule = NO_MODULES): string {
  for (const group of ERP_NAV) {
    for (const item of group.items)
      if (item.href !== '/erp/search' && navItemAllowed(item, can, hasModule)) return item.href;
  }
  return '/erp/settings';
}

export function isNavActive(href: string, pathname: string): boolean {
  if (href === '/erp') return pathname === '/erp';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function currentNavItem(pathname: string): ERPNavItem | null {
  for (const group of ERP_NAV) {
    for (const item of group.items) if (isNavActive(item.href, pathname)) return item;
  }
  return null;
}
