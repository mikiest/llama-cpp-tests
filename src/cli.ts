import { Command } from 'commander';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import ora from 'ora';
import pc from 'picocolors';
import { ensureModel } from './model.js';
import { scanProject } from './projectScanner.js';
import { planWork } from './planner.js';
import { generateTestsForPlan } from './generator.js';
import { detectTestSetup } from './testSetup.js';
import { generateWithAgent } from './generateAgent.js';
import { FileSummary } from './progressTypes.js';
import {
  chunkKey as makeChunkKey,
  computePlanSignature,
  isStateCompatible,
  loadRunState,
  RunStateManager,
  StoredRunState,
} from './runState.js';

function toolLabel(tool: string): string {
  switch (tool) {
    case 'list_exports': return '📜  Listing exports…';
    case 'read_file': return '📖  Reading file…';
    case 'read_file_section': return '📑  Reading file section…';
    case 'find_usages': return '🔍  Finding usages…';
    case 'grep_text': return '🔎  Searching code…';
    case 'list_files': return '📁  Listing files…';
    case 'get_imports': return '📦  Inspecting imports…';
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

    const planSignature = computePlanSignature(plan);
    const runMode = opts.agent ? 'agent' : 'basic';
    const statePath = path.join(testSetup.outputDir, '.llama-testgen-state.json');
    const existingState = await loadRunState(statePath);

    const askForResume = async (state: StoredRunState): Promise<'continue' | 'reset'> => {
      console.log();
      console.log(
        pc.yellow(
          `💾  Found unfinished run from ${new Date(state.updatedAt).toLocaleString()} (${state.totals.completedChunks}/${state.totals.totalChunks} chunks)`,
        ),
      );
      console.log(
        `    ✅  wrote ${state.totals.written}  |  ⏭️  skipped ${state.totals.skipped}  |  📄  existed ${state.totals.exists}`,
      );
      if (input.isTTY && output.isTTY) {
        const rl = createInterface({ input, output });
        try {
          while (true) {
            const answer = (await rl.question('Continue previous run? (c)ontinue/(r)eset [c/r]: ')).trim().toLowerCase();
            if (answer === '' || answer === 'c' || answer === 'continue') return 'continue';
            if (answer === 'r' || answer === 'reset') return 'reset';
            console.log('Please answer with "c" to continue or "r" to reset.');
          }
        } finally {
          rl.close();
        }
      }
      console.log('No interactive terminal detected, continuing previous run by default.');
      return 'continue';
    };

    let resumeState: StoredRunState | null = null;
    let continuing = false;

    if (existingState && isStateCompatible(existingState, planSignature, runMode, totalChunks)) {
      if (existingState.totals.completedChunks >= totalChunks) {
        await fs.rm(statePath, { force: true });
      } else {
        const choice = await askForResume(existingState);
        if (choice === 'continue') {
          continuing = true;
          resumeState = existingState;
        } else {
          await fs.rm(statePath, { force: true });
        }
      }
    } else if (existingState) {
      if (debug) console.log('Incompatible previous run state found, resetting.');
      await fs.rm(statePath, { force: true });
    }

    if (opts.dryRun) {
      console.log(JSON.stringify({ ctxInfo, testSetup, plan }, null, 2));
      await model.dispose();
      return;
    }

    const cleared = continuing ? false : await clearOutputDir(testSetup.outputDir, projectRoot, { debug });
    if (debug) {
      const relOut = path.relative(projectRoot, testSetup.outputDir) || testSetup.outputDir;
      console.log(cleared ? `🧹  Cleared output dir: ${relOut}` : `🧹  Skipped clearing output dir: ${relOut}`);
    }

    const runStateManager = new RunStateManager(statePath, planSignature, runMode, totalChunks, resumeState ?? undefined);
    const completedChunkKeys = runStateManager.getCompletedChunkKeys();

    let written = continuing ? (resumeState?.totals.written ?? 0) : 0;
    let exists = continuing ? (resumeState?.totals.exists ?? 0) : 0;
    let skippedCount = continuing ? (resumeState?.totals.skipped ?? 0) : initiallySkipped;
    const overall = ora({ text: '', spinner: 'dots' }).start();
    const baseModeLabel = opts.agent ? 'Agent mode: planning & generating…' : 'Generating tests…';
    const modeLabel = continuing ? `${baseModeLabel} (resuming)` : baseModeLabel;
    let statusLine = '';

    const updateOverall = () => {
      const summaryParts = [
        `✍️  ${modeLabel}`,
        `✅  Wrote ${written}`,
        `⏭️  Skipped ${skippedCount}`,
        `📄  Already existed ${exists}`,
      ];
      const summary = pc.white(summaryParts.join('  |  '));
      overall.text = statusLine ? `${summary}\n${statusLine}` : summary;
      overall.render();
    };

    const perFile = new Map<string, FileSummary>();
    if (resumeState) {
      for (const [rel, entry] of Object.entries(resumeState.perFile)) {
        perFile.set(rel, { ...entry.summary });
      }
    }
    const chunkStartTimes = new Map<string, number>();
    const chunkPromptTokens = new Map<string, number>();
    const lastToolMessages = new Map<string, string>();
    const overallStart = Date.now();
    const finishedChunks = new Set<string>(completedChunkKeys);
    let completedChunks = continuing ? (resumeState?.totals.completedChunks ?? 0) : 0;

    runStateManager.setTotals({ written, skipped: skippedCount, exists, completedChunks });

    const markChunkFinished = (evt: { file: string; chunkId?: string }) => {
      if (evt.chunkId == null) return;
      const key = makeChunkKey(evt.file, evt.chunkId);
      if (finishedChunks.has(key)) return;
      finishedChunks.add(key);
      completedChunkKeys.add(key);
      completedChunks = Math.min(completedChunks + 1, totalChunks);
    };

    const formatDuration = (ms?: number) => {
      if (ms == null) return '-';
      if (ms < 1000) return `${Math.round(ms)}ms`;
      let totalSeconds = Math.round(ms / 1000);
      const seconds = totalSeconds % 60;
      totalSeconds = (totalSeconds - seconds) / 60;
      const minutes = totalSeconds % 60;
      const hours = Math.floor(totalSeconds / 60);
      const parts: string[] = [];
      if (hours) parts.push(`${hours}h`);
      if (hours || minutes) parts.push(`${hours ? String(minutes).padStart(2, '0') : minutes}m`);
      const secondsLabel = (hours || minutes) ? String(seconds).padStart(2, '0') : String(seconds);
      parts.push(`${secondsLabel}s`);
      return parts.join('');
    };

    const formatElapsed = () => formatDuration(Date.now() - overallStart);

    const formatPromptTokens = (tokens?: number) => {
      if (tokens == null || !Number.isFinite(tokens)) return '';
      return `prompt≈ ${Math.round(tokens)} tok`;
    };

    const formatFileLabel = (file: string, chunkId?: string) => {
      const chunkLabel = chunkId ? ` ${pc.dim(`[chunk ${chunkId}]`)}` : '';
      return `${pc.cyan(file)}${chunkLabel}`;
    };

    const emphasize = (text: string, kind: 'info'|'success'|'warn'|'skip'|'error'|'tool') => {
      switch (kind) {
        case 'info': return pc.cyan(text);
        case 'success': return pc.green(text);
        case 'warn': return pc.yellow(text);
        case 'skip': return pc.magenta(text);
        case 'error': return pc.red(text);
        case 'tool': return pc.blue(text);
        default: return pc.bold(text);
      }
    };

    const dim = (text: string) => pc.dim(text);

    const formatProgressStatus = () => {
      if (!totalChunks) return '';
      const inFlight = chunkStartTimes.size;
      const current = Math.min(completedChunks + inFlight, totalChunks);
      const pct = totalChunks ? Math.min(100, (current / totalChunks) * 100) : 0;
      const pctLabel = pct < 10 && totalChunks > 1 ? pct.toFixed(1) : pct.toFixed(0);
      return `${current}/${totalChunks} • ${pctLabel}%`;
    };

    const setActivity = (text: string) => {
      const parts: string[] = [];
      const progress = formatProgressStatus();
      if (progress) parts.push(progress);
      parts.push(`⏱️ ${formatElapsed()}`);
      const suffix = parts.length ? ` ${pc.white(`[${parts.join(' • ')}]`)}` : '';
      statusLine = `${text}${suffix}`;
      runStateManager.setTotals({ written, skipped: skippedCount, exists, completedChunks });
      updateOverall();
    };

    const logLine = (symbol: string, message: string) => {
      overall.clear();
      console.log(`${symbol}  ${message}`);
      overall.render();
    };

    if (opts.agent) setActivity('🛠️  Preparing…');
    else updateOverall();

    const commonProgress = (evt: { type: 'start'|'write'|'skip'|'exists'|'tool'|'error'; file: string; chunkId?: string; message?: string }) => {
      const key = makeChunkKey(evt.file, evt.chunkId);
      const fileLabel = formatFileLabel(evt.file, evt.chunkId);
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
          logLine('🧩', `${fileLabel} – ${emphasize('analyzing', 'info')}${approxLabel ? ` ${dim(`(${approxLabel})`)}` : ''}`);
        }
        setActivity(`🧩  ${pc.yellow('Analyzing')} ${fileLabel}…`);
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
        markChunkFinished(evt);
        info.durationMs = (info.startedAt ? Date.now() - info.startedAt : undefined);
        perFile.set(evt.file, info);
        runStateManager.recordFileSummary(evt.file, info);
        runStateManager.recordChunkResult(evt.file, evt.chunkId, {
          status: 'exists',
          tokens: approxTokens,
          durationMs: duration,
        });
        completedChunkKeys.add(key);
        const durationLabel = duration ? ` • ⏱️  ${dim(formatDuration(duration))}` : '';
        const promptLabel = formatPromptTokens(approxTokens);
        logLine('📄', `${fileLabel} – ${emphasize('exists', 'warn')} ${dim('(use --force to overwrite)')}${durationLabel}${promptLabel ? ` • ${dim(promptLabel)}` : ''}`);
        setActivity(`🛠️  ${pc.blue('Working…')}`);
      } else if (evt.type === 'skip') {
        skippedCount++;
        const info = perFile.get(evt.file) || { status: 'skip' } as FileSummary;
        const started = chunkStartTimes.get(key);
        const duration = started ? Date.now() - started : undefined;
        if (started) chunkStartTimes.delete(key);
        const approxTokens = chunkPromptTokens.get(key);
        chunkPromptTokens.delete(key);
        lastToolMessages.delete(key);
        markChunkFinished(evt);
        info.durationMs = (info.startedAt ? Date.now() - info.startedAt : undefined);
        info.reason = evt.message;
        perFile.set(evt.file, info);
        runStateManager.recordFileSummary(evt.file, info);
        runStateManager.recordChunkResult(evt.file, evt.chunkId, {
          status: 'skip',
          message: evt.message,
          tokens: approxTokens,
          durationMs: duration,
        });
        completedChunkKeys.add(key);
        const reason = evt.message ? ` ${dim(`(${evt.message})`)}` : '';
        const durationLabel = duration ? ` • ⏱️  ${dim(formatDuration(duration))}` : '';
        const promptLabel = formatPromptTokens(approxTokens);
        logLine('⏭️', `${fileLabel} – ${emphasize('skipped', 'skip')}${reason}${durationLabel}${promptLabel ? ` • ${dim(promptLabel)}` : ''}`);
        setActivity(`🛠️  ${pc.blue('Working…')}`);
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
        markChunkFinished(evt);
        info.durationMs = (info.startedAt ? Date.now() - info.startedAt : undefined);
        info.status = 'wrote';
        info.cases = cases;
        info.hints = hints;
        perFile.set(evt.file, info);
        runStateManager.recordFileSummary(evt.file, info);
        runStateManager.recordChunkResult(evt.file, evt.chunkId, {
          status: 'write',
          message: evt.message,
          tokens: approxTokens,
          durationMs: duration,
        });
        completedChunkKeys.add(key);
        const caseLabel = typeof cases === 'number' ? `${cases} test${cases === 1 ? '' : 's'}` : 'tests';
        const hintLabel = hints && hints.trim().length ? ` • hints: ${hints.trim()}` : '';
        const durationLabel = duration ? ` • ⏱️  ${dim(formatDuration(duration))}` : '';
        const promptLabel = formatPromptTokens(approxTokens);
        logLine('✅', `${fileLabel} – ${emphasize('wrote', 'success')} ${pc.bold(caseLabel)}${hintLabel ? ` ${dim(hintLabel)}` : ''}${durationLabel}${promptLabel ? ` • ${dim(promptLabel)}` : ''}`);
        setActivity(`🛠️  ${pc.blue('Working…')}`);
      } else if (evt.type === 'tool') {
        const msg = evt.message || '';
        const toolToken = msg.split(' ')[0];
        let tool = toolToken;
        let phaseLabel = '';
        if (toolToken.includes(':')) {
          const [phase, actual] = toolToken.split(':', 2);
          if (phase === 'review' && actual) {
            phaseLabel = '🔁 Review';
            tool = actual;
          }
        }
        const detail = msg.slice(toolToken.length).trim();
        const label = toolLabel(tool);
        const textCore = detail ? `${label} ${detail}` : label;
        const text = phaseLabel ? `${phaseLabel} • ${textCore}` : textCore;
        if (text.trim().length && lastToolMessages.get(key) !== text) {
          lastToolMessages.set(key, text);
          logLine('🛠️', `${fileLabel} – ${emphasize(text, 'tool')}`);
        }
        const activityLabel = phaseLabel ? `${phaseLabel} • ${label}` : label;
        setActivity(`${emphasize(activityLabel, 'tool')} • ${fileLabel}`);
      } else if (evt.type === 'error') {
        const started = chunkStartTimes.get(key);
        const duration = started ? Date.now() - started : undefined;
        if (started) chunkStartTimes.delete(key);
        const approxTokens = chunkPromptTokens.get(key);
        chunkPromptTokens.delete(key);
        lastToolMessages.delete(key);
        const durationLabel = duration ? ` • ⏱️  ${dim(formatDuration(duration))}` : '';
        const promptLabel = formatPromptTokens(approxTokens);
        const reason = evt.message ? `: ${pc.red(evt.message)}` : '';
        logLine('❌', `${fileLabel} – ${emphasize('error', 'error')}${reason}${durationLabel}${promptLabel ? ` • ${dim(promptLabel)}` : ''}`);
        setActivity(`❌  ${pc.red('Encountered an error')}`);
      }

      updateOverall();
    };

    if (opts.agent) {
      await generateWithAgent(model, plan, {
        projectRoot,
        outDir: testSetup.outputDir,
        force: opts.force,
        debug,
        onProgress: commonProgress,
        renderer: testSetup.renderer,
        framework: testSetup.framework,
        scan,
        resume: { completedChunks: completedChunkKeys },
      });
    } else {
      await generateTestsForPlan(model, plan, {
        projectRoot,
        outDir: testSetup.outputDir,
        force: opts.force,
        debug,
        onProgress: commonProgress,
        resume: { completedChunks: completedChunkKeys },
        scan,
      });
    }

    overall.stop();

    const lines: string[] = [];
    const rels = Array.from(perFile.keys()).sort();
    for (const rel of rels) {
      const s = perFile.get(rel)!;
      if (s.status === 'wrote') {
        const base = rel.replace(/\.(tsx|ts|jsx|js)$/i, m => `.test${m}`);
        const cases = typeof s.cases === 'number' ? `${s.cases} cases` : `tests`;
        const hintStr = s.hints && s.hints.trim().length ? `, ${s.hints}` : '';
        lines.push(`✅  ${pc.cyan(rel)} → ${emphasize('wrote', 'success')} ${pc.bold(path.basename(base))} (${cases}${hintStr ? ', ' + hintStr : ''}) • ⏱️  ${dim(formatDuration(s.durationMs))} • ${dim(`prompt≈ ${s.tokens ?? 0} tok`)}`);
      } else if (s.status === 'exists') {
        lines.push(`📄  ${pc.cyan(rel)} → ${emphasize('exists', 'warn')} ${dim('(use --force to overwrite)')} • ⏱️   ${dim(formatDuration(s.durationMs))} • ${dim(`prompt≈ ${s.tokens ?? 0} tok`)}`);
      } else {
        const reason = s.reason ? s.reason : 'skipped';
        lines.push(`⏭️  ${pc.cyan(rel)} → ${emphasize('skipped', 'skip')} ${dim(`(${reason})`)} • ⏱️   ${dim(formatDuration(s.durationMs))} • ${dim(`prompt≈ ${s.tokens ?? 0} tok`)}`);
      }
    }
    for (const l of lines) console.log(l);

    const relativeOut = path.relative(projectRoot, testSetup.outputDir) || testSetup.outputDir;
    ora().succeed(`✅  ${pc.green('Done.')} ${pc.green(`Wrote ${written}`)} • ${pc.magenta(`⏭️  skipped ${skippedCount}`)} • ${pc.yellow(`📄  existed ${exists}`)}. Output → ${pc.cyan(relativeOut)}`);

    if (completedChunks >= totalChunks) {
      await runStateManager.complete();
    } else {
      await runStateManager.flush();
    }

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
