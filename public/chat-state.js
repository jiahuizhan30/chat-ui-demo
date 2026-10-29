// The client-side reducer: turns stream chunks into UI message "parts".
// This is the job useChat() does for you in the Vercel AI SDK.
// state = { messages: [{ role, parts: [...] }], status: 'ready'|'submitted'|'streaming'|'error' }
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ChatState = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function findTool(msg, id) {
    return msg.parts.find(function (p) { return p.type === 'tool' && p.toolCallId === id; });
  }

  // Mutates state in place so the UI can keep stable DOM nodes per part.
  function applyChunk(state, chunk, opts) {
    const resume = !!(opts && opts.resume);
    if (chunk.type === 'start') {
      if (!resume) state.messages.push({ role: 'assistant', parts: [] });
      state.status = 'streaming';
      return state;
    }
    const msg = state.messages[state.messages.length - 1];
    switch (chunk.type) {
      case 'text-delta': {
        const lastPart = msg.parts[msg.parts.length - 1];
        if (lastPart && lastPart.type === 'text') lastPart.text += chunk.delta;
        else msg.parts.push({ type: 'text', text: chunk.delta });
        break;
      }
      case 'tool-input-start':
        msg.parts.push({ type: 'tool', toolCallId: chunk.toolCallId, toolName: chunk.toolName, state: 'input-streaming' });
        break;
      case 'tool-input-available': {
        const p = findTool(msg, chunk.toolCallId);
        if (p) { p.input = chunk.input; p.state = 'input-available'; }
        break;
      }
      case 'tool-approval-request': {
        const p = findTool(msg, chunk.toolCallId);
        if (p) p.state = 'approval-requested';
        break;
      }
      case 'tool-output-available': {
        const p = findTool(msg, chunk.toolCallId);
        if (p) { p.output = chunk.output; p.state = 'output-available'; }
        break;
      }
      case 'tool-output-error': {
        const p = findTool(msg, chunk.toolCallId);
        if (p) { p.errorText = chunk.errorText; p.state = 'output-error'; }
        break;
      }
      case 'tool-output-denied': {
        const p = findTool(msg, chunk.toolCallId);
        if (p) p.state = 'output-denied';
        break;
      }
      case 'finish':
        state.status = 'ready';
        break;
      case 'error':
        state.status = 'error';
        break;
    }
    return state;
  }

  return { applyChunk: applyChunk };
});
