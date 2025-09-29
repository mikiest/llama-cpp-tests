import { Project, Node } from 'ts-morph';

export type Chunk = { id: string; code: string; kind: 'component' | 'function' | 'hook' | 'module'; approxTokens: number };

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function chunkSource(relPath: string, code: string, maxTokens: number): Chunk[] {
  const tokens = estimateTokens(code);
  if (tokens <= maxTokens) return [{ id: relPath + '#module', code, kind: 'module', approxTokens: tokens }];

  const project = new Project({ useInMemoryFileSystem: true });
  const file = project.createSourceFile('index.tsx', code, { overwrite: true });
  const chunks: Chunk[] = [];

  for (const stmt of file.getStatements()) {
    if (Node.isFunctionDeclaration(stmt) && stmt.getName()) {
      const text = stmt.getText();
      chunks.push({ id: relPath + '#' + stmt.getName(), code: text, kind: inferKindFromName(stmt.getName()!), approxTokens: estimateTokens(text) });
    } else if (Node.isVariableStatement(stmt)) {
      for (const d of stmt.getDeclarations()) {
        const name = d.getName();
        const init = d.getInitializer();
        if (!init) continue;
        if (Node.isArrowFunction(init) || Node.isFunctionExpression(init) || looksLikeComponent(init.getText(), name)) {
          const text = stmt.getText();
          chunks.push({ id: relPath + '#' + name, code: text, kind: inferKindFromName(name), approxTokens: estimateTokens(text) });
        }
      }
    }
  }

  if (chunks.length === 0) {
    const approxSize = Math.max(512, maxTokens - 512);
    for (let i = 0; i < code.length; i += approxSize * 4) {
      const slice = code.slice(i, i + approxSize * 4);
      chunks.push({ id: relPath + `#slice${i}`, code: slice, kind: 'module', approxTokens: estimateTokens(slice) });
      if (chunks.length > 12) break;
    }
  }

  return chunks.filter(c => c.approxTokens <= maxTokens);
}

function inferKindFromName(name: string): Chunk['kind'] {
  if (/^use[A-Z]/.test(name)) return 'hook';
  if (/^[A-Z]/.test(name)) return 'component';
  return 'function';
}

function looksLikeComponent(text: string, name: string): boolean {
  return (/return\s*\(/.test(text) || /<\w/.test(text)) && /^[A-Z]/.test(name);
}
