# Bank Audit for FiveM / Qbox

A read-only web dashboard for auditing the economy of a FiveM Qbox server
(Renewed-Banking tables). You give it your database credentials and a list of
tables, and it shows every character's money, transactions, shared accounts,
houses, bills, vehicles and jobs, and flags suspicious activity.

## How the data fits together

The **`players` table is the core**. It lists every character: citizenid,
name (`charinfo`), money (`cash` / `bank` / `crypto`), job and license. Every
other table is linked to it by **citizenid**:

| Table | Role | Linked by |
| --- | --- | --- |
| `players` | **Core** | `citizenid` |
| `player_transactions` | Personal transaction history (JSON) | `id` = citizenid |
| `bank_accounts_new` | Shared / society accounts | `auth` JSON, `creator` |
| `house_bills` | House utility bills | `payed_by` |
| `houselocations` | All houses | `creator` |
| `player_houses` | Owned houses | `citizenid`, `owner`, `keyholders` JSON |
| `player_jobs_activity` | Job activity | `citizenid` |
| `player_vehicles` | Vehicles | `citizenid` |
| `player_groups` | Jobs / gangs (multi-job) | `citizenid` |

You can add any other table in **Settings** with the *Generic* role; if it has
a `citizenid` column its rows show up on each character's page. Column names
can be overridden per table if your schema differs.

## Pages

- **Overview** – total money in the economy, richest characters, 14-day
  deposit / withdrawal flow, money by job, high-severity flags.
- **Characters** – searchable, sortable list of every character from the
  players table, with CSV export.
- **Character page** – balances, job and groups, other characters on the same
  license, shared accounts they can use, counterparties they send to or
  receive from, full transaction history, and every linked row (houses,
  bills, vehicles, jobs).
- **Shared accounts** – society / shared accounts with balances, authorised
  characters, job members and history.
- **Transactions** – search every transaction by name, citizenid, amount,
  type, date range or transaction id, with CSV export.
- **Audit flags** – see below.
- **Tables** – browse and export any configured table.
- **Settings** – database connection, tables and roles, audit thresholds.

## Audit flags

| Flag | Meaning |
| --- | --- |
| `LARGE_TX` | One transaction at or above the large-transaction threshold. |
| `HIGH_BALANCE` / `HIGH_ACCOUNT_BALANCE` | A character or shared account above its threshold. |
| `NEGATIVE_BALANCE` | Negative cash, bank, crypto or account balance. |
| `BURST` | Many transactions on one account in a few minutes (exploit or script spam). |
| `ALT_TRANSFER` | Money sent between two characters on the **same FiveM license**. |
| `REPEATED_TRANSFERS` | Repeated transfers to the same person within N days. |
| `TRANS_ID_MISMATCH` / `TRANS_ID_DUPLICATE` | The same transaction id recorded with different amounts, or more than twice. |
| `ORPHAN_RECORDS` / `ORPHAN_AUTH` | Vehicles, houses, bills, history or account access for a citizenid that isn't in `players`. |
| `FROZEN` | Frozen accounts (informational). |

You can change the thresholds in Settings.

## Deploy on Coolify

1. **Create a read-only MySQL user** on the game database:
   ```sql
   CREATE USER 'bank_audit'@'%' IDENTIFIED BY 'a-long-random-password';
   GRANT SELECT ON s1_lcrpdatabase.* TO 'bank_audit'@'%';
   ```
   The app only sends `SELECT` queries and sets every session to
   `READ ONLY`. A SELECT-only user adds a third layer of protection.
   **Settings → Test connection** warns you if the user can write.
2. In Coolify, go to **New Resource → Public/Private Repository**, pick this
   repo, and choose the **Dockerfile** build pack (or **Docker Compose**
   with `docker-compose.yml`). The port is **3000**.
3. Set the environment variables (see `.env.example`):
   - `APP_PASSWORD` (required) – password for the web UI
   - `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
   - optional: `PLAYERS_TABLE`, `AUDIT_TABLES`, `TZ_DISPLAY`, `SESSION_SECRET`
4. Add a **persistent storage** volume mounted at `/data`, so settings you
   change in the UI survive redeploys. The compose file sets this up for you.
5. Assign a domain and deploy.

If the game database runs on another machine, allow the Coolify server's IP in
the MySQL host's firewall, and restrict that user to the IP
(`'bank_audit'@'1.2.3.4'`).

## Local development

```bash
npm install
# optional: a fictional demo database
node scripts/demo-seed.js | mysql
APP_PASSWORD=dev DB_USER=... DB_PASSWORD=... DB_NAME=qbox_demo npm run dev
npm test
```

## Notes

- Data is cached for 30 seconds (`CACHE_SECONDS`). Click **refresh** in the
  footer to reload it.
- Transaction history only goes back as far as Renewed-Banking keeps it, so
  the "history in / out" totals won't always match current balances.
- Transfers are matched to characters by the character name in
  `issuer` / `receiver`. When two characters share a name, the match is skipped.
