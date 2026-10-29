# Build, Break, Fix: A Streaming AI Chat UI

> **Topics:** streaming · tool calling · generative UI · prompt injection
> **Presenters:** [YOUR NAME(S)]
> **Total time:** 12 min (talk ~7 min + activity ~5 min)
> **You need:** Node 18+ and a browser. **No `npm install`, no account, no API key.**

---

## 1. Why this matters (30 sec)

Every AI product you use is a chat UI that streams text, lets the model call tools, and renders components. Every one of them also reads text it didn't write: web pages, emails, documents. **If the model reads it, the model might obey it.**

**By the end of this session you will be able to:**

1. Explain how a chat UI streams a model response to the browser.
2. Explain what a tool call is and who actually executes it.
3. Explain how a tool call becomes a rendered component (generative UI).
4. Demonstrate a prompt injection attack and apply defenses that work, and say which don't.

---

## 2. The big picture (2 min)

```
User → Chat UI → POST /api/chat → agent loop ⇄ model
                                      │
        stream of SSE events: text-delta, tool-input-start, tool-input-available,
                              tool-output-available, tool-approval-request, finish
                                      │
                                      ▼
        Chat UI turns events into "parts" and renders text + components as they arrive
```

**Attack surface:** any untrusted text that reaches the model can try to steer it. It becomes dangerous when the model can **do** something (tools) or **send** something out (rendered output).

### How this demo maps to the Vercel AI SDK

This demo is zero-dependency on purpose (no install, no key, no version drift), but each piece matches a real-world one:

| In this demo | In the Vercel AI SDK (what you'd use in production) |
|---|---|
| `agent.js` → `runAgent()` | `streamText()` with `tools` |
| `public/chat-state.js` + `streamChat()` in `app.js` | `useChat()` (messages, status, streaming) |
| `tools.js` (schema, `execute`, `needsApproval`) | `tool({ inputSchema, execute, needsApproval })` |
| `components` registry in `app.js` | tool parts rendered as components (e.g. CopilotKit's `useComponent`) |
| SSE events like `text-delta` | the SDK's UI message stream (event names here are simplified) |
| `model.js` (scripted) | a real model provider |

---

## 3. Concepts

### 3.1 Streaming
- The model generates token by token; the UI shows tokens as they arrive.
- Transport: HTTP POST, response is a **server-sent events (SSE)** stream: one-way, server to client, just a long-lived HTTP response.
- Client states: `submitted` → `streaming` → `ready` (or `error`).
- **Find it:** `server.js` (`res.write('data: …\n\n')`) and `streamChat()` in `public/app.js`. In DevTools → Network → `chat` → EventStream, you can watch the raw events.

**Check yourself:** Why is SSE enough here? Why don't we need WebSockets?

### 3.2 Tool calling
- The model emits a structured request ("call `showWeather` with `{ city: "Austin" }`"). **Your server runs it.** The model never executes anything.
- A tool = name + description + input schema + `execute`.
- Order of checks in `agent.js` → `invoke()`: **schema → policy → approval → execute.**

**Check yourself:** Where does `execute` run, browser or server? Why does that matter?

### 3.3 Generative UI
- Map each tool part to a component. Registry: `components` in `public/app.js`.
- **Every state needs a UI,** not just success: `input-streaming` (skeleton) → `input-available` → `approval-requested` → `output-available` / `output-error` / `output-denied`.
- Tool inputs and outputs came from the model, so the components use `textContent`, never `innerHTML`.

**Check yourself:** What should the UI show while a tool's arguments are still streaming?

### 3.4 Prompt injection
- Text the model reads is treated as instructions, not just data. OWASP lists it as **LLM01**.
- **Direct:** the user types the attack. **Indirect:** it hides in content the model fetches (this demo).
- **No complete fix exists.** Defense = limit what a hijacked model can do.
- **Lethal trifecta** (Simon Willison): private data + untrusted content + a way to communicate externally. Remove a leg.

| Defense (flag in `defenses.json`) | What it does | Limit |
|---|---|---|
| `validateArgs` | Server-side **policy** check on tool arguments (recipient allowlist) | Only covers what you thought to check |
| `approval` | Human must approve the tool call | Users click through; needs a good prompt |
| `removeOutboundTool` | Don't give the model the dangerous tool | **Doesn't stop the image channel** (see activity) |
| `blockExternalImages` | Renderer allowlists image sources | Only closes that one channel |

Not in the table on purpose: "tell the model to ignore malicious instructions." Policy belongs in code, not in the prompt.

**Check yourself:** Which leg of the trifecta is easiest to remove in a chat app?

---

## 4. Activity: Build, Break, Fix (5 min)

```bash
node server.js          # or: npm start        → http://localhost:3000
```

The "model" is **scripted** so the demo behaves identically everywhere and needs no API key. It deliberately acts like a *vulnerable* model: if text it reads says "ignore previous instructions", it obeys. Real models differ in how easily they're fooled; none are immune.

### Step 0: Streaming (30 sec)
1. Click **hello**.
2. **You should see:** the reply appearing word by word, the status pill going `submitted` → `streaming` → `ready`, and a small robot image (a trusted image).

### Step 1: Tool call → component (1 min)
1. Click **weather in Austin**.
2. **You should see:** a grey skeleton card for a moment (`input-streaming`), then a weather card.
3. Open `public/app.js` and find `components`. That one object is the generative UI.

### Step 2: Break it (1.5 min)
1. Click **Summarize this page**.
2. **You should see:** a page card, a summary, a **sendEmail** card ("Email sent to attacker@evil.test"), and, on the right, **the attacker's server has your API key twice**: once from the email, once from an invisible image.
3. Click "view source" on the page card to find the hidden instruction the user never saw.
4. DevTools → Network: find the request to `/evil/collect.png`. The image was a 1×1 pixel. The request *is* the leak.
5. Name the three legs of the trifecta in this app.

### Step 3: Fix it (2 min)
Click **Reset**, edit `defenses.json`, set flags to `true` **one at a time**, and re-run Step 2. (No restart needed.)

| Try | Expect |
|---|---|
| `"approval": true` | An Approve/Deny prompt appears showing the recipient and body. Nothing leaks until you click. |
| `"validateArgs": true` | The email is rejected with an error card, before any prompt. |
| `"removeOutboundTool": true` | No email attempt… **but the attacker still gets the key via the image.** |
| `"blockExternalImages": true` | The image is replaced by "🚫 image blocked". |
| all four | Nothing reaches the attacker. |

### Debrief questions
1. Which fix would you trust most? Which can still be worked around?
2. Why did removing the email tool *not* make the app safe?
3. In `approval` mode, what if the user just clicks Approve?
4. Why isn't "tell the model to ignore malicious instructions" on the list?

---

## 5. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `EADDRINUSE` | Port 3000 is taken | `PORT=3001 node server.js` |
| Changed `defenses.json`, nothing changed | Old messages were already rendered | Click **Reset**, then run again |
| Badge says `off` after editing | Badges refresh when you send a message | Send any message |
| Nothing streams / blank page | Opened `index.html` as a file | Run `node server.js` and use `http://localhost:3000` |
| Works in browser but `npm test` fails | Node older than 18 (needs built-in `fetch`) | Upgrade Node |

<!-- AUTHOR NOTE: Add the real bugs you hit in YOUR clean-machine rebuild. -->

---

## 6. Run the tests

```bash
npm test      # 13 checks: streaming, tool states, the attack, every defense, HTML escaping
```

Tested with Node 22 on Linux and Chromium. **Not yet tested:** Windows/macOS, Safari/Firefox, StackBlitz/CodeSandbox. Do this in your clean-machine rebuild.

---

## 7. Known simplifications (be ready to say these out loud)

- The model is a script, not an LLM. It shows the *mechanism*, not how often real models get fooled.
- The server trusts the client's "approved" flag. Production code must verify approvals server-side (the AI SDK tracks them in the message history).
- `blockExternalImages` runs in the client renderer, and the "attacker" is simulated on the same origin under `/evil/`, so the allowlist is path-based here. In production, allowlist trusted **hosts** or proxy images.
- Argument validation here is hand-rolled; use Zod in a real project.

---

## 8. Key takeaways

1. Streaming is a long-lived HTTP response of small events.
2. The model *requests* tool calls; your server *executes* them.
3. Generative UI = map tool parts to components, and handle every state.
4. Prompt injection has no complete fix. Constrain what a hijacked model can do, and close **every** exfiltration channel, not just the obvious one.

---

## 9. Further reading

- Vercel AI SDK docs: `useChat`, stream protocol, tools, human-in-the-loop (TODO: add links)
- OWASP Top 10 for LLM Applications: LLM01 Prompt Injection, LLM05 Improper Output Handling (TODO: link)
- Simon Willison: "The lethal trifecta" (TODO: link)
- Incident write-ups: EchoLeak, ForcedLeak (TODO: read the primary sources first)

---

## Presenter notes (delete before sharing)

| Time | Section |
|---|---|
| 0:00 | Hook + objectives |
| 0:30 | Big picture + SDK mapping |
| 2:30 | Streaming → tools → gen UI |
| 5:00 | Prompt injection concepts |
| 7:00 | Activity (Steps 0-3) |
| 12:00 | Done |

**Pre-flight**
- [ ] Clean-machine rebuild from this README only
- [ ] Sandbox link works in an incognito window (TODO: URL)
- [ ] Slack announcement ≥ 2 days ahead (even if "nothing to install")
- [ ] Rehearsed out loud, timed, twice
- [ ] Backup: screen recording of Steps 0-3
- [ ] Answer ready: "Can't a classifier just detect injections?" (It raises the bar; attackers adapt; it's not a guarantee.)
