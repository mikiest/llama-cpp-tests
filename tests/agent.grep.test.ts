import assert from 'node:assert/strict';
import { runAgent } from '../src/agent.js';
import type { ModelWrapper } from '../src/model.js';
import type { ScanResult } from '../src/projectScanner.js';

const scan: ScanResult = {
  root: process.cwd(),
  files: [
    {
      path: 'src/example.ts',
      rel: 'src/example.ts',
      ext: '.ts',
      text: 'const foo = 1;\nconsole.log(foo);\n',
      lines: 2,
    },
  ],
};

const ctx = {
  projectRoot: process.cwd(),
  scan,
};

const fakeModel: ModelWrapper = {
  async getContextInfo() {
    throw new Error('not implemented');
  },
  async complete(_prompt, opts) {
    const grep = opts?.functions?.grep_text;
    assert.ok(grep, 'grep_text tool should be available');

    const invalid = await grep.handler({ pattern: 'foo', flags: 'rn' });
    assert.deepEqual(invalid, { ok: false, error: 'invalid_flags' });

    const hits = await grep.handler({ pattern: 'foo', flags: 'im' });
    assert.ok(Array.isArray(hits));
    assert.ok(hits.length >= 1, 'Expected at least one match for valid flags');
    assert.strictEqual(hits[0].rel, 'src/example.ts');

    return JSON.stringify({ final: { plan: [] } });
  },
  async dispose() {},
};

await runAgent(fakeModel, 'Check grep tool behaviour', ctx);

console.log('✓ grep_text rejects invalid flags and works with valid ones');
