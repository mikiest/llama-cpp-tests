import assert from 'node:assert/strict';
import { runAgent } from '../src/agent.js';
import type { ModelWrapper } from '../src/model.js';
import type { ScanResult } from '../src/projectScanner.js';

type ToolEvent = { step: number; tool: string; args: any };

const events: ToolEvent[] = [];

const fakeModel: ModelWrapper = {
  async getContextInfo() {
    throw new Error('not implemented');
  },
  async complete(_prompt, opts) {
    const fn = opts?.functions?.project_info;
    assert.ok(fn, 'project_info tool should be available');
    const call = () => fn.handler({});
    await call();
    await call();
    await call();
    return JSON.stringify({ final: { plan: [] } });
  },
  async dispose() {}
};

const scan: ScanResult = { root: process.cwd(), files: [] };

const ctx = {
  projectRoot: process.cwd(),
  scan,
  maxSteps: 2,
  onTool: (event: ToolEvent) => {
    events.push(event);
  }
};

await assert.rejects(
  () => runAgent(fakeModel, 'Plan tests for sample file', ctx),
  (error: any) => {
    assert.ok(error instanceof Error, 'Expected an Error');
    assert.match(error.message, /limit/i);
    assert.match(error.message, /project_info/);
    return true;
  }
);

assert.deepEqual(events.map(evt => evt.step), [1, 2]);
assert.strictEqual(events.length, 2);

console.log('✓ tool invocation limit enforced');
