import { DEFAULT_LOCALE, type Locale } from './config';
import { messages, type Entry, type MessageKey } from './messages';

export type TranslateVars = Record<string, string | number>;

function column(locale: Locale): 'en' | 'id' | 'zh' {
  return locale === 'zh-CN' ? 'zh' : locale;
}

function interpolate(template: string, vars?: TranslateVars): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match
  );
}

export function translate(locale: Locale, key: MessageKey, vars?: TranslateVars): string {
  const entry = (messages as Record<string, Entry | undefined>)[key];
  if (!entry) return key;
  return interpolate(entry[column(locale)] || entry.en, vars);
}

let currentLocale: Locale = DEFAULT_LOCALE;

export function setCurrentLocale(locale: Locale) {
  currentLocale = locale;
}

export function getCurrentLocale(): Locale {
  return currentLocale;
}

export function tr(key: MessageKey, vars?: TranslateVars): string {
  return translate(currentLocale, key, vars);
}

const SERVER_MESSAGE_PATTERNS: { pattern: RegExp; key: MessageKey; names: string[] }[] = [
  {
    pattern: /^A payment must be in the invoice currency \(([A-Z]{3})\)$/,
    key: 'server.paymentCurrency',
    names: ['currency'],
  },
  {
    pattern: /^Enter the exchange rate to the base currency$/,
    key: 'server.fxRateRequired',
    names: [],
  },
  {
    pattern: /^A payment must be in the purchase order currency \(([A-Z]{3})\)$/,
    key: 'server.paymentCurrencyPo',
    names: ['currency'],
  },
  {
    pattern: /^No exchange rate from ([A-Z]{3}) to ([A-Z]{3}) on or before (\d{4}-\d{2}-\d{2})/,
    key: 'server.fxMissing',
    names: ['from', 'to', 'date'],
  },
  {
    pattern:
      /^The latest ([A-Z]{3}) to ([A-Z]{3}) rate is from (\d{4}-\d{2}-\d{2}) \(more than (\d+) days before (\d{4}-\d{2}-\d{2})\)/,
    key: 'server.fxStale',
    names: ['from', 'to', 'rateDate', 'days', 'date'],
  },
  {
    pattern: /^The exchange rate must be greater than zero$/,
    key: 'server.fxRatePositive',
    names: [],
  },
  { pattern: /^Unknown currency ([A-Z]{3})$/, key: 'server.unknownCurrency', names: ['currency'] },
  {
    pattern: /^The base currency is locked as ([A-Z]{3})/,
    key: 'server.baseLocked',
    names: ['currency'],
  },
  {
    pattern: /^The base currency is already confirmed as ([A-Z]{3})/,
    key: 'server.baseLocked',
    names: ['currency'],
  },
  {
    pattern: /^Only the workspace owner can (change|confirm) the base currency$/,
    key: 'server.baseOwnerOnly',
    names: [],
  },
  {
    pattern: /^Financial records already exist\. Review them and confirm their currency/,
    key: 'server.baseConfirmRequired',
    names: [],
  },
  { pattern: /^Records changed since the preview/, key: 'server.basePreviewChanged', names: [] },
  {
    pattern: /^(\d+) foreign-currency documents have exchange rates to ([A-Z]{3})/,
    key: 'server.baseForeignDocs',
    names: ['count', 'currency'],
  },
  {
    pattern: /^Only (\d+) units of (.+) are in that warehouse$/,
    key: 'server.warehouseShort',
    names: ['count', 'product'],
  },
  {
    pattern: /^The books are closed through (\d{4}-\d{2}-\d{2})/,
    key: 'server.booksClosed',
    names: ['date'],
  },
  { pattern: /^Journal entry .*is not balanced/, key: 'server.journalUnbalanced', names: [] },
  { pattern: /^Two-factor verification required/, key: 'server.mfaRequired', names: [] },
  {
    pattern: /^Turn on two-factor authentication for your own account first/,
    key: 'server.ownMfaFirst',
    names: [],
  },
  {
    pattern: /^Financial records can only be changed through ERP actions/,
    key: 'server.financialLocked',
    names: [],
  },
  {
    pattern: /^Insufficient available stock for (.+) \(available (-?\d+), requested (\d+)\)$/,
    key: 'server.insufficientAvailable',
    names: ['product', 'available', 'requested'],
  },
  {
    pattern: /^Insufficient stock for (.+) \(available (-?\d+), required (\d+)\)$/,
    key: 'server.insufficientStock',
    names: ['product', 'available', 'required'],
  },
  { pattern: /^Insufficient stock$/, key: 'server.insufficientStockPlain', names: [] },
  {
    pattern: /^Quantity for (.+) exceeds the remaining (\d+) units$/,
    key: 'server.exceedsRemaining',
    names: ['product', 'remaining'],
  },
  {
    pattern: /^Payment exceeds the invoice balance \(remaining ([\d.]+)\)$/,
    key: 'server.exceedsInvoice',
    names: ['remaining'],
  },
  {
    pattern: /^Payment exceeds the purchase order balance \(remaining ([\d.]+)\)$/,
    key: 'server.exceedsPo',
    names: ['remaining'],
  },
  {
    pattern: /^A reason \(at least 3 characters\) is required to .+$/,
    key: 'server.reasonRequired',
    names: [],
  },
  { pattern: /^A reason is required to .+$/, key: 'server.reasonRequired', names: [] },
  {
    pattern: /^Only draft sales orders can be edited$/,
    key: 'server.onlyDraftEditable',
    names: [],
  },
  { pattern: /^Only draft orders can be invoiced$/, key: 'server.onlyDraftInvoiced', names: [] },
  {
    pattern: /^Only invoiced sales orders can be delivered$/,
    key: 'server.onlyInvoicedDelivered',
    names: [],
  },
  {
    pattern: /^Only approved purchase orders can be received$/,
    key: 'server.onlyApprovedReceived',
    names: [],
  },
  {
    pattern: /^Only approved or received purchase orders can be paid$/,
    key: 'server.onlyApprovedPaid',
    names: [],
  },
  { pattern: /^Invalid purchase order transition$/, key: 'server.invalidTransition', names: [] },
  {
    pattern: /^(Purchase|Sales) order cannot move from (\w+) to (\w+)$/,
    key: 'server.invalidTransition',
    names: [],
  },
  {
    pattern: /^Void the payments recorded on this .+ first$/,
    key: 'server.voidPaymentsFirst',
    names: [],
  },
  {
    pattern: /^Void the payments recorded on this order's invoice first$/,
    key: 'server.voidPaymentsFirst',
    names: [],
  },
  {
    pattern: /^Orders with deliveries cannot be cancelled; reverse the deliveries first$/,
    key: 'server.reverseDeliveriesFirst',
    names: [],
  },
  {
    pattern: /^Orders with received goods cannot be cancelled; reverse the receipts first$/,
    key: 'server.reverseReceiptsFirst',
    names: [],
  },
  {
    pattern: /^This invoice belongs to a sales order; cancel the sales order to void it$/,
    key: 'server.cancelOrderToVoid',
    names: [],
  },
  {
    pattern: /^Payments cannot be recorded against a void invoice$/,
    key: 'server.voidInvoicePayment',
    names: [],
  },
  {
    pattern: /^Payment amount must be greater than zero$/,
    key: 'server.amountPositive',
    names: [],
  },
  {
    pattern: /^Cannot reverse the receipt of (.+): only (\d+) units are on hand$/,
    key: 'server.cannotReverseReceipt',
    names: ['product', 'onHand'],
  },
  { pattern: /^This event has already been reversed$/, key: 'server.alreadyReversed', names: [] },
  { pattern: /^Product not found for this account$/, key: 'server.productNotFound', names: [] },
  { pattern: /^Customer not found for this account$/, key: 'server.customerNotFound', names: [] },
  { pattern: /^Supplier not found for this account$/, key: 'server.supplierNotFound', names: [] },
  {
    pattern: /^Item quantity must be positive and price cannot be negative$/,
    key: 'server.itemInvalid',
    names: [],
  },
  {
    pattern: /^This purchase order is awaiting an assigned approver$/,
    key: 'server.awaitingApprover',
    names: [],
  },
  { pattern: /^Stock cannot be negative$/, key: 'server.stockNegative', names: [] },
  { pattern: /^Quantity must be greater than zero$/, key: 'server.quantityPositive', names: [] },
  {
    pattern: /^Too many pending invitations\. Revoke unused codes first$/,
    key: 'server.tooManyInvitations',
    names: [],
  },
  { pattern: /^Invalid login credentials$/, key: 'server.invalidLogin', names: [] },
  { pattern: /^Email not confirmed$/, key: 'server.emailNotConfirmed', names: [] },
  { pattern: /^User already registered$/, key: 'server.userExists', names: [] },
  {
    pattern: /^Password should be at least 6 characters\.?$/,
    key: 'server.passwordShort',
    names: [],
  },
  {
    pattern: /^This access code is invalid, expired, or has already been used\.$/,
    key: 'workspace.invalidCode',
    names: [],
  },
  {
    pattern: /^Too many attempts\. Please wait 15 minutes and try again\.$/,
    key: 'workspace.tooManyAttempts',
    names: [],
  },
  {
    pattern: /^You are not allowed to do that in this workspace\.$/,
    key: 'workspace.notAllowed',
    names: [],
  },
];

export function translateServerMessage(message: string, locale: Locale = currentLocale): string {
  const text = (message || '').trim();
  for (const { pattern, key, names } of SERVER_MESSAGE_PATTERNS) {
    const match = text.match(pattern);
    if (match) {
      const vars: TranslateVars = {};
      names.forEach((name, index) => {
        vars[name] = match[index + 1];
      });
      return translate(locale, key, vars);
    }
  }
  return message;
}
