// "Twitch followers": the follower count of the Twitch channel this server has connected (Connected accounts). Twitch tells an application a
// channel's followers only with a token the streamer approved, so the flow uses that token — one look per server, however many flows use it.
import { countSettings, MIN_TWITCH_FOLLOWER_MINUTES } from '../../shared/platforms.js';
import { AccountError } from '../accounts/common.js';
import { askWithAccount } from './account-call.js';
import { parseTargetKey, targetKeyOf } from './account-target.js';
import { countData, evaluateCount } from './count-gain.js';

const FOLLOWERS = 'https://api.twitch.tv/helix/channels/followers';

export const twitchFollowersAdapter = {
  type: 'trigger.twitch.followers',

  prepare(settings, { guildId }) {
    const { mode, everyMs } = countSettings(settings, { min: MIN_TWITCH_FOLLOWER_MINUTES });
    return { key: targetKeyOf(guildId, settings), everyMs, label: 'Twitch followers', mode };
  },

  async fetch(target, { fetch, keys, accounts }) {
    const { guildId, accountId } = parseTargetKey(target.key);
    const { res, access } = await askWithAccount({
      accounts, guildId, accountId, provider: 'twitch', refused: (r) => r.status === 401,
      ask: (a) => fetch(`${FOLLOWERS}?broadcaster_id=${encodeURIComponent(a.accountId)}&first=1`, {
        headers: { accept: 'application/json', 'client-id': keys.twitch.clientId, authorization: `Bearer ${a.token}` },
      }),
    });
    if (res.status === 429) throw new Error('Twitch says the bot is asking too often (429).');
    if (res.status === 403) {
      accounts.expire(guildId, 'twitch', access.accountId, 'Twitch did not allow reading the followers.');
      throw new AccountError('Twitch did not allow reading the followers of the connected account. Open “Accounts” and connect it again.', { expired: true });
    }
    if (res.status !== 200) throw new Error(`Twitch answered with an error (${res.status}).`);
    let total; let latest = '';
    try {
      const body = JSON.parse(res.text);
      total = Number(body.total);
      latest = String(body.data?.[0]?.user_name ?? body.data?.[0]?.user_login ?? ''); // with first=1 this is the newest follower
    } catch { throw new Error('Twitch’s answer could not be read.'); }
    if (!Number.isInteger(total) || total < 0) throw new Error('Twitch’s answer could not be read.');
    accounts.noteCount(guildId, 'twitch', access.accountId, total);
    return { followers: total, name: access.accountName, login: access.accountLogin, accountId: access.accountId, latest };
  },

  evaluate(state, { followers, name, login, accountId, latest }, sub) {
    const shown = name || 'the connected channel';
    const { state: next, fire, log } = evaluateCount(state, followers, { mode: sub.plan.mode, noun: 'followers', name: `Twitch “${shown}”`, owner: accountId });
    return {
      state: next, log,
      fire: fire.map((f) => ({
        label: f.gained > 0 ? `Twitch “${shown}” gained ${f.gained.toLocaleString('en-US')} follower${f.gained === 1 ? '' : 's'}` : `Twitch “${shown}” now has ${f.count.toLocaleString('en-US')} followers`,
        data: { twitch: { ...countData('followers', f), name: shown, login: login || '', url: login ? `https://www.twitch.tv/${login}` : '', latest: latest || '' } },
      })),
    };
  },
};
