import { FeedSettingError, feedSettings } from '@shared/feeds.js';
import { useEditor } from '../context.js';

/** Under a New Feed Item trigger's settings: the exact address the bot will read, and when it looks. Problems are already listed at the top of the panel. */
export default function FeedPreview({ data }) {
  const { feedMinMinutes } = useEditor();
  let url;
  try { ({ url } = feedSettings(data)); } catch (e) {
    if (e instanceof FeedSettingError) return null;
    throw e;
  }
  const every = Math.max(Number(feedMinMinutes) || 0, Number(data.minutes));
  return (
    <div className="field feed-preview">
      <label>The bot will read</label>
      <code className="feed-url">{url}</code>
      <div className="help">It looks every {every} minutes{every > Number(data.minutes) ? ` (this bot's operator allows no more often than that)` : ''}. The first look only remembers the posts that are already there; after that, each new post starts this flow once.</div>
    </div>
  );
}
