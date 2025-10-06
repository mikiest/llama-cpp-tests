import fs from 'node:fs/promises';
import path from 'node:path';

export type TestSetup = {
  framework: 'jest' | 'vitest';
  renderer: 'rtl-web' | 'rtl-native' | 'none';
  outputDir: string;
};

export async function detectTestSetup(projectRoot: string, outOverride?: string): Promise<TestSetup> {
  const pkgPath = path.join(projectRoot, 'package.json');
  const pkg = JSON.parse(await fs.readFile(pkgPath, 'utf-8')) as any;

  const deps = { ...pkg.dependencies, ...pkg.devDependencies };

  const framework: TestSetup['framework'] = deps['vitest'] ? 'vitest' : 'jest';
  const isRN = !!deps['react-native'];
  const renderer: TestSetup['renderer'] = isRN
    ? 'rtl-native'
    : deps['@testing-library/react']
    ? 'rtl-web'
    : 'none';

  const outputDir = outOverride
    ? path.resolve(projectRoot, outOverride)
    : projectRoot;
  await fs.mkdir(outputDir, { recursive: true });

  return { framework, renderer, outputDir };
}

