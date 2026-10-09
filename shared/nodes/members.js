// Members: give, take away and toggle a role on a member; kick, ban, unban, time out and rename a member.
import { idField, num, text } from '../fields.js';
import { ACTION_OUTS, def, reasonField, ROLE } from './core.js';

// ---- members ------------------------------------------------------------------------------------
const userField = () => idField('userId', 'Member', 'user', { placeholder: 'blank = the user who triggered this' });
def('action.member.addRole', {
  category: 'member', label: 'Give Role', icon: '🎖️', description: 'Give a member a role.',
  fields: [userField(), idField('roleId', 'Role', 'role', { required: true }), reasonField()],
  outputs: ACTION_OUTS, summary: (d) => d.roleId || '',
});
def('action.member.removeRole', {
  category: 'member', label: 'Remove Role', icon: '📤', description: 'Take a role away from a member.',
  fields: [userField(), idField('roleId', 'Role', 'role', { required: true }), reasonField()],
  outputs: ACTION_OUTS, summary: (d) => d.roleId || '',
});
def('action.member.toggleRole', {
  category: 'member', label: 'Toggle Role', icon: '🔁',
  description: 'Give the role if the member does not have it, take it away if they do. Perfect for role panels: one button per role. Use {{toggle.action}} (added / removed) in your reply.',
  fields: [userField(), idField('roleId', 'Role', 'role', { required: true }), reasonField()],
  outputs: ACTION_OUTS,
  provides: () => [...ROLE, ['toggle.action', 'Whether the role was “added” or “removed”']],
  summary: (d) => d.roleId || '',
});
def('action.member.kick', {
  category: 'member', label: 'Kick Member', icon: '🥾', description: 'Kick a member from the server.',
  fields: [userField(), reasonField()], outputs: ACTION_OUTS, summary: (d) => d.userId || 'triggering user',
});
def('action.member.ban', {
  category: 'member', label: 'Ban Member', icon: '🔨', description: 'Ban a member from the server.',
  fields: [userField(), reasonField(), num('deleteMessageDays', 'Delete their messages from the last … days', { min: 0, max: 7, default: 0 })],
  outputs: ACTION_OUTS, summary: (d) => d.userId || 'triggering user',
});
def('action.member.unban', {
  category: 'member', label: 'Unban User', icon: '🕊️', description: 'Lift a ban.',
  fields: [idField('userId', 'User ID', 'user', { required: true }), reasonField()], outputs: ACTION_OUTS, summary: (d) => d.userId || '',
});
def('action.member.timeout', {
  category: 'member', label: 'Timeout Member', icon: '⏳', description: 'Mute a member for a while. 0 minutes removes a timeout.',
  fields: [userField(), num('minutes', 'Minutes', { default: 10, min: 0, max: 40320, required: true }), reasonField()],
  outputs: ACTION_OUTS, summary: (d) => `${d.minutes ?? '?'} min`,
});
def('action.member.nickname', {
  category: 'member', label: 'Set Nickname', icon: '🏷️', description: 'Change a member\'s nickname. Leave blank to reset it.',
  fields: [userField(), text('nickname', 'Nickname', { placeholder: 'blank = reset' }), reasonField()],
  outputs: ACTION_OUTS, summary: (d) => d.nickname || 'reset',
});
