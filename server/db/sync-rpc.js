// The rest of the bot calls the database synchronously. MongoDB, Firestore and D1 answer over the network,
// so those calls run in a worker thread and this side waits for the reply. One call at a time: the bot thread
// is blocked until it returns, which is also why a second call cannot overlap the first.
import { Worker } from 'node:worker_threads';
import { ConfigError } from '../config.js';
import { FlowError } from '../engine/errors.js';
import { decode, encode } from './codec.js';
import { SlugTakenError } from './errors.js';

const HEADER = 16;
const MAX = 16 * 1024 * 1024;
const TIMEOUT_MS = 30_000;

export function startSyncRpc(workerUrl) {
  const sab = new SharedArrayBuffer(HEADER + MAX);
  const state = new Int32Array(sab, 0, 4);
  const bytes = new Uint8Array(sab);
  const worker = new Worker(workerUrl, {
    workerData: { sab },
    execArgv: process.execArgv.filter((arg) => arg !== '--test' && !arg.startsWith('--test-')),
  });
  let dead = null;
  worker.on('error', (err) => { dead = err; });
  worker.on('exit', (code) => { if (!dead && code !== 0) dead = new Error(`The database worker stopped (${code}).`); });

  function call(method, args) {
    if (dead) throw new Error(dead.message || 'The database worker stopped.');
    const payload = Buffer.from(JSON.stringify({ method, args: encode(args) }));
    if (payload.length > MAX) throw new Error('The database request is too large.');
    bytes.set(payload, HEADER);
    Atomics.store(state, 1, payload.length);
    Atomics.store(state, 0, 1);
    Atomics.notify(state, 0);
    const waited = Atomics.wait(state, 0, 1, TIMEOUT_MS);
    if (Atomics.load(state, 0) !== 2) {
      dead = new Error(waited === 'timed-out' ? `The database took too long on ${method}.` : 'The database worker stopped.');
      worker.terminate();
      throw dead;
    }
    const length = Atomics.load(state, 1);
    const response = JSON.parse(Buffer.from(bytes.subarray(HEADER, HEADER + length)).toString());
    bytes.fill(0, HEADER, HEADER + length);
    Atomics.store(state, 0, 0);
    Atomics.notify(state, 0);
    if (response.error) throw revive(response.error);
    return decode(response.value);
  }

  return {
    call,
    close() {
      if (!dead) { try { call('close', []); } catch { /* already stopping */ } }
      worker.terminate();
    },
  };
}

function revive(error) {
  if (error.name === 'FlowError') return new FlowError(error.message);
  if (error.name === 'SlugTakenError') return new SlugTakenError(error.message);
  if (error.name === 'ConfigError') return new ConfigError(error.message);
  const err = new Error(error.message);
  err.name = error.name || 'Error';
  return err;
}
