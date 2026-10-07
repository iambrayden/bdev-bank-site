// Table "roles" tell the auditor how to interpret a table. Each role has a set of
// logical columns with default physical column names (Qbox / Renewed-Banking
// defaults). Any of them can be overridden per table in Settings.

const ROLES = {
  players: {
    label: 'Players (core)',
    description: 'One row per character. Holds money JSON (cash/bank/crypto) and charinfo.',
    single: true,
    columns: {
      citizenid: 'citizenid',
      license: 'license',
      name: 'name',
      money: 'money',
      charinfo: 'charinfo',
      job: 'job',
      gang: 'gang',
      lastUpdated: 'last_updated',
    },
  },
  player_transactions: {
    label: 'Personal transactions',
    description: 'Renewed-Banking personal account history. id = citizenid, transactions = JSON array.',
    single: true,
    columns: { citizenid: 'id', transactions: 'transactions', frozen: 'isFrozen' },
  },
  bank_accounts: {
    label: 'Shared / society bank accounts',
    description: 'Renewed-Banking job & shared accounts with balance, history, auth list.',
    single: true,
    columns: {
      id: 'id',
      amount: 'amount',
      transactions: 'transactions',
      auth: 'auth',
      frozen: 'isFrozen',
      creator: 'creator',
    },
  },
  house_bills: {
    label: 'House bills',
    description: 'Utility bills per house, linked to the character who paid / owes.',
    columns: {
      id: 'id',
      house: 'house',
      citizenid: 'payed_by',
      total: 'total',
      breakdown: 'breakdown',
      paid: 'payed',
      date: 'date',
    },
  },
  house_locations: {
    label: 'House locations',
    description: 'All houses with price / tier / creator.',
    columns: { name: 'name', label: 'label', price: 'price', owned: 'owned', tier: 'tier', creator: 'creator' },
  },
  player_houses: {
    label: 'Player houses',
    description: 'Owned houses with owner citizenid and keyholders JSON.',
    columns: { id: 'id', house: 'house', citizenid: 'citizenid', owner: 'owner', keyholders: 'keyholders' },
  },
  player_vehicles: {
    label: 'Player vehicles',
    description: 'Owned vehicles.',
    columns: {
      id: 'id',
      citizenid: 'citizenid',
      license: 'license',
      vehicle: 'vehicle',
      plate: 'plate',
      garage: 'garage',
      state: 'state',
      fuel: 'fuel',
      engine: 'engine',
      body: 'body',
    },
  },
  player_groups: {
    label: 'Player groups (jobs/gangs)',
    description: 'Qbox multi-job table: citizenid, group, type, grade.',
    columns: { citizenid: 'citizenid', group: 'group', type: 'type', grade: 'grade' },
  },
  job_activity: {
    label: 'Job activity',
    description: 'Who was on duty / held which job. Shown on the character page.',
    columns: { citizenid: 'citizenid' },
  },
  generic: {
    label: 'Generic (linked by citizenid)',
    description: 'Any other table. If the citizenid column exists, rows show on the character page.',
    columns: { citizenid: 'citizenid' },
  },
};

// The players table is the core: every other table links to it by citizenid.
const DEFAULT_CORE = { name: 'players', role: 'players' };

const DEFAULT_TABLES = [
  { name: 'player_transactions', role: 'player_transactions' },
  { name: 'bank_accounts_new', role: 'bank_accounts' },
  { name: 'house_bills', role: 'house_bills' },
  { name: 'houselocations', role: 'house_locations' },
  { name: 'player_houses', role: 'player_houses' },
  { name: 'player_jobs_activity', role: 'job_activity' },
  { name: 'player_vehicles', role: 'player_vehicles' },
  { name: 'player_groups', role: 'player_groups' },
];

module.exports = { ROLES, DEFAULT_TABLES, DEFAULT_CORE };
