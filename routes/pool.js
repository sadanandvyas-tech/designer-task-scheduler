// Pool tab — list pool tasks + move-to-active (single + bulk).
// Mounted by server.js: require('./routes/pool')(router, db);

module.exports = function (router, db) {

  // List pool tasks (Zoho-imported or sent-back). Most recently imported first.
  // sent_back_at is included so the UI can render the "Returned manually" badge
  // and so callers know whether sync will auto-promote this row.
  router.get('/api/pool', async (_req, res) => {
    try {
      const { rows } = await db.query(`
        SELECT t.id, t.source, t.task_name, t.project_name,
               t.zoho_project_id, t.zoho_task_id,
               t.zoho_status_at_import, t.zoho_priority_at_import,
               t.zoho_owner_raw,
               t.tag_id, tg.name AS tag_name, tg.color_hex AS tag_color,
               t.imported_at, t.created_by, t.sent_back_at
        FROM tasks t
        LEFT JOIN tags tg ON tg.id = t.tag_id
        WHERE t.state = 'pool'
        ORDER BY t.imported_at DESC
      `);
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Single move pool -> active.
  // Clears sent_back_at so the task is once again eligible for Zoho /
  // designer-mapping auto-promote on future syncs.
  router.post('/api/tasks/:id/move-to-active', async (req, res) => {
    try {
      const { id } = req.params;
      const actor = (req.body?.actor || 'unknown').trim();
      const { rows } = await db.query(
        `UPDATE tasks
            SET state        = 'active',
                sent_back_at = NULL
          WHERE id = $1 AND state = 'pool'
         RETURNING id, task_name, state`, [id]
      );
      if (rows.length === 0) {
        return res.status(409).json({ error: 'task is not in pool state' });
      }
      await db.query(
        `INSERT INTO audit_log (task_id, actor, action) VALUES ($1, $2, 'moved_to_active')`,
        [id, actor]
      );
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Bulk move pool -> active. Same sent_back_at clear as the single-move path.
  router.post('/api/tasks/bulk-move-to-active', async (req, res) => {
    try {
      const ids = (req.body?.ids || []).map(x => parseInt(x)).filter(Boolean);
      if (ids.length === 0) return res.status(400).json({ error: 'ids array required' });
      const actor = (req.body?.actor || 'unknown').trim();

      const { rows } = await db.query(
        `UPDATE tasks
            SET state        = 'active',
                sent_back_at = NULL
          WHERE id = ANY($1::int[]) AND state = 'pool'
         RETURNING id, task_name`, [ids]
      );
      // Audit each
      for (const r of rows) {
        await db.query(
          `INSERT INTO audit_log (task_id, actor, action) VALUES ($1, $2, 'moved_to_active')`,
          [r.id, actor]
        );
      }
      res.json({ ok: true, moved: rows.length, ids: rows.map(r => r.id) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Single delete of a pool task. Scoped to state = 'pool' so an
  // Active/Assigned/Done task can never be deleted through this path.
  router.post('/api/tasks/:id/delete', async (req, res) => {
    try {
      const { id } = req.params;
      const actor = (req.body?.actor || 'unknown').trim();
      const { rows } = await db.query(
        `DELETE FROM tasks WHERE id = $1 AND state = 'pool' RETURNING id, task_name`,
        [id]
      );
      if (rows.length === 0) {
        return res.status(409).json({ error: 'task is not in pool state' });
      }
      await db.query(
        `INSERT INTO audit_log (actor, action, after_json)
         VALUES ($1, 'deleted_pool_tasks', $2)`,
        [actor, JSON.stringify({ deleted: 1, ids: [rows[0].id] })]
      );
      res.json({ ok: true, deleted: 1, id: rows[0].id });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // Bulk delete pool tasks. Scoped to state = 'pool' so an Active/Assigned/Done
  // task can never be deleted through this path. assignments + audit_log rows
  // for any deleted task are removed automatically (ON DELETE CASCADE), but a
  // pool task normally has no assignments anyway. We log the deletion without a
  // task_id (the rows are gone), mirroring the /api/zoho/clear-pool audit.
  router.post('/api/tasks/bulk-delete', async (req, res) => {
    try {
      const ids = (req.body?.ids || []).map(x => parseInt(x)).filter(Boolean);
      if (ids.length === 0) return res.status(400).json({ error: 'ids array required' });
      const actor = (req.body?.actor || 'unknown').trim();

      const { rows } = await db.query(
        `DELETE FROM tasks
          WHERE id = ANY($1::int[]) AND state = 'pool'
         RETURNING id`, [ids]
      );
      const deletedIds = rows.map(r => r.id);
      await db.query(
        `INSERT INTO audit_log (actor, action, after_json)
         VALUES ($1, 'deleted_pool_tasks', $2)`,
        [actor, JSON.stringify({ deleted: deletedIds.length, ids: deletedIds })]
      );
      res.json({ ok: true, deleted: deletedIds.length, ids: deletedIds });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
};
