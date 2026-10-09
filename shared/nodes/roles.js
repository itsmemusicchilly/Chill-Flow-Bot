// Roles: create, change and delete the server's roles themselves.
import { bool, color, idField, multi, select, text } from '../fields.js';
import { ACTION_OUTS, def, reasonField, ROLE_PERMISSIONS } from './core.js';

// ---- roles --------------------------------------------------------------------------------------
def('action.role.create', {
  category: 'role', label: 'Create Role', icon: '➕', description: 'Create a new role.',
  fields: [
    text('name', 'Name', { required: true }), color('color', 'Color', { default: '#99aab5' }),
    bool('hoist', 'Show separately in the member list'), bool('mentionable', 'Anyone can @mention it'),
    multi('permissions', 'Permissions', ROLE_PERMISSIONS),
    text('outputVar', 'Save role ID as variable', { placeholder: 'role', pattern: 'var' }),
  ],
  outputs: ACTION_OUTS, summary: (d) => d.name || '',
});
def('action.role.delete', {
  category: 'role', label: 'Delete Role', icon: '🗑️', description: 'Delete a role.',
  fields: [idField('roleId', 'Role', 'role', { required: true }), reasonField()], outputs: ACTION_OUTS, summary: (d) => d.roleId || '',
});
def('action.role.update', {
  category: 'role', label: 'Update Role', icon: '🛠️', description: 'Rename or recolor a role. Blank fields stay unchanged.',
  fields: [
    idField('roleId', 'Role', 'role', { required: true }), text('name', 'New name'),
    text('color', 'New color', { placeholder: '#ff0000' }),
    select('hoist', 'Show separately', [['', 'Unchanged'], ['yes', 'Yes'], ['no', 'No']]),
    select('mentionable', 'Mentionable', [['', 'Unchanged'], ['yes', 'Yes'], ['no', 'No']]),
  ],
  outputs: ACTION_OUTS, summary: (d) => d.roleId || '',
  check: (d) => (d.color && !/^#[0-9a-fA-F]{6}$/.test(d.color) && !/\{\{/.test(d.color) ? ['Color must look like #ff8800.'] : []),
});
