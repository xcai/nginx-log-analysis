import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, appendFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { watchLines, createAlertHandler } from '../lib/monitor.mjs';
import { createNotifier, formatAlert } from '../lib/notifications.mjs';

const log = (seconds, path = '/api/orders?token=hidden') =>
  `192.0.2.1 [2026-10-30T09:55:40+08:00] "GET ${path} HTTP/1.1" 200 123 "-" "Agent" rt=${seconds}`;

test('watch follows new complete UTF-8 lines, rotation and truncation', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nginx-watch-'));
  const path = join(directory, 'access.log');
  const controller = new AbortController();
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path, 'historical\nunfinished');
  const lines = watchLines([path], { pollMs: 5, signal: controller.signal,
    onReady: () => appendFile(path, ' old line\nnew\n').catch(() => {}) });
  t.after(async () => { controller.abort(); await lines.return(); });
  assert.equal((await lines.next()).value.line, 'new');
  const text = Buffer.from('中文\r\n');
  await appendFile(path, text.subarray(0, 2));
  const next = lines.next();
  await appendFile(path, text.subarray(2));
  assert.equal((await next).value.line, '中文');
  await rename(path, `${path}.1`);
  await appendFile(`${path}.1`, 'old tail\n');
  await writeFile(path, 'rotated\n');
  assert.equal((await lines.next()).value.line, 'old tail');
  assert.equal((await lines.next()).value.line, 'rotated');
  await writeFile(path, 'cut\n');
  assert.equal((await lines.next()).value.line, 'cut');
  controller.abort();
  assert.equal((await lines.next()).done, true);
});

test('watch stops without yielding the rest of a buffered batch', { timeout: 5000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'nginx-watch-stop-'));
  const path = join(directory, 'access.log');
  const controller = new AbortController();
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path, '');
  const lines = watchLines([path], { pollMs: 5, signal: controller.signal,
    onReady: () => appendFile(path, 'first\nsecond\n').catch(() => {}) });
  t.after(async () => { controller.abort(); await lines.return(); });
  assert.equal((await lines.next()).value.line, 'first');
  controller.abort();
  assert.equal((await lines.next()).done, true);
});

test('alerts use RT in milliseconds, strip queries and apply per-endpoint cooldown', async () => {
  const alerts = [];
  let time = 0;
  const handle = createAlertHandler({ thresholdMs: 10_000, cooldownMs: 100,
    notify: async alert => alerts.push(alert), now: () => time });
  for (const line of ['bad line', log('-'), log('9.999'), log('10'), log('11')]) {
    await handle({ path: 'access.log', line });
  }
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].metrics.rt, 10_000);
  assert.equal(alerts[0].path, '/api/orders');
  await handle({ path: 'access.log', line: log('12', '/api/other') });
  assert.equal(alerts.length, 2);
  time = 100;
  await handle({ path: 'access.log', line: log('12') });
  assert.equal(alerts.length, 3);
});

test('notification errors do not stop subsequent alerts', async () => {
  const errors = [];
  let calls = 0;
  const handle = createAlertHandler({ cooldownMs: 0, notify: async () => { calls++; throw new Error('offline'); },
    onError: message => errors.push(message) });
  await handle({ path: 'access.log', line: log('11') });
  await handle({ path: 'access.log', line: log('12') });
  assert.equal(calls, 2);
  assert.equal(errors.length, 2);
});

const alert = { source: 'access.log', method: 'GET', path: '/api/orders', status: 200,
  timestamp: Date.parse('2026-10-30T09:55:40+08:00'), metrics: { rt: 12_000 }, thresholdMs: 10_000 };

test('Feishu sends signed text and reports business errors without stopping', async () => {
  const bodies = [];
  const errors = [];
  const notifier = await createNotifier({ feishuWebhook: 'https://example.com/hook', env: { FEISHU_SECRET: 'test-secret' },
    log: () => {}, onError: message => errors.push(message), fetchImpl: async (url, options) => {
      assert.equal(url.href, 'https://example.com/hook');
      assert.equal(options.method, 'POST');
      assert.ok(options.signal);
      bodies.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ code: bodies.length === 1 ? 0 : 19021 }) };
    } });
  await notifier.notify(alert);
  await notifier.notify(alert);
  assert.equal(bodies[0].msg_type, 'text');
  assert.equal(bodies[0].content.text, formatAlert(alert));
  assert.equal(bodies[0].sign, createHmac('sha256', `${bodies[0].timestamp}\ntest-secret`).update('').digest('base64'));
  assert.equal(errors.length, 1);
});

test('notification settings prefer environment variables and fall back to config', async () => {
  for (const env of [{}, { FEISHU_WEBHOOK_URL: 'https://example.com/env', FEISHU_SECRET: 'env-secret' }]) {
    const errors = [];
    const notifier = await createNotifier({ env,
      config: { FEISHU_WEBHOOK_URL: 'https://example.com/config', FEISHU_SECRET: 'config-secret' },
      log: () => {}, onError: message => errors.push(message), fetchImpl: async (url, options) => {
        assert.equal(url.href, env.FEISHU_WEBHOOK_URL ?? 'https://example.com/config');
        const body = JSON.parse(options.body);
        const secret = env.FEISHU_SECRET ?? 'config-secret';
        assert.equal(body.sign, createHmac('sha256', `${body.timestamp}\n${secret}`).update('').digest('base64'));
        return { ok: true, json: async () => ({ code: 0 }) };
      } });
    await notifier.notify(alert);
    assert.deepEqual(errors, []);
    notifier.close();
  }
  await assert.rejects(createNotifier({ env: { SMTP_PORT: '0' }, config: {
    ALERT_EMAIL_TO: 'ops@example.com', SMTP_HOST: 'localhost', SMTP_FROM: 'monitor@example.com', SMTP_PORT: 465,
  } }), /SMTP_PORT/);
});

test('SMTP sends mail even when the Feishu channel fails', { timeout: 5000 }, async t => {
  const commands = [];
  const messages = [];
  const sockets = new Set();
  const server = createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.write('220 localhost test SMTP\r\n');
    let pending = '';
    let message = null;
    socket.on('data', chunk => {
      pending += chunk.toString();
      let boundary;
      while ((boundary = pending.indexOf('\r\n')) !== -1) {
        const line = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        if (message !== null) {
          if (line === '.') { messages.push(message.join('\r\n')); message = null; socket.write('250 queued\r\n'); }
          else message.push(line);
          continue;
        }
        commands.push(line);
        if (line.startsWith('EHLO')) socket.write('250-localhost\r\n250 OK\r\n');
        else if (line === 'DATA') { message = []; socket.write('354 send data\r\n'); }
        else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const errors = [];
  const notifier = await createNotifier({ feishuWebhook: 'https://example.com/hook',
    config: { ALERT_EMAIL_TO: 'ops@example.com,dev@example.com', SMTP_HOST: 'invalid.example',
      SMTP_PORT: server.address().port, SMTP_FROM: 'monitor@example.com', SMTP_SECURE: false, SMTP_REQUIRE_TLS: false },
    env: { SMTP_HOST: '127.0.0.1' },
    log: () => {}, onError: message => errors.push(message), fetchImpl: async () => ({ ok: false, status: 500 }) });
  t.after(() => notifier.close());
  await notifier.notify(alert);
  assert.equal(messages.length, 1);
  assert.ok(messages[0].includes('From: monitor@example.com'));
  assert.ok(messages[0].includes('Subject:'));
  assert.ok(commands.includes('RCPT TO:<ops@example.com>'));
  assert.ok(commands.includes('RCPT TO:<dev@example.com>'));
  assert.deepEqual(errors, ['飞书告警发送失败：HTTP 500']);
});

test('notification configuration fails early and console-only alerts work', async () => {
  await assert.rejects(createNotifier({ emailTo: 'ops@example.com', env: {} }), /SMTP_HOST/);
  await assert.rejects(createNotifier({ feishuWebhook: 'file:///tmp/hook' }), /HTTP/);
  await assert.rejects(createNotifier({ emailTo: 'ops@example.com', env: {
    SMTP_HOST: 'localhost', SMTP_FROM: 'monitor@example.com', SMTP_PORT: '0' } }), /SMTP_PORT/);
  const logs = [];
  const notifier = await createNotifier({ env: {}, log: text => logs.push(text) });
  await notifier.notify(alert);
  assert.equal(logs[0], formatAlert(alert));
  notifier.close();
});