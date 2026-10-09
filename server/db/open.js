import { applyLimits } from '../../shared/limits.js';
import { DocumentDatabase } from './document.js';
import { MemoryStore } from './memory-store.js';

/** Builds the cloud database inside the worker. `memory` is for tests. */
export async function openCloudDatabase(cfg) {
  applyLimits(cfg.limits || {});
  if (cfg.driver === 'memory') return new DocumentDatabase(new MemoryStore());
  if (cfg.driver === 'mongodb') {
    const { MongoStore } = await import('./mongo-store.js');
    return new DocumentDatabase(await MongoStore.connect(cfg));
  }
  if (cfg.driver === 'firebase') {
    const { FirestoreStore } = await import('./firestore-store.js');
    return new DocumentDatabase(await FirestoreStore.connect(cfg));
  }
  if (cfg.driver === 'cloudflare') {
    const { D1Store } = await import('./d1-store.js');
    return new DocumentDatabase(await D1Store.connect(cfg));
  }
  throw new Error(`Unknown database driver “${cfg.driver}”.`);
}
