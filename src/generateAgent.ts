import fs from 'node:fs/promises';
import path from 'node:path';
import prettier from 'prettier';
import type { WorkPlan } from './planner.js';
import type { ModelWrapper } from './model.js';
import type { ScanResult } from './projectScanner.js';
import { buildPlanPrompt } from './promptPlan.js';
import { buildTestsPrompt } from './promptTests.js';
import { runAgent } from './agent.js';
import { chunkKey } from './runState.js';
import { verifyGeneratedTestSource } from './testVerifier.js';
import { reviewGeneratedTest } from './testReviewer.js';
import { countTests, detectHints } from './testUtils.js';

export async function generateWithAgent(
  model: ModelWrapper,
  plan: WorkPlan,
  opts: {
    projectRoot: string;
    outDir: string;
    force: boolean;
    debug?: boolean;
    maxToolCalls?: number;
    renderer: 'rtl-web' | 'rtl-native' | 'none';
    framework: 'jest' | 'vitest';
    scan: ScanResult;
    onProgress?: (evt: { type: 'start'|'write'|'skip'|'exists'|'tool'|'error'; file: string; chunkId?: string; message?: string }) => void;
    resume?: { completedChunks: Set<string> };
  }
) {
  for (const item of plan.items) {
    const skipKey = chunkKey(item.rel);
    if (!item.chunks.length) {
      if (opts.resume?.completedChunks.has(skipKey)) continue;
      opts.onProgress?.({ type: 'skip', file: item.rel, message: 'No viable chunks' });
      continue;
    }
    for (const chunk of item.chunks) {
      const key = chunkKey(item.rel, chunk.id);
      if (opts.resume?.completedChunks.has(key)) continue;
      opts.onProgress?.({ type: 'start', file: item.rel, chunkId: chunk.id, message: String(chunk.approxTokens) });

      const planPrompt = buildPlanPrompt({
        relPath: item.rel,
        codeChunk: chunk.code,
        renderer: opts.renderer,
        framework: opts.framework
      });

      let agentResult;
      try {
        agentResult = await runAgent(model, planPrompt, {
          projectRoot: opts.projectRoot,
          scan: opts.scan,
          maxSteps: opts.maxToolCalls ?? 40,
          onTool: ({ tool, args }) => {
            const detail = (args?.relPath || args?.identifier || args?.component || '');
            opts.onProgress?.({ type: 'tool', file: item.rel, chunkId: chunk.id, message: `${tool} ${detail}` });
          },
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        opts.onProgress?.({ type: 'error', file: item.rel, chunkId: chunk.id, message });
        continue;
      }

      if (!agentResult.ok || !agentResult.plan || agentResult.plan.length === 0) {
        opts.onProgress?.({ type: 'skip', file: item.rel, chunkId: chunk.id, message: 'Empty plan' });
        continue;
      }

      const testsPrompt = buildTestsPrompt({
        relPath: item.rel,
        codeChunk: chunk.code,
        testPlanJson: JSON.stringify(agentResult.plan),
        renderer: opts.renderer,
        framework: opts.framework
      });

      const raw = await model.complete(testsPrompt, { maxTokens: 900, temperature: 0.1 });
      const code = extractCodeBlock(raw);
      if (!code) {
        opts.onProgress?.({ type: 'skip', file: item.rel, chunkId: chunk.id, message: 'Model returned no code' });
        continue;
      }
      const formatted = await tryFormat(code);
      const outPath = resolveOutPath(opts.outDir, item.rel);
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      if (!opts.force) {
        try {
          await fs.access(outPath);
          opts.onProgress?.({ type: 'exists', file: item.rel, chunkId: chunk.id });
          continue;
        } catch {}
      }
      const verification = verifyGeneratedTestSource(formatted, { filePath: outPath });
      if (verification.diagnostics.length) {
        const message = verification.diagnostics.join(' | ');
        opts.onProgress?.({ type: 'error', file: item.rel, chunkId: chunk.id, message });
        if (opts.debug) console.warn(`Verification failed for ${outPath}: ${message}`);
        continue;
      }
      if (verification.testCount === 0) {
        const message = 'No tests detected after verification';
        opts.onProgress?.({ type: 'skip', file: item.rel, chunkId: chunk.id, message });
        if (opts.debug) console.warn(`Skipping ${outPath}: ${message}`);
        continue;
      }

      let finalCode = await tryFormat(verification.code);

      const review = await reviewGeneratedTest(model, {
        projectRoot: opts.projectRoot,
        scan: opts.scan,
        sourceRelPath: item.rel,
        originalSource: chunk.code,
        generatedTestSource: finalCode,
        testFilePath: outPath,
        planJson: JSON.stringify(agentResult.plan),
        onTool: (event) => {
          const detail = event.args?.relPath || event.args?.identifier || event.args?.component || event.args?.pattern || '';
          opts.onProgress?.({ type: 'tool', file: item.rel, chunkId: chunk.id, message: `review:${event.tool} ${detail}`.trim() });
        },
      });

      if (review.ok && review.code) {
        const refined = await tryFormat(review.code);
        const reviewVerification = verifyGeneratedTestSource(refined, { filePath: outPath });
        if (reviewVerification.diagnostics.length) {
          const message = `Review output failed verification: ${reviewVerification.diagnostics.join(' | ')}`;
          opts.onProgress?.({ type: 'error', file: item.rel, chunkId: chunk.id, message });
          if (opts.debug) console.warn(`Review verification failed for ${outPath}: ${message}`);
        } else if (reviewVerification.testCount === 0) {
          const message = 'Review output removed all tests';
          opts.onProgress?.({ type: 'error', file: item.rel, chunkId: chunk.id, message });
          if (opts.debug) console.warn(`Review skipped for ${outPath}: ${message}`);
        } else {
          finalCode = await tryFormat(reviewVerification.code);
        }
      } else if (!review.ok && opts.debug) {
        console.warn(`Review skipped for ${outPath}: ${review.reason ?? 'unknown error'}`);
      }

      await fs.writeFile(outPath, finalCode, 'utf-8');

      const tests = countTests(finalCode);
      const hints = detectHints(finalCode).join(', ');
      opts.onProgress?.({ type: 'write', file: item.rel, chunkId: chunk.id, message: `${tests}|${hints}` });
    }
  }
}

function resolveOutPath(outDir: string, rel: string): string {
  const relDir = path.dirname(rel);
  const ext = path.extname(rel);
  const normalizedExt = ['.ts', '.tsx', '.js', '.jsx'].includes(ext.toLowerCase()) ? ext : '.ts';
  const baseName = path.basename(rel, ext);
  const testFile = `${baseName}.test${normalizedExt}`;
  const destDir = relDir === '.' ? '' : relDir;
  return path.join(outDir, destDir, '__tests__', testFile);
}

function extractCodeBlock(text: string): string | null {
  const m = text.match(/```[a-zA-Z]*\n([\s\S]*?)```/);
  if (m) return m[1].trim();
  if (/__SKIP__/.test(text)) return null;
  if (/describe\(|it\(|test\(/.test(text)) return text.trim();
  return null;
}

async function tryFormat(code: string): Promise<string> {
  try { return await prettier.format(code, { parser: 'typescript' }); } catch { return code; }
}
