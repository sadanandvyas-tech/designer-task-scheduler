const { Pool } = require('pg');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');

// Read THIS app's .env directly into a local object — do NOT touch process.env.
// When mounted as a sub-router inside another app (e.g. /var/www/5s-tracker),
// the parent has already called dotenv.config() and process.env.DATABASE_URL
// points at the parent's database. dotenv.config() refuses to override existing
// env vars by default, so we'd silently use the wrong DB. Reading our own
// .env directly with dotenv.parse() avoids the conflict entirely.
const envPath = path.join(__dirname, '.env');
const localEnv = fs.existsSync(envPath)
  ? dotenv.parse(fs.readFileSync(envPath))
  : {};
const get = (k) => (localEnv[k] !== undefined ? localEnv[k] : process.env[k]);

const pool = new Pool(
  get('DATABASE_URL')
    ? { connectionString: get('DATABASE_URL') }
    : {
        host:     get('PGHOST')     || 'localhost',
        port:     get('PGPORT')     || 5432,
        user:     get('PGUSER')     || 'postgres',
        password: get('PGPASSWORD'),
        database: get('PGDATABASE') || 'designer_task_scheduler',
      }
);

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
  get, // expose env getter for other modules (Zoho client, etc.)
};
