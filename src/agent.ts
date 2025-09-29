import fs from 'node:fs/promises';
import path from 'node:path';
import { Project } from 'ts-morph';
import type { ScanResult } from './projectScanner.js';
import type { ModelWrapper } from './model.js';

type AgentCtx = { projectRoot: string; scan: ScanResult; maxSteps?: number; onTool?: (ev: { step: number; tool: string; args: any }) => void };
type ToolResult = { ok: boolean; data?: any; error?: string };

type Tool = (args: any, ctx: AgentCtx) => Promise<ToolResult>;

const tools: Record<string, Tool> = {
  async project_info(_args, ctx) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(ctx.projectRoot, 'package.json'), 'utf-8'));
      return { ok: true, data: { name: pkg.name, deps: { ...pkg.dependencies, ...pkg.devDependencies } } };
    } catch (e: any) {
      return { ok: false, error: String(e) };
    }
  },
  async read_file(args, ctx) {
    try {
      const rel = String(args.relPath || '');
      const entry = ctx.scan.files.find(f => f.rel === rel);
      if (!entry) return { ok: false, error: 'not_found' };
      const max = Math.min(8000, Number(args.maxChars ?? 4000));
      return { ok: true, data: entry.text.slice(0, max) };
    } catch (e: any) {
      return { ok: false, error: String(e) };
    }
  },
  async list_exports(args, ctx) {
    try {
      const rel = String(args.relPath || '');
      const file = ctx.scan.files.find(f => f.rel === rel);
      if (!file) return { ok: false, error: 'not_found' };
      const project = new Project({ useInMemoryFileSystem: true });
      const sf = project.createSourceFile(rel, file.text, { overwrite: true });
      const exports: any[] = [];
      for (const d of sf.getExportedDeclarations().entries()) {
        const [name, decls] = d as any;
        const decl = decls[0];
        const kind = decl.getKindName();
        exports.push({ name, kind });
      }
      return { ok: true, data: exports };
    } catch (e: any) {
      return { ok: false, error: String(e) };
    }
  },
  async find_usages(args, ctx) {
    const ident = String(args.identifier || '');
    if (!ident) return { ok: false, error: 'missing_identifier' };
    const matches: { rel: string; lines: number[] }[] = [];
    for (const f of ctx.scan.files) {
      const lines: number[] = [];
      const re = new RegExp(`\\b${ident}\\b`);
      const arr = f.text.split(/\r?\n/);
      arr.forEach((ln, i) => { if (re.test(ln)) lines.push(i + 1); });
      if (lines.length) matches.push({ rel: f.rel, lines: lines.slice(0, 5) });
      if (matches.length > 30) break;
    }
    return { ok: true, data: matches };
  },
  async get_ast_digest(args, ctx) {
    try {
      const rel = String(args.relPath || '');
      const file = ctx.scan.files.find(f => f.rel === rel);
      if (!file) return { ok: false, error: 'not_found' };
      const project = new Project({ useInMemoryFileSystem: true });
      const sf = project.createSourceFile(rel, file.text, { overwrite: true });

      const exports: any[] = [];
      for (const [name, decls] of sf.getExportedDeclarations().entries()) {
        const decl = decls[0];
        const kind = decl.getKindName();
        const isComp = /^[A-Z]/.test(name);
        const isHook = /^use[A-Z]/.test(name);
        exports.push({ name, kind, isComponent: isComp, isHook });
      }

      const hasFetch = /fetch\(|axios\./.test(file.text);
      const hasTimers = /\bsetTimeout\(|\bsetInterval\(/.test(file.text);
      const usesEffect = /useEffect\(/.test(file.text);
      const usesNavigation = /useNavigation\(|@react-navigation\//.test(file.text);

      return { ok: true, data: { exports, hasFetch, hasTimers, usesEffect, usesNavigation } };
    } catch (e: any) {
      return { ok: false, error: String(e) };
    }
  },
  async grep_text(args, ctx) {
    const pat = String(args.pattern || '').trim();
    if (!pat) return { ok: false, error: 'missing_pattern' };
    const flags = String(args.flags || 'i');
    const limit = Math.min(100, Number(args.limit || 40));
    const re = new RegExp(pat, flags);
    const hits: any[] = [];
    for (const f of ctx.scan.files) {
      const lines = f.text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const ln = lines[i];
        if (re.test(ln)) {
          hits.push({ rel: f.rel, line: i + 1, excerpt: ln.trim().slice(0, 200) });
          if (hits.length >= limit) break;
        }
      }
      if (hits.length >= limit) break;
    }
    return { ok: true, data: hits };
  },
  async infer_props_from_usage(args, ctx) {
    const comp = String(args.component || '').trim();
    if (!comp) return { ok: false, error: 'missing_component' };
    const rxOpen = new RegExp(`<${comp}([^>/]*)/?>(?:</${comp}>)?`, 'g');
    const props: Record<string, number> = {};
    for (const f of ctx.scan.files) {
      let m;
      while ((m = rxOpen.exec(f.text))) {
        const attrs = m[1] || '';
        const rxAttr = /([A-Za-z_][A-Za-z0-9_]*)\s*=/g;
        let a;
        while ((a = rxAttr.exec(attrs))) {
          const name = a[1];
          props[name] = (props[name] || 0) + 1;
        }
      }
    }
    const sorted = Object.entries(props).sort((a,b)=>b[1]-a[1]).map(([name,count])=>({ name, count }));
    return { ok: true, data: sorted.slice(0, 20) };
  }
};

function extractJson(text: string): any | null {
  const m = text.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

export async function runAgent(model: ModelWrapper, userPrompt: string, ctx: AgentCtx): Promise<{ ok: boolean; plan?: any[]; trace?: any[] }> {
  const trace: any[] = [];
  let observation: any = null;

  const sys = [
    'You are a planning agent for unit tests.',
    'When you need information, respond ONLY with JSON: {"tool":"<name>","args":{...}} using one of tools: project_info, read_file, list_exports, find_usages, get_ast_digest, grep_text, infer_props_from_usage.',
    'When ready to produce a plan, respond ONLY with JSON: {"final":{"plan":[...test cases array...]}}.',
    'Never write prose. Never wrap JSON in backticks.'
  ].join('\n');

  for (let step = 0; step < (ctx.maxSteps ?? 4); step++) {
    const prompt = [sys, 'User task:', userPrompt, observation ? `Observation:\n${JSON.stringify(observation).slice(0, 4000)}` : ''].join('\n\n');
    const out = await model.complete(prompt, { maxTokens: 700, temperature: 0.1 });
    const json = extractJson(out);
    if (!json) { return { ok: false, trace: trace.concat({ step, out }) }; }

    if (json.final && Array.isArray(json.final.plan)) {
      trace.push({ step, final: json.final });
      return { ok: true, plan: json.final.plan, trace };
    }

    const toolName = json.tool as string;
    const args = json.args ?? {};
    if (!toolName || !(toolName in tools)) {
      return { ok: false, trace: trace.concat({ step, error: 'bad_tool', json }) };
    }

    ctx.onTool?.({ step, tool: toolName, args });
    const result = await tools[toolName](args, ctx);
    trace.push({ step, call: { tool: toolName, args }, result: result.ok ? 'ok' : result.error });
    observation = result.ok ? result.data : { error: result.error };
  }

  return { ok: false, trace, plan: [] };
}
