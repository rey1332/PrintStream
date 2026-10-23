import type { Entry } from './types';
import { commonMessages } from './common';
import { serverMessages } from './server';
import { erpMessages } from './erp';
import { settingsMessages } from './settings';
import { dashboardMessages } from './dashboard';
import { homeWidgetMessages } from './homeWidgets';
import { masterDataMessages } from './masterData';
import { operationsMessages } from './operations';
import { reportsMessages } from './reports';
import { workflowMessages } from './workflow';
import { workflowUnifyMessages } from './workflowUnify';
import { terminalErpLinkMessages } from './terminalErpLinks';
import { catalogMessages } from './catalog';
import { workflowRunMessages } from './workflowRuns';
import { securityMessages } from './security';
import { accountingMessages } from './accounting';
import { workflowAnalysisMessages } from './workflowAnalysis';
import { ontologyMessages } from './ontology';
import { currencyMessages } from './currency';
import { sidebarMessages } from './sidebar';
import { hrMessages } from './hr';
import { syncMessages } from './sync';
import { printMessages } from './print';
import { backupMessages } from './backup';
import { hrLeaveMessages } from './hrLeave';
import { userAdminMessages } from './userAdmin';
import type { platformAdminMessages } from './platformAdmin';
import type { platformAdminManageMessages } from './platformAdminManage';
import { passwordResetMessages } from './passwordReset';
import { termsMessages } from './terms';
import type { platformAdminTermsMessages } from './platformAdminTerms';
import { governanceSharedMessages } from './governanceShared';
import type { platformAdminDashboardMessages } from './platformAdminDashboard';
import { unitMessages } from './units';
import { industryMessages } from './industry';
import { weighbridgeMessages } from './weighbridge';
import { productionMessages } from './production';
import { equipmentMessages } from './equipment';
import { payrollIdMessages } from './payrollId';
import type { platformAdminOpsMessages } from './platformAdminOps';
import type { platformAdminCloseMessages } from './platformAdminClose';
import { workspaceRoleMessages } from './workspaceRoles';
import type { platformAdminGovernanceMessages } from './platformAdminGovernance';
import { workspaceGovernanceMessages } from './workspaceGovernance';
import { terminalMessages } from './terminal';
import { terminalConnectorMessages } from './terminalConnectors';
import { terminalDbSourceMessages } from './terminalDbSources';
import { terminalRestMessages } from './terminalRest';
import { terminalWebMessages } from './terminalWeb';
import { terminalSheetsMessages } from './terminalSheets';
import { terminalMcpMessages } from './terminalMcp';
import { terminalAiMessages } from './terminalAi';
import { taxMessages } from './tax';
import { financeMessages } from './finance';
import { terminalOpsMessages } from './terminalOps';
import { terminalQueryMessages } from './terminalQuery';

export const messages = {
  ...commonMessages,
  ...serverMessages,
  ...erpMessages,
  ...settingsMessages,
  ...dashboardMessages,
  ...homeWidgetMessages,
  ...masterDataMessages,
  ...operationsMessages,
  ...reportsMessages,
  ...workflowMessages,
  ...workflowUnifyMessages,
  ...terminalErpLinkMessages,
  ...catalogMessages,
  ...workflowRunMessages,
  ...securityMessages,
  ...accountingMessages,
  ...workflowAnalysisMessages,
  ...ontologyMessages,
  ...currencyMessages,
  ...sidebarMessages,
  ...hrMessages,
  ...syncMessages,
  ...printMessages,
  ...backupMessages,
  ...hrLeaveMessages,
  ...userAdminMessages,
  ...passwordResetMessages,
  ...termsMessages,
  ...governanceSharedMessages,
  ...unitMessages,
  ...industryMessages,
  ...weighbridgeMessages,
  ...productionMessages,
  ...equipmentMessages,
  ...taxMessages,
  ...financeMessages,
  ...terminalOpsMessages,
  ...terminalQueryMessages,
  ...payrollIdMessages,
  ...workspaceRoleMessages,
  ...workspaceGovernanceMessages,
  ...terminalMessages,
  ...terminalConnectorMessages,
  ...terminalDbSourceMessages,
  ...terminalRestMessages,
  ...terminalWebMessages,
  ...terminalSheetsMessages,
  ...terminalMcpMessages,
  ...terminalAiMessages,
} satisfies Record<string, Entry>;

// The admin panel's words are not sent to every browser: only admin pages
// load them (./admin.ts, addMessages). Their keys are still known here, so
// the panel's code is checked like the rest.
type AdminOnly = typeof platformAdminMessages &
  typeof platformAdminManageMessages &
  typeof platformAdminDashboardMessages &
  typeof platformAdminOpsMessages &
  typeof platformAdminCloseMessages &
  typeof platformAdminGovernanceMessages &
  typeof platformAdminTermsMessages;

export type MessageKey = keyof typeof messages | keyof AdminOnly;

/** Adds messages loaded later (the admin panel's). */
export function addMessages(extra: Record<string, Entry>) {
  Object.assign(messages, extra);
}
export type { Entry };
