import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';

const cli = fileURLToPath(new URL('../analyze.mjs', import.meta.url));
const samplePath = fileURLToPath(new URL('../examples/access.log', import.meta.url));
const run = (args, input) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', input });
async function temporary(t) {
  const directory = await mkdtemp(join(tmpdir(), 'nginx-analysis-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('CLI merges gzip and stdin, generates nested HTML and JSON outputs', async t => {
  const directory = await temporary(t);
  const source = await readFile(samplePath);
  const gzipPath = join(directory, 'access.log.gz');
  const htmlPath = join(directory, 'nested', 'report.html');
  const jsonPath = join(directory, 'stats.json');
  await writeFile(gzipPath, gzipSync(source));
  const result = run([gzipPath, '-', '-o', htmlPath, '--json', jsonPath, '--slow-ms', '500', '--top', '3'], source);
  assert.equal(result.status, 0, result.stderr);
  const data = JSON.parse(await readFile(jsonPath, 'utf8'));
  assert.equal(data.overall.count, 20);
  assert.equal(data.overall.slow, 6);
  assert.equal(data.slowest.length, 3);
  assert.equal(data.endpoints.length, 9);
  assert.ok((await readFile(htmlPath, 'utf8')).startsWith('<!doctype html>'));
});

test('CLI excludes static endpoints by default and supports --include-static', async t => {
  const directory = await temporary(t);
  const htmlPath = join(directory, 'report.html');
  const jsonPath = join(directory, 'stats.json');
  const input = ['/assets/app.js?v=1', '/assets/style.css', '/api/users'].map(target =>
    `192.0.2.1 [2026-10-30T09:55:40+08:00] "GET ${target} HTTP/1.1" 200 123 "-" "Agent" rt=0.1`).join('\n');
  for (const includeStatic of [false, true]) {
    const result = run(['-', '-o', htmlPath, '--json', jsonPath, ...(includeStatic ? ['--include-static'] : [])], input);
    assert.equal(result.status, 0, result.stderr);
    const data = JSON.parse(await readFile(jsonPath, 'utf8'));
    assert.equal(data.overall.count, 3);
    assert.equal(data.endpoints.length, includeStatic ? 3 : 1);
    assert.equal(data.slowest.length, 3);
    assert.ok((await readFile(htmlPath, 'utf8')).startsWith('<!doctype html>'));
  }
  assert.ok(run(['--help']).stdout.includes('--include-static'));
});

test('CLI rejects invalid options, empty input, unreadable files and output collisions', async t => {
  const directory = await temporary(t);
  const output = join(directory, 'report.html');
  const cases = [
    [[], '请指定日志文件'],
    [[samplePath, '--slow-ms', '0'], '--slow-ms'],
    [[samplePath, '--top', '0.5'], '--top'],
    [['-', '-'], '标准输入只能读取一次'],
    [[samplePath, '-o', samplePath], '输出路径不能覆盖输入日志'],
    [[samplePath, '-o', output, '--json', output], '不能使用相同路径'],
    [[join(directory, 'absent.log'), '-o', output], 'ENOENT'],
    [['-', '-o', output], '没有有效日志记录'],
  ];
  for (const [args, message] of cases) {
    const result = run(args, 'not a log\n');
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.ok(result.stderr.includes(message), result.stderr);
  }
  await assert.rejects(readFile(output), { code: 'ENOENT' });
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.ok(help.stdout.includes('用法'));
});

test('corrupt gzip and missing gzip fail cleanly', async t => {
  const directory = await temporary(t);
  const path = join(directory, 'bad.gz');
  await writeFile(path, 'not gzip');
  for (const input of [path, join(directory, 'absent.gz')]) {
    const result = run([input, '-o', join(directory, 'report.html')]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.startsWith('分析失败：'), result.stderr);
    assert.ok(!result.stderr.includes('Unhandled'), result.stderr);
  }
});

test('watch CLI validates monitor options', async t => {
  const directory = await temporary(t);
  const cases = [
    [['-', '--watch'], '普通日志文件'],
    [[samplePath, '--watch', '--alert-ms', '0'], '--alert-ms'],
    [[samplePath, '--watch', '--poll-ms', '0'], '--poll-ms'],
    [[samplePath, '--watch', '--alert-cooldown-ms', '-1'], '--alert-cooldown-ms'],
    [[samplePath, '--watch', '-o', join(directory, 'report.html')], '报告选项'],
    [[samplePath, samplePath, '--watch'], '不能重复'],
    [[samplePath, '--alert-ms', '10000'], '--watch'],
    [[join(directory, 'missing.log'), '--watch'], 'ENOENT'],
  ];
  for (const [args, message] of cases) {
    const result = run(args);
    assert.equal(result.status, 1, JSON.stringify(args));
    assert.ok(result.stderr.includes(message), result.stderr);
  }
  assert.ok(run(['--help']).stdout.includes('--watch'));
});

test('watch CLI rejects unreadable or malformed notification config without exposing secrets', async t => {
  const directory = await temporary(t);
  const path = join(directory, 'config.json');
  for (const source of ['{"FEISHU_SECRET":"private-secret",', 'null', '[]', '"private-secret"']) {
    await writeFile(path, source);
    const result = run([samplePath, '--watch', '--config', path]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes('--config'), result.stderr);
    assert.ok(!result.stderr.includes('private-secret'), result.stderr);
  }
  const missing = run([samplePath, '--watch', '--config', join(directory, 'missing.json')]);
  assert.equal(missing.status, 1);
  assert.ok(missing.stderr.includes('ENOENT'), missing.stderr);
  const report = run([samplePath, '--config', path]);
  assert.equal(report.status, 1);
  assert.ok(report.stderr.includes('--watch'), report.stderr);
  assert.ok(run(['--help']).stdout.includes('--config'));
});

for (const source of ['config', 'env', 'cli']) {
test(`watch CLI sends Webhook from ${source} and exits cleanly on SIGTERM`, { timeout: 5000 }, async t => {
  const directory = await temporary(t);
  const path = join(directory, 'access.log');
  const log = seconds => `192.0.2.1 [2026-10-30T09:55:40+08:00] "GET /api/orders?secret=hidden HTTP/1.1" 200 123 "-" "Agent" rt=${seconds}\n`;
  await writeFile(path, log(30));
  let received;
  const notification = new Promise(resolve => { received = resolve; });
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    response.setHeader('content-type', 'application/json');
    response.end('{"code":0}');
    received(JSON.parse(Buffer.concat(chunks).toString()));
  });
  t.after(() => { server.closeAllConnections(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const env = { ...process.env };
  for (const name of ['FEISHU_WEBHOOK_URL', 'FEISHU_SECRET', 'ALERT_EMAIL_TO']) delete env[name];
  const webhook = `http://127.0.0.1:${server.address().port}/hook`;
  const configPath = join(directory, 'config.json');
  await writeFile(configPath, JSON.stringify({
    FEISHU_WEBHOOK_URL: source === 'config' ? webhook : 'file:///config-hook', FEISHU_SECRET: 'config-secret',
  }));
  if (source !== 'config') {
    env.FEISHU_WEBHOOK_URL = source === 'env' ? webhook : 'file:///env-hook';
    env.FEISHU_SECRET = 'env-secret';
  }
  const child = spawn(process.execPath, [cli, path, '--watch', '--poll-ms', '5', '--alert-ms', '10000',
    '--config', configPath, ...(source === 'cli' ? ['--feishu-webhook', webhook] : [])], { cwd: directory, env });
  const closed = once(child, 'close');
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stdout = '';
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', () => reject(new Error(`监控提前退出：${stderr}`)));
    child.stdout.on('data', chunk => { stdout += chunk.toString(); if (stdout.includes('正在监控')) resolve(); });
  });
  await appendFile(path, log(1) + log(12));
  const body = await notification;
  assert.ok(body.content.text.includes('12000 ms'));
  assert.ok(!body.content.text.includes('hidden'));
  assert.equal(body.sign, createHmac('sha256', `${body.timestamp}\n${env.FEISHU_SECRET ?? 'config-secret'}`).update('').digest('base64'));
  child.kill('SIGTERM');
  const [code, signal] = await closed;
  assert.equal(code, 0, stderr);
  assert.equal(signal, null);
  await assert.rejects(readFile(join(directory, 'report.html')), { code: 'ENOENT' });
});
}