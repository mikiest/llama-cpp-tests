import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';

export interface RunTestResult {
  ok: boolean;
  output: string;
  command: string;
}

export async function runGeneratedTestFile(opts: {
  projectRoot: string;
  testFilePath: string;
  framework: 'jest' | 'vitest';
}): Promise<RunTestResult> {
  const runner = opts.framework === 'vitest' ? 'vitest' : 'jest';
  const rel = path.relative(opts.projectRoot, opts.testFilePath) || opts.testFilePath;
  const binCandidates = await getRunnerBinaries(opts.projectRoot, runner);

  let lastError: Error | null = null;
  for (const candidate of binCandidates) {
    try {
      const result = await execRunner(candidate.command, candidate.args.concat(runnerArgs(runner, rel)), opts.projectRoot);
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if ((error as any)?.code === 'ENOENT') continue;
      throw lastError;
    }
  }

  const message = lastError?.message || `Unable to locate ${runner} binary`;
  return {
    ok: false,
    output: message,
    command: `${runner} ${runnerArgs(runner, rel).join(' ')}`.trim(),
  };
}

async function getRunnerBinaries(projectRoot: string, runner: 'jest' | 'vitest') {
  const binDir = path.join(projectRoot, 'node_modules', '.bin');
  const executable = process.platform === 'win32' ? `${runner}.cmd` : runner;
  const localBin = path.join(binDir, executable);

  const candidates: { command: string; args: string[] }[] = [];
  try {
    await fs.access(localBin);
    candidates.push({ command: localBin, args: [] });
  } catch {}

  candidates.push({ command: runner, args: [] });
  return candidates;
}

function runnerArgs(runner: 'jest' | 'vitest', relTestPath: string): string[] {
  if (runner === 'vitest') {
    return ['run', relTestPath];
  }
  return ['--runTestsByPath', relTestPath];
}

function execRunner(command: string, args: string[], cwd: string): Promise<RunTestResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      output += chunk.toString();
    });

    child.on('error', (error) => {
      reject(error);
    });

    child.on('close', (code) => {
      const result: RunTestResult = {
        ok: code === 0,
        output: output.trim(),
        command: `${command} ${args.join(' ')}`.trim(),
      };
      if (code === 0) resolve(result);
      else resolve(result);
    });
  });
}
