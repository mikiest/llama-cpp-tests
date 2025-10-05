export function buildPrompt(params: {
  framework: 'jest' | 'vitest';
  renderer: 'rtl-web' | 'rtl-native' | 'none';
  relPath: string;
  codeChunk: string;
}): string {
  const { framework, renderer, relPath, codeChunk } = params;
  const runner = framework === 'vitest' ? 'vitest' : 'jest';

  return `You write high-quality, minimal unit tests.
- Aim for one or two high-level assertions that cover the most important behavior.
- Use ${runner} (ESM).
- Prefer Testing Library (${renderer}) for UI.
- Test behavior via public API only.
- Mock external IO.
- Keep examples short and deterministic.
- If not testable (types-only/barrel/autogen), reply __SKIP__ only.
- Do not wrap your response in Markdown fences; return raw TypeScript.

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
