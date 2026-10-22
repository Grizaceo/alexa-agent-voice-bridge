// Identificación por voz (Voice ID de Alexa): con VOICE_ID_MODE=enforce, el puente solo atiende al dueño.
// Alexa agrega context.System.person.personId a cada request cuyo hablante reconoce, si la skill tiene el
// permiso alexa::person_id:read y el Voice ID del usuario tiene activo "Personalizar skills".
// Sin reconocimiento (la TV, una visita, mucho ruido), el request llega sin person.
// modeEn fija el modo para los requests en inglés (locale en-*); por defecto es el mismo.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MODES = ['off', 'enroll', 'enforce'];

// Para el log: identifica a la persona sin escribir su personId.
const personHash = personId => (personId ? crypto.createHash('sha256').update(personId).digest('hex').slice(0, 8) : null);

function createVoiceId({ mode = 'off', modeEn = mode, ownerFile, ownerPersonId = '', log = () => {} }) {
  if (!MODES.includes(mode)) throw new Error(`VOICE_ID_MODE debe ser ${MODES.join(', ')} (llegó "${mode}")`);
  if (!MODES.includes(modeEn)) throw new Error(`VOICE_ID_MODE_EN debe ser ${MODES.join(', ')} (llegó "${modeEn}")`);
  let owner = ownerPersonId || readOwner();

  function readOwner() {
    try {
      return JSON.parse(fs.readFileSync(ownerFile, 'utf8')).personId || '';
    } catch {
      return '';
    }
  }

  function saveOwner(personId) {
    fs.mkdirSync(path.dirname(ownerFile), { recursive: true });
    const tmp = `${ownerFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ personId, enrolledAt: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, ownerFile);
  }

  // allowed: el request puede llegar al agente o a sus respuestas. En enforce sin dueño registrado,
  // basta con que Alexa reconozca la voz; con dueño, tiene que ser él.
  function check(requestEnvelope, kind) {
    const personId = requestEnvelope?.context?.System?.person?.personId || '';
    const locale = requestEnvelope?.request?.locale || null;
    const activeMode = /^en\b/i.test(locale || '') ? modeEn : mode;
    if (activeMode === 'enroll' && personId && !owner) {
      owner = personId;
      saveOwner(personId);
      log('voice_owner_enrolled', { person: personHash(personId) });
    }
    const isOwner = Boolean(personId) && (!owner || personId === owner);
    const allowed = activeMode !== 'enforce' || isOwner;
    log('voice_id', { mode: activeMode, kind, locale, recognized: Boolean(personId), person: personHash(personId), isOwner, allowed });
    return { allowed, recognized: Boolean(personId) };
  }

  return { check, status: () => ({ mode, ...(modeEn !== mode ? { modeEn } : {}), ownerEnrolled: Boolean(owner) }) };
}

module.exports = { createVoiceId, personHash };
