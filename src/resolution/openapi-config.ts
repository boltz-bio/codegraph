import * as path from 'path';
import { logWarn } from '../errors';

/** Explicit service identity and mount evidence; no global path-only matching. */
export interface OpenApiBinding {
  service: string;
  schema: string;
  clients: string[];
  routes: { directory: string; prefix: string }[];
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function relativePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 &&
    !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value) &&
    !value.includes('\\') && !value.split('/').some(p => p === '..' || p === '.' || !p);
}

export function parseOpenApiBindings(value: unknown): OpenApiBinding[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    logWarn('Ignoring "openapi" in codegraph.json: expected an array');
    return [];
  }
  const out: OpenApiBinding[] = [];
  for (const entry of value) {
    if (!record(entry) || typeof entry.service !== 'string' || !entry.service.trim() ||
        !relativePath(entry.schema) || !entry.schema.endsWith('.json') ||
        !Array.isArray(entry.clients) || !entry.clients.length || !entry.clients.every(relativePath) ||
        !Array.isArray(entry.routes) || !entry.routes.length || !entry.routes.every(r =>
          record(r) && relativePath(r.directory) && typeof r.prefix === 'string' &&
          (r.prefix === '' || /^\/(?:[\w.-]+\/?)*$/.test(r.prefix)))) {
      logWarn('Ignoring an openapi binding: specify service, local JSON schema, client files, and route directories/prefixes');
      continue;
    }
    out.push(entry as unknown as OpenApiBinding);
  }
  return out;
}
