const fs = require('fs');
const path = require('path');
const os = require('os');
const express = require('express');
const Alexa = require('ask-sdk-core');
const { ExpressAdapter } = require('ask-sdk-express-adapter');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const agent = require('./agent');
const { stripMarkdown, forSpeech } = agent;
const { mountMcp } = require('./mcp');
const { createVoiceId } = require('./voice-id');
const { TEXTS, langOf } = require('./i18n');

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
// Frase con la que el usuario vuelve a abrir la skill (rutina de la app Alexa), por idioma.
const RETURN_PHRASES = {
  es: process.env.ALEXA_RETURN_PHRASE || 'Alexa, mango',
  en: process.env.ALEXA_RETURN_PHRASE_EN || 'Alexa, open mango',
};
// Sonido de la biblioteca de Alexa antes de leer una respuesta que esperó. READY_SOUND= (vacío) lo apaga.
const READY_SOUND = process.env.READY_SOUND ?? 'soundbank://soundlibrary/alarms/beeps_and_bloops/bell_02';
// taskId -> cuántas veces "repite" esperó sin respuesta. Solo afecta a cuándo se corta la conversación.
const stillWorkingCounts = new Map();
// Identificación por voz: off (solo registra si Alexa reconoció la voz), enroll (guarda al primer
// hablante reconocido como dueño) o enforce (solo el dueño llega al agente). Ver src/voice-id.js.
const voiceId = createVoiceId({
  mode: process.env.VOICE_ID_MODE || 'off',
  // Opcional: otro modo para inglés (p. ej. off si Alexa no reconoce tu voz en inglés).
  modeEn: process.env.VOICE_ID_MODE_EN || process.env.VOICE_ID_MODE || 'off',
  ownerFile: path.resolve(process.env.VOICE_OWNER_FILE || path.join(__dirname, '..', 'data', 'voice-owner.json')),
  ownerPersonId: process.env.VOICE_OWNER_PERSON_ID || '',
  log: logDebug,
});
// Frases seguidas de otras voces tras las que se cierra la sesión, y si se ignoran en silencio.
const VOICE_ID_MAX_IGNORED = Number(process.env.VOICE_ID_MAX_IGNORED || 3);
const VOICE_ID_SILENT = String(process.env.VOICE_ID_SILENT || 'false').toLowerCase() === 'true';
// Free*Intent capturan habla libre ("qué {query}", "what {query}"). Alexa no incluye
// la palabra inicial en el slot, así que se reconstruye desde la primera muestra del modelo.
// Un modelo por idioma: config/interaction-model.json (es-*) y config/interaction-model.en-US.json.
const INTERACTION_MODEL_INTENTS = {
  es: loadInteractionModelIntents('interaction-model.json'),
  en: loadInteractionModelIntents('interaction-model.en-US.json'),
};
const FREE_INTENT_LEADS = Object.fromEntries(Object.values(INTERACTION_MODEL_INTENTS).flat()
  .filter(intent => /^Free[A-Za-z]+Intent$/.test(intent.name) && intent.samples?.length)
  .map(intent => [intent.name, intent.samples[0].replace('{query}', '').trim()]));
// Palabra de cierre = primera muestra de AMAZON.StopIntent en cada modelo ("maracuyá", "passion fruit").
const CLOSE_WORDS = {
  es: INTERACTION_MODEL_INTENTS.es.find(intent => intent.name === 'AMAZON.StopIntent')?.samples?.[0] || 'adiós',
  en: INTERACTION_MODEL_INTENTS.en.find(intent => intent.name === 'AMAZON.StopIntent')?.samples?.[0] || 'stop',
};

function loadInteractionModelIntents(file) {
  try {
    const model = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', file), 'utf8'));
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
// Textos, frase de regreso y palabra de cierre del idioma en que se habló en esta request.
function voiceOf(handlerInput) {
  const lang = langOf(handlerInput.requestEnvelope?.request?.locale);
  return { lang, t: TEXTS[lang], returnPhrase: RETURN_PHRASES[lang], closeWord: CLOSE_WORDS[lang] };
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
function ssml(text, { sound = '' } = {}) {
  const safe = String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .trim();
  const audio = sound ? `<audio src="${sound.replace(/["<>&]/g, '')}"/>` : '';
  return `<speak>${audio}${safe}</speak>`;
}
// La pregunta en pocas palabras y como frase cerrada, para repetirla ("Entendí: …", "lo que me pediste: …").
// Conserva "¿…?" y "¡…!"; si no termina en puntuación, agrega un punto.
function shortQuestion(text, maxWords = 14) {
  const words = stripMarkdown(text).replace(/\s+/g, ' ').trim().replace(/\.+$/, '').split(' ');
  const short = words.length > maxWords ? `${words.slice(0, maxWords).join(' ')}…` : words.join(' ');
  return /[?!…]$/.test(short) ? short : `${short}.`;
}
// Tarjeta con la respuesta completa en la app Alexa (y en la pantalla de un Echo Show).
function withAnswerCard(builder, question, answer) {
  return builder.withSimpleCard(`${ASSISTANT_NAME}: ${shortQuestion(question, 10).replace(/\.$/, '')}`, stripMarkdown(answer).slice(0, 6000));
}
// Solo en español: Alexa normaliza "un"/"una" a "1" dentro de AMAZON.SearchQuery ("1 correo", "1 idea").
// El artículo sale de la palabra siguiente: "una" si termina en -a (salvo "día", "problema"…),
// en -ción, -sión, -dad, -tad, -tud o -umbre, o si es una femenina común ("vez", "noche"…).
// Ante "de", "y"… el 1 es un número ("el 1 de noviembre") y se deja.
const MASCULINE_A_WORDS = new Set(['dia', 'mediodia', 'mapa', 'problema', 'tema', 'sistema', 'programa', 'idioma', 'clima', 'planeta', 'poema', 'esquema', 'dilema', 'drama', 'diagrama', 'pijama', 'sofa']);
const FEMININE_WORDS = new Set(['vez', 'noche', 'tarde', 'clase', 'calle', 'parte', 'frase', 'llave', 'nube', 'fuente', 'serie', 'imagen', 'red', 'flor', 'ley', 'foto', 'mano', 'moto']);
const NUMBER_FOLLOWERS = new Set(['de', 'del', 'y', 'o', 'a', 'al', 'en', 'por', 'para', 'con', 'mas', 'menos']);
function spokenOne(nextWord) {
  const word = nextWord.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  if (NUMBER_FOLLOWERS.has(word)) return '1';
  const feminine = FEMININE_WORDS.has(word)
    || (word.endsWith('a') && !MASCULINE_A_WORDS.has(word))
    || /(cion|sion|dad|tad|tud|umbre)$/.test(word);
  return feminine ? 'una' : 'un';
}
function normalizeSpokenQuery(text) {
  return String(text || '').replace(/(^|\s)1(?=\s+([a-záéíóúüñ]+))/gi, (_, before, nextWord) => `${before}${spokenOne(nextWord)}`);
}
function getFastSystemStatusReply(t) {
  const memFree = os.totalmem() > 0 ? Math.round((os.freemem() / os.totalmem()) * 100) : null;
  const load = Array.isArray(os.loadavg()) && Number.isFinite(os.loadavg()[0]) ? os.loadavg()[0].toFixed(2) : null;
  return t.status({ model: HERMES_API_MODEL, memFree, load, uptimeMin: Math.round(process.uptime() / 60) });
}
function resolveFastPath(utterance, t) {
  const text = String(utterance || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
  if (!text) return null;
  if (t.isStatusQuestion(text)) return getFastSystemStatusReply(t);
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
  const { t } = voiceOf(handlerInput);
  const sessionAttrs = handlerInput.attributesManager.getSessionAttributes();
  const ignoredCount = (sessionAttrs.ignoredCount || 0) + 1;
  handlerInput.attributesManager.setSessionAttributes({ ...sessionAttrs, ignoredCount });
  if (ignoredCount >= VOICE_ID_MAX_IGNORED) {
    return handlerInput.responseBuilder
      .speak(ssml(t.voiceUnknownClose))
      .withShouldEndSession(true)
      .getResponse();
  }
  if (VOICE_ID_SILENT) return handlerInput.responseBuilder.withShouldEndSession(false).getResponse();
  return handlerInput.responseBuilder
    .speak(ssml(t.voiceUnknown))
    .reprompt(ssml(t.listening))
    .withShouldEndSession(false)
    .getResponse();
}
// La tarea que espera esta conversación de voz o, si no tiene, la última pendiente de cualquier superficie.
function findVoiceTask(sessionAttrs) {
  const own = sessionAttrs.pendingTaskId ? agent.getTask(sessionAttrs.pendingTaskId) : null;
  return own || agent.listTasks().find(task => task.status === 'pending') || null;
}
// Lee la respuesta de una tarea que esperó, la marca entregada y la suma al historial de la sesión.
// Suena READY_SOUND; al abrir (o si la pidió otra superficie) recuerda cuál era la pregunta.
function deliverTask(handlerInput, task, { atLaunch = false } = {}) {
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
  const { t } = voiceOf(handlerInput);
  const elsewhere = task.origin === 'voice' ? '' : t.fromElsewhere;
  const intro = atLaunch
    ? t.readyAtLaunch(elsewhere, shortQuestion(task.question))
    : (elsewhere ? t.readyFromElsewhere(elsewhere, shortQuestion(task.question)) : '');
  return withAnswerCard(handlerInput.responseBuilder, task.question, task.answer)
    .speak(ssml(`${intro}${forSpeech(task.answer)}`, { sound: READY_SOUND }))
    .reprompt(ssml(t.anythingElse))
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
    const { lang, t } = voiceOf(handlerInput);
    logDebug('launch', { userId, allowed, lang });
    if (!allowed) {
      return handlerInput.responseBuilder
        .speak(ssml(t.notAllowedLaunch(ASSISTANT_NAME)))
        .withShouldEndSession(true)
        .getResponse();
    }
    const state = getSessionState(userId);
    // Solo se anuncia la última tarea done sin entregar, venga de la voz o de un cliente MCP,
    // y con VOICE_ID_MODE=enforce solo si quien abre es el dueño.
    const ready = state.linked && speakerAllowed(handlerInput, 'launch') ? agent.latestUndelivered() : null;
    if (ready) {
      return deliverTask(handlerInput, ready, { atLaunch: true });
    }
    const pending = findVoiceTask({});
    if (pending) {
      handlerInput.attributesManager.setSessionAttributes({ ...handlerInput.attributesManager.getSessionAttributes(), pendingTaskId: pending.id });
    }
    const greeting = pending ? t.greetingPending(ASSISTANT_NAME) : t.greeting(ASSISTANT_NAME);
    const speech = state.linked ? greeting : t.greetingNotLinked(ASSISTANT_NAME);
    return handlerInput.responseBuilder
      .speak(ssml(speech))
      .reprompt(ssml(t.launchReprompt))
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
    const { lang, t, returnPhrase } = voiceOf(handlerInput);
    if (!getAllowed(userId)) {
      return handlerInput.responseBuilder
        .speak(ssml(t.notAllowed(ASSISTANT_NAME)))
        .withShouldEndSession(true)
        .getResponse();
    }

    const state = getSessionState(userId);
    if (PIN_REQUIRED && !state.linked) {
      return handlerInput.responseBuilder
        .speak(ssml(t.notLinked))
        .withShouldEndSession(true)
        .getResponse();
    }
    // La TV o alguien que le habla al usuario no llegan al agente (VOICE_ID_MODE=enforce).
    if (!speakerAllowed(handlerInput, 'talk')) return ignoreSpeaker(handlerInput);

    const intentName = Alexa.getIntentName(handlerInput.requestEnvelope);

    // Recuperar historial conversacional desde session attributes de Alexa
    const sessionAttrs = handlerInput.attributesManager.getSessionAttributes();
    const slots = handlerInput.requestEnvelope?.request?.intent?.slots || {};
    let utterance = slots.query?.value || slots.message?.value || '';
    if (lang === 'es') utterance = normalizeSpokenQuery(utterance);
    if (utterance && FREE_INTENT_LEADS[intentName]) {
      utterance = `${FREE_INTENT_LEADS[intentName]} ${utterance}`;
    }
    if (!utterance && intentName === 'AboutDaviIntent') {
      utterance = t.aboutQuestion;
    }
    if (!utterance && intentName === 'CapabilitiesIntent') {
      utterance = t.capabilitiesQuestion;
    }
    logDebug('talk_intent_received', {
      userId,
      deviceId,
      lang,
      intentName,
      utterance,
      turnCountBefore: sessionAttrs?.turnCount || 0,
    });
    if (!utterance) {
      return handlerInput.responseBuilder
        .speak(ssml(t.emptyUtterance))
        .reprompt(ssml(t.emptyReprompt))
        .withShouldEndSession(false)
        .getResponse();
    }
    const turnCount = (sessionAttrs.turnCount || 0) + 1;
    const history = sessionAttrs.history || [];

    const fastReply = resolveFastPath(utterance, t);
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
        .speak(ssml(t.thinking(shortQuestion(utterance), returnPhrase)))
        .reprompt(ssml(t.thinkingReprompt))
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

    return withAnswerCard(handlerInput.responseBuilder, utterance, result.text)
      .speak(ssml(forSpeech(result.text)))
      .reprompt(ssml(t.answerReprompt))
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
    const { t } = voiceOf(handlerInput);
    const pin = handlerInput.requestEnvelope?.request?.intent?.slots?.pin?.value || '';
    if (!PIN_REQUIRED) {
      setSessionState(userId, { linked: true });
      return handlerInput.responseBuilder.speak(ssml(t.linkNoPin)).getResponse();
    }
    if (pin && ALEXA_LINK_PIN && pin === String(ALEXA_LINK_PIN)) {
      setSessionState(userId, { linked: true, hermesSessionKey: String(Date.now()) });
      return handlerInput.responseBuilder.speak(ssml(t.linkOk(ASSISTANT_NAME))).getResponse();
    }
    return handlerInput.responseBuilder
      .speak(ssml(t.linkBad))
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
    const { t, returnPhrase } = voiceOf(handlerInput);
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
          .speak(ssml(t.stillWorkingClose(returnPhrase)))
          .withShouldEndSession(true)
          .getResponse();
      }
      return handlerInput.responseBuilder
        .speak(ssml(t.stillWorking))
        .reprompt(ssml(t.thinkingReprompt))
        .withShouldEndSession(false)
        .getResponse();
    }
    const lastReply = sessionAttrs.lastReply || t.nothingToRepeat;
    logDebug('repeat_intent', { pending: false, lastReplyPreview: String(lastReply).slice(0, 160) });
    return handlerInput.responseBuilder
      .speak(ssml(forSpeech(lastReply)))
      .reprompt(ssml(t.anythingElse))
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
    const { t, closeWord } = voiceOf(handlerInput);
    return handlerInput.responseBuilder
      .speak(ssml(t.help(closeWord)))
      .reprompt(ssml(t.helpReprompt))
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
    // "maracuyá" o "passion fruit" caen aquí (muestras de AMAZON.StopIntent). Una respuesta pendiente no se descarta.
    const { t, returnPhrase } = voiceOf(handlerInput);
    const task = findVoiceTask(handlerInput.attributesManager.getSessionAttributes());
    const saved = task && (task.status === 'pending' || (task.status === 'done' && !task.deliveredAt));
    const speech = saved ? t.byeSaved(returnPhrase) : t.bye;
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
    // La TV casi nunca empieza con una palabra de la skill: llega aquí y, sin este filtro, mantenía la sesión abierta.
    if (!speakerAllowed(handlerInput, 'fallback')) return ignoreSpeaker(handlerInput);
    const { t } = voiceOf(handlerInput);
    return handlerInput.responseBuilder
      .speak(ssml(t.fallback))
      .reprompt(ssml(t.fallbackReprompt))
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
    if (!speakerAllowed(handlerInput, 'unknown')) return ignoreSpeaker(handlerInput);

    const { t } = voiceOf(handlerInput);
    const speech = intentName === 'AMAZON.SendToPhoneIntent' ? t.sendToPhone(ASSISTANT_NAME) : t.otherIntent(ASSISTANT_NAME, intentName);

    return handlerInput.responseBuilder
      .speak(ssml(speech))
      .reprompt(ssml(t.tryWhoAreYou))
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
    const { t } = voiceOf(handlerInput);
    return handlerInput.responseBuilder
      .speak(ssml(t.error))
      .reprompt(ssml(t.tryWhoAreYou))
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
