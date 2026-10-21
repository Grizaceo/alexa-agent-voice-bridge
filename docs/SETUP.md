# Setup

About 20 minutes. The only manual steps are the Amazon login, the Tailscale Funnel command, and the routine in the Alexa app. (Spanish version: [es/SETUP.md](es/SETUP.md).)

## 0. Requirements

- Node.js 20 or later (the MCP SDK v2 requires it).
- An Echo, and an Amazon developer account that uses **the same Amazon login as the Echo**. It is free: https://developer.amazon.com/alexa/console/ask
- [Tailscale](https://tailscale.com) on the backend machine, with Funnel allowed in your tailnet (or any HTTPS endpoint on port 443 with a valid certificate).
- An agent with an OpenAI-compatible `/v1/chat/completions` endpoint.

## 1. Install

```bash
npm ci
cp .env.example .env
```

## 2. Connect your agent

With **Hermes Agent**, enable its API server in `~/.hermes/config.yaml`:

```yaml
platforms:
  api_server:
    enabled: true
    host: 127.0.0.1
    port: 8742
    key: ${env:API_SERVER_KEY}
```

Set `API_SERVER_KEY` in `~/.hermes/.env` and restart the gateway. Then put the same key in `HERMES_GATEWAY_TOKEN` and check that the agent answers:

```bash
curl -s http://127.0.0.1:8742/v1/models -H "Authorization: Bearer $HERMES_GATEWAY_TOKEN"
```

With another agent, point `HERMES_GATEWAY_URL` and `HERMES_API_MODEL` at its endpoint. The backend sends `messages` with the voice session's history and no system prompt: your agent brings its own personality.

## 3. ASK CLI

```bash
npm i -g ask-cli
ask configure        # opens the browser: sign in with the Echo's Amazon account and accept
```

When it asks whether to link an AWS account, answer no; it isn't needed.

> If an agent without an interactive terminal does this, keep in mind:
> - `~/.ask/cli_config` must already exist (`{"profiles":{}}`).
> - `ask util generate-lwa-tokens` asks for a `(Y/n)` confirmation after the browser login, which needs a TTY.
> - The vendor ID comes from `GET https://api.amazonalexa.com/v1/vendors` and goes in `profiles.default.vendor_id`.

## 4. Publish the backend

Alexa requires HTTPS with a valid certificate on port **443**. With Tailscale Funnel, publish **only** `/alexa`:

```bash
tailscale funnel --bg --https=443 --set-path=/alexa http://127.0.0.1:3107/alexa
tailscale funnel status
```

Funnel exposes all of `host:443`. If that machine already serves other `tailscale serve` routes on 443, move them to another port first (for example `tailscale serve --bg --https=8001 http://127.0.0.1:8000`), or they become public too.

Put the URL in `.env`:

```
ALEXA_ENDPOINT=https://<your-machine>.<your-tailnet>.ts.net/alexa
```

## 5. Start the backend

```bash
npm start
```

To keep it running as a service, use [`deploy/alexa-bridge.service`](../deploy/alexa-bridge.service); the instructions are inside the file.

## 6. Create the skill

```bash
npm run skill -- create
```

This does the following:
- creates the skill from `config/skill-manifest.json` and saves `ALEXA_SKILL_ID` in `.env`;
- uploads `config/interaction-model.json` for es-US, es-MX and es-ES, and waits for the build;
- enables the skill for testing on your account.

**Restart the backend** afterwards, because it reads `ALEXA_SKILL_ID` at startup. Use `--dry-run` to print the manifest without creating anything.

## 7. Verify without the Echo

```bash
npm test                                        # unit + integration tests, no network
npm run nlu                                     # every phrase should say OK
npm run skill -- simulate "abre mango" --new    # → "Mango listo. Puedes hablarme."
npm run skill -- simulate "estado del sistema"  # → "Estado rápido: …"
npm run skill -- simulate "qué hora es en Santiago"
npm run skill -- simulate "repite"
```

If the simulator says "No puedo conectarme con la Skill solicitada", Amazon didn't reach the backend. Check `tailscale funnel status`, check that the backend is running, and look at the `http` events in `data/alexa-debug.log`. A freshly created Funnel can take a couple of minutes to answer.

## 8. On the Echo

1. Make sure the Echo uses a language the skill supports (Alexa app → Devices → your Echo → Language). **Spanish (United States)** is the most tested.
2. In the Alexa app → **More → Skills & Games → Your Skills → Dev**, the skill should be listed. If it isn't, the Echo's account isn't the developer console's account.
3. Create a routine (button names may vary):
   - **More → Routines → +**
   - **When this happens → Voice** → `mango`
   - **Add action → Custom** → `abre mango`
   - Pick your Echo and save.
4. Say **"Alexa, mango"** and then **"estado del sistema"**.

## 9. The MCP server

1. Generate a token and put it in `.env` as `MCP_TOKEN`:
   ```bash
   node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"
   ```
2. Restart the backend. `curl -s http://127.0.0.1:3107/health` should show `"mcpEnabled":true`.
3. Connect a client to `http://127.0.0.1:3107/mcp` with the header `Authorization: Bearer <MCP_TOKEN>` (see the README for Claude Code and MCP Inspector).
4. For a remote client, also publish `/mcp`: `tailscale funnel --bg --https=443 --set-path=/mcp http://127.0.0.1:3107/mcp`.

Browser-based clients send an `Origin` header. Add their hostnames to `MCP_ALLOWED_ORIGINS`, or they get `403`.

## 10. Owner-only voice (Voice ID)

1. In the Alexa app, set up your **Voice ID** and turn on **Personalize skills** for it.
2. Upload the manifest, which declares the `alexa::person_id:read` permission:
   ```bash
   npm run skill -- endpoint
   ```
   If the skill's permissions in the Alexa app show a personalization toggle, turn it on.
3. Pick a mode and restart the backend after each change:
   - Start with `VOICE_ID_MODE=off`, talk to the Echo, and check that `voice_id` events in `data/alexa-debug.log` show `"recognized":true`.
   - With `VOICE_ID_MODE=enroll`, the next recognized speaker becomes the owner (`data/voice-owner.json`).
   - With `VOICE_ID_MODE=enforce`, only that owner reaches the agent. Without an enrolled owner, any recognized voice does.

## 11. Customize

| To change | Where | Then |
|---|---|---|
| Wake word | `invocationName` in `config/interaction-model.json`, the routine, and `ALEXA_RETURN_PHRASE` | `npm run skill -- model`, restart |
| Spoken name / name in the app | `ASSISTANT_NAME` | Restart; `npm run skill -- endpoint` for the app |
| Close word | First sample of `AMAZON.StopIntent` | `npm run skill -- model`, restart |
| Leading words | Add a `Free<Word>Intent` whose first sample is `<word> {query}`, plus a case in `test/nlu-cases.json` | `npm run skill -- model`, `npm run nlu`, restart |
| Instant answers | `resolveFastPath()` in `src/server.js` | Restart |

Pick common words that the speech recognizer always transcribes the same way. Before adopting one, check what Alexa wrote when you said it: *Alexa app → Settings → Alexa Privacy → Review Voice History*.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| "No tengo muy claro cómo ayudarte con eso" | Alexa didn't open the skill: the invocation name was transcribed differently. Check your voice history. |
| "No puedo conectarme con la Skill solicitada" | Amazon can't reach the backend (Funnel, backend down) or the signature check failed. See the `http` events in `data/alexa-debug.log`. |
| "No entendí esa petición" | `FallbackIntent`: the phrase didn't start with a known word. Try `npm run nlu`. |
| Stuck on "Me va a tomar un momento" | The agent is still working. Say "repite" or reopen later; the maximum wait is `HERMES_MAX_WAIT_MS`. |
| MCP client gets `401` / `403` / `503` | Missing or wrong bearer token / `Origin` not in `MCP_ALLOWED_ORIGINS` / `MCP_TOKEN` not set. |
| "No reconocí tu voz" | `VOICE_ID_MODE=enforce` and Alexa didn't recognize the speaker. Check Voice ID and "Personalize skills". |
