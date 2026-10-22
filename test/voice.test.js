// Requests sintéticas de Alexa contra src/server.js (proceso real, puerto libre, firma sin verificar)
// con un gateway falso: el agente tarda FAST_MS, o SLOW_MS si la pregunta contiene "lento".
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SLOW_MS, sleep, startGateway, startBackend, alexaSession: session, launch, intent, readTasks, readLog } = require('./helpers');

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
    assert.deepEqual(reply.sounds, []);
    assert.equal(reply.card.title, 'Mango: qué hora es en Santiago');
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

  await t.test('una URL suelta no se deletrea por voz; la tarjeta la conserva', async () => {
    const send = session(backend);
    const reply = await send(intent('FreeQueIntent', { query: 'dice https://www.accuweather.com/es/cl' }));
    assert.equal(reply.speech, 'Respuesta: qué dice accuweather.com');
    assert.equal(reply.card.content, 'Respuesta: qué dice https://www.accuweather.com/es/cl');
  });

  await t.test('el "1" que Alexa pone en lugar de "un"/"una" vuelve con el artículo de la palabra siguiente', async () => {
    const send = session(backend);
    const cases = [
      ['FreeDameIntent', '1 idea para la cena', 'dame una idea para la cena'],
      ['FreeMandaIntent', '1 correo a Ana', 'manda un correo a Ana'],
      ['FreeQueIntent', 'hago en 1 día libre', 'qué hago en un día libre'],
      ['FreeDameIntent', '1 canción y 1 vez más 1 chiste', 'dame una canción y una vez más un chiste'],
      ['FreeQueIntent', 'pasa el 1 de noviembre', 'qué pasa el 1 de noviembre'],
    ];
    for (const [name, query, question] of cases) {
      assert.equal((await send(intent(name, { query }))).speech, `Respuesta: ${question}`);
    }
  });

  await t.test('pregunta lenta: modo pensando, "repite" espera y luego lee la respuesta', async () => {
    const send = session(backend);
    const thinking = await send(intent('FreeBuscaIntent', { query: 'algo lento' }));
    assert.equal(thinking.speech, 'Entendí: busca algo lento. Me va a tomar un momento. Di repite en unos segundos, o más tarde dime Alexa, mango, y te cuento.');
    assert.deepEqual(thinking.sounds, []);
    assert.ok(thinking.attributes.pendingTaskId);
    assert.equal((await send(intent('AMAZON.RepeatIntent'))).speech, 'Todavía estoy en eso. Di repite en unos segundos.');
    await sleep(SLOW_MS);
    const answer = await send(intent('AMAZON.RepeatIntent'));
    assert.equal(answer.speech, 'Respuesta: busca algo lento');
    // Una respuesta que esperó suena antes de leerse y queda completa en la app Alexa.
    assert.deepEqual(answer.sounds, ['soundbank://soundlibrary/alarms/beeps_and_bloops/bell_02']);
    assert.deepEqual(answer.card, { type: 'Simple', title: 'Mango: busca algo lento', content: 'Respuesta: busca algo lento' });
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
    assert.equal((await reopened(launch())).speech, 'Tengo la respuesta a lo que me pediste: busca otra cosa más lento. Respuesta: busca otra cosa más lento');
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
    assert.equal((await session(backend)(launch())).speech, 'Tengo la respuesta a lo que me pediste: qué tiempo hace mañana lento. Respuesta: qué tiempo hace mañana lento');
  });
});
