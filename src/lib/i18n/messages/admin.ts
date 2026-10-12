// The admin panel's words, loaded by the admin pages only (never sent to
// other pages). Importing this module adds them to the messages.

import { addMessages } from './index';
import { platformAdminMessages } from './platformAdmin';
import { platformAdminManageMessages } from './platformAdminManage';
import { platformAdminDashboardMessages } from './platformAdminDashboard';
import { platformAdminOpsMessages } from './platformAdminOps';
import { platformAdminCloseMessages } from './platformAdminClose';
import { platformAdminGovernanceMessages } from './platformAdminGovernance';
import { platformAdminTermsMessages } from './platformAdminTerms';

addMessages({
  ...platformAdminMessages,
  ...platformAdminManageMessages,
  ...platformAdminDashboardMessages,
  ...platformAdminOpsMessages,
  ...platformAdminCloseMessages,
  ...platformAdminGovernanceMessages,
  ...platformAdminTermsMessages,
});

export const ADMIN_MESSAGES_LOADED = true;
