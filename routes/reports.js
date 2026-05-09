// Reports / efficiency + Completed-tasks log.
// Per-spec: efficiency = on-time-done / assigned (count-based, cancelled excluded).
// On-time = done_at on or before 20:00 of the assigned_date.
// V1 simplification: per-assignment (each (date, hours) slice is a unit).
// Mounted by server.js: require('./routes/reports')(router, db);

module.exports = function (router, db) {

  // ===================================================================
  // GET /api/reports/daily?from=YYYY-MM-DD&to=YYYY-MM-DD&designer_id?=
  // Returns one row per (designer, date): total + on_time_done + late_done.
  // ===================================================================
  router.get('/api/reports/daily', async (req, res) => {
    try {
      const from = req.query.from || lastNDaysISO(30);
      const to   = req.query.to   || todayISO();
      const designerId = req.query.designer_id ? parseInt(req.query.designer_id) : null;

      const params = [from, to];
      let where = `t.state != 'cancelled'
                   AND a.assigned_date BETWEEN $1 AND $2`;
      if (designerId) {
        params.push(designerId);
        where += ` AND a.designer_id = $${params.length}`;
      }

      const { rows } = await db.query(`
        SELECT
          a.designer_id,
          d.name AS designer_name,
          a.assigned_date::text AS date,
          COUNT(*)::int AS total,
          COUNT(*) FILTER (
            WHERE a.is_done
              AND a.done_at IS NOT NULL
              AND a.done_at <= ((a.assigned_date::timestamp) + INTERVAL '20 hours')
          )::int AS on_time_done,
          COUNT(*) FILTER (WHERE a.is_done)::int AS done_total,
          COUNT(*) FILTER (
            WHERE a.is_done
              AND a.done_at > ((a.assigned_date::timestamp) + INTERVAL '20 hours')
          )::int AS late_done
        FROM assignments a
        JOIN tasks t ON t.id = a.task_id
        JOIN designers d ON d.id = a.designer_id
        WHERE ${where}
        GROUP BY a.designer_id, d.name, a.assigned_date
        ORDER BY d.name, a.assigned_date
      `, params);

      const series = rows.map(r => ({
        ...r,
        efficiency_pct: r.total > 0 ? Math.round((r.on_time_done / r.total) * 100) : null,
      }));

      res.json({ from, to, series });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===================================================================
  // GET /api/reports/summary?from=YYYY-MM-DD&to=YYYY-MM-DD
  // Per-designer rollup: monthly_efficiency = mean of daily efficiencies
  // (skipping days with zero assignments).
  // ===================================================================
  router.get('/api/reports/summary', async (req, res) => {
    try {
      const from = req.query.from || firstOfMonthISO();
      const to   = req.query.to   || todayISO();

      const { rows } = await db.query(`
        WITH daily AS (
          SELECT
            a.designer_id,
            a.assigned_date,
            COUNT(*)::int AS total,
            COUNT(*) FILTER (
              WHERE a.is_done
                AND a.done_at IS NOT NULL
                AND a.done_at <= ((a.assigned_date::timestamp) + INTERVAL '20 hours')
            )::int AS on_time
          FROM assignments a
          JOIN tasks t ON t.id = a.task_id
          WHERE t.state != 'cancelled'
            AND a.assigned_date BETWEEN $1 AND $2
          GROUP BY a.designer_id, a.assigned_date
        )
        SELECT
          d.id AS designer_id,
          d.name AS designer_name,
          COALESCE(COUNT(daily.assigned_date), 0)::int AS days_active,
          COALESCE(SUM(daily.total), 0)::int AS total_assignments,
          COALESCE(SUM(daily.on_time), 0)::int AS total_on_time,
          CASE
            WHEN COUNT(daily.assigned_date) = 0 THEN NULL
            ELSE AVG(daily.on_time::numeric / NULLIF(daily.total, 0))::float
          END AS efficiency_avg
        FROM designers d
        LEFT JOIN daily ON daily.designer_id = d.id
        WHERE d.is_active
        GROUP BY d.id, d.name
        ORDER BY efficiency_avg DESC NULLS LAST, d.name
      `, [from, to]);

      const summary = rows.map(r => ({
        ...r,
        efficiency_pct: r.efficiency_avg != null ? Math.round(r.efficiency_avg * 100) : null,
      }));

      const teamTotals = {
        from, to,
        total_assignments: summary.reduce((s, r) => s + r.total_assignments, 0),
        total_on_time:     summary.reduce((s, r) => s + r.total_on_time, 0),
      };
      teamTotals.team_efficiency_pct = teamTotals.total_assignments > 0
        ? Math.round((teamTotals.total_on_time / teamTotals.total_assignments) * 100)
        : null;

      res.json({ from, to, designers: summary, team: teamTotals });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ===================================================================
  // GET /api/completed?from=&to=&designer_id?=
  // List of done tasks with designer + total hours + on-time flag.
  // ===================================================================
  router.get('/api/completed', async (req, res) => {
    try {
      const from = req.query.from || lastNDaysISO(30);
      const to   = req.query.to   || todayISO();
      const designerId = req.query.designer_id ? parseInt(req.query.designer_id) : null;

      const params = [from, to];
      let where = `t.state = 'done'
                   AND t.completed_at >= $1::timestamp
                   AND t.completed_at < ($2::date + INTERVAL '1 day')`;
      if (designerId) {
        params.push(designerId);
        where += ` AND a.designer_id = $${params.length}`;
      }

      const { rows } = await db.query(`
        SELECT
          t.id AS task_id, t.task_name, t.project_name, t.source,
          t.completed_at, tg.name AS tag_name,
          d.id AS designer_id, d.name AS designer_name,
          SUM(a.minutes)::int AS total_minutes,
          MAX(a.assigned_date)::text AS final_date,
          (t.completed_at <= ((MAX(a.assigned_date)::timestamp) + INTERVAL '20 hours'))::boolean AS on_time
        FROM tasks t
        JOIN assignments a ON a.task_id = t.id
        JOIN designers d ON d.id = a.designer_id
        LEFT JOIN tags tg ON tg.id = t.tag_id
        WHERE ${where}
        GROUP BY t.id, t.task_name, t.project_name, t.source,
                 t.completed_at, tg.name, d.id, d.name
        ORDER BY t.completed_at DESC
      `, params);

      res.json({ from, to, items: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
};

function todayISO() { return new Date().toISOString().slice(0, 10); }
function lastNDaysISO(n) {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function firstOfMonthISO() {
  const d = new Date(); d.setDate(1);
  return d.toISOString().slice(0, 10);
}
