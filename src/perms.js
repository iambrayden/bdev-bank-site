// Permission catalog. Roles grant a set of these; users can additionally have
// per-user allow / deny overrides. Superadmins implicitly have everything.

const PERMISSIONS = [
  {
    group: 'Economy data',
    items: [
      ['dashboard.view', 'View the overview dashboard'],
      ['players.view', 'View the character list and character pages'],
      ['money.view', 'See balances and transaction amounts (otherwise masked)'],
      ['players.identity', 'See license, FiveM name and other characters on the same license'],
      ['players.personal', 'See phone number and birthdate'],
      ['players.linked', 'See linked records on character pages (houses, bills, vehicles, jobs…)'],
      ['transactions.view', 'View and search transactions'],
      ['accounts.view', 'View shared / society accounts'],
      ['audit.view', 'View audit flags'],
      ['tables.browse', 'Browse raw tables — shows every column, including money (limited to the role’s allowed tables)'],
      ['export.csv', 'Export CSV files'],
      ['data.refresh', 'Force a data refresh from the database'],
    ],
  },
  {
    group: 'Cases',
    items: [
      ['cases.view', 'View cases they created, are assigned to or collaborate on'],
      ['cases.view_all', 'View every case'],
      ['cases.create', 'Create cases'],
      ['cases.edit', 'Edit cases they can view (title, summary, subjects, evidence)'],
      ['cases.comment', 'Add notes to cases they can view'],
      ['cases.status', 'Change case status and priority'],
      ['cases.assign', 'Assign cases and manage collaborators'],
      ['cases.delete', 'Delete cases and remove evidence / notes by others'],
    ],
  },
  {
    group: 'Administration',
    items: [
      ['admin.settings', 'Manage database connection, tables and thresholds'],
      ['admin.users', 'Manage users (create, edit, disable, reset passwords)'],
      ['admin.roles', 'Manage roles and their permissions'],
      ['admin.activity', 'View the activity log'],
    ],
  },
];

const ALL = PERMISSIONS.flatMap((g) => g.items.map(([k]) => k));
const LABELS = Object.fromEntries(PERMISSIONS.flatMap((g) => g.items));

const DEFAULT_ROLES = [
  { name: 'Administrator', description: 'Full access to everything.', permissions: ALL, tables: ['*'] },
  {
    name: 'Investigator',
    description: 'Full read access and case management.',
    permissions: ALL.filter((p) => !p.startsWith('admin.') && p !== 'cases.delete'),
    tables: ['*'],
  },
  {
    name: 'Viewer',
    description: 'Read-only economy access. Can view cases shared with them.',
    permissions: ['dashboard.view', 'players.view', 'money.view', 'transactions.view', 'accounts.view', 'audit.view', 'cases.view', 'cases.comment'],
    tables: [],
  },
];

// Effective permission set for a user record (with role + overrides joined in).
function effective(user) {
  if (!user) return new Set();
  if (user.is_superadmin) return new Set(ALL);
  const set = new Set((user.role_permissions || []).filter((p) => ALL.includes(p)));
  for (const p of user.allow || []) set.add(p);
  for (const p of user.deny || []) set.delete(p);
  return set;
}

module.exports = { PERMISSIONS, ALL, LABELS, DEFAULT_ROLES, effective };
