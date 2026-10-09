// A Followers trigger watches one connected account of one server. Its watcher target is "<server id>|<account id>", where a blank account means
// "the first one that works" and is written "*". Servers share nothing: a target always starts with its own server's id.
import { accountOf } from '../../shared/platforms.js';

export const ANY_ACCOUNT = '*';

/** The target key for a trigger's settings in a server (throws a FeedSettingError when the account setting is not usable). */
export const targetKeyOf = (guildId, settings) => `${guildId}|${accountOf(settings) || ANY_ACCOUNT}`;

/** The server and account a target key stands for (`accountId` is '' for “the first one that works”). */
export function parseTargetKey(key) {
  const [guildId, account = ANY_ACCOUNT] = String(key).split('|');
  return { guildId, accountId: account === ANY_ACCOUNT ? '' : account };
}
