import path from 'node:path';
import type { ModelWrapper } from './model.js';
import type { ScanResult } from './projectScanner.js';
import { buildSessionFunctions } from './agentTools.js';

export type ReviewGeneratedTestResult = {
  ok: boolean;
  code?: string;
  changed?: boolean;
  raw?: string;
  reason?: string;
};

const REVIEW_SYSTEM = [
  'You are a senior engineer reviewing automatically generated TypeScript unit tests.',
  'You will receive the source snippet under test and the generated test file.',
  'Carefully inspect for logical issues, missing coverage, incorrect assertions, or TypeScript mistakes.',
  'You may call tools to inspect additional project files. Use them when you need more context.',
  'Respond with ONLY a Markdown code fence labelled ts that contains the COMPLETE, corrected test file.',
  'If the provided test file is already correct, return it unchanged inside the code fence.',
  'Do not include explanations outside the code fence.',
].join('\n');

function extractCodeBlock(text: string): string | null {
  const fenced = text.match(/```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();

  const inline = text.match(/```[a-zA-Z0-9_-]*[ \t]+([\s\S]*?)```/);
  if (inline) return inline[1].trim();

  if (/__SKIP__/.test(text)) return null;
  if (/describe\(|it\(|test\(/.test(text)) return text.trim();
  return null;
}

export async function reviewGeneratedTest(
  model: ModelWrapper,
  opts: {
    projectRoot: string;
    scan: ScanResult;
    sourceRelPath: string;
    originalSource: string;
    generatedTestSource: string;
    testFilePath: string;
    planJson?: string;
    maxSteps?: number;
    onTool?: (ev: { step: number; tool: string; args: any }) => void;
  },
): Promise<ReviewGeneratedTestResult> {
  const relTestFile = path.relative(opts.projectRoot, opts.testFilePath) || opts.testFilePath;
  const planSection = opts.planJson ? `\nPlanned scenarios (JSON):\n${opts.planJson}\n` : '';
  const userPrompt = [
    `Source snippet (${opts.sourceRelPath}):`,
    '```ts',
    opts.originalSource.trim(),
    '```',
    `Generated test file (${relTestFile}):`,
    '```ts',
    opts.generatedTestSource.trim(),
    '```',
    planSection,
    'Review the test file. Fix any issues and ensure imports and mocks are correct. Return the full revised test file.',
  ]
    .filter(Boolean)
    .join('\n');

  const functions = buildSessionFunctions({
    projectRoot: opts.projectRoot,
    scan: opts.scan,
    maxSteps: opts.maxSteps ?? 30,
    onTool: opts.onTool,
  });

  let raw: string;
  try {
    raw = await model.complete(`${REVIEW_SYSTEM}\n\n${userPrompt}`, {
      functions,
      maxTokens: 900,
      temperature: 0.1,
    });
  } catch (error: any) {
    return { ok: false, reason: error?.message ?? String(error) };
  }

  const code = extractCodeBlock(raw);
  if (!code) {
    return { ok: false, raw, reason: 'no_code_block' };
  }

  const normalisedExisting = opts.generatedTestSource.trim();
  const normalisedNew = code.trim();
  const changed = normalisedExisting !== normalisedNew;

  return { ok: true, code, changed, raw };
}
