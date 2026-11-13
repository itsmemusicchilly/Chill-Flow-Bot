import { embedsOf } from '@shared/embeds.js';
import { uploadIdOf, uploadPath } from '@shared/urls.js';
import { useImages } from '../context.js';

// A small picture of the message a Send Message or Edit Message node will send, next to its settings: the text, every embed with its
// parts, the buttons and the menu. Variables stay as written — they are only filled in when the flow runs — and nothing here is HTML:
// the little bit of Discord's formatting that is shown (bold, italic, underline, strike-through, code, links) is built from text.
const PARTS = /(\{\{[^{}]+\}\}|\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/;
const WRAPPED = [['**', 'strong'], ['__', 'u'], ['~~', 's'], ['*', 'em']];

function rich(text, depth = 0) {
  return String(text ?? '').split(PARTS).map((part, i) => {
    if (!part) return null;
    if (part.startsWith('{{') && part.endsWith('}}')) return <span key={i} className="mp-var">{part}</span>;
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) return <code key={i}>{part.slice(1, -1)}</code>;
    const link = /^\[([^\]\n]+)\]\(https?:\/\/[^\s)]+\)$/.exec(part);
    if (link) return <span key={i} className="mp-link">{link[1]}</span>;
    for (const [mark, Tag] of WRAPPED) {
      if (part.length > mark.length * 2 && part.startsWith(mark) && part.endsWith(mark)) {
        const inner = part.slice(mark.length, -mark.length);
        return <Tag key={i}>{depth < 3 ? rich(inner, depth + 1) : inner}</Tag>;
      }
    }
    return part;
  });
}

/** A picture field: an uploaded picture or an https link is shown; a variable (or anything else) is a labelled box, since only the run knows it. */
function Pic({ value, className }) {
  const { gid } = useImages();
  const v = String(value ?? '').trim();
  if (!v) return null;
  const id = uploadIdOf(v);
  const src = id && gid ? uploadPath(gid, id) : /^https:\/\/\S+$/i.test(v) && !v.includes('{{') ? v : null;
  if (src) return <img className={className} src={src} alt="" loading="lazy" />;
  return <span className={`${className} mp-pic-box`} title={v}>{v.includes('{{') ? v : 'picture'}</span>;
}

function Embed({ e }) {
  const color = /^#?[0-9a-f]{6}$/i.test(String(e.color ?? '').trim()) ? `#${String(e.color).trim().replace('#', '')}` : 'var(--line)';
  const fields = (e.fields || []).filter((f) => f && (f.name || f.value));
  return (
    <div className="mp-embed" style={{ '--edge': color }}>
      <div className="mp-e-main">
        {e.authorName && <div className="mp-e-author"><Pic value={e.authorIcon} className="mp-e-icon" />{rich(e.authorName)}</div>}
        {e.title && <div className={`mp-e-title ${e.url ? 'mp-link' : ''}`}>{rich(e.title)}</div>}
        {e.description && <div className="mp-e-desc">{rich(e.description)}</div>}
        {fields.length > 0 && (
          <div className="mp-e-fields">
            {fields.map((f, i) => <div key={i} className={f.inline ? 'inline' : ''}><b>{rich(f.name)}</b><div>{rich(f.value)}</div></div>)}
          </div>
        )}
        <Pic value={e.image} className="mp-e-image" />
        {(e.footer || e.timestamp) && (
          <div className="mp-e-footer"><Pic value={e.footer ? e.footerIcon : ''} className="mp-e-icon" />{rich(e.footer)}{e.footer && e.timestamp ? ' • ' : ''}{e.timestamp ? 'Today at 12:00' : ''}</div>
        )}
      </div>
      <Pic value={e.thumbnail} className="mp-e-thumb" />
    </div>
  );
}

export default function MessagePreview({ data, node }) {
  const editing = node?.type === 'action.message.edit';
  const showText = !editing || data.contentMode === 'replace';
  const showEmbeds = !editing || data.embedsMode === 'replace';
  const content = showText ? String(data.content ?? '') : '';
  const embeds = showEmbeds ? embedsOf(data) : [];
  const buttons = editing ? [] : (data.buttons || []);
  const menu = !editing && data.menuEnabled;
  const empty = !content && !embeds.length && !buttons.length && !menu;
  if (editing && !showText && !showEmbeds) return null;
  return (
    <div className="field message-preview">
      <label>Preview <span className="tiny muted">{editing ? '(only what you replace)' : '(variables are filled in when the flow runs)'}</span></label>
      <div className="mp" role="img" aria-label="How the message will look in Discord">
        <div className="mp-head"><span className="mp-avatar" aria-hidden="true">🤖</span><b>Your bot</b><span className="mp-app">APP</span></div>
        {content && <div className="mp-content">{rich(content)}</div>}
        {embeds.map((e, i) => <Embed key={e.id ?? i} e={e} />)}
        {buttons.length > 0 && (
          <div className="mp-buttons">
            {buttons.map((b, i) => <span key={b.id ?? i} className={`mp-btn ${String(b.style || 'Primary').toLowerCase()} ${b.disabled ? 'off' : ''}`}>{b.emoji ? `${b.emoji} ` : ''}{b.label || 'Button'}{b.style === 'Link' ? ' ↗' : ''}</span>)}
          </div>
        )}
        {menu && <div className="mp-menu">{data.menuPlaceholder || 'Choose…'}<span aria-hidden="true">▾</span></div>}
        {empty && <div className="tiny muted">Nothing to show yet: add text, an embed or a button.</div>}
      </div>
    </div>
  );
}
