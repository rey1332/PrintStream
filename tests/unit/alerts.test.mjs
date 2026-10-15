import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AlertQueue, alertRecipients, describeLog } from '../../src/server/alerts.ts';

function harness(overrides = {}) {
  let now = Date.parse('2026-10-15T10:00:00Z');
  const timers = [];
  const sent = [];
  const queue = new AlertQueue({
    recipients: ['ops@example.com', 'owner@example.com'],
    source: 'app on erp-01',
    send: async (mail) => sent.push(mail),
    now: () => now,
    setTimer: (fn, ms) => timers.push({ fn, at: now + ms }),
    ...overrides,
  });
  const advance = async (ms) => {
    now += ms;
    for (let i = 0; i < timers.length; i += 1) {
      const t = timers[i];
      if (t && t.at <= now) {
        timers[i] = null;
        await t.fn();
      }
    }
  };
  return { queue, sent, advance, timers: () => timers.filter(Boolean) };
}

test('a burst of errors is one e-mail a minute later, to every recipient', async () => {
  const { queue, sent, advance } = harness();
  queue.report('db', '57P01');
  queue.report('db', '57P01');
  queue.report('auth', 'login ECONNREFUSED');
  await advance(59_000);
  assert.equal(sent.length, 0);
  await advance(1_000);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent.map((m) => m.to), ['ops@example.com', 'owner@example.com']);
  assert.equal(sent[0].subject, 'ETNA: 3 errors on app on erp-01');
  assert.match(sent[0].text, /\[db\] 2 times, 2026-10-15 10:00:00 UTC to 2026-10-15 10:00:00 UTC\n {4}57P01/);
  assert.match(sent[0].text, /\[auth\] 1 time/);
});

test('then at most one e-mail every 15 minutes, with what came in between', async () => {
  const { queue, sent, advance } = harness();
  queue.report('db', 'a');
  await advance(60_000);
  assert.equal(sent.length, 2);
  queue.report('db', 'b');
  await advance(5 * 60_000);
  assert.equal(sent.length, 2, 'not before 15 minutes have passed');
  queue.report('db', 'c');
  await advance(10 * 60_000);
  assert.equal(sent.length, 4);
  assert.match(sent[2].text, /\[db\] 2 times/);
  assert.match(sent[2].text, / {4}b\n {4}c/);
});

test('no recipients: nothing is collected or sent', async () => {
  const { queue, sent, advance, timers } = harness({ recipients: [] });
  queue.report('db', 'x');
  await advance(60 * 60_000);
  assert.equal(queue.enabled, false);
  assert.equal(sent.length, 0);
  assert.equal(timers().length, 0);
});

test('log lines: the tag and codes only, never messages or values', () => {
  assert.deepEqual(describeLog(['[db]', '57P01']), { kind: 'db', detail: '57P01' });
  assert.deepEqual(describeLog(['[auth]', 'login', 'ECONNREFUSED']), { kind: 'auth', detail: 'login ECONNREFUSED' });
  // An error object travels by its code only: a database message can quote data.
  const pgError = Object.assign(new Error('duplicate key value violates unique constraint: (email)=(ana@example.com)'), { code: '23505' });
  assert.deepEqual(describeLog(['[POST /api/erp/workflows]', { code: pgError.code, message: pgError.message }]), {
    kind: 'POST /api/erp/workflows',
    detail: '23505',
  });
  assert.deepEqual(describeLog(['[2026-10-15T10:00:00.000Z] [worker] loop: 57P01']), { kind: 'worker', detail: 'loop: 57P01' });
  assert.equal(describeLog(['[mail] not sent:', 'timeout']), null, "the mailer's own failures are not alerted (no loop)");
  assert.equal(describeLog(['no tag here']).kind, 'error');
  assert.equal(describeLog(['[x]', 'y'.repeat(500)]).detail.length, 160);
});

test('recipients: ETNA_ALERT_EMAILS, else the server admins; invalid entries are skipped', () => {
  assert.deepEqual(alertRecipients({ ETNA_ALERT_EMAILS: 'a@b.co, not-an-address ,c@d.co' }), ['a@b.co', 'c@d.co']);
  assert.deepEqual(alertRecipients({ ETNA_ADMIN_EMAILS: 'admin@b.co' }), ['admin@b.co']);
  assert.deepEqual(alertRecipients({ ETNA_ALERT_EMAILS: ' ', ETNA_ADMIN_EMAILS: 'admin@b.co' }), ['admin@b.co']);
  assert.deepEqual(alertRecipients({}), []);
});
