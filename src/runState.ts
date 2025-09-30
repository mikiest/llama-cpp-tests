import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FileSummary } from './progressTypes.js';
import type { WorkPlan } from './planner.js';

type PersistedFileSummary = Omit<FileSummary, 'startedAt'>;

type StoredChunkState = {
  status: 'write' | 'skip' | 'exists';
  message?: string;
  durationMs?: number;
  tokens?: number;
  updatedAt: number;
};

type StoredFileState = {
  summary: PersistedFileSummary;
  chunks: Record<string, StoredChunkState>;
};

export type StoredRunState = {
  version: 1;
  planSignature: string;
  mode: 'agent' | 'basic';
  totals: {
    written: number;
    skipped: number;
    exists: number;
    completedChunks: number;
    totalChunks: number;
  };
  perFile: Record<string, StoredFileState>;
  createdAt: number;
  updatedAt: number;
};

export function chunkKey(file: string, chunkId?: string): string {
  return `${file}::${chunkId ?? '0'}`;
}

export function computePlanSignature(plan: WorkPlan): string {
  const hash = crypto.createHash('sha1');
  hash.update(plan.framework);
  hash.update('|');
  hash.update(plan.renderer);
  hash.update('|');
  hash.update(String(plan.ctxBudget));
  const items = plan.items
    .map(item => ({
      ...item,
      chunks: [...item.chunks].sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.rel.localeCompare(b.rel));
  for (const item of items) {
    hash.update(item.rel);
    hash.update('|');
    hash.update(String(item.originalTokens));
    hash.update('|');
    if (item.skipReason) hash.update(item.skipReason);
    hash.update('|');
    hash.update(String(item.chunks.length));
    for (const chunk of item.chunks) {
      hash.update(chunk.id);
      hash.update('|');
      hash.update(chunk.kind);
      hash.update('|');
      hash.update(String(chunk.approxTokens));
    }
  }
  return hash.digest('hex');
}

export async function loadRunState(statePath: string): Promise<StoredRunState | null> {
  try {
    const data = await fs.readFile(statePath, 'utf-8');
    const parsed = JSON.parse(data);
    if (parsed && parsed.version === 1) {
      return parsed as StoredRunState;
    }
    return null;
  } catch (error: any) {
    if (error && error.code === 'ENOENT') return null;
    if (process.env.DEBUG || process.env.LLAMA_TESTGEN_DEBUG) {
      console.warn(`Failed to load run state from ${statePath}:`, error);
    }
    return null;
  }
}

export function isStateCompatible(
  state: StoredRunState,
  signature: string,
  mode: 'agent' | 'basic',
  totalChunks: number,
): boolean {
  if (!state || state.version !== 1) return false;
  if (state.planSignature !== signature) return false;
  if (state.mode !== mode) return false;
  if (!state.totals || state.totals.totalChunks !== totalChunks) return false;
  return true;
}

function sanitizeSummary(summary: FileSummary): PersistedFileSummary {
  const persisted: PersistedFileSummary = { status: summary.status };
  if (summary.cases != null) persisted.cases = summary.cases;
  if (summary.hints != null) persisted.hints = summary.hints;
  if (summary.reason != null) persisted.reason = summary.reason;
  if (summary.tokens != null) persisted.tokens = summary.tokens;
  if (summary.durationMs != null) persisted.durationMs = summary.durationMs;
  return persisted;
}

function sanitizeChunkState(state: StoredChunkState): StoredChunkState {
  const persisted: StoredChunkState = {
    status: state.status,
    updatedAt: state.updatedAt,
  };
  if (state.message != null) persisted.message = state.message;
  if (state.durationMs != null) persisted.durationMs = state.durationMs;
  if (state.tokens != null) persisted.tokens = state.tokens;
  return persisted;
}

export class RunStateManager {
  private state: StoredRunState;
  private dirty = false;
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private statePath: string,
    planSignature: string,
    mode: 'agent' | 'basic',
    totalChunks: number,
    existing?: StoredRunState,
  ) {
    if (existing) {
      this.state = {
        ...existing,
        totals: {
          ...existing.totals,
          totalChunks,
        },
        planSignature,
        mode,
      };
    } else {
      const now = Date.now();
      this.state = {
        version: 1,
        planSignature,
        mode,
        totals: { written: 0, skipped: 0, exists: 0, completedChunks: 0, totalChunks },
        perFile: {},
        createdAt: now,
        updatedAt: now,
      };
    }
  }

  getCompletedChunkKeys(): Set<string> {
    const keys = new Set<string>();
    for (const entry of Object.values(this.state.perFile)) {
      for (const [chunk, chunkState] of Object.entries(entry.chunks)) {
        if (chunkState.status === 'write' || chunkState.status === 'skip' || chunkState.status === 'exists') {
          keys.add(chunk);
        }
      }
    }
    return keys;
  }

  getStateSnapshot(): StoredRunState {
    return JSON.parse(JSON.stringify(this.state));
  }

  setTotals(totals: { written: number; skipped: number; exists: number; completedChunks: number }): void {
    const prev = this.state.totals;
    if (
      prev.written === totals.written &&
      prev.skipped === totals.skipped &&
      prev.exists === totals.exists &&
      prev.completedChunks === totals.completedChunks
    ) {
      return;
    }
    this.state.totals = {
      ...this.state.totals,
      written: totals.written,
      skipped: totals.skipped,
      exists: totals.exists,
      completedChunks: totals.completedChunks,
    };
    this.markDirty();
  }

  recordFileSummary(file: string, summary: FileSummary): void {
    const persisted = sanitizeSummary(summary);
    const existing = this.state.perFile[file];
    this.state.perFile[file] = {
      summary: persisted,
      chunks: existing?.chunks ?? {},
    };
    this.markDirty();
  }

  recordChunkResult(
    file: string,
    chunkId: string | undefined,
    result: { status: 'write' | 'skip' | 'exists'; message?: string; tokens?: number; durationMs?: number },
  ): void {
    const key = chunkKey(file, chunkId);
    const entry = this.state.perFile[file] ?? { summary: { status: 'skip' }, chunks: {} };
    entry.chunks[key] = sanitizeChunkState({
      status: result.status,
      message: result.message,
      tokens: result.tokens,
      durationMs: result.durationMs,
      updatedAt: Date.now(),
    });
    this.state.perFile[file] = entry;
    this.markDirty();
  }

  private markDirty(): void {
    this.state.updatedAt = Date.now();
    this.dirty = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (this.dirty) {
        void this.flush();
      }
    }, 200);
  }

  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.dirty = false;
    await fs.mkdir(path.dirname(this.statePath), { recursive: true }).catch(() => {});
    const serialized = JSON.stringify(this.state, null, 2);
    await fs.writeFile(this.statePath, serialized, 'utf-8');
  }

  async reset(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    this.dirty = false;
    await fs.rm(this.statePath, { force: true });
  }

  async complete(): Promise<void> {
    await this.flush();
    await fs.rm(this.statePath, { force: true });
  }
}
