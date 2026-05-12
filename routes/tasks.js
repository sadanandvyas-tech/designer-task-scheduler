// Task CRUD — ad-hoc creation, listing by state, cancellation.
// Mounted by server.js: require('./routes/tasks')(router, db);

module.exports = function (router, db) {

  // -------- create ad-hoc task -----------------------------------------
  router.post('/api/tasks', async (req, res) => {
    try {
      const { name, project_name, tag_id, created_by } = req.body || {};
      const taskName = (name || '').trim();
      if (!taskName) return res.status(400).json({ error: 'task name is required' });

      const { rows } = await db.query(
        `INSERT INTO tasks (source, task_name, project_name, tag_id, state, created_by)
         VALUES ('adhoc', $1, $2, $3, 'active', $4)
         RETURNING id, source, task_name, project_name, tag_id, state, imported_at, created_by`,
        [
          taskName,
          (project_name || '').trim() || null,
          tag_id || null,
          (created_by || 'unknown').trim()
        ]
      );

      // Audit
      await db.query(
        `INSERT INTO audit_log (task_id, actor, action, after_json)
         VALUES ($1, $2, 'created_adhoc', $3)`,
        [rows[0].id, (created_by || 'unknown').trim(), JSON.stringify(rows[0])]
      );

      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // -------- list tasks by state ---------------------------------------
  router.get('/api/tasks', async (req, res) => {
    try {
      const state = req.query.state || 'active';
      if (!['pool', 'active', 'assigned', 'done', 'cancelled'].includes(state)) {
        return res.status(400).json({ error: 'invalid state filter' });
      }
      const { rows } = await db.query(
        `SELECT t.id, t.source, t.task_name, t.project_name,
                t.zoho_project_id, t.zoho_task_id,
                t.zoho_status_at_import, t.zoho_priority_at_import,
                t.zoho_owner_raw,
                t.tag_id, tg.name AS tag_name, tg.color_hex AS tag_color,
                t.suggested_designer_id, d.name AS suggested_designer_name,
                t.state, t.imported_at, t.created_by
         FROM tasks t
         LEFT JOIN tags tg ON tg.id = t.tag_id
         LEFT JOIN designers d ON d.id = t.suggested_designer_id
         WHERE t.state = $1
         ORDER BY t.imported_at ASC`,
        [state]
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // -------- cancel ----------------------------------------------------
  router.post('/api/tasks/:id/cancel', async (req, res) => {
    try {
      const { id } = req.params;
      const reason = (req.body?.reason || '').trim();
      const actor  = (req.body?.actor  || 'unknown').trim();
      if (!reason) return res.status(400).json({ error: 'cancellation reason is required' });

      const { rows: before } = await db.query('SELECT * FROM tasks WHERE id = $1', [id]);
      if (before.length === 0) return res.status(404).json({ error: 'task not found' });
      if (before[0].state === 'done') {
        return res.status(409).json({ error: 'task is already done; cannot cancel' });
      }

      const { rows } = await db.query(
        `UPDATE tasks SET state = 'cancelled', cancel_reason = $1
         WHERE id = $2
         RETURNING *`,
        [reason, id]
      );

      await db.query(
        `INSERT INTO audit_log (task_id, actor, action, reason, before_json, after_json)
         VALUES ($1, $2, 'cancelled', $3, $4, $5)`,
        [id, actor, reason, JSON.stringify(before[0]), JSON.stringify(rows[0])]
      );

      res.json(rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
};
