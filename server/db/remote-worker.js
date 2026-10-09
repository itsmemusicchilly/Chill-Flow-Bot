import { workerData } from 'node:worker_threads';
import { decode, encode } from './codec.js';
import { openCloudDatabase } from './open.js';

const HEADER = 16;
const state = new Int32Array(workerData.sab, 0, 4);
const bytes = new Uint8Array(workerData.sab);
let db = null;

function read() {
  const length = Atomics.load(state, 1);
  const value = JSON.parse(Buffer.from(bytes.subarray(HEADER, HEADER + length)).toString());
  bytes.fill(0, HEADER, HEADER + length);
  return value;
}

function write(value) {
  const payload = Buffer.from(JSON.stringify(value));
  const room = bytes.length - HEADER;
  if (payload.length > room) {
    const err = Buffer.from(JSON.stringify({ error: { name: 'Error', message: 'The database reply is too large.' } }));
    bytes.set(err, HEADER);
    Atomics.store(state, 1, err.length);
    return;
  }
  bytes.set(payload, HEADER);
  Atomics.store(state, 1, payload.length);
}

async function handle(request) {
  const args = decode(request.args);
  if (request.method === 'init') {
    db = await openCloudDatabase(args[0]);
    return { driver: args[0].driver };
  }
  if (request.method === 'close') {
    await db?.close();
    db = null;
    return null;
  }
  const fn = db?.[request.method];
  if (typeof fn !== 'function') throw new Error(`Unknown database method ${request.method}.`);
  return fn.apply(db, args);
}

for (;;) {
  while (Atomics.load(state, 0) !== 1) {
    const seen = Atomics.load(state, 0);
    if (seen === 1) break;
    Atomics.wait(state, 0, seen);
  }
  const request = read();
  let response;
  try { response = { value: encode(await handle(request)) }; } catch (err) {
    response = { error: { name: err.name || 'Error', message: err.message || String(err) } };
  }
  write(response);
  Atomics.store(state, 0, 2);
  Atomics.notify(state, 0);
  if (request.method === 'close') break;
}
