import { Command } from 'commander';
import path from 'node:path';
import ora from 'ora';
import type { Ora } from 'ora';
import fs from 'node:fs/promises';
import { ensureModel } from './model.js';
import { scanProject } from './projectScanner.js';
import { planWork } from './planner.js';
import { generateTestsForPlan } from './generator.js';
import { detectTestSetup } from './testSetup.js';
import { generateWithAgent } from './generateAgent.js';

type FileSummary = { status: 'wrote'|'exists'|'skip'; cases?: number; reason?: string; hints?: string; startedAt?: number; tokens?: number; durationMs?: number };

function toolLabel(tool: string): string {
  switch (tool) {
    case 'list_exports': return '📜  Listing exports…';
    case 'read_file': return '📖  Reading file…';
    case 'find_usages': return '🔍  Finding usages…';
    case 'grep_text': return '🔎  Searching code…';
    case 'infer_props_from_usage': return '🧠  Inferring props from usage…';
    case 'get_ast_digest': return '🧩  Analyzing AST…';
    case 'project_info': return '🧭  Reading project info…';
    default: return '🛠️  Running tool…';
  }
}

const program = new Command();

program
  .name('llama-testgen')
  .description('🧪  Generate unit tests for React/React Native TypeScript projects using node-llama-cpp')
  .argument('<model>', 'Model id or GGUF URL/path (e.g. ./models/qwen2.5-coder.Q8.gguf or https://... .gguf)')
  .argument('<projectPath>', 'Path to the project root')
  .option('-o, --out <dir>', 'Output directory for tests (default: autodetect __tests__ or __generated-tests__)', '')
  .option('--max-files <n>', 'Limit number of files to process', (v)=>parseInt(v,10))
  .option('--min-lines <n>', 'Skip files with fewer lines than this (default 10)', (v)=>parseInt(v,10), 10)
  .option('--dry-run', 'Plan only, do not write files', false)
  .option('--include <globs...>', 'Only include files matching these globs (default: src/**/*.{ts,tsx,js,jsx})')
  .option('--exclude <globs...>', 'Exclude files matching these globs')
  .option('--force', 'Overwrite existing test files', false)
  .option('--concurrency <n>', 'Parallel generations (default 2)', (v)=>parseInt(v,10), 2)
  .option('--debug', 'Verbose logging', false)
  .option('--context <n>', 'Requested context size for the model (tokens)', (v)=>parseInt(v,10))
  .option('--fast', 'Faster, smaller generations', false)
  .option('--agent', 'Use tool-calling agent (two-pass: plan → tests)', false)
  .action(async (modelArg, projectPathArg, opts, cmd) => {
    const projectRoot = path.resolve(projectPathArg);
    const modelSpec = modelArg;
    const debug = !!opts.debug;

    const spin = ora({ spinner: 'dots' });

    spin.start('🤖  Loading model');
    const model = await ensureModel(modelSpec, { debug, contextSize: opts.context });
    spin.succeed('🤖  Model loaded');

    spin.start('🧠  Probing context size');
    const ctxInfo = await model.getContextInfo();
    spin.succeed(`🧠  Context size: ${ctxInfo.contextSize}`);

    spin.start('🧭  Detecting test setup');
    const testSetup = await detectTestSetup(projectRoot, opts.out);
    spin.succeed(`🧭  Using ${testSetup.framework} with ${testSetup.renderer}`);

    spin.start('🔎  Scanning project files');
    const scan = await scanProject(projectRoot, {
      include: opts.include,
      exclude: opts.exclude,
      minLines: opts.minLines,
      maxFiles: opts.maxFiles,
      debug,
    });
    spin.succeed(`🔎  Found ${scan.files.length} candidate files`);

    spin.start('📝  Planning work and chunking sources');
    const plan = await planWork(scan, testSetup, ctxInfo);
    const totalChunks = plan.items.reduce((acc, it) => acc + it.chunks.length, 0);
    const initiallySkipped = plan.items.filter(i => !i.chunks.length).length;
    spin.succeed(`📝  Planned ${totalChunks} chunks (${initiallySkipped} skipped)`);

    if (opts.dryRun) {
      console.log(JSON.stringify({ ctxInfo, testSetup, plan }, null, 2));
      await model.dispose();
      return;
    }

    const cleared = await clearOutputDir(testSetup.outputDir, projectRoot, { debug });
    if (debug) {
      const relOut = path.relative(projectRoot, testSetup.outputDir) || testSetup.outputDir;
      console.log(cleared ? `🧹  Cleared output dir: ${relOut}` : `🧹  Skipped clearing output dir: ${relOut}`);
    }

    const overall = ora(opts.agent ? '✍️  Agent mode: planning & generating…' : '✍️  Generating tests…').start();
    let activity: Ora | null = null;
    let activityText = '';
    if (opts.agent) {
      activityText = '🛠️  Preparing…';
      activity = ora(activityText).start();
    }
    let written = 0, exists = 0, skippedCount = initiallySkipped;

    const perFile = new Map<string, FileSummary>();
    const chunkStartTimes = new Map<string, number>();
    const chunkPromptTokens = new Map<string, number>();
    const lastToolMessages = new Map<string, string>();

    const setActivity = (text: string) => {
      activityText = text;
      if (activity) {
        activity.text = text;
        activity.render();
      }
    };

    const logLine = (symbol: string, message: string) => {
      if (activity) {
        activity.stop();
      }
      console.log(`${symbol}  ${message}`);
      if (activity) {
        activity.start(activityText || '🛠️  Working…');
      }
    };

    const chunkKey = (evt: { file: string; chunkId?: string }) => `${evt.file}::${evt.chunkId ?? '0'}`;

    const formatDuration = (ms?: number) => {
      if (ms == null) return '-';
      if (ms < 1000) return `${ms} ms`;
      const seconds = ms / 1000;
      return `${seconds < 10 ? seconds.toFixed(2) : seconds.toFixed(1)} s`;
    };

    const formatPromptTokens = (tokens?: number) => {
      if (tokens == null || !Number.isFinite(tokens)) return '';
      return `prompt≈ ${Math.round(tokens)} tok`;
    };

    const commonProgress = (evt: { type: 'start'|'write'|'skip'|'exists'|'tool'|'error'; file: string; chunkId?: string; message?: string }) => {
      const key = chunkKey(evt);
      const chunkLabel = evt.chunkId ? ` [chunk ${evt.chunkId}]` : '';
      if (evt.type === 'start') {
        if (!perFile.has(evt.file)) perFile.set(evt.file, { status: 'skip' });
        const info = perFile.get(evt.file)!;
        if (!info.startedAt) info.startedAt = Date.now();
        const approx = evt.message ? parseInt(evt.message, 10) : NaN;
        if (!Number.isFinite(info.tokens)) info.tokens = 0;
        if (!chunkStartTimes.has(key)) {
          chunkStartTimes.set(key, Date.now());
          if (Number.isFinite(approx)) {
            info.tokens = (info.tokens ?? 0) + approx;
            chunkPromptTokens.set(key, approx);
          }
          const approxLabel = formatPromptTokens(approx);
          logLine('🧩', `${evt.file}${chunkLabel} – analyzing${approxLabel ? ` (${approxLabel})` : ''}`);
        }
        setActivity(`🧩  Analyzing ${evt.file}${chunkLabel}…`);
        perFile.set(evt.file, info);
      } else if (evt.type === 'exists') {
        exists++;
        const info = perFile.get(evt.file) || { status: 'exists' } as FileSummary;
        const started = chunkStartTimes.get(key);
        const duration = started ? Date.now() - started : undefined;
        if (started) chunkStartTimes.delete(key);
        const approxTokens = chunkPromptTokens.get(key);
        chunkPromptTokens.delete(key);
        lastToolMessages.delete(key);
        info.durationMs = (info.startedAt ? Date.now() - info.startedAt : undefined);
        perFile.set(evt.file, info);
        const durationLabel = duration ? ` • ⏱️ ${formatDuration(duration)}` : '';
        const promptLabel = formatPromptTokens(approxTokens);
        logLine('📄', `${evt.file}${chunkLabel} – exists (use --force to overwrite)${durationLabel}${promptLabel ? ` • ${promptLabel}` : ''}`);
        setActivity('🛠️  Working…');
      } else if (evt.type === 'skip') {
        skippedCount++;
        const info = perFile.get(evt.file) || { status: 'skip' } as FileSummary;
        const started = chunkStartTimes.get(key);
        const duration = started ? Date.now() - started : undefined;
        if (started) chunkStartTimes.delete(key);
        const approxTokens = chunkPromptTokens.get(key);
        chunkPromptTokens.delete(key);
        lastToolMessages.delete(key);
        info.durationMs = (info.startedAt ? Date.now() - info.startedAt : undefined);
        info.reason = evt.message;
        perFile.set(evt.file, info);
        const reason = evt.message ? ` (${evt.message})` : '';
        const durationLabel = duration ? ` • ⏱️ ${formatDuration(duration)}` : '';
        const promptLabel = formatPromptTokens(approxTokens);
        logLine('⏭️', `${evt.file}${chunkLabel} – skipped${reason}${durationLabel}${promptLabel ? ` • ${promptLabel}` : ''}`);
        setActivity('🛠️  Working…');
      } else if (evt.type === 'write') {
        written++;
        let cases = undefined, hints = undefined;
        if (evt.message) {
          const [c, h] = evt.message.split('|');
          if (c) cases = parseInt(c, 10);
          if (h) hints = h;
        }
        const info = perFile.get(evt.file) || { status: 'wrote' } as FileSummary;
        const started = chunkStartTimes.get(key);
        const duration = started ? Date.now() - started : undefined;
        if (started) chunkStartTimes.delete(key);
        const approxTokens = chunkPromptTokens.get(key);
        chunkPromptTokens.delete(key);
        lastToolMessages.delete(key);
        info.durationMs = (info.startedAt ? Date.now() - info.startedAt : undefined);
        info.status = 'wrote'; info.cases = cases; info.hints = hints; perFile.set(evt.file, info);
        const caseLabel = typeof cases === 'number' ? `${cases} test${cases === 1 ? '' : 's'}` : 'tests';
        const hintLabel = hints && hints.trim().length ? ` • hints: ${hints.trim()}` : '';
        const durationLabel = duration ? ` • ⏱️ ${formatDuration(duration)}` : '';
        const promptLabel = formatPromptTokens(approxTokens);
        logLine('✅', `${evt.file}${chunkLabel} – wrote ${caseLabel}${hintLabel}${durationLabel}${promptLabel ? ` • ${promptLabel}` : ''}`);
        setActivity('🛠️  Working…');
      } else if (evt.type === 'tool') {
        const msg = evt.message || '';
        const tool = msg.split(' ')[0];
        const detail = msg.slice(tool.length).trim();
        const label = toolLabel(tool);
        const text = detail ? `${label} ${detail}` : label;
        if (text.trim().length && lastToolMessages.get(key) !== text) {
          lastToolMessages.set(key, text);
          logLine('🛠️', `${evt.file}${chunkLabel} – ${text}`);
        }
        setActivity(`${text} • ${evt.file}${chunkLabel}`);
      } else if (evt.type === 'error') {
        const started = chunkStartTimes.get(key);
        const duration = started ? Date.now() - started : undefined;
        if (started) chunkStartTimes.delete(key);
        const approxTokens = chunkPromptTokens.get(key);
        chunkPromptTokens.delete(key);
        lastToolMessages.delete(key);
        const durationLabel = duration ? ` • ⏱️ ${formatDuration(duration)}` : '';
        const promptLabel = formatPromptTokens(approxTokens);
        const reason = evt.message ? `: ${evt.message}` : '';
        logLine('❌', `${evt.file}${chunkLabel} – error${reason}${durationLabel}${promptLabel ? ` • ${promptLabel}` : ''}`);
        setActivity('❌  Encountered an error');
      }

      overall.text = `✍️  ${opts.agent ? 'Agent mode: planning & generating…' : 'Generating tests…'} ✅  ${written} • ⏭️  ${skippedCount} • 📄  exists ${exists}`;
    };

    if (opts.agent) {
      await generateWithAgent(model, plan, {
        projectRoot,
        outDir: testSetup.outputDir,
        force: opts.force,
        concurrency: opts.concurrency,
        debug,
        onProgress: commonProgress,
        renderer: testSetup.renderer,
        framework: testSetup.framework,
        scan,
      });
    } else {
      await generateTestsForPlan(model, plan, {
        projectRoot,
        outDir: testSetup.outputDir,
        force: opts.force,
        concurrency: opts.concurrency,
        debug,
        onProgress: commonProgress
      });
    }

    overall.stop();
    if (activity) activity.stop();

    const lines: string[] = [];
    const rels = Array.from(perFile.keys()).sort();
    for (const rel of rels) {
      const s = perFile.get(rel)!;
      if (s.status === 'wrote') {
        const base = rel.replace(/\.(tsx|ts|jsx|js)$/i, m => `.test${m}`);
        const cases = typeof s.cases === 'number' ? `${s.cases} cases` : `tests`; const hintStr = s.hints && s.hints.trim().length ? `, ${s.hints}` : '';
        lines.push(`✅  ${rel} → wrote ${path.basename(base)} (${cases}${hintStr ? ', ' + hintStr : ''}) • ⏱️  ${formatDuration(s.durationMs)} • prompt≈ ${s.tokens ?? 0} tok`);
      } else if (s.status === 'exists') {
        lines.push(`📄  ${rel} → exists (use --force to overwrite) • ⏱️  ${formatDuration(s.durationMs)} • prompt≈ ${s.tokens ?? 0} tok`);
      } else {
        const reason = s.reason ? s.reason : 'skipped';
        lines.push(`⏭️  ${rel} → skipped (${reason}) • ⏱️  ${formatDuration(s.durationMs)} • prompt≈ ${s.tokens ?? 0} tok`);
      }
    }
    for (const l of lines) console.log(l);

    ora().succeed(`✅  Done. Wrote ${written} • ⏭️  skipped ${skippedCount} • 📄  existed ${exists}. Output → ${testSetup.outputDir}`);

    await model.dispose();
  });

program.parseAsync(process.argv);

async function clearOutputDir(outDir: string, projectRoot: string, opts: { debug?: boolean }) {
  try {
    const rel = path.relative(projectRoot, outDir);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
      if (opts.debug) console.warn(`Skipping clear of ${outDir} (outside project root)`);
      return false;
    }

    const entries = await fs.readdir(outDir).catch(() => []);
    await Promise.all(entries.map(async (entry) => {
      const target = path.join(outDir, entry);
      await fs.rm(target, { recursive: true, force: true });
    }));
    return true;
  } catch (error) {
    if (opts.debug) console.warn(`Failed to clear output dir ${outDir}:`, error);
    return false;
  }
}
