# Designer Task Scheduler

Daily task assignment + capacity tracking for a design team. Sub-app of `operation.yotser.in`.

**Live at:** `https://operation.yotser.in/designer-tasks/`

---

## TL;DR (read this first if you're a new collaborator or new Claude session)

This is a Node/Express + PostgreSQL app that:

1. Pulls design-tagged tasks from **Zoho Projects** every 5 minutes via a background cron
2. Lets one or more **assigners** stage those tasks (plus ad-hoc internal tasks they add manually) and allocate them to specific **designers** with hours-per-day budgets
3. Visualizes **capacity** (Today / Week / Kanban views), surfaces **aged work** in yellow and **overload** in red, and computes per-designer **efficiency** daily and monthly
4. Gives each designer a **personal read-only mobile URL** (PIN-gated) showing only their queue

The app is a single-page UI for the assigner team (2–5 people, shared password) plus a separate mobile page for designers (no login, just PIN).

**Architecturally**, this is NOT a standalone app with its own PM2 process. It exports an Express **Router** that gets `require()`d and mounted at `/designer-tasks/` inside the existing `5s-tracker` Node process on the VPS (PM2 process name `5s-tracker`, port 3010). All the other apps on `operation.yotser.in/` (5S Tracker, Production Tracker, Installation Scheduler, etc.) follow this same sub-app pattern — see `OPERATIONS_PORTAL_NEW_APP_GUIDE` in the parent folder for the full convention.

**Status:** end-to-end functional. Every promised feature is shipped. Zoho sync filters out closed/completed tasks at import time. The 5-min cron runs in the background. Currently 11 open Designing-tagged tasks in the Pool.

---

## Where things live

| Resource | Location |
|---|---|
| **Live URL (assigner)** | `https://operation.yotser.in/designer-tasks/` |
| **Live URL (designer)** | `https://operation.yotser.in/designer-tasks/d/<token>` (PIN-gated) |
| **Health endpoint** | `https://operation.yotser.in/designer-tasks/api/health` |
| **GitHub repo** | `https://github.com/sadanandvyas-tech/designer-task-scheduler` (currently public — should be flipped to private) |
| **VPS folder** | `/var/www/designer-task-scheduler/` |
| **VPS PM2 process** | `5s-tracker` (shared with other sub-apps; this app does NOT have its own process) |
| **Postgres database** | `designer_task_scheduler` (owner `fivesuser`, Postgres 16) |
| **Production .env** | `/var/www/designer-task-scheduler/.env` (DATABASE_URL only — no PORT line) |
| **Local dev folder** | `/Users/sadanand/Documents/Sadanand Work 2/Claude application developement/30. Designer Task schedular/designer-task-scheduler/` |
| **Companion docs** | Same workspace folder, one level up: `Designer_Task_Scheduler_Build_Spec_v1.docx`, `decision_recap.md`, `wireframe.html`, `MORNING_BRIEFING.md` |

---

## Tech stack

| Layer | What | Notes |
|---|---|---|
| Runtime | **Node.js 20+** | VPS has v20.20.2; local Mac has v22.20 |
| HTTP | **Express 4.x** as a `Router` | Not a full app; see Architecture below |
| DB | **PostgreSQL 16** | Hosted on the same VPS, port 5432 |
| Auth (designers) | **bcryptjs** | 4-digit PINs hashed; pure-JS, no native compile |
| Auth (assigners) | **None** | Internal-only URL; planned to add shared password later |
| Frontend | **Vanilla HTML/CSS/JS** | Single-file `public/index.html` for assigner UI, separate `public/designer.html` for the designer mobile view |
| External API | **Zoho Projects API** (`.in` region) | OAuth2 refresh-token flow; Self Client |
| Process supervisor | **PM2** (`5s-tracker` process) | We DO NOT have our own PM2 process |
| Hosting | **Hostinger VPS** (`srv1479112`, `187.127.128.19`) | Nginx in Docker → port 3010 → 5s-tracker |

**No build step.** All JS runs natively. CSS is inline. No webpack/vite/babel. Following the existing portal convention.

---

## Architecture

```
┌─────────────────────── Hostinger VPS ──────────────────────┐
│                                                              │
│   Docker Nginx :443 ─→ localhost :3010                       │
│                              │                               │
│                    ┌─────────▼──────────┐                    │
│                    │  5s-tracker        │  (PM2 process)     │
│                    │  /var/www/5s-      │                    │
│                    │  tracker/server.js │                    │
│                    │                    │                    │
│                    │  app.use('/5s/',  ...)                  │
│                    │  app.use('/projects/', ...)             │
│                    │  app.use('/production/', ...)           │
│                    │  app.use('/installation/', ...)         │
│                    │  app.use('/designer-tasks/',            │
│                    │          designerTasksRouter)  ◄─── us  │
│                    │  app.use('/shopfloor-mistakes/', ...)   │
│                    │  ...                                    │
│                    │                                         │
│                    │  app.listen(3010)                       │
│                    └─────────────────────────────────────────┘
│                                                              │
│   PostgreSQL :5432                                           │
│   ├── fives_tracker  (5s-tracker DB)                         │
│   ├── designer_task_scheduler   (our DB)                     │
│   └── ...                                                    │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

Our `server.js` is required by the parent process at boot. We export an Express `Router`, not a full app. The parent process owns the listener.

**Why this matters:**
- Don't add `app.listen()` anywhere in our code — the parent already has one
- `db.js` MUST use the dotenv-isolation pattern (read our own `.env` directly via `dotenv.parse(fs.readFileSync(...))`) because the parent process has already called `dotenv.config()` and `process.env.DATABASE_URL` points at the parent's database. See `db.js` and the inline comment.
- Restarting our app means restarting the WHOLE 5s-tracker process: `pm2 restart 5s-tracker`. This briefly takes down all other sub-apps too.

---

## File structure

```
designer-task-scheduler/
├── README.md                     ← this file
├── package.json                  ← deps + scripts (no devDependencies)
├── .env.example                  ← template; real .env is on VPS only, NOT in git
├── .gitignore                    ← excludes node_modules, .env, uploads/*
├── server.js                     ← exports Express Router; wires all route modules
├── local.js                      ← local-dev wrapper (`npm start`); never runs on VPS
├── db.js                         ← Postgres pool with critical dotenv-isolation pattern
├── schema.sql                    ← idempotent DDL for all 7 tables + 2 views
├── scripts/
│   └── init-db.js                ← applies schema.sql + seeds default tags
├── routes/                       ← feature modules, each exports (router, db) => void
│   ├── designers.js              ← CRUD + URL token rotation + PIN management
│   ├── tags.js                   ← read-only list of ad-hoc tags
│   ├── tasks.js                  ← create ad-hoc, list by state, cancel
│   ├── assignments.js            ← assign + availability query + overload guard
│   ├── capacity.js               ← Today/Week views + mark-done + edit + reassign + send-back
│   ├── reports.js                ← daily/summary efficiency + completed-tasks log
│   ├── pool.js                   ← list pool + move-to-active (single + bulk)
│   ├── dashboard.js              ← tile counts + alert banner data
│   ├── zoho.js                   ← OAuth refresh + project iteration + tag-filter import + 5-min cron
│   └── designer-public.js        ← /d/:token + PIN gate + read-only today queue
├── public/
│   ├── index.html                ← assigner SPA (all 7 tabs, ~1500 lines)
│   └── designer.html             ← designer mobile read-only page (~260 lines)
└── uploads/
    └── .gitkeep                  ← placeholder; uploads not yet used
```

`server.js` is the entry point. It mounts each route module in order, then ends with a SPA fallback that serves `index.html` for any unmatched GET (so deep-link refresh works).

---

## Database schema

7 tables and 2 views, all in the `designer_task_scheduler` Postgres database. Schema is idempotent (every `CREATE TABLE` is `IF NOT EXISTS`); running `npm run init-db` is safe at any time.

### Tables

| Table | Purpose | Key columns |
|---|---|---|
| **designers** | Roster of design team members | `id`, `name` (unique), `url_token` (random, opaque), `pin_hash` (bcrypt of 4-digit PIN), `is_active` |
| **tags** | Categories for ad-hoc tasks (Internal, Rework, Training, etc.) | `id`, `name` (unique), `color_hex`, `sort_order`, `is_active` |
| **tasks** | Master table; one row per task (Zoho-imported OR ad-hoc) | `id`, `source` (`zoho`/`adhoc`), `zoho_project_id`, `zoho_task_id` (composite unique partial index when source=zoho), `task_name`, `project_name`, `tag_id` (nullable FK to tags), `state` (`pool`/`active`/`assigned`/`done`/`cancelled`), `cancel_reason` (required when state=cancelled), `imported_at`, `completed_at`, `created_by` |
| **assignments** | Per-day allocation slices. One task = one designer; multi-day = multiple rows for same task_id, all same designer_id | `id`, `task_id` (FK, ON DELETE CASCADE), `designer_id` (FK, ON DELETE RESTRICT), `assigned_date`, `minutes` (must be >0 and multiple of 15), `is_done`, `done_at` |
| **audit_log** | Append-only history for every state-changing action | `task_id` (nullable FK), `actor`, `action` (e.g. `created_adhoc`, `assigned`, `marked_done`, `cancelled`), `reason`, `before_json`, `after_json`, `at` |
| **sync_log** | One row per Zoho sync attempt (manual or scheduled) | `trigger_type`, `triggered_by`, `started_at`, `finished_at`, `tasks_seen`, `tasks_new`, `tasks_skipped`, `ok`, `error_message` |
| **settings** | k/v store for app-wide config | `key`, `value`, `updated_at`. Known keys: `zoho_client_id`, `zoho_client_secret`, `zoho_refresh_token`, `zoho_portal_id`, `zoho_designing_tag_id`, `zoho_designing_tag_name`, `last_sync_at`, `assigner_names` |

### Views

| View | Purpose |
|---|---|
| `v_designer_day_minutes` | Per-designer per-day total / done / open minutes; convenience for capacity queries |
| `v_aged_assignments` | Assignments where `is_done=false` AND (`assigned_date` < today OR (`= today` AND time > 20:00)) — i.e., yellow leftover work |

### Key constraints to know about

- `tasks.state` is checked: must be one of the 5 enum values
- `tasks` has a partial unique index on `(zoho_project_id, zoho_task_id)` only when `source='zoho'` — so multiple ad-hoc tasks can have NULL Zoho IDs without colliding
- `assignments.minutes` must be >0 and a multiple of 15 (15-min granularity per spec)
- `designers` cannot be deleted if they have any non-done assignments (FK + app-level check)
- A task is auto-flipped to `state='done'` when the LAST of its assignments gets `is_done=true`. See `routes/capacity.js → POST /api/assignments/:id/done`.

---

## Task lifecycle (state machine)

```
                          ┌──────────────┐
                          │   POOL       │  ← Zoho-imported (cron)
                          │              │  ← OR sent back from later states
                          └──────┬───────┘
                                 │ move-to-active
                                 ▼
                          ┌──────────────┐
                          │   ACTIVE     │  ← Ad-hoc tasks land directly here
                          │              │
                          └──────┬───────┘
                                 │ assign (designer + slices)
                                 ▼
                          ┌──────────────┐
                          │   ASSIGNED   │  ◄── reassign / edit / send-back
                          │              │      stays here on partial completion
                          └──────┬───────┘
                                 │ all assignments marked done
                                 ▼
                          ┌──────────────┐
                          │     DONE     │  (terminal)
                          └──────────────┘

  Any non-done state can also transition to → CANCELLED (with required reason)
```

**Transitions are managed by API endpoints (see API surface below).** Direct DB writes that skip these endpoints will skip audit logs and possibly violate state invariants.

---

## API surface (all routes prefixed with `/designer-tasks`)

| Method + Path | What it does |
|---|---|
| `GET /api/health` | Returns `{ok, version, db_time}` — used as smoke test |
| `GET /api/dashboard` | Tile counts (pool, active, aged, today's capacity %) + banner data (aged details, overloaded designers, last sync failure) |
| **Designers** | |
| `GET /api/designers` | List all designers (active sorted first) |
| `POST /api/designers` | Create. Body: `{name, pin}`. Generates url_token, bcrypts PIN |
| `PATCH /api/designers/:id` | Update name / PIN / is_active |
| `DELETE /api/designers/:id` | Hard delete. Refuses with 409 if any non-done assignments exist |
| `POST /api/designers/:id/rotate-token` | Generate a new public-URL token (invalidates old URL) |
| **Tags** | |
| `GET /api/tags` | List active tags (read-only for now; CRUD planned) |
| **Tasks** | |
| `POST /api/tasks` | Create ad-hoc task. Body: `{name, project_name?, tag_id?, created_by}` |
| `GET /api/tasks?state=...` | List tasks by state (pool/active/assigned/done/cancelled) |
| `POST /api/tasks/:id/cancel` | Cancel with required reason; logged in audit |
| `POST /api/tasks/:id/move-to-active` | Pool → Active |
| `POST /api/tasks/bulk-move-to-active` | Body: `{ids: []}`. Bulk variant |
| `POST /api/tasks/:id/assign` | Body: `{designer_id, slices: [{date, minutes}], force?, actor}`. Creates one assignment row per slice, flips task to `assigned`. Returns 422 with overload details if would exceed 8h, unless `force: true` |
| `POST /api/tasks/:id/reassign` | Body: `{new_designer_id, reason, force?}`. Changes designer on ALL assignments for the task. Reason required. Same overload-check pattern |
| `POST /api/tasks/:id/send-back` | Delete all assignments, return task to `pool` state |
| `GET /api/tasks/:id/audit` | Audit log entries for the task (powers History panel — UI not yet built) |
| **Assignments** | |
| `GET /api/availability?date=YYYY-MM-DD` | Per-designer minutes_assigned + free + overload for that date |
| `POST /api/assignments/:id/done` | Toggle `is_done`. If all task's assignments are now done, flip task.state=done with `completed_at=NOW()` |
| `PATCH /api/assignments/:id` | Body: `{date?, minutes?, force?}`. Edit a single slice. Same overload check |
| **Capacity** | |
| `GET /api/capacity/today?date=YYYY-MM-DD` | All designers, with their assignments + free hours + aged carry-over for that date |
| `GET /api/capacity/week?start=YYYY-MM-DD` | Mon-Sat × all-active-designers grid (numeric matrix) |
| **Reports** | |
| `GET /api/reports/daily?from=&to=&designer_id?` | Per-designer per-day series: total / on_time_done / late_done / efficiency_pct |
| `GET /api/reports/summary?from=&to=` | Per-designer rollup with monthly mean efficiency, plus team-wide rollup |
| `GET /api/completed?from=&to=&designer_id?` | Done-tasks log (one row per task, with designer + total hours + on-time flag) |
| **Pool / Zoho** | |
| `GET /api/pool` | List `state='pool'` tasks |
| `GET /api/zoho/status` | OAuth config status + last 5 sync log entries |
| `POST /api/zoho/settings` | Save credentials. Body: `{zoho_client_id?, zoho_client_secret?, zoho_refresh_token?, zoho_portal_id?, zoho_designing_tag_id?, zoho_designing_tag_name?}` |
| `POST /api/zoho/sync` | Trigger a manual sync (same logic as the cron) |
| `GET /api/zoho/last-sync` | Most recent sync_log row (for the Pool page header) |
| `POST /api/zoho/clear-pool` | Delete all `source='zoho'` tasks where `state='pool'`. Used to re-import after filter changes. Does NOT touch active/assigned/done/cancelled. |
| `GET /api/zoho/debug` | DIAGNOSTIC. Returns raw Zoho API responses (project list + sample task structure) without any filtering. Useful when sync returns unexpected counts. |
| **Designer public** | |
| `GET /d/:token` | Serves `designer.html` (separate page from the assigner SPA) |
| `POST /d/:token/verify-pin` | Body: `{pin}`. Sets a 12-hour HttpOnly cookie scoped to `/designer-tasks/` if PIN matches |
| `GET /api/d/:token/today` | Returns today's queue + carry-over + today/month efficiency for the designer. Cookie required. |

---

## The 7 UI tabs (assigner view)

The assigner page (`public/index.html`) is a single-page app with a top tab bar. All tabs render dynamically from the API on click.

| Tab | What's there |
|---|---|
| **Dashboard** | 4 tiles (Pool count, Active count, Today's team-capacity %, Aged count) + alert banners (yellow leftover, red overload, sync-failure). Tiles are clickable shortcuts to relevant tabs. |
| **Pool** | Inbox of design-tagged tasks pulled from Zoho. Per-row "→ Active" button + bulk via checkboxes + "Sync now (Zoho)" button + last-sync info. Empty when no Zoho sync has occurred. |
| **Active** *(default landing)* | Inline quick-assign table: each row has Task / Project-Tag / Designer dropdown (with free hours suffix) / Date / H / M / Assign + Slice + Send-back + Cancel. Multi-day "+ Slice" expands a continuation row underneath the parent. Top of tab has an "+ Add ad-hoc task" inline bar. |
| **Capacity** | Sub-tabs Today / Week / Kanban + a date picker. Today board shows per-designer rows with progress bars + task cards (with Mark Done + Reassign + Send-back + Cancel buttons) + carry-over section for aged work. Week is a Mon-Sat × designer grid color-coded by load. Kanban is one column per designer. |
| **Completed** | Filterable log of done tasks. Date range + designer filter. Each row shows on-time / late badge. |
| **Reports** | Per-designer daily efficiency bar chart + team leaderboard + team-wide rollup. Date range + designer filter. |
| **Settings** | Three sections: Designers (CRUD with PIN + URL rotation), Ad-hoc task tags (read-only list of 6 default tags), Zoho connection (OAuth credential form + Save / Test sync now / Clear Zoho pool buttons + recent syncs table). |

The header has an "Acting as: [name]" input that persists in `localStorage`. Whatever's typed there is sent as `actor` on every state-change API call and ends up in `audit_log`.

---

## Designer mobile page (`/d/<token>`)

Separate HTML file (`public/designer.html`). Purple header with the designer's name + today/month efficiency badges. Below that:
- PIN gate on first visit (4-digit numeric input)
- Once PIN-verified, a 12-hour cookie keeps them in
- Read-only list of today's tasks + any aged carry-over from past days
- Auto-refreshes every 5 minutes

Designers cannot mark anything done, edit, or reassign — only the assigner can do those from the main UI.

---

## Configuration

### Required for production (`.env` on VPS only)

```env
DATABASE_URL=postgres://fivesuser:<password>@localhost:5432/designer_task_scheduler
```

That's it. No `PORT=` line in production (would be dead code anyway since we don't `app.listen()`). No Zoho credentials in `.env` either — those live in the `settings` table, set via Settings UI.

### Optional for local development (`.env.example` shows the shape)

```env
PORT=3001
DATABASE_URL=postgres://postgres:postgres@localhost:5432/designer_task_scheduler
APP_SHARED_PASSWORD=changeme    # not yet used; planned auth hook
ZOHO_CLIENT_ID=
ZOHO_CLIENT_SECRET=
ZOHO_REFRESH_TOKEN=
ZOHO_PORTAL_ID=
ZOHO_DESIGNING_TAG_ID=
```

The Zoho env vars in `.env.example` are vestigial — the app reads Zoho config from the `settings` table at runtime, not from env. They're listed for documentation only.

### Settings table (set via Settings → Zoho connection UI)

| Key | Value |
|---|---|
| `zoho_client_id` | OAuth Client ID from `api-console.zoho.in` Self Client |
| `zoho_client_secret` | OAuth Client Secret |
| `zoho_refresh_token` | Long-lived refresh token (mint via curl exchange — see Zoho setup section) |
| `zoho_portal_id` | Portal name from `projects.zoho.in/portal/<NAME>/` (currently `parallellearningdotin`) |
| `zoho_designing_tag_id` | Numeric tag ID. Optional — falls back to name match. |
| `zoho_designing_tag_name` | Tag name to match if no ID. Default: `Designing` |
| `last_sync_at` | ISO timestamp; updated on every successful sync |

---

## Background jobs

### Zoho sync (every 5 minutes)

Started by `routes/zoho.js → scheduleBackgroundSync(db)`, which is invoked once at boot from `server.js`.

- 60 seconds after server start, fires the first tick
- Then every 5 minutes via `setInterval`
- Each tick checks if Zoho creds are configured; if not, no-op
- If configured: refreshes access token (cached 1h), fetches projects, fetches each project's tasks, filters by tag = "Designing" + non-closed status, inserts new tasks into pool with `ON CONFLICT DO NOTHING` for the (zoho_project_id, zoho_task_id) composite key
- Every attempt (success or failure) writes a row to `sync_log`

**There is no other cron.** No 8 pm rollover job — aged-yellow status is computed live by SQL (in `v_aged_assignments` and inline conditions) based on `CURRENT_DATE` / `CURRENT_TIME`.

---

## Deployment workflow

Standard GitHub-first cycle (set up after the initial deployment):

### Make a code change

Either:
- Edit locally on Mac in the workspace folder, then `git add / commit / push`
- OR open `https://github.com/sadanandvyas-tech/designer-task-scheduler` in browser, press `.` for github.dev (web VS Code), edit, commit + push from the web UI

### Deploy to VPS

SSH/web-terminal to VPS (Hostinger panel → VPS → Browser SSH), then:

```bash
cd /var/www/designer-task-scheduler && git pull && npm install --omit=dev && pm2 restart 5s-tracker
```

A shell alias `deploy-dts` is set up in `~/.bashrc` on the VPS that does exactly this — so usually just typing `deploy-dts` is enough.

`npm install --omit=dev` is a no-op when no dependencies changed but is harmless to run every time.

### Verify

Open `https://operation.yotser.in/designer-tasks/` and **hard-refresh** (Cmd-Shift-R) to bust cached HTML/JS. Health pill at the bottom should turn green within a few seconds.

If `pm2 restart 5s-tracker` produced a `Cannot find module` error or a SyntaxError, the whole portal is down. Roll back:

```bash
cd /var/www/designer-task-scheduler
git log --oneline -5
git reset --hard <last-good-sha>
pm2 restart 5s-tracker
```

The main `5s-tracker` process's `server.js` and `portal/index.html` were edited ONCE during initial deployment to mount our router and add the portal card — and not touched since. Backups of those edits are preserved in `/var/www/5s-tracker/server.js.bak.<timestamp>` and `portal/index.html.bak.<timestamp>` if needed.

---

## Critical design decisions (the "why we did it this way" log)

These came out of an extensive spec interview before any code was written. See the companion `decision_recap.md` for the full flat list. The most important ones to know about:

### Lifecycle / scope

- **Single persona: assigner.** No login for designers. They see only their personal `/d/<token>` URL.
- **Single password for assigners** (planned, not yet enforced) + name dropdown for audit identity. Currently the `Acting as:` header field provides the actor name.
- **One task = one designer.** Multi-day splits are allowed but always to the SAME designer.
- **8 pm rollover** is visual only, not a state change. At 8 pm, today's unfinished assignments turn yellow; tomorrow gets a fresh 8h budget.
- **8-hour daily cap** is a soft guard — assigner can override via confirmation popup.
- **Cancelled tasks are excluded from efficiency entirely.**

### Zoho integration

- **One-way Zoho → app.** No write-back. Once imported, the local copy is canonical (frozen).
- **Composite unique key:** `(zoho_project_id, zoho_task_id)`. Partial index so ad-hoc tasks (NULL Zoho IDs) don't collide.
- **5-min cron + manual button.** No real-time webhooks (would require public Zoho callback URL).
- **Filters at import:** must have Designing tag AND not be in a closed-type status. Without the closed filter, the import was 182 historical tasks; with it, it's 11 actually-open ones.
- **Reuses one Self Client.** Zoho only allows one Self Client per account, so the app reuses the existing one (formerly used for Zoho Creator integration). Refresh tokens are scope-specific so this is safe.

### Efficiency formula

- Per-assignment (not per-task): each (date, hours) slice is the unit
- On-time = `done_at <= 20:00 of assigned_date`
- Daily efficiency = on-time-done / total-assigned that day
- Monthly efficiency = mean of daily efficiencies (skipping zero-task days)
- Cancelled excluded from numerator AND denominator
- Late completion earns no credit; the day's efficiency stays at its 8 pm value forever (no backfill)

### UX

- **Inline assignment table, no popups.** This was iterated to during the wireframe phase — original spec had a modal, then user pushed back for inline editing. The Active tab is now the most-used view.
- **Ad-hoc tasks were added late** — initially the app was Zoho-only, then user requested manual task creation for internal/training/rework work that doesn't live in Zoho.
- **Tag pills** for ad-hoc tasks (Internal / Rework / Training / Admin / Meeting / Misc) with color-coded styles. List is editable in the future via a Settings sub-section that's not yet built.

---

## Known issues / future work

| # | Item | Why it's not done |
|---|---|---|
| 1 | **Assigner authentication** — currently anyone with the URL can access the assigner UI | Internal-only URL was deemed acceptable for v1 |
| 2 | **`/d/<token>` URL with bad token serves the assigner SPA** instead of a "not found" page | Edge case; SPA fallback in server.js catches everything that didn't match |
| 3 | **Reassign UI is a `prompt()` numeric picker** (not a proper dropdown modal) | UX corner; functional but ugly |
| 4 | **Edit-assignment** has API (`PATCH /api/assignments/:id`) but no UI button | Workaround: cancel + recreate |
| 5 | **Drag-drop in Kanban** — view-only | Out of v1 scope |
| 6 | **Audit log viewer per task** — backend (`GET /api/tasks/:id/audit`) ready, no UI yet | Low priority |
| 7 | **Tag CRUD** — only read-only list in Settings | Default 6 tags cover common cases |
| 8 | **Holiday calendar / per-designer leaves** — out of v1 | Spec interview deferred to v2 |
| 9 | **Per-designer custom capacity** (part-timers at 4h, etc.) | Always 8h in v1; spec deferred |
| 10 | **Postgres `fivesuser` password** is the literal string `your-new-strong-password` | Inherited from earlier sub-app deployment; needs coordinated rotation across all sub-apps |
| 11 | **GitHub repo is currently Public** | Needs to be flipped to Private for internal infra |
| 12 | **Zoho refresh token was shared via chat during setup** | Should be rotated by generating a fresh refresh_token via the same Self Client OAuth flow and updating Settings → Zoho connection |
| 13 | **`bcrypt` was originally a dependency, swapped to `bcryptjs`** to remove 3 high-severity vulns from the native-compile chain. PINs hashed under `bcrypt` still verify correctly under `bcryptjs` because both produce the same `$2a$/$2b$` hash format. | Done; noted here so future devs don't try to swap back |

---

## Common operations cheatsheet

### Quick deploy
```bash
# Mac
git add . && git commit -m "..." && git push

# VPS (alias 'deploy-dts' set up in ~/.bashrc)
deploy-dts
```

### Inspect the database
```bash
# On VPS
sudo -u postgres psql designer_task_scheduler

# Useful queries:
\dt                            # list tables
SELECT COUNT(*), state FROM tasks GROUP BY state;
SELECT * FROM sync_log ORDER BY started_at DESC LIMIT 5;
SELECT * FROM v_aged_assignments;
SELECT actor, action, at FROM audit_log ORDER BY at DESC LIMIT 20;
```

### Debug a failing Zoho sync
```bash
# Check the most recent attempts:
sudo -u postgres psql designer_task_scheduler -c \
  "SELECT id, started_at, ok, tasks_seen, tasks_new, error_message FROM sync_log ORDER BY started_at DESC LIMIT 10;"

# Hit the debug endpoint to see raw Zoho responses:
curl -s 'https://operation.yotser.in/designer-tasks/api/zoho/debug' | python3 -m json.tool
```

### Check pm2 logs
```bash
pm2 logs 5s-tracker --lines 100 --nostream
pm2 logs 5s-tracker --err --lines 50 --nostream   # errors only
```

### Restore the parent server.js from backup (if a deploy bricks the portal)
```bash
ls /var/www/5s-tracker/server.js.bak.*
cp /var/www/5s-tracker/server.js.bak.YYYYMMDD-HHMMSS /var/www/5s-tracker/server.js
pm2 restart 5s-tracker
```

### Drop and recreate the database (NUCLEAR — last resort)
```bash
sudo -u postgres psql -c "DROP DATABASE designer_task_scheduler;"
sudo -u postgres psql -c "CREATE DATABASE designer_task_scheduler OWNER fivesuser;"
cd /var/www/designer-task-scheduler && npm run init-db
# Then re-add designers + Zoho creds via Settings UI
```

---

## Companion documents

The full design context lives one folder up from this repo, in the parent workspace:

| File | What's in it |
|---|---|
| `Designer_Task_Scheduler_Build_Spec_v1.docx` | The formal build spec written from the design interview. ~30 pages with decision tables, data model, API surface, ASCII wireframes, deployment plan, acceptance criteria. |
| `decision_recap.md` | Flat one-page list of every decision (Zoho sync model, lifecycle, efficiency formula, etc.). Quick cross-check. |
| `wireframe.html` | Interactive HTML mockup of all 7 tabs. Open in any browser. Predates the actual build but matches it closely. |
| `MORNING_BRIEFING.md` | Notes from the autonomous overnight build of phases 4–9. Includes deployment instructions and known-gap list at the time. |
| `schema.sql` *(early draft, in parent folder)* | An earlier version of the schema. The CURRENT canonical schema is `designer-task-scheduler/schema.sql`. The parent's copy is preserved for historical reference only. |

The deployment guide that THIS app's structure conforms to (sub-app router pattern, etc.) is `OPERATIONS_PORTAL_NEW_APP_GUIDE.md`, also in the parent workspace folder. It documents the conventions all sub-apps of `operation.yotser.in` follow.

---

## When something breaks

1. **Hard-refresh the browser first.** 80% of "the UI looks weird" reports are stale cached HTML/JS.
2. **Check `pm2 list`** — is `5s-tracker` `online` with non-trivial uptime? If `errored`, see logs.
3. **Check the health endpoint:** `https://operation.yotser.in/designer-tasks/api/health` — should return `{ok:true, db_time:...}`. If it 500s, the DB connection broke. If it 502s, the whole 5s-tracker process is down.
4. **Check `sync_log`** if Zoho data isn't flowing.
5. **Check `audit_log`** if you suspect data was changed unexpectedly.
6. **Last resort:** roll back to a known-good git commit and `pm2 restart 5s-tracker`.

---

*This README represents the state of the app as of the end of its initial build phase. Update it when major features change. The spec and wireframe are frozen historical artifacts; this README is the living source of truth for "what the app does today".*
