// scripts/init-db.js — applies schema.sql and seeds default tags / settings.
// Idempotent: safe to run repeatedly.

const fs   = require('fs');
const path = require('path');
const db   = require('../db');

async function main() {
  // 1. Apply schema
  const sql = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  console.log('Applying schema...');
  await db.query(sql);

  // 2. Seed default tags (only if the table is empty)
  const tagCount = await db.query('SELECT COUNT(*)::int AS n FROM tags');
  if (tagCount.rows[0].n === 0) {
    console.log('Seeding default ad-hoc task tags...');
    const defaultTags = [
      { name: 'Internal',  color: '#dbeafe', sort: 10 },
      { name: 'Rework',    color: '#fee2e2', sort: 20 },
      { name: 'Training',  color: '#d1fae5', sort: 30 },
      { name: 'Admin',     color: '#f3f4f6', sort: 40 },
      { name: 'Meeting',   color: '#fef3c7', sort: 50 },
      { name: 'Misc',      color: '#ede9fe', sort: 60 },
    ];
    for (const t of defaultTags) {
      await db.query(
        'INSERT INTO tags (name, color_hex, sort_order) VALUES ($1, $2, $3)',
        [t.name, t.color, t.sort]
      );
    }
  }

  // 3. Seed an empty assigner_names list if missing — assigner adds names in Settings later
  const an = await db.query("SELECT 1 FROM settings WHERE key = 'assigner_names'");
  if (an.rowCount === 0) {
    await db.query(
      "INSERT INTO settings (key, value) VALUES ('assigner_names', '[]')"
    );
  }

  console.log('Done.');
  process.exit(0);
}

main().catch((err) => {
  console.error('init-db failed:', err);
  process.exit(1);
});
