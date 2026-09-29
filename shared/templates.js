// Starter flows shown in "New flow → from template". Ids are fixed so button handles line up.
import { defaultsFor } from './catalog.js';

const n = (id, type, x, y, data = {}) => ({ id, type, position: { x, y }, data: { ...defaultsFor(type), ...data } });
const e = (source, target, sourceHandle = 'out') => ({ id: `${source}:${sourceHandle}>${target}`, source, sourceHandle, target, targetHandle: 'in' });

export const TEMPLATES = [
  {
    id: 'welcome',
    name: 'Welcome new members',
    description: 'Greets people in a channel and gives them a starter role. Needs the Server Members intent.',
    build: () => ({
      nodes: [
        n('t1', 'trigger.member.join', 0, 60),
        n('m1', 'action.message.send', 340, 0, {
          target: 'channel', useEmbed: true, embedTitle: 'Welcome!', embedColor: '#3ba55d',
          embedDescription: 'Hey {{user.mention}}, welcome to **{{guild.name}}**! You are member #{{guild.memberCount}}.',
        }),
        n('r1', 'action.member.addRole', 700, 40, { reason: 'Welcome flow' }),
      ],
      edges: [e('t1', 'm1'), e('m1', 'r1')],
    }),
  },
  {
    id: 'ticket',
    name: 'Support tickets',
    description: '/ticket opens a private channel with a Close button. Add your staff role in the “Create Channel” overrides.',
    build: () => ({
      nodes: [
        n('t1', 'trigger.command', 0, 120, {
          name: 'ticket', description: 'Open a support ticket',
          options: [{ name: 'reason', description: 'What do you need help with?', type: 'string', required: false }],
        }),
        n('c1', 'action.channel.create', 340, 60, {
          name: 'ticket-{{user.name}}', privateChannel: true, outputVar: 'ticket',
          overwrites: [{ targetType: 'member', targetId: '{{user.id}}', allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory'], deny: [] }],
        }),
        n('r1', 'action.message.send', 700, 60, { target: 'reply', ephemeral: true, content: 'Your ticket is ready: <#{{var.ticket}}>' }),
        n('s1', 'action.message.send', 1060, 60, {
          target: 'channel', channelId: '{{var.ticket}}', useEmbed: true, embedTitle: '🎫 Ticket', embedColor: '#5865f2',
          embedDescription: '{{user.mention}} opened a ticket.\n**Reason:** {{option.reason | default:No reason given}}',
          buttons: [{ id: 'close', label: 'Close ticket', style: 'Danger', emoji: '🔒', url: '', disabled: false }],
        }),
        n('r2', 'action.message.send', 1440, 200, { target: 'reply', content: 'Closing this ticket in 5 seconds…' }),
        n('w1', 'logic.wait', 1800, 200, { seconds: 5 }),
        n('d1', 'action.channel.delete', 2140, 200, { reason: 'Ticket closed' }),
      ],
      edges: [e('t1', 'c1'), e('c1', 'r1'), e('r1', 's1'), e('s1', 'r2', 'btn_close'), e('r2', 'w1'), e('w1', 'd1')],
    }),
  },
  {
    id: 'role-panel',
    name: 'Button role panel',
    description: 'Press ▶ Run on the trigger to post a panel; each button gives a different role. Set a channel on the trigger.',
    build: () => ({
      nodes: [
        n('t1', 'trigger.manual', 0, 140),
        n('m1', 'action.message.send', 340, 100, {
          target: 'current_channel', useEmbed: true, embedTitle: 'Pick your roles', embedDescription: 'Press a button to get a role.',
          buttons: [
            { id: 'b1', label: 'Gamer', style: 'Primary', emoji: '🎮', url: '', disabled: false },
            { id: 'b2', label: 'Artist', style: 'Secondary', emoji: '🎨', url: '', disabled: false },
          ],
        }),
        n('g1', 'action.member.addRole', 760, 20, { reason: 'Role panel' }),
        n('g2', 'action.member.addRole', 760, 300, { reason: 'Role panel' }),
        n('a1', 'action.message.send', 1120, 20, { target: 'reply', ephemeral: true, content: 'You got the Gamer role ✅' }),
        n('a2', 'action.message.send', 1120, 300, { target: 'reply', ephemeral: true, content: 'You got the Artist role ✅' }),
      ],
      edges: [e('t1', 'm1'), e('m1', 'g1', 'btn_b1'), e('m1', 'g2', 'btn_b2'), e('g1', 'a1'), e('g2', 'a2')],
    }),
  },
  {
    id: 'counter',
    name: 'Server counter',
    description: 'A tiny example of remembered variables: /count adds one and shows the total.',
    build: () => ({
      nodes: [
        n('t1', 'trigger.command', 0, 60, { name: 'count', description: 'Add one to the server counter' }),
        n('v1', 'data.variable.set', 340, 40, { scope: 'guild', name: 'counter', operation: 'add', value: '1' }),
        n('m1', 'action.message.send', 700, 40, { target: 'reply', content: 'The counter is now **{{guild.vars.counter}}**.' }),
      ],
      edges: [e('t1', 'v1'), e('v1', 'm1')],
    }),
  },
  {
    id: 'mod-log',
    name: 'Ban log',
    description: 'Posts an embed in a log channel whenever someone is banned.',
    build: () => ({
      nodes: [
        n('t1', 'trigger.member.banned', 0, 60, { ignoreBots: false }),
        n('m1', 'action.message.send', 340, 40, {
          target: 'channel', useEmbed: true, embedTitle: '🔨 Member banned', embedColor: '#ed4245', embedTimestamp: true,
          embedDescription: '**{{user.name}}** (`{{user.id}}`) was banned by {{executor.mention | default:someone}}.\nReason: {{reason | default:none given}}',
        }),
      ],
      edges: [e('t1', 'm1')],
    }),
  },
];
