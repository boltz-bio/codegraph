import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { ToolHandler } from '../src/mcp/tools';
import { clearProjectConfigCache } from '../src/project-config';
import { parseTemporalBindings } from '../src/resolution/temporal-config';

let root: string, cg: CodeGraph;
const binding = { connection: 'cluster-a', namespace: 'lab', taskQueue: 'jobs', workflows: ['workflow.ts'],
  workers: [{ file: 'worker.ts', factory: 'createJobsWorker', mode: 'all' }] };
const workflow = `import { proxyActivities } from '@temporalio/workflow';
import type * as activities from './activities';
const { stopRun } = proxyActivities<typeof activities>({ startToCloseTimeout: '1m' });
export async function pollingWorkflow() { return await stopRun('run-1'); }
`;
const worker = `import { Worker } from '@temporalio/worker';
import * as activities from './registry';
const queue = 'jobs';
export async function createJobsWorker() {
  return Worker.create({ namespace: 'lab', taskQueue: queue, activities, workflowsPath: './workflow' });
}
`;
const registry = `export { stopRun } from './activities';\n`;
function write(file: string, source: string) { fs.writeFileSync(path.join(root, file), source); }
function config(bindings: unknown[] = [binding]) { write('codegraph.json', JSON.stringify({ temporal: bindings })); clearProjectConfigCache(); }
async function setup(extra?: () => void) {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-temporal-'));
  write('package.json', JSON.stringify({ dependencies: { '@temporalio/worker': '1', '@temporalio/workflow': '1' } }));
  write('workflow.ts', workflow); write('worker.ts', worker); write('registry.ts', registry);
  write('activities.ts', `export async function stopRun(id: string) { return id; }\n`);
  config(); extra?.(); cg = await CodeGraph.init(root, { index: true });
}
function node(name: string) { const n = cg.getNodesByName(name).find(n => n.kind === 'function'); if (!n) throw new Error(name); return n; }
function outgoing() { return cg.getCallees(node('pollingWorkflow').id).filter(c => c.node.name === 'stopRun'); }
beforeAll(async () => { await initGrammars(); await loadAllGrammars(); });
afterEach(() => { cg?.close(); if (root) fs.rmSync(root, { recursive: true, force: true }); });

describe('Temporal routing evidence', () => {
  it('replaces the name guess with typed proxy, queue, and real registry evidence in native tools', async () => {
    await setup();
    expect(outgoing()).toHaveLength(1);
    expect(outgoing()[0]?.edge.metadata).toMatchObject({ synthesizedBy: 'temporal-activity', taskQueue: 'jobs', namespace: 'lab' });
    const r = await new ToolHandler(cg).execute('codegraph_explore', { query: 'pollingWorkflow stopRun' });
    const text = r.content.map(c => c.type === 'text' ? c.text : '').join('\n');
    expect(text).toContain('Temporal activity stopRun'); expect(text).toContain('worker=createJobsWorker');
    const impact = cg.getImpactRadius(node('stopRun').id, 2);
    expect([...impact.nodes.values()].map(n => n.name)).toContain('pollingWorkflow');
  });
  it('removes stale calls when activity registration is removed, including ordinary name guesses', async () => {
    await setup(); write('registry.ts', 'export {};'); await cg.sync(); expect(outgoing()).toHaveLength(0);
    write('registry.ts', registry); await cg.sync(); expect(outgoing()).toHaveLength(1);
  });
  it('rejects wrong worker namespace, queue, and workflow-only mode', async () => {
    await setup();
    for (const source of [worker.replace("'lab'", "'other'"), worker.replace("'jobs'", "'other'"), worker.replace('activities, workflowsPath', 'workflowsPath')]) {
      write('worker.ts', source); await cg.sync(); expect(outgoing()).toHaveLength(0);
      write('worker.ts', worker); await cg.sync(); expect(outgoing()).toHaveLength(1);
    }
    config([{ ...binding, workers: [{ ...binding.workers[0], mode: 'workflow' }] }]); await cg.sync(); expect(outgoing()).toHaveLength(0);
    config([{ ...binding, workers: [{ ...binding.workers[0], mode: 'activity' }] }]); await cg.sync(); expect(outgoing()).toHaveLength(1);
  });
  it('rejects explicit different/dynamic proxy queues and disabled remote activity polling', async () => {
    await setup();
    for (const queue of ["'other'", 'input.queue']) {
      write('workflow.ts', workflow.replace("startToCloseTimeout: '1m'", "startToCloseTimeout: '1m', taskQueue: " + queue));
      await cg.sync(); expect(outgoing()).toHaveLength(0);
    }
    write('workflow.ts', workflow); write('worker.ts', worker.replace('activities, workflowsPath', 'activities, enableNonLocalActivities: false, workflowsPath'));
    await cg.sync(); expect(outgoing()).toHaveLength(0);
  });
  it('does not conflate identical names or queues in another service or connection', async () => {
    await setup(() => write('other.ts', `export async function stopRun() { return 'other'; }`));
    expect(outgoing()[0]?.node.filePath).toBe('activities.ts');
    write('registry.ts', `export { stopRun } from './other';`); await cg.sync(); expect(outgoing()).toHaveLength(0);
    write('registry.ts', registry); config([binding, { ...binding, connection: 'cluster-b' }]);
    await cg.sync(); expect(outgoing()).toHaveLength(0);
  });
  it('resolves named export aliases and namespace-style proxies', async () => {
    await setup(() => {
      write('activities.ts', `export async function actualStop(id: string) { return id; }`);
      write('public.ts', `export { actualStop as stopRun } from './activities';`);
      write('registry.ts', `export { stopRun } from './public';`);
      write('workflow.ts', workflow.replace("'./activities'", "'./public'").replace('const { stopRun }', 'const tasks').replace("await stopRun(", "await tasks.stopRun("));
    });
    expect(cg.getCallees(node('pollingWorkflow').id).some(c => c.node.name === 'actualStop' && c.edge.metadata?.synthesizedBy === 'temporal-activity')).toBe(true);
  });
  it('is stable after sync/reopen, worker deletion, and configuration removal', async () => {
    await setup(); await cg.sync(); expect(outgoing()).toHaveLength(1);
    cg.close(); cg = CodeGraph.openSync(root); await cg.sync(); expect(outgoing()).toHaveLength(1);
    fs.unlinkSync(path.join(root, 'worker.ts')); await cg.sync(); expect(outgoing()).toHaveLength(0);
    write('worker.ts', worker); await cg.sync(); expect(outgoing()).toHaveLength(1);
    config([]); await cg.sync(); expect(outgoing()).toHaveLength(0);
  });
  it('watches registry-only changes', async () => {
    await setup(); expect(cg.watch({ debounceMs: 50 })).toBe(true); await cg.waitUntilWatcherReady();
    write('registry.ts', 'export {};'); await expect.poll(() => outgoing().length, { timeout: 10000 }).toBe(0);
    write('registry.ts', registry); await expect.poll(() => outgoing().length, { timeout: 10000 }).toBe(1);
  }, 25000);
  it('leaves non-Temporal same-named calls alone', async () => {
    await setup(() => write('other.ts', `import { stopRun } from './activities';\nexport function localCall() { return stopRun('x'); }`));
    write('registry.ts', 'export {};'); await cg.sync(); expect(outgoing()).toHaveLength(0);
    expect(cg.getCallees(node('localCall').id).some(c => c.node.name === 'stopRun')).toBe(true);
  });
  it('uses each service tsconfig and refreshes routing after an alias changes', async () => {
    await setup(() => {
      for (const service of ['one', 'two']) {
        fs.mkdirSync(path.join(root, service, 'src'), { recursive: true });
        write(service + '/tsconfig.json', JSON.stringify({ compilerOptions: { paths: { 'src/*': ['./src/*'] } } }));
        write(service + '/src/activities.ts', `export async function stopRun() { return '${service}'; }`);
      }
      write('one/src/workflow.ts', workflow.replace("'./activities'", "'src/activities'"));
      write('one/src/worker.ts', worker.replace("'./registry'", "'src/registry'"));
      write('one/src/registry.ts', registry.replace("'./activities'", "'src/activities'"));
      fs.unlinkSync(path.join(root, 'workflow.ts'));
      config([{ ...binding, workflows: ['one/src/workflow.ts'], workers: [{ ...binding.workers[0], file: 'one/src/worker.ts' }] }]);
    });
    expect(outgoing()).toHaveLength(1); expect(outgoing()[0]?.node.filePath).toBe('one/src/activities.ts');
    expect(cg.watch({ debounceMs: 50 })).toBe(true); await cg.waitUntilWatcherReady();
    write('one/tsconfig.json', JSON.stringify({ compilerOptions: { paths: { 'src/*': ['./missing/*'] } } }));
    await expect.poll(() => outgoing().length, { timeout: 10000 }).toBe(0);
    write('one/tsconfig.json', JSON.stringify({ compilerOptions: { paths: { 'src/*': ['./src/*'] } } }));
    await expect.poll(() => outgoing().length, { timeout: 10000 }).toBe(1);
  }, 25000);
  it('does not turn string examples or shadowed parameters into Temporal calls', async () => {
    await setup(() => write('workflow.ts', workflow + `
export function example() { return "stopRun('example')"; }
export function shadow(stopRun: () => void) { return stopRun(); }
`));
    for (const name of ['example', 'shadow']) {
      expect(cg.getCallees(node(name).id).some(c => c.edge.metadata?.synthesizedBy === 'temporal-activity')).toBe(false);
    }
  });
  it('follows an options builder and the actual mode selector before loading a dynamic registry', async () => {
    const selector = `export function selectMode(mode) {
      switch (mode) {
        case 'all': return { workflows: true, activities: true };
        case 'workflow': return { workflows: true, activities: false };
        case 'activity': return { workflows: false, activities: true };
      }
    }`;
    const built = `import { Worker } from '@temporalio/worker';
import { selectMode } from './modes';
export async function createJobsWorker() {
  const registrations = selectMode(settings.mode);
  const workerOptions = await buildOptions({ registrations });
  return Worker.create(workerOptions);
}
async function buildOptions({ registrations }) {
  const workerOptions: WorkerOptions = { taskQueue: 'jobs', namespace: 'lab' };
  await applyRegistrations(workerOptions, registrations);
  return workerOptions;
}
async function applyRegistrations(workerOptions, registrations) {
  if (registrations.activities) {
    const activities = await import('./registry');
    workerOptions.activities = activities;
  }
}`;
    const spec = { ...binding.workers[0], optionsFactory: 'buildOptions', registrationFunction: 'applyRegistrations' };
    await setup(() => { write('worker.ts', built); write('modes.ts', selector); config([{ ...binding, workers: [spec] }]); });
    expect(outgoing()).toHaveLength(1);
    config([{ ...binding, workers: [{ ...spec, mode: 'activity' }] }]); await cg.sync(); expect(outgoing()).toHaveLength(1);
    config([{ ...binding, workers: [{ ...spec, mode: 'workflow' }] }]); await cg.sync(); expect(outgoing()).toHaveLength(0);
    config([{ ...binding, workers: [{ ...spec, mode: 'activity' }] }]); await cg.sync(); expect(outgoing()).toHaveLength(1);
    write('modes.ts', selector.replace("case 'activity': return { workflows: false, activities: true }", "case 'activity': return { workflows: false, activities: false }"));
    await cg.sync(); expect(outgoing()).toHaveLength(0);
  });
});

describe('Temporal binding validation', () => {
  it('rejects missing scope and non-local paths', () => {
    expect(parseTemporalBindings([{ ...binding, connection: '' }, { ...binding, workflows: ['../workflow.ts'] }])).toEqual([]);
  });
});
