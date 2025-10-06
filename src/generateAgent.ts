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
import { countTests, detectHints } from './testUtils.js';
import { runGeneratedTestFile } from './testRunner.js';

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
    maxFixLoops: number;
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
        const detail = agentResult.reason ? `Empty plan: ${agentResult.reason}` : 'Empty plan';
        opts.onProgress?.({ type: 'skip', file: item.rel, chunkId: chunk.id, message: detail });
        continue;
      }

      const planJson = JSON.stringify(agentResult.plan);
      const outPath = resolveOutPath(opts.outDir, item.rel);
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      if (!opts.force) {
        try {
          await fs.access(outPath);
          opts.onProgress?.({ type: 'exists', file: item.rel, chunkId: chunk.id });
          continue;
        } catch {}
      }

      let previousTest: string | undefined;
      let failureMessage: string | undefined;
      let finalFailure = 'Model returned no code';
      let wrote = false;

      for (let attempt = 1; attempt <= opts.maxFixLoops; attempt++) {
        const testsPrompt = buildTestsPrompt({
          relPath: item.rel,
          codeChunk: chunk.code,
          testPlanJson: planJson,
          renderer: opts.renderer,
          framework: opts.framework,
          attempt,
          previousTest,
          failureMessage,
        });

        const raw = await model.complete(testsPrompt, { maxTokens: 900, temperature: 0.1 });
        const code = extractCodeBlock(raw);
        if (!code) {
          finalFailure = 'Model returned no code';
          failureMessage = 'Model returned no code';
          if (opts.debug) console.warn(`Model returned no code for ${outPath} (attempt ${attempt})`);
          continue;
        }

        const formatted = await tryFormat(code);
        const verification = verifyGeneratedTestSource(formatted, { filePath: outPath });
        if (verification.diagnostics.length) {
          finalFailure = verification.diagnostics.join(' | ');
          failureMessage = `TypeScript diagnostics:\n${verification.diagnostics.join('\n')}`;
          previousTest = formatted;
          if (opts.debug) console.warn(`Verification failed for ${outPath} (attempt ${attempt}): ${finalFailure}`);
          continue;
        }
        if (verification.testCount === 0) {
          finalFailure = 'No tests detected after verification';
          failureMessage = finalFailure;
          previousTest = formatted;
          if (opts.debug) console.warn(`Skipping ${outPath}: ${finalFailure} (attempt ${attempt})`);
          continue;
        }

        const finalCode = await tryFormat(verification.code);
        await fs.writeFile(outPath, finalCode, 'utf-8');

        const runResult = await runGeneratedTestFile({
          projectRoot: opts.projectRoot,
          testFilePath: outPath,
          framework: opts.framework,
        });

        if (!runResult.ok) {
          finalFailure = summarizeFailure(runResult.output || 'Test run failed');
          failureMessage = `${runResult.command}\n${runResult.output}`.trim();
          previousTest = finalCode;
          if (opts.debug) console.warn(`Test run failed for ${outPath} (attempt ${attempt}): ${finalFailure}`);
          if (attempt === opts.maxFixLoops) break;
          continue;
        }

        const tests = countTests(finalCode);
        const hints = detectHints(finalCode).join(', ');
        opts.onProgress?.({ type: 'write', file: item.rel, chunkId: chunk.id, message: `${tests}|${hints}` });
        wrote = true;
        break;
      }

      if (!wrote) {
        await fs.rm(outPath, { force: true });
        opts.onProgress?.({
          type: 'skip',
          file: item.rel,
          chunkId: chunk.id,
          message: `Failed after ${opts.maxFixLoops} attempts: ${summarizeFailure(finalFailure)}`,
        });
      }
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

function summarizeFailure(text: string): string {
  if (!text) return 'Unknown error';
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const snippet = lines.slice(0, 3).join(' ');
  return snippet.length > 160 ? `${snippet.slice(0, 157)}…` : snippet;
}
