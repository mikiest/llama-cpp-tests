import fs from 'node:fs/promises';
import { defineChatSessionFunction } from 'node-llama-cpp';
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

function buildSessionFunctions(ctx: AgentCtx) {
  const wrap = (name: string, schema: any, handler: (args: any) => Promise<any>) =>
    defineChatSessionFunction({
      description: name.replace(/_/g, ' '),
      params: schema,
      async handler(params: any) {
        ctx.onTool?.({ step: 0, tool: name, args: params });
        return await handler(params);
      }
    });

  return {
    project_info: wrap('project_info', { type: 'object', properties: {} }, async () => {
      const r = await tools.project_info({}, ctx); if (!r.ok) throw new Error(r.error!); return r.data;
    }),
    read_file: wrap('read_file', {
      type: 'object', properties: { relPath: { type: 'string' }, maxChars: { type: 'number' } }, required: ['relPath']
    }, async (args) => {
      const r = await tools.read_file(args, ctx); if (!r.ok) throw new Error(r.error!); return r.data;
    }),
    list_exports: wrap('list_exports', {
      type: 'object', properties: { relPath: { type: 'string' } }, required: ['relPath']
    }, async (args) => {
      const r = await tools.list_exports(args, ctx); if (!r.ok) throw new Error(r.error!); return r.data;
    }),
    find_usages: wrap('find_usages', {
      type: 'object', properties: { identifier: { type: 'string' } }, required: ['identifier']
    }, async (args) => {
      const r = await tools.find_usages(args, ctx); if (!r.ok) throw new Error(r.error!); return r.data;
    }),
    get_ast_digest: wrap('get_ast_digest', {
      type: 'object', properties: { relPath: { type: 'string' } }, required: ['relPath']
    }, async (args) => {
      const r = await tools.get_ast_digest(args, ctx); if (!r.ok) throw new Error(r.error!); return r.data;
    }),
    grep_text: wrap('grep_text', {
      type: 'object',
      properties: { pattern: { type: 'string' }, flags: { type: 'string' }, limit: { type: 'number' } },
      required: ['pattern']
    }, async (args) => {
      const r = await tools.grep_text(args, ctx); if (!r.ok) throw new Error(r.error!); return r.data;
    }),
    infer_props_from_usage: wrap('infer_props_from_usage', {
      type: 'object', properties: { component: { type: 'string' } }, required: ['component']
    }, async (args) => {
      const r = await tools.infer_props_from_usage(args, ctx); if (!r.ok) throw new Error(r.error!); return r.data;
    }),
  };
}

export async function runAgent(model: ModelWrapper, userPrompt: string, ctx: AgentCtx) {
  const sys = [
    'You are a planning agent for unit tests.',
    'You can call tools via function calling. Use them to gather facts, then return ONLY JSON as:',
    '{"final":{"plan":[{"title":"...","kind":"unit|component","arrange":"...","act":"...","assert":"...","mocks":["..."]}]}}',
    'If nothing meaningful to test: {"final":{"plan":[]}}',
  ].join('\\n');

  const functions = buildSessionFunctions(ctx);

  // Single pass: the model will call tools as needed, then answer with plan JSON.
  const out = await model.complete(`${sys}\n\nUser task:\n${userPrompt}`, {
    functions,
  });

  const json = extractJson(out);
  if (json?.final?.plan && Array.isArray(json.final.plan)) {
    return { ok: true, plan: json.final.plan, trace: [{ final: json.final }] };
  }
  return { ok: false, plan: [], trace: [{ out }] };
}

