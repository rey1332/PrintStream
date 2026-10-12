export interface ChatMetrics {
  totalRevenue: number;
  totalExpenses: number;
  cashBalance: number;
  inventoryValue: number;
  accountsReceivable: number;
  accountsPayable: number;
}

export interface PendingQuestion {
  key: string;
  prompt: string;
  options: { index: number; label: string; command: string }[];
}

export interface ChatContext {
  turn: number;
  userName: string | null;
  lastIntent: string | null;
  lastEntity: string | null;
  pending: PendingQuestion | null;
  recentTopics: string[];
  greeted: boolean;
}

export function createChatContext(): ChatContext {
  return {
    turn: 0,
    userName: null,
    lastIntent: null,
    lastEntity: null,
    pending: null,
    recentTopics: [],
    greeted: false,
  };
}

// 🔒 SAFETY: force context into correct shape (handles HMR / stale cache)
function ensureCtx(ctx: Partial<ChatContext> | null | undefined): ChatContext {
  return {
    turn: typeof ctx?.turn === 'number' ? ctx.turn : 0,
    userName: typeof ctx?.userName === 'string' ? ctx.userName : null,
    lastIntent: typeof ctx?.lastIntent === 'string' ? ctx.lastIntent : null,
    lastEntity: typeof ctx?.lastEntity === 'string' ? ctx.lastEntity : null,
    pending: ctx?.pending ?? null,
    recentTopics: Array.isArray(ctx?.recentTopics) ? ctx.recentTopics : [],
    greeted: ctx?.greeted === true,
  };
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .replace(/[!?.,;]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function fmt(n: number): string {
  return `$${n.toLocaleString()}`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  return s.length >= width ? s : ' '.repeat(width - s.length) + s;
}

const ENTITY_ALIASES: Record<string, string> = {
  transaction: 'd_ts',
  transactions: 'd_ts',
  transaksi: 'd_ts',
  supplier: 'd_sp',
  suppliers: 'd_sp',
  pemasok: 'd_sp',
  vendor: 'd_sp',
  product: 'd_inv',
  products: 'd_inv',
  produk: 'd_inv',
  inventory: 'd_inv',
  inventaris: 'd_inv',
  stock: 'd_inv',
  stok: 'd_inv',
  customer: 'd_cust',
  customers: 'd_cust',
  pelanggan: 'd_cust',
  client: 'd_cust',
  payment: 'd_pay',
  payments: 'd_pay',
  pembayaran: 'd_pay',
  po: 'd_po',
  'purchase order': 'd_po',
  'purchase orders': 'd_po',
  so: 'd_so',
  'sales order': 'd_so',
  'sales orders': 'd_so',
  invoice: 'd_invcs',
  invoices: 'd_invcs',
  tagihan: 'd_invcs',
  faktur: 'd_invcs',
  audit: 'd_aud',
  'audit log': 'd_aud',
  'audit logs': 'd_aud',
  everything: 'd_all',
  semua: 'd_all',
};

const ENTITY_KEYS = Object.keys(ENTITY_ALIASES).sort((a, b) => b.length - a.length);

const ENTITY_LABEL: Record<string, string> = {
  d_ts: 'transactions',
  d_sp: 'suppliers',
  d_inv: 'products / inventory',
  d_cust: 'customers',
  d_pay: 'payments',
  d_po: 'purchase orders',
  d_so: 'sales orders',
  d_invcs: 'invoices',
  d_aud: 'audit logs',
  d_all: 'ALL ERP data',
};

interface Entities {
  tables: string[];
  name: string | null;
  numbers: number[];
}

function extractEntities(text: string): Entities {
  const t = ` ${norm(text)} `;
  const tables: string[] = [];
  const seen = new Set<string>();
  for (const k of ENTITY_KEYS) {
    if (new RegExp(`\\b${k}\\b`).test(t) && !seen.has(ENTITY_ALIASES[k])) {
      seen.add(ENTITY_ALIASES[k]);
      tables.push(ENTITY_ALIASES[k]);
    }
  }
  const nameMatch = t.match(
    /\b(?:my name is|i am|i'm|call me|nama saya|panggil saya)\s+([a-z][a-z0-9_-]{1,24})\b/i
  );
  const numbers = (text.match(/-?\d+(\.\d+)?/g) || []).map(Number);
  return {
    tables,
    name: nameMatch ? nameMatch[1] : null,
    numbers,
  };
}

interface RespondCtx {
  text: string;
  ctx: ChatContext;
  ents: Entities;
  metrics?: ChatMetrics;
}

interface IntentResult {
  reply: string[];
  patch?: Partial<ChatContext>;
}

interface Intent {
  name: string;
  score: (ctx: RespondCtx) => number;
  run: (ctx: RespondCtx) => IntentResult;
}

const INTENTS: Intent[] = [
  // IDENTITY
  {
    name: 'identity',
    score: ({ text }) =>
      /^(who are you|what are you|your name|nama kamu|siapa kamu)/i.test(text) ? 0.95 : 0,
    run: () => ({
      reply: [
        'PrintStream Developer Console',
        'A built-in assistant for the PrintStream application.',
        '',
        'Capabilities:',
        '  - Run data operations (with CONFIRM)',
        '  - Evaluate math expressions',
        '  - Navigate between modules',
        '  - Answer questions about your ERP data',
        '',
        'Type "help" for the full command reference.',
      ],
    }),
  },

  // GREET
  {
    name: 'greet',
    score: ({ text, ctx }) => {
      if (!/\b(hi|hello|hey|halo|hai|hei|yo|pagi|siang|sore|malam)\b/i.test(text)) return 0;
      return ctx.greeted ? 0.5 : 0.9;
    },
    run: ({ ctx }) => ({
      reply: ctx.greeted
        ? ['Ready for the next command.']
        : [
            'PrintStream Developer Console active.',
            '',
            'You can ask questions, run commands, or type "help".',
          ],
      patch: { greeted: true },
    }),
  },

  // THANKS
  {
    name: 'thanks',
    score: ({ text }) =>
      /\b(thanks|thank you|thx|makasih|terima kasih|tq)\b/i.test(text) ? 0.9 : 0,
    run: () => ({ reply: ['Acknowledged.'] }),
  },

  // SMALL TALK
  {
    name: 'howareyou',
    score: ({ text }) =>
      /\b(how are you|how's it going|apa kabar|gimana kabar)\b/i.test(text) ? 0.9 : 0,
    run: () => ({ reply: ['Operational. All services running normally.'] }),
  },
  {
    name: 'joke',
    score: ({ text }) => (/\b(joke|lawak|lelucon)\b/i.test(text) ? 0.9 : 0),
    run: () => {
      const jokes = [
        [
          'Why did the accountant break up with the calculator?',
          "Because she couldn't count on him.",
        ],
        ['There are 10 types of people:', "Those who understand binary, and those who don't."],
        ['Why did the ERP go to therapy?', 'Too many unresolved dependencies.'],
        ['A SQL query walks into a bar,', 'Approaches two tables and asks: "May I join you?"'],
        ['Why do programmers prefer dark mode?', 'Because light attracts bugs.'],
      ];
      return { reply: jokes[Math.floor(Math.random() * jokes.length)] };
    },
  },

  // NAME
  {
    name: 'set_name',
    score: ({ ents }) => (ents.name ? 0.95 : 0),
    run: ({ ents }) => ({
      reply: [`Name set: ${ents.name}`, 'This session will remember it.'],
      patch: { userName: ents.name || null },
    }),
  },
  {
    name: 'get_name',
    score: ({ text }) => (/\b(what'?s my name|who am i|nama saya siapa)\b/i.test(text) ? 0.9 : 0),
    run: ({ ctx }) => ({
      reply: ctx.userName
        ? [`Current session name: ${ctx.userName}`]
        : ['No name set for this session. Say "my name is ___" to set one.'],
    }),
  },

  // STATUS
  {
    name: 'status',
    score: ({ text }) => {
      let s = 0;
      if (
        /\b(status|summary|overview|health check|kondisi|ringkasan|cek semua|snapshot)\b/i.test(
          text
        )
      )
        s = 0.95;
      if (
        /\b(show|what|how|berapa|lihat|display|report)\b/i.test(text) &&
        /\b(revenue|expense|profit|cash|inventory|receivable|payable)\b/i.test(text)
      )
        s = Math.max(s, 0.85);
      return s;
    },
    run: ({ metrics, ctx }) => {
      if (!metrics) return { reply: ['Metrics not available.'] };
      const net = metrics.totalRevenue - metrics.totalExpenses;
      const cashStatus =
        metrics.cashBalance < 0 ? 'NEGATIVE' : metrics.cashBalance < 5000 ? 'LOW' : 'OK';

      return {
        reply: [
          `ERP Snapshot${ctx.userName ? ` — ${ctx.userName}` : ''}`,
          '─'.repeat(48),
          `${pad('Revenue', 20)} ${padLeft(fmt(metrics.totalRevenue), 14)}`,
          `${pad('Expenses', 20)} ${padLeft(fmt(metrics.totalExpenses), 14)}`,
          `${pad('Net', 20)} ${padLeft(fmt(net), 14)}`,
          `${pad('Cash Balance', 20)} ${padLeft(fmt(metrics.cashBalance), 14)}  [${cashStatus}]`,
          `${pad('Inventory Value', 20)} ${padLeft(fmt(metrics.inventoryValue), 14)}`,
          `${pad('Receivable', 20)} ${padLeft(fmt(metrics.accountsReceivable), 14)}`,
          `${pad('Payable', 20)} ${padLeft(fmt(metrics.accountsPayable), 14)}`,
          '─'.repeat(48),
          'Run "stat" for a fresh pull, or "export" to copy as JSON.',
        ],
      };
    },
  },

  // EXPLAIN
  {
    name: 'explain',
    score: ({ text }) => {
      if (/\b(what is|whats|what's|explain|define|jelaskan|apa itu|maksud)\b/i.test(text)) {
        if (/\b(revenue|expense|profit|cash|inventory|receivable|payable|margin)\b/i.test(text))
          return 0.95;
      }
      if (/^(revenue|expense|profit|cash|inventory|receivable|payable|margin)$/i.test(text.trim()))
        return 0.9;
      return 0;
    },
    run: ({ text }) => {
      const t = norm(text);
      if (/revenue|pendapatan|omzet/.test(t))
        return {
          reply: [
            'Revenue',
            '  Definition: Total value of all invoices issued to customers.',
            '  Formula:    SUM(erp_invoices.total)',
            '  Note:       Reflects billed amount, not necessarily paid.',
          ],
        };
      if (/expense|pengeluaran|biaya/.test(t))
        return {
          reply: [
            'Expenses',
            '  Definition: Total of all outgoing payments.',
            '  Formula:    SUM(erp_payments WHERE type = outgoing)',
          ],
        };
      if (/profit|margin|laba/.test(t))
        return {
          reply: [
            'Profit',
            '  Definition: Net gain after expenses.',
            '  Formula:    Revenue - Expenses',
            '  Margin:     (Profit / Revenue) x 100%',
            '  Guideline:  Above 20% is typically healthy.',
          ],
        };
      if (/cash|saldo|kas/.test(t))
        return {
          reply: [
            'Cash Balance',
            '  Definition: Net liquidity from payments.',
            '  Formula:    SUM(incoming) - SUM(outgoing)',
            '  Note:       Alert triggers below $5,000 (configurable).',
          ],
        };
      if (/inventory|inventaris|stok/.test(t))
        return {
          reply: [
            'Inventory Value',
            '  Definition: Total cost-basis of held stock.',
            '  Formula:    SUM(current_stock x purchase_price)',
          ],
        };
      if (/receivable|piutang/.test(t))
        return {
          reply: [
            'Accounts Receivable',
            '  Definition: Money owed to you by customers.',
            '  Formula:    SUM(invoices WHERE status IN (unpaid, overdue))',
          ],
        };
      if (/payable|utang|hutang/.test(t))
        return {
          reply: [
            'Accounts Payable',
            '  Definition: Money you owe to suppliers.',
            '  Formula:    SUM(purchase_orders WHERE status IN (pending, approved))',
          ],
        };
      return {
        reply: [
          'Known metrics: revenue, expense, profit, cash, inventory, receivable, payable, margin.',
        ],
      };
    },
  },

  // DELETE
  {
    name: 'delete',
    score: ({ text, ents }) => {
      const hasDel = /\b(delete|remove|clear|wipe|erase|hapus|bersihkan|reset)\b/i.test(text);
      if (hasDel && ents.tables.length) return 0.95;
      if (hasDel) return 0.55;
      return 0;
    },
    run: ({ ents }) => {
      if (!ents.tables.length) {
        return {
          reply: [
            'Specify a target for deletion:',
            '',
            '  [1] transactions',
            '  [2] suppliers',
            '  [3] customers',
            '  [4] products / inventory',
            '  [5] payments',
            '  [6] purchase orders',
            '  [7] sales orders',
            '  [8] invoices',
            '  [9] audit logs',
            '  [0] ALL ERP data (high risk)',
            '',
            'Reply with a number or name. Type "cancel" to abort.',
          ],
          patch: {
            pending: {
              key: 'delete_target',
              prompt: 'Awaiting target',
              options: [
                { index: 1, label: 'transactions', command: 'd_ts' },
                { index: 2, label: 'suppliers', command: 'd_sp' },
                { index: 3, label: 'customers', command: 'd_cust' },
                { index: 4, label: 'products / inventory', command: 'd_inv' },
                { index: 5, label: 'payments', command: 'd_pay' },
                { index: 6, label: 'purchase orders', command: 'd_po' },
                { index: 7, label: 'sales orders', command: 'd_so' },
                { index: 8, label: 'invoices', command: 'd_invcs' },
                { index: 9, label: 'audit logs', command: 'd_aud' },
                { index: 0, label: 'ALL ERP data', command: 'd_all' },
              ],
            },
          },
        };
      }
      const cmd = ents.tables[0];
      const warning =
        cmd === 'd_all'
          ? ['  WARNING: This wipes every ERP table for your account.']
          : ['  Note: Linked records may be affected.'];
      return {
        reply: [
          `Target: ${ENTITY_LABEL[cmd]}`,
          `Command: ${cmd}`,
          '',
          ...warning,
          '',
          'Type CONFIRM to proceed, or cancel to abort.',
        ],
        patch: { lastIntent: 'delete', lastEntity: cmd },
      };
    },
  },

  // NAVIGATE
  {
    name: 'navigate',
    score: ({ text }) => {
      if (!/\b(go|open|navigate|goto|show|buka|pergi|lihat|take me to|bring me)\b/i.test(text))
        return 0;
      if (/\b(report|laporan|analytics)\b/i.test(text)) return 0.9;
      if (/\b(setting|pengaturan|config)\b/i.test(text)) return 0.9;
      if (/\b(erp|dashboard|home|beranda)\b/i.test(text)) return 0.9;
      if (/\b(logout|sign out|log out|keluar)\b/i.test(text)) return 0.9;
      return 0.4;
    },
    run: ({ text }) => {
      const t = norm(text);
      if (/report|laporan|analytics/.test(t))
        return { reply: ['Opening reports...', 'Run: r_reports'] };
      if (/setting|pengaturan|config/.test(t))
        return { reply: ['Opening settings...', 'Run: r_settings'] };
      if (/logout|sign out|log out|keluar/.test(t))
        return { reply: ['Signing out...', 'Run: r_logout'] };
      if (/erp|dashboard|home|beranda/.test(t))
        return {
          reply: ['Destinations:', '  r_erp       ERP dashboard', '  r_dash      Main dashboard'],
        };
      return { reply: ['Where to? Available: reports, settings, ERP, dashboard, logout.'] };
    },
  },

  // HELP
  {
    name: 'help_lost',
    score: ({ text }) =>
      /\b(i'?m lost|confused|help me|i don'?t know|not sure|bingung|gatau|nggak tau)\b/i.test(text)
        ? 0.9
        : 0,
    run: () => ({
      reply: [
        'Suggested starting points:',
        '',
        '  Data query       "show my revenue"    or  "status"',
        '  Delete data      "delete transactions"',
        '  Math             "calc 500 * 12"',
        '  Navigation       "go to reports"',
        '  Full reference   "help"',
      ],
    }),
  },

  // TIME
  {
    name: 'time',
    score: ({ text }) =>
      /\b(what time|current time|today|date|jam berapa|tanggal|hari ini)\b/i.test(text) ? 0.9 : 0,
    run: () => ({ reply: [new Date().toLocaleString()] }),
  },

  // PENDING
  {
    name: 'pending_answer',
    score: ({ text, ctx }) => {
      if (!ctx.pending) return 0;
      const t = norm(text);
      if (/^(cancel|batal|nevermind|never mind|no|n|skip|gausah)\b/i.test(t)) return 0.99;
      if (t.match(/\b(\d+)\b/)) return 0.97;
      for (const opt of ctx.pending.options) {
        if (new RegExp(`\\b${opt.label.split(' ')[0]}\\b`, 'i').test(t)) return 0.95;
      }
      return 0;
    },
    run: ({ text, ctx }) => {
      const t = norm(text);
      const pending = ctx.pending!;

      if (/^(cancel|batal|nevermind|never mind|no|n|skip|gausah)\b/i.test(t)) {
        return { reply: ['Cancelled. No changes made.'], patch: { pending: null } };
      }

      const numMatch = t.match(/\b(\d+)\b/);
      let chosen = null as (typeof pending.options)[0] | null;
      if (numMatch) {
        const idx = Number(numMatch[1]);
        chosen = pending.options.find((o) => o.index === idx) || null;
      }
      if (!chosen) {
        chosen =
          pending.options.find((o) => new RegExp(`\\b${o.label.split(' ')[0]}\\b`, 'i').test(t)) ||
          null;
      }

      if (!chosen) {
        return {
          reply: [
            'Unrecognized selection. Reply with a number (0-9) or option name.',
            'Type "cancel" to abort.',
          ],
        };
      }

      if (pending.key === 'delete_target') {
        const warning =
          chosen.command === 'd_all'
            ? ['  WARNING: This wipes every ERP table for your account.']
            : ['  Note: Linked records may be affected.'];
        return {
          reply: [
            `Target: ${ENTITY_LABEL[chosen.command]}`,
            `Command: ${chosen.command}`,
            '',
            ...warning,
            '',
            'Type CONFIRM to proceed, or cancel to abort.',
          ],
          patch: { pending: null, lastIntent: 'delete', lastEntity: chosen.command },
        };
      }
      return { reply: [`Selected: ${chosen.label}`], patch: { pending: null } };
    },
  },

  // CAPABILITIES
  {
    name: 'capabilities',
    score: ({ text }) =>
      /\b(what can you do|capabilities|abilities|bisa apa|fitur|features)\b/i.test(text) ? 0.9 : 0,
    run: () => ({
      reply: [
        'Capability overview:',
        '',
        '  Data operations      delete records (with CONFIRM)',
        '  Calculator           calc 15 * 2000, sqrt(144), 2^10',
        '  Navigation           r_erp, r_reports, r_settings, r_reload',
        '  Metrics              stat, export',
        '  Theme                theme dark | theme light',
        '  Query                ask anything about your ERP',
        '',
        'Type "help" for full reference.',
      ],
    }),
  },
];

export interface ChatResult {
  reply: string[];
  ctx: ChatContext;
}

export function processChat(input: string, rawCtx: ChatContext, metrics?: ChatMetrics): ChatResult {
  // 🔒 Force into correct shape — handles HMR / stale cache / old shape
  const ctx = ensureCtx(rawCtx);

  const trimmed = input.trim();
  if (!trimmed) return { reply: [], ctx };

  const next: ChatContext = {
    ...ctx,
    turn: ctx.turn + 1,
    recentTopics: [...ctx.recentTopics, trimmed].slice(-10),
  };

  const ents = extractEntities(trimmed);
  const respondCtx: RespondCtx = { text: trimmed, ctx: next, ents, metrics };

  let best: { intent: Intent; score: number } | null = null;
  for (const intent of INTENTS) {
    const s = intent.score(respondCtx);
    if (s > 0 && (!best || s > best.score)) best = { intent, score: s };
  }

  // Clear pending if unrelated
  if (ctx.pending && (!best || best.intent.name !== 'pending_answer')) {
    if (best && best.score >= 0.5) next.pending = null;
  }

  if (!best || best.score < 0.45) {
    return {
      reply: [
        'Command not recognized.',
        '',
        'Suggestions:',
        '  help              Full command reference',
        '  stat              Show KPI metrics',
        '  show revenue      Query revenue',
        '  delete <target>   Delete records',
        '  calc 2+2          Evaluate expression',
        '  go to reports     Navigate',
      ],
      ctx: next,
    };
  }

  const result = best.intent.run({ ...respondCtx, ctx: next });

  if (result.patch) Object.assign(next, result.patch);
  next.lastIntent = best.intent.name;

  return { reply: result.reply, ctx: next };
}
