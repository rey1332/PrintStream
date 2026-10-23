import type { ConnectorKind } from '@/lib/terminal/connectors';
import { accurate } from './accurate';
import { jurnal } from './jurnal';
import { mcp } from './mcp';
import { odoo } from './odoo';
import { postgres } from './postgres';
import { rest } from './rest';
import { web } from './web';
import { sheets } from './sheets';
import { sapB1 } from './sapb1';
import type { Adapter } from './types';

export const ADAPTERS: Record<ConnectorKind, Adapter> = {
  accurate,
  jurnal,
  odoo,
  sap_b1: sapB1,
  postgres,
  rest,
  web,
  mcp,
  sheets,
};
