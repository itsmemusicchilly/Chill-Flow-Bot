import { DocumentDatabase } from './document.js';
import { startSyncRpc } from './sync-rpc.js';

/** A database that looks synchronous to the rest of the bot and does its work in a worker thread. */
export function openRemoteDatabase(database) {
  const rpc = startSyncRpc(new URL('./remote-worker.js', import.meta.url));
  const db = new RemoteDatabase(rpc);
  try { rpc.call('init', [database]); } catch (err) {
    rpc.close();
    throw err;
  }
  return db;
}

class RemoteDatabase {
  constructor(rpc) { this.rpc = rpc; }
  close() { this.rpc.close(); }
}

for (const name of Object.getOwnPropertyNames(DocumentDatabase.prototype)) {
  if (name === 'constructor' || name === 'close') continue;
  RemoteDatabase.prototype[name] = function remoteMethod(...args) { return this.rpc.call(name, args); };
}
