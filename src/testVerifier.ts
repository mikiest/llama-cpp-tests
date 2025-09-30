import path from 'node:path';
import { Project, ts } from 'ts-morph';
import { countTests } from './testUtils.js';

const GLOBAL_DECLARATIONS = `
  declare const describe: any;
  declare const it: any;
  declare const test: any;
  declare const expect: any;
  declare const beforeEach: any;
  declare const afterEach: any;
  declare const beforeAll: any;
  declare const afterAll: any;
  declare const vi: any;
  declare const jest: any;
`;

const IGNORED_DIAGNOSTIC_CODES = new Set<number>([
  2307, // Cannot find module
]);

export interface VerifyGeneratedTestResult {
  code: string;
  diagnostics: string[];
  testCount: number;
}

export function verifyGeneratedTestSource(source: string, opts: { filePath: string }): VerifyGeneratedTestResult {
  const project = new Project({
    useInMemoryFileSystem: true,
    skipAddingFilesFromTsConfig: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      jsx: ts.JsxEmit.React,
      allowJs: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      resolveJsonModule: true,
    },
  });

  project.createSourceFile('global-test-decls.d.ts', GLOBAL_DECLARATIONS, { overwrite: true });

  const virtualPath = toVirtualPath(opts.filePath);
  const sourceFile = project.createSourceFile(virtualPath, source, { overwrite: true });

  sourceFile.fixUnusedIdentifiers();
  sourceFile.organizeImports();

  const diagnostics = sourceFile
    .getPreEmitDiagnostics()
    .filter((diag) => !IGNORED_DIAGNOSTIC_CODES.has(diag.getCode()));

  const diagnosticMessages = diagnostics.map((diag) => formatDiagnostic(diag));
  const code = sourceFile.getFullText();
  const testCount = countTests(code);

  return { code, diagnostics: diagnosticMessages, testCount };
}

function toVirtualPath(filePath: string): string {
  const ext = path.extname(filePath) || '.ts';
  const base = path.basename(filePath, ext) || 'generated-test';
  return `/virtual/${base}${ext}`;
}

function formatDiagnostic(diag: import('ts-morph').Diagnostic): string {
  const message = ts.flattenDiagnosticMessageText(diag.compilerObject.messageText, '\n');
  const sourceFile = diag.getSourceFile();
  if (!sourceFile) return message;
  const start = diag.getStart();
  if (start == null) return `${sourceFile.getBaseName()}: ${message}`;
  const { line, column } = sourceFile.getLineAndColumnAtPos(start);
  return `${sourceFile.getBaseName()}:${line + 1}:${column + 1} ${message}`;
}
