const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const Alexa = require('ask-sdk-core');
const { ExpressAdapter } = require('ask-sdk-express-adapter');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const agent = require('./agent');
const { stripMarkdown } = agent;
const { mountMcp } = require('./mcp');
const { createVoiceId } = require('./voice-id');

const PORT = Number(process.env.PORT || 3107);
// Solo localhost: Tailscale Funnel llega por 127.0.0.1 y la spec MCP pide no exponer servidores locales.
const HOST = process.env.HOST || '127.0.0.1';
// Token del servidor MCP en /mcp. Sin él, /mcp responde 503.
const MCP_TOKEN = process.env.MCP_TOKEN || '';
// Hostnames permitidos en el header Origin de /mcp (los clientes que no son navegador no lo mandan).
const MCP_ALLOWED_ORIGINS = (process.env.MCP_ALLOWED_ORIGINS || 'localhost,127.0.0.1,[::1]').split(',').map(s => s.trim()).filter(Boolean);
// Nombre con que la skill se presenta por voz ("Mango listo. Puedes hablarme.").
const ASSISTANT_NAME = process.env.ASSISTANT_NAME || 'Mango';
const ALEXA_SKILL_ID = process.env.ALEXA_SKILL_ID || '';
const HERMES_GATEWAY_URL = (process.env.HERMES_GATEWAY_URL || 'http://127.0.0.1:8642/v1/chat/completions').replace(/\/+$/, '');
const HERMES_API_MODEL = process.env.HERMES_API_MODEL || 'hermes-agent';
const SESSION_FILE = path.resolve(process.env.SESSION_FILE || path.join(__dirname, '..', 'data', 'sessions.json'));
const DEBUG_LOG_FILE = path.resolve(process.env.ALEXA_DEBUG_LOG || path.join(__dirname, '..', 'data', 'alexa-debug.log'));
const ALLOW_USER_IDS = new Set((process.env.ALLOW_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
const PIN_REQUIRED = String(process.env.PIN_REQUIRED || 'false').toLowerCase() === 'true';
const ALEXA_LINK_PIN = process.env.ALEXA_LINK_PIN || '';
// Bypass de verificación de firma para tests locales.
// En PRODUCCIÓN nunca se debe activar (Alexa firma cada request con su cert chain).
// Se enciende solo cuando ALEXA_SKIP_VERIFICATION=true en .env local.
const ALEXA_SKIP_VERIFICATION = String(process.env.ALEXA_SKIP_VERIFICATION || 'false').toLowerCase() === 'true';
// Alexa corta a los ~8 s (incluido el relay de Tailscale). Pasado este plazo se responde
// "lo estoy pensando" y la tarea sigue corriendo en src/agent.js (hasta HERMES_MAX_WAIT_MS).
const VOICE_GATEWAY_TIMEOUT_MS = Number(process.env.VOICE_GATEWAY_TIMEOUT_MS || 5000);
// Frase con la que el usuario vuelve a abrir la skill (rutina de la app Alexa).
const RETURN_PHRASE = process.env.ALEXA_RETURN_PHRASE || 'Alexa, mango';
// taskId -> cuántas veces "repite" esperó sin respuesta. Solo afecta a cuándo se corta la conversación.
const stillWorkingCounts = new Map();
// Identificación por voz: off (solo registra si Alexa reconoció la voz), enroll (guarda al primer
// hablante reconocido como dueño) o enforce (solo el dueño llega al agente). Ver src/voice-id.js.
const voiceId = createVoiceId({
  mode: process.env.VOICE_ID_MODE || 'off',
  ownerFile: path.resolve(process.env.VOICE_OWNER_FILE || path.join(__dirname, '..', 'data', 'voice-owner.json')),
  ownerPersonId: process.env.VOICE_OWNER_PERSON_ID || '',
  log: logDebug,
});
// Frases seguidas de otras voces tras las que se cierra la sesión, y si se ignoran en silencio.
const VOICE_ID_MAX_IGNORED = Number(process.env.VOICE_ID_MAX_IGNORED || 3);
const VOICE_ID_SILENT = String(process.env.VOICE_ID_SILENT || 'false').toLowerCase() === 'true';
// Free*Intent capturan habla libre ("qué {query}", "busca {query}"). Alexa no incluye
// la palabra inicial en el slot, así que se reconstruye desde la primera muestra del modelo.
const INTERACTION_MODEL_INTENTS = loadInteractionModelIntents();
const FREE_INTENT_LEADS = Object.fromEntries(INTERACTION_MODEL_INTENTS
  .filter(intent => /^Free[A-Za-z]+Intent$/.test(intent.name) && intent.samples?.length)
  .map(intent => [intent.name, intent.samples[0].replace('{query}', '').trim()]));
// Palabra de cierre = primera muestra de AMAZON.StopIntent en el modelo ("maracuyá").
const CLOSE_WORD = INTERACTION_MODEL_INTENTS.find(intent => intent.name === 'AMAZON.StopIntent')?.samples?.[0] || 'adiós';

function loadInteractionModelIntents() {
  try {
    const model = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', 'interaction-model.json'), 'utf8'));
    return model?.interactionModel?.languageModel?.intents || [];
  } catch {
    return [];
  }
}

function ensureSessionStore() {
  fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
  if (!fs.existsSync(SESSION_FILE)) fs.writeFileSync(SESSION_FILE, JSON.stringify({}, null, 2));
}
function readSessions() {
  ensureSessionStore();
  return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
}
function writeSessions(data) {
  ensureSessionStore();
  fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
}
function logDebug(event, payload = {}) {
  try {
    fs.mkdirSync(path.dirname(DEBUG_LOG_FILE), { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), event, ...payload });
    fs.appendFileSync(DEBUG_LOG_FILE, line + '\n');
  } catch {}
}
function getAlexaUserId(handlerInput) {
  return handlerInput.requestEnvelope?.context?.System?.user?.userId || handlerInput.requestEnvelope?.session?.user?.userId || 'unknown';
}
function getAlexaDeviceId(handlerInput) {
  return handlerInput.requestEnvelope?.context?.System?.device?.deviceId || 'unknown-device';
}
function getAllowed(userId) {
  if (ALLOW_USER_IDS.size === 0) return true;
  return ALLOW_USER_IDS.has(userId);
}
function getSessionState(userId) {
  const db = readSessions();
  const defaults = { linked: !PIN_REQUIRED, hermesSessionKey: null, lastSeenAt: null, lastDeviceId: null };
  return { ...defaults, ...(db[userId] || {}) };
}
function setSessionState(userId, patch) {
  const db = readSessions();
  db[userId] = { ...(db[userId] || {}), ...patch };
  writeSessions(db);
  return db[userId];
}
function ssml(text) {
  const safe = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim();
  return `<speak>${safe}</speak>`;
}
// Alexa normaliza "un"/"una" a "1" dentro de AMAZON.SearchQuery ("1 correo").
function normalizeSpokenQuery(text) {
  return String(text || '').replace(/(^|\s)1(?=\s+[a-záéíóúñ])/gi, '$1un');
}
function getFastSystemStatusReply() {
  const mem = os.totalmem() > 0 ? Math.round((os.freemem() / os.totalmem()) * 100) : null;
  const load = Array.isArray(os.loadavg()) ? os.loadavg()[0] : 0;
  const uptimeMin = Math.round(process.uptime() / 60);
  const memText = mem == null ? 'memoria no disponible' : `memoria libre aproximada ${mem} por ciento`;
  const loadText = Number.isFinite(load) ? `carga ${load.toFixed(2)}` : 'carga no disponible';
  return `Estado rápido: backend Alexa activo, gateway configurado, modelo ${HERMES_API_MODEL}, ${memText}, ${loadText}, uptime del backend ${uptimeMin} minutos.`;
}
function resolveFastPath(utterance) {
  const text = String(utterance || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  if (!text) return null;
  if (text.includes('estado del sistema') || text === 'estado sistema' || text === 'como esta el sistema' || text === 'como esta el estado del sistema') {
    return getFastSystemStatusReply();
  }
  return null;
}
// true si quien habla puede usar el agente (siempre, salvo VOICE_ID_MODE=enforce); reinicia la cuenta de ignoradas.
function speakerAllowed(handlerInput, kind) {
  if (!voiceId.check(handlerInput.requestEnvelope, kind).allowed) return false;
  const sessionAttrs = handlerInput.attributesManager.getSessionAttributes();
  if (sessionAttrs.ignoredCount) handlerInput.attributesManager.setSessionAttributes({ ...sessionAttrs, ignoredCount: 0 });
  return true;
}
// Una voz que no es la del dueño: no crea tarea ni entra al historial, y la sesión sigue escuchando.
function ignoreSpeaker(handlerInput) {
  const sessionAttrs = handlerInput.attributesManager.getSessionAttributes();
  const ignoredCount = (sessionAttrs.ignoredCount || 0) + 1;
  handlerInput.attributesManager.setSessionAttributes({ ...sessionAttrs, ignoredCount });
  if (ignoredCount >= VOICE_ID_MAX_IGNORED) {
    return handlerInput.responseBuilder
      .speak(ssml('No reconozco esta voz. Hasta luego.'))
      .withShouldEndSession(true)
      .getResponse();
  }
  if (VOICE_ID_SILENT) return handlerInput.responseBuilder.withShouldEndSession(false).getResponse();
  return handlerInput.responseBuilder
    .speak(ssml('No reconocí tu voz. Si me hablabas a mí, repítelo.'))
    .reprompt(ssml('Te escucho.'))
    .withShouldEndSession(false)
    .getResponse();
}
// La tarea que espera esta conversación de voz o, si no tiene, la última pendiente de cualquier superficie.
function findVoiceTask(sessionAttrs) {
  const own = sessionAttrs.pendingTaskId ? agent.getTask(sessionAttrs.pendingTaskId) : null;
  return own || agent.listTasks().find(task => task.status === 'pending') || null;
}
// Lee la respuesta de una tarea terminada, la marca entregada y la suma al historial de la sesión.
function deliverTask(handlerInput, task, intro = '') {
  agent.markDelivered(task.id);
  stillWorkingCounts.delete(task.id);
  const sessionAttrs = handlerInput.attributesManager.getSessionAttributes();
  const history = [
    ...(sessionAttrs.history || []),
    { role: 'user', content: task.question },
    { role: 'assistant', content: task.answer },
  ].slice(-20);
  handlerInput.attributesManager.setSessionAttributes({
    ...sessionAttrs,
    history,
    lastQuery: task.question,
    lastReply: task.answer,
    pendingTaskId: null,
  });
  logDebug('pending_reply_delivered', { taskId: task.id, origin: task.origin, waitedMs: Date.now() - Date.parse(task.createdAt) });
  return handlerInput.responseBuilder
    .speak(ssml(`${intro}${stripMarkdown(task.answer)}`))
    .reprompt(ssml('¿Algo más?'))
    .withShouldEndSession(false)
    .getResponse();
}

const LaunchRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'LaunchRequest';
  },
  handle(handlerInput) {
    const userId = getAlexaUserId(handlerInput);
    const allowed = getAllowed(userId);
    logDebug('launch', { userId, allowed });
    if (!allowed) {
      return handlerInput.responseBuilder
        .speak(ssml(`Este usuario de Alexa no está autorizado todavía para usar a ${ASSISTANT_NAME}.`))
        .withShouldEndSession(true)
        .getResponse();
    }
    const state = getSessionState(userId);
    // Solo se anuncia la última tarea done sin entregar, venga de la voz o de un cliente MCP,
    // y con VOICE_ID_MODE=enforce solo si quien abre es el dueño.
    const ready = state.linked && speakerAllowed(handlerInput, 'launch') ? agent.latestUndelivered() : null;
    if (ready) {
      return deliverTask(handlerInput, ready, 'Tengo la respuesta a lo que me pediste. ');
    }
    const pending = findVoiceTask({});
    if (pending) {
      handlerInput.attributesManager.setSessionAttributes({ ...handlerInput.attributesManager.getSessionAttributes(), pendingTaskId: pending.id });
    }
    const greeting = pending
      ? `${ASSISTANT_NAME} listo. Sigo trabajando en lo que me pediste antes; di repite para esperarla, o pídeme otra cosa.`
      : `${ASSISTANT_NAME} listo. Puedes hablarme.`;
    const speech = state.linked
      ? greeting
      : `${ASSISTANT_NAME} listo. Antes de usar esta skill, el dueño de la skill tiene que vincular esta cuenta.`;
    return handlerInput.responseBuilder
      .speak(ssml(speech))
      .reprompt(ssml('Puedes decirme qué necesitas.'))
      .withShouldEndSession(false)
      .getResponse();
  }
};

const TalkToDaviIntentHandler = {
  canHandle(handlerInput) {
    if (Alexa.getRequestType(handlerInput.requestEnvelope) !== 'IntentRequest') return false;
    const intentName = Alexa.getIntentName(handlerInput.requestEnvelope);
    return ['TalkToDaviIntent', 'AboutDaviIntent', 'CapabilitiesIntent'].includes(intentName)
      || Object.hasOwn(FREE_INTENT_LEADS, intentName);
  },
  async handle(handlerInput) {
    const userId = getAlexaUserId(handlerInput);
    const deviceId = getAlexaDeviceId(handlerInput);
    if (!getAllowed(userId)) {
      return handlerInput.responseBuilder
        .speak(ssml(`Este usuario no está autorizado para usar a ${ASSISTANT_NAME}.`))
        .withShouldEndSession(true)
        .getResponse();
    }

    const state = getSessionState(userId);
    if (PIN_REQUIRED && !state.linked) {
      return handlerInput.responseBuilder
        .speak(ssml('Esta cuenta todavía no está vinculada. Pide al dueño de la skill que complete la vinculación.'))
        .withShouldEndSession(true)
        .getResponse();
    }
    // La TV o alguien que le habla al usuario no llegan al agente (VOICE_ID_MODE=enforce).
    if (!speakerAllowed(handlerInput, 'talk')) return ignoreSpeaker(handlerInput);

    const intentName = Alexa.getIntentName(handlerInput.requestEnvelope);

    // Recuperar historial conversacional desde session attributes de Alexa
    const sessionAttrs = handlerInput.attributesManager.getSessionAttributes();
    const slots = handlerInput.requestEnvelope?.request?.intent?.slots || {};
    let utterance = normalizeSpokenQuery(slots.query?.value || slots.message?.value || '');
    if (utterance && FREE_INTENT_LEADS[intentName]) {
      utterance = `${FREE_INTENT_LEADS[intentName]} ${utterance}`;
    }
    if (!utterance && intentName === 'AboutDaviIntent') {
      utterance = '¿Quién eres?';
    }
    if (!utterance && intentName === 'CapabilitiesIntent') {
      utterance = '¿Para qué sirves y cómo puedes ayudarme?';
    }
    logDebug('talk_intent_received', {
      userId,
      deviceId,
      intentName,
      utterance,
      turnCountBefore: sessionAttrs?.turnCount || 0,
    });
    if (!utterance) {
      return handlerInput.responseBuilder
        .speak(ssml('No alcancé a entender qué querías decirme. Inténtalo de nuevo.'))
        .reprompt(ssml('Puedes decir, por ejemplo: qué hora es en Santiago.'))
        .withShouldEndSession(false)
        .getResponse();
    }
    const turnCount = (sessionAttrs.turnCount || 0) + 1;
    const history = sessionAttrs.history || [];

    const fastReply = resolveFastPath(utterance);
    let result = fastReply ? { ok: true, text: fastReply } : null;
    let task = null;
    if (!fastReply) {
      setSessionState(userId, { lastSeenAt: new Date().toISOString() });
      // La tarea sigue en segundo plano si no termina dentro del límite de voz.
      const started = agent.startTask(utterance, 'voice', { history, hermesSessionKey: state.hermesSessionKey });
      task = (await agent.waitForTask(started.id, VOICE_GATEWAY_TIMEOUT_MS)) || started;
      if (task.status !== 'pending') {
        agent.markDelivered(task.id);
        result = { ok: task.status === 'done', text: task.answer };
      }
    }
    logDebug('talk_intent_result', {
      userId,
      deviceId,
      intentName,
      turnCount,
      taskId: task?.id || null,
      ok: result ? result.ok : null,
      pending: !result,
      replyPreview: String(result?.text || '').slice(0, 160),
    });

    if (!result) {
      handlerInput.attributesManager.setSessionAttributes({ ...sessionAttrs, turnCount, history, lastQuery: utterance, pendingTaskId: task.id });
      return handlerInput.responseBuilder
        .speak(ssml(`Me va a tomar un momento. Di repite en unos segundos, o más tarde dime ${RETURN_PHRASE}, y te cuento.`))
        .reprompt(ssml('Di repite cuando quieras escuchar la respuesta.'))
        .withShouldEndSession(false)
        .getResponse();
    }

    // Guardar estado conversacional en session attributes para el proximo turno
    const newHistory = [
      ...history,
      { role: 'user', content: utterance },
      { role: 'assistant', content: result.text },
    ];
    // Limitar a los ultimos 10 intercambios (20 mensajes) para no exceder el limite de Alexa
    const trimmedHistory = newHistory.slice(-20);
    handlerInput.attributesManager.setSessionAttributes({
      turnCount,
      history: trimmedHistory,
      lastQuery: utterance,
      lastReply: result.text,
    });

    return handlerInput.responseBuilder
      .speak(ssml(stripMarkdown(result.text)))
      .reprompt(ssml('Si quieres, puedes seguir hablando conmigo.'))
      .withShouldEndSession(false)
      .getResponse();
  }
};

const LinkIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'LinkIntent';
  },
  handle(handlerInput) {
    const userId = getAlexaUserId(handlerInput);
    const pin = handlerInput.requestEnvelope?.request?.intent?.slots?.pin?.value || '';
    if (!PIN_REQUIRED) {
      setSessionState(userId, { linked: true });
      return handlerInput.responseBuilder.speak(ssml('Esta skill no requiere PIN. La cuenta quedó habilitada.')).getResponse();
    }
    if (pin && ALEXA_LINK_PIN && pin === String(ALEXA_LINK_PIN)) {
      setSessionState(userId, { linked: true, hermesSessionKey: String(Date.now()) });
      return handlerInput.responseBuilder.speak(ssml(`Vinculación correcta. Ya puedes hablar con ${ASSISTANT_NAME}.`)).getResponse();
    }
    return handlerInput.responseBuilder
      .speak(ssml('El PIN no coincide. Pide al dueño de la skill revisar la vinculación.'))
      .withShouldEndSession(true)
      .getResponse();
  }
};

const RepeatIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.RepeatIntent';
  },
  async handle(handlerInput) {
    if (!speakerAllowed(handlerInput, 'repeat')) return ignoreSpeaker(handlerInput);
    const sessionAttrs = handlerInput.attributesManager.getSessionAttributes();
    let task = findVoiceTask(sessionAttrs);
    // Esperar dentro de este mismo turno antes de pedir otro "repite".
    if (task?.status === 'pending') task = (await agent.waitForTask(task.id, VOICE_GATEWAY_TIMEOUT_MS)) || task;
    if (task && task.status !== 'pending') return deliverTask(handlerInput, task);
    if (task) {
      const stillWorkingCount = (stillWorkingCounts.get(task.id) || 0) + 1;
      stillWorkingCounts.set(task.id, stillWorkingCount);
      logDebug('repeat_intent', { pending: true, taskId: task.id, waitedMs: Date.now() - Date.parse(task.createdAt), stillWorkingCount });
      // A la segunda espera fallida se corta: la respuesta queda guardada para la próxima apertura.
      if (stillWorkingCount >= 2) {
        return handlerInput.responseBuilder
          .speak(ssml(`Sigue trabajando y te guardo la respuesta. Cuando quieras, dime ${RETURN_PHRASE}, y te la leo.`))
          .withShouldEndSession(true)
          .getResponse();
      }
      return handlerInput.responseBuilder
        .speak(ssml('Todavía estoy en eso. Di repite en unos segundos.'))
        .reprompt(ssml('Di repite cuando quieras escuchar la respuesta.'))
        .withShouldEndSession(false)
        .getResponse();
    }
    const lastReply = sessionAttrs.lastReply || 'No tengo nada que repetir todavía.';
    logDebug('repeat_intent', { pending: false, lastReplyPreview: String(lastReply).slice(0, 160) });
    return handlerInput.responseBuilder
      .speak(ssml(stripMarkdown(lastReply)))
      .reprompt(ssml('¿Algo más?'))
      .withShouldEndSession(false)
      .getResponse();
  }
};

const HelpIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.HelpIntent';
  },
  handle(handlerInput) {
    logDebug('help_intent', {});
    return handlerInput.responseBuilder
      .speak(ssml(`Pregúntame lo que quieras empezando con qué, cuál, cómo, busca o pon. Si tardo, di repite. Para terminar, di ${CLOSE_WORD}.`))
      .reprompt(ssml('Prueba diciendo: qué hora es en Santiago.'))
      .withShouldEndSession(false)
      .getResponse();
  }
};

const CancelAndStopIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && ['AMAZON.CancelIntent', 'AMAZON.StopIntent'].includes(Alexa.getIntentName(handlerInput.requestEnvelope));
  },
  handle(handlerInput) {
    // "maracuyá" cae aquí (muestra de AMAZON.StopIntent). Una respuesta pendiente no se descarta.
    const task = findVoiceTask(handlerInput.attributesManager.getSessionAttributes());
    const saved = task && (task.status === 'pending' || (task.status === 'done' && !task.deliveredAt));
    const speech = saved
      ? `Listo. Te guardo la respuesta que sigue en curso; dime ${RETURN_PHRASE} cuando quieras escucharla.`
      : 'Listo, hasta luego.';
    return handlerInput.responseBuilder
      .speak(ssml(speech))
      .withShouldEndSession(true)
      .getResponse();
  }
};

const FallbackIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest'
      && Alexa.getIntentName(handlerInput.requestEnvelope) === 'AMAZON.FallbackIntent';
  },
  handle(handlerInput) {
    logDebug('fallback_intent', {
      requestType: Alexa.getRequestType(handlerInput.requestEnvelope),
      intentName: Alexa.getIntentName(handlerInput.requestEnvelope),
    });
    return handlerInput.responseBuilder
      .speak(ssml('No entendí esa petición. Puedes intentar con: quién eres, háblame de ti, o ayúdame con una idea.'))
      .reprompt(ssml('Puedes decir: quién eres, háblame de ti, o ayúdame con una idea.'))
      .withShouldEndSession(false)
      .getResponse();
  }
};

const UnknownIntentHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'IntentRequest';
  },
  handle(handlerInput) {
    const intentName = Alexa.getIntentName(handlerInput.requestEnvelope);
    const slots = handlerInput.requestEnvelope?.request?.intent?.slots || {};
    const slotSummary = Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, v?.value || null]));
    logDebug('unknown_intent', {
      requestType: Alexa.getRequestType(handlerInput.requestEnvelope),
      intentName,
      slots: slotSummary,
    });

    const isSendToPhone = intentName === 'AMAZON.SendToPhoneIntent';
    const speech = isSendToPhone
      ? `Alexa entendió una intención del sistema llamada Send To Phone en vez de mandarla a ${ASSISTANT_NAME}. No empieces con dime. Prueba diciendo solo: quién eres, o háblame de ti.`
      : `Alexa entendió otra intención distinta a ${ASSISTANT_NAME}. Intento detectado: ${intentName}. Prueba diciendo: quién eres, o háblame de ti.`;

    return handlerInput.responseBuilder
      .speak(ssml(speech))
      .reprompt(ssml('Prueba diciendo: quién eres, o háblame de ti.'))
      .withShouldEndSession(false)
      .getResponse();
  }
};

const SessionEndedRequestHandler = {
  canHandle(handlerInput) {
    return Alexa.getRequestType(handlerInput.requestEnvelope) === 'SessionEndedRequest';
  },
  handle(handlerInput) {
    logDebug('session_ended', {
      reason: handlerInput.requestEnvelope?.request?.reason || null,
    });
    return handlerInput.responseBuilder.getResponse();
  }
};

const ErrorHandler = {
  canHandle() { return true; },
  handle(handlerInput, error) {
    const requestType = Alexa.getRequestType(handlerInput.requestEnvelope);
    const intentName = requestType === 'IntentRequest' ? Alexa.getIntentName(handlerInput.requestEnvelope) : null;
    const slots = handlerInput.requestEnvelope?.request?.intent?.slots || {};
    const slotSummary = Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, v?.value || null]));
    logDebug('error', {
      requestType,
      intentName,
      slots: slotSummary,
      error: error instanceof Error ? error.message : String(error),
    });
    console.error('Alexa error:', error);
    return handlerInput.responseBuilder
      .speak(ssml('Tuve un problema procesando esa petición. Inténtalo de nuevo diciendo: quién eres, o háblame de ti.'))
      .reprompt(ssml('Prueba diciendo: quién eres, o háblame de ti.'))
      .withShouldEndSession(false)
      .getResponse();
  }
};

const skillBuilder = Alexa.SkillBuilders.custom();
if (ALEXA_SKILL_ID) skillBuilder.withSkillId(ALEXA_SKILL_ID);
const skill = skillBuilder
  .addRequestHandlers(
    LaunchRequestHandler,
    TalkToDaviIntentHandler,
    LinkIntentHandler,
    RepeatIntentHandler,
    HelpIntentHandler,
    CancelAndStopIntentHandler,
    FallbackIntentHandler,
    UnknownIntentHandler,
    SessionEndedRequestHandler
  )
  .addErrorHandlers(ErrorHandler)
  .create();

const adapter = new ExpressAdapter(skill, !ALEXA_SKIP_VERIFICATION, !ALEXA_SKIP_VERIFICATION);
const app = express();
// IMPORTANTE: NO registrar express.json() aquí.
// El ExpressAdapter de ask-sdk usa internamente body-parser.text para /alexa
// y falla con "Do not register any parsers before using the adapter" si
// registramos un parser JSON antes. /health es GET simple, no requiere parser.

// Registra cada request: el adapter responde 400/500 (p. ej. firma inválida) sin dejar rastro.
app.use((req, res, next) => {
  const startedAt = Date.now();
  let errorBody = null;
  const send = res.send.bind(res);
  res.send = (body) => {
    if (res.statusCode >= 400) errorBody = String(body).slice(0, 300);
    return send(body);
  };
  res.on('finish', () => {
    const mcpProtocol = req.path === '/mcp' ? req.headers['mcp-protocol-version'] || null : undefined;
    logDebug('http', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - startedAt, error: errorBody, mcpProtocol });
  });
  next();
});

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'alexa-agent-voice-bridge',
    skillIdConfigured: Boolean(ALEXA_SKILL_ID),
    gatewayConfigured: Boolean(HERMES_GATEWAY_URL),
    apiModel: HERMES_API_MODEL,
    mcpEnabled: Boolean(MCP_TOKEN),
    voiceId: voiceId.status(),
  });
});

// Servidor MCP: la otra superficie del mismo agente. Va antes del adapter de Alexa y sin parser JSON global.
mountMcp(app, { token: MCP_TOKEN, allowedOrigins: MCP_ALLOWED_ORIGINS, log: logDebug });

// Ruta raíz para el funnel (Tailscale proxy elimina /alexa del path prefix).
// Alexa se configura con endpoint raíz en la consola de desarrollador.
app.post('/', adapter.getRequestHandlers());

// Ruta /alexa explícita para Tailscale serve (que preserva el path, a diferencia de funnel).
// Ambas rutas apuntan al mismo adapter.
app.post('/alexa', adapter.getRequestHandlers());

// Recarga las tareas de data/tasks.json; las que quedaron pending pasan a failed.
agent.initTasks({ log: logDebug });

const server = app.listen(PORT, HOST, () => {
  ensureSessionStore();
  console.log(`[alexa-agent-voice-bridge] listening on ${HOST}:${PORT} (MCP ${MCP_TOKEN ? 'on /mcp' : 'off: set MCP_TOKEN'})`);
});

module.exports = { app, server };
