# Build Journal — *Palette* (Designer Task Scheduler)

A chronological retrospective of how we went from "we have a problem" to a fully working production app, with every error we hit along the way and how we recovered.

---

## Naming the application

The repo, the spec, the database, the URL — all use **Designer Task Scheduler** as the official name. Functional, descriptive, fine for documentation.

For something more memorable / brandable, my suggestion:

> ### **Palette** 🎨
>
> Short. Designer-themed (matches the existing emoji). Connotes a place where you arrange your tools. Easy to say in hallway conversation: *"I've added you to Palette."*

Other contenders if Palette doesn't land:

| Name | Why it could work | Why it might not |
|---|---|---|
| **Easel** | What designers actually work at; concrete; short | Slightly too literal |
| **Atelier** | A designer's studio; sounds professional | Spelling friction; pretentious |
| **Loom** | Weaves designer schedules together | Already a video product (cluttered space) |
| **Studio** | Designers' workspace | Too generic; overused |
| **DesignFlow** | Tells you exactly what it does | Boring; could be any tool |

This document refers to the app as **Palette** for narrative purposes. The codebase itself stays as `designer-task-scheduler` because the deployment guide's naming conventions are baked in.

---

## Executive summary

**What we built:** a sub-app of `operation.yotser.in` that pulls design-tagged tasks from Zoho Projects, lets the operations team allocate them (plus ad-hoc internal work) to designers with daily 8-hour budgets, visualizes capacity in three views (Today / Week / Kanban), surfaces aged-yellow and overload-red signals, and computes daily + monthly efficiency. Each designer also gets a personal mobile read-only URL gated by PIN.

**How long:** about 36 hours of elapsed time, across roughly 4 working sessions, including a long autonomous overnight build. ~3,500 lines of production code (Node + Postgres + vanilla HTML/CSS/JS) plus ~1,500 lines of documentation.

**Where it lives:** `https://operation.yotser.in/designer-tasks/`. Code at `github.com/sadanandvyas-tech/designer-task-scheduler`. Mounted as an Express Router inside the existing `5s-tracker` PM2 process on the Hostinger VPS.

**Status:** end-to-end functional. Real Zoho data flowing. Sync runs hourly in the background.

---

## Build chronology

### Phase 0 — Spec interview (the foundation)

Before any code, we ran a relentless decision interview spanning 9 branches: Zoho sync model, lifecycle, designer roster, time allocation, capacity visualization, efficiency formula, auth/personas/UI, notifications, deployment. Each branch produced explicit decisions captured in tables.

Key choices that shaped everything downstream:
- **Single persona — assigner.** Designers don't log in. They get a token URL.
- **One task = one designer.** Multi-day splits OK, but always to the same person.
- **8-hour cap is soft.** Override allowed via confirmation popup.
- **Yellow = aged work, red = overloaded.** Visual semantics, not state changes.
- **Efficiency = on-time-done / assigned, count-based.** Cancelled excluded.
- **Production-first deploy.** Skeleton on VPS first; fill in features iteratively.

Output: `Designer_Task_Scheduler_Build_Spec_v1.docx` + `decision_recap.md` + `wireframe.html`.

### Phase 1 — Skeleton (clean)

Wrote `package.json`, `db.js` (with the critical dotenv-isolation pattern), `server.js` as an Express Router, `local.js` wrapper, `schema.sql`, `scripts/init-db.js`, `public/index.html` "coming soon", `.gitignore`, `.env.example`. Each file followed the conventions in the existing `OPERATIONS_PORTAL_NEW_APP_GUIDE`. No errors.

### Phase 2 — GitHub (first hiccup)

**Error #1:** Tried to push, but the user accidentally created the GitHub repo named `sadanandvyas-tech` (matching their username — which on GitHub creates the special "profile README" repo) instead of `designer-task-scheduler`.

**Recovery:** Renamed the repo via GitHub Settings → Repository name → Rename. Updated the local remote with `git remote set-url origin <new>`. Re-pushed.

**Error #2:** When I gave the user a command template with placeholders like `<your-username>`, zsh interpreted the `<` as input redirection and tried to redirect from a file named `your-username`, failing with `no such file or directory`.

**Recovery:** Started using literal known values in the actual commands (e.g., `sadanandvyas-tech`) instead of bracketed placeholders. Lesson: when giving terminal commands to a non-developer audience, never use angle-bracket placeholders.

### Phase 3 — VPS database, clone, install (one weird discovery)

**Error #3:** The Postgres password in `/var/www/5s-tracker/.env` turned out to be the literal string `your-new-strong-password` — clearly a placeholder that was never replaced when the original VPS was set up. We inherited this for our app's `.env` because all sub-apps share `fivesuser`.

**Recovery:** Documented as a deferred follow-up (coordinated rotation across all sub-apps' `.env` files plus the Postgres role). Logged in the README's "known issues" table. Not changed during deployment to avoid breaking other apps.

**Error #4:** `npm install` reported "3 high severity vulnerabilities" — coming from `bcrypt`'s native compile toolchain (`tar`, `glob`, `inflight`, etc.). The native compile chain is install-time only; it doesn't run at runtime, but the warnings looked scary.

**Recovery:** Replaced `bcrypt` with `bcryptjs` (pure-JS, no native compile, hash format-compatible). Removed 59 transitive packages, added 1. Vulnerability count dropped to 0. PINs hashed under the old `bcrypt` continue to verify correctly under `bcryptjs` because both produce `$2a$/$2b$` hashes.

### Phases 4–6 — Mount + portal card + smoke test (clean)

The Python scripts from the deployment guide worked first try: backed up the main `server.js`, inserted the two mount lines after the existing `/production` mount, verified with `node --check`, added the portal card with our 🎨 emoji and `#f3e8ff` lavender. PM2 restart was clean.

Pre-existing notes worth noting (not our errors):
- The PM2 log showed `[production-tracker] event-bus not available; events will be skipped. MODULE_NOT_FOUND` and similar for `dispatch-qc`. Pre-existing in the portal, unrelated to us.
- An Ubuntu "system restart required" banner appeared. Pending kernel updates from before; we did NOT reboot during deployment.

### Phase 7 — Designer roster Settings tab (smooth)

CRUD for designers (`routes/designers.js`), tag list endpoint (`routes/tags.js`), Settings page rebuilt with the designer table + add row + Zoho placeholder. First fully-functional UI feature. Worked on first deploy.

### Phase 3 (build) — Active tab + ad-hoc tasks (smooth, but iterations followed)

Wrote the inline quick-assign table with multi-day +Slice support. Added ad-hoc task creation with tag dropdowns. The user successfully created and assigned a test task (1h to sadanand) on the first try.

This is also where we caught a small data quirk:
- The user typed "Create the workorder docuemnt" (typo) as a test task and assigned it 15 minutes. That row carried as a yellow leftover for several days — became our running diagnostic test case for aged-yellow logic.

### Phases 4–9 — Autonomous overnight build (~3,400 lines, one structural error)

Per the user's request, I built phases 4 through 9 overnight without their interactive presence. Files written: `routes/capacity.js`, `routes/reports.js`, `routes/dashboard.js`, `routes/zoho.js`, `routes/pool.js`, `routes/designer-public.js`, `public/designer.html`, plus a complete rewrite of `public/index.html`.

**Error #5:** While editing `routes/reports.js` to add a new `/api/completed` endpoint, my Edit tool replaced just `function todayISO() { ... }` with the new endpoint *plus* a new `};` closing brace. The result was a `};` outside of `module.exports = function(...) {...}` which broke the file structure.

**Recovery:** Rewrote `reports.js` from scratch with `Write`. Caught immediately by `node --check`.

The overnight build also dealt with:
- Phase 4 — Capacity views (Today/Week/Kanban) + mark-done + reassign + send-back
- Phase 5 — Aged-yellow visual logic woven into Phase 4 views (no separate cron — derived live by SQL)
- Phase 6 — Reports / efficiency (per-designer daily + summary leaderboard + completed-tasks log)
- Phase 7 — Designer public URLs (`/d/<token>` + 4-digit PIN gate + 12-hour cookie)
- Phase 8 — Zoho scaffold (OAuth refresh + project iteration + tag-filter import + 5-min cron)
- Phase 9 — Dashboard tiles + 3 alert banners (yellow / red / sync-failure)

The deploy in the morning was one git pull + npm install + pm2 restart. Everything booted cleanly.

### Zoho integration (the long debugging journey)

This is where most of our real errors lived. The Zoho story alone deserves its own section.

#### Setup errors

**Error #6:** OAuth setup. User pasted my placeholder strings (`paste-your-client-id`, etc.) literally into the curl command. Zoho returned `{"error":"invalid_client"}`.

**Recovery:** Re-explained with explicit "REPLACE_WITH_REAL_CLIENT_ID" placeholders + instruction to use the copy icons in Zoho's UI to capture untruncated credentials.

**Error #7:** zsh-vs-bash. My initial curl template used `read -p "Client ID: "` which is bash syntax. zsh interpreted `-p` as the coprocess flag and errored with `read: -p: no coprocess`.

**Recovery:** Switched to direct variable assignment (`ZCID="..."`) + paste, no prompts. Fully shell-agnostic.

**Error #8:** Truncated copy. User's first attempt at sharing Client ID and Secret showed values that looked short (30 chars and 42 chars vs Zoho's typical 32 and 64). The values appeared truncated in the Zoho console UI when not using the copy icon.

**Recovery:** User used the copy-icon button to capture full values; subsequent attempts succeeded.

**Error #9:** Mislabeled value. User shared a value labeled "secret key" that was actually a fresh authorization code (recognizable by the `1000.x.y` format).

**Recovery:** I noted the format mismatch and used the value as the auth code, not a secret. Exchange succeeded.

**Error #10:** Single Self Client per account. We had originally specced "create a new OAuth client" for clean separation. Discovered Zoho only allows one Self Client per account. The existing one (from April 2021) had to be reused.

**Recovery:** Reused the existing Self Client. Generated a new authorization code with our specific scope (`ZohoProjects.tasks.READ,projects.READ,portals.READ`). The refresh token returned was scope-specific and independent of any existing tokens for other scopes used by other apps.

#### Discovery errors (the actual sync)

**Error #11:** First sync attempt: `Zoho tasks fetch failed: Input Parameter Missing`. The endpoint I'd written code for — `/restapi/portal/{id}/tasks/` (cross-portal task list) — exists but requires undocumented mandatory parameters (likely `customstatus_index` or similar).

**Recovery:** Rewrote `fetchDesigningTasks()` to iterate: list projects → fetch tasks per project → filter by tag client-side. N+1 calls instead of 1, but works. Returned **182 tasks**.

**Error #12:** 182 was way more than expected — the import was including closed/completed tasks that still carried the Designing tag historically.

**Recovery:** Added a status filter using Zoho's `status.type === 'closed'` flag plus name-fallback (`closed`, `completed`, `done`, `cancelled`). After filter: **11 tasks**.

**Error #13:** 11 was way LESS than expected. User's screenshots from the Zoho UI showed ~35+ open Designing tasks. Something was over-filtering.

**Recovery (initial):** Suspected the `/projects/` endpoint was paginated (200 max per page) and we were only fetching the first page. Patched to paginate and also fetch archived projects. Pushed.

**Error #14:** The new patch worked too well — combined with the every-5-minute cron, we hammered Zoho's API. User got `Sync failed: sync already running` because a previous sync was still iterating archived projects.

**Recovery:** Added a "stuck-lock recovery" timer (sync lock auto-releases after 3 minutes if stuck). Reverted archived-projects fetch (active only).

**Error #15:** Even after the stuck-lock fix, syncs kept returning **0 tasks**. PM2 logs revealed dozens of lines: `[zoho] tasks fetch failed for project XXX:` — but with no error detail (`data.error?.message || res.statusText` was both empty/undefined).

**Recovery:** Beefed up the error log to capture the full HTTP status code and JSON response body.

**Error #16 (the smoking gun):** The detailed log showed:

```
HTTP 400 body={"error":{"status_code":400,
"title":"URL_ROLLING_THROTTLES_LIMIT_EXCEEDED",
"details":{"message":"Cannot execute more than 100 requests
per API in 2 minutes. Try again after 22 minutes."}}}
```

We'd been throttled by Zoho's per-URL rate limit (100 requests / 2 min on the `/projects/{X}/tasks/` URL pattern). With ~50 active projects + a 5-min cron + manual clicks, we'd burned through in seconds. The 22-minute cooldown then blocked everything.

**Recovery (after research):** Used WebSearch to confirm Zoho's documented limits: 100 req / 2 min per URL pattern, 5,000 daily org-wide, no bulk endpoint exists for cross-portal task fetch. Implemented a three-part fix:
1. **1.5-second delay between per-project calls** (50 projects × 1.5s = 75s per sync, stays under 100/2min)
2. **Cron interval changed from 5 min to 30 min** — and after the user pointed out that 8h planning windows don't need higher freshness, **changed again to hourly**
3. **3-min minimum gap between manual sync triggers** (HTTP 429 if violated)

After waiting out the 22-minute Zoho cooldown, the sync ran cleanly: **65 open Designing tasks pulled into the Pool.** Working steady state.

#### Quality-of-life errors during Zoho debugging

**Error #17:** Sync log `Last sync: 0 new of 0 seen` was confusingly displayed even after a successful sync of 9/15/6. The "last sync" text on the Pool page picked up the most recent `sync_log` row regardless of success.

**Recovery:** Logged as a minor cosmetic issue. The Recent Syncs table on Settings → Zoho connection shows the full history with each sync's actual numbers.

**Error #18:** The user accidentally created a `zoho-response.json` file by piping `curl ... | tee zoho-response.json` during the OAuth exchange. The file contained the access token and refresh token in plaintext — sitting on the local Mac, not committed (because `.gitignore` already excluded it... no, it didn't, but git status flagged it as untracked).

**Recovery:** Logged as a clean-up (`rm zoho-response.json` after testing). The refresh token was also visible in our chat conversation; flagged for rotation later.

### UX iterations (treating discovered friction as errors)

**Error #19:** Original Active tab had a popup modal for the assignment dialog. User pushed back: *"instead of making this a popup what i need is to make this like a table so that i can quickly assign."*

**Recovery:** Rebuilt as an inline table with per-row designer dropdown / date / H / M / Assign button. Multi-day +Slice expands a continuation row underneath. No popups.

**Error #20:** Active tab had only Pool-sourced (Zoho) tasks. User asked: *"in this active table i should be able to add additional tags which are not from the pool. As people might be free we might need to add them in various type of task."*

**Recovery:** Added ad-hoc task creation directly in Active. New `+ Add ad-hoc task` bar at the top of the tab with task name + tag dropdown + project context. Added `source='zoho'/'adhoc'` discriminator to the tasks table.

**Error #21:** Reassign UX was clunky — three sequential `prompt()` popups (designer number, reason, force-confirm). User: *"what should happen when i click on the reassign button"* — implicitly asking "this isn't great".

**Recovery:** Replaced with inline expansion (Option A): clicking Reassign expands the task card with a designer dropdown + reason input + Save/Cancel right there.

**Error #22:** When clicking the ↩ Pool icon button on a task card in Capacity → Today, the task moved server-side but the UI didn't refresh — the card stayed visible until manual refresh. User asked for a refresh button. AND when manually refreshing the browser, the page kept landing on the Active tab regardless of which tab was previously open.

**Recovery:**
- Added a `↻ Refresh` button to the Pool tab (re-reads local DB without hitting Zoho)
- Persisted the active tab in `location.hash` (`#capacity` etc.) so browser refresh stays put
- Made `sendBack`, `cancelTask`, `toggleDone`, etc. auto-reload whichever tab was visible (no manual refresh needed)

**Error #23:** Active tab had separate H (number input) and M (dropdown) columns. The H input was tiny and easy to miss; user said: *"the ui for selecting the hours needs to be improved."*

**Recovery:** Replaced both columns with a single Duration dropdown showing all 32 valid durations (15-min increments from 15m to 8h). Cleaner row, one click.

---

## Errors organized by category

### Tooling / shell

| # | Error | Lesson |
|---|---|---|
| 2 | `<your-username>` interpreted as shell redirect | Never use angle-bracket placeholders in commands meant to be pasted into a shell |
| 7 | `read -p` is bash, fails in zsh | Default to direct variable assignment for cross-shell compatibility |

### Setup / deployment

| # | Error | Lesson |
|---|---|---|
| 1 | GitHub repo created with wrong name | Triple-check repo name before creating; rename via Settings is easy fallback |
| 3 | Postgres password is literal placeholder string | Inherited tech debt; document for coordinated rotation |
| 4 | bcrypt's native-compile chain causes 3 high vulns | Use `bcryptjs` for pure-JS PIN hashing; identical hash format |

### Code I broke

| # | Error | Lesson |
|---|---|---|
| 5 | Edit tool dropped a `};` outside `module.exports` closure | When the edit is structural, prefer `Write` over `Edit` — full rewrite is safer than spot patching |

### Zoho integration

| # | Error | Lesson |
|---|---|---|
| 6 | Placeholder strings pasted literally | Always use unmistakable replacement markers like `REPLACE_WITH_X` |
| 8 | Truncated UI copy of Client ID/Secret | Tell users to use copy-icon, never select-and-copy |
| 9 | Auth code mislabeled as "secret key" | Check format before trusting labels |
| 10 | One Self Client per account | Reuse existing; refresh tokens are scope-specific |
| 11 | Cross-portal `/tasks/` endpoint requires undocumented params | Iterate per project — slower but works |
| 12 | Closed Zoho tasks polluting the Pool | Filter on import using `status.type === 'closed'` plus name fallback |
| 13 | Pagination missing on `/projects/` | Always paginate Zoho list endpoints |
| 14 | Stuck sync lock | Add timeout to in-memory locks |
| 15 | Per-project task fetch silently failing | Log full HTTP status + response body, not just message |
| 16 | Hit `URL_ROLLING_THROTTLES_LIMIT_EXCEEDED` | 100 req / 2 min per URL pattern; need 1.5s delay between calls + reduced cron frequency |

### UX friction (discovered through use)

| # | Friction | Iteration |
|---|---|---|
| 19 | Modal for assignment | Inline table with per-row fields |
| 20 | No way to add non-Zoho tasks | Ad-hoc tasks with tag dropdown |
| 21 | Three-popup reassign | Inline form (Option A) |
| 22 | Tab lost on browser refresh + state changes don't refresh | URL hash persistence + auto-reload current tab |
| 23 | Tiny H number input | Single Duration dropdown |

---

## Lessons from the journey

### What I'd do differently next time

1. **Test against real external APIs before writing fancy code around them.** I wrote `routes/zoho.js` against an idealized Zoho API surface. Almost everything I assumed was slightly off — endpoint paths, response shapes, rate limits, what happens with archived projects. If I'd done one curl against the real API first, I'd have saved 4–5 deploy iterations.

2. **Be honest about scope when promising "I'll build phases 4–9 overnight".** I delivered, but the trade-off was zero interactive testing. Bugs surfaced over the next several deploys. Acceptable for this project (single user, internal tool, fast feedback loop) — but on something with real users, an autonomous overnight ship is dangerous.

3. **Default to inline UX, not modals.** The user pushed back on the assignment modal early. Once we converted to inline, every subsequent UX decision (reassign, tag picker, slice splitting) was easier — there was a clear pattern to follow.

4. **Show your error logs in detail from day one.** When `[zoho] tasks fetch failed for project X:` had nothing after the colon, we burned a deploy cycle adding HTTP-status logging. Should've been there from the start.

5. **Document the `dotenv` isolation pattern at the top of every sub-app.** This is the single most important thing about the operations-portal architecture and the easiest to break. The deployment guide warns about it; my `db.js` has a 12-line comment about it; the README has a section on it. It's worth it.

### What went well

1. **The spec interview.** We made decisions before code. When implementation got messy, we had something to anchor against ("this is what we said we'd build"). Almost no scope creep.

2. **Production-first deployment.** The "skeleton on VPS first, fill in features iteratively" approach kept the feedback loop tight. Every new tab or feature went through one deploy cycle, surfaced its own issues, and was fixed in the next round.

3. **Iterative UX.** We explicitly accepted that the first version of any UI would need rework once the user actually used it. The single Duration dropdown, the inline reassign, the ad-hoc tasks — none were in the original spec; all came from feedback.

4. **Treating GitHub web UI / GitHub Desktop as an option.** Once the initial deploy was done, the user mentioned they'd switch to GitHub Desktop for ongoing edits. Lowering the bar for non-developer collaboration on long-lived tools is a real product win.

---

## What this app is, in one sentence

**Palette is the daily air-traffic-control panel for a designer team — pulling work in from Zoho Projects, routing it to specific designers within their 8-hour days, surfacing what's leaking past deadlines, and producing accountability metrics that don't require self-reporting.**

That's the elevator pitch.

The tactical pitch: it's a thin scheduling layer on top of Zoho Projects + ad-hoc internal work, glued to a daily 8-hour-per-designer capacity model with on-time efficiency tracking. Lives at `operation.yotser.in/designer-tasks/`. Built in 36 hours including its own debug journal.

---

*This journal accompanies the [`README.md`](./README.md) (canonical app docs). Additional design artifacts that aren't in the repo — `Designer_Task_Scheduler_Build_Spec_v1.docx` (the original spec from the design interview), `decision_recap.md` (flat list of every decision), `wireframe.html` (interactive UI mockup), and `MORNING_BRIEFING.md` (notes from the autonomous overnight build of phases 4–9) — live alongside this repo's parent folder on the developer's machine.*
