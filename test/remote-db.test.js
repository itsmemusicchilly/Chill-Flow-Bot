import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openRemoteDatabase } from '../server/db/remote.js';
import { SlugTakenError } from '../server/db/errors.js';
import { FlowError } from '../server/engine/errors.js';

describe('the synchronous cloud database bridge', () => {
  it('returns plain values, sets, maps and the same errors the local database raises', () => {
    const db = openRemoteDatabase({ driver: 'memory', limits: { varsPerGuild: 1 } });
    try {
      db.setVar('g', 'guild', '', 'score', 1);
      assert.equal(db.getVar('g', 'guild', '', 'score'), 1);
      assert.equal(db.getVar('g', 'guild', '', 'missing'), undefined);
      assert.throws(() => db.setVar('g', 'channel', '9', 'other', 2), (err) => err instanceof FlowError && /limit of 1/.test(err.message));
      const page = db.createPage({ guildId: 'g', slug: 'home', title: 'Home', theme: {}, blocks: ['upload:abcdefghijklmnop'] });
      assert.throws(() => db.createPage({ guildId: 'g', slug: 'home', title: 'Again', theme: {}, blocks: [] }), (err) => err instanceof SlugTakenError);
      const upload = db.addUpload({ guildId: 'g', name: 'pic', bytes: 2, width: 1, height: 1, animated: false, sha256: 'h' });
      assert.equal(db.uploadIds('g') instanceof Set, true);
      const uses = db.uploadUses('g');
      assert.equal(uses instanceof Map, true);
      assert.equal(uses.get('abcdefghijklmnop').pages[0].id, page.id);
      assert.equal(db.getUpload('g', upload.id).name, 'pic');
      assert.equal(db.deletePage('g', page.id), true);
    } finally {
      db.close();
    }
  });
});
