// Capacity views (Today / Week / Kanban) + assignment lifecycle actions:
//   mark done, edit, reassign, send-back.
// Mounted by server.js: require('./routes/capacity')(router, db);

const DAY_MINUTES = 480;

module.exports = function (router, db) {

  // ===================================================================
  // GET /api/capacity/today?date=YYYY-MM-DD
  // Returns each active designer with: their assignments for that date,
  // free/used minutes, aged carry-over from past days.
  // ===================================================================
  router.get('/api/capacity/today', async (req, res) => {
    try {
      const date = req.query.date || new Date().toISOString().slice(0, 10);

      const { rows: dayRows } = await db.query(`
        SELECT
          d.id AS designer_id, d.name AS designer_name,
          COALESCE(json_agg(json_build_object(
            'id', a.id,
            'task_id', a.task_id,
            'task_name', t.task_name,
            'project_name', t.project_name,
            'tag_name', tg.name,
            'tag_color', tg.color_hex,
            'source', t.source,
            'minutes', a.minutes,
            'is_done', a.is_done,
            'done_at', a.done_at,
            'assigned_date', a.assigned_date
          ) ORDER BY a.is_done, a.id) FILTER (WHERE a.id IS NOT NULL), '[]'::json) AS assignments
        FROM designers d
        LEFT JOIN assignments a ON a.designer_id = d.id AND a.assigned_date = $1
        LEFT JOIN tasks t ON t.id = a.task_id
        LEFT JOIN tags tg ON tg.id = t.tag_id
        WHERE d.is_active
        GROUP BY d.id, d.name
        ORDER BY d.name
      `, [date]);

      const { rows: agedRows } = await db.query(`
        SELECT
          a.id, a.task_id, a.designer_id, a.assigned_date, a.minutes,
          t.task_name, t.project_name, t.source,
          tg.name AS tag_name, tg.color_hex AS tag_color
        FROM assignments a
        JOIN tasks t ON t.id = a.task_id
        LEFT JOIN tags tg ON tg.id = t.tag_id
        WHERE NOT a.is_done
          AND a.assigned_date < $1
        ORDER BY a.assigned_date, a.id
      `, [date]);

      const agedByDesigner = {};
      for (const a of agedRows) {
        if (!agedByDesigner[a.designer_id]) agedByDesigner[a.designer_id] = [];
        agedByDesigner[a.designer_id].push(a);
      }

      const designers = dayRows.map(r => {
        const totalMin = (r.assignments || []).reduce((s, a) => s + a.minutes, 0);
        const doneMin  = (r.assignments || []).reduce((s, a) => s + (a.is_done ? a.minutes : 0), 0);
        const aged = agedByDesigner[r.designer_id] || [];
        return {
          designer_id: r.designer_id,
          designer_name: r.designer_name,
          assignments: r.assignments || [],
          minutes_assigned: totalMin,
          minutes_done: doneMin,
          minutes_open: totalMin - doneMin,
          minutes_free: Math.max(0, DAY_MINUTES - totalMin),
          is_overloaded: totalMin > DAY_MINUTES,
          aged_carryover: aged,
          aged_count: aged.length,
        };
      });

      const totals = {
        designer_count: designers.length,
        total_minutes_assigned: designers.reduce((s, d) => s + d.minutes_assigned, 0),
        total_minutes_done:     designers.reduce((s, d) => s + d.minutes_done, 0),
        total_capacity_minutes: designers.length * DAY_MINUTES,
        overload_count:         designers.filter(d => d.is_overloaded).length,
        aged_total:             designers.reduce((s, d) => s + d.aged_count, 0),
      };

      res.json({ date, day_minutes: DAY_MINUTES, designers, totals });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===================================================================
  // GET /api/capacity/week?start=YYYY-MM-DD
  // Returns Mon-Sat × all-active-designers grid (6 days).
  // ===================================================================
  router.get('/api/capacity/week', async (req, res) => {
    try {
      const startDate = req.query.start || mondayOf(new Date()).toISOString().slice(0, 10);
      const endDate = addDaysISO(startDate, 5);

      const { rows: cells } = await db.query(`
        SELECT
          a.designer_id, a.assigned_date::text AS the_date,
          SUM(a.minutes)::int AS minutes_assigned,
          SUM(a.minutes) FILTER (WHERE a.is_done)::int AS minutes_done,
          (SUM(a.minutes) > $3)::boolean AS is_overloaded
        FROM assignments a
        JOIN tasks t ON t.id = a.task_id
        WHERE a.assigned_date BETWEEN $1 AND $2
          AND t.state != 'cancelled'
        GROUP BY a.designer_id, a.assigned_date
      `, [startDate, endDate, DAY_MINUTES]);

      const { rows: designers } = await db.query(
        `SELECT id, name FROM designers WHERE is_active ORDER BY name`
      );

      const cellByKey = {};
      for (const c of cells) cellByKey[`${c.designer_id}|${c.the_date}`] = c;

      const dates = [];
      for (let i = 0; i < 6; i++) dates.push(addDaysISO(startDate, i));

      const grid = designers.map(d => ({
        designer_id: d.id,
        designer_name: d.name,
        cells: dates.map(date => {
          const c = cellByKey[`${d.id}|${date}`];
          return {
            date,
            minutes_assigned: c ? c.minutes_assigned : 0,
            minutes_done:     c ? c.minutes_done || 0 : 0,
            is_overloaded:    c ? c.is_overloaded : false,
          };
        }),
      }));

      res.json({ start: startDate, end: endDate, dates, day_minutes: DAY_MINUTES, grid });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===================================================================
  // POST /api/assignments/:id/done   { actor }
  // Toggle is_done. If a task's assignments are now ALL done, auto-flip
  // task.state='done' and set completed_at. If marking undone, revert.
  // ===================================================================
  router.post('/api/assignments/:id/done', async (req, res) => {
    const client = await db.pool.connect();
    let txOpen = false;
    try {
      const { id } = req.params;
      const actor = (req.body?.actor || 'unknown').trim();

      await client.query('BEGIN'); txOpen = true;

      const { rows: aRows } = await client.query(
        'SELECT * FROM assignments WHERE id = $1', [id]
      );
      if (aRows.length === 0) {
        await client.query('ROLLBACK'); txOpen = false; client.release();
        return res.status(404).json({ error: 'assignment not found' });
      }
      const a = aRows[0];
      const newDone = !a.is_done;

      await client.query(
        `UPDATE assignments SET is_done = $1, done_at = $2 WHERE id = $3`,
        [newDone, newDone ? new Date() : null, id]
      );

      // Aggregate state for the parent task
      const { rows: stat } = await client.query(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (WHERE is_done)::int AS done
        FROM assignments WHERE task_id = $1
      `, [a.task_id]);
      const allDone = stat[0].total > 0 && stat[0].done === stat[0].total;

      if (allDone) {
        await client.query(
          `UPDATE tasks SET state = 'done', completed_at = NOW() WHERE id = $1`,
          [a.task_id]
        );
      } else {
        await client.query(
          `UPDATE tasks SET state = 'assigned', completed_at = NULL WHERE id = $1 AND state = 'done'`,
          [a.task_id]
        );
      }

      await client.query(
        `INSERT INTO audit_log (task_id, actor, action, after_json)
         VALUES ($1, $2, $3, $4)`,
        [a.task_id, actor, newDone ? 'marked_done' : 'unmarked_done',
         JSON.stringify({ assignment_id: a.id, all_done: allDone })]
      );

      await client.query('COMMIT'); txOpen = false;
      res.json({ ok: true, is_done: newDone, all_done: allDone });
    } catch (err) {
      if (txOpen) { try { await client.query('ROLLBACK'); } catch (_) {} }
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // ===================================================================
  // PATCH /api/assignments/:id   { date?, minutes?, force?, actor? }
  // Edit an existing assignment slice (date and/or minutes).
  // ===================================================================
  router.patch('/api/assignments/:id', async (req, res) => {
    const client = await db.pool.connect();
    let txOpen = false;
    try {
      const { id } = req.params;
      const { date, minutes, force, actor } = req.body || {};

      if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      }
      if (minutes !== undefined) {
        const m = Number(minutes);
        if (!Number.isInteger(m) || m <= 0 || m % 15 !== 0) {
          return res.status(400).json({ error: 'minutes must be > 0 and multiple of 15' });
        }
      }
      if (date === undefined && minutes === undefined) {
        return res.status(400).json({ error: 'nothing to update' });
      }

      await client.query('BEGIN'); txOpen = true;

      const { rows: aRows } = await client.query(
        'SELECT * FROM assignments WHERE id = $1', [id]
      );
      if (aRows.length === 0) {
        await client.query('ROLLBACK'); txOpen = false; client.release();
        return res.status(404).json({ error: 'assignment not found' });
      }
      const before = aRows[0];
      const newDate    = date    !== undefined ? date           : before.assigned_date;
      const newMinutes = minutes !== undefined ? Number(minutes) : before.minutes;

      // Overload check on the destination date (subtract this assignment's old minutes if same date)
      const { rows: oth } = await client.query(`
        SELECT COALESCE(SUM(minutes), 0)::int AS used
        FROM assignments
        WHERE designer_id = $1 AND assigned_date = $2 AND id != $3
      `, [before.designer_id, newDate, id]);
      const wouldBe = oth[0].used + newMinutes;

      if (wouldBe > DAY_MINUTES && !force) {
        await client.query('ROLLBACK'); txOpen = false; client.release();
        return res.status(422).json({
          error: 'overload',
          overloads: [{
            date: newDate,
            current_minutes: oth[0].used,
            adding_minutes: newMinutes,
            total_minutes: wouldBe,
            over_by: wouldBe - DAY_MINUTES,
          }],
          message: 'Edit would push designer past 8h on that day.',
        });
      }

      const { rows: updated } = await client.query(
        `UPDATE assignments SET assigned_date = $1, minutes = $2 WHERE id = $3 RETURNING *`,
        [newDate, newMinutes, id]
      );

      await client.query(
        `INSERT INTO audit_log (task_id, actor, action, before_json, after_json)
         VALUES ($1, $2, 'edited_assignment', $3, $4)`,
        [
          before.task_id,
          (actor || 'unknown').trim(),
          JSON.stringify(before),
          JSON.stringify(updated[0]),
        ]
      );

      await client.query('COMMIT'); txOpen = false;
      res.json(updated[0]);
    } catch (err) {
      if (txOpen) { try { await client.query('ROLLBACK'); } catch (_) {} }
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // ===================================================================
  // POST /api/tasks/:id/reassign   { new_designer_id, reason, force?, actor? }
  // Change designer on ALL assignments for this task (multi-day reassigns
  // as a unit). Requires a free-text reason (audited).
  // ===================================================================
  router.post('/api/tasks/:id/reassign', async (req, res) => {
    const client = await db.pool.connect();
    let txOpen = false;
    try {
      const { id } = req.params;
      const { new_designer_id, reason, force, actor } = req.body || {};
      if (!new_designer_id) return res.status(400).json({ error: 'new_designer_id required' });
      const trimmedReason = (reason || '').trim();
      if (!trimmedReason) return res.status(400).json({ error: 'reason note required for reassignment' });

      await client.query('BEGIN'); txOpen = true;

      // Verify new designer
      const { rows: dRows } = await client.query(
        'SELECT id, name FROM designers WHERE id = $1 AND is_active', [new_designer_id]
      );
      if (dRows.length === 0) {
        await client.query('ROLLBACK'); txOpen = false; client.release();
        return res.status(400).json({ error: 'new designer not found or inactive' });
      }

      // Get all assignments for this task
      const { rows: aRows } = await client.query(
        'SELECT * FROM assignments WHERE task_id = $1 ORDER BY assigned_date', [id]
      );
      if (aRows.length === 0) {
        await client.query('ROLLBACK'); txOpen = false; client.release();
        return res.status(409).json({ error: 'task has no assignments to reassign' });
      }
      const oldDesignerId = aRows[0].designer_id;
      if (oldDesignerId === new_designer_id) {
        await client.query('ROLLBACK'); txOpen = false; client.release();
        return res.status(409).json({ error: 'task is already assigned to that designer' });
      }

      // Overload check for new designer: aggregate this task's minutes per date
      const byDate = {};
      for (const a of aRows) byDate[a.assigned_date] = (byDate[a.assigned_date] || 0) + a.minutes;

      const overloads = [];
      for (const [date, addMin] of Object.entries(byDate)) {
        const { rows } = await client.query(`
          SELECT COALESCE(SUM(minutes), 0)::int AS used
          FROM assignments WHERE designer_id = $1 AND assigned_date = $2
        `, [new_designer_id, date]);
        const wouldBe = rows[0].used + addMin;
        if (wouldBe > DAY_MINUTES) {
          overloads.push({ date, current_minutes: rows[0].used, adding_minutes: addMin, total_minutes: wouldBe, over_by: wouldBe - DAY_MINUTES });
        }
      }
      if (overloads.length > 0 && !force) {
        await client.query('ROLLBACK'); txOpen = false; client.release();
        return res.status(422).json({ error: 'overload', designer_name: dRows[0].name, overloads });
      }

      await client.query(
        `UPDATE assignments SET designer_id = $1 WHERE task_id = $2`,
        [new_designer_id, id]
      );

      await client.query(
        `INSERT INTO audit_log (task_id, actor, action, reason, before_json, after_json)
         VALUES ($1, $2, 'reassigned', $3, $4, $5)`,
        [
          id, (actor || 'unknown').trim(), trimmedReason,
          JSON.stringify({ designer_id: oldDesignerId, assignments: aRows }),
          JSON.stringify({ designer_id: new_designer_id, designer_name: dRows[0].name }),
        ]
      );

      await client.query('COMMIT'); txOpen = false;
      res.json({ ok: true, new_designer_id, new_designer_name: dRows[0].name });
    } catch (err) {
      if (txOpen) { try { await client.query('ROLLBACK'); } catch (_) {} }
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // ===================================================================
  // POST /api/tasks/:id/send-back   { reason?, actor? }
  // Delete all assignments and return task to 'pool' state.
  // Works for both Zoho and ad-hoc tasks.
  // ===================================================================
  router.post('/api/tasks/:id/send-back', async (req, res) => {
    const client = await db.pool.connect();
    let txOpen = false;
    try {
      const { id } = req.params;
      const reason = (req.body?.reason || '').trim();
      const actor  = (req.body?.actor  || 'unknown').trim();

      await client.query('BEGIN'); txOpen = true;

      const { rows: tRows } = await client.query('SELECT * FROM tasks WHERE id = $1', [id]);
      if (tRows.length === 0) {
        await client.query('ROLLBACK'); txOpen = false; client.release();
        return res.status(404).json({ error: 'task not found' });
      }
      if (tRows[0].state === 'done') {
        await client.query('ROLLBACK'); txOpen = false; client.release();
        return res.status(409).json({ error: 'cannot send a done task back to pool' });
      }

      const { rows: deleted } = await client.query(
        `DELETE FROM assignments WHERE task_id = $1 RETURNING *`, [id]
      );
      // Mark the task as manually sent back. While sent_back_at is non-NULL,
      // Zoho sync + designer-mapping auto-promote logic MUST NOT flip this
      // task back to 'active' — that flag is cleared only on explicit
      // move-to-active (routes/pool.js).
      await client.query(
        `UPDATE tasks
            SET state         = 'pool',
                completed_at  = NULL,
                sent_back_at  = NOW()
          WHERE id = $1`, [id]
      );

      await client.query(
        `INSERT INTO audit_log (task_id, actor, action, reason, before_json, after_json)
         VALUES ($1, $2, 'sent_back_to_pool', $3, $4, $5)`,
        [id, actor, reason || null, JSON.stringify(tRows[0]),
         JSON.stringify({ deleted_assignments: deleted.length, sent_back_at: 'NOW()' })]
      );

      await client.query('COMMIT'); txOpen = false;
      res.json({ ok: true, deleted_assignments: deleted.length });
    } catch (err) {
      if (txOpen) { try { await client.query('ROLLBACK'); } catch (_) {} }
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });

  // ===================================================================
  // GET /api/tasks/:id/audit
  // Return audit log entries for a single task (for the History panel).
  // ===================================================================
  router.get('/api/tasks/:id/audit', async (req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT id, actor, action, reason, before_json, after_json, at
         FROM audit_log WHERE task_id = $1 ORDER BY at DESC`,
        [req.params.id]
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
};

// ----- helpers -----
function mondayOf(d) {
  const x = new Date(d);
  const day = x.getDay() || 7; // Sun = 7
  if (day !== 1) x.setHours(-24 * (day - 1));
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDaysISO(iso, n) {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
