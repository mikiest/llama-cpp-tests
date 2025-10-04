import assert from 'node:assert/strict';
import { runAgent } from '../src/agent.js';
import type { ModelWrapper } from '../src/model.js';
import type { ScanResult } from '../src/projectScanner.js';

const scan: ScanResult = {
  root: process.cwd(),
  files: [],
};

const fakeModel: ModelWrapper = {
  async getContextInfo() {
    throw new Error('not implemented');
  },
  async complete(_prompt, opts) {
    const read = opts?.functions?.read_file;
    assert.ok(read, 'read_file tool should be available');

    const outcome = await read.handler({ relPath: 'does/not/exist.ts' });
    assert.deepEqual(outcome, { ok: false, error: 'not_found' });

    return JSON.stringify({ final: { plan: [], reason: 'Source chunk missing' } });
  },
  async dispose() {},
};

const result = await runAgent(fakeModel, 'Plan tests when file is missing', {
  projectRoot: process.cwd(),
  scan,
});

assert.ok(result.ok);
assert.deepEqual(result.plan, []);
assert.strictEqual(result.reason, 'Source chunk missing');

console.log('✓ agent reports reason after tool failure and keeps going');
