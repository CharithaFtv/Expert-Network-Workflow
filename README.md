# Expert Network Workflow

Internal FTV Capital app for running expert network projects across deal teams,
compliance and the expert network vendors.

## Status

Built: the **Project Initiation Form** (`/projects/new`) and **outbound email**.

- Requester is the signed-in user (name, title, team from the DealCloud user directory).
- Every project must link to one DealCloud deal whose status is **Active** or **Lead**,
  enforced on the server at submit time. Deal stage is stored but not shown.
- Team members are tagged by name; each gets an in-app notification, an email and project
  access. Linking a deal pre-tags its DealCloud deal team.
- **Submitting the form is the send trigger.** After the request is saved, the app delivers that
  project's queued mail from the shared mailbox through Microsoft Graph (`sendMail`). A send
  failure never fails the request: unsent mail stays `Queued` and can be retried with
  `npm run send-outbox`. Nothing is sent unless `MAIL_MODE=graph`.
- Vendor briefs carry the project code in the subject, `[EN-2026-0001] Title`, so replies can be
  matched later. They never include the DealCloud deal name.
- Only vendors with an intake address are offered on the form. Manage them with
  `npm run vendors -- list | add "Name" email | set-email "Name" email|none`.
- Each project shows per-vendor status: Pending send, Sent, Send failed or Send blocked.

### Testing safety
While testing, real mail may only go to the addresses in `MAIL_ALLOWED_RECIPIENTS`
(`charitha@` and `adas@`, who act as both vendors and deal team). Any other recipient is marked
`Blocked` and never sent, so a test cannot reach an external vendor. Real sending outside
production refuses to start without an allowlist (or `MAIL_DEV_RECIPIENT`).

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

- **Sign-in:** Microsoft Entra single sign-on is built (`AUTH_MODE=entra`) but not enabled: it
  needs the redirect URI registered in the Entra app. Until then `AUTH_MODE=dev` shows a name
  picker, which is refused in production.
- **DealCloud** is a snapshot, so deal status can go stale. Replace `load()` in
  `src/lib/dealcloud.ts` with a live Snowflake query.
- **Vendors:** the five real networks have no intake addresses yet, so they are not offered.
  Add addresses with `npm run vendors`; remove the allowlist only for production.
- **Replies are not read yet.** Inbound mail, parsing and the review screens are the next steps.
- **Hosting:** Postgres is local. Azure provisioning and Entra-based database auth are still to do.
