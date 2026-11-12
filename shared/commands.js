// What the editor, the runtime and the registration with Discord all need to agree on about slash commands:
// how a command with a sub-command is named, and how the lines of a choice list are read.

export const COMMAND_NAME_RE = /^[a-z0-9_-]{1,32}$/;
/** Discord shows at most this many choices, and at most this many suggestions while typing. */
export const MAX_CHOICES = 25;
/** The option types that can have choices or suggestions. */
export const CHOICE_TYPES = ['string', 'integer', 'number'];
/** Discord allows this many right-click commands of each kind (on a member, on a message) per server. */
export const MAX_MENU_COMMANDS = 5;

export const subOf = (d) => String(d?.sub ?? '').trim();
/** How a Slash Command trigger is found: "ticket", or "ticket open" for a sub-command. */
export const commandKey = (name, sub = '') => (sub ? `${name} ${sub}` : String(name ?? ''));
/** How a Right-Click Command trigger is found: its kind and its name, exactly as shown in the menu. */
export const menuKey = (kind, name) => `${kind === 'message' ? 'message' : 'user'}|${String(name ?? '').trim()}`;

/**
 * The lines of a choice list. "Label = value" shows the label and gives the flow the value; a line without "=" is both.
 * Empty lines and repeated labels are left out; labels and values are cut to Discord's 100 characters.
 */
export function parseChoices(text) {
  const out = [];
  const seen = new Set();
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf('=');
    const name = (i === -1 ? t : t.slice(0, i)).trim().slice(0, 100);
    const value = (i === -1 ? t : t.slice(i + 1)).trim().slice(0, 100);
    if (!name || !value || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, value });
  }
  return out;
}

/** A choice as Discord wants it for this option type: number options need a number. Null when the value is not one. */
export function typedChoice(choice, type) {
  if (type !== 'integer' && type !== 'number') return { name: choice.name, value: String(choice.value) };
  const n = Number(choice.value);
  if (String(choice.value).trim() === '' || !Number.isFinite(n) || (type === 'integer' && !Number.isInteger(n))) return null;
  return { name: choice.name, value: n };
}

/** The suggestions for what has been typed so far: those that start with it first, then those that contain it. Capital letters do not matter. */
export function suggestChoices(choices, typed, type = 'string', max = MAX_CHOICES) {
  const q = String(typed ?? '').trim().toLowerCase();
  const starts = [];
  const contains = [];
  for (const c of choices) {
    const choice = typedChoice(c, type);
    if (!choice) continue;
    const label = choice.name.toLowerCase();
    if (!q || label.startsWith(q)) starts.push(choice);
    else if (label.includes(q) || String(choice.value).toLowerCase().includes(q)) contains.push(choice);
  }
  return [...starts, ...contains].slice(0, max);
}
