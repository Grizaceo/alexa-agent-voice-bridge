// La skill en inglés: requests con locale en-US (un Echo en inglés o en modo bilingüe inglés/español).
// Mismo backend y mismo almacén que en español; solo cambian el modelo y lo que se habla.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const { MCP_TOKEN, SLOW_MS, sleep, startGateway, startBackend, alexaSession, launch, intent, readTasks } = require('./helpers');

const session = (backend, options = {}) => alexaSession(backend, { locale: 'en-US', ...options });

test('voice in English (en-US)', async t => {
  const gateway = await startGateway();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-en-'));
  const backend = await startBackend(dir, gateway.address().port);
  t.after(async () => {
    await backend.stop();
    gateway.close();
  });

  await t.test('quick answer: English greeting, the leading word goes back in, the task is delivered', async () => {
    const send = session(backend);
    assert.equal((await send(launch())).speech, 'Mango is ready. You can talk to me.');
    const reply = await send(intent('FreeWhatIntent', { query: 'time is it in Tokyo' }));
    assert.equal(reply.speech, 'Respuesta: what time is it in Tokyo');
    assert.equal(reply.card.title, 'Mango: what time is it in Tokyo');
    const [task] = readTasks(dir);
    assert.equal(task.question, 'what time is it in Tokyo');
    assert.equal(task.origin, 'voice');
    assert.ok(task.deliveredAt);
  });

  await t.test('the Spanish "un/una" fix does not touch English, and two-word leads come back whole', async () => {
    const send = session(backend);
    assert.equal((await send(intent('FreeGiveMeIntent', { query: '1 idea for dinner' }))).speech, 'Respuesta: give me 1 idea for dinner');
    assert.equal((await send(intent('FreeLookUpIntent', { query: 'the weather in Lima' }))).speech, 'Respuesta: look up the weather in Lima');
    assert.equal((await send(intent('FreeWhatsIntent', { query: 'on my calendar' }))).speech, "Respuesta: what's on my calendar");
  });

  await t.test('"system status" answers right away without a task', async () => {
    const before = readTasks(dir).length;
    const reply = await session(backend)(intent('FreeSystemIntent', { query: 'status' }));
    assert.match(reply.speech, /^Quick status: Alexa backend up, gateway configured, model /);
    assert.equal(readTasks(dir).length, before);
  });

  await t.test('slow question: "Got it", repeat waits, then the answer with the chime', async () => {
    const send = session(backend);
    const thinking = await send(intent('FreeSearchIntent', { query: 'something slow' }));
    assert.equal(thinking.speech, "Got it: search something slow. This will take a moment. Say repeat in a few seconds, or later say Alexa, open mango, and I'll tell you.");
    assert.equal((await send(intent('AMAZON.RepeatIntent'))).speech, "I'm still on it. Say repeat in a few seconds.");
    await sleep(SLOW_MS);
    const answer = await send(intent('AMAZON.RepeatIntent'));
    assert.equal(answer.speech, 'Respuesta: search something slow');
    assert.deepEqual(answer.sounds, ['soundbank://soundlibrary/alarms/beeps_and_bloops/bell_02']);
  });

  await t.test('"passion fruit" with work in progress saves it; reopening announces it', async () => {
    const send = session(backend);
    await send(intent('FreeSummarizeIntent', { query: 'the slow report' }));
    const bye = await send(intent('AMAZON.StopIntent'));
    assert.equal(bye.speech, "Done. I'll keep the answer that's still in progress; say Alexa, open mango whenever you want to hear it.");
    assert.equal(bye.ended, true);
    const early = await session(backend)(launch());
    assert.equal(early.speech, "Mango is ready. I'm still working on what you asked earlier; say repeat to wait for it, or ask me something else.");
    await sleep(SLOW_MS);
    assert.equal((await session(backend)(launch())).speech, 'I have the answer to what you asked me: summarize the slow report. Respuesta: summarize the slow report');
    assert.equal((await session(backend)(intent('AMAZON.StopIntent'))).speech, 'Done, goodbye.');
  });

  await t.test('asked over MCP, announced in English on the next launch', async () => {
    const client = new Client({ name: 'voice-en-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StreamableHTTPClientTransport(new URL(backend.mcp), { requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } } }));
    const asked = (await client.callTool({ name: 'ask_agent', arguments: { question: 'a slow question from MCP', wait_seconds: 0 } })).structuredContent;
    assert.equal(asked.status, 'pending');
    await client.close();
    await sleep(SLOW_MS + 200);
    const reopened = await session(backend)(launch());
    assert.equal(reopened.speech, 'I have the answer to what you asked me from another device: a slow question from MCP. Respuesta: a slow question from MCP');
  });

  await t.test('help names the English close word; the same backend still speaks Spanish to es-US', async () => {
    assert.equal((await session(backend)(intent('AMAZON.HelpIntent'))).speech,
      'Ask me anything, starting with what, who, how, search, or play. If I take a while, say repeat. To finish, say passion fruit.');
    assert.equal((await alexaSession(backend)(launch())).speech, 'Mango listo. Puedes hablarme.');
  });
});

test('Voice ID in English: another voice is ignored with an English reply', async t => {
  const gateway = await startGateway();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-en-voiceid-'));
  const backend = await startBackend(dir, gateway.address().port, { VOICE_ID_MODE: 'enforce' });
  t.after(async () => {
    await backend.stop();
    gateway.close();
  });
  const send = session(backend);
  const tv = await send(intent('FreePlayIntent', { query: 'the next episode' }));
  assert.equal(tv.speech, "I didn't recognize your voice. If you were talking to me, say it again.");
  assert.equal(tv.ended, false);
  await send(intent('AMAZON.FallbackIntent'));
  const third = await send(intent('AMAZON.FallbackIntent'));
  assert.equal(third.speech, "I don't recognize this voice. Goodbye.");
  assert.equal(third.ended, true);
  assert.ok(!fs.existsSync(path.join(dir, 'tasks.json')) || readTasks(dir).length === 0, 'other voices create no tasks');
});

test('VOICE_ID_MODE_EN=off: English requests pass without Voice ID, Spanish ones are still filtered', async t => {
  const gateway = await startGateway();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-en-modeen-'));
  const backend = await startBackend(dir, gateway.address().port, { VOICE_ID_MODE: 'enforce', VOICE_ID_MODE_EN: 'off' });
  t.after(async () => {
    await backend.stop();
    gateway.close();
  });
  const health = await (await fetch(`${backend.base}/health`)).json();
  assert.deepEqual(health.voiceId, { mode: 'enforce', modeEn: 'off', ownerEnrolled: false });
  assert.equal((await session(backend)(intent('FreeWhatIntent', { query: 'is the weather like' }))).speech, 'Respuesta: what is the weather like');
  assert.equal((await alexaSession(backend)(intent('FreeQueIntent', { query: 'tiempo hace' }))).speech, 'No reconocí tu voz. Si me hablabas a mí, repítelo.');
  const checks = fs.readFileSync(path.join(dir, 'debug.log'), 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(e => e.event === 'voice_id');
  assert.deepEqual(checks.map(e => [e.locale, e.mode, e.allowed]), [['en-US', 'off', true], ['es-US', 'enforce', false]]);
});
