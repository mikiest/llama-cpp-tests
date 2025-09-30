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

export async function generateTestsForPlan(model: ModelWrapper, plan: WorkPlan, opts: {
  projectRoot: string;
  outDir: string;
  force: boolean;
  debug?: boolean;
  onProgress?: (evt: { type: 'start'|'write'|'skip'|'exists'|'tool'|'error'; file: string; chunkId?: string; message?: string }) => void;
  resume?: { completedChunks: Set<string> };
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
      let prompt = buildPrompt({ framework: plan.framework, renderer: plan.renderer, relPath: item.rel, codeChunk: codeForPrompt });
      const budget = plan.ctxBudget - 128; // leave headroom
      if (estimateTokens(prompt) > budget) {
        codeForPrompt = slimCode(codeForPrompt, Math.max(128, Math.floor(budget * 0.8)));
        prompt = buildPrompt({ framework: plan.framework, renderer: plan.renderer, relPath: item.rel, codeChunk: codeForPrompt });
      }

      const maxGen = Math.min(Math.floor(plan.ctxBudget * 0.35), 900);
      const raw = await model.complete(prompt, { maxTokens: maxGen, temperature: 0.1, stop: ['__SKIP__'] });
      const code = extractCodeBlock(raw);
      if (!code) {
        opts.onProgress?.({ type: 'skip', file: item.rel, chunkId: chunk.id, message: 'Model returned no code' });
        continue;
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

      const formatted = await tryFormat(code);
      const verification = verifyGeneratedTestSource(formatted, { filePath: outPath });
      if (verification.diagnostics.length) {
        const message = verification.diagnostics.join(' | ');
        opts.onProgress?.({ type: 'error', file: item.rel, chunkId: chunk.id, message: message });
        if (opts.debug) console.warn(`Verification failed for ${outPath}: ${message}`);
        continue;
      }
      if (verification.testCount === 0) {
        const message = 'No tests detected after verification';
        opts.onProgress?.({ type: 'skip', file: item.rel, chunkId: chunk.id, message });
        if (opts.debug) console.warn(`Skipping ${outPath}: ${message}`);
        continue;
      }

      const finalCode = await tryFormat(verification.code);
      const tests = countTests(finalCode);
      const hints = detectHints(finalCode).join(', ');
      await fs.writeFile(outPath, finalCode, 'utf-8');
      opts.onProgress?.({ type: 'write', file: item.rel, chunkId: chunk.id, message: `${tests}|${hints}` });
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
  return path.join(outDir, destDir, '__tests__', testFile);
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

