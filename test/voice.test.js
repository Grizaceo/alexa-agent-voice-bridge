// Requests sintéticas de Alexa contra src/server.js (proceso real, puerto libre, firma sin verificar)
// con un gateway falso: el agente tarda FAST_MS, o SLOW_MS si la pregunta contiene "lento".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const SKILL_ID = 'amzn1.ask.skill.test-voice-bridge';
const USER_ID = 'amzn1.ask.account.TEST';
const VOICE_TIMEOUT_MS = 300;
const FAST_MS = 30;
const SLOW_MS = 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    }).on('error', reject);
  });
}

async function startGateway() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const { messages } = JSON.parse(body);
      const question = messages[messages.length - 1].content;
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: `**Respuesta:** ${question}` } }] }));
      }, question.includes('lento') ? SLOW_MS : FAST_MS);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

// Levanta src/server.js con un entorno aislado; dir guarda tasks.json, sessions.json y el log.
async function startBackend(dir, gatewayPort) {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      ASSISTANT_NAME: 'Mango',
      ALEXA_RETURN_PHRASE: 'Alexa, mango',
      ALEXA_SKILL_ID: SKILL_ID,
      ALEXA_SKIP_VERIFICATION: 'true',
      ALLOW_USER_IDS: '',
      PIN_REQUIRED: 'false',
      HERMES_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}/v1/chat/completions`,
      HERMES_GATEWAY_TOKEN: 'test-token',
      VOICE_GATEWAY_TIMEOUT_MS: String(VOICE_TIMEOUT_MS),
      TASKS_FILE: path.join(dir, 'tasks.json'),
      SESSION_FILE: path.join(dir, 'sessions.json'),
      ALEXA_DEBUG_LOG: path.join(dir, 'debug.log'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    child.stdout.on('data', chunk => { if (String(chunk).includes('listening')) resolve(); });
    child.on('exit', code => reject(new Error(`server.js salió con código ${code}`)));
  });
  const stop = () => new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGKILL');
  });
  return { url: `http://127.0.0.1:${port}/alexa`, stop };
}

// Una sesión de Alexa: lleva los sessionAttributes de cada respuesta a la siguiente request, como Alexa.
function session(backend) {
  const sessionId = `amzn1.echo-api.session.${Math.random().toString(36).slice(2)}`;
  let attributes = {};
  let isNew = true;
  let requestCount = 0;
  return async function send(request) {
    const envelope = {
      version: '1.0',
      session: { new: isNew, sessionId, application: { applicationId: SKILL_ID }, user: { userId: USER_ID }, attributes },
      context: { System: { application: { applicationId: SKILL_ID }, user: { userId: USER_ID }, device: { deviceId: 'test-device', supportedInterfaces: {} }, apiEndpoint: 'https://api.amazonalexa.com' } },
      request: { requestId: `${sessionId}.${requestCount += 1}`, timestamp: new Date().toISOString(), locale: 'es-US', ...request },
    };
    isNew = false;
    const res = await fetch(backend.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope) });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    attributes = body.sessionAttributes || {};
    return {
      speech: (body.response.outputSpeech?.ssml || '').replace(/<\/?speak>/g, ''),
      ended: body.response.shouldEndSession === true,
      attributes,
    };
  };
}

const launch = () => ({ type: 'LaunchRequest' });
const intent = (name, slots = {}) => ({
  type: 'IntentRequest',
  dialogState: 'COMPLETED',
  intent: { name, confirmationStatus: 'NONE', slots: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, { name: k, value: v, confirmationStatus: 'NONE' }])) },
});
const readTasks = dir => JSON.parse(fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8')).tasks;
const readLog = dir => fs.readFileSync(path.join(dir, 'debug.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));

test('voz: respuestas rápidas, modo pensando, repite, cierre y reinicios', async t => {
  const gateway = await startGateway();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-'));
  let backend = await startBackend(dir, gateway.address().port);
  t.after(async () => {
    await backend.stop();
    gateway.close();
  });

  await t.test('respuesta rápida: se habla sin Markdown y la tarea queda done y entregada', async () => {
    const send = session(backend);
    assert.equal((await send(launch())).speech, 'Mango listo. Puedes hablarme.');
    const reply = await send(intent('FreeQueIntent', { query: 'hora es en Santiago' }));
    assert.equal(reply.speech, 'Respuesta: qué hora es en Santiago');
    assert.equal(reply.ended, false);
    const [task] = readTasks(dir);
    assert.equal(task.status, 'done');
    assert.equal(task.origin, 'voice');
    assert.equal(task.question, 'qué hora es en Santiago');
    assert.ok(task.deliveredAt);
  });

  await t.test('"estado del sistema" responde al instante sin crear tarea', async () => {
    const send = session(backend);
    const reply = await send(intent('FreeEstadoIntent', { query: 'del sistema' }));
    assert.match(reply.speech, /^Estado rápido: backend Alexa activo/);
    assert.equal(readTasks(dir).length, 1);
  });

  await t.test('pregunta lenta: modo pensando, "repite" espera y luego lee la respuesta', async () => {
    const send = session(backend);
    const thinking = await send(intent('FreeBuscaIntent', { query: 'algo lento' }));
    assert.equal(thinking.speech, 'Me va a tomar un momento. Di repite en unos segundos, o más tarde dime Alexa, mango, y te cuento.');
    assert.ok(thinking.attributes.pendingTaskId);
    assert.equal((await send(intent('AMAZON.RepeatIntent'))).speech, 'Todavía estoy en eso. Di repite en unos segundos.');
    await sleep(SLOW_MS);
    const answer = await send(intent('AMAZON.RepeatIntent'));
    assert.equal(answer.speech, 'Respuesta: busca algo lento');
    assert.equal(answer.attributes.pendingTaskId, null);
    assert.equal(answer.attributes.history.at(-1).content, '**Respuesta:** busca algo lento');
    const task = readTasks(dir).find(x => x.id === thinking.attributes.pendingTaskId);
    assert.equal(task.status, 'done');
    assert.ok(task.deliveredAt);
    // Ya entregada: "repite" vuelve a leer la última respuesta.
    assert.equal((await send(intent('AMAZON.RepeatIntent'))).speech, 'Respuesta: busca algo lento');
  });

  await t.test('dos "repite" sin respuesta cierran la conversación y la respuesta se guarda', async () => {
    const send = session(backend);
    await send(intent('FreeBuscaIntent', { query: 'otra cosa más lento' }));
    assert.equal((await send(intent('AMAZON.RepeatIntent'))).ended, false);
    const closing = await send(intent('AMAZON.RepeatIntent'));
    assert.equal(closing.speech, 'Sigue trabajando y te guardo la respuesta. Cuando quieras, dime Alexa, mango, y te la leo.');
    assert.equal(closing.ended, true);
    await sleep(SLOW_MS);
    const reopened = session(backend);
    assert.equal((await reopened(launch())).speech, 'Tengo la respuesta a lo que me pediste. Respuesta: busca otra cosa más lento');
    assert.equal((await reopened(launch())).speech, 'Mango listo. Puedes hablarme.');
  });

  await t.test('"maracuyá" con algo en curso lo guarda; al reabrir antes de tiempo, sigue trabajando', async () => {
    const send = session(backend);
    await send(intent('FreeResumeIntent', { query: 'el documento lento' }));
    const bye = await send(intent('AMAZON.StopIntent'));
    assert.equal(bye.speech, 'Listo. Te guardo la respuesta que sigue en curso; dime Alexa, mango cuando quieras escucharla.');
    assert.equal(bye.ended, true);
    const early = session(backend);
    const greeting = await early(launch());
    assert.equal(greeting.speech, 'Mango listo. Sigo trabajando en lo que me pediste antes; di repite para esperarla, o pídeme otra cosa.');
    assert.ok(greeting.attributes.pendingTaskId);
    await sleep(SLOW_MS);
    assert.equal((await early(intent('AMAZON.RepeatIntent'))).speech, 'Respuesta: resume el documento lento');
    assert.equal((await session(backend)(intent('AMAZON.StopIntent'))).speech, 'Listo, hasta luego.');
  });

  await t.test('reinicio con una tarea en curso: queda failed y el Echo no la anuncia', async () => {
    const send = session(backend);
    const thinking = await send(intent('FreeBuscaIntent', { query: 'algo muy lento' }));
    await backend.stop();
    backend = await startBackend(dir, gateway.address().port);
    const task = readTasks(dir).find(x => x.id === thinking.attributes.pendingTaskId);
    assert.equal(task.status, 'failed');
    assert.equal(task.answer, 'Tarea interrumpida por reinicio.');
    assert.equal((await session(backend)(launch())).speech, 'Mango listo. Puedes hablarme.');
    assert.ok(readLog(dir).some(e => e.event === 'tasks_loaded' && e.interrupted === 1));
  });

  await t.test('reinicio con una respuesta lista sin entregar: el Echo la anuncia al abrir', async () => {
    const send = session(backend);
    await send(intent('FreeQueIntent', { query: 'tiempo hace mañana lento' }));
    await send(intent('AMAZON.StopIntent'));
    await sleep(SLOW_MS);
    await backend.stop();
    backend = await startBackend(dir, gateway.address().port);
    assert.equal((await session(backend)(launch())).speech, 'Tengo la respuesta a lo que me pediste. Respuesta: qué tiempo hace mañana lento');
  });
});
