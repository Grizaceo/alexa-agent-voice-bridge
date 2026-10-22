// Corre las frases de prueba contra el modelo de la skill (stage development) con
// `ask smapi profile-nlu` y muestra qué intent elige Alexa para cada frase.
// Uso: npm run nlu [-- --group free] [-- --locale en-US]   (ALEXA_SKILL_ID y ALEXA_LOCALE desde .env)
// Frases: test/nlu-cases.<locale>.json si existe (en-US); si no, test/nlu-cases.json (español).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const SKILL_ID = process.env.ALEXA_SKILL_ID || '';
const localeArg = process.argv.indexOf('--locale');
const LOCALE = localeArg > -1 ? process.argv[localeArg + 1] : (process.env.ALEXA_LOCALE || 'es-US');
const groupArg = process.argv.indexOf('--group');
const ONLY_GROUP = groupArg > -1 ? process.argv[groupArg + 1] : null;

if (!SKILL_ID) {
  console.error('Falta ALEXA_SKILL_ID (en .env o como variable de entorno).');
  process.exit(2);
}

const ownCases = path.join(__dirname, '..', 'test', `nlu-cases.${LOCALE}.json`);
const casesFile = fs.existsSync(ownCases) ? ownCases : path.join(__dirname, '..', 'test', 'nlu-cases.json');
const { cases } = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
const selected = cases.filter(c => !ONLY_GROUP || c.group === ONLY_GROUP);

function profile(utterance) {
  const out = execFileSync('ask', ['smapi', 'profile-nlu', '-s', SKILL_ID, '-l', LOCALE, '-u', utterance, '--profile', process.env.ASK_PROFILE || 'default'], { encoding: 'utf8' });
  const data = JSON.parse(out);
  const intent = data?.selectedIntent?.name || '(none)';
  const query = data?.selectedIntent?.slots?.query?.value || null;
  return { intent, query };
}

// 'DAVI' = cualquier intent que el backend reenvía a Hermes.
function matches(intent, expect) {
  if (expect === 'DAVI') return ['TalkToDaviIntent', 'AboutDaviIntent', 'CapabilitiesIntent'].includes(intent) || /^Free[A-Za-z]+Intent$/.test(intent);
  return intent === expect;
}

let pass = 0;
for (const c of selected) {
  let result;
  try {
    result = profile(c.utterance);
  } catch (error) {
    result = { intent: `ERROR: ${String(error.stderr || error.message).split('\n')[0]}`, query: null };
  }
  const ok = matches(result.intent, c.expect);
  if (ok) pass += 1;
  const slot = result.query ? ` [query="${result.query}"]` : '';
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${c.group.padEnd(8)} "${c.utterance}" -> ${result.intent}${slot}${ok ? '' : ` (esperado ${c.expect})`}`);
}
console.log(`\n${pass}/${selected.length} frases llegan al intent esperado (${LOCALE}).`);
process.exit(pass === selected.length ? 0 : 1);
