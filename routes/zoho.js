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
  const headers = { 'Authorization': `Zoho-oauthtoken ${accessToken}` };

  // Zoho's cross-portal /tasks/ endpoint requires extra params we can't easily
  // satisfy (status_index, customstatus, etc.). The reliable pattern is:
  //   1. List all projects in the portal
  //   2. For each project, list its tasks
  //   3. Filter by tag client-side
  // This is N+1 calls but works on every Zoho Projects edition.

  // 1. Projects — paginated. Zoho returns max 200 per page; iterate until empty.
  // Try both 'active' and 'archived' statuses to capture any open tasks in
  // projects that have been marked complete but still have outstanding work.
  const projects = [];
  for (const status of ['active', 'archived']) {
    let from = 1;
    while (true) {
      const projectsUrl = `https://projectsapi.zoho.in/restapi/portal/${portalId}/projects/?index=${from}&range=200&status=${status}`;
      const projRes = await fetch(projectsUrl, { headers });
      const projData = await projRes.json().catch(() => ({}));
      if (!projRes.ok) {
        // If the very first page of 'active' fails, that's a real error.
        // For 'archived' page-1 failure, just skip — some Zoho editions don't expose archived.
        if (status === 'active' && from === 1) {
          throw new Error('Zoho projects fetch failed: ' +
            (projData.error?.message || projRes.statusText) +
            ' (URL: ' + projectsUrl + ')');
        }
        break;
      }
      const page = projData.projects || [];
      if (page.length === 0) break;
      projects.push(...page);
      if (page.length < 200) break;
      from += 200;
      if (from > 5000) break; // safety cap: 5000 projects is plenty
    }
  }
  if (projects.length === 0) {
    throw new Error('No projects returned from Zoho. Verify portal_id "' + portalId + '" matches your portal URL.');
  }
  console.log(`[zoho-sync] fetched ${projects.length} projects total`);

  // 2. Tasks per project (paginated)
  const collected = [];
  for (const proj of projects) {
    const pid = proj.id_string || proj.id;
    let from = 1;
    while (true) {
      const url = `https://projectsapi.zoho.in/restapi/portal/${portalId}/projects/${pid}/tasks/?index=${from}&range=200`;
      const res = await fetch(url, { headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        // Don't fail the whole sync if one project errors — log and skip
        console.error(`[zoho] tasks fetch failed for project ${pid}:`, data.error?.message || res.statusText);
        break;
      }
      const tasks = data.tasks || [];
      // Augment each task with project context (it's not always in the task body)
      for (const t of tasks) {
        t._project_id = String(pid);
        t._project_name = proj.name || '(no project name)';
      }
      collected.push(...tasks);
      if (tasks.length < 200) break;
      from += 200;
      if (from > 10000) break;
    }
  }

  console.log(`[zoho-sync] collected ${collected.length} raw tasks across ${projects.length} projects (before filter)`);

  // 3. Filter: must have the Designing tag AND not be in a closed status.
  // Zoho's status object has a `type` field set to "open" or "closed" — we use
  // that as primary signal, with name-based fallback for safety.
  const closedNames = ['closed', 'completed', 'done', 'cancelled'];
  return collected.filter(t => {
    // Skip closed tasks
    const statusType = (t.status?.type || '').toLowerCase();
    const statusName = (t.status?.name || '').toLowerCase();
    if (statusType === 'closed') return false;
    if (statusName && closedNames.includes(statusName)) return false;

    // Match the Designing tag
    const tags = t.tags || (t.details && t.details.tags) || [];
    if (tagId) return tags.some(tg => String(tg.id) === String(tagId) || String(tg.id_string) === String(tagId));
    return tags.some(tg => (tg.name || tg.tag_name || '').toLowerCase() === tagName.toLowerCase());
  });
}

async function importTasks(db, zohoTasks, triggeredBy = 'cron') {
  let inserted = 0, skipped = 0;
  for (const z of zohoTasks) {
    // Use the augmented _project_id we set during fetch (most reliable),
    // falling back to nested z.project.id or z.project_id.
    const projectId = String(z._project_id || z.project_id || z.project?.id || '');
    const taskId    = String(z.id_string || z.id || '');
    if (!projectId || !taskId) { skipped++; continue; }

    const projectName = z._project_name || z.project_name || z.project?.name || '(no project)';
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

  // ---- DEBUG: raw Zoho responses, no filtering ----
  router.get('/api/zoho/debug', async (req, res) => {
    try {
      const portalId = await getSetting(db, 'zoho_portal_id');
      if (!portalId) return res.status(400).json({ error: 'portal_id not set' });
      const accessToken = await getAccessToken(db);
      const headers = { 'Authorization': `Zoho-oauthtoken ${accessToken}` };

      // 1. Projects
      const projUrl = `https://projectsapi.zoho.in/restapi/portal/${portalId}/projects/?index=1&range=10`;
      const projRes = await fetch(projUrl, { headers });
      const projData = await projRes.json().catch(() => ({}));
      const projects = projData.projects || [];

      // 2. First project's tasks (if any) — RAW, no filter
      let sampleTasks = [];
      let sampleTaskKeys = null;
      let sampleTagShape = null;
      let sampleStatusShape = null;
      let totalTasksAcrossSampledProjects = 0;
      const sampledProjects = projects.slice(0, 3);
      for (const proj of sampledProjects) {
        const pid = proj.id_string || proj.id;
        const taskUrl = `https://projectsapi.zoho.in/restapi/portal/${portalId}/projects/${pid}/tasks/?index=1&range=10`;
        const taskRes = await fetch(taskUrl, { headers });
        const taskData = await taskRes.json().catch(() => ({}));
        const tasks = taskData.tasks || [];
        totalTasksAcrossSampledProjects += tasks.length;
        if (tasks.length > 0 && sampleTasks.length < 3) {
          sampleTasks.push(...tasks.slice(0, 3 - sampleTasks.length));
          if (!sampleTaskKeys) sampleTaskKeys = Object.keys(tasks[0]);
          if (!sampleStatusShape && tasks[0].status) sampleStatusShape = tasks[0].status;
          if (!sampleTagShape) {
            const t0 = tasks[0];
            const tg = (t0.tags && t0.tags[0]) || (t0.details && t0.details.tags && t0.details.tags[0]);
            if (tg) sampleTagShape = tg;
          }
        }
      }

      res.json({
        portal_id: portalId,
        projects_total: projects.length,
        projects_sample_names: projects.slice(0, 5).map(p => ({ id: p.id, name: p.name })),
        sampled_projects: sampledProjects.length,
        total_tasks_across_sampled_projects: totalTasksAcrossSampledProjects,
        sample_task_top_level_keys: sampleTaskKeys,
        sample_status_shape: sampleStatusShape,
        sample_tag_shape: sampleTagShape,
        sample_tasks: sampleTasks,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ---- clear all Zoho-sourced tasks in pool state (for re-import) ----
  // Only deletes from pool — Zoho tasks that were already moved to active /
  // assigned / done are preserved. Ad-hoc tasks are never touched.
  router.post('/api/zoho/clear-pool', async (req, res) => {
    try {
      const actor = (req.body?.actor || 'manual').trim();
      const { rowCount } = await db.query(
        `DELETE FROM tasks WHERE source = 'zoho' AND state = 'pool'`
      );
      // Audit (no task_id since the rows are gone)
      await db.query(
        `INSERT INTO audit_log (actor, action, after_json)
         VALUES ($1, 'cleared_zoho_pool', $2)`,
        [actor, JSON.stringify({ deleted: rowCount })]
      );
      res.json({ ok: true, deleted: rowCount });
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
