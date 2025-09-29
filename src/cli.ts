import { Command } from 'commander';
import path from 'node:path';
import ora from 'ora';
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

    const overall = ora(opts.agent ? '✍️  Agent mode: planning & generating…' : '✍️  Generating tests…').start();
    const activity = opts.agent ? ora('🛠️  Preparing…').start() : null;
    let written = 0, exists = 0, skippedCount = initiallySkipped;

    const perFile = new Map<string, FileSummary>();

    const commonProgress = (evt: { type: 'start'|'write'|'skip'|'exists'|'tool'|'error'; file: string; chunkId?: string; message?: string }) => {
      if (evt.type === 'start') {
        if (activity) activity.text = `📝  Analyzing ${evt.file}…`;
        if (!perFile.has(evt.file)) perFile.set(evt.file, { status: 'skip' });
        const info = perFile.get(evt.file)!;
        if (!info.startedAt) info.startedAt = Date.now();
        const t = evt.message ? parseInt(evt.message, 10) : 0;
        info.tokens = (info.tokens ?? 0) + (Number.isFinite(t) ? t : 0);
        perFile.set(evt.file, info);
      } else if (evt.type === 'exists') {
        exists++;
        const info = perFile.get(evt.file) || { status: 'exists' } as FileSummary;
        info.durationMs = (info.startedAt ? Date.now() - info.startedAt : undefined);
        perFile.set(evt.file, info);
        if (activity) activity.text = `📄  Exists: ${evt.file}`;
      } else if (evt.type === 'skip') {
        skippedCount++;
        const info = perFile.get(evt.file) || { status: 'skip' } as FileSummary;
        info.durationMs = (info.startedAt ? Date.now() - info.startedAt : undefined);
        info.reason = evt.message;
        perFile.set(evt.file, info);
        if (activity) activity.text = `⏭️  Skipped: ${evt.file}`;
      } else if (evt.type === 'write') {
        written++;
        let cases = undefined, hints = undefined;
        if (evt.message) {
          const [c, h] = evt.message.split('|');
          if (c) cases = parseInt(c, 10);
          if (h) hints = h;
        }
        const info = perFile.get(evt.file) || { status: 'wrote' } as FileSummary;
        info.durationMs = (info.startedAt ? Date.now() - info.startedAt : undefined);
        info.status = 'wrote'; info.cases = cases; info.hints = hints; perFile.set(evt.file, info);
        if (activity) activity.text = `✅  Wrote tests for ${evt.file}`;
      } else if (evt.type === 'tool') {
        const msg = evt.message || '';
        const tool = msg.split(' ')[0];
        if (activity) activity.text = toolLabel(tool);
      }

      overall.text = `✍️  ${opts.agent ? 'Agent mode: planning & generating…' : 'Generating tests…'} ✅  ${written} • ⏭️  ${skippedCount} • 📄  exist ${exists}`;
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
        lines.push(`✅  ${rel} → wrote ${path.basename(base)} (${cases}${hintStr ? ', ' + hintStr : ''}) • ⏱️  ${s.durationMs ? (Math.round(s.durationMs/10)/100).toFixed(2) + 's' : '-'} • in≈ ${s.tokens ?? 0} tok`);
      } else if (s.status === 'exists') {
        lines.push(`📄  ${rel} → exists (use --force to overwrite) • ⏱️  ${s.durationMs ? (Math.round(s.durationMs/10)/100).toFixed(2) + 's' : '-'} • in≈ ${s.tokens ?? 0} tok`);
      } else {
        const reason = s.reason ? s.reason : 'skipped';
        lines.push(`⏭️  ${rel} → skipped (${reason}) • ⏱️  ${s.durationMs ? (Math.round(s.durationMs/10)/100).toFixed(2) + 's' : '-'} • in≈ ${s.tokens ?? 0} tok`);
      }
    }
    for (const l of lines) console.log(l);

    ora().succeed(`✅  Done. Wrote ${written} • ⏭️  skipped ${skippedCount} • 📄  existed ${exists}. Output → ${testSetup.outputDir}`);

    await model.dispose();
  });

program.parseAsync(process.argv);
