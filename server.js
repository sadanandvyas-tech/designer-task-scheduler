// Designer Task Scheduler — Express Router (sub-app)
// Mounted at /designer-tasks/ inside the 5s-tracker process in production.
// In local dev, local.js mounts this router on PORT.

const express = require('express');
const path    = require('path');
const fs      = require('fs');
const db      = require('./db');

const router = express.Router();

// File uploads dir (kept per the deployment-guide convention even if not used yet)
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Body parsing
router.use(express.json({ limit: '500kb' }));
router.use(express.urlencoded({ extended: true }));

// Static files
router.use('/uploads', express.static(UPLOAD_DIR));
router.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

// Health check (kept inline — used by deployment guide smoke test)
router.get('/api/health', async (_req, res) => {
  try {
    const { rows } = await db.query('SELECT NOW() AS now');
    res.json({
      ok: true,
      app: 'designer-task-scheduler',
      version: '0.4.0',
      db_time: rows[0].now,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Mounted feature routes (order matters: more-specific paths first; the
// catch-all SPA fallback at the bottom must stay last).
require('./routes/designers')(router, db);
require('./routes/tags')(router, db);
require('./routes/tasks')(router, db);
require('./routes/assignments')(router, db);
require('./routes/capacity')(router, db);
require('./routes/reports')(router, db);
require('./routes/pool')(router, db);
require('./routes/dashboard')(router, db);
require('./routes/zoho')(router, db);
require('./routes/designer-public')(router, db);

// Schedule background Zoho sync (no-op until OAuth creds are set in Settings).
require('./routes/zoho').scheduleBackgroundSync(db);

// ---------------------------------------------------------------------------
// SPA fallback — sends index.html for any unmatched GET (so refresh works on
// deep URLs like /designer-tasks/active/123). NB: /d/:token has its own
// handler in designer-public.js so it serves designer.html instead.
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
