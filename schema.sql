-- Designer Task Scheduler — schema.sql
-- Postgres 16+. Idempotent (uses IF NOT EXISTS everywhere). Run via `npm run init-db`.
-- Database: designer_task_scheduler   Owner: fivesuser (in production)

-- ===========================================================================
-- 1. designers — manual roster managed in Settings tab
-- ===========================================================================
CREATE TABLE IF NOT EXISTS designers (
  id              SERIAL PRIMARY KEY,
  name            TEXT NOT NULL UNIQUE,
  url_token       TEXT NOT NULL UNIQUE,                  -- random opaque, used in /d/<token>
  pin_hash        TEXT NOT NULL,                         -- bcrypt of the 4-digit PIN
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  zoho_user_id    TEXT,                                  -- maps designer ↔ Zoho user (for owner→designer)
  zoho_user_name  TEXT,                                  -- display name from Zoho at mapping time
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent column adds (for installs that pre-date the zoho_user_id feature)
ALTER TABLE designers ADD COLUMN IF NOT EXISTS zoho_user_id   TEXT;
ALTER TABLE designers ADD COLUMN IF NOT EXISTS zoho_user_name TEXT;

-- One Zoho user can map to at most one designer
CREATE UNIQUE INDEX IF NOT EXISTS uq_designers_zoho_user_id
  ON designers (zoho_user_id) WHERE zoho_user_id IS NOT NULL;

CREATE OR REPLACE FUNCTION designers_set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_designers_updated_at ON designers;
CREATE TRIGGER trg_designers_updated_at BEFORE UPDATE ON designers
  FOR EACH ROW EXECUTE FUNCTION designers_set_updated_at();

-- ===========================================================================
-- 2. tags — categories for ad-hoc tasks (Internal, Rework, Training, etc.)
-- ===========================================================================
CREATE TABLE IF NOT EXISTS tags (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  color_hex   TEXT NOT NULL DEFAULT '#ede9fe',        -- pill background color
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===========================================================================
-- 3. tasks — master table. One row per task (Zoho-imported OR ad-hoc).
--    Frozen content; mutable state.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS tasks (
  id                       SERIAL PRIMARY KEY,
  source                   TEXT NOT NULL DEFAULT 'zoho'
                             CHECK (source IN ('zoho','adhoc')),
  -- Zoho-only (NULL for ad-hoc tasks)
  zoho_project_id          TEXT,
  zoho_task_id             TEXT,
  zoho_status_at_import    TEXT,
  zoho_priority_at_import  TEXT,
  zoho_owner_raw           JSONB,                       -- raw {id, name, email, full_name} from Zoho task owner
  -- Common
  task_name                TEXT NOT NULL,
  project_name             TEXT,                       -- Zoho: project name; Ad-hoc: free text context (nullable)
  tag_id                   INT REFERENCES tags(id) ON DELETE SET NULL,  -- ad-hoc tasks usually carry a tag
  suggested_designer_id    INT REFERENCES designers(id) ON DELETE SET NULL,
                                                       -- pre-filled when a Zoho-mapped owner is detected on import
  state                    TEXT NOT NULL DEFAULT 'pool'
                             CHECK (state IN ('pool','active','assigned','done','cancelled')),
  cancel_reason            TEXT,
  imported_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at             TIMESTAMPTZ,
  sent_back_at             TIMESTAMPTZ,                -- set when an assigner manually sends a task back to Pool;
                                                       -- while non-NULL, Zoho sync + designer-mapping must NOT auto-promote.
                                                       -- cleared on explicit move-to-active.
  created_by               TEXT,                       -- assigner name (ad-hoc); 'zoho-sync' (zoho)
  CONSTRAINT chk_tasks_zoho_keys
    CHECK ((source = 'zoho' AND zoho_project_id IS NOT NULL AND zoho_task_id IS NOT NULL)
        OR (source = 'adhoc' AND zoho_project_id IS NULL AND zoho_task_id IS NULL)),
  CONSTRAINT chk_tasks_cancel_reason
    CHECK ((state = 'cancelled' AND cancel_reason IS NOT NULL AND length(trim(cancel_reason)) > 0)
        OR state <> 'cancelled')
);

-- Idempotent column adds (for installs that pre-date these features)
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS zoho_owner_raw        JSONB;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS suggested_designer_id INT REFERENCES designers(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS sent_back_at          TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_tasks_suggested_designer
  ON tasks (suggested_designer_id) WHERE suggested_designer_id IS NOT NULL;

-- Composite uniqueness only matters for Zoho-sourced tasks. Use a partial index.
CREATE UNIQUE INDEX IF NOT EXISTS uq_tasks_zoho_key
  ON tasks (zoho_project_id, zoho_task_id)
  WHERE source = 'zoho';

CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks (state);
CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks (source);
CREATE INDEX IF NOT EXISTS idx_tasks_imported_at ON tasks (imported_at);

-- ===========================================================================
-- 4. assignments — per-day allocation slices.
--    Pool/Active task = zero rows. Assigned task = one or more (one per day).
--    Multi-day = multiple rows for the same task_id, all same designer_id.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS assignments (
  id              SERIAL PRIMARY KEY,
  task_id         INT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  designer_id     INT NOT NULL REFERENCES designers(id) ON DELETE RESTRICT,
  assigned_date   DATE NOT NULL,
  minutes         INT NOT NULL CHECK (minutes > 0 AND minutes % 15 = 0),
  is_done         BOOLEAN NOT NULL DEFAULT FALSE,
  done_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_assignments_designer_date
  ON assignments (designer_id, assigned_date);
CREATE INDEX IF NOT EXISTS idx_assignments_task ON assignments (task_id);

-- ===========================================================================
-- 5. audit_log — append-only history per task
-- ===========================================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id           SERIAL PRIMARY KEY,
  task_id      INT REFERENCES tasks(id) ON DELETE CASCADE,
  actor        TEXT NOT NULL,
  action       TEXT NOT NULL,
  reason       TEXT,
  before_json  JSONB,
  after_json   JSONB,
  at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_task ON audit_log (task_id, at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_log (actor, at DESC);

-- ===========================================================================
-- 6. sync_log — one row per Zoho sync attempt
-- ===========================================================================
CREATE TABLE IF NOT EXISTS sync_log (
  id              SERIAL PRIMARY KEY,
  trigger_type    TEXT NOT NULL CHECK (trigger_type IN ('manual','scheduled')),
  triggered_by    TEXT,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  tasks_seen      INT,
  tasks_new       INT,
  tasks_skipped   INT,
  ok              BOOLEAN,
  error_message   TEXT
);

CREATE INDEX IF NOT EXISTS idx_sync_log_started ON sync_log (started_at DESC);

-- ===========================================================================
-- 7. settings — k/v store for app-wide config
-- ===========================================================================
CREATE TABLE IF NOT EXISTS settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Known keys (seeded on first run by init-db.js):
--   shared_password_hash     bcrypt of the assigner-team shared password
--   zoho_client_id           OAuth client id of THIS app's Zoho client
--   zoho_client_secret       OAuth client secret
--   zoho_refresh_token       long-lived refresh token
--   zoho_portal_id           Zoho Projects portal id
--   zoho_designing_tag_id    cached id of the "Designing" tag
--   last_sync_at             ISO timestamp of last successful sync
--   assigner_names           JSON array of names for the post-login dropdown

-- ===========================================================================
-- 8. Convenience views — capacity calculations
-- ===========================================================================

-- Daily minutes used per designer
CREATE OR REPLACE VIEW v_designer_day_minutes AS
SELECT
  d.id            AS designer_id,
  d.name          AS designer_name,
  a.assigned_date AS the_date,
  COALESCE(SUM(a.minutes), 0) AS minutes_assigned,
  COALESCE(SUM(CASE WHEN a.is_done THEN a.minutes ELSE 0 END), 0) AS minutes_done,
  COALESCE(SUM(CASE WHEN NOT a.is_done THEN a.minutes ELSE 0 END), 0) AS minutes_open
FROM designers d
LEFT JOIN assignments a ON a.designer_id = d.id
GROUP BY d.id, d.name, a.assigned_date;

-- Aged (yellow) assignments — past 8 pm rollover, still not done
CREATE OR REPLACE VIEW v_aged_assignments AS
SELECT a.*, t.task_name, t.project_name, t.source, d.name AS designer_name
FROM assignments a
JOIN tasks     t ON t.id = a.task_id
JOIN designers d ON d.id = a.designer_id
WHERE a.is_done = FALSE
  AND (a.assigned_date < CURRENT_DATE
        OR (a.assigned_date = CURRENT_DATE AND CURRENT_TIME > TIME '20:00:00'));

-- ===========================================================================
-- End of schema.
-- ===========================================================================
