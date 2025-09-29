export function buildPrompt(params: {
  framework: 'jest' | 'vitest';
  renderer: 'rtl-web' | 'rtl-native' | 'none';
  relPath: string;
  codeChunk: string;
}): string {
  const { framework, renderer, relPath, codeChunk } = params;
  const runner = framework === 'vitest' ? 'vitest' : 'jest';

  return `You write high-quality, minimal unit tests.
- Use ${runner} (ESM).
- Prefer Testing Library (${renderer}) for UI.
- Test behavior via public API only.
- Mock external IO.
- If not testable (types-only/barrel/autogen), reply __SKIP__ only.

FILE: ${relPath}
SOURCE:

${codeChunk}

---
Return exactly one TypeScript code block with tests. If nothing to test, return __SKIP__.`;
}
