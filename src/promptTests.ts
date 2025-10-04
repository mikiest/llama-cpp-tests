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

- Aim for one or two high-level assertions that match the plan.
- Use ${runner} (ESM). For UI, use Testing Library (${renderer}).
- Mock external IO (network, timers, storage) if listed in plan.mocks.
- Focus on public behavior. Name tests clearly.
- Keep examples short and deterministic.
- If plan is empty, return __SKIP__.

Example – component test (condensed):
\`\`\`ts
import { render, screen } from '@testing-library/react';
import { Greeting } from './Greeting';

test('shows message', () => {
  render(<Greeting name="Sky" />);
  expect(screen.getByText('Hello, Sky')).toBeInTheDocument();
});
\`\`\`

Example – logic test (condensed):
\`\`\`ts
import { sum } from './math';

test('adds numbers', () => {
  expect(sum(2, 3)).toBe(5);
});
\`\`\`

FILE: ${relPath}
PLAN(JSON): ${testPlanJson}

SOURCE:
${codeChunk}

---
Return exactly one TypeScript code block with tests. If empty plan, return __SKIP__.`;
}
