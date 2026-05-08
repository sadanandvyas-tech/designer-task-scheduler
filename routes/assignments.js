// Assignment creation + per-day availability query.
// Mounted by server.js: require('./routes/assignments')(router, db);

const DAY_MINUTES = 480;  // 8h cap per spec

module.exports = function (router, db) {

  // -------- availability for a date -----------------------------------
  // Returns each active designer's minutes_assigned + free + overload flag.
  router.get('/api/availability', async (req, res) => {
    try {
      const date = req.query.date || new Date().toISOString().slice(0, 10);
      const { rows } = await db.query(
        `SELECT d.id, d.name,
                COALESCE(SUM(a.minutes), 0)::int AS minutes_assigned
         FROM designers d
         LEFT JOIN assignments a ON a.designer_id = d.id AND a.assigned_date = $1
         WHERE d.is_active
         GROUP BY d.id, d.name
         ORDER BY minutes_assigned ASC, d.name`,
        [date]
      );
      const designers = rows.map(r => ({
        id: r.id,
        name: r.name,
        minutes_assigned: r.minutes_assigned,
        minutes_free: Math.max(0, DAY_MINUTES - r.minutes_assigned),
        is_overloaded: r.minutes_assigned > DAY_MINUTES,
      }));
      res.json({ date, day_minutes: DAY_MINUTES, designers });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // -------- assign a task ---------------------------------------------
  // Body: { designer_id, slices: [{date, minutes}, ...], force?: bool, actor?: string }
  // Multi-day = multiple slices, all to the SAME designer.
  // If would push designer past 8h on any day, returns 422 with overload details
  // unless force=true.
  router.post('/api/tasks/:id/assign', async (req, res) => {
    const client = await db.pool.connect();
    let txOpen = false;
    try {
      const { id } = req.params;
      const { designer_id, slices, force, actor } = req.body || {};

      // ---- input validation ----
      if (!designer_id) {
        return res.status(400).json({ error: 'designer_id is required' });
      }
      if (!Array.isArray(slices) || slices.length === 0) {
        return res.status(400).json({ error: 'slices array (at least one) is required' });
      }
      for (const s of slices) {
        if (!s.date || !/^\d{4}-\d{2}-\d{2}$/.test(s.date)) {
          return res.status(400).json({ error: 'each slice needs a YYYY-MM-DD date' });
        }
        const m = Number(s.minutes);
        if (!Number.isInteger(m) || m <= 0 || m % 15 !== 0) {
          return res.status(400).json({ error: 'each slice needs minutes > 0 and multiple of 15' });
        }
      }

      await client.query('BEGIN');
      txOpen = true;

      // ---- verify designer ----
      const { rows: dRows } = await client.query(
        'SELECT id, name FROM designers WHERE id = $1 AND is_active',
        [designer_id]
      );
      if (dRows.length === 0) {
        await client.query('ROLLBACK'); txOpen = false;
        return res.status(400).json({ error: 'designer not found or inactive' });
      }

      // ---- verify task ----
      const { rows: tRows } = await client.query(
        'SELECT * FROM tasks WHERE id = $1', [id]
      );
      if (tRows.length === 0) {
        await client.query('ROLLBACK'); txOpen = false;
        return res.status(404).json({ error: 'task not found' });
      }
      if (!['active', 'pool'].includes(tRows[0].state)) {
        await client.query('ROLLBACK'); txOpen = false;
        return res.status(409).json({
          error: `task is in '${tRows[0].state}' state; can only assign from active or pool`
        });
      }

      // ---- overload check per slice date ----
      // (Sum existing minutes for that (designer, date) and add this slice.)
      const overloads = [];
      // Aggregate this batch's slices per date in case multiple slices target the same day
      const batchByDate = {};
      for (const s of slices) {
        batchByDate[s.date] = (batchByDate[s.date] || 0) + Number(s.minutes);
      }
      for (const [date, addMin] of Object.entries(batchByDate)) {
        const { rows } = await client.query(
          `SELECT COALESCE(SUM(minutes), 0)::int AS used
           FROM assignments WHERE designer_id = $1 AND assigned_date = $2`,
          [designer_id, date]
        );
        const wouldBe = rows[0].used + addMin;
        if (wouldBe > DAY_MINUTES) {
          overloads.push({
            date,
            current_minutes: rows[0].used,
            adding_minutes: addMin,
            total_minutes: wouldBe,
            over_by: wouldBe - DAY_MINUTES,
          });
        }
      }

      if (overloads.length > 0 && !force) {
        await client.query('ROLLBACK'); txOpen = false;
        return res.status(422).json({
          error: 'overload',
          designer_name: dRows[0].name,
          overloads,
          message: `Would push ${dRows[0].name} past 8h on ${overloads.length} day(s).`
        });
      }

      // ---- insert assignment rows ----
      const inserted = [];
      for (const s of slices) {
        const { rows } = await client.query(
          `INSERT INTO assignments (task_id, designer_id, assigned_date, minutes)
           VALUES ($1, $2, $3, $4) RETURNING *`,
          [id, designer_id, s.date, Number(s.minutes)]
        );
        inserted.push(rows[0]);
      }

      // ---- update task state ----
      await client.query(
        `UPDATE tasks SET state = 'assigned' WHERE id = $1`, [id]
      );

      // ---- audit ----
      await client.query(
        `INSERT INTO audit_log (task_id, actor, action, after_json)
         VALUES ($1, $2, 'assigned', $3)`,
        [
          id,
          (actor || 'unknown').trim(),
          JSON.stringify({
            designer_id, designer_name: dRows[0].name,
            slices: inserted, overloaded: overloads.length > 0
          })
        ]
      );

      await client.query('COMMIT'); txOpen = false;

      res.json({
        ok: true,
        designer_id,
        designer_name: dRows[0].name,
        slices: inserted,
        overloaded: overloads.length > 0,
      });
    } catch (err) {
      if (txOpen) { try { await client.query('ROLLBACK'); } catch (_) {} }
      res.status(500).json({ error: err.message });
    } finally {
      client.release();
    }
  });
};
