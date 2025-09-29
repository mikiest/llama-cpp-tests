import { ScanResult } from './projectScanner.js';
import { TestSetup } from './testSetup.js';
import { estimateTokens, chunkSource, Chunk } from './chunker.js';

export type WorkItem = {
  rel: string;
  originalTokens: number;
  chunks: Chunk[];
  skipReason?: string;
};

export type WorkPlan = {
  ctxBudget: number;
  renderer: TestSetup['renderer'];
  framework: TestSetup['framework'];
  items: WorkItem[];
};

export async function planWork(scan: ScanResult, setup: TestSetup, ctx: { contextSize: number }): Promise<WorkPlan> {
  const usable = Math.max(1024, Math.floor(ctx.contextSize * 0.5)); // tighter budget
  const items: WorkItem[] = [];
  for (const f of scan.files) {
    const tok = estimateTokens(f.text);
    if (tok < 64) continue;
    const isPureTypes = /^(export\s+type|type\s+|interface\s+)/m.test(f.text) && !/\bfunction\b|=>|return\s*\(/.test(f.text);
    if (isPureTypes) {
      items.push({ rel: f.rel, originalTokens: tok, chunks: [], skipReason: 'Types-only file' });
      continue;
    }
    const chunks = chunkSource(f.rel, f.text, usable - 768); // more reserve
    if (chunks.length === 0) {
      items.push({ rel: f.rel, originalTokens: tok, chunks: [], skipReason: 'Too large to chunk under budget' });
      continue;
    }
    items.push({ rel: f.rel, originalTokens: tok, chunks });
  }
  return { ctxBudget: usable, renderer: setup.renderer, framework: setup.framework, items };
}
