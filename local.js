// Local-dev wrapper. Mounts the sub-app's router on the same path it'll have
// in production (/designer-tasks) so frontend code is identical.
require('dotenv').config();
const express = require('express');
const router  = require('./server');

const app   = express();
const PORT  = process.env.PORT || 3001;
const MOUNT = '/designer-tasks';

app.get('/', (_req, res) => res.redirect(MOUNT + '/'));
app.use(MOUNT, router);

app.listen(PORT, () => {
  console.log(`designer-task-scheduler running at http://localhost:${PORT}${MOUNT}/`);
});
