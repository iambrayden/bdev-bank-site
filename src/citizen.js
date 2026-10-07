// Turns the raw linked-table rows for one citizen into short, readable summaries.
const { parseJson } = require('./audit');

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const isShort = (v) => {
  if (v === null || v === undefined) return true;
  const s = Buffer.isBuffer(v) ? v.toString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return s.length <= 32 && !/^[[{]/.test(s.trim());
};

function summarize(cid, sections) {
  const out = { houses: [], listings: [], vehicles: [], bills: null, records: [], errors: [] };
  for (const sec of sections) {
    if (sec.error) {
      out.errors.push(`${sec.table.name}: ${sec.error}`);
      continue;
    }
    const c = sec.cols;
    const role = sec.table.role;
    if (role === 'player_houses') {
      for (const r of sec.rows) {
        const owns = (c.owner && r[c.owner] === cid) || (c.citizenid && r[c.citizenid] === cid);
        const keys = parseJson(c.keyholders ? r[c.keyholders] : null, []);
        out.houses.push({
          house: c.house ? r[c.house] : '',
          label: r.house_label || '',
          price: r.house_price,
          relation: owns ? 'Owner' : 'Key holder',
          keyCount: Array.isArray(keys) ? keys.length : 0,
        });
      }
    } else if (role === 'house_locations') {
      for (const r of sec.rows) out.listings.push({ name: c.name ? r[c.name] : '', label: c.label ? r[c.label] : '', price: c.price ? r[c.price] : null });
    } else if (role === 'player_vehicles') {
      for (const r of sec.rows) {
        const garage = (c.garage && r[c.garage]) || (c.garageFallback && r[c.garageFallback]) || '';
        out.vehicles.push({
          model: c.vehicle ? r[c.vehicle] : '',
          plate: c.plate ? r[c.plate] : '',
          garage,
          financed: c.financed ? r[c.financed] : null,
          mileage: c.mileage ? r[c.mileage] : null,
          isFinanced: c.financed ? num(r[c.financed]) === 1 : false,
          balance: c.balance ? r[c.balance] : null,
          paymentAmount: c.paymentAmount ? r[c.paymentAmount] : null,
          paymentsLeft: c.paymentsLeft ? r[c.paymentsLeft] : null,
          financeTime: c.financeTime ? r[c.financeTime] : null,
        });
      }
    } else if (role === 'house_bills') {
      const rows = sec.rows;
      const paid = (r) => (c.paid ? !!num(r[c.paid]) : true);
      const total = (r) => (c.total ? num(r[c.total]) : 0);
      const unpaid = rows.filter((r) => !paid(r));
      const recent = [...rows].sort((a, b) => String(c.date ? b[c.date] : '').localeCompare(String(c.date ? a[c.date] : ''))).slice(0, 8);
      out.bills = {
        count: rows.length,
        capped: rows.length >= 500,
        total: rows.reduce((a, r) => a + total(r), 0),
        unpaid: unpaid.reduce((a, r) => a + total(r), 0),
        unpaidCount: unpaid.length,
        recent: recent.map((r) => ({ house: c.house ? r[c.house] : '', total: total(r), paid: paid(r), date: c.date ? r[c.date] : '' })),
        byHouse: rows.reduce((m, r) => {
          const h = String(c.house ? r[c.house] : '');
          const e = m[h] || (m[h] = { billed: 0, unpaid: 0, unpaidCount: 0 });
          e.billed += total(r);
          if (!paid(r)) (e.unpaid += total(r)), e.unpaidCount++;
          return m;
        }, {}),
      };
    } else if (role === 'player_groups') {
      // already shown in the profile
    } else if (sec.rows.length) {
      // Generic tables: keep only short, non-JSON columns so the table stays readable.
      const cols = sec.columns.filter((col) => sec.rows.every((r) => isShort(r[col]))).slice(0, 8);
      out.records.push({ table: sec.table, columns: cols, hidden: sec.columns.length - cols.length, rows: sec.rows, allColumns: sec.columns, cols: c });
    }
  }
  return out;
}

module.exports = { summarize };
