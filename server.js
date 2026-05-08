// Designer Task Scheduler — Express Router (sub-app)
// Mounted at /designer-tasks/ inside the 5s-tracker process in production.
// In local dev, local.js mounts this router on PORT.

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const db      = require('./db');

const router = express.Router();

// File uploads dir (kept per the deployment-guide convention even if not used in v0)
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Body parsing
router.use(express.json());
router.use(express.urlencoded({ extended: true }));

// Static files
router.use('/uploads', express.static(UPLOAD_DIR));
router.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// Health check — used by deployment guide smoke test
router.get('/api/health', async (_req, res) => {
  try {
    const { rows } = await db.query('SELECT NOW() AS now');
    res.json({
      ok: true,
      app: 'designer-task-scheduler',
      version: '0.1.0',
      db_time: rows[0].now,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Tile counts for the dashboard (returns zeros until features are built)
router.get('/api/dashboard', async (_req, res) => {
  try {
    const pool   = await db.query("SELECT COUNT(*)::int AS n FROM tasks WHERE state = 'pool'");
    const active = await db.query("SELECT COUNT(*)::int AS n FROM tasks WHERE state = 'active'");
    const aged   = await db.query("SELECT COUNT(*)::int AS n FROM v_aged_assignments");
    const cap    = await db.query(
      `SELECT COALESCE(SUM(minutes), 0)::int AS used FROM assignments
       WHERE assigned_date = CURRENT_DATE`
    );
    const designers = await db.query("SELECT COUNT(*)::int AS n FROM designers WHERE is_active");
    const totalCapacity = designers.rows[0].n * 8 * 60; // minutes
    res.json({
      pool:           pool.rows[0].n,
      active:         active.rows[0].n,
      aged:           aged.rows[0].n,
      capacity_used_min:  cap.rows[0].used,
      capacity_total_min: totalCapacity,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Future routes will go here, organized by feature:
//   require('./routes/auth')(router, db);
//   require('./routes/pool')(router, db);
//   require('./routes/active')(router, db);
//   require('./routes/assignments')(router, db);
//   require('./routes/capacity')(router, db);
//   require('./routes/reports')(router, db);
//   require('./routes/designers')(router, db);
//   require('./routes/tags')(router, db);
//   require('./routes/zoho')(router, db);
//   require('./routes/designer_public')(router, db);

// ---------------------------------------------------------------------------
// SPA fallback — sends index.html for any unmatched GET (so refresh works on
// deep URLs like /designer-tasks/active/123).
// ---------------------------------------------------------------------------
router.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler
router.use((err, _req, res, _next) => {
  console.error('[designer-task-scheduler]', err);
  res.status(500).json({ error: err.message || 'internal error' });
});

module.exports = router;
