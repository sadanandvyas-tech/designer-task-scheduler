// Designer-facing public URL handlers.
// Path: /designer-tasks/d/<url_token>  (HTML page)
//       POST /designer-tasks/d/<url_token>/verify-pin  (PIN gate)
//       GET  /designer-tasks/api/d/<url_token>/today    (data, cookie required)
// Mounted by server.js: require('./routes/designer-public')(router, db);

const path   = require('path');
const bcrypt = require('bcryptjs');

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  h.split(';').forEach(c => {
    const i = c.indexOf('=');
    if (i === -1) return;
    out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}

module.exports = function (router, db) {

  // Serve the designer-facing HTML page (separate from the assigner index.html)
  router.get('/d/:token', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'designer.html'));
  });

  // Verify PIN; on success set a cookie scoped to /designer-tasks/
  router.post('/d/:token/verify-pin', async (req, res) => {
    try {
      const { token } = req.params;
      const pin = (req.body?.pin || '').trim();
      if (!/^\d{4}$/.test(pin)) {
        return res.status(400).json({ error: 'PIN must be 4 digits' });
      }
      const { rows } = await db.query(
        `SELECT id, name, pin_hash FROM designers
         WHERE url_token = $1 AND is_active`,
        [token]
      );
      if (rows.length === 0) {
        return res.status(404).json({ error: 'invalid URL or designer is inactive' });
      }
      const ok = await bcrypt.compare(pin, rows[0].pin_hash);
      if (!ok) return res.status(403).json({ error: 'wrong PIN' });

      // 12-hour cookie. Scoped to /designer-tasks/ so /api/d/<token>/* sees it.
      res.setHeader(
        'Set-Cookie',
        `dts_d=${token}; Path=/designer-tasks/; HttpOnly; SameSite=Lax; Max-Age=43200`
      );
      res.json({ ok: true, name: rows[0].name });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Today's queue + efficiency for this designer (cookie required)
  router.get('/api/d/:token/today', async (req, res) => {
    try {
      const { token } = req.params;
      const cookies = parseCookies(req);
      if (cookies.dts_d !== token) {
        return res.status(401).json({ error: 'PIN required' });
      }

      const { rows: dRows } = await db.query(
        `SELECT id, name FROM designers WHERE url_token = $1 AND is_active`, [token]
      );
      if (dRows.length === 0) {
        return res.status(404).json({ error: 'designer not found' });
      }
      const designer = dRows[0];
      const today = new Date().toISOString().slice(0, 10);

      // Today's assignments + any aged carry-over (past dates not yet done)
      const { rows: tasks } = await db.query(`
        SELECT a.id, a.task_id, a.assigned_date::text AS assigned_date,
               a.minutes, a.is_done,
               t.task_name, t.project_name, t.source,
               tg.name AS tag_name, tg.color_hex AS tag_color
        FROM assignments a
        JOIN tasks t ON t.id = a.task_id
        LEFT JOIN tags tg ON tg.id = t.tag_id
        WHERE a.designer_id = $1
          AND t.state != 'cancelled'
          AND (a.assigned_date = $2
               OR (a.assigned_date < $2 AND NOT a.is_done))
        ORDER BY a.assigned_date, a.id
      `, [designer.id, today]);
      for (const t of tasks) {
        t.is_aged = !t.is_done && t.assigned_date < today;
      }

      // Today's efficiency
      const { rows: tEff } = await db.query(`
        SELECT COUNT(*)::int AS total,
               COUNT(*) FILTER (
                 WHERE a.is_done AND a.done_at IS NOT NULL
                   AND a.done_at <= ((a.assigned_date::timestamp) + INTERVAL '20 hours')
               )::int AS on_time
        FROM assignments a
        JOIN tasks t ON t.id = a.task_id
        WHERE a.designer_id = $1
          AND t.state != 'cancelled'
          AND a.assigned_date = $2
      `, [designer.id, today]);

      // Month-to-date efficiency = mean of daily efficiencies
      const monthStart = today.slice(0, 7) + '-01';
      const { rows: mEff } = await db.query(`
        WITH daily AS (
          SELECT a.assigned_date,
                 COUNT(*)::int AS total,
                 COUNT(*) FILTER (
                   WHERE a.is_done AND a.done_at IS NOT NULL
                     AND a.done_at <= ((a.assigned_date::timestamp) + INTERVAL '20 hours')
                 )::int AS on_time
          FROM assignments a
          JOIN tasks t ON t.id = a.task_id
          WHERE a.designer_id = $1
            AND t.state != 'cancelled'
            AND a.assigned_date BETWEEN $2 AND $3
          GROUP BY a.assigned_date
        )
        SELECT
          COUNT(*)::int AS days_active,
          COALESCE(AVG(on_time::numeric / NULLIF(total, 0)), 0)::float AS month_eff
        FROM daily
      `, [designer.id, monthStart, today]);

      const todayPct = tEff[0].total > 0
        ? Math.round((tEff[0].on_time / tEff[0].total) * 100) : null;
      const monthPct = mEff[0].days_active > 0
        ? Math.round(mEff[0].month_eff * 100) : null;

      res.json({
        designer: { name: designer.name },
        date: today,
        tasks,
        efficiency: { today_pct: todayPct, month_pct: monthPct },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
};
