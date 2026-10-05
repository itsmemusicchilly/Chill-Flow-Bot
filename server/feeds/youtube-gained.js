// "YouTube subscribers gained": the same public subscriber count as the milestone trigger (YouTube's Data API, one request for up to 50
// channels, the operator's API key) — but it runs for each rise, or for each change when it drives a counter. YouTube rounds public counts to
// three significant figures above 1,000, so a big channel moves in small jumps; a hidden count cannot be watched.
import { youtubeCountSettings } from '../../shared/platforms.js';
import { countData, evaluateCount } from './count-gain.js';
import { fetchYoutubeChannels } from './youtube.js';

export const youtubeGainedAdapter = {
  type: 'trigger.youtube.gained',

  prepare(settings) {
    const { channelId, mode, everyMs } = youtubeCountSettings(settings);
    return { key: channelId, everyMs, label: `YouTube ${channelId}`, mode };
  },

  fetchMany: fetchYoutubeChannels,

  evaluate(state, { channel }, sub) {
    const name = channel.title || sub.label;
    if (channel.hidden) {
      if (state?.hiddenNoted) return { state, fire: [], log: [] };
      return { state: { ...(state ?? {}), hiddenNoted: true }, fire: [], log: [{ level: 'warn', message: `“${name}” hides its subscriber count, so there is nothing to watch.` }] };
    }
    const { state: next, fire, log } = evaluateCount(state, channel.subscribers, { mode: sub.plan.mode, noun: 'subscribers', name: `“${name}”` });
    const cleared = next.hiddenNoted ? { ...next, hiddenNoted: false } : next;
    return {
      state: cleared, log,
      fire: fire.map((f) => ({
        label: f.gained > 0 ? `YouTube “${name}” gained ${f.gained.toLocaleString('en-US')} subscriber${f.gained === 1 ? '' : 's'}` : `YouTube “${name}” now has ${f.count.toLocaleString('en-US')} subscribers`,
        data: { youtube: { subscribers: f.count, ...countData('subscribers', f), channelTitle: name, channelId: channel.id, url: `https://www.youtube.com/channel/${channel.id}` } },
      })),
    };
  },
};
