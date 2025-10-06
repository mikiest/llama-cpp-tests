export function buildPrompt(params: {
  framework: 'jest' | 'vitest';
  renderer: 'rtl-web' | 'rtl-native' | 'none';
  relPath: string;
  codeChunk: string;
  attempt?: number;
  previousTest?: string;
  failureMessage?: string;
}): string {
  const { framework, renderer, relPath, codeChunk } = params;
  const runner = framework === 'vitest' ? 'vitest' : 'jest';
  const attemptNote = params.attempt && params.attempt > 1
    ? `\nPrevious attempt's tests failed. Use the feedback below to adjust the new version.`
    : '';
  const previousTestSection = params.previousTest
    ? `\nPREVIOUS TEST IMPLEMENTATION:\n${truncate(params.previousTest)}\n`
    : '';
  const failureSection = params.failureMessage
    ? `\nTEST RUN FEEDBACK:\n${truncate(params.failureMessage)}\n`
    : '';

  return `You write high-quality, minimal unit tests.
- Aim for one or two high-level assertions that cover the most important behavior.
- Use ${runner} (ESM).
- Prefer Testing Library (${renderer}) for UI.
- Test behavior via public API only.
- Mock external IO.
- Keep examples short and deterministic.
- If not testable (types-only/barrel/autogen), reply __SKIP__ only.
- Do not wrap your response in Markdown fences; return raw TypeScript.${attemptNote}
${previousTestSection ? `${previousTestSection}` : ''}${failureSection ? `${failureSection}` : ''}

Example – component test (condensed):
import { render, screen } from '@testing-library/react';
import { SaveButton } from '../SaveButton';

it('shows the provided label', () => {
  render(<SaveButton label="Save" />);
  expect(screen.getByRole('button', { name: /save/i })).toBeInTheDocument();
});

Example – logic test (condensed):
import { formatName } from '../formatName';

it('joins first and last name with a space', () => {
  expect(formatName('Ada', 'Lovelace')).toBe('Ada Lovelace');
});

FILE: ${relPath}
SOURCE:

${codeChunk}

---
Return only the TypeScript test file contents without Markdown fences. If nothing to test, return __SKIP__.`;
}

function truncate(text: string, max = 2000): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n…\n${text.slice(-half)}`;
}
