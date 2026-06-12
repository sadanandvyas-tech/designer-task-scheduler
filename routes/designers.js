// Designer roster CRUD.
// Mounted by server.js: require('./routes/designers')(router, db);

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

module.exports = function (router, db) {

  // --------- list -------------------------------------------------------
  router.get('/api/designers', async (_req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT id, name, url_token, is_active, zoho_user_id, zoho_user_name, created_at
         FROM designers
         ORDER BY is_active DESC, name`
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // --------- create -----------------------------------------------------
  router.post('/api/designers', async (req, res) => {
    try {
      const name = (req.body.name || '').trim();
      const pin  = (req.body.pin  || '').trim();
      if (!name)             return res.status(400).json({ error: 'name is required' });
      if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be exactly 4 digits' });

      const token   = crypto.randomBytes(8).toString('hex');           // 16-char opaque
      const pinHash = await bcrypt.hash(pin, 10);

      const { rows } = await db.query(
        `INSERT INTO designers (name, url_token, pin_hash)
         VALUES ($1, $2, $3)
         RETURNING id, name, url_token, is_active, created_at`,
        [name, token, pinHash]
      );
      res.json(rows[0]);
    } catch (err) {
      if (err.code === '23505')                                         // unique_violation
        return res.status(409).json({ error: 'A designer with that name already exists' });
      res.status(500).json({ error: err.message });
    }
  });

  // --------- update -----------------------------------------------------
  router.patch('/api/designers/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const { name, pin, is_active, zoho_user_id, zoho_user_name } = req.body || {};

      const sets = [];
      const vals = [];

      if (name !== undefined) {
        const trimmed = String(name).trim();
        if (!trimmed) return res.status(400).json({ error: 'name cannot be empty' });
        vals.push(trimmed);
        sets.push(`name = $${vals.length}`);
      }
      if (pin !== undefined) {
        if (!/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN must be exactly 4 digits' });
        const hash = await bcrypt.hash(pin, 10);
        vals.push(hash);
        sets.push(`pin_hash = $${vals.length}`);
      }
      if (is_active !== undefined) {
        vals.push(!!is_active);
        sets.push(`is_active = $${vals.length}`);
      }
      // Zoho user pairing — empty string clears the mapping (unpair)
      if (zoho_user_id !== undefined) {
        const v = String(zoho_user_id || '').trim() || null;
        vals.push(v);
        sets.push(`zoho_user_id = $${vals.length}`);
      }
      if (zoho_user_name !== undefined) {
        const v = String(zoho_user_name || '').trim() || null;
        vals.push(v);
        sets.push(`zoho_user_name = $${vals.length}`);
      }
      if (sets.length === 0) return res.status(400).json({ error: 'nothing to update' });

      vals.push(id);
      const { rows } = await db.query(
        `UPDATE designers SET ${sets.join(', ')}
         WHERE id = $${vals.length}
         RETURNING id, name, url_token, is_active, zoho_user_id, zoho_user_name, created_at`,
        vals
      );
      if (rows.length === 0) return res.status(404).json({ error: 'designer not found' });

      // Self-healing: if we just SET a zoho_user_id, retro-promote any pool
      // tasks owned by that Zoho user — assigner doesn't have to wait for the
      // next hourly sync to see them pre-filled.
      // Tasks the assigner manually returned to Pool (sent_back_at IS NOT NULL)
      // are intentionally excluded — they must stay in Pool until the assigner
      // explicitly moves them, mirroring the Zoho sync guard.
      let promoted = 0;
      const newZohoId = rows[0].zoho_user_id;
      if (zoho_user_id !== undefined && newZohoId) {
        const prom = await db.query(
          `UPDATE tasks
              SET state = 'active', suggested_designer_id = $1
            WHERE source = 'zoho'
              AND state = 'pool'
              AND sent_back_at IS NULL
              AND zoho_owner_raw->>'id' = $2
           RETURNING id`,
          [rows[0].id, newZohoId]
        );
        promoted = prom.rowCount;
        for (const t of prom.rows) {
          await db.query(
            `INSERT INTO audit_log (task_id, actor, action, after_json)
             VALUES ($1, $2, 'auto_promoted_via_mapping', $3)`,
            [t.id, (req.body?.actor || 'unknown').toString().trim(),
             JSON.stringify({ designer_id: rows[0].id, zoho_user_id: newZohoId })]
          );
        }
      }

      res.json({ ...rows[0], promoted });
    } catch (err) {
      if (err.code === '23505') {
        // Could be either name collision or zoho_user_id collision — try to disambiguate.
        const detail = (err.detail || '').toLowerCase();
        if (detail.includes('zoho_user_id'))
          return res.status(409).json({ error: 'That Zoho user is already paired to another designer.' });
        return res.status(409).json({ error: 'A designer with that name already exists' });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // --------- delete (with open-assignment guard) ------------------------
  router.delete('/api/designers/:id', async (req, res) => {
    try {
      const { id } = req.params;
      const open = await db.query(
        `SELECT COUNT(*)::int AS n FROM assignments
         WHERE designer_id = $1 AND is_done = false`,
        [id]
      );
      if (open.rows[0].n > 0) {
        return res.status(409).json({
          error: `Cannot delete: this designer has ${open.rows[0].n} open assignment(s). Reassign or close them first.`
        });
      }
      const { rowCount } = await db.query('DELETE FROM designers WHERE id = $1', [id]);
      if (rowCount === 0) return res.status(404).json({ error: 'designer not found' });
      res.json({ ok: true });
    } catch (err) {
      // FK violation possible if designer is still referenced by completed assignments
      if (err.code === '23503')
        return res.status(409).json({
          error: 'Cannot delete: designer is referenced by historical records. Mark them inactive instead.'
        });
      res.status(500).json({ error: err.message });
    }
  });

  // --------- regenerate URL token (rotation) ----------------------------
  router.post('/api/designers/:id/rotate-token', async (req, res) => {
    try {
      const { id } = req.params;
      const token = crypto.randomBytes(8).toString('hex');
      const { rows } = await db.query(
        `UPDATE designers SET url_token = $1 WHERE id = $2
         RETURNING id, name, url_token, is_active`,
        [token, id]
      );
      if (rows.length === 0) return res.status(404).json({ error: 'designer not found' });
      res.json(rows[0]);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
};
