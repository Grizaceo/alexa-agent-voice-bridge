# HANDOFF — Alexa+ track (Build, Ship, Shape: Amazon Developer Hackathon)

> Documento de trabajo para el agente que implementa. **Antes de publicar el repo, muévelo a `docs/hackathon-log.md` o elimínalo** (fase F8).
> Los datos propios de la máquina (puertos en uso, hostnames, procesos de producción) están en `.hackathon/LOCAL_NOTES.md`, que no se versiona.

## Estado (actualizado el 2026-10-21, 05:30, rama `hackathon/alexa-plus`, sin push)

| Fase | Estado | Evidencia |
|---|---|---|
| F0 spec y SDK | ✅ | `.hackathon/NOTES.md` § F0. Cambio a SDK v2 aprobado. |
| F1 almacén persistente | ✅ | `src/agent.js`, `test/agent.test.js` |
| F2 servidor MCP | ✅ | `src/mcp.js`, `test/mcp.test.js` (ambas eras), Inspector 2.11 |
| F3 entre superficies | ✅ | `test/cross-surface.test.js`; NLU 32/32; producción en este repo (cruce real voz ↔ MCP) |
| F4 Agent Skill | ✅ | `skills/voice-agent-bridge/SKILL.md` (skills-ref válido), también servida por MCP (SEP-2640, Inspector `--verify`); demo con Claude Code |
| F4b Voice ID | 🟡 código y tests listos | Falta la puerta en el Echo real (ver "Pasos del usuario" abajo) |
| F5 PR a ask-cli | 🟡 listo en local | Publicar requiere permiso (`.hackathon/f5-pr.md`) |
| F6 docs y Devpost | ✅ (con **[confirmar]**) | README/SETUP en inglés; `.hackathon/` (friction log, feedback, feature requests, devpost, video) |
| Extra tras brainstorm y juez | ✅ | Pulido de voz (repetir lo entendido, recordar la pregunta, sonido, tarjeta), `npm run demo`, MCP App (tablero, verificado en MCPJam) |
| F7 web que simula Alexa+ | ⛔ descartada | La reemplazan la MCP App y `npm run demo` |
| F8 publicar | 🟡 semi-gate hecho | `.hackathon/f8-gate.md` |

Producción (3107) corre el código de F4b en `VOICE_ID_MODE=off`. Los commits posteriores (pulido de voz, MCP App) necesitan un reinicio aprobado por el usuario.

## Objetivo

Entregar al track **Alexa+** antes de **2026-10-23 19:00 UTC** (12:00 PDT). Requisitos oficiales verificados en `.hackathon/REQUIREMENTS.md` (fuente: https://amazonappdev2026.devpost.com/rules, leída el 2026-10-21).

Puntos que definen el diseño:
- El track exige un **servidor MCP self-hosted (spec 2025-11-25 o posterior, Streamable HTTP)** o una Agent Skill, y que el repo **use esa tecnología en runtime**.
- Para Alexa+, un "wrapper MCP básico" o una pregunta/respuesta de un turno cuentan como ideas *obvias*. Lo *creativo* es un flujo agéntico, **estado entre sesiones**, MCP Apps o Agent Skills.
- No existe una vía para conectar un MCP a un Echo real. El Echo sigue entrando por la skill clásica.

## Idea de la entrega

**"Your own agent, any surface — answers that wait for you."** Un solo agente y un solo almacén de tareas largas, compartido por dos superficies:
1. **Voz:** el Echo, con la skill clásica.
2. **MCP:** cualquier cliente MCP, que hace el papel de Alexa+.

Una tarea lenta pedida por voz se recoge después desde un cliente MCP, o al revés. Es la respuesta al límite de 8 s de Alexa, con estado que sobrevive a sesiones y reinicios.

## Contrato fijo (el implementador no lo re-decide)

**Módulo `src/agent.js`**, compartido por ambas superficies:
- `callAgent(question, { history })`: lo que hoy es `callHermesGateway`, sin cambiar su comportamiento.
- Almacén de tareas `{ id, question, status: pending|done|failed, answer, createdAt, finishedAt, deliveredAt, origin: "voice"|"mcp" }`:
  - se persiste en `data/tasks.json` con escritura atómica (tmp + rename);
  - las tareas se recargan al arrancar; una que quedó `pending` cuando el proceso murió pasa a `failed` con motivo "interrumpida por reinicio";
  - TTL configurable, `TASK_TTL_MS`, por defecto 24 h.
- `startTask(question, origin)`, `waitForTask(id, ms)`, `getTask(id)`, `latestUndelivered()` y `markDelivered(id)`.
- **Un solo dueño por despliegue** (es un agente personal). No hay multiusuario; documentarlo como límite.
- **Entrega:** una tarea queda `delivered` cuando cualquier superficie entrega su respuesta. El Echo, al abrirse, solo anuncia la última tarea `done` no entregada.

**Skill clásica:** `src/server.js` reemplaza su `pendingReplies` en memoria por `src/agent.js`. El comportamiento de voz no cambia, salvo que ahora sobrevive a reinicios y el TTL es de 24 h.

**Servidor MCP** (cambio aprobado por el usuario el 2026-10-21 tras F0; ver `.hackathon/NOTES.md`):
- Ruta `/mcp` en el mismo proceso Express. Es **stateless**: POST atiende todo, y GET y DELETE responden 405, como permiten ambas specs.
- SDK oficial **v2**: `@modelcontextprotocol/server` (más `@modelcontextprotocol/node` para Express) con **versión exacta fijada** y transporte **Streamable HTTP**.
- Protocolo negociado: **2026-07-28** con clientes que lo hablen y **2025-11-25** con los demás, en el mismo endpoint.
- **Límite de 1,5 h** para tener los tests de F2 en verde con v2. Si no se cumple, se vuelve a `@modelcontextprotocol/sdk@1.32.1` (2025-11-25, con sesiones y POST/GET/DELETE).
- Valida `Origin` (403 si viene y no está permitido, MUST de la spec) y exige `Authorization: Bearer ${MCP_TOKEN}` (sin él, 401).

Herramientas (todas devuelven texto limpio, apto para voz, sin Markdown):

| Herramienta | Entrada | Salida |
|---|---|---|
| `ask_agent` | `question: string`, `wait_seconds?: number` (por defecto 5, máximo 20) | `{status:"done", answer}` o `{status:"pending", task_id}` |
| `get_agent_result` | `task_id: string`, `wait_seconds?: number` (por defecto 0, máximo 20) | `{status:"done"\|"pending"\|"failed"\|"expired", answer?}` |
| `list_tasks` | `include_delivered?: boolean` | `[{task_id, question, status, origin, created_at}]` |

Tasks nativas: v2 no ejecuta las Tasks de 2025-11-25, así que aplica el Plan B y queda **solo el polling**. La extensión `io.modelcontextprotocol/tasks` de 2026-07-28 es un extra opcional si sobra tiempo (F7).

**Agent Skill** en `skills/voice-agent-bridge/SKILL.md`, con el formato abierto de Agent Skills. Le enseña a un agente tipo Alexa+ a usar estas herramientas:
- respuestas de 1–2 frases;
- patrón asíncrono: avisar, seguir conversando y recoger después;
- nunca empezar una frase de usuario con "dime" en es-US;
- cerrar con la palabra de cierre.

## Fases (en orden; cada una cierra con su verificación)

| Fase | Trabajo | Verificación exigida (evidencia real, no prosa) |
|---|---|---|
| F0 | Leer la spec MCP 2025-11-25 (transporte, versión, ¿Tasks?) y el SDK. Elegir la versión exacta del SDK. **Reportar al usuario antes de construir.** | Enlaces y fecha de lectura anotados al inicio de la sección F0 de `.hackathon/NOTES.md` |
| F1 | `src/agent.js` y persistencia; migrar `server.js` | `npm run check`; tests de `node:test` del almacén (persistencia, reinicio, TTL, entrega); requests sintéticas de voz contra un puerto de pruebas con `ALEXA_SKIP_VERIFICATION=true` y un gateway falso |
| F2 | Servidor MCP y autenticación | Tests con el cliente del SDK contra un servidor local: listar herramientas, `ask_agent` rápido y lento, `get_agent_result`, 401 sin token. Una sesión real con MCP Inspector (versión fijada) |
| F3 | Flujo entre superficies | Test: tarea creada por voz y recogida por MCP, y al revés. Luego `npm run nlu` (32/32) y `npm run skill -- simulate` contra la skill real, ya con este repo como producción (ver LOCAL_NOTES) |
| F4 | Agent Skill | Frontmatter YAML válido (parsearlo); un agente que la carga y usa el MCP en una demo |
| F4b | Identificación por voz (ver la sección de abajo). Límite: 2 h | Tests sintéticos con y sin `context.System.person` y con otro `personId`, en cada modo. En el Echo: el dueño habla y llega al agente; durante la sesión, la TV o un tercero hablan y se ignoran (evidencia: `data/alexa-debug.log` e historial de voz de Alexa) |
| F5 | Mini challenge Open Source: una **contribución adicional**. Propuesta: PR a `alexa/ask-cli` para que `util generate-lwa-tokens` cree `~/.ask/cli_config` si falta y no exija TTY para el `(Y/n)` | Tests del propio repo de ask-cli en verde. **Pedir permiso al usuario antes de hacer fork, push o abrir el PR** |
| F6 | `README.md` en inglés (el actual pasa a `docs/es/`), con "what we built during the submission window"; `.hackathon/`: `product-feedback.md`, `friction-log.md` (formato oficial por entrada), `feature-requests.md`, descripción para Devpost y guion del video | Cada afirmación técnica del README se puede comprobar con un comando o un archivo del repo |
| F7 | *(Opcional)* Mini web que simule Alexa+: push-to-talk y un agente que use este MCP | Solo si F0–F6 están completas el jueves |
| F8 | Publicar: repo GitHub público, LICENSE visible en "About"; mover o borrar este HANDOFF | **Pedir permiso al usuario antes de crear el repo remoto o hacer push** |

## Identificación por voz (F4b, pedida por el usuario el 2026-10-21)

**Objetivo:** con la conversación abierta, el puente solo atiende al dueño. Si suena la TV o alguien le habla al usuario en medio de un comando, eso no llega al agente.

**Base (doc de Amazon, [Add Personalization to Your Alexa Skill](https://developer.amazon.com/en-US/docs/alexa/custom-skills/add-personalization-to-your-skill.html), leída el 2026-10-21):**
- Con el permiso `alexa::person_id:read` en el manifiesto, cada request de un hablante reconocido trae `context.System.person.personId` (y `authenticationConfidenceLevel`).
- Si Alexa no reconoce la voz, o el hablante no activó "Personalizar skills" en su Voice ID, el request llega **sin** `person`.
- El reconocimiento se hace en cada request, no solo al abrir la skill.

**Diseño:**
- `VOICE_ID_MODE=off|enroll|enforce`, por defecto `off`. En `enroll`, el primer `personId` que llega queda registrado como dueño en `data/`.
- En `enforce`, un request sin `person` o de otra persona no crea tarea ni entra al historial. La respuesta es breve y deja la sesión escuchando (su forma exacta, voz o silencio, se decide probando en el Echo). Después de N ignorados seguidos, se cierra la sesión.
- La palabra de cierre ("maracuyá") se acepta de cualquiera.
- El log registra si el hablante fue reconocido, sin escribir el `personId` completo.

**Pasos del usuario:**
1. En la app Alexa, crear su Voice ID y activar "Personalizar skills".
2. Correr con `!` el comando que sube el manifiesto con el permiso (`npm run skill -- endpoint`); el modo automático lo bloquea.
3. Aceptar el permiso de la skill en la app.

**Primer paso (puerta):** comprobar en el Echo real que llega `person`. La doc no confirma que funcione en **es-US** ni con la skill en etapa development. Si no llega, la fase se cae y queda como entrada del friction log y como feature request.

**Límites (van al README):**
- Voice ID clasifica cada request completo; no separa voces superpuestas. Si la TV u otra persona hablan **al mismo tiempo** que el dueño, el texto llega mezclado o Alexa no reconoce al dueño. Ese caso se ignora y el dueño repite.
- Fuera de una sesión abierta, la TV solo activa Alexa si dice la palabra de activación; el filtro actúa en la ventana de micrófono abierto de la sesión.
- Con mucho ruido, Alexa puede no reconocer al dueño. En `enforce`, esa frase se ignora y la respuesta tiene que invitar a repetir.

## Plan B

- **Si el SDK no negocia 2025-11-25:** usar el último release que sí lo haga; si ninguno, implementar el transporte Streamable HTTP según la spec y documentarlo.
- **Si Tasks no existe o el SDK no la soporta:** quedarse solo con el polling (ya es el contrato).
- **Si v2 no pasa los tests de F2 en 1,5 h:** volver a `@modelcontextprotocol/sdk@1.32.1`.
- **Si Voice ID no llega a la skill (es-US/development) o F4b supera 2 h:** se cae F4b; queda como friction log, feature request y trabajo futuro.
- **Si falta tiempo:** se cae F7. En F5, en vez del PR, publicar `scripts/nlu-check.js` como repo independiente (`alexa-nlu-check`, MIT, con tests).

## Material para el friction log (incidentes reales, 2026-10-21)

Cada entrada debe quedar con el formato oficial: tarea, pasos, esperado vs. real, severidad, workaround y sugerencia.

1. El reconocimiento de voz de es-US transcribía la invocación "davi" como "david" o "dabi". La invocación exige coincidencia exacta y Alexa no da pistas ("no tengo muy claro cómo ayudarte con eso"). Workaround: invocación "mango".
2. `AMAZON.SearchQuery` no acepta una muestra que sea solo `{query}`, así que el habla libre caía en `FallbackIntent`. Workaround: un intent por palabra inicial, y el backend la re-antepone.
3. En es-US, "dime" se interpreta como la moneda (*dime*) y termina en `SendToPhoneIntent` o en un slot numérico.
4. `SearchQuery` normaliza "un"/"una" a "1".
5. En es-MX, `profile-nlu` falla con enclíticos escritos con tilde ("pregúntale"); sin tilde funciona.
6. El límite de ~8 s por respuesta; las respuestas progresivas no lo amplían. Workaround: modo pensando.
7. `ask util generate-lwa-tokens` falla si no existe `~/.ask/cli_config`, y el `(Y/n)` posterior al login exige TTY.
8. El adapter de `ask-sdk-express-adapter` responde 400/500 sin registrar el motivo.
9. Alexa exige el puerto 443, y Tailscale Funnel publica todo `host:443`, incluidas otras rutas de `serve`.
10. El simulador (`simulate-skill`) no prueba el reconocimiento de voz, que era justamente lo que fallaba en el Echo.
11. `GET /v1/vendors` devuelve el nombre de perfil, lo que me hizo creer que la cuenta developer era otra que la del Echo.
12. No hay API para crear rutinas de Alexa.
13. No hay vía para conectar un MCP propio a Alexa+ en un Echo es-US.

## Restricciones

- No hacer push, crear repos remotos ni abrir PRs sin permiso explícito del usuario.
- No imprimir tokens ni el contenido de `.env`.
- No borrar archivos sin permiso.
- No reiniciar el backend de producción sin avisar (ver LOCAL_NOTES).
