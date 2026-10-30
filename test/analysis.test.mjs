import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { analyzeStreams, openInputs, parseLine, summarize } from '../lib/analysis.mjs';

const line = (tail, target = '/api/test/?tel=secret') => `192.0.2.1 [2026-10-30T09:55:40+08:00] "GET ${target} HTTP/1.1" 200 123 "-" "Agent" ${tail}`;
const analyze = (text, options) => analyzeStreams([Readable.from([text])], options);

test('sample: exact aggregation, slow requests and bottleneck evidence', async () => {
  const result = await analyzeStreams(openInputs([new URL('../examples/access.log', import.meta.url)]));
  assert.equal(result.overall.count, 10);
  assert.equal(result.endpoints.length, 9);
  assert.equal(result.overall.slow, 2);
  assert.equal(result.overall.metrics.rt.p95, 2293);
  assert.equal(result.overall.metrics.rt.mean, 672.6);
  assert.equal(result.overall.metrics.uct.max, 1);
  assert.equal(result.endpoints[0].key, 'GET /api/sample/get_receive_sample_list/');
  assert.equal(result.endpoints[0].count, 2);
  assert.ok(result.endpoints[0].findings.some(finding => finding.kind === 'wait'));
  assert.equal(result.quality.inconsistent, 0);
  assert.ok(!JSON.stringify(result).includes('REDACTED'));
});

test('missing upstream is not zero, derived values tolerate 1ms rounding', async () => {
  const result = await analyze(`${line('rt=0.235 uct="0.001" uht="0.236" urt="0.236"')}\n${line('rt=0.010 uct="-" uht="-" urt="-"')}`);
  assert.equal(result.overall.metrics.urt.count, 1);
  assert.equal(result.quality.missing.urt, 1);
  assert.equal(result.overall.metrics.edge.min, 0);
});

test('retries and internal redirects sum timing lists without deriving stages', () => {
  const record = parseLine(line('rt=0.4 uct="0.001, 0.002 : 0.003" uht="0.010, 0.020 : 0.030" urt="0.1, 0.1 : 0.1"'));
  assert.equal(record.attempts, 3);
  assert.equal(record.metrics.uct, 6);
  assert.equal(record.metrics.urt, 300);
  assert.equal(record.metrics.wait, null);
  const missing = parseLine(line('rt=1 uct="0.001, -" uht="-, 0.2" urt="0.1, 0.2"'));
  assert.equal(missing.metrics.uct, null);
  assert.equal(missing.metrics.urt, 300);
});

test('invalid lines, bad timings and impossible timing stages are visible', async () => {
  const result = await analyze(`broken\n\n${line('rt=bad uct="0.2" uht="0.1" urt="0.3"')}\n${line('rt=-1 uct="-"')}`);
  assert.equal(result.quality.invalid, 1);
  assert.equal(result.quality.blank, 1);
  assert.equal(result.quality.missing.rt, 2);
  assert.equal(result.quality.inconsistent, 1);
  assert.equal(result.overall.metrics.wait.count, 0);
});

test('nearest rank quantiles, empty input and optional ID normalization', async () => {
  assert.equal(summarize([4, 1, 3, 2]).p50, 2);
  assert.equal(summarize([]).p95, null);
  assert.equal((await analyze('')).start, null);
  const result = await analyze(line('rt=0.1', '/api/users/123?token=secret'), { normalizeIds: true });
  assert.equal(result.endpoints[0].key, 'GET /api/users/:id');
  assert.equal(result.overall.metrics.uct.count, 0);
});