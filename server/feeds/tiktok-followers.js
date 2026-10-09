// "TikTok followers": the follower count of the TikTok account this server has connected (Connected accounts), read through TikTok's own
// Display API with the token the creator approved. One look per server, however many flows use it.
import { countSettings, MIN_TIKTOK_MINUTES } from '../../shared/platforms.js';
import { AccountError } from '../accounts/common.js';
import { askWithAccount } from './account-call.js';
import { parseTargetKey, targetKeyOf } from './account-target.js';
import { countData, evaluateCount } from './count-gain.js';

const USER = 'https://open.tiktokapis.com/v2/user/info/?fields=open_id,display_name,follower_count';

const bodyOf = (res) => { try { return JSON.parse(res.text); } catch { return null; } };
const codeOf = (res) => String(bodyOf(res)?.error?.code ?? '');

export const tiktokFollowersAdapter = {
  type: 'trigger.tiktok.followers',

  prepare(settings, { guildId }) {
    const { mode, everyMs } = countSettings(settings, { min: MIN_TIKTOK_MINUTES });
    return { key: targetKeyOf(guildId, settings), everyMs, label: 'TikTok followers', mode };
  },

  async fetch(target, { fetch, accounts }) {
    const { guildId, accountId } = parseTargetKey(target.key);
    const { res, access } = await askWithAccount({
      accounts, guildId, accountId, provider: 'tiktok', refused: (r) => r.status === 401 || codeOf(r) === 'access_token_invalid',
      ask: (a) => fetch(USER, { headers: { accept: 'application/json', authorization: `Bearer ${a.token}` } }),
    });
    const code = codeOf(res);
    if (code === 'scope_not_authorized' || code === 'scope_permission_missed') {
      accounts.expire(guildId, 'tiktok', access.accountId, 'TikTok did not allow reading the follower count.');
      throw new AccountError('TikTok did not allow reading the follower count of the connected account. Open “Accounts” and connect it again.', { expired: true });
    }
    if (res.status === 429 || code === 'rate_limit_exceeded') throw new Error('TikTok says the bot is asking too often.');
    if (res.status !== 200 || (code && code !== 'ok')) throw new Error(`TikTok answered with an error (${code || res.status}).`);
    const followers = Number(bodyOf(res)?.data?.user?.follower_count);
    if (!Number.isInteger(followers) || followers < 0) throw new Error('TikTok’s answer could not be read.');
    accounts.noteCount(guildId, 'tiktok', access.accountId, followers);
    return { followers, name: access.accountName, accountId: access.accountId };
  },

  evaluate(state, { followers, name, accountId }, sub) {
    const shown = name || 'the connected account';
    const { state: next, fire, log } = evaluateCount(state, followers, { mode: sub.plan.mode, noun: 'followers', name: `TikTok “${shown}”`, owner: accountId });
    return {
      state: next, log,
      fire: fire.map((f) => ({
        label: f.gained > 0 ? `TikTok “${shown}” gained ${f.gained.toLocaleString('en-US')} follower${f.gained === 1 ? '' : 's'}` : `TikTok “${shown}” now has ${f.count.toLocaleString('en-US')} followers`,
        data: { tiktok: { ...countData('followers', f), name: shown } },
      })),
    };
  },
};
