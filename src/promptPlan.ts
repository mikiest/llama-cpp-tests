export function buildPlanPrompt(params: {
  relPath: string;
  codeChunk: string;
  framework: 'jest' | 'vitest';
  renderer: 'rtl-web' | 'rtl-native' | 'none';
}): string {
  const { relPath, codeChunk, framework, renderer } = params;
  return [
    `Plan unit tests for the file: ${relPath}.`,
    `Testing stack: ${framework} + ${renderer}.`,
    'Produce a compact plan as JSON only: {"final":{"plan":[{"title":"...","kind":"unit|component","arrange":"...","act":"...","assert":"...","mocks":["..."]}]}}',
    'Prefer public API & user behavior. Keep 2–6 cases.',
    'If nothing meaningful to test, return {"final":{"plan":[]}}.',
    'Source:',
    codeChunk
  ].join('\n');
}
