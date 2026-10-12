'use client';

// The letterhead of an ERP (db/migrations/20261012000007_erp_company_profile.sql).

import { createClient } from '@/lib/data/client';

export interface CompanyProfile {
  legal_name: string;
  address: string;
  city: string;
  phone: string;
  email: string;
  website: string;
  tax_id: string;
  bank_details: string;
  footer_note: string;
  logo: string | null;
}

export const EMPTY_PROFILE: CompanyProfile = {
  legal_name: '',
  address: '',
  city: '',
  phone: '',
  email: '',
  website: '',
  tax_id: '',
  bank_details: '',
  footer_note: '',
  logo: null,
};

export async function loadCompanyProfile(
  workspaceId: string | null
): Promise<{ profile: CompanyProfile; canEdit: boolean; erpName: string }> {
  const { data, error } = await createClient().rpc('erp_company_profile_get', {
    p_workspace_id: workspaceId,
  });
  if (error) throw error;
  const raw = (data ?? {}) as Partial<CompanyProfile> & { can_edit?: boolean; erp_name?: string };
  const profile = { ...EMPTY_PROFILE };
  for (const key of Object.keys(EMPTY_PROFILE) as (keyof CompanyProfile)[]) {
    const value = raw[key];
    if (key === 'logo') profile.logo = typeof value === 'string' && value ? value : null;
    else profile[key] = typeof value === 'string' ? value : '';
  }
  return { profile, canEdit: raw.can_edit === true, erpName: raw.erp_name ?? '' };
}
