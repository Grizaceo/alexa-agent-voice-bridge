// skills/*/SKILL.md cumple la especificación de Agent Skills (https://agentskills.io/specification).
// La validación oficial es `skills-ref validate skills/voice-agent-bridge`; esto la repite sin Python.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const SKILLS_DIR = path.join(__dirname, '..', 'skills');
const skillDirs = fs.readdirSync(SKILLS_DIR).filter(name => fs.existsSync(path.join(SKILLS_DIR, name, 'SKILL.md')));

test('hay al menos una skill', () => {
  assert.ok(skillDirs.includes('voice-agent-bridge'));
});

for (const dir of skillDirs) {
  test(`${dir}/SKILL.md: frontmatter YAML válido y dentro de los límites`, () => {
    const text = fs.readFileSync(path.join(SKILLS_DIR, dir, 'SKILL.md'), 'utf8');
    const match = text.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(match, 'SKILL.md empieza con frontmatter YAML');
    const fm = YAML.parse(match[1]);

    assert.equal(fm.name, dir, 'name coincide con la carpeta');
    assert.match(fm.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(fm.name.length <= 64);
    assert.equal(typeof fm.description, 'string');
    assert.ok(fm.description.length >= 1 && fm.description.length <= 1024);
    if (fm.compatibility !== undefined) assert.ok(fm.compatibility.length >= 1 && fm.compatibility.length <= 500);
    if (fm.metadata !== undefined) assert.ok(Object.values(fm.metadata).every(value => typeof value === 'string'));
    const allowed = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
    assert.deepEqual(Object.keys(fm).filter(key => !allowed.has(key)), []);
    assert.ok(text.split('\n').length < 500, 'menos de 500 líneas');
  });
}

test('la skill nombra las herramientas que de verdad expone el servidor MCP', () => {
  const text = fs.readFileSync(path.join(SKILLS_DIR, 'voice-agent-bridge', 'SKILL.md'), 'utf8');
  const mcp = fs.readFileSync(path.join(__dirname, '..', 'src', 'mcp.js'), 'utf8');
  for (const tool of ['ask_agent', 'get_agent_result', 'list_tasks']) {
    assert.ok(text.includes(`\`${tool}\``), `SKILL.md menciona ${tool}`);
    assert.ok(mcp.includes(`registerTool('${tool}'`), `src/mcp.js registra ${tool}`);
  }
});
