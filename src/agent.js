// El agente y su almacén de tareas largas, compartidos por la skill de voz y el servidor MCP.
// Un solo dueño por despliegue: no hay separación por usuario.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Mango';
const HERMES_GATEWAY_URL = (process.env.HERMES_GATEWAY_URL || 'http://127.0.0.1:8642/v1/chat/completions').replace(/\/+$/, '');
const HERMES_GATEWAY_TOKEN = process.env.HERMES_GATEWAY_TOKEN || process.env.API_SERVER_KEY || '';
const HERMES_API_MODEL = process.env.HERMES_API_MODEL || 'hermes-agent';
const HERMES_MAX_WAIT_MS = Number(process.env.HERMES_MAX_WAIT_MS || 600000);
const TASKS_FILE = path.resolve(process.env.TASKS_FILE || path.join(__dirname, '..', 'data', 'tasks.json'));
const TASK_TTL_MS = Number(process.env.TASK_TTL_MS || 24 * 60 * 60 * 1000);
const INTERRUPTED_REASON = 'Tarea interrumpida por reinicio.';

// Llama al endpoint /v1/chat/completions del agente. Nunca lanza: los errores vuelven como { ok: false, text }.
async function callAgent(question, { history = [], hermesSessionKey = null } = {}) {
  const url = HERMES_GATEWAY_URL;
  if (!url) {
    return { ok: false, text: 'Falta configurar la URL del gateway del agente.' };
  }

  const messages = (history || []).map(entry => ({ role: entry.role, content: entry.content }));
  messages.push({ role: 'user', content: question });

  const body = {
    model: HERMES_API_MODEL,
    messages,
    max_tokens: 512,
    temperature: 0.2,
  };

  const headers = {
    'Content-Type': 'application/json',
  };
  if (HERMES_GATEWAY_TOKEN) {
    headers['Authorization'] = `Bearer ${HERMES_GATEWAY_TOKEN}`;
  }
  if (hermesSessionKey) {
    headers['X-Hermes-Session-Id'] = String(hermesSessionKey);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HERMES_MAX_WAIT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    clearTimeout(timeout);
    const aborted = error && (error.name === 'AbortError' || String(error.message || '').includes('aborted'));
    if (aborted) {
      return { ok: false, text: `${ASSISTANT_NAME} no respondió en ${Math.round(HERMES_MAX_WAIT_MS / 1000)} segundos. Prueba con una pregunta más breve.` };
    }
    const reason = error instanceof Error ? error.message : String(error);
    return { ok: false, text: `Error de red al llamar a ${ASSISTANT_NAME}: ${reason}` };
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    return { ok: false, text: `${ASSISTANT_NAME} respondió con error ${response.status}: ${text}` };
  }

  let data;
  try {
    data = await response.json();
  } catch (error) {
    return { ok: false, text: `Respuesta de ${ASSISTANT_NAME} inválida.` };
  }

  let reply = '';
  try {
    const choice = data?.choices?.[0];
    if (choice?.message?.content) reply = choice.message.content.trim();
    else if (choice?.message?.reasoning) reply = choice.message.reasoning.trim();
    else if (choice?.delta?.content) reply = choice.delta.content.trim();
  } catch {
    reply = '';
  }

  if (!reply) {
    return { ok: true, text: `${ASSISTANT_NAME} no generó respuesta de texto.` };
  }
  return { ok: true, text: reply };
}

// Tarea: { id, question, status: pending|done|failed, answer, createdAt, finishedAt, deliveredAt, origin: voice|mcp }.
// Se guarda entera en `file` (tmp + rename) en cada cambio. Las fechas son ISO 8601.
// En una tarea failed, `answer` lleva el motivo (lo que se diría por voz).
function createTaskStore({ file = TASKS_FILE, ttlMs = TASK_TTL_MS, run = callAgent, now = Date.now, log = () => {} } = {}) {
  const tasks = new Map();
  // id -> promesa que resuelve cuando la tarea termina; solo existe mientras corre en este proceso.
  const running = new Map();

  const iso = () => new Date(now()).toISOString();
  const copy = task => ({ ...task });
  const isExpired = task => now() - Date.parse(task.createdAt) > ttlMs;

  function persist() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ tasks: [...tasks.values()] }, null, 2));
    fs.renameSync(tmp, file);
  }

  function purgeExpired() {
    let purged = 0;
    for (const task of tasks.values()) {
      if (isExpired(task) && !running.has(task.id)) {
        tasks.delete(task.id);
        purged += 1;
      }
    }
    return purged;
  }

  function load() {
    let saved = [];
    try {
      saved = JSON.parse(fs.readFileSync(file, 'utf8')).tasks || [];
    } catch (error) {
      if (error.code !== 'ENOENT') {
        // Archivo dañado: se aparta (no se borra) y se parte con el almacén vacío.
        const aside = `${file}.corrupt-${now()}`;
        try { fs.renameSync(file, aside); } catch {}
        log('tasks_file_unreadable', { file, aside, error: error.message });
      }
    }
    let interrupted = 0;
    for (const task of saved) {
      // Una tarea pending en disco es de un proceso que murió: su llamada al agente se perdió.
      if (task.status === 'pending') {
        Object.assign(task, { status: 'failed', answer: INTERRUPTED_REASON, finishedAt: iso() });
        interrupted += 1;
      }
      tasks.set(task.id, task);
    }
    const purged = purgeExpired();
    if (interrupted || purged) persist();
    log('tasks_loaded', { file, count: tasks.size, interrupted, purged });
  }

  function finish(task, result) {
    task.status = result.ok ? 'done' : 'failed';
    task.answer = result.text;
    task.finishedAt = iso();
    persist();
    log('task_finished', { taskId: task.id, origin: task.origin, status: task.status, ms: Date.parse(task.finishedAt) - Date.parse(task.createdAt) });
  }

  // `options` se pasa tal cual a `run` (p. ej. { history } de la sesión de voz).
  function startTask(question, origin, options = {}) {
    const task = {
      id: crypto.randomUUID(),
      question,
      status: 'pending',
      answer: null,
      createdAt: iso(),
      finishedAt: null,
      deliveredAt: null,
      origin,
    };
    tasks.set(task.id, task);
    persist();
    log('task_started', { taskId: task.id, origin });
    const settled = Promise.resolve()
      .then(() => run(question, options))
      .catch(error => ({ ok: false, text: `Error al llamar a ${ASSISTANT_NAME}: ${error instanceof Error ? error.message : String(error)}` }))
      .then(result => {
        finish(task, result);
        running.delete(task.id);
      });
    running.set(task.id, settled);
    return copy(task);
  }

  // null si la tarea no existe o ya venció su TTL.
  function getTask(id) {
    const task = tasks.get(id);
    if (!task) return null;
    if (isExpired(task) && !running.has(id)) {
      tasks.delete(id);
      persist();
      return null;
    }
    return copy(task);
  }

  // Espera hasta `ms` a que la tarea termine y devuelve su estado en ese momento.
  async function waitForTask(id, ms) {
    const settled = running.get(id);
    if (settled && ms > 0) {
      let timer;
      const deadline = new Promise(resolve => { timer = setTimeout(resolve, ms); });
      await Promise.race([settled, deadline]);
      clearTimeout(timer);
    }
    return getTask(id);
  }

  // Más recientes primero.
  function listTasks({ includeDelivered = false } = {}) {
    if (purgeExpired()) persist();
    return [...tasks.values()]
      .filter(task => includeDelivered || !task.deliveredAt)
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map(copy);
  }

  // La última tarea done (por finishedAt) que ninguna superficie entregó todavía.
  function latestUndelivered() {
    const ready = listTasks().filter(task => task.status === 'done');
    ready.sort((a, b) => Date.parse(b.finishedAt) - Date.parse(a.finishedAt));
    return ready[0] || null;
  }

  function markDelivered(id) {
    const task = tasks.get(id);
    if (!task) return null;
    if (!task.deliveredAt) {
      task.deliveredAt = iso();
      persist();
      log('task_delivered', { taskId: id, origin: task.origin });
    }
    return copy(task);
  }

  load();
  return { startTask, waitForTask, getTask, listTasks, latestUndelivered, markDelivered };
}

// Almacén del proceso. server.js lo crea al arrancar con initTasks({ log }); si no, se crea al primer uso.
let store = null;
function initTasks(options = {}) {
  store = createTaskStore(options);
  return store;
}
function tasks() {
  return store || initTasks();
}

module.exports = {
  callAgent,
  createTaskStore,
  initTasks,
  startTask: (question, origin, options) => tasks().startTask(question, origin, options),
  waitForTask: (id, ms) => tasks().waitForTask(id, ms),
  getTask: id => tasks().getTask(id),
  listTasks: options => tasks().listTasks(options),
  latestUndelivered: () => tasks().latestUndelivered(),
  markDelivered: id => tasks().markDelivered(id),
  INTERRUPTED_REASON,
};
