# SAFIN — San Andreas Financial Intelligence Network

Warrant-gated financial records access for FiveM / Qbox servers. The login page shows a government-style "authorized use only" notice, and a
restricted-access banner sits on every page.

A read-only web dashboard for auditing the economy of a FiveM Qbox server
(Renewed-Banking tables). You give it your database credentials and a list of
tables, and it shows every citizen's money, transactions, shared accounts,
houses, bills, vehicles and jobs, and flags suspicious activity.

## How the data fits together

The **`players` table is the core**. It lists every citizen: citizenid,
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
a `citizenid` column its rows show up on each citizen's page. Column names
can be overridden per table if your schema differs.

## Pages

- **Overview** – total money in the economy, richest citizens, 14-day
  deposit / withdrawal flow, money by job, high-severity flags.
- **Citizens** – searchable, sortable list of every citizen from the
  players table, with CSV export.
- **Citizen page** – balances, job and groups, other citizens on the same
  license, shared accounts they can use, counterparties they send to or
  receive from, full transaction history, and every linked row (houses,
  bills, vehicles, jobs).
- **Shared accounts** – society / shared accounts with balances, authorised
  citizens, job members and history.
- **Transactions** – search every transaction by name, citizenid, amount,
  type, date range or transaction id, with CSV export.
- **Audit flags** – see below.
- **Cases** – case files for investigations (see below).
- **Tables** – browse and export any configured table.
- **Admin** – users, roles & permissions, activity log, data settings.

## Users, roles and permissions

Everyone signs in with their own username and password. On first start the app
creates a **superadmin** from `ADMIN_USERNAME` / `ADMIN_PASSWORD`; after that,
manage accounts in **Admin → Users**.

- **Roles** bundle permissions. Three are created to start with —
  *Administrator*, *Investigator* and *Viewer* — and you can edit them or add
  your own in **Admin → Roles & permissions**.
- **Per-user overrides**: each permission can be set to *from role*, *allow*
  or *deny* for an individual user.
- **Table access** per role: which tables can be browsed raw and shown as
  linked records on citizen pages.
- **Superadmins** have every permission and are the only ones who can manage
  other superadmins. Admins who aren't superadmins can never grant a
  permission they don't hold themselves.
- Disabling a user, resetting their password or "sign out everywhere"
  ends their sessions immediately. New users can be forced to change their
  password at first login.

| Area | Permissions |
| --- | --- |
| Economy data | `dashboard.view`, `players.view`, `money.view` (otherwise every balance and amount is masked), `players.identity` (license, FiveM name, alts), `players.personal` (phone, birthdate), `players.linked` (houses, bills, vehicles, jobs), `transactions.view`, `accounts.view`, `audit.view`, `tables.browse`, `export.csv`, `data.refresh` |
| Cases | `cases.view` (own / assigned / shared), `cases.view_all`, `cases.create`, `cases.edit`, `cases.comment`, `cases.status`, `cases.assign`, `cases.delete` |
| Administration | `admin.settings`, `admin.users`, `admin.roles`, `admin.activity` |

**Activity log** (Admin → Activity log) records sign-ins and failed sign-ins,
every citizen / account / table viewed, every export, every case change and
every admin action, with user and IP.

## Cases

Case files collect everything about an investigation in one place:

- **“+ case”** links on every transaction and audit flag, and **Add to
  case** buttons on citizen and shared-account pages, add the item to an
  existing case or start a new one. The citizens on either side of a
  transaction can be added in the same step.
- Evidence is **snapshotted** when added (amounts, both sides of a transfer,
  balances), so it survives Renewed-Banking rotating its history or a
  citizen being deleted. Citizen entries show balance *when added* next
  to the balance *now*.
- Add free-text notes and links (clips, screenshots, logs) as evidence, with
  an investigator note on each item.
- Status (open → investigating → pending review → closed), priority,
  assignee and collaborators. Collaborators can see a case even without
  `cases.view_all`.
- A notes timeline with automatic entries for status and assignment changes.
- **Print report** (print or save as PDF) and **Evidence CSV**.

## Audit flags

| Flag | Meaning |
| --- | --- |
| `LARGE_TX` | One transaction at or above the large-transaction threshold. |
| `HIGH_BALANCE` / `HIGH_ACCOUNT_BALANCE` | A citizen or shared account above its threshold. |
| `NEGATIVE_BALANCE` | Negative cash, bank, crypto or account balance. |
| `BURST` | Many transactions on one account in a few minutes (exploit or script spam). |
| `ALT_TRANSFER` | Money sent between two citizens on the **same FiveM license**. |
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
   - `ADMIN_USERNAME`, `ADMIN_PASSWORD` – the first superadmin (used only
     when no users exist yet)
   - `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
   - optional: `PLAYERS_TABLE`, `AUDIT_TABLES`, `TZ_DISPLAY`, `SESSION_HOURS`,
     `APP_NAME` / `APP_TAGLINE` (branding; defaults to SAFIN), `BANNER_TEXT`
     (the red bar at the top of every page; set it empty to hide it)
4. Add a **persistent storage** volume mounted at `/data`. **Required**: it
   holds users, cases and the activity log (`app.db`) as well as settings
   (`config.json`). Without it, all of that is lost on redeploy. The compose
   file sets this up for you. Back up `/data` regularly.
5. Assign a domain and deploy.

If the game database runs on another machine, allow the Coolify server's IP in
the MySQL host's firewall, and restrict that user to the IP
(`'bank_audit'@'1.2.3.4'`).

## Local development

```bash
npm install
# optional: a fictional demo database
node scripts/demo-seed.js | mysql
ADMIN_PASSWORD=devpassword1 DB_USER=... DB_PASSWORD=... DB_NAME=qbox_demo npm run dev
npm test
```

## Notes

- Data is cached for 30 seconds (`CACHE_SECONDS`). Click **refresh** in the
  footer to reload it.
- Transaction history only goes back as far as Renewed-Banking keeps it, so
  the "history in / out" totals won't always match current balances.
- Transfers are matched to citizens by the citizen name in
  `issuer` / `receiver`. When two citizens share a name, the match is skipped.
