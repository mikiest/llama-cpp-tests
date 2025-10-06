export function buildTestsPrompt(params: {
  relPath: string;
  codeChunk: string;
  testPlanJson: string;
  framework: 'jest' | 'vitest';
  renderer: 'rtl-web' | 'rtl-native' | 'none';
  attempt?: number;
  previousTest?: string;
  failureMessage?: string;
}): string {
  const { relPath, codeChunk, testPlanJson, framework, renderer } = params;
  const runner = framework === 'vitest' ? 'vitest' : 'jest';
  const attemptNote = params.attempt && params.attempt > 1
    ? `\nPrevious attempt's tests failed. Use the feedback below to improve them.`
    : '';
  const previousTestSection = params.previousTest
    ? `\nPREVIOUS TEST IMPLEMENTATION:\n${truncate(params.previousTest)}\n`
    : '';
  const failureSection = params.failureMessage
    ? `\nTEST RUN FEEDBACK:\n${truncate(params.failureMessage)}\n`
    : '';
  return `You write minimal, high-quality tests.

- Aim for one or two high-level assertions that match the plan.
- Use ${runner} (ESM). For UI, use Testing Library (${renderer}).
- Mock external IO (network, timers, storage) if listed in plan.mocks.
- Focus on public behavior. Name tests clearly.
- Keep examples short and deterministic.
- If plan is empty, return __SKIP__.
- Do not wrap your response in Markdown fences; return raw TypeScript.${attemptNote}
${previousTestSection ? `${previousTestSection}` : ''}${failureSection ? `${failureSection}` : ''}

Example – component test (condensed):
import { render, screen } from '@testing-library/react';
import { Greeting } from '../Greeting';

it('displays the greeting message', () => {
  render(<Greeting name="Sky" />);
  expect(screen.getByText('Hello, Sky')).toBeInTheDocument();
});

Example – logic test (condensed):
import { sum } from '../math';

it('adds two numbers', () => {
  expect(sum(2, 3)).toBe(5);
});

FILE: ${relPath}
PLAN(JSON): ${testPlanJson}

SOURCE:
${codeChunk}

---
Return only the TypeScript test file contents without Markdown fences. If empty plan, return __SKIP__.`;
}

function truncate(text: string, max = 2000): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n…\n${text.slice(-half)}`;
}
