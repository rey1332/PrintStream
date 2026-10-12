'use client';

import { useMemo } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { customerService, productService, supplierService } from './erpService';
import type { PickerOption } from '../components/RecordPicker';

export type PickedParty = Awaited<ReturnType<typeof customerService.pick>>[number];
export type PickedProduct = Awaited<ReturnType<typeof productService.pick>>[number];

function partyOption(p: PickedParty): PickerOption<PickedParty> {
  return {
    id: p.id,
    label: p.name,
    detail: [p.email, p.city].filter(Boolean).join(' · '),
    data: p,
  };
}

export function productOption(p: PickedProduct, extra?: string): PickerOption<PickedProduct> {
  return {
    id: p.id,
    label: p.name,
    detail: [p.sku, extra].filter(Boolean).join(' · '),
    data: p,
  };
}

const none = <T>(): Promise<PickerOption<T>[]> => Promise.resolve([]);

export function useRecordSearch() {
  const { user } = useAuth();
  const userId = user?.id;
  return useMemo(
    () => ({
      customers: (text: string) =>
        userId
          ? customerService.pick(userId, text).then((rows) => rows.map(partyOption))
          : none<PickedParty>(),
      suppliers: (text: string) =>
        userId
          ? supplierService.pick(userId, text).then((rows) => rows.map(partyOption))
          : none<PickedParty>(),
      products: (text: string, opts: { inStock?: boolean } = {}) =>
        userId ? productService.pick(userId, text, opts) : Promise.resolve([] as PickedProduct[]),
    }),
    [userId]
  );
}
