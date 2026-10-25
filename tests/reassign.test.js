const test = require('node:test');
const assert = require('node:assert/strict');
const registerCapacityRoutes = require('../routes/capacity');

function makeReassignRoute(usedMinutes = 0) {
  const queries = [];
  let releases = 0;
  const assignments = [
    { id: 1, task_id: 7, designer_id: 2, assigned_date: '2026-09-23', minutes: 60 },
    { id: 2, task_id: 7, designer_id: 2, assigned_date: '2026-09-23', minutes: 45 },
    { id: 3, task_id: 7, designer_id: 2, assigned_date: '2026-09-24', minutes: 30 },
  ];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('FROM designers WHERE')) return { rows: [{ id: 3, name: 'New designer' }] };
      if (sql.includes('FROM assignments WHERE task_id')) {
        assert.match(sql, /assigned_date::text AS assigned_date/);
        return { rows: assignments };
      }
      if (sql.includes('SUM(minutes)')) {
        assert.match(params[1], /^\d{4}-\d{2}-\d{2}$/);
        return { rows: [{ used: usedMinutes }] };
      }
      return { rows: [] };
    },
    release() { releases++; },
  };
  const handlers = {};
  const router = { post(path, handler) { handlers[path] = handler; }, get() {}, patch() {} };
  registerCapacityRoutes(router, { pool: { async connect() { return client; } } });
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return {
    queries,
    response,
    get releases() { return releases; },
    async reassign(force = false) {
      await handlers['/api/tasks/:id/reassign']({
        params: { id: '7' },
        body: { new_designer_id: 3, reason: 'Workload change', actor: 'Tester', force },
      }, response);
      return response;
    },
  };
}

test('reassign checks each calendar date, moves all slices, and audits the change', async () => {
  const route = makeReassignRoute();
  const response = await route.reassign();
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.new_designer_name, 'New designer');
  assert.deepEqual(route.queries.filter(q => q.sql.includes('SUM(minutes)')).map(q => q.params[1]), [
    '2026-09-23', '2026-09-24',
  ]);
  assert.ok(route.queries.some(q => q.sql.includes('UPDATE assignments SET designer_id')));
  assert.ok(route.queries.some(q => q.sql.includes('INSERT INTO audit_log')));
  assert.ok(route.queries.some(q => q.sql === 'COMMIT'));
  assert.equal(route.releases, 1);
});

test('reassign reports overload with calendar dates and releases the client once', async () => {
  const route = makeReassignRoute(400);
  const response = await route.reassign();
  assert.equal(response.statusCode, 422);
  assert.deepEqual(response.body.overloads.map(o => o.date), ['2026-09-23']);
  assert.equal(response.body.overloads[0].adding_minutes, 105);
  assert.ok(route.queries.some(q => q.sql === 'ROLLBACK'));
  assert.ok(!route.queries.some(q => q.sql.includes('UPDATE assignments SET designer_id')));
  assert.equal(route.releases, 1);
});

test('forced reassign moves the task after an overload warning', async () => {
  const route = makeReassignRoute(400);
  const response = await route.reassign(true);
  assert.equal(response.statusCode, 200);
  assert.ok(route.queries.some(q => q.sql.includes('UPDATE assignments SET designer_id')));
  assert.ok(route.queries.some(q => q.sql === 'COMMIT'));
  assert.equal(route.releases, 1);
});
