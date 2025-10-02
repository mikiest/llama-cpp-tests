import type { ModelWrapper } from './model.js';
import { buildSessionFunctions, type AgentCtx } from './agentTools.js';

function extractJson(text: string): any | null {
  const m = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

export async function runAgent(model: ModelWrapper, userPrompt: string, ctx: AgentCtx) {
  const sys = [
    'You are a planning agent for unit tests.',
    'You can call tools via function calling. Use them to gather facts, then return ONLY JSON as:',
    '{"final":{"plan":[{"title":"...","kind":"unit|component","arrange":"...","act":"...","assert":"...","mocks":["..."]}]}}',
    'If nothing meaningful to test: {"final":{"plan":[]}}',
  ].join('\\n');

  const functions = buildSessionFunctions(ctx);
  // Single pass: the model will call tools as needed, then answer with plan JSON.
  const out = await model.complete(`${sys}\n\nUser task:\n${userPrompt}`, {
    functions,
  });

  const json = extractJson(out);
  if (json?.final?.plan && Array.isArray(json.final.plan)) {
    return { ok: true, plan: json.final.plan, trace: [{ final: json.final }] };
  }
  return { ok: false, plan: [], trace: [{ out }] };
}

