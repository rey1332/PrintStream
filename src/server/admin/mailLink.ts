// E-mails a password link an admin just created (invitation, reset, new
// company owner). The link is still shown to the admin in the panel, so a
// failed e-mail never loses it.

import type { SessionInfo } from '@/server/auth/service';
import type { Executor } from '@/server/db/executor';
import { linkMail, mailConfigured, sendMail, type LinkMailKind } from '@/server/mail/mailer';
import { authorizeOperation, type RequestMeta } from './service';

export type MailOutcome = 'sent' | 'failed' | 'off';

export async function emailLink(
  executor: Executor,
  session: SessionInfo,
  meta: RequestMeta,
  link: {
    userId: string;
    email: string;
    kind: LinkMailKind;
    url: string;
    expiresAt: string;
    company?: string;
  }
): Promise<MailOutcome> {
  if (!mailConfigured()) return 'off';
  try {
    await authorizeOperation(executor, session, meta, 'INVITE_EMAILED', {
      user_id: link.userId,
      email: link.email,
      kind: link.kind,
    });
  } catch {
    return 'failed';
  }
  const message = linkMail(link.kind, link.url, link.expiresAt, link.company);
  const result = await sendMail({ to: link.email, ...message });
  return result.ok ? 'sent' : 'failed';
}
