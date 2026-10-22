import { withAuth } from '@/lib/api-safe';
import { terminalContext } from '@/server/terminal/context';
import { TerminalError } from '@/server/terminal/session';
import * as ai from '@/server/terminal/aiService';
import * as connectors from '@/server/terminal/connectorService';
import * as erpLinks from '@/server/terminal/erpLinkService';
import * as terminal from '@/server/terminal/service';
import * as sql from '@/server/terminal/sqlService';

// PrintStream Terminal: one endpoint, an action per request (as /api/erp/workspace).

const ACTIONS: Record<string, (ctx: terminal.TerminalContext, body: any) => Promise<unknown>> = {
  overview: (ctx, b) => terminal.overview(ctx, b.workspaceId),
  'dataset.create': terminal.createDataset,
  'dataset.get': terminal.getDataset,
  'dataset.alter': terminal.alterDataset,
  'dataset.delete': terminal.deleteDataset,
  'dataset.rows': terminal.editRows,
  'item.access': terminal.setItemAccess,
  'import.get': terminal.getImport,
  'import.commit': terminal.commitImport,
  'import.reanalyze': terminal.reanalyzeImport,
  'import.cancel': terminal.cancelImport,
  'job.cancel': terminal.cancelJob,
  'job.retry': terminal.retryJob,
  'mcpTokens.list': terminal.listMcpTokens,
  'mcpToken.create': terminal.createMcpToken,
  'mcpToken.revoke': terminal.revokeMcpToken,
  'mcpToken.scope': terminal.setMcpTokenScope,
  'mcpApps.list': terminal.listMcpApps,
  'mcpApp.revoke': terminal.revokeMcpApp,
  'mcpApp.scope': terminal.setMcpAppScope,
  'pipeline.run': terminal.runPipeline,
  'pipeline.schedule': terminal.saveSchedule,
  'pipeline.unschedule': terminal.deleteSchedule,
  'pipeline.chain': terminal.saveChain,
  'pipeline.unchain': terminal.deleteChain,
  'pipeline.enable': terminal.setPipelineEnabled,
  'connections.list': connectors.listConnections,
  'connection.save': connectors.saveConnection,
  'connection.option': connectors.setConnectionOption,
  'connection.delete': connectors.deleteConnection,
  'connection.test': connectors.testConnection,
  'connection.describe': connectors.describeConnection,
  'job.get': connectors.getJob,
  'connection.revoke': connectors.revokeConnection,
  'mcpTools.list': connectors.listMcpTools,
  'ai.overview': ai.aiOverview,
  'ai.provider.save': ai.saveProvider,
  'ai.provider.delete': ai.deleteProvider,
  'ai.provider.test': ai.testProvider,
  'ai.personalKey.set': ai.setPersonalKey,
  'ai.policy.set': ai.setPolicy,
  'ai.settings.set': ai.setSettings,
  'insight.disclose': ai.discloseInsight,
  'insight.create': ai.createInsight,
  'insights.list': ai.listInsights,
  'insight.get': ai.getInsight,
  'insight.requestReview': ai.requestReview,
  'insight.review': ai.reviewInsight,
  'dataset.entity.get': ai.getEntity,
  'dataset.entity.set': ai.setEntity,
  'mcpTool.approve': connectors.approveMcpTool,
  'sync.create': connectors.createSync,
  'sync.createSource': connectors.createSourceSync,
  'sync.run': connectors.runSyncNow,
  'sync.schedule': connectors.scheduleSync,
  'sync.delete': connectors.deleteSync,
  'erpLinks.list': erpLinks.listErpLinks,
  'erpLink.add': erpLinks.addErpLink,
  'erpLink.remove': erpLinks.removeErpLink,
  'sql.targets': sql.sqlTargets,
  'sql.run': sql.sqlRun,
  'sql.result': sql.sqlResult,
  'sql.history': sql.sqlHistory,
};

export const POST = withAuth(async ({ request }) => {
  const ctx = await terminalContext(request);
  if (!ctx) return { success: false, error: 'forbidden' };
  const body = await request.json().catch(() => null);
  const action = typeof body?.action === 'string' ? ACTIONS[body.action] : undefined;
  if (!action) return { success: false, error: 'invalid' };
  try {
    return { success: true, data: (await action(ctx, body)) ?? null };
  } catch (error) {
    if (error instanceof TerminalError)
      return { success: false, error: error.code, vars: error.vars };
    throw error;
  }
});
