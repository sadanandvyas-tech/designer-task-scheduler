// Zoho Projects integration — scaffold.
// Reads OAuth credentials from the `settings` table. Set them via Settings UI:
//   zoho_client_id, zoho_client_secret, zoho_refresh_token,
//   zoho_portal_id, zoho_designing_tag_id (or zoho_designing_tag_name)
//
// Refresh-token flow:
//   POST https://accounts.zoho.in/oauth/v2/token
//     ?refresh_token=...&client_id=...&client_secret=...&grant_type=refresh_token
//   -> { access_token, expires_in, ... }
// Tasks list (filtered by tag):
//   GET https://projectsapi.zoho.in/restapi/portal/{portal_id}/projects/{project_id}/tasks/
//   (or /portal/{portal_id}/tasks/ across all projects, then filter)
//
// Note: account region varies (.in / .com / .eu). Keep .in as default since
// the existing portal at operation.yotser.in indicates an Indian Zoho account.
//
// Mounted by server.js: require('./routes/zoho')(router, db);

let inflightSync = false;     // simple lock so 5-min poll + manual click don't collide
let cachedToken  = null;      // { access_token, expires_at_ms }

async function getSetting(db, key) {
  const { rows } = await db.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : null;
}
async function setSetting(db, key, value) {
  await db.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value]
  );
}

async function getAccessToken(db) {
  if (cachedToken && cachedToken.expires_at_ms > Date.now() + 60_000) {
    return cachedToken.access_token;
  }
  const clientId     = await getSetting(db, 'zoho_client_id');
  const clientSecret = await getSetting(db, 'zoho_client_secret');
  const refreshToken = await getSetting(db, 'zoho_refresh_token');
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Zoho not configured: missing client_id, client_secret, or refresh_token in Settings.');
  }
  const url = `https://accounts.zoho.in/oauth/v2/token` +
    `?refresh_token=${encodeURIComponent(refreshToken)}` +
    `&client_id=${encodeURIComponent(clientId)}` +
    `&client_secret=${encodeURIComponent(clientSecret)}` +
    `&grant_type=refresh_token`;
  const res = await fetch(url, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.access_token) {
    throw new Error('Zoho refresh failed: ' + (data.error || res.statusText));
  }
  cachedToken = {
    access_token: data.access_token,
    expires_at_ms: Date.now() + (data.expires_in || 3600) * 1000,
  };
  return data.access_token;
}

async function fetchDesigningTasks(db) {
  const portalId = await getSetting(db, 'zoho_portal_id');
  if (!portalId) throw new Error('Zoho not configured: missing portal_id in Settings.');
  const tagId = await getSetting(db, 'zoho_designing_tag_id');
  const tagName = await getSetting(db, 'zoho_designing_tag_name') || 'Designing';

  const accessToken = await getAccessToken(db);

  // Endpoint: list tasks across the portal. Pagination: 200/page max per Zoho.
  // We paginate and stop when fewer than 200 returned.
  const collected = [];
  let from = 1;
  while (true) {
    const url = `https://projectsapi.zoho.in/restapi/portal/${portalId}/tasks/` +
                `?index=${from}&range=200`;
    const res = await fetch(url, {
      headers: { 'Authorization': `Zoho-oauthtoken ${accessToken}` }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error('Zoho tasks fetch failed: ' + (data.error?.message || res.statusText));
    }
    const tasks = data.tasks || [];
    collected.push(...tasks);
    if (tasks.length < 200) break;
    from += 200;
    if (from > 10000) break; // safety
  }

  // Filter by tag — match by tag_id if set, else fuzzy by name.
  return collected.filter(t => {
    const tags = t.tags || [];
    if (tagId) return tags.some(tg => String(tg.id) === String(tagId));
    return tags.some(tg => (tg.name || '').toLowerCase() === tagName.toLowerCase());
  });
}

async function importTasks(db, zohoTasks, triggeredBy = 'cron') {
  let inserted = 0, skipped = 0;
  for (const z of zohoTasks) {
    const projectId = String(z.project_id || z.project?.id || '');
    const taskId    = String(z.id || z.id_string || '');
    if (!projectId || !taskId) { skipped++; continue; }

    const projectName = z.project_name || z.project?.name || '(no project)';
    const taskName    = z.name || z.title || '(unnamed)';
    const status      = z.status?.name || z.status_name || null;
    const priority    = z.priority || null;

    try {
      const r = await db.query(
        `INSERT INTO tasks (source, zoho_project_id, zoho_task_id, task_name, project_name,
                            zoho_status_at_import, zoho_priority_at_import, state, created_by)
         VALUES ('zoho', $1, $2, $3, $4, $5, $6, 'pool', 'zoho-sync')
         ON CONFLICT (zoho_project_id, zoho_task_id) WHERE source = 'zoho' DO NOTHING
         RETURNING id`,
        [projectId, taskId, taskName, projectName, status, priority]
      );
      if (r.rowCount > 0) {
        inserted++;
        await db.query(
          `INSERT INTO audit_log (task_id, actor, action, after_json)
           VALUES ($1, 'zoho-sync', 'imported', $2)`,
          [r.rows[0].id, JSON.stringify({ projectId, taskId, taskName })]
        );
      } else {
        skipped++;
      }
    } catch (e) {
      // Continue on individual row errors; we log to sync_log at the end.
      skipped++;
    }
  }
  return { inserted, skipped };
}

async function runSync(db, triggeredBy = 'cron') {
  if (inflightSync) {
    return { ok: false, error: 'sync already running' };
  }
  inflightSync = true;
  const { rows: logRow } = await db.query(
    `INSERT INTO sync_log (trigger_type, triggered_by) VALUES ($1, $2) RETURNING id`,
    [triggeredBy === 'cron' ? 'scheduled' : 'manual', triggeredBy]
  );
  const syncId = logRow[0].id;
  try {
    const tasks = await fetchDesigningTasks(db);
    const { inserted, skipped } = await importTasks(db, tasks, triggeredBy);
    await db.query(
      `UPDATE sync_log SET finished_at = NOW(), tasks_seen = $1, tasks_new = $2, tasks_skipped = $3, ok = TRUE
       WHERE id = $4`,
      [tasks.length, inserted, skipped, syncId]
    );
    await setSetting(db, 'last_sync_at', new Date().toISOString());
    return { ok: true, tasks_seen: tasks.length, tasks_new: inserted, tasks_skipped: skipped };
  } catch (err) {
    await db.query(
      `UPDATE sync_log SET finished_at = NOW(), ok = FALSE, error_message = $1 WHERE id = $2`,
      [err.message, syncId]
    );
    return { ok: false, error: err.message };
  } finally {
    inflightSync = false;
  }
}

module.exports = function (router, db) {

  // ---- status ----
  router.get('/api/zoho/status', async (_req, res) => {
    try {
      const cfg = {
        client_id_set:     !!(await getSetting(db, 'zoho_client_id')),
        client_secret_set: !!(await getSetting(db, 'zoho_client_secret')),
        refresh_token_set: !!(await getSetting(db, 'zoho_refresh_token')),
        portal_id:         await getSetting(db, 'zoho_portal_id'),
        designing_tag_id:  await getSetting(db, 'zoho_designing_tag_id'),
        designing_tag_name: await getSetting(db, 'zoho_designing_tag_name') || 'Designing',
        last_sync_at:      await getSetting(db, 'last_sync_at'),
      };
      cfg.connected = cfg.client_id_set && cfg.client_secret_set
        && cfg.refresh_token_set && !!cfg.portal_id;

      // Last 5 sync attempts
      const { rows: recent } = await db.query(
        `SELECT * FROM sync_log ORDER BY started_at DESC LIMIT 5`
      );
      res.json({ config: cfg, recent_syncs: recent });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ---- save settings ----
  router.post('/api/zoho/settings', async (req, res) => {
    try {
      const allowed = [
        'zoho_client_id', 'zoho_client_secret', 'zoho_refresh_token',
        'zoho_portal_id', 'zoho_designing_tag_id', 'zoho_designing_tag_name',
      ];
      for (const key of allowed) {
        if (req.body && req.body[key] !== undefined && req.body[key] !== '') {
          await setSetting(db, key, String(req.body[key]).trim());
        }
      }
      cachedToken = null; // force refresh on next sync
      res.json({ ok: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ---- manual sync trigger ----
  router.post('/api/zoho/sync', async (req, res) => {
    try {
      const actor = (req.body?.actor || 'manual').trim();
      const result = await runSync(db, actor);
      if (!result.ok) return res.status(502).json(result);
      res.json(result);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ---- recent sync log (for the banner) ----
  router.get('/api/zoho/last-sync', async (_req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT * FROM sync_log ORDER BY started_at DESC LIMIT 1`
      );
      res.json(rows[0] || null);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
};

// Background scheduler — kicks off every 5 minutes if creds are configured.
// server.js calls module.scheduleBackgroundSync(db) once at boot.
module.exports.scheduleBackgroundSync = function (db) {
  const FIVE_MIN_MS = 5 * 60 * 1000;
  const tick = async () => {
    try {
      const ready = await getSetting(db, 'zoho_client_id')
        && await getSetting(db, 'zoho_client_secret')
        && await getSetting(db, 'zoho_refresh_token')
        && await getSetting(db, 'zoho_portal_id');
      if (ready) await runSync(db, 'cron');
    } catch (e) {
      console.error('[designer-task-scheduler] zoho cron tick failed:', e.message);
    }
  };
  // Initial tick after 60s (let server fully boot), then every 5 min.
  setTimeout(tick, 60_000);
  setInterval(tick, FIVE_MIN_MS);
};
