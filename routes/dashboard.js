// Dashboard tiles + banners.
// Mounted by server.js: require('./routes/dashboard')(router, db);

const DAY_MINUTES = 480;

module.exports = function (router, db) {

  router.get('/api/dashboard', async (_req, res) => {
    try {
      const today = new Date().toISOString().slice(0, 10);

      // Tile counts
      const [poolR, activeR, agedR, capR, designersR, lastSyncR] = await Promise.all([
        db.query("SELECT COUNT(*)::int AS n FROM tasks WHERE state = 'pool'"),
        db.query("SELECT COUNT(*)::int AS n FROM tasks WHERE state = 'active'"),
        db.query(
          `SELECT COUNT(*)::int AS n FROM assignments
           WHERE NOT is_done AND assigned_date < $1`, [today]
        ),
        db.query(
          `SELECT COALESCE(SUM(minutes), 0)::int AS used
           FROM assignments WHERE assigned_date = $1`, [today]
        ),
        db.query(`SELECT COUNT(*)::int AS n FROM designers WHERE is_active`),
        db.query(`SELECT * FROM sync_log ORDER BY started_at DESC LIMIT 1`),
      ]);
      const totalCapMin = designersR.rows[0].n * DAY_MINUTES;
      const usedMin     = capR.rows[0].used;
      const capPct      = totalCapMin > 0 ? Math.round((usedMin / totalCapMin) * 100) : 0;

      // Banner data
      const { rows: agedDetails } = await db.query(`
        SELECT a.id, a.task_id, a.assigned_date::text AS assigned_date, a.minutes,
               t.task_name, t.project_name, t.source,
               d.id AS designer_id, d.name AS designer_name
        FROM assignments a
        JOIN tasks t ON t.id = a.task_id
        JOIN designers d ON d.id = a.designer_id
        WHERE NOT a.is_done AND a.assigned_date < $1
        ORDER BY a.assigned_date, d.name
      `, [today]);

      const { rows: overloadDetails } = await db.query(`
        SELECT d.id AS designer_id, d.name AS designer_name,
               SUM(a.minutes)::int AS minutes_assigned,
               (SUM(a.minutes) - $2)::int AS over_by
        FROM assignments a
        JOIN designers d ON d.id = a.designer_id
        JOIN tasks t ON t.id = a.task_id
        WHERE a.assigned_date = $1
          AND t.state != 'cancelled'
        GROUP BY d.id, d.name
        HAVING SUM(a.minutes) > $2
        ORDER BY over_by DESC
      `, [today, DAY_MINUTES]);

      // Sync banner: only show if last sync failed
      const lastSync = lastSyncR.rows[0] || null;
      const syncFailure = lastSync && lastSync.ok === false ? {
        started_at: lastSync.started_at,
        error_message: lastSync.error_message,
      } : null;

      res.json({
        date: today,
        tiles: {
          pool:               poolR.rows[0].n,
          active:             activeR.rows[0].n,
          aged:               agedR.rows[0].n,
          capacity_used_min:  usedMin,
          capacity_total_min: totalCapMin,
          capacity_pct:       capPct,
        },
        banners: {
          aged:     agedDetails,
          overload: overloadDetails,
          sync_failure: syncFailure,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
};
