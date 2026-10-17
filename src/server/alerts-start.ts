// Turns error alerts on for this process (src/server/alerts.ts): the app from
// src/instrumentation.ts, the Terminal worker from scripts/server/worker.mjs.

import os from 'node:os';
import { AlertQueue, alertRecipients, installConsoleAlerts } from './alerts';
import { mailConfigured, sendMail } from './mail/mailer';

export function startAlerts(processName: 'app' | 'worker'): AlertQueue | null {
  if (process.env.NODE_ENV !== 'production') return null;
  const recipients = alertRecipients();
  if (!recipients.length || !mailConfigured()) return null;
  const queue = new AlertQueue({
    recipients,
    source: `${processName} on ${os.hostname()}`,
    send: (mail) => sendMail(mail),
  });
  installConsoleAlerts(queue);
  return queue;
}
