# Puesta en marcha

Son unos 20 minutos. Los únicos pasos que tienes que hacer a mano son el login de Amazon, el comando de Tailscale Funnel y la rutina en la app Alexa.

## 0. Requisitos

- Node.js 18 o superior.
- Un Echo, y una cuenta de developer de Amazon con **el mismo login Amazon del Echo**. Se crea gratis en https://developer.amazon.com/alexa/console/ask.
- [Tailscale](https://tailscale.com) en la máquina del backend, con Funnel permitido en tu tailnet.
- Un agente con endpoint `/v1/chat/completions` compatible con OpenAI.

## 1. Instalar

```bash
npm ci
cp .env.example .env
```

## 2. Conectar el agente

Con **Hermes Agent**, habilita el API server en `~/.hermes/config.yaml`:

```yaml
platforms:
  api_server:
    enabled: true
    host: 127.0.0.1
    port: 8742
    key: ${env:API_SERVER_KEY}
```

Define `API_SERVER_KEY` en `~/.hermes/.env` y reinicia el gateway. Luego pon la misma clave en `HERMES_GATEWAY_TOKEN` y comprueba que responde:

```bash
curl -s http://127.0.0.1:8742/v1/models -H "Authorization: Bearer $HERMES_GATEWAY_TOKEN"
```

Con otro agente, apunta `HERMES_GATEWAY_URL` y `HERMES_API_MODEL` a su endpoint. El backend envía `messages` con el historial de la sesión de Alexa, sin prompt de sistema: la personalidad la pone tu agente.

## 3. ASK CLI

```bash
npm i -g ask-cli
ask configure        # abre el navegador: entra con la cuenta Amazon del Echo y acepta
```

Cuando pregunte si quieres vincular AWS, responde que no: no hace falta.

> Si lo hace un agente sin terminal interactiva: `~/.ask/cli_config` tiene que existir antes (`{"profiles":{}}`); `ask util generate-lwa-tokens` pide confirmar con `(Y/n)` después del login (necesita una TTY); el vendor ID se obtiene con `GET https://api.amazonalexa.com/v1/vendors` y va en `profiles.default.vendor_id`.

## 4. Publicar el backend

Alexa exige HTTPS con certificado válido en el puerto **443**. Con Tailscale Funnel, publica **solo** `/alexa`:

```bash
tailscale funnel --bg --https=443 --set-path=/alexa http://127.0.0.1:3107/alexa
tailscale funnel status
```

Funnel expone todo `host:443`. Si en esa máquina ya tienes otros servicios de `tailscale serve` en el 443, muévelos a otro puerto antes (por ejemplo `tailscale serve --bg --https=8001 http://127.0.0.1:8000`), o quedarán públicos.

Pon la URL en `.env`:

```
ALEXA_ENDPOINT=https://<tu-máquina>.<tu-tailnet>.ts.net/alexa
```

## 5. Levantar el backend

```bash
npm start
```

Para que quede como servicio, usa [`deploy/alexa-bridge.service`](../../deploy/alexa-bridge.service): las instrucciones están dentro del archivo.

## 6. Crear la skill

```bash
npm run skill -- create
```

Esto crea la skill con `config/skill-manifest.json`, guarda `ALEXA_SKILL_ID` en `.env`, sube `config/interaction-model.json` a es-US, es-MX y es-ES, espera el build y habilita la skill para pruebas en tu cuenta. **Reinicia el backend** después, porque lee `ALEXA_SKILL_ID` al arrancar. Con `--dry-run` ves el manifiesto sin crear nada.

## 7. Verificar sin el Echo

```bash
npm run nlu                                     # todas las frases deberían dar OK
npm run skill -- simulate "abre mango" --new    # → "Mango listo. Puedes hablarme."
npm run skill -- simulate "estado del sistema"  # → "Estado rápido: …"
npm run skill -- simulate "qué hora es en Santiago"
npm run skill -- simulate "repite"
```

Si el simulador dice "No puedo conectarme con la Skill solicitada", Amazon no llegó al backend. Revisa `tailscale funnel status`, que el backend esté corriendo y los eventos `http` de `data/alexa-debug.log`. Recién creado, el Funnel puede tardar un par de minutos en responder bien.

## 8. En el Echo

1. Revisa que tu Echo esté en un idioma que la skill soporta (app Alexa → Dispositivos → tu Echo → Idioma). **Español (Estados Unidos)** es el más probado.
2. En la app Alexa → **Más → Skills y juegos → Tus skills → Desarrollo**, la skill debería aparecer. Si no aparece, la cuenta del Echo no es la del developer console.
3. Crea la rutina (los nombres de los botones pueden variar):
   - **Más → Rutinas → +**
   - **Cuando suceda esto → Voz** → `mango`
   - **Agregar acción → Personalizado** → `abre mango`
   - Elige tu Echo y guarda.
4. Di **"Alexa, mango"** y luego **"estado del sistema"**.

## 9. Personalizar

| Quieres cambiar | Dónde | Después |
|---|---|---|
| Palabra para abrir | `invocationName` en `config/interaction-model.json`, la rutina, y `ALEXA_RETURN_PHRASE` | `npm run skill -- model`, reiniciar el backend |
| Nombre hablado / en la app | `ASSISTANT_NAME` | Reiniciar; `npm run skill -- endpoint` para la app |
| Palabra de cierre | Primera muestra de `AMAZON.StopIntent` | `npm run skill -- model`, reiniciar |
| Palabras iniciales | Agrega un `Free<Palabra>Intent` cuya primera muestra sea `<palabra> {query}`, y un caso en `test/nlu-cases.json` | `npm run skill -- model`, `npm run nlu`, reiniciar |
| Respuestas instantáneas | `resolveFastPath()` en `src/server.js` | Reiniciar |

Elige palabras comunes que el reconocimiento de voz transcriba siempre igual. Antes de adoptar una, revisa en *app Alexa → Configuración → Privacidad de Alexa → Revisar historial de voz* qué escribió Alexa cuando la dijiste.

## Problemas frecuentes

| Síntoma | Causa probable |
|---|---|
| "No tengo muy claro cómo ayudarte con eso" | Alexa no abrió la skill: el nombre de invocación se transcribió distinto. Revisa el historial de voz. |
| "No puedo conectarme con la Skill solicitada" | Amazon no llega al backend (Funnel, backend caído) o la firma falló. Revisa los eventos `http` en `data/alexa-debug.log`. |
| "No entendí esa petición" | `FallbackIntent`: la frase no empezó con una palabra conocida. Prueba con `npm run nlu`. |
| Se queda en "Me va a tomar un momento" | El agente sigue trabajando. Di "repite" o vuelve a abrir más tarde; la espera máxima es `HERMES_MAX_WAIT_MS`. |
