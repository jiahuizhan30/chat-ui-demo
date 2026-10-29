'use strict';
// The agent loop: ask the model for a step -> stream its text -> run any tool calls -> repeat.
// This is the server-side half of what streamText() + tools does in the Vercel AI SDK.
// Everything it yields is one SSE event, loosely modeled on the AI SDK stream protocol.

const { scriptedModel } = require('./model');
const { buildToolset, validateSchema, SECRET } = require('./tools');

// Flatten UI messages (with parts) into the simple history the scripted model reads.
function flatten(messages) {
  const history = [];
  for (const m of messages) {
    if (m.role === 'user') {
      history.push({ kind: 'user', text: m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('') });
      continue;
    }
    for (const p of m.parts) {
      if (p.type === 'text') history.push({ kind: 'assistant-text', text: p.text });
      if (p.type === 'tool') {
        history.push({ kind: 'tool-call', toolCallId: p.toolCallId, toolName: p.toolName, input: p.input });
        if (p.state === 'output-available') history.push({ kind: 'tool-result', toolName: p.toolName, output: p.output });
        if (p.state === 'output-error') history.push({ kind: 'tool-result', toolName: p.toolName, error: p.errorText });
        if (p.state === 'output-denied') history.push({ kind: 'tool-result', toolName: p.toolName, denied: true });
      }
    }
  }
  return history;
}

// Validate -> (maybe) ask for approval -> execute. Returns 'done' or 'paused'.
// The ORDER matters: policy checks run before a human is even asked.
async function* invoke(call, env, { approved = false } = {}) {
  const { toolset, flags, ctx, history } = env;
  const { toolCallId, toolName, input } = call;

  const fail = (errorText) => {
    history.push({ kind: 'tool-result', toolName, error: errorText });
    return { type: 'tool-output-error', toolCallId, errorText };
  };

  const tool = toolset[toolName];
  if (!tool) { yield fail(`Unknown tool: ${toolName}`); return 'done'; }

  const schemaError = validateSchema(input, tool.schema);
  if (schemaError) { yield fail(schemaError); return 'done'; }

  const policyError = tool.check ? tool.check(input, flags) : null;
  if (policyError) { yield fail(policyError); return 'done'; }

  if (!approved && tool.needsApproval && tool.needsApproval(input, flags)) {
    yield { type: 'tool-approval-request', toolCallId };
    return 'paused';
  }

  const output = await tool.execute(input, ctx);
  history.push({ kind: 'tool-result', toolName, output });
  yield { type: 'tool-output-available', toolCallId, output };
  return 'done';
}

async function* runAgent({ messages, flags, ctx }) {
  const toolset = buildToolset(flags);
  const history = flatten(messages);
  const env = { toolset, flags, ctx, history };

  yield { type: 'start' };

  // Resume: the client answered an approval request on the last assistant message.
  const last = messages[messages.length - 1];
  if (last && last.role === 'assistant') {
    for (const part of last.parts) {
      if (part.type === 'tool' && part.state === 'approval-responded') {
        if (part.approved === true) {
          yield* invoke(part, env, { approved: true });
        } else {
          history.push({ kind: 'tool-result', toolName: part.toolName, denied: true });
          yield { type: 'tool-output-denied', toolCallId: part.toolCallId };
        }
      }
    }
  }

  for (let step = 0; step < 6; step++) {
    const plan = scriptedModel({ history, toolNames: Object.keys(toolset), secret: SECRET });

    for (const chunk of plan.text) {
      yield { type: 'text-delta', delta: chunk };
      await ctx.sleep(1);
    }
    if (plan.text.length) history.push({ kind: 'assistant-text', text: plan.text.join('') });
    if (!plan.toolCalls.length) break;

    let paused = false;
    for (const tc of plan.toolCalls) {
      const call = { toolCallId: ctx.newId(), toolName: tc.toolName, input: tc.input };
      yield { type: 'tool-input-start', toolCallId: call.toolCallId, toolName: call.toolName };
      await ctx.sleep(20); // lets the UI show a skeleton while "arguments stream in"
      yield { type: 'tool-input-available', ...call };
      history.push({ kind: 'tool-call', ...call });
      const status = yield* invoke(call, env);
      if (status === 'paused') paused = true;
    }
    if (paused) break; // stream ends; the client resumes after the human answers
  }

  yield { type: 'finish' };
}

module.exports = { runAgent, flatten };
