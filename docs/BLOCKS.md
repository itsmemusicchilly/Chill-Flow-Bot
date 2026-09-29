# Page block reference

> Generated from `shared/blocks.js` by `npm run docs` — do not edit by hand.

Pages are made of blocks, top to bottom. Text fields accept a little formatting — `**bold**`, `*italic*`, `[link text](https://example.com)` —
and never raw HTML. Links must be full `https://` (or `http://`) addresses. Images are pictures you upload in the editor (**Choose…**) or full `https://` addresses.

## Page settings

| Field | Type | Notes |
| --- | --- | --- |
| Look | select | options: Dark, Light |
| Accent colour | color |  |
| Page width | select | options: Narrow, Normal, Wide |

## 🌟 Hero

`hero` — A big title with an optional subtitle, background image and button.

| Field | Type | Notes |
| --- | --- | --- |
| Title | text |  |
| Subtitle | text |  |
| Background image | image | a picture you uploaded, or a full https link |
| Button label | text |  |
| Button link | text |  |
| Alignment | select | options: Left, Centred |

## 🔤 Heading

`heading` — A section heading.

| Field | Type | Notes |
| --- | --- | --- |
| Text | text | required |
| Size | select | options: Large, Medium, Small |
| Alignment | select | options: Left, Centred |

## 📝 Text

`text` — A paragraph. Use **bold**, *italic* and [links](https://example.com). Blank line = new paragraph.

| Field | Type | Notes |
| --- | --- | --- |
| Text | textarea | required |
| Alignment | select | options: Left, Centred |

## 🖼️ Image

`image` — A picture: upload one from your computer, or paste an https link.

| Field | Type | Notes |
| --- | --- | --- |
| Image | image | required; a picture you uploaded, or a full https link |
| Description (for screen readers) | text |  |
| Caption | text |  |
| Make it a link (optional) | text |  |
| Size | select | options: Full width, Medium, Small |

## 🔘 Button

`button` — A button that links to another page, e.g. your Discord invite.

| Field | Type | Notes |
| --- | --- | --- |
| Label | text | required |
| Link | text | required |
| Style | select | options: Filled, Outline |
| Alignment | select | options: Left, Centred |

## 📋 List

`list` — A bulleted, numbered or checklist.

| Field | Type | Notes |
| --- | --- | --- |
| Items (one per line) | textarea | required |
| Style | select | options: Bullets, Numbers, Checks |

## ➖ Divider

`divider` — A thin line between sections.

## ↕️ Spacer

`spacer` — Empty space.

| Field | Type | Notes |
| --- | --- | --- |
| Size | select | options: Small, Medium, Large |

## 🧾 Form

`form` — Collect answers from people who log in with Discord. A “Form Submitted” flow can react to each response.

| Field | Type | Notes |
| --- | --- | --- |
| Form title | text | required |
| Introduction | textarea |  |
| Questions | list |  |
| ↳ ID (the answer is {{form.ID}} in flows) | text | required |
| ↳ Question | text | required |
| ↳ Answer type | select | options: Short answer, Long answer, Number, Dropdown, Pick one (radio buttons), Pick many (checkboxes), Single tick box (“I agree”), Date |
| ↳ Required | boolean |  |
| ↳ Placeholder | text | shown when `type` is `short` / `long` / `number` |
| ↳ Options (one per line) | textarea | required; shown when `type` is `select` / `radio` / `checkboxes` |
| ↳ Minimum (length, or value for numbers) | number | shown when `type` is `short` / `long` / `number` |
| ↳ Maximum (length, or value for numbers) | number | shown when `type` is `short` / `long` / `number` |
| ↳ Help text | text |  |
| Button label | text |  |
| Only members of this server can submit | boolean | Checked live through the bot. Turn off for public applications. |
| One response per person | boolean |  |
| Wait between responses (minutes) | number | range 0–…; Blank or 0 = no wait. |
| Save responses in the dashboard | boolean | Turn off if you only want the flow to react. If “one response per person” or a wait is on, a receipt (who and when — no answers) is still kept so those rules work. |
| After submitting | select | options: Show a thank-you message, Go to another web address |
| Thank-you message | textarea | shown when `onSuccess` is `message` |
| Go to (link) | text | required; shown when `onSuccess` is `redirect` |

