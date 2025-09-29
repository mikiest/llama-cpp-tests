export function buildTestsPrompt(params: {
  relPath: string;
  codeChunk: string;
  testPlanJson: string;
  framework: 'jest' | 'vitest';
  renderer: 'rtl-web' | 'rtl-native' | 'none';
}): string {
  const { relPath, codeChunk, testPlanJson, framework, renderer } = params;
  const runner = framework === 'vitest' ? 'vitest' : 'jest';
  return `You write minimal, high-quality tests.

- Use ${runner} (ESM). For UI, use Testing Library (${renderer}).
- Mock external IO (network, timers, storage) if listed in plan.mocks.
- Focus on public behavior. Name tests clearly.
- If plan is empty, return __SKIP__.

FILE: ${relPath}
PLAN(JSON): ${testPlanJson}

SOURCE:
${codeChunk}

---
Return exactly one TypeScript code block with tests. If empty plan, return __SKIP__.`;
}
