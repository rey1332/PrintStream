'use client';

import React, { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nProvider';
import {
  Dialog,
  DialogButtons,
  Field,
  FormError,
  errorKey,
  inputCls,
  todayIso,
} from '../components/moduleUi';
import {
  TRX_CODES,
  taxService,
  type BillInput,
  type FakturRow,
  type SupplierBill,
} from '../lib/taxService';
import { financeService, type CashAccount } from '../lib/financeService';

// Object codes of PPh 23 most often met by a quarry (rental of equipment,
// services, transport); any other code can be typed. Check the current list
// in Coretax (docs/TAX.md).
export const PPH23_OBJECTS = [
  { code: '24-104-01', key: 'tax.obj.rental' },
  { code: '24-104-14', key: 'tax.obj.services' },
  { code: '24-104-33', key: 'tax.obj.transport' },
] as const;

const digits = (value: string) => value.replace(/\D/g, '');

export function FakturDialog({
  row,
  onClose,
  onSaved,
}: {
  row: FakturRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [trx, setTrx] = useState(row.trxCode);
  const [number, setNumber] = useState(row.fakturNumber ?? '');
  const [date, setDate] = useState(row.fakturDate ?? row.invoiceDate);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const approved = row.status === 'approved';

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (number && digits(number).length !== 17) return setError(t('tax.err.fakturNumber'));
    setBusy(true);
    setError('');
    try {
      await taxService.setFaktur(
        row.invoiceId,
        approved ? null : trx,
        digits(number),
        number ? date : null
      );
      onSaved();
    } catch (err) {
      setError(t(errorKey(err, 'tax.err.failed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={t('tax.faktur.title', { invoice: row.docNo ?? row.customerName })}
      onClose={onClose}
      onSubmit={submit}
    >
      <Field label={t('tax.faktur.trxCode')} hint={t('tax.faktur.trxCodeHint')}>
        <select
          className={inputCls}
          value={trx}
          onChange={(e) => setTrx(e.target.value)}
          disabled={approved}
        >
          {TRX_CODES.map((code) => (
            <option key={code} value={code}>
              {code} · {t(`tax.trx.${code}` as never)}
            </option>
          ))}
        </select>
      </Field>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('tax.faktur.number')} hint={t('tax.faktur.numberHint')}>
          <input
            className={inputCls}
            inputMode="numeric"
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            placeholder="04002500000000123"
          />
        </Field>
        <Field label={t('tax.faktur.date')}>
          <input
            type="date"
            className={inputCls}
            value={date}
            max={todayIso()}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
      </div>
      <FormError text={error} />
      <DialogButtons busy={busy} label={t('common.save')} onCancel={onClose} />
    </Dialog>
  );
}

export function WithheldDialog({
  row,
  onClose,
  onSaved,
}: {
  row: FakturRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, fmt } = useI18n();
  // PPh 23 is 2% of the DPP (the amount before PPN).
  const [amount, setAmount] = useState(String(Math.round(row.subtotal * 0.02)));
  const [date, setDate] = useState(todayIso());
  const [bupot, setBupot] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!bupot.trim()) return setError(t('tax.err.bupotRequired'));
    setBusy(true);
    setError('');
    try {
      await taxService.pph23Withheld(row.invoiceId, Number(amount), date, bupot.trim());
      onSaved();
    } catch (err) {
      setError(t(errorKey(err, 'tax.err.failed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={t('tax.withheld.title')} onClose={onClose} onSubmit={submit}>
      <p className="text-[0.78rem] text-muted-foreground">
        {t('tax.withheld.intro', {
          invoice: row.docNo ?? row.customerName,
          dpp: fmt.money(row.subtotal),
        })}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('tax.withheld.amount')}>
          <input
            type="number"
            min="0.01"
            step="0.01"
            className={inputCls}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        </Field>
        <Field label={t('tax.withheld.date')}>
          <input
            type="date"
            className={inputCls}
            value={date}
            max={todayIso()}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </Field>
        <Field label={t('tax.withheld.bupot')} hint={t('tax.withheld.bupotHint')} wide>
          <input
            className={inputCls}
            value={bupot}
            onChange={(e) => setBupot(e.target.value)}
            maxLength={40}
            required
          />
        </Field>
      </div>
      <FormError text={error} />
      <DialogButtons busy={busy} label={t('common.save')} onCancel={onClose} />
    </Dialog>
  );
}

const emptyBill = (): BillInput => ({
  supplier_id: null,
  supplier_name: '',
  bill_no: '',
  bill_date: todayIso(),
  due_date: todayIso(30),
  description: '',
  expense_account_id: null,
  subtotal: 0,
  ppn_amount: 0,
  faktur_number: '',
  faktur_date: '',
  pph23_rate: 0,
  pph23_object_code: '',
});

export function BillDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t, fmt } = useI18n();
  const [bill, setBill] = useState<BillInput>(emptyBill);
  const [suppliers, setSuppliers] = useState<{ id: string; name: string; hasTaxId: boolean }[]>([]);
  const [accounts, setAccounts] = useState<{ id: string; code: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<BillInput>) => setBill((b) => ({ ...b, ...patch }));

  useEffect(() => {
    taxService
      .suppliers()
      .then(setSuppliers)
      .catch(() => undefined);
    taxService
      .expenseAccounts()
      .then(setAccounts)
      .catch(() => undefined);
  }, []);

  const supplier = suppliers.find((s) => s.id === bill.supplier_id);
  const pph23 = Math.round(bill.subtotal * bill.pph23_rate) / 100;
  const payable = bill.subtotal + bill.ppn_amount - pph23;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (bill.ppn_amount > 0 && digits(bill.faktur_number).length !== 17)
      return setError(t('tax.err.fakturRequired'));
    if (bill.pph23_rate > 0 && !/^\d{2}-\d{3}-\d{2}$/.test(bill.pph23_object_code))
      return setError(t('tax.err.objectCode'));
    setBusy(true);
    setError('');
    try {
      await taxService.createBill({ ...bill, faktur_number: digits(bill.faktur_number) });
      onSaved();
    } catch (err) {
      setError(t(errorKey(err, 'tax.err.failed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog title={t('tax.bill.new')} onClose={onClose} onSubmit={submit} wide>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('tax.bill.supplier')} wide>
          <select
            className={inputCls}
            value={bill.supplier_id ?? ''}
            onChange={(e) => set({ supplier_id: e.target.value || null })}
          >
            <option value="">{t('tax.bill.otherSupplier')}</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        {!bill.supplier_id && (
          <Field label={t('tax.bill.supplierName')} wide>
            <input
              className={inputCls}
              value={bill.supplier_name}
              onChange={(e) => set({ supplier_name: e.target.value })}
              maxLength={200}
              required
            />
          </Field>
        )}
        <Field label={t('tax.bill.billNo')}>
          <input
            className={inputCls}
            value={bill.bill_no}
            onChange={(e) => set({ bill_no: e.target.value })}
            maxLength={60}
          />
        </Field>
        <Field label={t('tax.bill.description')}>
          <input
            className={inputCls}
            value={bill.description}
            onChange={(e) => set({ description: e.target.value })}
            maxLength={300}
            required
          />
        </Field>
        <Field label={t('tax.bill.date')}>
          <input
            type="date"
            className={inputCls}
            value={bill.bill_date}
            max={todayIso()}
            onChange={(e) => set({ bill_date: e.target.value })}
            required
          />
        </Field>
        <Field label={t('tax.bill.due')}>
          <input
            type="date"
            className={inputCls}
            value={bill.due_date}
            min={bill.bill_date}
            onChange={(e) => set({ due_date: e.target.value })}
            required
          />
        </Field>
        <Field label={t('tax.bill.account')} hint={t('tax.bill.accountHint')} wide>
          <select
            className={inputCls}
            value={bill.expense_account_id ?? ''}
            onChange={(e) => set({ expense_account_id: e.target.value || null })}
          >
            <option value="">{t('tax.bill.defaultAccount')}</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} · {a.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('tax.bill.dpp')}>
          <input
            type="number"
            min="0.01"
            step="0.01"
            className={inputCls}
            value={bill.subtotal || ''}
            onChange={(e) => set({ subtotal: Number(e.target.value) })}
            required
          />
        </Field>
        <Field label={t('tax.bill.ppn')} hint={t('tax.bill.ppnHint')}>
          <input
            type="number"
            min="0"
            step="0.01"
            className={inputCls}
            value={bill.ppn_amount || ''}
            onChange={(e) => set({ ppn_amount: Number(e.target.value) })}
          />
        </Field>
        {bill.ppn_amount > 0 && (
          <>
            <Field label={t('tax.bill.faktur')}>
              <input
                className={inputCls}
                inputMode="numeric"
                value={bill.faktur_number}
                onChange={(e) => set({ faktur_number: e.target.value })}
                placeholder="04002500000000456"
                required
              />
            </Field>
            <Field label={t('tax.bill.fakturDate')}>
              <input
                type="date"
                className={inputCls}
                value={bill.faktur_date}
                max={todayIso()}
                onChange={(e) => set({ faktur_date: e.target.value })}
              />
            </Field>
          </>
        )}
        <Field
          label={t('tax.bill.pph23Rate')}
          hint={
            supplier && !supplier.hasTaxId ? t('tax.bill.noNpwpHint') : t('tax.bill.pph23RateHint')
          }
        >
          <select
            className={inputCls}
            value={String(bill.pph23_rate)}
            onChange={(e) => set({ pph23_rate: Number(e.target.value) })}
          >
            <option value="0">{t('tax.bill.noPph23')}</option>
            <option value="2">2%</option>
            <option value="4">4%</option>
            <option value="15">15%</option>
          </select>
        </Field>
        {bill.pph23_rate > 0 && (
          <Field label={t('tax.bill.objectCode')}>
            <input
              className={inputCls}
              list="pph23-objects"
              value={bill.pph23_object_code}
              onChange={(e) => set({ pph23_object_code: e.target.value })}
              placeholder="24-104-01"
              required
            />
            <datalist id="pph23-objects">
              {PPH23_OBJECTS.map((o) => (
                <option key={o.code} value={o.code}>
                  {t(o.key)}
                </option>
              ))}
            </datalist>
          </Field>
        )}
      </div>
      <dl className="grid grid-cols-3 gap-2 rounded-lg border border-border p-3 text-[0.78rem]">
        <div>
          <dt className="text-muted-foreground">{t('tax.bill.pph23')}</dt>
          <dd className="tabular-nums">{fmt.money(pph23)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('tax.bill.payable')}</dt>
          <dd className="tabular-nums font-medium">{fmt.money(payable)}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{t('tax.bill.expense')}</dt>
          <dd className="tabular-nums">{fmt.money(bill.subtotal)}</dd>
        </div>
      </dl>
      <FormError text={error} />
      <DialogButtons busy={busy} label={t('tax.bill.save')} onCancel={onClose} />
    </Dialog>
  );
}

export function PayBillDialog({
  bill,
  onClose,
  onSaved,
}: {
  bill: SupplierBill;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t, fmt } = useI18n();
  const open = bill.totalPayable - bill.amountPaid;
  const [amount, setAmount] = useState(String(open));
  const [date, setDate] = useState(todayIso());
  const [method, setMethod] = useState('transfer');
  const [cashAccounts, setCashAccounts] = useState<CashAccount[]>([]);
  const [cashAccountId, setCashAccountId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    financeService
      .accounts()
      .then((list) => {
        const usable = list.filter((a) => a.active);
        setCashAccounts(usable);
        setCashAccountId((usable.find((a) => a.isDefault) ?? usable[0])?.id ?? '');
      })
      .catch(() => setCashAccounts([]));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await taxService.payBill(bill.id, Number(amount), date, method, cashAccountId || null);
      onSaved();
    } catch (err) {
      setError(t(errorKey(err, 'tax.err.failed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={t('tax.pay.title', { supplier: bill.supplierName })}
      onClose={onClose}
      onSubmit={submit}
    >
      <p className="text-[0.78rem] text-muted-foreground">
        {t('tax.pay.open', { amount: fmt.money(open) })}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('tax.pay.amount')}>
          <input
            type="number"
            min="0.01"
            max={open}
            step="0.01"
            className={inputCls}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            required
          />
        </Field>
        <Field label={t('tax.pay.date')}>
          <input
            type="date"
            className={inputCls}
            value={date}
            max={todayIso()}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </Field>
        <Field label={t('tax.pay.method')} wide>
          <input
            className={inputCls}
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            maxLength={40}
          />
        </Field>
        {cashAccounts.length > 1 && (
          <Field label={t('pay.cashAccountOut')} wide>
            <select
              className={inputCls}
              value={cashAccountId}
              onChange={(e) => setCashAccountId(e.target.value)}
            >
              {cashAccounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <FormError text={error} />
      <DialogButtons busy={busy} label={t('tax.pay.save')} onCancel={onClose} />
    </Dialog>
  );
}

export function BupotDialog({
  bill,
  onClose,
  onSaved,
}: {
  bill: SupplierBill;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { t } = useI18n();
  const [number, setNumber] = useState(bill.bupotNumber);
  const [date, setDate] = useState(bill.bupotDate ?? todayIso());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await taxService.bupot(bill.id, number.trim(), date);
      onSaved();
    } catch (err) {
      setError(t(errorKey(err, 'tax.err.failed')));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={t('tax.bupot.title', { supplier: bill.supplierName })}
      onClose={onClose}
      onSubmit={submit}
    >
      <p className="text-[0.78rem] text-muted-foreground">{t('tax.bupot.intro')}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t('tax.bupot.number')} hint={t('tax.bupot.numberHint')}>
          <input
            className={inputCls}
            value={number}
            onChange={(e) => setNumber(e.target.value)}
            maxLength={40}
          />
        </Field>
        <Field label={t('tax.bupot.date')}>
          <input
            type="date"
            className={inputCls}
            value={date}
            max={todayIso()}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
      </div>
      <FormError text={error} />
      <DialogButtons busy={busy} label={t('common.save')} onCancel={onClose} />
    </Dialog>
  );
}
