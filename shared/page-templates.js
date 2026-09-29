// Starter pages for "New page → from template". Block ids are fixed so they stay stable across copies.
import { defaultBlockData } from './blocks.js';

const b = (id, type, data = {}) => ({ id, type, data: { ...defaultBlockData(type), ...data } });
const q = (id, label, type, extra = {}) => ({ id, label, type, required: true, placeholder: '', help: '', options: '', min: '', max: '', ...extra });

export const PAGE_TEMPLATES = [
  {
    id: 'blank', name: 'Blank page', description: 'Start from nothing.',
    build: () => ({ title: 'New page', slug: 'new-page', blocks: [] }),
  },
  {
    id: 'landing', name: 'Landing page', description: 'A hero, a few lines about your community and a join button.',
    build: () => ({
      title: 'Welcome', slug: 'welcome',
      blocks: [
        b('hero1', 'hero', { title: 'Welcome to our community', subtitle: 'Friendly people, good vibes, weekly events.', buttonLabel: 'Join on Discord', buttonUrl: 'https://discord.gg/your-invite' }),
        b('text1', 'text', { body: '## About us\n\nWe are a **friendly** community. Tell people what makes yours special.' }),
        b('list1', 'list', { items: 'Weekly game nights\nHelpful channels\nActive moderators', style: 'checks' }),
        b('btn1', 'button', { label: 'Join the server', url: 'https://discord.gg/your-invite', align: 'center' }),
      ],
    }),
  },
  {
    id: 'application', name: 'Staff application form', description: 'People log in with Discord and apply. Pair it with a “Form Submitted” flow that posts the answers to a private channel.',
    build: () => ({
      title: 'Staff applications', slug: 'apply',
      blocks: [
        b('hero1', 'hero', { title: 'Join our team', subtitle: 'Tell us a bit about yourself.' }),
        b('form1', 'form', {
          title: 'Application', intro: 'Answers go to the admins together with your Discord name.', submitLabel: 'Send application', oneResponsePerUser: true,
          fields: [
            q('name', 'What should we call you?', 'short', { max: 60 }),
            q('age', 'How old are you?', 'number', { min: 13, max: 120 }),
            q('role', 'Which role are you applying for?', 'select', { options: 'Moderator\nEvent host\nHelper' }),
            q('why', 'Why do you want to help?', 'long', { min: 30, help: 'A few sentences is plenty.' }),
            q('rules', 'I have read and agree to the server rules', 'agree'),
          ],
          successMessage: 'Thanks — we will get back to you on Discord.',
        }),
      ],
    }),
  },
  {
    id: 'contact', name: 'Contact / support form', description: 'A simple way to reach the admins without opening a ticket in Discord.',
    build: () => ({
      title: 'Contact the admins', slug: 'contact',
      blocks: [
        b('h1', 'heading', { text: 'How can we help?', level: '1' }),
        b('form1', 'form', {
          title: 'Send us a message', submitLabel: 'Send',
          fields: [
            q('topic', 'What is this about?', 'radio', { options: 'Question\nReport a problem\nSuggestion' }),
            q('message', 'Your message', 'long', { min: 10 }),
            q('reply', 'Is it OK to DM you a reply?', 'agree', { required: false }),
          ],
          successMessage: 'Thanks! An admin will look at it soon.',
        }),
      ],
    }),
  },
  {
    id: 'rules', name: 'Rules & verification', description: 'Show the rules; members tick a box to confirm. A flow can then give them a role.',
    build: () => ({
      title: 'Server rules', slug: 'rules',
      blocks: [
        b('h1', 'heading', { text: 'Server rules', level: '1' }),
        b('list1', 'list', { items: 'Be kind and respectful\nNo spam or self-promotion\nKeep topics in the right channels\nFollow the Discord Terms of Service', style: 'numbers' }),
        b('form1', 'form', {
          title: 'Verify', submitLabel: 'I agree', oneResponsePerUser: true, saveResponses: false,
          fields: [q('agree', 'I have read and agree to the rules', 'agree')],
          successMessage: 'Thanks — you are verified. Head back to Discord!',
        }),
      ],
    }),
  },
];
