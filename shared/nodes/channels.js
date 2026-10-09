// Channels: create, change and delete channels, and save a channel's messages as a transcript.
import { area, bool, idField, list, multi, num, select, text, when, whenNot } from '../fields.js';
import { ACTION_OUTS, CHANNEL_PERMISSIONS, def, reasonField } from './core.js';

// ---- channels -----------------------------------------------------------------------------------
const overwriteList = () => list('overwrites', 'Permission overrides', {
  create: () => ({ targetType: 'role', targetId: '@everyone', allow: [], deny: [] }),
  label: (o) => `${o.targetType}: ${o.targetId}`,
  fields: [
    select('targetType', 'Applies to', [['role', 'A role'], ['member', 'A member']]),
    text('targetId', 'Role / member ID', { required: true, placeholder: '@everyone, a role ID, or {{user.id}}' }),
    multi('allow', 'Allow', CHANNEL_PERMISSIONS),
    multi('deny', 'Deny', CHANNEL_PERMISSIONS),
  ],
});
const CHANNEL_TYPES = [['text', 'Text'], ['voice', 'Voice'], ['category', 'Category'], ['announcement', 'Announcement'], ['stage', 'Stage'], ['forum', 'Forum']];
def('action.channel.create', {
  category: 'channel', label: 'Create Channel', icon: '➕', description: 'Create a channel. Save its ID to use it later in the flow.',
  fields: [
    text('name', 'Name', { required: true, placeholder: 'ticket-{{user.name}}' }),
    select('type', 'Type', CHANNEL_TYPES),
    idField('parentId', 'Category', 'category', { showIf: whenNot('type', 'category') }),
    text('topic', 'Topic', { showIf: when('type', 'text', 'announcement', 'forum') }),
    bool('nsfw', 'Age-restricted', { showIf: when('type', 'text', 'announcement', 'forum', 'voice') }),
    num('slowmode', 'Slowmode (seconds)', { showIf: when('type', 'text', 'forum'), min: 0, max: 21600 }),
    num('userLimit', 'User limit', { showIf: when('type', 'voice', 'stage'), min: 0, max: 99 }),
    bool('privateChannel', 'Hide from @everyone', { help: 'Then add overrides below to let specific people in.' }),
    overwriteList(),
    text('outputVar', 'Save channel ID as variable', { placeholder: 'channel', pattern: 'var' }),
  ],
  outputs: ACTION_OUTS, summary: (d) => `${d.type} “${d.name || '?'}”`,
});
def('action.channel.delete', {
  category: 'channel', label: 'Delete Channel', icon: '🗑️', description: 'Delete a channel. Blank = the channel where this happened.',
  fields: [idField('channelId', 'Channel', 'channel', { placeholder: 'blank = current channel' }), reasonField()],
  outputs: ACTION_OUTS, summary: (d) => d.channelId || 'current channel',
});
def('action.channel.update', {
  category: 'channel', label: 'Update Channel', icon: '🛠️', description: 'Rename or reconfigure a channel. Blank fields stay unchanged. Discord allows only two name/topic changes per channel every 10 minutes: extra ones are held and only the newest is applied when Discord allows.',
  fields: [
    idField('channelId', 'Channel', 'channel', { placeholder: 'blank = current channel' }),
    text('name', 'New name'), text('topic', 'New topic'),
    idField('parentId', 'Move to category', 'category'),
    num('slowmode', 'Slowmode (seconds)', { min: 0, max: 21600 }),
    select('nsfw', 'Age-restricted', [['', 'Unchanged'], ['yes', 'Yes'], ['no', 'No']]),
    overwriteList(),
  ],
  outputs: ACTION_OUTS, summary: (d) => d.channelId || 'current channel',
});
def('action.channel.transcript', {
  category: 'channel', label: 'Save Transcript', icon: '📄',
  description: 'Record everything said in a channel (for example a ticket that is being closed), post it in a log channel and optionally send it to someone by direct message — as a link to a web page the bot\'s server keeps, as an .html file (plus a plain .txt copy), or both. If it cannot be saved, follow On error and keep the channel.',
  fields: [
    idField('channelId', 'Channel to record', 'channel', { placeholder: 'blank = current channel' }),
    idField('sendChannelId', 'Post the transcript in', 'channel', {
      required: true, help: 'For example your staff log. The bot needs Send Messages (and Attach Files, if the files are sent) there. Do not use the channel being recorded.',
    }),
    select('delivery', 'How to send the transcript', [
      ['link', 'A link to a web page (kept on the bot\'s server)'],
      ['files', 'Files attached to the message (.html and .txt)'],
      ['both', 'Both: the link and the files'],
    ], {
      help: 'A link opens the transcript as a web page for anyone who has it, until the server deletes it (TRANSCRIPT_RETENTION_DAYS in the .env file; by default it is kept forever). It is sent as an “Open transcript” button and needs a public BASE_URL. “Both” sends just the files when the server has no public address.',
    }),
    area('channelMessage', 'Message with the transcript (log channel)', { default: '📄 Transcript of #{{channel.name}}', rows: 2 }),
    idField('sendUserId', 'Also send it to (direct message)', 'user', {
      placeholder: '{{original.user.id}} = whoever opened the ticket',
      help: 'Optional. If their DMs are closed, or they can no longer see the channel, the DM is skipped and the flow carries on.',
    }),
    area('dmMessage', 'Message with the transcript (direct message)', {
      showIf: whenNot('sendUserId', ''), rows: 2,
      default: 'Here is a copy of your conversation in {{guild.name}}.',
    }),
    bool('skipText', 'Leave out the plain-text (.txt) copy', {
      showIf: whenNot('delivery', 'link'),
      help: 'By default a .txt file with the same messages is attached next to the .html one, in the log channel and in the direct message. It is easy to search, copy and read on a phone.',
    }),
  ],
  outputs: ACTION_OUTS,
  provides: () => [
    ['transcript.messages', 'Messages in the transcript'], ['transcript.name', 'Transcript file name (.html)'], ['transcript.textName', 'Plain-text file name (.txt, blank if left out)'], ['transcript.bytes', 'File size (bytes, .html)'],
    ['transcript.truncated', 'true if the transcript was cut short'], ['transcript.dm', 'Direct message: sent, failed or skipped'],
    ['transcript.url', 'Link to the transcript page (blank if no link was made)'], ['transcript.expires', 'When the link stops working (ISO time; blank = never, or no link)'],
  ],
  wants: 'messageContent',
  wantsNote: 'without the Message Content intent Discord hides other people\'s message text, so the transcript can only show who wrote when (plus the bot\'s own messages). Ask the bot operator to enable it.',
  summary: (d) => (d.sendChannelId
    ? `→ ${d.sendChannelId}${d.sendUserId ? ' + DM' : ''}${d.delivery === 'link' ? ' · link' : d.delivery === 'both' ? ' · link + files' : ''}`
    : 'choose a log channel'),
});
