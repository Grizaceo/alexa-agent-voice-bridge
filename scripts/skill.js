// Administra la skill desde la terminal con ASK CLI (sin la consola web de Amazon).
// Uso:
//   node scripts/skill.js create [--dry-run]    crea la skill, sube el modelo y la habilita para pruebas
//   node scripts/skill.js model                 sube config/interaction-model.json a todos los locales y espera el build
//   node scripts/skill.js endpoint [--dry-run]  actualiza el manifiesto (endpoint y nombre) de ALEXA_SKILL_ID
//   node scripts/skill.js simulate "abre mango" [--new]   simula una frase de punta a punta (Amazon → tu backend)
// Requiere `ask configure` hecho (perfil en ~/.ask/cli_config) y las variables de .env.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ROOT = path.join(__dirname, '..');
const ENV_FILE = path.join(ROOT, '.env');
const MODEL_FILE = path.join(ROOT, 'config', 'interaction-model.json');
const MANIFEST_FILE = path.join(ROOT, 'config', 'skill-manifest.json');
const ASK_PROFILE = process.env.ASK_PROFILE || 'default';
const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Mango';
const ALEXA_ENDPOINT = process.env.ALEXA_ENDPOINT || '';
const ALEXA_LOCALE = process.env.ALEXA_LOCALE || 'es-US';

const [command, ...args] = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

function smapi(...smapiArgs) {
  const out = execFileSync('ask', ['smapi', ...smapiArgs, '--profile', ASK_PROFILE], { encoding: 'utf8' });
  try {
    return JSON.parse(out);
  } catch {
    return out;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requireSkillId() {
  const skillId = process.env.ALEXA_SKILL_ID || '';
  if (!skillId) throw new Error('Falta ALEXA_SKILL_ID en .env (lo deja `create`).');
  return skillId;
}

function buildManifest() {
  if (!/^https:\/\/[^/]+\/alexa$/.test(ALEXA_ENDPOINT)) {
    throw new Error('ALEXA_ENDPOINT debe ser https://<host>/alexa (Alexa exige HTTPS en el puerto 443).');
  }
  const doc = JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8'));
  doc.manifest.apis.custom.endpoint.uri = ALEXA_ENDPOINT;
  for (const locale of Object.values(doc.manifest.publishingInformation.locales)) {
    locale.name = ASSISTANT_NAME;
  }
  return doc;
}

function manifestLocales() {
  return Object.keys(JSON.parse(fs.readFileSync(MANIFEST_FILE, 'utf8')).manifest.publishingInformation.locales);
}

function writeTempJson(data) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alexa-skill-'));
  const file = path.join(dir, 'body.json');
  fs.writeFileSync(file, JSON.stringify(data));
  return file;
}

function readVendorId() {
  const config = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.ask', 'cli_config'), 'utf8'));
  const vendorId = config?.profiles?.[ASK_PROFILE]?.vendor_id;
  if (!vendorId) throw new Error(`El perfil ASK "${ASK_PROFILE}" no tiene vendor_id. Corre \`ask configure\`.`);
  return vendorId;
}

function saveEnvValue(key, value) {
  const current = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : '';
  const line = `${key}=${value}`;
  const next = new RegExp(`^${key}=.*$`, 'm').test(current)
    ? current.replace(new RegExp(`^${key}=.*$`, 'm'), line)
    : `${current.replace(/\n?$/, '\n')}${line}\n`;
  fs.writeFileSync(ENV_FILE, next);
}

// get-skill-status puede seguir mostrando el build anterior unos segundos después de subir.
async function waitForStatus(skillId, resource, pick) {
  await sleep(15000);
  for (let i = 0; i < 60; i += 1) {
    const status = smapi('get-skill-status', '-s', skillId, '--resource', resource);
    const states = pick(status);
    if (!Object.values(states).some(s => s.status === 'IN_PROGRESS')) return states;
    await sleep(10000);
  }
  throw new Error(`Timeout esperando ${resource}.`);
}

async function uploadModel(skillId) {
  const locales = manifestLocales();
  for (const locale of locales) {
    smapi('set-interaction-model', '-s', skillId, '-l', locale, '--interaction-model', `file:${MODEL_FILE}`);
    console.log(`modelo subido: ${locale}`);
  }
  const states = await waitForStatus(skillId, 'interactionModel', status => Object.fromEntries(
    locales.map(locale => [locale, status.interactionModel?.[locale]?.lastUpdateRequest || {}])));
  let ok = true;
  for (const [locale, state] of Object.entries(states)) {
    console.log(`build ${locale}: ${state.status}`);
    for (const error of state.errors || []) {
      ok = false;
      console.log(`  error: ${error.message}`);
    }
    if (state.status !== 'SUCCEEDED') ok = false;
  }
  if (!ok) process.exitCode = 1;
}

async function updateManifest(skillId) {
  const manifest = buildManifest();
  if (DRY_RUN) return console.log(JSON.stringify(manifest, null, 2));
  smapi('update-skill-manifest', '-s', skillId, '--manifest', `file:${writeTempJson(manifest)}`);
  const states = await waitForStatus(skillId, 'manifest', status => ({ manifest: status.manifest?.lastUpdateRequest || {} }));
  console.log(`manifiesto: ${states.manifest.status}`);
  for (const error of states.manifest.errors || []) console.log(`  error: ${error.message}`);
}

async function create() {
  const body = { vendorId: readVendorId(), ...buildManifest() };
  if (DRY_RUN) return console.log(JSON.stringify(body, null, 2));
  const { skillId } = smapi('create-skill-for-vendor', '--manifest', `file:${writeTempJson(body)}`);
  console.log(`skill creada: ${skillId}`);
  saveEnvValue('ALEXA_SKILL_ID', skillId);
  console.log('ALEXA_SKILL_ID guardado en .env');
  await waitForStatus(skillId, 'manifest', status => ({ manifest: status.manifest?.lastUpdateRequest || {} }));
  await uploadModel(skillId);
  smapi('set-skill-enablement', '-s', skillId, '-g', 'development');
  console.log('skill habilitada para pruebas en los dispositivos de tu cuenta Amazon.');
}

async function simulate(text, forceNew) {
  const skillId = requireSkillId();
  const sessionArgs = forceNew ? ['--session-mode', 'FORCE_NEW_SESSION'] : [];
  const { id } = smapi('simulate-skill', '-s', skillId, '--input-content', text, '--device-locale', ALEXA_LOCALE, ...sessionArgs);
  let result;
  for (let i = 0; i < 30; i += 1) {
    result = smapi('get-skill-simulation', '-s', skillId, '-i', id);
    if (result.status !== 'IN_PROGRESS') break;
    await sleep(1500);
  }
  const caption = result?.result?.alexaExecutionInfo?.alexaResponses?.[0]?.content?.caption || '';
  const reachedSkill = (result?.result?.skillExecutionInfo?.invocations || []).length > 0;
  console.log(`${reachedSkill ? 'skill' : 'NO llegó a la skill'} | "${text}" -> ${caption}`);
  if (result?.result?.error) console.log(`  error: ${result.result.error.message}`);
}

async function main() {
  if (command === 'create') return create();
  if (command === 'model') return uploadModel(requireSkillId());
  if (command === 'endpoint') return updateManifest(requireSkillId());
  if (command === 'simulate' && args[0] && !args[0].startsWith('--')) return simulate(args[0], args.includes('--new'));
  console.log('Uso: node scripts/skill.js create|model|endpoint [--dry-run] | simulate "<frase>" [--new]');
  process.exitCode = 2;
}

main().catch(error => {
  console.error(error.stderr ? String(error.stderr).trim() : error.message);
  process.exitCode = 1;
});
