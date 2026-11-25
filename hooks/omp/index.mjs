import { renderHookBootstrap } from '../../src/hooks/render-bootstrap.mjs';

export function createBeforeAgentStartHandler(options = {}) {
  const { renderBootstrap = renderHookBootstrap, ...bootstrapOptions } = options;
  const sessions = new Map();
  return async (event, ctx) => {
    try {
      const key = ctx?.sessionManager?.getSessionId?.() ?? ctx?.sessionId ?? event?.sessionId
        ?? ctx?.cwd ?? event?.cwd ?? '__default__';
      if (!sessions.has(key)) {
        const cwd = ctx?.cwd ?? event?.cwd ?? process.cwd();
        sessions.set(key, renderBootstrap({ ...bootstrapOptions, cwd }));
      }
      const block = await sessions.get(key);
      if (!block) return;
      const prompt = event?.systemPrompt;
      if (Array.isArray(prompt)) return { systemPrompt: [...prompt, block] };
      if (typeof prompt === 'string' && prompt) return { systemPrompt: `${prompt}\n\n${block}` };
      return { systemPrompt: block };
    } catch {
      return undefined;
    }
  };
}

export default function multiSubMemoryOmpHook(pi) {
  pi.on('before_agent_start', createBeforeAgentStartHandler());
}
