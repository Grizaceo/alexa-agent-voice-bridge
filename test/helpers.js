// Utilidades de los tests de integración: un gateway falso del agente y src/server.js en un proceso real.
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');

const SKILL_ID = 'amzn1.ask.skill.test-voice-bridge';
const USER_ID = 'amzn1.ask.account.TEST';
const MCP_TOKEN = 'test-mcp-token';
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

// Responde "**Respuesta:** <pregunta>" en FAST_MS, o en SLOW_MS si la pregunta contiene "lento".
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
async function startBackend(dir, gatewayPort, extraEnv = {}) {
  const port = await freePort();
  const child = spawn(process.execPath, ['src/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      ASSISTANT_NAME: 'Mango',
      ALEXA_RETURN_PHRASE: 'Alexa, mango',
      ALEXA_SKILL_ID: SKILL_ID,
      ALEXA_SKIP_VERIFICATION: 'true',
      ALLOW_USER_IDS: '',
      PIN_REQUIRED: 'false',
      HERMES_GATEWAY_URL: `http://127.0.0.1:${gatewayPort}/v1/chat/completions`,
      HERMES_GATEWAY_TOKEN: 'test-token',
      VOICE_GATEWAY_TIMEOUT_MS: String(VOICE_TIMEOUT_MS),
      MCP_TOKEN,
      MCP_ALLOWED_ORIGINS: 'localhost,127.0.0.1,[::1]',
      TASKS_FILE: path.join(dir, 'tasks.json'),
      SESSION_FILE: path.join(dir, 'sessions.json'),
      ALEXA_DEBUG_LOG: path.join(dir, 'debug.log'),
      VOICE_ID_MODE: 'off',
      VOICE_OWNER_PERSON_ID: '',
      VOICE_OWNER_FILE: path.join(dir, 'voice-owner.json'),
      ...extraEnv,
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
  const base = `http://127.0.0.1:${port}`;
  return { base, alexa: `${base}/alexa`, mcp: `${base}/mcp`, stop };
}

// Una sesión de Alexa: lleva los sessionAttributes de cada respuesta a la siguiente request, como Alexa.
// personId simula Voice ID (context.System.person); se puede fijar por sesión o por request.
function alexaSession(backend, { personId: sessionPersonId = null } = {}) {
  const sessionId = `amzn1.echo-api.session.${Math.random().toString(36).slice(2)}`;
  let attributes = {};
  let isNew = true;
  let requestCount = 0;
  return async function send(request, { personId = sessionPersonId } = {}) {
    const envelope = {
      version: '1.0',
      session: { new: isNew, sessionId, application: { applicationId: SKILL_ID }, user: { userId: USER_ID }, attributes },
      context: { System: { application: { applicationId: SKILL_ID }, user: { userId: USER_ID }, device: { deviceId: 'test-device', supportedInterfaces: {} }, apiEndpoint: 'https://api.amazonalexa.com' } },
      request: { requestId: `${sessionId}.${requestCount += 1}`, timestamp: new Date().toISOString(), locale: 'es-US', ...request },
    };
    if (personId) envelope.context.System.person = { personId, authenticationConfidenceLevel: { level: 300 } };
    isNew = false;
    const res = await fetch(backend.alexa, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(envelope) });
    assert.equal(res.status, 200, await res.clone().text());
    const body = await res.json();
    attributes = body.sessionAttributes || {};
    const ssml = body.response.outputSpeech?.ssml || '';
    return {
      speech: ssml.replace(/<audio[^>]*\/>/g, '').replace(/<\/?speak>/g, ''),
      sounds: [...ssml.matchAll(/<audio src="([^"]+)"\/>/g)].map(m => m[1]),
      card: body.response.card || null,
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

module.exports = {
  MCP_TOKEN, VOICE_TIMEOUT_MS, SLOW_MS,
  sleep, startGateway, startBackend, alexaSession, launch, intent, readTasks, readLog,
};
