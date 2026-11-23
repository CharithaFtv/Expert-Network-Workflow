# Expert Network Workflow

Internal FTV Capital app for running expert network projects across deal teams,
compliance and the expert network vendors.

## Status

Step 1 is built: the **Project Initiation Form** (`/projects/new`).

- Requester is the signed-in user (name, title, team from the DealCloud user directory).
- Every project must link to one DealCloud deal whose status is **Active** or **Lead**.
  The rule is enforced on the server at submit time, not only in the picker.
- Team members are tagged by name; each gets an in-app notification and project access.
  Linking a deal pre-tags its DealCloud deal team.
- Submitting queues the request for the chosen expert network. Nothing is emailed yet;
  queued messages sit in the `outbox` table.
- The message to the network never includes the DealCloud deal name.

## Run

```
npm install
cp .env.example .env.local   # DATABASE_URL -> local Postgres
npm run migrate              # apply migrations/*.sql
npm run dev                  # http://localhost:3000
npm test                     # needs the enw_test database (see below)
```

Requires Node 24 and a local PostgreSQL 16 (Postgres.app works). One-time:
`createdb enw_dev && createdb enw_test`. Tests refuse to run against any database whose
URL does not contain `enw_test`.

## Data

| Path | Contents | Committed |
|---|---|---|
| `data/dealcloud/deals.csv` | Active and Lead deals from `PROD.SILVER.DIM_DEAL` | No |
| `data/dealcloud/users.csv` | Active users from `PROD.SILVER.DIM_USER` | No |
| Postgres `enw_dev` | App database (projects, members, notifications, outbox) | n/a |

`data/` is git-ignored because it holds firm data. The two CSVs are a point-in-time
snapshot; the exact SQL is in `src/lib/dealcloud.ts`. The files have a blank header
line and are read by column position.

## Not production-ready yet

- **Sign-in** is a development user picker (`src/lib/session.ts`). Replace with
  Microsoft Entra SSO before sharing.
- **DealCloud** is a snapshot, so deal status can go stale. Replace `load()` in
  `src/lib/dealcloud.ts` with a live Snowflake query.
- **Delivery**: team emails and network briefs are queued, not sent. Needs Microsoft
  Graph mail and confirmed intake addresses per network (`vendors.intake_email`).
- **Database** is Postgres (schema in `migrations/`). Azure provisioning and Entra-based DB auth still to do.
