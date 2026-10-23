# Friction log: Alexa Agent Voice Bridge

All entries come from building and testing this project on a real Echo (Spanish, United States) and from the command line, in October 2026. Format per entry: task, steps, expected vs. actual, severity, workaround, suggestion.

---

### 1. The invocation name is silently misheard and there is no feedback

- **Task:** Open the skill by voice with the invocation name "davi".
- **Steps:** Created the skill with invocation "davi", enabled it in development, and said "Alexa, abre davi" on an es-US Echo.
- **Expected:** The skill opens, or Alexa tells me it heard something close to my invocation.
- **Actual:** Speech recognition transcribed "david" or "dabi". The invocation requires an exact match, so Alexa only said "no tengo muy claro cómo ayudarte con eso". The only way to find out was Alexa app → Review Voice History.
- **Severity:** High (the skill is unusable and the cause is invisible).
- **Workaround:** Changed the invocation to "mango", which is transcribed reliably.
- **Suggestion:** When an invocation fails, surface "did you mean <invocation>?" for dev-stage skills on the developer's own devices. At model build, warn when the invocation name is a likely ASR collision (for example, close to a common first name).

### 2. `AMAZON.SearchQuery` cannot capture free speech

- **Task:** Let the user say anything ("qué tiempo hace mañana") and forward it to an agent.
- **Steps:** Tried an intent whose only sample is `{query}` (SearchQuery).
- **Expected:** A catch-all free-form intent.
- **Actual:** The model build rejects a sample that is only `{query}`. Without a carrier phrase, free speech fell into `AMAZON.FallbackIntent`: 0 of 7 test phrases reached the skill.
- **Severity:** High (it is the core use case for a conversational agent skill).
- **Workaround:** One intent per leading word (`FreeQueIntent` → `qué {query}`, `FreeBuscaIntent` → `busca {query}`, and so on). Alexa drops the leading word from the slot, so the backend restores it from the model's first sample. This got 6 of 7 phrases through; the remaining one started with "dime" (entry 3).
- **Suggestion:** Allow a free-form intent for private/dev skills, or include the raw ASR transcript in the request.

### 3. In es-US, "dime" is parsed as the US coin

- **Task:** Ask "dime el clima de Santiago" (*tell me the weather in Santiago*).
- **Steps:** `npm run nlu` (SMAPI `profile-nlu`) and the real Echo.
- **Expected:** One of the skill's intents.
- **Actual:** The request routes to `AMAZON.SendToPhoneIntent` or a number slot ("dime" = 10 cents). `profile-nlu` shows `AMAZON.FallbackIntent`.
- **Severity:** Medium ("dime" is one of the most common ways to start a request in Spanish).
- **Workaround:** Tell users to start with another word. The Agent Skill tells assistants never to suggest it.
- **Suggestion:** Locale-aware disambiguation in es-US when a custom skill session is open and the phrase continues as Spanish.

### 4. `SearchQuery` turns "un"/"una" into "1"

- **Task:** Forward "necesito ayuda con un correo" verbatim.
- **Steps:** `profile-nlu` and real requests.
- **Expected:** `query = "un correo"`.
- **Actual:** `query = "1 correo"`.
- **Severity:** Low to medium (it changes meaning for downstream LLMs).
- **Workaround:** The backend rewrites `1 <word>` back to `un <word>`.
- **Suggestion:** Don't apply number normalization inside `AMAZON.SearchQuery`, or provide the unnormalized text.

### 5. `profile-nlu` in es-MX fails with accented enclitic verbs

- **Task:** Test "pregúntale…" in es-MX.
- **Steps:** `ask smapi profile-nlu -l es-MX -u "pregúntale qué hora es"`.
- **Expected:** `TalkToDaviIntent`.
- **Actual:** Fails; the unaccented "preguntale" works.
- **Severity:** Medium (misleading test results).
- **Workaround:** Keep unaccented samples, and test es-US as the primary locale.
- **Suggestion:** Normalize diacritics in `profile-nlu` the same way the runtime does.

### 6. The ~8 s response limit cannot be extended

- **Task:** Answer questions that take an agent with tools from 5 s to minutes (a weather forecast with web search took 138 s).
- **Steps:** Sent progressive responses while waiting.
- **Expected:** Progressive responses keep the request alive.
- **Actual:** Alexa still cuts the turn at about 8 s.
- **Severity:** High for any agentic skill.
- **Workaround:** "Thinking mode". After 5 s the skill says it needs a moment and the task keeps running in the background. The answer is delivered with "repite" or on the next launch, and now persisted across restarts and shared with MCP clients.
- **Suggestion:** Native async responses: let a skill deliver a late answer into the user's next interaction or as a notification without a separate proactive-events setup. For Alexa+, an equivalent of MCP Tasks.

### 7. `ask util generate-lwa-tokens` needs `~/.ask/cli_config` and a TTY

- **Task:** Get LWA tokens non-interactively (an AI coding agent setting up the CLI).
- **Steps:** `ask util generate-lwa-tokens` on a machine without `~/.ask/cli_config`.
- **Expected:** The command works; it only needs the LWA client given in its options.
- **Actual:** `[Error]: File ~/.ask/cli_config not exists.` After creating the file by hand, the browser login is followed by a `(Y/n)` confirmation that requires a TTY.
- **Severity:** Medium (it blocks automation and CI).
- **Workaround:** Write `{"profiles":{}}` by hand, and finish the login in a real terminal.
- **Suggestion:** Fix prepared in a branch of `alexa/ask-cli`: the command no longer requires the config file, with tests (unit suite 1639 → 1640 passing). The `(Y/n)` mitigates issue #476 (local-server credential hijacking), so it should not simply be skipped. Validating the OAuth `state` would allow a safe non-interactive path.

### 8. The ASK SDK Express adapter rejects requests without logging why

- **Task:** Debug "No puedo conectarme con la Skill solicitada".
- **Steps:** Sent requests through Funnel and watched the server.
- **Expected:** A log line saying why a request was rejected (signature, timestamp, parsing).
- **Actual:** HTTP 400/500 with nothing logged.
- **Severity:** Medium.
- **Workaround:** Wrapped `res.send` in a middleware that logs status and body for every request (`data/alexa-debug.log`).
- **Suggestion:** An `onError`/logger hook in `ask-sdk-express-adapter`.

### 9. Alexa requires port 443, and Tailscale Funnel then exposes all of host:443

- **Task:** Expose only the skill endpoint from a home machine.
- **Steps:** `tailscale funnel --https=443 --set-path=/alexa …` on a machine that already served other routes on 443 through `tailscale serve`.
- **Expected:** Only `/alexa` becomes public.
- **Actual:** Funnel publishes the whole `host:443`, including the other `serve` routes.
- **Severity:** Medium (a security trap for self-hosters).
- **Workaround:** Moved the other routes to port 8001 (tailnet only) and published only the needed paths.
- **Suggestion:** Allow non-443 HTTPS ports for dev-stage skill endpoints, or document this trap in the self-hosted endpoint guide.

### 10. The simulator doesn't exercise speech recognition

- **Task:** Reproduce on the CLI what failed on the Echo (entries 1 and 3).
- **Steps:** `ask smapi simulate-skill` with text input.
- **Expected:** A way to test what the ASR will hear.
- **Actual:** Text input skips ASR entirely, so the failures only appear on a real device.
- **Severity:** Medium.
- **Workaround:** Alexa app voice history, by hand.
- **Suggestion:** Simulate from audio (or TTS of the text), and return the ASR transcript or n-best list in simulation results.

### 11. `GET /v1/vendors` returns the profile name, which looks like another account

- **Task:** Confirm the developer account is the same as the Echo's.
- **Steps:** `GET https://api.amazonalexa.com/v1/vendors`.
- **Expected:** An identifier I can match with the Echo's account.
- **Actual:** A profile name that made me believe it was a different account.
- **Severity:** Low.
- **Suggestion:** Include a masked account email or customer ID hint.

### 12. There is no API for Alexa routines

- **Task:** Make "Alexa, mango" (without "abre") open the skill.
- **Steps:** Searched SMAPI and the ASK CLI.
- **Expected:** An API to create a routine for my own devices.
- **Actual:** Routines can only be created by hand in the Alexa app.
- **Severity:** Low to medium (every user of the project has to repeat a manual step).
- **Suggestion:** A routines API, at least for the developer's own devices.

### 13. There is no way to connect a self-hosted MCP server to Alexa+ on an Echo

- **Task:** Use this project's MCP server from Alexa+ on my es-US Echo, which is the Alexa+ track itself.
- **Steps:** Read the track resources and searched the docs.
- **Expected:** A dev path to attach an MCP server (or Agent Skill) to Alexa+ on my own devices.
- **Actual:** None documented. The resources point only to the open standards, so the Echo still enters through the classic custom skill and MCP clients stand in for Alexa+.
- **Severity:** Critical for the track's premise.
- **Workaround:** Two surfaces sharing one task store: the Echo through the custom skill, and any MCP client (Claude Code in the demo) as the Alexa+ stand-in.
- **Suggestion:** A developer preview that connects a self-hosted MCP server (Streamable HTTP, with OAuth or a token) to Alexa+ on the developer's own devices, plus published locale availability.

### 14. `ask-sdk-express-adapter` pulls a `node-forge` version with a high-severity advisory and no fix

- **Task:** Keep the backend's dependencies clean.
- **Steps:** `npm audit` on a fresh install.
- **Expected:** No high-severity advisories from the official SDK.
- **Actual:** `node-forge` (RSA PKCS#1 v1.5 signature verification), through `ask-sdk-express-adapter`, with "fix available: false". The adapter uses it for request signature verification.
- **Severity:** Medium.
- **Workaround:** None in the project. The advisory is documented.
- **Suggestion:** Update the adapter's signature verification to Node's built-in `crypto`, or to a patched `node-forge`.

### 15. ask-cli's unit tests don't run on current Node.js

- **Task:** Run `npm test` in `alexa/ask-cli` to contribute the fix from entry 7.
- **Steps:** `npm ci && npm test` on Node 26.
- **Expected:** The suite runs.
- **Actual:** `ReferenceError: require is not defined in ES module scope` from mocha's bundled yargs. The CI matrix pins Node 16/18 (end of life).
- **Severity:** Low to medium (it raises the bar for outside contributors).
- **Workaround:** Ran mocha under Node 18 with `npx -p node@18`: 1640 passing.
- **Suggestion:** Update mocha and the test toolchain, and run CI on supported LTS versions. The repository's last push was in March 2024.

### 16. Voice ID: no availability info in the docs, and the iPhone app can't start the setup

- **Task:** Make the skill answer only the owner's voice (`context.System.person`), so a TV or a bystander can't talk to the agent.
- **Steps:**
  1. Read "Add Personalization to Your Alexa Skill" and added the `alexa::person_id:read` permission to the manifest.
  2. In the Alexa app on iPhone, tapped the pending "set up your Voice ID" item on the profile, and then Settings → Your Profile → Voice ID ("not set up").
- **Expected:** The docs say which locales and skill stages support personalization. The app opens the Voice ID setup.
- **Actual:**
  - The docs don't list locales or say whether personalization works in development stage. We built the feature first and could only find out on the device: on an es-US Echo, with the skill in development, it **works**. Every request from the owner carried `person` (launch, free speech, "repite"), and a TV talking during the session arrived without it.
  - In the iPhone app, both Voice ID entries returned to the previous screen with no error message, so the Voice ID could not be created from the app.
- **Severity:** Medium. We had to build before knowing whether the feature existed in our locale, and the setup path the app offers did nothing.
- **Workaround:**
  - Built it behind `VOICE_ID_MODE` (off by default) with synthetic tests, and verified on the device afterwards.
  - Said "Alexa, aprende mi voz" to the Echo. It sent a notification to the app; tapping it started the setup (four phrases out loud), and the Voice ID was created.
- **Suggestion:** Add a locale and stage availability table to the personalization docs. When the app can't open the Voice ID setup, show the reason and point to the voice command.

### 17. Voice ID in multilingual mode: a voice ID created in Spanish doesn't identify you speaking English

- **Task:** Keep owner-only voice (`context.System.person`) when the skill also speaks English, on the same Echo in English/Spanish (US) multilingual mode.
- **Steps:**
  1. Added the en-US locale to the skill (manifest and interaction model; the `alexa::person_id:read` permission is skill-wide).
  2. Switched the Echo to English (United States) / Español (Estados Unidos) and said "Alexa, open mango", then a question in English.
- **Expected:** The owner's existing voice ID (created with "Alexa, aprende mi voz") identifies them in both languages, or the docs say it doesn't.
- **Actual:**
  - Every en-US request arrived **without** `person`, launch included, so owner-only mode ignored the owner and closed the session after three phrases. The es-US requests from the same person, minutes apart, carried it.
  - After creating the voice ID again in English ("Alexa, learn my voice"), en-US requests carried `person`, with the **same** `personId` as in Spanish.
  - But then Spanish broke: in es-US sessions only the launch phrase ("Alexa, abre mango") carried `person`; every phrase after it arrived without it, in both multilingual orders (Español/English and English/Español). One person has one voice ID, and it only works in the language it was recorded in.
  - Neither the personalization docs nor the Alexa app say that a voice ID is per language.
- **Severity:** Medium. A skill that relies on personalization silently treats a bilingual owner as a stranger in one of their languages.
- **Workaround:** Created the voice ID in English too. Added logging of the locale on every Voice ID check, and an optional `VOICE_ID_MODE_EN` for deployments where that isn't possible. Redacted log: `docs/evidence/voice-id-real-echo-en.jsonl`.
- **Suggestion:** Document that a voice ID only works in the language it was recorded in, and let a person train it in both languages of multilingual mode.

### 18. Multilingual mode: a skill session stays in the language it was opened in

- **Task:** Talk to the skill in English and Spanish on an Echo in multilingual mode.
- **Steps:** Opened the skill in English, then said a phrase in Spanish inside the same session.
- **Expected:** Like Alexa itself, each utterance goes to the model of the language it was said in.
- **Actual:** The Spanish phrase was resolved with the **English** model (it landed in `AMAZON.FallbackIntent`), and the reply came in English. Switching language takes closing and reopening the skill in the other language.
- **Severity:** Low. Easy to live with once known, but nothing in the docs says it.
- **Workaround:** Open the skill in the language you are going to use ("Alexa, open mango" or "Alexa, mango"). The backend already answers in the language of each request.
- **Suggestion:** Document how multilingual mode picks the locale inside a skill session, or let the session follow the language of each utterance.
