// Ad-hoc task tag list (read-only for now; full CRUD in a later phase).
// Mounted by server.js: require('./routes/tags')(router, db);

module.exports = function (router, db) {

  router.get('/api/tags', async (_req, res) => {
    try {
      const { rows } = await db.query(
        `SELECT id, name, color_hex, sort_order, is_active
         FROM tags
         WHERE is_active
         ORDER BY sort_order, name`
      );
      res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
};
