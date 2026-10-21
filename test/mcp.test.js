// Servidor MCP en /mcp con el cliente oficial (@modelcontextprotocol/client), en las dos eras del protocolo,
// contra src/server.js real y un gateway falso del agente.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { z } = require('zod');
const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const { MCP_TOKEN, SLOW_MS, startGateway, startBackend, readTasks } = require('./helpers');

async function connect(backend, versionNegotiation) {
  const client = new Client({ name: 'mcp-test', version: '1.0.0' }, versionNegotiation ? { versionNegotiation } : {});
  const transport = new StreamableHTTPClientTransport(new URL(backend.mcp), {
    requestInit: { headers: { Authorization: `Bearer ${MCP_TOKEN}` } },
  });
  await client.connect(transport);
  return client;
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.notEqual(result.isError, true, JSON.stringify(result));
  // El texto lleva el mismo JSON que structuredContent, para clientes sin outputSchema.
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  return result.structuredContent;
}

const ERAS = [
  { name: '2025-11-25 (initialize, cliente por defecto)', versionNegotiation: null, expected: '2025-11-25' },
  { name: '2026-07-28 (server/discover, versión fijada)', versionNegotiation: { mode: { pin: '2026-07-28' } }, expected: '2026-07-28' },
];

test('MCP: herramientas en ambas eras, autenticación y Origin', async t => {
  const gateway = await startGateway();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-mcp-'));
  const backend = await startBackend(dir, gateway.address().port);
  t.after(async () => {
    await backend.stop();
    gateway.close();
  });

  for (const era of ERAS) {
    await t.test(`era ${era.name}`, async () => {
      const client = await connect(backend, era.versionNegotiation);
      assert.equal(client.getNegotiatedProtocolVersion(), era.expected);
      assert.equal(client.getServerVersion().name, 'alexa-agent-voice-bridge');

      const { tools } = await client.listTools();
      assert.deepEqual(tools.map(tool => tool.name).sort(), ['ask_agent', 'get_agent_result', 'list_tasks']);
      assert.ok(tools.every(tool => tool.outputSchema && tool.description));

      // Rápida: done dentro del plazo, sin Markdown, y queda entregada.
      const fast = await call(client, 'ask_agent', { question: `qué hora es (${era.expected})` });
      assert.equal(fast.status, 'done');
      assert.equal(fast.answer, `Respuesta: qué hora es (${era.expected})`);
      assert.ok(readTasks(dir).find(task => task.id === fast.task_id).deliveredAt);

      // Lenta: pending con task_id; get_agent_result la recoge después.
      const slow = await call(client, 'ask_agent', { question: `busca algo lento (${era.expected})`, wait_seconds: 0.1 });
      assert.deepEqual(Object.keys(slow).sort(), ['status', 'task_id']);
      assert.equal(slow.status, 'pending');
      assert.equal((await call(client, 'get_agent_result', { task_id: slow.task_id })).status, 'pending');
      const listed = await call(client, 'list_tasks', {});
      assert.ok(listed.tasks.some(task => task.task_id === slow.task_id && task.status === 'pending' && task.origin === 'mcp'));
      assert.ok(!listed.tasks.some(task => task.task_id === fast.task_id), 'list_tasks por defecto oculta las entregadas');

      const collected = await call(client, 'get_agent_result', { task_id: slow.task_id, wait_seconds: (SLOW_MS / 1000) * 3 });
      assert.deepEqual(collected, { status: 'done', task_id: slow.task_id, answer: `Respuesta: busca algo lento (${era.expected})` });
      const all = await call(client, 'list_tasks', { include_delivered: true });
      assert.ok(all.tasks.some(task => task.task_id === fast.task_id));

      assert.deepEqual(await call(client, 'get_agent_result', { task_id: 'no-existe' }), { status: 'expired' });
      // wait_seconds sobre el máximo se recorta a 20 s en vez de fallar.
      assert.equal((await call(client, 'ask_agent', { question: 'hola', wait_seconds: 999 })).status, 'done');
      await client.close();
    });
  }

  for (const era of ERAS) {
    await t.test(`Agent Skill servida por MCP (SEP-2640), era ${era.expected}`, async () => {
      const client = await connect(backend, era.versionNegotiation);
      const skillPath = path.join(__dirname, '..', 'skills', 'voice-agent-bridge', 'SKILL.md');
      const bytes = fs.readFileSync(skillPath);
      const uri = 'skill://voice-agent-bridge/SKILL.md';
      const anyResult = z.object({}).loose();

      const { skills } = await client.request({ method: 'skills/list', params: {} }, anyResult);
      assert.equal(skills.length, 1);
      assert.equal(skills[0].uri, uri);
      assert.equal(skills[0].frontmatter.name, 'voice-agent-bridge');
      assert.deepEqual(skills[0].resources, [{ uri, digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`, size: bytes.length }]);

      const { skill } = await client.request({ method: 'skills/get', params: { uri } }, anyResult);
      assert.deepEqual(skill, skills[0]);
      await assert.rejects(client.request({ method: 'skills/get', params: { uri: 'skill://nope/SKILL.md' } }, anyResult), error => error.code === -32602);

      const { contents } = await client.readResource({ uri });
      assert.equal(contents[0].mimeType, 'text/markdown');
      assert.equal(contents[0].text, bytes.toString('utf8'));
      await client.close();
    });
  }

  await t.test('una entrada inválida vuelve como error de la herramienta (SEP-1303)', async () => {
    const client = await connect(backend, null);
    const result = await client.callTool({ name: 'ask_agent', arguments: {} });
    assert.equal(result.isError, true);
    await client.close();
  });

  await t.test('HTTP: 401 sin token o con token incorrecto, 403 con Origin ajeno, 405 en GET y DELETE', async () => {
    const init = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'raw', version: '0' } } });
    const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
    const post = extra => fetch(backend.mcp, { method: 'POST', headers: { ...headers, ...extra }, body: init });

    const anonymous = await post({});
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('www-authenticate'), /^Bearer/);
    assert.equal((await post({ Authorization: 'Bearer otro-token' })).status, 401);
    assert.equal((await post({ Authorization: `Bearer ${MCP_TOKEN}`, Origin: 'https://evil.example' })).status, 403);
    // El Origin se valida antes que el token.
    assert.equal((await post({ Origin: 'https://evil.example' })).status, 403);
    assert.equal((await post({ Authorization: `Bearer ${MCP_TOKEN}`, Origin: 'http://localhost:6274' })).status, 200);

    const auth = { Authorization: `Bearer ${MCP_TOKEN}` };
    assert.equal((await fetch(backend.mcp, { headers: { ...auth, Accept: 'text/event-stream' } })).status, 405);
    assert.equal((await fetch(backend.mcp, { method: 'DELETE', headers: auth })).status, 405);
  });

  await t.test('sin MCP_TOKEN el MCP queda apagado (503) y la voz sigue funcionando', async () => {
    const off = await startBackend(fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bridge-mcp-off-')), gateway.address().port, { MCP_TOKEN: '' });
    try {
      assert.equal((await fetch(off.mcp, { method: 'POST' })).status, 503);
      assert.equal((await (await fetch(`${off.base}/health`)).json()).mcpEnabled, false);
    } finally {
      await off.stop();
    }
  });
});
