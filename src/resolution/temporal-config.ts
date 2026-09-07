import * as path from 'path';
import { logWarn } from '../errors';

/** One explicitly configured deployment scope. Equal queue names across scopes do not imply a connection. */
export interface TemporalBinding {
  connection: string;
  namespace: string;
  taskQueue: string;
  workflows: string[];
  workers: {
    file: string; factory: string; mode: 'all' | 'workflow' | 'activity';
    /** Optional same-file options builder and conditional registration helper. */
    optionsFactory?: string; registrationFunction?: string;
  }[];
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function local(value: unknown): value is string {
  return text(value) && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) &&
    !value.includes('\\') && !value.split('/').some(p => !p || p === '..' || p === '.');
}
export function parseTemporalBindings(value: unknown): TemporalBinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) { logWarn('Ignoring temporal: expected an array'); return []; }
  const out: TemporalBinding[] = [];
  for (const v of value) {
    if (!object(v) || !text(v.connection) || !text(v.namespace) || !text(v.taskQueue) ||
        !Array.isArray(v.workflows) || !v.workflows.every(local) ||
        !Array.isArray(v.workers) || !v.workers.length || !v.workers.every(w =>
          object(w) && local(w.file) && text(w.factory) && ['all', 'workflow', 'activity'].includes(String(w.mode)) &&
          (w.optionsFactory === undefined || text(w.optionsFactory)) &&
          (w.registrationFunction === undefined || text(w.registrationFunction)))) {
      logWarn('Ignoring temporal binding: expected connection, namespace, taskQueue, workflow files, and worker factories/modes');
      continue;
    }
    out.push(v as unknown as TemporalBinding);
  }
  return out;
}
