// Asking a platform on behalf of a server's connected account: use its token; when the platform refuses the token, take a fresh one and ask
// once more; when it still refuses, the connection is marked "connect again" and the person is told so.
import { CONNECTIONS } from '../../shared/platforms.js';
import { AccountError } from '../accounts/common.js';

/**
 * @param {{accounts: object, guildId: string, provider: string, accountId?: string, ask: (access: {token: string, accountId: string}) => Promise<{status: number, text: string}>, refused: (res: object) => boolean}} o
 * @returns {Promise<{res: object, access: object}>}
 */
export async function askWithAccount({ accounts, guildId, provider, accountId = '', ask, refused }) {
  if (!accounts) throw new AccountError(`${CONNECTIONS[provider]} accounts are not available here.`);
  let access = await accounts.access(guildId, provider, { accountId });
  let res = await ask(access);
  if (refused(res)) {
    access = await accounts.access(guildId, provider, { accountId: access.accountId, fresh: true });
    res = await ask(access);
    if (refused(res)) {
      accounts.expire(guildId, provider, access.accountId, `${CONNECTIONS[provider]} no longer accepts the saved permission.`);
      throw new AccountError(`${CONNECTIONS[provider]} no longer accepts this connection. Open “Accounts” and connect it again.`, { expired: true });
    }
  }
  return { res, access };
}
