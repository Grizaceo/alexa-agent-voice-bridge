// Agent Skills servidas por MCP: extensión io.modelcontextprotocol/skills (SEP-2640).
// Cada archivo de skills/<nombre>/ es un recurso skill://<nombre>/<ruta>; skills/list y skills/get
// devuelven el frontmatter tal cual y el manifiesto (SHA-256 y tamaño de los bytes que se sirven).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const YAML = require('yaml');
const { z } = require('zod');
const { ProtocolError, ProtocolErrorCode } = require('@modelcontextprotocol/server');

const SKILLS_DIR = path.join(__dirname, '..', 'skills');
const EXTENSION = 'io.modelcontextprotocol/skills';
const CACHE = { ttlMs: 5 * 60 * 1000, cacheScope: 'public' };
const MIME_TYPES = { '.md': 'text/markdown', '.json': 'application/json', '.txt': 'text/plain' };

function listFiles(dir, prefix = '') {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    return entry.isDirectory() ? listFiles(path.join(dir, entry.name), rel) : [rel];
  }).sort();
}

// Lee skills/ una vez al arrancar: los bytes servidos y los digests del manifiesto salen de la misma lectura.
function loadSkills(dir = SKILLS_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && fs.existsSync(path.join(dir, entry.name, 'SKILL.md')))
    .map(entry => {
      const root = path.join(dir, entry.name);
      const files = listFiles(root).map(rel => {
        const bytes = fs.readFileSync(path.join(root, rel));
        return {
          uri: `skill://${entry.name}/${rel}`,
          mimeType: MIME_TYPES[path.extname(rel)] || 'text/plain',
          text: bytes.toString('utf8'),
          digest: `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`,
          size: bytes.length,
        };
      });
      const skillMd = files.find(file => file.uri.endsWith(`${entry.name}/SKILL.md`));
      const frontmatter = YAML.parse(skillMd.text.match(/^---\r?\n([\s\S]*?)\r?\n---/)[1]);
      if (frontmatter.name !== entry.name) throw new Error(`skills/${entry.name}/SKILL.md: name "${frontmatter.name}" no coincide con la carpeta`);
      return {
        entry: { uri: skillMd.uri, frontmatter, resources: files.map(({ uri, digest, size }) => ({ uri, digest, size })) },
        files,
      };
    });
}

// Registra recursos y métodos en un McpServer creado con skillsCapabilities().
function registerSkills(mcpServer, skills) {
  for (const { files } of skills) {
    for (const file of files) {
      mcpServer.registerResource(file.uri, file.uri, { mimeType: file.mimeType }, async () => ({
        contents: [{ uri: file.uri, mimeType: file.mimeType, text: file.text }],
      }));
    }
  }
  const entries = skills.map(skill => skill.entry);
  mcpServer.server.setRequestHandler('skills/list', { params: z.object({ cursor: z.string().optional() }).loose() }, async () => ({
    resultType: 'complete',
    skills: entries,
    ...CACHE,
  }));
  mcpServer.server.setRequestHandler('skills/get', { params: z.object({ uri: z.string() }).loose() }, async ({ uri }) => {
    const skill = entries.find(entry => entry.uri === uri);
    if (!skill) throw new ProtocolError(ProtocolErrorCode.InvalidParams, `Unknown skill: ${uri}`);
    return { resultType: 'complete', skill, ...CACHE };
  });
}

function skillsCapabilities(skills) {
  return skills.length ? { resources: {}, extensions: { [EXTENSION]: {} } } : {};
}

module.exports = { loadSkills, registerSkills, skillsCapabilities, EXTENSION };
