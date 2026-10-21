// Identificación por voz: con VOICE_ID_MODE=enforce, solo el dueño llega al agente y a sus respuestas.
// Alexa manda context.System.person.personId cuando reconoce al hablante; la TV o una visita llegan sin él.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SLOW_MS, sleep, startGateway, startBackend, alexaSession, launch, intent, readLog } = require('./helpers');

const OWNER = 'amzn1.ask.person.OWNER';
const GUEST = 'amzn1.ask.person.GUEST';
const IGNORED = 'No reconocí tu voz. Si me hablabas a mí, repítelo.';
const tasksIn = dir => (fs.existsSync(path.join(dir, 'tasks.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 'tasks.json'), 'utf8')).tasks : []);
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-voiceid-'));

test('Voice ID', async t => {
  const gateway = await startGateway();
  const port = gateway.address().port;
  t.after(() => gateway.close());

  await t.test('off (por defecto): atiende a todos y registra si la voz fue reconocida', async () => {
    const dir = tempDir();
    const backend = await startBackend(dir, port);
    try {
      const send = alexaSession(backend);
      assert.equal((await send(intent('FreeQueIntent', { query: 'hora es' }))).speech, 'Respuesta: qué hora es');
      assert.equal((await send(intent('FreeQueIntent', { query: 'día es' }), { personId: OWNER })).speech, 'Respuesta: qué día es');
      const events = readLog(dir).filter(e => e.event === 'voice_id');
      assert.deepEqual(events.map(e => [e.mode, e.recognized, e.allowed]), [['off', false, true], ['off', true, true]]);
      assert.match(events[1].person, /^[0-9a-f]{8}$/);
      assert.ok(!fs.readFileSync(path.join(dir, 'debug.log'), 'utf8').includes(OWNER), 'el log no guarda el personId');
    } finally {
      await backend.stop();
    }
  });

  await t.test('enforce sin dueño registrado: basta con que Alexa reconozca la voz', async () => {
    const dir = tempDir();
    const backend = await startBackend(dir, port, { VOICE_ID_MODE: 'enforce' });
    try {
      const send = alexaSession(backend);
      // La TV habla durante la sesión: llega sin person, no crea tarea y la sesión sigue escuchando.
      const tv = await send(intent('FreeBuscaIntent', { query: 'ofertas en la tele' }));
      assert.equal(tv.speech, IGNORED);
      assert.equal(tv.ended, false);
      assert.deepEqual(tasksIn(dir), []);
      // El usuario, reconocido, sigue hablando: llega al agente y reinicia la cuenta de ignoradas.
      assert.equal((await send(intent('FreeQueIntent', { query: 'hora es' }), { personId: OWNER })).speech, 'Respuesta: qué hora es');
      assert.equal((await send(intent('FreeQueIntent', { query: 'pasa' }))).speech, IGNORED);
      assert.equal((await send(intent('FreeQueIntent', { query: 'pasa' }))).ended, false);
      const closing = await send(intent('FreeQueIntent', { query: 'pasa' }));
      assert.equal(closing.speech, 'No reconozco esta voz. Hasta luego.');
      assert.equal(closing.ended, true);
      assert.deepEqual(tasksIn(dir).map(task => task.question), ['qué hora es']);

      // Cerrar ("maracuyá") se acepta de cualquiera.
      assert.equal((await alexaSession(backend)(intent('AMAZON.StopIntent'))).speech, 'Listo, hasta luego.');
      assert.deepEqual((await (await fetch(`${backend.base}/health`)).json()).voiceId, { mode: 'enforce', ownerEnrolled: false });
    } finally {
      await backend.stop();
    }
  });

  await t.test('enroll registra al dueño; enforce después atiende solo a esa voz', async () => {
    const dir = tempDir();
    let backend = await startBackend(dir, port, { VOICE_ID_MODE: 'enroll' });
    try {
      assert.equal((await alexaSession(backend, { personId: OWNER })(launch())).speech, 'Mango listo. Puedes hablarme.');
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'voice-owner.json'), 'utf8')).personId, OWNER);
      // enroll no filtra: una segunda voz no reemplaza al dueño y se atiende igual.
      assert.equal((await alexaSession(backend, { personId: GUEST })(intent('FreeQueIntent', { query: 'hora es' }))).speech, 'Respuesta: qué hora es');
      assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'voice-owner.json'), 'utf8')).personId, OWNER);
      assert.ok(readLog(dir).some(e => e.event === 'voice_owner_enrolled'));
      await backend.stop();

      backend = await startBackend(dir, port, { VOICE_ID_MODE: 'enforce' });
      assert.deepEqual((await (await fetch(`${backend.base}/health`)).json()).voiceId, { mode: 'enforce', ownerEnrolled: true });

      // El dueño deja una pregunta lenta y cierra.
      const owner = alexaSession(backend, { personId: OWNER });
      assert.match((await owner(intent('FreeBuscaIntent', { query: 'vuelos lento' }))).speech, /Me va a tomar un momento/);
      await owner(intent('AMAZON.StopIntent'));
      await sleep(SLOW_MS + 200);

      // Una visita (otra voz reconocida) abre la skill: no oye la respuesta del dueño ni puede pedir "repite".
      const guest = alexaSession(backend, { personId: GUEST });
      assert.equal((await guest(launch())).speech, 'Mango listo. Puedes hablarme.');
      assert.equal((await guest(intent('AMAZON.RepeatIntent'))).speech, IGNORED);
      assert.equal((await guest(intent('FreeQueIntent', { query: 'hora es' }))).speech, IGNORED);

      // El dueño abre: se le anuncia lo que pidió.
      assert.equal((await alexaSession(backend, { personId: OWNER })(launch())).speech, 'Tengo la respuesta a lo que me pediste: busca vuelos lento. Respuesta: busca vuelos lento');
    } finally {
      await backend.stop();
    }
  });

  await t.test('VOICE_ID_SILENT=true: la voz ajena se ignora sin hablar', async () => {
    const dir = tempDir();
    const backend = await startBackend(dir, port, { VOICE_ID_MODE: 'enforce', VOICE_ID_SILENT: 'true' });
    try {
      const reply = await alexaSession(backend)(intent('FreeQueIntent', { query: 'hora es' }));
      assert.equal(reply.speech, '');
      assert.equal(reply.ended, false);
    } finally {
      await backend.stop();
    }
  });
});
