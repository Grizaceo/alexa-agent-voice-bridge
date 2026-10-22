// Lo que habla la skill, en español y en inglés. El idioma sale del locale de cada request
// ("en-US" → inglés, cualquier otro → español), así un Echo en modo bilingüe contesta en el
// idioma en que se le habló. El agente ya responde en el idioma de la pregunta.
const TEXTS = {
  es: {
    greeting: name => `${name} listo. Puedes hablarme.`,
    greetingPending: name => `${name} listo. Sigo trabajando en lo que me pediste antes; di repite para esperarla, o pídeme otra cosa.`,
    greetingNotLinked: name => `${name} listo. Antes de usar esta skill, el dueño de la skill tiene que vincular esta cuenta.`,
    launchReprompt: 'Puedes decirme qué necesitas.',
    notAllowedLaunch: name => `Este usuario de Alexa no está autorizado todavía para usar a ${name}.`,
    notAllowed: name => `Este usuario no está autorizado para usar a ${name}.`,
    notLinked: 'Esta cuenta todavía no está vinculada. Pide al dueño de la skill que complete la vinculación.',
    aboutQuestion: '¿Quién eres?',
    capabilitiesQuestion: '¿Para qué sirves y cómo puedes ayudarme?',
    emptyUtterance: 'No alcancé a entender qué querías decirme. Inténtalo de nuevo.',
    emptyReprompt: 'Puedes decir, por ejemplo: qué hora es en Santiago.',
    thinking: (question, returnPhrase) => `Entendí: ${question} Me va a tomar un momento. Di repite en unos segundos, o más tarde dime ${returnPhrase}, y te cuento.`,
    thinkingReprompt: 'Di repite cuando quieras escuchar la respuesta.',
    answerReprompt: 'Si quieres, puedes seguir hablando conmigo.',
    anythingElse: '¿Algo más?',
    fromElsewhere: ' desde otro dispositivo',
    readyAtLaunch: (elsewhere, question) => `Tengo la respuesta a lo que me pediste${elsewhere}: ${question} `,
    readyFromElsewhere: (elsewhere, question) => `Lo que me pediste${elsewhere}: ${question} `,
    linkNoPin: 'Esta skill no requiere PIN. La cuenta quedó habilitada.',
    linkOk: name => `Vinculación correcta. Ya puedes hablar con ${name}.`,
    linkBad: 'El PIN no coincide. Pide al dueño de la skill revisar la vinculación.',
    stillWorkingClose: returnPhrase => `Sigue trabajando y te guardo la respuesta. Cuando quieras, dime ${returnPhrase}, y te la leo.`,
    stillWorking: 'Todavía estoy en eso. Di repite en unos segundos.',
    nothingToRepeat: 'No tengo nada que repetir todavía.',
    help: closeWord => `Pregúntame lo que quieras empezando con qué, cuál, cómo, busca o pon. Si tardo, di repite. Para terminar, di ${closeWord}.`,
    helpReprompt: 'Prueba diciendo: qué hora es en Santiago.',
    byeSaved: returnPhrase => `Listo. Te guardo la respuesta que sigue en curso; dime ${returnPhrase} cuando quieras escucharla.`,
    bye: 'Listo, hasta luego.',
    fallback: 'No entendí esa petición. Puedes intentar con: quién eres, háblame de ti, o ayúdame con una idea.',
    fallbackReprompt: 'Puedes decir: quién eres, háblame de ti, o ayúdame con una idea.',
    sendToPhone: name => `Alexa entendió una intención del sistema llamada Send To Phone en vez de mandarla a ${name}. No empieces con dime. Prueba diciendo solo: quién eres, o háblame de ti.`,
    otherIntent: (name, intentName) => `Alexa entendió otra intención distinta a ${name}. Intento detectado: ${intentName}. Prueba diciendo: quién eres, o háblame de ti.`,
    tryWhoAreYou: 'Prueba diciendo: quién eres, o háblame de ti.',
    error: 'Tuve un problema procesando esa petición. Inténtalo de nuevo diciendo: quién eres, o háblame de ti.',
    voiceUnknownClose: 'No reconozco esta voz. Hasta luego.',
    voiceUnknown: 'No reconocí tu voz. Si me hablabas a mí, repítelo.',
    listening: 'Te escucho.',
    status: ({ model, memFree, load, uptimeMin }) => {
      const memText = memFree == null ? 'memoria no disponible' : `memoria libre aproximada ${memFree} por ciento`;
      const loadText = load == null ? 'carga no disponible' : `carga ${load}`;
      return `Estado rápido: backend Alexa activo, gateway configurado, modelo ${model}, ${memText}, ${loadText}, uptime del backend ${uptimeMin} minutos.`;
    },
    // Frases (sin tildes, en minúscula) que piden el estado sin pasar por el agente.
    isStatusQuestion: text => text.includes('estado del sistema') || ['estado sistema', 'como esta el sistema', 'como esta el estado del sistema'].includes(text),
  },
  en: {
    greeting: name => `${name} is ready. You can talk to me.`,
    greetingPending: name => `${name} is ready. I'm still working on what you asked earlier; say repeat to wait for it, or ask me something else.`,
    greetingNotLinked: name => `${name} is ready. Before you use this skill, the skill owner has to link this account.`,
    launchReprompt: 'Tell me what you need.',
    notAllowedLaunch: name => `This Alexa user isn't allowed to use ${name} yet.`,
    notAllowed: name => `This user isn't allowed to use ${name}.`,
    notLinked: "This account isn't linked yet. Ask the skill owner to finish linking it.",
    aboutQuestion: 'Who are you?',
    capabilitiesQuestion: 'What are you for, and how can you help me?',
    emptyUtterance: "I didn't catch what you wanted to say. Please try again.",
    emptyReprompt: 'You can say, for example: what time is it in Tokyo.',
    thinking: (question, returnPhrase) => `Got it: ${question} This will take a moment. Say repeat in a few seconds, or later say ${returnPhrase}, and I'll tell you.`,
    thinkingReprompt: 'Say repeat when you want to hear the answer.',
    answerReprompt: 'You can keep talking to me if you like.',
    anythingElse: 'Anything else?',
    fromElsewhere: ' from another device',
    readyAtLaunch: (elsewhere, question) => `I have the answer to what you asked me${elsewhere}: ${question} `,
    readyFromElsewhere: (elsewhere, question) => `What you asked me${elsewhere}: ${question} `,
    linkNoPin: "This skill doesn't need a PIN. The account is enabled.",
    linkOk: name => `Linked. You can talk to ${name} now.`,
    linkBad: "The PIN doesn't match. Ask the skill owner to check the linking.",
    stillWorkingClose: returnPhrase => `Still working on it, and I'll save the answer. Whenever you want, say ${returnPhrase}, and I'll read it to you.`,
    stillWorking: "I'm still on it. Say repeat in a few seconds.",
    nothingToRepeat: "I don't have anything to repeat yet.",
    help: closeWord => `Ask me anything, starting with what, who, how, search, or play. If I take a while, say repeat. To finish, say ${closeWord}.`,
    helpReprompt: 'Try saying: what time is it in Tokyo.',
    byeSaved: returnPhrase => `Done. I'll keep the answer that's still in progress; say ${returnPhrase} whenever you want to hear it.`,
    bye: 'Done, goodbye.',
    fallback: "I didn't understand that request. You can try: who are you, tell me about yourself, or help me with an idea.",
    fallbackReprompt: 'You can say: who are you, tell me about yourself, or help me with an idea.',
    sendToPhone: name => `Alexa heard a system intent called Send To Phone instead of sending it to ${name}. Try saying just: who are you, or tell me about yourself.`,
    otherIntent: (name, intentName) => `Alexa heard a different intent than ${name}: ${intentName}. Try saying: who are you, or tell me about yourself.`,
    tryWhoAreYou: 'Try saying: who are you, or tell me about yourself.',
    error: 'I had a problem with that request. Try again by saying: who are you, or tell me about yourself.',
    voiceUnknownClose: "I don't recognize this voice. Goodbye.",
    voiceUnknown: "I didn't recognize your voice. If you were talking to me, say it again.",
    listening: "I'm listening.",
    status: ({ model, memFree, load, uptimeMin }) => {
      const memText = memFree == null ? 'memory not available' : `about ${memFree} percent memory free`;
      const loadText = load == null ? 'load not available' : `load ${load}`;
      return `Quick status: Alexa backend up, gateway configured, model ${model}, ${memText}, ${loadText}, backend uptime ${uptimeMin} minutes.`;
    },
    isStatusQuestion: text => text.includes('system status') || ['status of the system', 'how is the system', "how's the system"].some(p => text.includes(p)),
  },
};

function langOf(locale) {
  return /^en\b/i.test(String(locale || '')) ? 'en' : 'es';
}

module.exports = { TEXTS, langOf };
