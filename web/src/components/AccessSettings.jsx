import FieldEditor from './FieldEditor.jsx';

const CHOICES = [
  ['public', 'Anyone with the link'],
  ['members', 'Members of this server'],
  ['roles', 'Members with one of these roles'],
];

/** Who can open the page. Unlike the content, this applies as soon as the page is saved (no Publish needed). */
export default function AccessSettings({ access, roleIds, roles, onChange }) {
  const known = new Set(roles.map((r) => r.id));
  const options = [
    ...roles.map((r) => ({ value: r.id, label: r.name })),
    ...roleIds.filter((id) => !known.has(id)).map((id) => ({ value: id, label: 'Deleted role' })), // still shown, so it can be un-ticked
  ];
  return (
    <fieldset className="access">
      <legend className="visually-hidden">Who can open this page</legend>
      {CHOICES.map(([value, label]) => (
        <label key={value} className="access-choice">
          <input type="radio" name="page-access" checked={access === value} onChange={() => onChange({ access: value })} />
          <span>{label}</span>
        </label>
      ))}
      {access === 'roles' && (
        <FieldEditor
          field={{ type: 'multiselect', key: 'roleIds', label: 'Roles', options }}
          value={roleIds} onChange={(v) => onChange({ roleIds: v })}
        />
      )}
      {access === 'roles' && roleIds.length === 0 && <p className="help bad-help">Choose at least one role, or nobody can open this page.</p>}
      {access !== 'public' && (
        <>
          <p className="help">Applies as soon as you save — no need to publish. Visitors log in with Discord; a new role can take up to a minute to count.</p>
          <p className="help warn-help">Pictures on this page can still be opened by their direct link.</p>
        </>
      )}
    </fieldset>
  );
}
