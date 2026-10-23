---
name: voice-agent-bridge
description: Talk to the user's own personal agent through the alexa-agent-voice-bridge MCP server (tools ask_agent, get_agent_result, list_tasks), as a voice assistant like Alexa+ would. Covers spoken-length answers, the asynchronous pattern for slow questions (acknowledge, keep talking, collect the answer later), delivering answers the user asked for earlier by voice on their Echo (in English or Spanish), and Spanish (es-US) voice pitfalls. Use when the user wants to ask their own agent something, asks about something they requested earlier, or says the close word.
license: MIT
compatibility: Requires the alexa-agent-voice-bridge MCP server (Streamable HTTP, protocol 2025-11-25 or 2026-07-28) and its bearer token. Designed for voice-first hosts; works in any MCP client.
metadata:
  author: Grizaceo
  version: "1.0"
---

# Voice agent bridge

The MCP server is a bridge to **one person's own agent**: the same agent they talk to from their Amazon Echo. Voice and MCP share one task store, so a question asked on the Echo can be answered here and the other way around. Every answer is meant to be spoken.

## Tools

| Tool | Use it to | Returns |
|---|---|---|
| `ask_agent` | Ask a new question. `wait_seconds` defaults to 5, max 20. | `done` + `answer`, or `pending` + `task_id`, or `failed` + `answer` (the reason) |
| `get_agent_result` | Collect a pending answer by `task_id`. `wait_seconds` defaults to 0. | `done`, `pending`, `failed`, or `expired` |
| `list_tasks` | See tasks from every surface (`origin`: `voice` or `mcp`) whose answer was not delivered yet. | `tasks[]`, newest first |

An answer counts as delivered as soon as any surface returns it, so the Echo will not repeat what you already said, and vice versa.

## Speak like a voice assistant

- Reply in **one or two short sentences**. If the answer is long, give the gist and offer more.
- Plain text only: no lists, tables, Markdown, URLs, or emoji. Say numbers and times the way people say them.
- Answer in the user's language. Keep the agent's facts; trim its asides.

## Slow questions: acknowledge, keep talking, collect later

The agent can take from a few seconds to several minutes (tools, web searches). Never leave the user in silence.

1. Call `ask_agent` with `wait_seconds` of 5 or less in a live voice turn.
2. If the result is `done`, say the answer.
3. If it is `pending`, keep the `task_id` and say so in one sentence: "Estoy en eso; te aviso cuando lo tenga." Then keep the conversation going.
4. At a natural pause, or when the user asks "¿y lo de antes?", call `get_agent_result` with that `task_id` and `wait_seconds` of 5 or less.
5. Do not ask the same question again to "retry": that starts a duplicate task. Use `list_tasks` to find the existing one.

## Start of a conversation

Call `list_tasks` once. If a task is `done`, deliver it first, the way the Echo does: "Tengo la respuesta a lo que me pediste: …". Fetch its answer with `get_agent_result`. If tasks are still `pending`, mention them in one sentence and offer to wait.

## Status meanings

- `done`: say the answer.
- `pending`: still working. It survives restarts of the conversation, not of the server.
- `failed`: say briefly what happened (the `answer` holds the reason) and offer to ask again. "Tarea interrumpida por reinicio." means the server restarted mid-task.
- `expired`: the task is unknown or older than 24 hours. Offer to ask again.

## Spanish voice pitfalls (es-US)

When you suggest a phrase for the user to say to the Echo:

- Never start it with **"dime"**: es-US speech recognition hears the US coin (*dime*) and routes it elsewhere. Suggest "qué…", "cuál…", "busca…" or "pregúntale…" instead.
- Spoken "un"/"una" may be transcribed as "1" ("1 correo"). Read the question back naturally.

## Closing

The close word is **"maracuyá"** in both English and Spanish by default (each deployment can change it). When the user says it, or asks to stop, end the conversation in one sentence. If tasks are still pending, confirm they are saved and can be heard later on the Echo ("Alexa, open mango", or "Alexa, mango" in Spanish) or from any MCP client.

## Example

> **User:** Pregúntale a mi agente qué vuelos hay a Lima el viernes.
> *(ask_agent → pending, task_id t1)*
> **You:** Estoy en eso; puede tardar un par de minutos. ¿Algo más mientras tanto?
> **User:** Sí, ¿qué hora es en Madrid?
> *(ask_agent → done)*
> **You:** En Madrid son las nueve y cuarto de la mañana.
> *(later: get_agent_result t1 → done)*
> **You:** Ya tengo lo de Lima: el vuelo más barato del viernes sale a las siete y cuesta ciento veinte dólares.
> **User:** Maracuyá.
> **You:** Listo, hasta luego.

## Limits

- One owner per deployment: every task belongs to the same person.
- Tasks expire 24 hours after creation (`TASK_TTL_MS` on the server).
