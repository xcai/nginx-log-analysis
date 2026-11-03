import { createHmac } from 'node:crypto';
import { hostname } from 'node:os';

function booleanEnv(env, name, fallback) {
  if (env[name] === undefined) return fallback;
  if (!['true', 'false'].includes(String(env[name]))) throw new Error(`${name} 必须为 true 或 false`);
  return String(env[name]) === 'true';
}

export function formatAlert(alert) {
  const clean = value => String(value).replace(/[\r\n\x00-\x1f\x7f]/g, ' ').slice(0, 500);
  return [
    'Nginx 慢请求告警',
    `主机：${clean(hostname())}`,
    `日志：${clean(alert.source)}`,
    `接口：${clean(alert.method)} ${clean(alert.path)}`,
    `耗时：${alert.metrics.rt} ms；阈值：${alert.thresholdMs} ms`,
    `状态码：${alert.status}`,
    `请求完成时间：${new Date(alert.timestamp).toISOString()}`,
  ].join('\n');
}

export async function createNotifier({ feishuWebhook, emailTo, config = {}, env = process.env, fetchImpl = fetch,
  log = console.warn, onError = console.error } = {}) {
  env = { ...config, ...env };
  feishuWebhook ??= env.FEISHU_WEBHOOK_URL;
  emailTo ??= env.ALERT_EMAIL_TO;
  const channels = [];
  let transport;
  if (feishuWebhook) {
    const url = new URL(feishuWebhook);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('飞书 Webhook 必须是 HTTP(S) URL');
    channels.push({ name: '飞书', send: async text => {
      const body = { msg_type: 'text', content: { text } };
      if (env.FEISHU_SECRET) {
        body.timestamp = String(Math.floor(Date.now() / 1000));
        body.sign = createHmac('sha256', `${body.timestamp}\n${env.FEISHU_SECRET}`).update('').digest('base64');
      }
      const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      if ((result.code ?? result.StatusCode) !== 0) throw new Error('飞书未确认发送成功，请检查机器人配置、关键词及签名');
    } });
  }
  if (emailTo) {
    if (!env.SMTP_HOST || !env.SMTP_FROM) throw new Error('邮件告警需要设置 SMTP_HOST 和 SMTP_FROM');
    if (Boolean(env.SMTP_USER) !== Boolean(env.SMTP_PASS)) throw new Error('SMTP_USER 与 SMTP_PASS 必须同时设置');
    const port = Number(env.SMTP_PORT ?? 465);
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('SMTP_PORT 必须为 1 到 65535 的整数');
    const secure = booleanEnv(env, 'SMTP_SECURE', port === 465);
    const requireTLS = booleanEnv(env, 'SMTP_REQUIRE_TLS', !secure);
    let nodemailer;
    try { ({ default: nodemailer } = await import('nodemailer')); }
    catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND') throw new Error('邮件告警需要先运行 npm install'); throw error; }
    transport = nodemailer.createTransport({ host: env.SMTP_HOST, port, secure, requireTLS,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 10_000 });
    channels.push({ name: '邮件', send: async text => {
      const result = await transport.sendMail({ from: env.SMTP_FROM, to: emailTo, subject: 'Nginx 慢请求告警', text });
      if (result.rejected?.length) throw new Error(`${result.rejected.length} 个收件人被拒绝`);
    } });
  }
  return {
    async notify(alert) {
      const text = formatAlert(alert);
      log(text);
      await Promise.all(channels.map(async channel => {
        try { await channel.send(text); }
        catch (error) { onError(`${channel.name}告警发送失败：${error.message}`); }
      }));
    },
    close() { transport?.close(); },
  };
}