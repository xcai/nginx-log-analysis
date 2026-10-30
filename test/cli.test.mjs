import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';

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