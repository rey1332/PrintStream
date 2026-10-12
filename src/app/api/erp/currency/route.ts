import { withAuth } from '@/lib/api-safe';
import { identityOf, sessionFromCookies } from '@/server/auth/request';
import { getAppExecutor } from '@/server/config';
import {
  CurrencyError,
  addRate,
  confirmBaseCurrency,
  currencyPreview,
  currencySettings,
  fetchAndStore,
  listRates,
  lookupRate,
  type CurrencyContext,
} from '@/server/currency/service';

export const POST = withAuth(async ({ request }) => {
  const body = await request.json().catch(() => null);
  const session = await sessionFromCookies(request.cookies);
  if (!session) return { success: false, error: 'forbidden' };
  const ctx: CurrencyContext = {
    executor: getAppExecutor(),
    identity: identityOf(session),
    workspacesEnabled: process.env.NEXT_PUBLIC_ERP_WORKSPACES !== 'off',
  };
  const ws = body?.workspaceId;
  try {
    switch (body?.action) {
      case 'settings':
        return { success: true, data: await currencySettings(ctx, ws) };
      case 'preview':
        return { success: true, data: await currencyPreview(ctx, ws) };
      case 'confirm':
        return {
          success: true,
          data: await confirmBaseCurrency(ctx, ws, body.currency, body.baseRows),
        };
      case 'rates':
        return { success: true, data: await listRates(ctx, ws) };
      case 'addRate':
        return { success: true, data: { id: await addRate(ctx, ws, body) } };
      case 'lookup':
        return { success: true, data: await lookupRate(ctx, ws, body) };
      case 'fetch':
        return { success: true, data: await fetchAndStore(ctx, ws, body) };
      default:
        return { success: false, error: 'invalid' };
    }
  } catch (error) {
    if (error instanceof CurrencyError)
      return { success: false, error: error.code, message: error.userMessage };
    throw error;
  }
});
