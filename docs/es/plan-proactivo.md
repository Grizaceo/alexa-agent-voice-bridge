# Plan: que Mango te hable sin que le preguntes

Estado: **propuesta** (aún no implementado). Rama: `claude/epic-johnson-tzh18z`.

Objetivo: comunicación de doble vía entre Hermes y el Echo.

1. **Recordatorios pedidos por voz.** "Mango, recuérdame a las ocho sacar la ropa", y a las 20:00 el Echo lo dice.
2. **Alertas de la máquina.** Si la GPU o la CPU pasan un umbral, el Echo avisa sin que nadie le hable.
3. **Responder al aviso.** Después de escuchar la alerta, poder contestarle a Hermes ("sí, mata ese proceso") con contexto.

## 1. Lo que Alexa permite hoy (verificado en octubre de 2026)

Revisé dos fuentes: la documentación de Amazon y el modelo de SMAPI que trae `ask-cli@2.30.7` (`ask-smapi-model/index.d.ts`). En ese modelo están los nombres exactos de los permisos y de los eventos.

| Mecanismo | ¿Habla solo? | ¿Se puede crear fuera de sesión? | Permiso del manifiesto |
|---|---|---|---|
| **Reminders API** | Sí: suena un tono y lee el texto | **No.** Solo se crean en sesión (error `NOT_IN_SESSION`). Fuera de sesión se pueden **leer, editar y borrar**. | `alexa::alerts:reminders:skill:readwrite` |
| **Timers API** | Sí. Al terminar puede sonar (`NOTIFY_ONLY`), leer un texto (`ANNOUNCE`) o **abrir una tarea de la skill** (`LAUNCH_TASK`). | No, según la comunidad: necesita el token de la sesión. Tampoco hay operación para editarlos. | `alexa::alerts:timers:skill:readwrite` |
| **Proactive Events API** (notificaciones) | No: anillo amarillo y tono, y hay que decir "Alexa, ¿qué notificaciones tengo?" | **Sí** (para eso existe) | `alexa::devices:all:notifications:write` (existe también `...:urgent:write`) |
| **Skill Messaging API** | No: despierta a tu skill con un `Messaging.MessageReceived` | Sí (token LWA `alexa:skill_messaging`) | Ninguno. Usa el client id/secret de la skill. |
| Anuncios / TTS (Home Assistant `alexa_media_player`, Voice Monkey) | Sí, al instante | Sí | No oficial (cookies o terceros) |
| **Alexa+ MCP Toolkit** | Por definir | — | Preview solo para partners (`alexa-ai` CLI) |

Corrección a mi primer análisis: con Skill Messaging **no** se puede crear un recordatorio. Amazon lo prohíbe explícitamente y revoca el acceso a la API si se hace. Lo que sí está permitido, y es el caso que documenta el tutorial oficial, es **editar** fuera de sesión un recordatorio que se creó en sesión. El diseño de abajo se apoya en eso.

Eventos que la skill puede suscribir en el manifiesto (`manifest.events.subscriptions`) y que sirven aquí: `REMINDER_STARTED`, `REMINDER_STATUS_CHANGED`, `REMINDER_CREATED`/`UPDATED`/`DELETED`, `SKILL_PERMISSION_ACCEPTED`, `SKILL_PERMISSION_CHANGED` y `SKILL_PROACTIVE_SUBSCRIPTION_CHANGED`.

## 2. ¿El CLI de Alexa trae una "llamada mejor"?

**No hay ningún comando de ASK CLI que haga hablar al Echo.** `ask smapi` es el plano de control: administra la skill, pero no habla con el usuario. Revisé la lista completa de `ask smapi --help` (v2.30.7) y no aparece nada de reminders, timers, notificaciones ni skill messaging. Estos son los comandos que sí sirven:

| Comando | Para qué nos sirve |
|---|---|
| `ask smapi get-skill-credentials -s $ALEXA_SKILL_ID` | Entrega el client id/secret para pedir el token LWA de Skill Messaging y de Proactive Events. |
| `ask smapi update-skill-manifest` (ya está en `npm run skill -- endpoint`) | Agrega permisos, `events.subscriptions` (`REMINDER_STARTED`…) y `events.publications` (esquemas de Proactive Events). |
| `ask smapi set-interaction-model` (ya está en `npm run skill -- model`) | Agrega un `RemindIntent` con slots `AMAZON.TIME`/`AMAZON.DATE`/`AMAZON.DURATION`. |
| `ask smapi profile-nlu` (ya está en `npm run nlu`) | Prueba que "recuérdame…" resuelva al intent correcto en es-US. |

Lo que de verdad cambia el juego **al editar la skill** no es un comando, sino tres capacidades que hoy no usamos:

1. **Timers con `LAUNCH_TASK`.** Es lo más parecido a una conversación iniciada por Alexa. Cuando el timer termina, el Echo puede **abrir Mango en una tarea propia** con un `input` (por ejemplo `{task_id}`), así que la sesión queda abierta para responder. Requiere declarar una *custom task* en el paquete de la skill. La limitación es que el timer se crea en sesión y dura como máximo 24 h, así que sirve para "avísame en 20 minutos y seguimos", no para alertas imprevistas. *A verificar en un Echo real:* si Alexa pide confirmación antes de abrir la tarea (`textToConfirm`) y cómo se comporta en es-US.
2. **Voice permissions** (`Connections.SendRequest` / `AskFor`). El permiso de recordatorios se da hablando, sin abrir la app.
3. **`REMINDER_STARTED`.** El bridge se entera de que el Echo **ya leyó** el aviso y puede marcar la tarea como entregada en `data/tasks.json`, como hace hoy cuando una respuesta se lee al abrir la skill.

## 3. Diseño propuesto

```text
           voz (en sesión)                               fuera de sesión
 "recuérdame a las 8…" ─┐                     Hermes (MCP)    watcher GPU/CPU
                        ▼                          │                │
               RemindIntent (src/server.js)        ▼                ▼
                        │              src/proactive.js: notify(text, at?, task_id)
   crea recordatorio real (token de sesión)        │
   + rellena el "pool" de recordatorios dormidos   ├─ 1) Skill Messaging → Messaging.MessageReceived
                        │                          │     → PUT /v1/alerts/reminders/{id} de un dormido
                        ▼                          │       (texto + hora = ahora+~30 s)
                 nube de Alexa  ◄──────────────────┘  2) si no hay dormidos: Proactive Events (anillo amarillo)
                        │
                Echo lo dice ── REMINDER_STARTED ──► tarea marcada "anunciada"
                        │
           "Alexa, mango" → LaunchRequest lee el detalle de la tarea y abre conversación con contexto
```

### 3.1 Recordatorios pedidos por voz (en sesión: 100 % dentro de las reglas)

- Agregar un `RemindIntent` a los dos modelos de interacción: "recuérdame {texto} a las {hora}", "recuérdame {texto} en {duración}", "remind me to {text} at {time}". El backend crea el recordatorio **durante la misma request** con el `apiAccessToken` y responde "Listo, a las ocho te recuerdo sacar la ropa". No pasa por Hermes, así que es rápido y determinista.
- Si la frase no calza con el intent (por ejemplo "recuérdame lo del abogado cuando salga el fallo"), va a Hermes como hoy. Si Hermes contesta dentro de los 5 s con una intención estructurada, el recordatorio se crea en la misma request. Si no, lo cubre el pool (3.2).

### 3.2 Avisos que nacen fuera de sesión: el "pool" de recordatorios dormidos

Como un recordatorio solo se puede **crear** en sesión pero sí se puede **editar** fuera de ella:

1. Cada vez que abres Mango, el backend se asegura de tener *N* recordatorios dormidos (por ejemplo 3) programados muy lejos, por ejemplo a un año. Hay que guardar sus `alertToken` en `data/proactive.json`.
2. Cuando Hermes o el watcher necesitan avisar, el backend:
   1. pide el token LWA con `grant_type=client_credentials` y scope `alexa:skill_messaging`;
   2. llama a `POST /v1/skillmessages/users/{userId}`;
   3. recibe un `Messaging.MessageReceived` con un `apiAccessToken` fuera de sesión;
   4. con ese token hace `PUT /v1/alerts/reminders/{alertToken}`, con el texto corto y la hora en ~30 s.
3. Con `REMINDER_STARTED` el recordatorio usado sale del pool, y el pool se rellena la próxima vez que abras la skill.
4. Si el pool está vacío, se usa como respaldo una notificación de Proactive Events (`AMAZON.MessageAlert.Activated`, "tienes un mensaje de Mango"). Si eso tampoco está disponible, el aviso queda como tarea pendiente y se lee al abrir la skill, como hoy.

Riesgos:
- Es un uso creativo de la API. Para una skill privada en desarrollo es razonable, pero **probablemente no pasaría la certificación** de una skill pública.
- Los recordatorios dormidos se ven en la lista de recordatorios de la app de Alexa. Hay que darles un texto honesto, por ejemplo "(Mango) espacio reservado para avisos".
- No sabemos cuál es el mínimo real de "ahora + X". Hay que medirlo.

### 3.3 Alertas de GPU/CPU

- Un watcher determinista en el bridge, no un LLM que haga polling: lee `nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader` y `sensors -j` cada 30 s.
- Configuración: `HW_ALERT_GPU_C=85`, `HW_ALERT_CPU_C=90`, `HW_ALERT_SUSTAIN=3` (lecturas seguidas antes de avisar), `HW_ALERT_COOLDOWN_MS=900000` (no repetir en 15 min) y `HW_ALERT_QUIET_HOURS=00-08`.
- El aviso crea una **tarea** en el store (`origin: "system"`) con el detalle: los procesos que más GPU usan y la tendencia de la temperatura. El Echo solo dice el texto corto: "Mango: la GPU está a 87 grados. Di 'Alexa, mango' para verlo".

### 3.4 La vuelta: responder al aviso

- Hoy `LaunchRequest` ya lee primero la tarea pendiente, con el tono. Se extiende para que, si la tarea es una alerta, la sesión quede **abierta con ese contexto**: la siguiente frase va a Hermes junto con el detalle de la alerta.
- Para el caso con timer (`LAUNCH_TASK`), la tarea entra directo con `{task_id}` y no hace falta decir "Alexa, mango".

### 3.5 Lo que gana Hermes (MCP)

Dos herramientas nuevas en `src/mcp.js`, con el mismo estilo de `structuredContent`:

| Tool | Input | Qué hace |
|---|---|---|
| `notify_owner` | `text` (≤ ~140 caracteres hablables), `detail?`, `at?` (ISO 8601) | Crea la tarea y programa el aviso por la mejor vía disponible. Devuelve `{task_id, channel: "reminder" \| "notification" \| "pending"}`. |
| `list_notifications` | — | Avisos programados o entregados, y cuántos recordatorios dormidos quedan. |

Hermes ya funciona como cliente MCP, así que sus tareas programadas (cron) pueden llamar a `notify_owner`. Además, la Skill del repo (`skills/voice-agent-bridge/SKILL.md`) explicaría cuándo conviene avisar y cuándo no.

## 4. Fases

| Fase | Entrega | Cómo se verifica |
|---|---|---|
| **0. Spike en el Echo real** | Script que crea un recordatorio en sesión, lo edita fuera de sesión vía Skill Messaging a "ahora + 30 s" y registra `REMINDER_STARTED`. Probar también un timer `ANNOUNCE` y un `LAUNCH_TASK`. | Que lo diga en es-US y en en-US, y anotar el offset mínimo. Evidencia en `docs/evidence/`, como con Voice ID. **Si esta fase falla, el plan cae a Proactive Events + tarea pendiente.** |
| **1. Manifiesto y modelo** | Permisos de reminders, timers y notificaciones; `events.subscriptions`; `RemindIntent` en es y en; `npm run skill -- credentials` (envuelve `get-skill-credentials` y guarda `ALEXA_CLIENT_ID`/`SECRET` en `.env`). | `npm run nlu`, `npm run skill -- model`, `npm run skill -- endpoint` |
| **2. `src/proactive.js`** | Cliente LWA (con caché del token), Skill Messaging, Reminders (crear, editar, borrar), el pool y Proactive Events como respaldo. | Tests con `node:test` y la API de Amazon simulada (mock), como en `test/helpers.js`. |
| **3. Voz** | `RemindIntent` y voice permissions; rellenar el pool en cada `LaunchRequest`; handlers de `Messaging.MessageReceived` y `Reminders.ReminderStarted`. | Peticiones sintéticas de Alexa en `test/voice.test.js` y `test/voice-en.test.js`. |
| **4. MCP** | `notify_owner` y `list_notifications`, más una sección nueva en el SKILL.md. | `test/mcp.test.js` en las dos eras del protocolo. |
| **5. Watcher** | `src/hw-watch.js` (opcional, apagado por defecto). | Test con lecturas falsas: histéresis, cooldown y horas de silencio. |
| **6. Docs** | README (inglés y español), `.env.example` y una entrada nueva en el friction log. | — |

## 5. Preguntas abiertas

- ¿El Echo lee bien un recordatorio editado fuera de sesión con poca anticipación? (fase 0)
- ¿`LAUNCH_TASK` funciona en una skill en etapa de desarrollo y en es-US? ¿Pide confirmación?
- ¿Qué esquemas de Proactive Events aceptan es-US hoy, y cuál es el límite diario (HTTP 432)?
- **Alexa+ MCP Toolkit:** Amazon ya documenta un camino MCP para Alexa+ (preview para partners, CLI `alexa-ai`). Esto deja desactualizada la frase del README "no documented way". Si se consigue acceso, Alexa+ podría consumir directamente `/mcp` y habría que ver qué ofrece en proactividad. Conviene pedir acceso en paralelo.

## Fuentes

- Reminders: [Overview](https://developer.amazon.com/en-US/docs/alexa/smapi/alexa-reminders-overview.html), [API Reference](https://developer.amazon.com/en-US/docs/alexa/smapi/alexa-reminders-api-reference.html), [Tutorial fuera de sesión](https://developer.amazon.com/en-US/docs/alexa/smapi/tutorial-update-reminder-from-outside-of-session.html), [Voice permissions](https://developer.amazon.com/en-US/docs/alexa/smapi/voice-permissions-for-reminders.html), [Foro: crear con token de skill messaging falla](https://amazon.developer.forums.answerhub.com/questions/228371/reminders-api-out-of-session-help.html)
- Timers: [API Reference](https://developer.amazon.com/en-US/docs/alexa/smapi/alexa-timers-api-reference.html), [Best practices](https://developer.amazon.com/en-US/docs/alexa/smapi/alexa-timers-guidelines-for-usage.html), [Blog parte 2](https://developer.amazon.com/en-US/blogs/alexa/alexa-skills-kit/2021/10/add-timer-to-alexa-skill-part-two)
- Proactive Events: [About](https://developer.amazon.com/en-US/docs/alexa/smapi/proactive-events-api.html), [API Reference](https://developer.amazon.com/en-US/docs/alexa/smapi/proactive-events-api-reference.html)
- Out-of-session con el SDK de Node.js: [Call Alexa Service APIs Out of Session](https://developer.amazon.com/docs/alexa/alexa-skills-kit-sdk-for-nodejs/call-alexa-service-apis-out-of-session.html)
- Alexa+: [Choose the integration approach](https://developer.amazon.com/docs/alexaplus/add-ons/choose-the-proper-alexaplus-integration-approach.html), [MCP client lifecycle](https://developer.amazon.com/docs/alexaplus/add-ons/category-sdk-mcp-client-lifecycle.html), [Local Inspector](https://developer.amazon.com/docs/alexaplus/add-ons/mcp-toolkit-local-inspector.html), [Blog julio 2026](https://developer.amazon.com/alexaplus/blogs/2026/07/alexa-plus-new-ways-to-build-experiences)
- ASK CLI: `ask smapi --help` de `ask-cli@2.30.7` y los tipos `PermissionName`/`EventNameType` de `ask-smapi-model`.
