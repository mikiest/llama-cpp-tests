import fs from 'node:fs/promises';
import path from 'node:path';
import prettier from 'prettier';
import { WorkPlan } from './planner.js';
import { buildPrompt } from './prompt.js';
import type { ModelWrapper } from './model.js';
import { estimateTokens } from './chunker.js';
import { chunkKey } from './runState.js';
import { verifyGeneratedTestSource } from './testVerifier.js';
import { countTests, detectHints } from './testUtils.js';
import { runGeneratedTestFile } from './testRunner.js';

export async function generateTestsForPlan(model: ModelWrapper, plan: WorkPlan, opts: {
  projectRoot: string;
  outDir: string;
  force: boolean;
  debug?: boolean;
  onProgress?: (evt: { type: 'start'|'write'|'skip'|'exists'|'tool'|'error'; file: string; chunkId?: string; message?: string }) => void;
  resume?: { completedChunks: Set<string> };
  maxFixLoops: number;
}) {
  for (const item of plan.items) {
    const skipKey = chunkKey(item.rel);
    if (!item.chunks.length) {
      if (opts.resume?.completedChunks.has(skipKey)) continue;
      opts.onProgress?.({ type: 'skip', file: item.rel, message: item.skipReason });
      continue;
    }
    for (const chunk of item.chunks) {
      const key = chunkKey(item.rel, chunk.id);
      if (opts.resume?.completedChunks.has(key)) continue;
      opts.onProgress?.({ type: 'start', file: item.rel, chunkId: chunk.id, message: String(chunk.approxTokens) });

      let codeForPrompt = chunk.code;
      const initialPrompt = buildPrompt({ framework: plan.framework, renderer: plan.renderer, relPath: item.rel, codeChunk: codeForPrompt });
      const budget = plan.ctxBudget - 128; // leave headroom
      if (estimateTokens(initialPrompt) > budget) {
        codeForPrompt = slimCode(codeForPrompt, Math.max(128, Math.floor(budget * 0.8)));
      }

      const outPath = resolveOutPath(opts.projectRoot, opts.outDir, item.rel);
      await fs.mkdir(path.dirname(outPath), { recursive: true });
      if (!opts.force) {
        try {
          await fs.access(outPath);
          if (opts.debug) console.log(`Exists, not overwriting: ${outPath}`);
          opts.onProgress?.({ type: 'exists', file: item.rel, chunkId: chunk.id });
          continue;
        } catch {}
      }

      const maxGen = Math.min(Math.floor(plan.ctxBudget * 0.35), 900);
      let previousTest: string | undefined;
      let failureMessage: string | undefined;
      let finalFailure = 'Model returned no code';
      let wrote = false;

      for (let attempt = 1; attempt <= opts.maxFixLoops; attempt++) {
        const prompt = buildPrompt({
          framework: plan.framework,
          renderer: plan.renderer,
          relPath: item.rel,
          codeChunk: codeForPrompt,
          attempt,
          previousTest,
          failureMessage,
        });
        const raw = await model.complete(prompt, { maxTokens: maxGen, temperature: 0.1, stop: ['__SKIP__'] });
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
          framework: plan.framework,
        });

        if (!runResult.ok) {
          finalFailure = summarizeFailure(runResult.output || 'Jest run failed');
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

function resolveOutPath(projectRoot: string, outDir: string, rel: string): string {
  const relDir = path.dirname(rel);
  const ext = path.extname(rel);
  const normalizedExt = ['.ts', '.tsx', '.js', '.jsx'].includes(ext.toLowerCase()) ? ext : '.ts';
  const baseName = path.basename(rel, ext);
  const testFile = `${baseName}.test${normalizedExt}`;
  const destDir = relDir === '.' ? '' : relDir;
  const baseDir = outDir || projectRoot;
  return path.join(baseDir, destDir, '__tests__', testFile);
}

function extractCodeBlock(text: string): string | null {
  const fenced = text.match(/```[a-zA-Z0-9_-]*\r?\n([\s\S]*?)```/);
  if (fenced) return fenced[1].trim();

  const inline = text.match(/```[a-zA-Z0-9_-]*[ \t]+([\s\S]*?)```/);
  if (inline) return inline[1].trim();

  if (/__SKIP__/.test(text)) return null;
  if (/describe\(|it\(|test\(/.test(text)) return text.trim();
  return null;
}

async function tryFormat(code: string): Promise<string> {
  try { return await prettier.format(code, { parser: 'typescript' }); } catch { return code; }
}

function slimCode(src: string, maxTokens: number): string {
  let s = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '$1')
    .replace(/\s+/g, ' ');
  let tokens = estimateTokens(s);
  if (tokens > maxTokens) {
    const ratio = maxTokens / tokens;
    const keep = Math.max(200, Math.floor(s.length * ratio));
    s = s.slice(0, keep);
  }
  return s.trim();
}

function summarizeFailure(text: string): string {
  if (!text) return 'Unknown error';
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const snippet = lines.slice(0, 3).join(' ');
  return snippet.length > 160 ? `${snippet.slice(0, 157)}…` : snippet;
}

