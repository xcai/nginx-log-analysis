import { open, stat } from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { parseLine } from './analysis.mjs';

function reset(state, offset = 0) {
  state.offset = offset;
  state.decoder = new StringDecoder('utf8');
  state.pending = '';
  state.discard = false;
}

async function openFile(path, fromEnd) {
  const handle = await open(path, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`监控仅支持普通文件：${path}`);
    const state = { path, handle, dev: info.dev, ino: info.ino };
    reset(state, fromEnd ? info.size : 0);
    if (fromEnd && info.size) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, info.size - 1);
      state.discard = last[0] !== 10;
    }
    return state;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function* readNewLines(state, signal) {
  const info = await state.handle.stat();
  if (info.size < state.offset) reset(state);
  const buffer = Buffer.alloc(64 * 1024);
  while (state.offset < info.size && !signal?.aborted) {
    const { bytesRead } = await state.handle.read(buffer, 0, Math.min(buffer.length, info.size - state.offset), state.offset);
    if (!bytesRead) break;
    state.offset += bytesRead;
    const parts = (state.pending + state.decoder.write(buffer.subarray(0, bytesRead))).split('\n');
    state.pending = parts.pop();
    for (const line of parts) {
      if (signal?.aborted) return;
      if (state.discard) { state.discard = false; continue; }
      yield { path: state.path, line: line.replace(/\r$/, '') };
    }
    if (state.pending.length > 1024 * 1024) {
      state.pending = '';
      state.discard = true;
    }
  }
}

export async function* watchLines(paths, { signal, pollMs = 1000, onReady = () => {} } = {}) {
  if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error('轮询间隔必须为正整数');
  const states = [];
  try {
    for (const path of paths) states.push(await openFile(path, true));
    onReady();
    while (!signal?.aborted) {
      for (let index = 0; index < states.length; index++) {
        const state = states[index];
        yield* readNewLines(state, signal);
        let info;
        try { info = await stat(state.path); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        if (info.dev !== state.dev || info.ino !== state.ino) {
          let replacement;
          try { replacement = await openFile(state.path, false); }
          catch (error) { if (error.code === 'ENOENT') continue; throw error; }
          states[index] = replacement;
          try { yield* readNewLines(state, signal); }
          finally { await state.handle.close(); }
          yield* readNewLines(replacement, signal);
        }
      }
      try { await delay(pollMs, undefined, { signal }); }
      catch (error) { if (error.name !== 'AbortError') throw error; }
    }
  } finally {
    await Promise.all(states.map(state => state.handle.close()));
  }
}

export function createAlertHandler({ thresholdMs = 10_000, cooldownMs = 60_000, notify, now = Date.now, onError = console.error }) {
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) throw new Error('告警阈值必须大于 0');
  if (!Number.isFinite(cooldownMs) || cooldownMs < 0) throw new Error('告警冷却时间不能小于 0');
  const lastAlerts = new Map();
  return async ({ path, line }) => {
    const record = parseLine(line);
    if (!record || record.metrics.rt === null || record.metrics.rt < thresholdMs) return;
    const current = now();
    for (const [key, time] of lastAlerts) {
      if (current - time >= cooldownMs) lastAlerts.delete(key);
    }
    const key = `${path}\n${record.method} ${record.path}`;
    if (lastAlerts.has(key)) return;
    lastAlerts.set(key, current);
    const alert = { source: path, thresholdMs, ...record };
    try { await notify(alert); }
    catch (error) { onError(`告警发送失败：${error.message}`); }
  };
}