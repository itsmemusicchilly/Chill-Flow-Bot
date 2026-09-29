// Per-trigger filters. Returns false to skip, or an object (optionally with extra template `data`) to run.
import { cleanId } from './resolve.js';
import { safeRegexTest } from './safe-regex.js';

function matchMessage(d, content) {
  const text = String(d.text ?? '');
  const cs = Boolean(d.caseSensitive);
  const a = cs ? content : content.toLowerCase();
  const b = cs ? text : text.toLowerCase();
  switch (d.mode) {
    case 'contains': { const i = a.indexOf(b); return i === -1 ? null : { after: content.slice(i + text.length).trim() }; }
    case 'startsWith': return a.startsWith(b) ? { after: content.slice(text.length).trim() } : null;
    case 'equals': return a === b ? { after: '' } : null;
    case 'regex': return safeRegexTest(text, content, cs ? '' : 'i') ? { after: content } : null;
    default: return { after: content };
  }
}

const sameId = (want, have) => !want || cleanId(want) === String(have ?? '');

function matchEmoji(want, e) {
  const w = String(want ?? '').trim().replace(/^<a?:|>$/g, '').replace(/^:|:$/g, '');
  if (!w) return true;
  return [e?.name, e?.id, e?.id ? `${e.name}:${e.id}` : null, e?.display].filter(Boolean).includes(w);
}

export function matches(type, d, info = {}) {
  if (info.byBot && !d.includeSelf) return false;
  if (d.ignoreBots && info.isBot) return false;
  switch (type) {
    case 'trigger.message.received': {
      if (!sameId(d.channelId, info.channelId)) return false;
      const m = matchMessage(d, String(info.content ?? ''));
      return m ? { data: { message: { after: m.after } } } : false;
    }
    case 'trigger.message.deleted':
    case 'trigger.voice.joined':
    case 'trigger.voice.left':
      return sameId(d.channelId, info.channelId) ? {} : false;
    case 'trigger.reaction.added':
    case 'trigger.reaction.removed':
      return sameId(d.messageId, info.messageId) && matchEmoji(d.emoji, info.emoji) ? {} : false;
    case 'trigger.form.submitted':
      return d.form && d.form === info.formKey ? {} : false;
    case 'trigger.member.roleAdded':
    case 'trigger.member.roleRemoved': {
      const want = String(d.roleId ?? '').trim();
      if (!want) return {};
      return cleanId(want) === info.roleId || want.toLowerCase() === String(info.roleName ?? '').toLowerCase() ? {} : false;
    }
    default: return {};
  }
}
