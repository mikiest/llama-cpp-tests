import fs from 'node:fs/promises';
import path from 'node:path';
import pLimit from 'p-limit';
import prettier from 'prettier';
import { WorkPlan } from './planner.js';
import { buildPrompt } from './prompt.js';
import type { ModelWrapper } from './model.js';
import { estimateTokens } from './chunker.js';

export async function generateTestsForPlan(model: ModelWrapper, plan: WorkPlan, opts: {
  projectRoot: string;
  outDir: string;
  force: boolean;
  concurrency: number;
  debug?: boolean;
  onProgress?: (evt: { type: 'start'|'write'|'skip'|'exists'|'tool'|'error'; file: string; chunkId?: string; message?: string }) => void;
}) {
  const limit = pLimit(Math.max(1, opts.concurrency));
  const jobs: Array<Promise<void>> = [];

  for (const item of plan.items) {
    if (!item.chunks.length) {
      opts.onProgress?.({ type: 'skip', file: item.rel, message: item.skipReason });
      continue;
    }
    for (const chunk of item.chunks) {
      jobs.push(limit(async () => {
        opts.onProgress?.({ type: 'start', file: item.rel, chunkId: chunk.id, message: String(chunk.approxTokens) });

        let codeForPrompt = chunk.code;
        let prompt = buildPrompt({ framework: plan.framework, renderer: plan.renderer, relPath: item.rel, codeChunk: codeForPrompt });
        const budget = plan.ctxBudget - 128; // leave headroom
        if (estimateTokens(prompt) > budget) {
          codeForPrompt = slimCode(codeForPrompt, Math.max(128, Math.floor(budget * 0.8)));
          prompt = buildPrompt({ framework: plan.framework, renderer: plan.renderer, relPath: item.rel, codeChunk: codeForPrompt });
        }

        const maxGen = Math.min( Math.floor(plan.ctxBudget * 0.35), 900 );
        const raw = await model.complete(prompt, { maxTokens: maxGen, temperature: 0.1, stop: ['__SKIP__'] });
        const code = extractCodeBlock(raw);
        if (!code) {
          opts.onProgress?.({ type: 'skip', file: item.rel, chunkId: chunk.id, message: 'Model returned no code' });
          return;
        }
        const formatted = await tryFormat(code);
        const outPath = resolveOutPath(opts.projectRoot, opts.outDir, item.rel);
        await fs.mkdir(path.dirname(outPath), { recursive: true });
        if (!opts.force) {
          try { await fs.access(outPath); if (opts.debug) console.log(`Exists, not overwriting: ${outPath}`); opts.onProgress?.({ type: 'exists', file: item.rel, chunkId: chunk.id }); return; } catch {}
        }
        const tests = countTests(formatted);
        const hints = detectHints(formatted).join(', ');
        await fs.writeFile(outPath, formatted, 'utf-8');
        opts.onProgress?.({ type: 'write', file: item.rel, chunkId: chunk.id, message: `${tests}|${hints}` });
      }));
    }
  }
  await Promise.all(jobs);
}

function resolveOutPath(projectRoot: string, outDir: string, rel: string): string {
  const baseName = rel.replace(/\.(tsx|ts|jsx|js)$/i, '.test.$1');
  const onlyName = path.basename(baseName);
  return path.join(outDir, onlyName);
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

function countTests(ts: string): number {
  const re = /\bit\s*\(|\btest\s*\(/g;
  let c = 0; while (re.exec(ts)) c++; return c;
}
function detectHints(ts: string): string[] {
  const hints: string[] = [];
  if (ts.includes("@testing-library/react-native")) hints.push("RTL native");
  else if (ts.includes("@testing-library/react")) hints.push("RTL web");
  if (/msw\b|\bsetupServer\b/.test(ts)) hints.push("MSW");
  if (/jest\.|vi\./.test(ts)) hints.push("mocks");
  return hints;
}
