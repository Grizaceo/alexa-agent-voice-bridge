# Mango con Maracuyá: Alexa → tu propio agente

> Guía original de la parte de voz. El servidor MCP, la Agent Skill, la MCP App, Voice ID y la demo de un comando están en el [README en inglés](../../README.md).

Una Alexa Custom Skill privada para hablar desde un Echo con **tu** agente, sea [Hermes Agent](https://github.com/NousResearch/hermes-agent) o cualquier endpoint `/v1/chat/completions` compatible con OpenAI. No usa skills de terceros ni Lambda: el backend corre en tu máquina y Amazon llega a él por Tailscale Funnel.

```text
"Alexa, mango"
  → Echo → nube de Alexa → skill (etapa development, tu cuenta)
  → https://<tu-máquina>.ts.net/alexa  (Tailscale Funnel, solo esa ruta)
  → backend Node (este repo, verifica la firma de Amazon)
  → agente (Hermes API server u otro OpenAI-compatible)
  ← texto → voz de Alexa
```

## Cómo se usa (por voz)

| Dices | Pasa |
|---|---|
| "Alexa, mango" | Abre la conversación. Usa una rutina de la app Alexa; también funciona "Alexa, abre mango". |
| "qué hora es en Santiago", "busca…", "resume…", "pon un video de… en la tele" | Va al agente con la frase completa. |
| "pregúntale…", "consulta…", "explícame…" | También va al agente. |
| "estado del sistema" | Responde al instante, sin pasar por el agente. |
| *(el agente tarda más de 5 s)* | "Me va a tomar un momento. Di repite en unos segundos…" |
| "repite" | Espera hasta 5 s más y lee la respuesta. A la segunda espera sin respuesta, cierra la conversación y la guarda. |
| "Alexa, mango" *(después)* | "Tengo la respuesta a lo que me pediste…" |
| "maracuyá" | Cierra la conversación. Si hay algo en curso, lo guarda. |
| "Alexa, pídele a mango estado del sistema" | Hace la pregunta en una sola frase, sin abrir la conversación. |

**En inglés.** La skill también habla inglés (en-US), con su propio modelo (`config/interaction-model.en-US.json`). Con el Echo en inglés o en modo bilingüe inglés/español, cada respuesta sale en el idioma en que le hablaste: "Alexa, open mango", "what…", "search…", "repeat" y, para cerrar, también "maracuyá".

**Hazla tuya.** "Mango" y "maracuyá" son valores por defecto. El nombre hablado es `ASSISTANT_NAME` y el de la app Alexa es `SKILL_NAME`, los dos en `.env`. La palabra para abrir es `invocationName` en los dos modelos de `config/`; la de cierre es la primera muestra de `AMAZON.StopIntent` en cada modelo. Después de cambiar los modelos, corre `npm run skill -- model` (o `endpoint` para el nombre de la app) y reinicia el backend. Detalle en el [README en inglés](../../README.md#make-it-yours-name-invocation-and-close-word).

**Voice ID y el idioma.** La skill funciona en los dos idiomas siempre; lo que depende del idioma es el filtro de "solo el dueño". Alexa reconoce tu voz bien solo en el idioma en que grabaste tu Voice ID, así que el filtro se fija por idioma en `.env`: si lo grabaste en español ("Alexa, aprende mi voz"), `VOICE_ID_MODE=enforce` y `VOICE_ID_MODE_EN=off`; si lo grabaste en inglés ("Alexa, learn my voice"), `VOICE_ID_MODE=off` y `VOICE_ID_MODE_EN=enforce`. Si solo hablas un idioma, basta `VOICE_ID_MODE=enforce`.

## Por qué está hecho así

Esto es lo que funcionó después de varios intentos que no llegaban al Echo:

1. **El nombre de invocación tiene que ser una palabra que Alexa transcriba bien.** Debe coincidir exacto con lo que escribe el reconocimiento de voz: "davi" salía como "david" o "dabi" y la skill nunca se abría (Alexa contestaba "no tengo muy claro cómo ayudarte con eso"). "mango" sí funciona. Amazon acepta una sola palabra en etapa development; para certificar una skill pública podría pedir dos.
2. **El habla libre necesita una palabra fija antes del texto.** `AMAZON.SearchQuery` no acepta una muestra que sea solo `{query}`, así que lo que dices sin "pregúntale…" caía en `FallbackIntent`. La solución es un intent por palabra inicial (`FreeQueIntent` → `qué {query}`, `FreeBuscaIntent` → `busca {query}`…). Alexa no entrega esa palabra en el slot, así que el backend la vuelve a anteponer leyéndola de la primera muestra del modelo. En es-US, esto pasó las frases libres de 0/7 a 6/7; la que siguió fallando empezaba con "dime" (ver el punto 3).
3. **En es-US, "dime" es la moneda gringa** (*dime*, 10 centavos): se interpreta como número y nunca llega a la skill. Hay que empezar con otra palabra. En es-MX, `profile-nlu` falla con verbos con pronombre pegado escritos con tilde ("pregúntale").
4. **Alexa convierte "un"/"una" en "1"** dentro de `SearchQuery` ("1 correo"). El backend lo revierte.
5. **Alexa corta a los ~8 s y un agente con herramientas tarda de 5 s a varios minutos.** Las respuestas progresivas no amplían ese límite. Por eso la consulta sigue en segundo plano, la respuesta queda guardada en `data/tasks.json` (24 h, sobrevive reinicios) y se entrega con "repite" o al volver a abrir. El límite de espera al agente es de 10 min: un pronóstico del tiempo con búsqueda tardó 138 s.
6. **El agente responde en Markdown y la voz leería los asteriscos, y deletrearía las URL enteras.** Se limpia antes de hablar: de un link solo se dice el sitio ("meteochile.gob.cl"), o nada si la respuesta ya lo nombra. La tarjeta de la app conserva la respuesta completa.
7. **Alexa exige HTTPS en el puerto 443, y Tailscale Funnel publica todo `host:443`.** No compartas el 443 de esa máquina con otros servicios de `tailscale serve`: Funnel los expondría también. Publica solo `/alexa`.
8. **La firma de Amazon se verifica siempre.** El adapter de `ask-sdk` rechaza con 400 sin dejar log, así que el backend registra cada request HTTP en `data/alexa-debug.log`.
9. **Una skill en etapa development funciona solo en los Echo de la misma cuenta Amazon** que creó la skill. Si aparece en *app Alexa → Skills y juegos → Tus skills → Desarrollo*, está disponible en tu Echo.
10. **Todo se maneja desde la terminal con ASK CLI**: crear la skill, subir el modelo, probar NLU y simular. La consola web y el Echo quedan solo para la prueba final.

## Puesta en marcha

Ver **[SETUP.md](SETUP.md)**. En resumen:

```bash
npm ci && cp .env.example .env              # completa el agente y ALEXA_ENDPOINT
npm i -g ask-cli && ask configure           # login de Amazon (el mismo de tu Echo)
tailscale funnel --bg --https=443 --set-path=/alexa http://127.0.0.1:3107/alexa
npm start                                   # o deploy/alexa-bridge.service
npm run skill -- create                     # crea la skill, sube el modelo, la habilita
npm run nlu                                 # ¿cada frase llega al intent correcto?
npm run skill -- simulate "abre mango" --new
```

## Pruebas

- `npm run nlu` corre `test/nlu-cases.json` contra el modelo real con `ask smapi profile-nlu` y muestra qué intent elige Alexa para cada frase. Úsalo después de cada cambio al modelo.
- `npm run skill -- simulate "<frase>" [--new]` hace un viaje completo por la nube de Alexa hasta tu backend. Prueba la cadena entera sin el Echo, excepto el reconocimiento de voz.
- `npm run check` verifica la sintaxis.

## Configuración

Todo está en `.env` (ver `.env.example`). Lo principal:

| Variable | Para qué |
|---|---|
| `HERMES_GATEWAY_URL`, `HERMES_GATEWAY_TOKEN`, `HERMES_API_MODEL` | El agente. Con Hermes: `platforms.api_server` en `~/.hermes/config.yaml`. |
| `ASSISTANT_NAME` | Cómo se presenta por voz y en la app Alexa. |
| `ALEXA_RETURN_PHRASE` | La frase para volver a abrir, que se menciona en los mensajes ("Alexa, mango"). |
| `ALEXA_ENDPOINT` | URL pública `https://<host>/alexa`. |
| `VOICE_GATEWAY_TIMEOUT_MS` / `HERMES_MAX_WAIT_MS` | Espera dentro de un turno de voz (5 s) y espera máxima al agente (10 min). |
| `ALLOW_USER_IDS` | Restringe la skill a ciertos userIds de Alexa. |

La palabra de invocación (`invocationName`), las palabras iniciales (`Free*Intent`) y la palabra de cierre (primera muestra de `AMAZON.StopIntent`) viven en `config/interaction-model.json`. Después de cambiarlas: `npm run skill -- model` y reinicia el backend.

## Limitaciones conocidas

- Un solo dueño por despliegue: todas las tareas son de la misma persona.
- Una tarea que está corriendo cuando el backend se reinicia queda como fallida ("Tarea interrumpida por reinicio").
- El historial de conversación dura lo que dura la sesión de Alexa.
- No es una skill publicable tal cual: le faltan política de privacidad, account linking para que cada usuario use su propio agente y hosting que no dependa de un PC.
