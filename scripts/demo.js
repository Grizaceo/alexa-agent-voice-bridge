// Demo de un comando, sin Echo: el src/server.js real en un puerto libre, requests de Alexa sintéticas
// (el mismo JSON que manda la nube de Alexa) y el cliente MCP oficial, sobre el mismo almacén de tareas.
// Uso: npm run demo                 agente SIMULADO (sin LLM): responde "Respuesta simulada a …"
//      npm run demo -- --real-agent el agente de .env (HERMES_GATEWAY_URL/TOKEN); las respuestas tardan lo que tarde
//      npm run demo -- --lang en    el Echo en inglés (requests en-US); se combina con --real-agent
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const { MCP_TOKEN, sleep, startBackend, alexaSession, launch, intent } = require('../test/helpers');

const REAL_AGENT = process.argv.includes('--real-agent');
const EN = process.argv.includes('--lang') && process.argv[process.argv.indexOf('--lang') + 1] === 'en';
const LOCALE = EN ? 'en-US' : 'es-US';
const SIMULATED_DELAY_MS = 4000;
const VOICE_TIMEOUT_MS = 1500;
// Con el agente real, preguntas sin búsqueda web: tardan segundos (más que el turno de voz de la demo), no minutos.
const QUESTIONS = {
  es: REAL_AGENT
    ? { voiceIntent: 'FreeQueIntent', voiceQuery: 'es un agujero negro, en dos frases', mcp: 'En dos frases: ¿por qué el cielo es azul?' }
    : { voiceIntent: 'FreeBuscaIntent', voiceQuery: 'vuelos baratos a Lima para el viernes', mcp: 'resume las noticias de tecnología de hoy' },
  en: REAL_AGENT
    ? { voiceIntent: 'FreeWhatIntent', voiceQuery: 'is a black hole, in two sentences', mcp: 'In two sentences: why is the sky blue?' }
    : { voiceIntent: 'FreeSearchIntent', voiceQuery: 'cheap flights to Lima for Friday', mcp: "summarize today's tech news" },
}[EN ? 'en' : 'es'];
// Lo que dice el usuario para abrir y cerrar la skill en cada idioma.
const OPEN = EN ? 'Alexa, open mango' : 'Alexa, mango';
const CLOSE = EN ? 'passion fruit' : 'maracuyá';
const MAX_WAIT_SECONDS = 300;

const style = (code, text) => (process.stdout.isTTY ? `\x1b[${code}m${text}\x1b[0m` : text);
const say = (who, text) => console.log(`${who} ${text}`);
const voice = text => say(style('36', '  [Echo]   '), text);
const user = text => say(style('1', '  [you]    '), `"${text}"`);
const mcp = text => say(style('35', '  [MCP]    '), text);
const step = text => console.log(`\n${style('33', `▸ ${text}`)}`);

// Agente simulado: contesta con un texto que deja claro que es simulado, tras SIMULATED_DELAY_MS
// (más que el límite de voz, para que se vea el modo pensando).
async function startSimulatedAgent() {
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const question = JSON.parse(body).messages.at(-1).content;
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        const content = EN ? `**Simulated answer** to "${question}".` : `**Respuesta simulada** a «${question}».`;
        res.end(JSON.stringify({ choices: [{ message: { content } }] }));
      }, SIMULATED_DELAY_MS);
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return server;
}

async function mcpClient(backend) {
  const client = new Client({ name: 'demo-alexa-plus-stand-in', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(backend.mcp), {
    requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
  }));
  return {
    client,
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent,
  };
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-demo-'));
  const agent = REAL_AGENT ? null : await startSimulatedAgent();
  const realEnv = {};
  if (REAL_AGENT) {
    const env = require('dotenv').parse(fs.readFileSync(path.join(__dirname, '..', '.env')));
    Object.assign(realEnv, { HERMES_GATEWAY_URL: env.HERMES_GATEWAY_URL, HERMES_GATEWAY_TOKEN: env.HERMES_GATEWAY_TOKEN, HERMES_API_MODEL: env.HERMES_API_MODEL });
  }
  const env = { VOICE_GATEWAY_TIMEOUT_MS: String(VOICE_TIMEOUT_MS), ...realEnv };
  let backend = await startBackend(dir, agent ? agent.address().port : 9, env);
  const waitSeconds = REAL_AGENT ? 20 : (SIMULATED_DELAY_MS / 1000) + 2;

  console.log(style('1', '\nAlexa Agent Voice Bridge: one agent, two surfaces, one task store'));
  console.log(`  server   src/server.js on ${backend.base} (data in ${dir})`);
  console.log(`  agent    ${REAL_AGENT ? `your agent from .env (${realEnv.HERMES_GATEWAY_URL})` : `SIMULATED (no LLM; answers after ${SIMULATED_DELAY_MS / 1000} s, longer than the voice turn)`}`);
  console.log(`  voice    synthetic Alexa requests (${LOCALE}), the same JSON the Alexa cloud sends (signature check off for this local demo)`);
  console.log('  MCP      official client @modelcontextprotocol/client, playing the role of Alexa+');

  try {
    step('1. A slow question by voice: the Echo says what it understood and keeps working in the background');
    const echo = alexaSession(backend, { locale: LOCALE });
    user(OPEN);
    voice((await echo(launch())).speech);
    const spoken = await echo(intent(QUESTIONS.voiceIntent, { query: QUESTIONS.voiceQuery }));
    user(spoken.attributes.lastQuery || QUESTIONS.voiceQuery);
    voice(spoken.speech);
    user(CLOSE);
    voice((await echo(intent('AMAZON.StopIntent'))).speech);

    step('2. An MCP client (the Alexa+ stand-in) finds that voice task and collects the answer');
    const first = await mcpClient(backend);
    mcp(`connected; negotiated protocol ${first.client.getNegotiatedProtocolVersion()}`);
    mcp(`tools: ${(await first.client.listTools()).tools.map(tool => tool.name).join(', ')}`);
    const { tasks } = await first.call('list_tasks');
    for (const task of tasks) mcp(`list_tasks → "${task.question}" status=${task.status} origin=${task.origin}`);
    const voiceTask = tasks.find(task => task.origin === 'voice');
    let collected;
    for (let waited = 0; ; waited += waitSeconds) {
      collected = await first.call('get_agent_result', { task_id: voiceTask.task_id, wait_seconds: waitSeconds });
      if (collected.status !== 'pending' || waited >= MAX_WAIT_SECONDS) break;
      mcp('get_agent_result → pending; the agent is still working, asking again…');
    }
    mcp(`get_agent_result → ${collected.status}${collected.answer ? `: ${collected.answer}` : ''}`);
    await first.client.close();

    step('3. Delivered once is delivered everywhere: the Echo does not repeat it');
    user(OPEN);
    voice((await alexaSession(backend, { locale: LOCALE })(launch())).speech);

    step('4. The other way around: ask from MCP, then the server restarts before you come back');
    const second = await mcpClient(backend);
    const pending = await second.call('ask_agent', { question: QUESTIONS.mcp, wait_seconds: 1 });
    mcp(`ask_agent → ${pending.status} (task_id ${pending.task_id.slice(0, 8)}…)`);
    await second.client.close();
    // Se espera a que el agente termine antes de reiniciar: un reinicio corta la llamada en curso
    // (esa tarea quedaría failed), y lo que se quiere mostrar es que una respuesta lista sobrevive.
    const started = Date.now();
    const probe = await mcpClient(backend);
    while ((await probe.call('list_tasks')).tasks.find(task => task.task_id === pending.task_id)?.status === 'pending'
      && Date.now() - started < MAX_WAIT_SECONDS * 1000) {
      await sleep(2000);
    }
    await probe.client.close();
    say(style('2', '  [server] '), `the answer is ready (${Math.round((Date.now() - started) / 1000)} s); restarting… (tasks live in data/tasks.json)`);
    await backend.stop();
    backend = await startBackend(dir, agent ? agent.address().port : 9, env);

    step('5. Back on the Echo after the restart');
    user(OPEN);
    const reopened = await alexaSession(backend, { locale: LOCALE })(launch());
    voice(`${reopened.sounds.length ? style('2', '(chime) ') : ''}${reopened.speech}`);
    if (reopened.card) say(style('2', '  [app]    '), `card "${reopened.card.title}"`);

    console.log(`\n${style('32', 'Done.')} Same flows are covered by npm test (test/cross-surface.test.js).`);
  } finally {
    await backend.stop();
    agent?.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
