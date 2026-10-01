// A node saved before it gained a choice is rewritten — when a flow is saved, and when it is opened in the editor — to say what it always
// did, so that what the editor shows is what will happen. (The runtime reads stored flows as they are, so every executor also treats a
// missing choice as the old behaviour.) Idempotent: a node that already says it comes back as the very same object.
import { upgradeMessageData } from './embeds.js';

/** Save Transcript: before there was a choice of delivery, it always attached the files. */
function upgradeTranscript(data) {
  if (!data || typeof data !== 'object' || data.delivery !== undefined) return data;
  return { ...data, delivery: 'files' };
}

export function upgradeNodeData(type, data) {
  if (type === 'action.channel.transcript') return upgradeTranscript(data);
  return upgradeMessageData(type, data);
}
