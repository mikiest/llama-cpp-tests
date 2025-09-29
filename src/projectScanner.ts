import fg from 'fast-glob';
import fs from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';

export type SourceFile = { path: string; rel: string; ext: string; text: string; lines: number };
export type ScanResult = { root: string; files: SourceFile[] };

const DEFAULT_EXCLUDE = [
  'node_modules/**',
  'dist/**',
  'build/**',
  '**/*.d.ts',
  '**/*.{test,spec}.?(ts|tsx|js|jsx)',
  '**/*.stories.?(ts|tsx|js|jsx)',
  '**/__snapshots__/**',
];

export async function scanProject(root: string, opts: {
  include?: string[];
  exclude?: string[];
  minLines?: number;
  maxFiles?: number;
  debug?: boolean;
}): Promise<ScanResult> {
  const ig = ignore();
  try { ig.add(await fs.readFile(path.join(root, '.gitignore'), 'utf-8')); } catch {}
  const patterns = opts.include?.length ? opts.include : ['**/*.{ts,tsx,js,jsx}'];
  const entries = await fg(patterns, { cwd: root, dot: false, ignore: [...DEFAULT_EXCLUDE, ...(opts.exclude ?? [])] });

  const files: SourceFile[] = [];
  for (const rel of entries) {
    const abs = path.join(root, rel);
    if (ig.ignores(rel)) continue;
    const text = await fs.readFile(abs, 'utf-8');
    const lines = text.split(/\r?\n/).length;
    if ((opts.minLines ?? 10) > lines) continue;
    files.push({ path: abs, rel, ext: path.extname(rel), text, lines });
    if (opts.maxFiles && files.length >= opts.maxFiles) break;
  }
  if (opts.debug) console.log(`Scanned ${files.length} candidate files`);
  return { root, files };
}
