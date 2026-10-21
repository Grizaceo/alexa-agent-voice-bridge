// Servidor MCP (Streamable HTTP, SDK v2): la segunda superficie del mismo agente y del mismo almacén de tareas.
// Stateless: cada request HTTP crea su McpServer. El estado vive en src/agent.js y viaja como task_id.
// Sirve 2026-07-28 a los clientes que lo negocian y 2025-11-25 (o anteriores) a los demás, en el mismo endpoint.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { McpServer, createMcpHandler } = require('@modelcontextprotocol/server');
const { toNodeHandler, originValidation } = require('@modelcontextprotocol/node');
const { z } = require('zod');
const agent = require('./agent');
const { loadSkills, registerSkills, skillsCapabilities } = require('./skills');
const { version } = require('../package.json');

const MAX_WAIT_SECONDS = 20;
// MCP App (extensión io.modelcontextprotocol/ui): tablero de tareas que los hosts compatibles muestran junto a list_tasks.
const TASK_BOARD_URI = 'ui://voice-agent-bridge/task-board.html';
const TASK_BOARD_MIME = 'text/html;profile=mcp-app';
const TASK_BOARD_HTML = fs.readFileSync(path.join(__dirname, 'ui', 'task-board.html'), 'utf8');

const INSTRUCTIONS = [
  "This server is a bridge to the owner's personal agent: the same agent they talk to from their Amazon Echo.",
  'Ask it with ask_agent. Questions that need tools or web searches can take minutes: if ask_agent returns status "pending",',
  'tell the user you will get back to them, keep the conversation going, and later call get_agent_result with the task_id.',
  'list_tasks shows work started from any surface, including questions asked by voice on the Echo, so you can deliver answers the user asked for earlier.',
  'Answers are plain text meant to be spoken: reply in one or two sentences.',
].join(' ');

const TASK_STATUS = z.enum(['pending', 'done', 'failed']);

function waitMs(seconds, fallback) {
  const value = Number.isFinite(seconds) ? seconds : fallback;
  return Math.round(Math.min(Math.max(value, 0), MAX_WAIT_SECONDS) * 1000);
}

// structuredContent para clientes con outputSchema y el mismo JSON como texto para los demás.
function toolResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

// Entregar una tarea terminada a un cliente MCP la marca delivered: el Echo ya no la anuncia.
function taskResult(task) {
  if (!task) return { status: 'expired' };
  if (task.status === 'pending') return { status: 'pending', task_id: task.id };
  agent.markDelivered(task.id);
  return { status: task.status, task_id: task.id, answer: agent.stripMarkdown(task.answer) };
}

function buildServer(log, skills) {
  const server = new McpServer({ name: 'alexa-agent-voice-bridge', version }, { instructions: INSTRUCTIONS, capabilities: skillsCapabilities(skills) });
  // La Agent Skill que enseña a usar estas herramientas viaja con el propio servidor (SEP-2640).
  registerSkills(server, skills);

  server.registerTool('ask_agent', {
    title: 'Ask the personal agent',
    description: 'Ask the owner\'s personal agent a question in natural language. Waits up to wait_seconds for the answer; '
      + 'if the agent needs longer, returns status "pending" with a task_id to collect later with get_agent_result.',
    inputSchema: z.object({
      question: z.string().min(1).describe('What to ask, in the user\'s words.'),
      wait_seconds: z.number().optional().describe(`Seconds to wait for the answer before returning "pending". Default 5, maximum ${MAX_WAIT_SECONDS}.`),
    }),
    outputSchema: z.object({ status: TASK_STATUS, task_id: z.string(), answer: z.string().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  }, async ({ question, wait_seconds }) => {
    const started = agent.startTask(question, 'mcp');
    const result = taskResult((await agent.waitForTask(started.id, waitMs(wait_seconds, 5))) || started);
    log('mcp_tool', { tool: 'ask_agent', taskId: started.id, status: result.status });
    return toolResult(result);
  });

  server.registerTool('get_agent_result', {
    title: 'Get a pending answer',
    description: 'Get the answer to a task started by ask_agent or by voice on the Echo. Optionally waits up to wait_seconds. '
      + 'Status "expired" means the task does not exist or is older than its time to live.',
    inputSchema: z.object({
      task_id: z.string().min(1).describe('The task_id from ask_agent or list_tasks.'),
      wait_seconds: z.number().optional().describe(`Seconds to wait if the task is still running. Default 0, maximum ${MAX_WAIT_SECONDS}.`),
    }),
    outputSchema: z.object({ status: z.enum(['pending', 'done', 'failed', 'expired']), task_id: z.string().optional(), answer: z.string().optional() }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ task_id, wait_seconds }) => {
    const result = taskResult(await agent.waitForTask(task_id, waitMs(wait_seconds, 0)));
    log('mcp_tool', { tool: 'get_agent_result', taskId: task_id, status: result.status });
    return toolResult(result);
  });

  server.registerTool('list_tasks', {
    title: 'List agent tasks',
    description: 'List the agent\'s tasks from every surface (Echo voice and MCP), newest first. '
      + 'By default only tasks whose answer has not been delivered yet.',
    inputSchema: z.object({
      include_delivered: z.boolean().optional().describe('Also list tasks whose answer was already delivered. Default false.'),
    }),
    outputSchema: z.object({
      tasks: z.array(z.object({ task_id: z.string(), question: z.string(), status: TASK_STATUS, origin: z.enum(['voice', 'mcp']), created_at: z.string() })),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
    _meta: { ui: { resourceUri: TASK_BOARD_URI } },
  }, async ({ include_delivered }) => {
    const tasks = agent.listTasks({ includeDelivered: Boolean(include_delivered) }).map(task => ({
      task_id: task.id,
      question: task.question,
      status: task.status,
      origin: task.origin,
      created_at: task.createdAt,
    }));
    log('mcp_tool', { tool: 'list_tasks', count: tasks.length });
    return toolResult({ tasks });
  });

  // Los hosts sin MCP Apps ignoran _meta.ui y usan el texto de list_tasks.
  const boardMeta = { ui: { prefersBorder: true } };
  server.registerResource('task-board', TASK_BOARD_URI, { mimeType: TASK_BOARD_MIME, description: 'Interactive board of the agent tasks from every surface.', _meta: boardMeta }, async () => ({
    contents: [{ uri: TASK_BOARD_URI, mimeType: TASK_BOARD_MIME, text: TASK_BOARD_HTML, _meta: boardMeta }],
  }));

  return server;
}

function bearerAuth(token) {
  const expected = Buffer.from(`Bearer ${token}`);
  return (req, res, next) => {
    const given = Buffer.from(String(req.headers.authorization || ''));
    if (given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
    res.set('WWW-Authenticate', 'Bearer realm="mcp"');
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized: send Authorization: Bearer <MCP_TOKEN>.' }, id: null });
  };
}

// Monta /mcp en la app Express: Origin (403) → Bearer (401) → handler MCP. Sin token, el MCP queda apagado (503).
function mountMcp(app, { token, allowedOrigins, log = () => {} }) {
  if (!token) {
    app.all('/mcp', (_req, res) => res.status(503).json({ error: 'MCP is disabled: set MCP_TOKEN.' }));
    return false;
  }
  const checkOrigin = originValidation(allowedOrigins);
  const onerror = error => log('mcp_error', { error: error.message });
  const skills = loadSkills();
  const serve = toNodeHandler(createMcpHandler(() => buildServer(log, skills), { onerror }), { onerror });
  app.all('/mcp', (req, res, next) => { if (checkOrigin(req, res)) next(); }, bearerAuth(token), (req, res) => serve(req, res));
  return true;
}

module.exports = { mountMcp };
