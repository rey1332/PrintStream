import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { buildMessage, encodeHeader, mailAddress, sendSmtp } from '../../src/server/mail/smtp.ts';
import { linkMail, mailConfig } from '../../src/server/mail/mailer.ts';

// tests/fixtures/smtp-test-*.pem: a self-signed certificate for localhost, for these tests only.
const cert = readFileSync(new URL('../fixtures/smtp-test-cert.pem', import.meta.url), 'utf8');
const key = readFileSync(new URL('../fixtures/smtp-test-key.pem', import.meta.url), 'utf8');

// Every server socket, destroyed after each test so nothing keeps the process alive.
const sockets = new Set();
const track = (socket) => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
};
afterEach(() => {
  for (const socket of sockets) socket.destroy();
});

/** A fake SMTP server that records the conversation. */
function fakeServer({ starttls = false, auth = 'PLAIN' } = {}) {
  const log = [];
  let message = '';
  const server = net.createServer((raw) => {
    track(raw);
    let socket = raw;
    let buffer = '';
    let inData = false;
    const say = (line) => socket.write(`${line}\r\n`);
    const ehlo = (secure) =>
      [`250-localhost`, ...(starttls && !secure ? ['250-STARTTLS'] : []), `250 AUTH ${auth}`].join(
        '\r\n'
      );
    const handle = (line, secure) => {
      if (inData) {
        if (line === '.') {
          inData = false;
          say('250 queued');
        } else message += `${line}\r\n`;
        return;
      }
      log.push(line.startsWith('AUTH PLAIN') ? 'AUTH PLAIN …' : line);
      if (line.startsWith('EHLO')) socket.write(`${ehlo(secure)}\r\n`);
      else if (line === 'STARTTLS') {
        say('220 go ahead');
        raw.removeAllListeners('data');
        socket = new tls.TLSSocket(raw, { isServer: true, cert, key });
        socket.on('data', (chunk) => feed(chunk, true));
      } else if (line.startsWith('AUTH PLAIN')) say('235 ok');
      else if (line === 'AUTH LOGIN') say('334 VXNlcm5hbWU6');
      else if (log.at(-2) === 'AUTH LOGIN') say('334 UGFzc3dvcmQ6');
      else if (log.at(-3) === 'AUTH LOGIN') say('235 ok');
      else if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) say('250 ok');
      else if (line === 'DATA') {
        inData = true;
        say('354 send');
      } else if (line === 'QUIT') {
        say('221 bye');
        socket.end();
      } else say('500 what');
    };
    const feed = (chunk, secure) => {
      buffer += chunk.toString('utf8');
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        handle(line, secure);
      }
    };
    raw.on('data', (chunk) => feed(chunk, false));
    say('220 fake ESMTP');
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: server.address().port, log, message: () => message })
    )
  );
}

const MESSAGE = {
  from: 'ETNA <erp@example.test>',
  to: 'budi@example.test',
  subject: 'Akun ETNA Anda',
  text: 'Halo\n.dot line',
};

test('sends with STARTTLS and AUTH PLAIN; refuses a server without TLS', async () => {
  const fake = await fakeServer({ starttls: true });
  await sendSmtp(
    {
      host: 'localhost',
      port: fake.port,
      secure: false,
      user: 'erp@example.test',
      password: 'secret',
      ca: cert,
    },
    MESSAGE
  );
  assert.deepEqual(
    fake.log.map((l) => l.split(' ')[0]),
    ['EHLO', 'STARTTLS', 'EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT']
  );
  assert.match(fake.message(), /^Subject: Akun ETNA Anda$/m, 'subject header present');
  fake.server.close();

  const plain = await fakeServer();
  await assert.rejects(
    sendSmtp(
      { host: '127.0.0.1', port: plain.port, secure: false, user: 'u', password: 'p' },
      MESSAGE
    ),
    /does not offer TLS/
  );
  plain.server.close();
});

test('AUTH LOGIN when PLAIN is not offered; errors never contain the password', async () => {
  const fake = await fakeServer({ auth: 'LOGIN' });
  await sendSmtp(
    {
      host: '127.0.0.1',
      port: fake.port,
      secure: false,
      user: 'u',
      password: 'p',
      allowInsecure: true,
    },
    MESSAGE
  );
  assert.ok(fake.log.includes('AUTH LOGIN'));
  fake.server.close();

  const refusing = net.createServer((s) => {
    s.write('220 hi\r\n');
    s.on('data', (d) =>
      s.write(String(d).startsWith('EHLO') ? '250 AUTH PLAIN\r\n' : '535 bad credentials\r\n')
    );
  });
  await new Promise((r) => refusing.listen(0, '127.0.0.1', r));
  await assert.rejects(
    sendSmtp(
      {
        host: '127.0.0.1',
        port: refusing.address().port,
        secure: false,
        user: 'u',
        password: 'hunter2',
        allowInsecure: true,
      },
      MESSAGE
    ),
    (error) => /AUTH refused \(535\)/.test(error.message) && !error.message.includes('hunter2')
  );
  refusing.close();
});

test('messages: addresses checked, headers without line breaks, dot-stuffing, UTF-8 subjects', () => {
  assert.equal(mailAddress('ETNA <erp@example.test>'), 'erp@example.test');
  assert.equal(mailAddress('bad\r\nBcc: x@y.z'), null);
  assert.equal(encodeHeader('Hello\r\nBcc: evil@x.test'), 'Hello Bcc: evil@x.test');
  assert.equal(encodeHeader('Akun siap'), 'Akun siap');
  assert.match(encodeHeader('账户'), /^=\?UTF-8\?B\?/);
  const raw = buildMessage({ ...MESSAGE, html: '<p>Halo</p>' });
  assert.match(raw, /multipart\/alternative/);
  assert.ok(!raw.includes('\n.dot'), 'body is base64, so no bare dot lines');
});

test('configuration from the environment; the link e-mail is bilingual', () => {
  assert.equal(mailConfig({}), null);
  assert.deepEqual(
    mailConfig({
      SMTP_HOST: 'smtp.example.test',
      SMTP_USER: 'erp@example.test',
      SMTP_PASSWORD: 'x',
    }),
    {
      host: 'smtp.example.test',
      port: 587,
      secure: false,
      user: 'erp@example.test',
      password: 'x',
      from: 'erp@example.test',
    }
  );
  assert.equal(
    mailConfig({ SMTP_HOST: 'h', SMTP_SECURE: 'true', SMTP_FROM: 'a@b.test' }).port,
    465
  );
  assert.equal(mailConfig({ SMTP_HOST: 'h' }), null, 'a sender is required');
  const mail = linkMail(
    'company',
    'https://erp.example.test/x',
    '2026-10-05T03:00:00Z',
    'PT Batu Jaya'
  );
  assert.match(mail.subject, /PT Batu Jaya/);
  assert.match(mail.text, /Buka tautan ini/);
  assert.match(mail.text, /Open this link/);
  assert.ok(
    !linkMail('invite', 'https://x.test/?a=<b>', '2026-10-05T03:00:00Z').html.includes('<b>'),
    'HTML is escaped'
  );
});
