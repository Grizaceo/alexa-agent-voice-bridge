// Almacén de tareas de src/agent.js: persistencia, reinicio, TTL y entrega.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createTaskStore, INTERRUPTED_REASON } = require('../src/agent');

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-tasks-'));
  return path.join(dir, 'tasks.json');
}
const answerAfter = ms => question => new Promise(resolve => setTimeout(() => resolve({ ok: true, text: `respuesta a ${question}` }), ms));
const never = () => new Promise(() => {});

test('una tarea terminada se guarda en disco y otro proceso la lee igual', async () => {
  const file = tempFile();
  const first = createTaskStore({ file, run: answerAfter(10) });
  const started = first.startTask('qué hora es', 'voice');
  assert.equal(started.status, 'pending');
  const done = await first.waitForTask(started.id, 1000);
  assert.equal(done.status, 'done');
  assert.equal(done.answer, 'respuesta a qué hora es');
  assert.ok(done.finishedAt);

  const second = createTaskStore({ file, run: never });
  assert.deepEqual(second.getTask(started.id), done);
  // Escritura atómica: no quedan temporales junto al archivo.
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['tasks.json']);
});

test('una tarea pending al reiniciar pasa a failed con el motivo', async () => {
  const file = tempFile();
  const first = createTaskStore({ file, run: never });
  const started = first.startTask('busca algo lento', 'mcp');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0].status, 'pending');

  const events = [];
  const second = createTaskStore({ file, run: never, log: (event, payload) => events.push({ event, ...payload }) });
  const task = second.getTask(started.id);
  assert.equal(task.status, 'failed');
  assert.equal(task.answer, INTERRUPTED_REASON);
  assert.equal(task.origin, 'mcp');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).tasks[0].status, 'failed');
  assert.deepEqual(events.find(e => e.event === 'tasks_loaded'), { event: 'tasks_loaded', file, count: 1, interrupted: 1, purged: 0 });
});

test('waitForTask devuelve pending al vencer el plazo y done después', async () => {
  const store = createTaskStore({ file: tempFile(), run: answerAfter(150) });
  const started = store.startTask('resume mis correos', 'voice');
  assert.equal((await store.waitForTask(started.id, 20)).status, 'pending');
  assert.equal((await store.waitForTask(started.id, 2000)).status, 'done');
  assert.equal(store.waitForTask('no-existe', 10) instanceof Promise, true);
  assert.equal(await store.waitForTask('no-existe', 10), null);
});

test('un error del agente deja la tarea failed con el texto del error', async () => {
  const store = createTaskStore({ file: tempFile(), run: async () => { throw new Error('se cayó'); } });
  const failed = await store.waitForTask(store.startTask('x', 'voice').id, 1000);
  assert.equal(failed.status, 'failed');
  assert.match(failed.answer, /se cayó/);

  const refused = createTaskStore({ file: tempFile(), run: async () => ({ ok: false, text: 'Mango respondió con error 500: boom' }) });
  const task = await refused.waitForTask(refused.startTask('y', 'mcp').id, 1000);
  assert.equal(task.status, 'failed');
  assert.equal(task.answer, 'Mango respondió con error 500: boom');
});

test('las tareas vencen TASK_TTL_MS después de creadas, también al recargar', async () => {
  const file = tempFile();
  let clock = Date.parse('2026-10-21T12:00:00Z');
  const now = () => clock;
  const ttlMs = 60 * 1000;
  const store = createTaskStore({ file, ttlMs, now, run: answerAfter(5) });
  const old = store.startTask('vieja', 'voice');
  await store.waitForTask(old.id, 1000);
  clock += 30 * 1000;
  const fresh = store.startTask('nueva', 'mcp');
  await store.waitForTask(fresh.id, 1000);

  clock += 31 * 1000; // la primera tiene 61 s; la segunda, 31 s
  assert.equal(store.getTask(old.id), null);
  assert.deepEqual(store.listTasks({ includeDelivered: true }).map(t => t.question), ['nueva']);
  assert.equal(store.latestUndelivered().question, 'nueva');

  clock += 30 * 1000; // ahora vencen ambas, también al recargar desde disco
  const reloaded = createTaskStore({ file, ttlMs, now, run: never });
  assert.deepEqual(reloaded.listTasks({ includeDelivered: true }), []);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).tasks, []);
});

test('entrega: el Echo solo ve la última done sin entregar; cualquier superficie la marca', async () => {
  const file = tempFile();
  const runs = { primera: 10, segunda: 60, falla: 5 };
  const store = createTaskStore({
    file,
    run: question => new Promise(resolve => setTimeout(() => resolve({ ok: question !== 'falla', text: `r-${question}` }), runs[question])),
  });
  const first = store.startTask('primera', 'voice');
  const second = store.startTask('segunda', 'mcp');
  const failing = store.startTask('falla', 'voice');
  await Promise.all([first, second, failing].map(t => store.waitForTask(t.id, 1000)));

  // La última en terminar es "segunda"; una failed nunca se anuncia.
  assert.equal(store.latestUndelivered().id, second.id);
  const delivered = store.markDelivered(second.id);
  assert.ok(delivered.deliveredAt);
  assert.equal(store.latestUndelivered().id, first.id);

  // markDelivered es idempotente y persiste.
  assert.equal(store.markDelivered(second.id).deliveredAt, delivered.deliveredAt);
  const reloaded = createTaskStore({ file, run: never });
  assert.equal(reloaded.latestUndelivered().id, first.id);
  assert.deepEqual(reloaded.listTasks().map(t => t.question).sort(), ['falla', 'primera']);
  assert.equal(reloaded.listTasks({ includeDelivered: true }).length, 3);

  store.markDelivered(first.id);
  assert.equal(store.latestUndelivered(), null);
  assert.equal(store.markDelivered('no-existe'), null);
});

test('un tasks.json ilegible se aparta (no se borra) y el almacén parte vacío', () => {
  const file = tempFile();
  fs.writeFileSync(file, '{ no es json');
  const store = createTaskStore({ file, run: never });
  assert.deepEqual(store.listTasks({ includeDelivered: true }), []);
  const files = fs.readdirSync(path.dirname(file));
  assert.equal(files.length, 1);
  assert.match(files[0], /^tasks\.json\.corrupt-\d+$/);
  assert.equal(fs.readFileSync(path.join(path.dirname(file), files[0]), 'utf8'), '{ no es json');
});

test('getTask devuelve copias: modificar el resultado no altera el almacén', async () => {
  const store = createTaskStore({ file: tempFile(), run: answerAfter(5) });
  const task = await store.waitForTask(store.startTask('z', 'voice').id, 1000);
  task.status = 'pending';
  task.answer = 'otra';
  assert.equal(store.getTask(task.id).status, 'done');
  assert.equal(store.getTask(task.id).answer, 'respuesta a z');
});
