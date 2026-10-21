// Una tarea, dos superficies: lo que se pide por voz se recoge por MCP y al revés, también tras un reinicio.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const { MCP_TOKEN, SLOW_MS, sleep, startGateway, startBackend, alexaSession, launch, intent, readTasks } = require('./helpers');

async function mcpClient(backend) {
  const client = new Client({ name: 'cross-surface-test', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(new StreamableHTTPClientTransport(new URL(backend.mcp), {
    requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
  }));
  return {
    call: async (name, args = {}) => (await client.callTool({ name, arguments: args })).structuredContent,
    close: () => client.close(),
  };
}

test('voz ↔ MCP sobre el mismo almacén de tareas', async t => {
  const gateway = await startGateway();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-cross-'));
  let backend = await startBackend(dir, gateway.address().port);
  t.after(async () => {
    await backend.stop();
    gateway.close();
  });

  await t.test('pedida por voz, recogida por MCP: el Echo ya no la anuncia', async () => {
    const voice = alexaSession(backend);
    const thinking = await voice(intent('FreeBuscaIntent', { query: 'vuelos baratos lento' }));
    assert.match(thinking.speech, /^Me va a tomar un momento/);
    await voice(intent('AMAZON.StopIntent'));

    const mcp = await mcpClient(backend);
    const { tasks } = await mcp.call('list_tasks');
    const task = tasks.find(x => x.question === 'busca vuelos baratos lento');
    assert.equal(task.origin, 'voice');
    assert.equal(task.status, 'pending');
    const result = await mcp.call('get_agent_result', { task_id: task.task_id, wait_seconds: (SLOW_MS / 1000) * 3 });
    assert.deepEqual(result, { status: 'done', task_id: task.task_id, answer: 'Respuesta: busca vuelos baratos lento' });
    await mcp.close();

    assert.equal((await alexaSession(backend)(launch())).speech, 'Mango listo. Puedes hablarme.');
  });

  await t.test('pedida por MCP, anunciada por el Echo al abrir', async () => {
    const mcp = await mcpClient(backend);
    const pending = await mcp.call('ask_agent', { question: 'resume mis correos lento', wait_seconds: 0 });
    assert.equal(pending.status, 'pending');
    await mcp.close();

    // Antes de que termine, el Echo avisa que sigue trabajando; después, la lee al abrir.
    const early = await alexaSession(backend)(launch());
    assert.equal(early.speech, 'Mango listo. Sigo trabajando en lo que me pediste antes; di repite para esperarla, o pídeme otra cosa.');
    await sleep(SLOW_MS + 200);
    const reopened = alexaSession(backend);
    assert.equal((await reopened(launch())).speech, 'Tengo la respuesta a lo que me pediste. Respuesta: resume mis correos lento');

    // Entregada por voz: list_tasks ya no la muestra, pero get_agent_result la sigue devolviendo.
    const again = await mcpClient(backend);
    assert.ok(!(await again.call('list_tasks')).tasks.some(x => x.task_id === pending.task_id));
    assert.equal((await again.call('get_agent_result', { task_id: pending.task_id })).status, 'done');
    await again.close();
  });

  await t.test('pedida por MCP, recogida con "repite" en una sesión de voz abierta', async () => {
    const mcp = await mcpClient(backend);
    const pending = await mcp.call('ask_agent', { question: 'revisa el calendario lento', wait_seconds: 0 });
    await mcp.close();
    const voice = alexaSession(backend);
    const greeting = await voice(launch());
    assert.equal(greeting.attributes.pendingTaskId, pending.task_id);
    await sleep(SLOW_MS + 200);
    assert.equal((await voice(intent('AMAZON.RepeatIntent'))).speech, 'Respuesta: revisa el calendario lento');
    assert.ok(readTasks(dir).find(x => x.id === pending.task_id).deliveredAt);
  });

  await t.test('la respuesta sobrevive un reinicio entre una superficie y la otra', async () => {
    const voice = alexaSession(backend);
    await voice(intent('FreeQueIntent', { query: 'clima hace mañana lento' }));
    await voice(intent('AMAZON.StopIntent'));
    await sleep(SLOW_MS + 200);
    await backend.stop();
    backend = await startBackend(dir, gateway.address().port);

    const mcp = await mcpClient(backend);
    const { tasks } = await mcp.call('list_tasks');
    assert.deepEqual(tasks.map(x => [x.question, x.status, x.origin]), [['qué clima hace mañana lento', 'done', 'voice']]);
    const result = await mcp.call('get_agent_result', { task_id: tasks[0].task_id });
    assert.equal(result.answer, 'Respuesta: qué clima hace mañana lento');
    await mcp.close();
  });
});
