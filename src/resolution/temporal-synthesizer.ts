/** Typed Temporal proxies, scoped to actual worker activity exports. Never contacts Temporal. */
import type { Edge, Node } from '../types';
import * as path from 'path';
import * as fs from 'fs';
import type { ResolutionContext } from './types';
import type { MaybeYield } from './cooperative-yield';
import { loadTemporalBindings } from '../project-config';
import { resolveImportPath } from './import-resolver';
import { applyAliases, loadProjectAliases } from './path-aliases';
import { stripCommentsForRegex } from './strip-comments';
import { matchBracket, readFields, skipString } from './frameworks/object-literal';
import { enclosingFn, makeLineAt } from './synth-utils';

export const TEMPORAL_SYNTHESIZER = 'temporal-activity';
export interface TemporalClaim { source: string; line: number; name: string }

function split(s: string): string[] {
  const parts: string[] = []; let start = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if ('\"\'`'.includes(ch)) { const end = skipString(s, i); if (end < 0) return []; i = end; }
    else if ('({['.includes(ch)) { const end = matchBracket(s, i); if (end < 0) return []; i = end; }
    else if (ch === ',') { parts.push(s.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(s.slice(start).trim()); return parts.filter(Boolean);
}

function fields(s: string, start: number, end: number): Map<string, string> {
  const result = new Map([...readFields(s, start, end)].map(([key, value]) => [key, value.text.trim()]));
  for (const part of split(s.slice(start + 1, end))) if (/^[\w$]+$/.test(part)) result.set(part, part);
  return result;
}

function literal(s: string): string | null {
  const match = /^(['"])([^'"\\]*)\1$/.exec(s.trim()); return match?.[2] ?? null;
}

function escapeRegex(s: string): string { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Keep offsets stable while excluding string examples from call-site matching. */
function maskStrings(source: string): string {
  const chars = source.split('');
  for (let i = 0; i < source.length; i++) {
    if (!'\"\'`'.includes(source[i]!)) continue;
    const end = skipString(source, i); if (end < 0) break;
    for (let j = i; j <= end; j++) if (chars[j] !== '\n') chars[j] = ' ';
    i = end;
  }
  return chars.join('');
}

/** Resolve an expression only when it is literal, or one unambiguous file-local literal constant. */
function value(expr: string | undefined, source: string, depth = 0): string | null {
  if (!expr) return null;
  if (depth > 3) return null;
  const direct = literal(expr); if (direct !== null) return direct;
  if (/^[\w$]+$/.test(expr)) {
    const values = [...source.matchAll(new RegExp('\\bconst\\s+' + escapeRegex(expr) + '\\s*=\\s*([^;\\n]+)', 'g'))].map(m => m[1]!.trim());
    if (values.length === 1) return value(values[0], source, depth + 1);
  }
  // An environment/config expression remains symbolic. Bindings must use that same expression.
  return /^[\w$]+(?:\.[\w$]+)+$/.test(expr) ? expr : null;
}

/** Service-local tsconfig aliases take precedence over the monorepo root. */
function resolveModule(ctx: ResolutionContext, file: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) {
    const root = ctx.getProjectRoot();
    for (let dir = path.dirname(file);; dir = path.dirname(dir)) {
      const absolute = path.join(root, dir);
      if (['tsconfig.json', 'jsconfig.json', 'tsconfig.base.json'].some(name => fs.existsSync(path.join(absolute, name)))) {
        const aliases = loadProjectAliases(absolute);
        const candidates = aliases ? applyAliases(specifier, aliases, root) : [];
        if (candidates.length) {
          for (const candidate of candidates) {
            for (const suffix of ['', '.ts', '.tsx', '.js', '.mts', '.cts', '/index.ts', '/index.tsx', '/index.js']) {
              const resolved = (candidate + suffix).replace(/\\/g, '/');
              if (ctx.fileExists(resolved)) return resolved;
            }
          }
          return null;
        }
        break;
      }
      if (dir === '.') break;
    }
  }
  return resolveImportPath(specifier, file, 'typescript', ctx);
}

function moduleFor(ctx: ResolutionContext, file: string, name: string): string | null {
  const imports = ctx.getImportMappings(file, 'typescript').filter(m => m.localName === name && m.isNamespace);
  return imports.length === 1 ? resolveModule(ctx, file, imports[0]!.source) : null;
}

/** Narrow adapter for same-file option builders and mode-gated dynamic registry imports. */
function builtOptions(ctx: ResolutionContext, file: string, source: string, factoryBody: string,
  variable: string, optionsFactory: string, registrationFunction: string, mode: string): { options: Map<string, string>; registry: string } | null {
  const bodyOf = (name: string): string | null => {
    const nodes = ctx.getNodesInFile(file).filter(n => n.kind === 'function' && n.name === name);
    return nodes.length === 1 ? source.split('\n').slice(nodes[0]!.startLine - 1, nodes[0]!.endLine).join('\n') : null;
  };
  if (!new RegExp('\\bconst\\s+' + escapeRegex(variable) + '\\s*=\\s*await\\s+' + escapeRegex(optionsFactory) + '\\s*\\(').test(factoryBody)) return null;
  const optionsBody = bodyOf(optionsFactory), registrationBody = bodyOf(registrationFunction);
  if (!optionsBody || !registrationBody || !new RegExp('\\b' + escapeRegex(registrationFunction) + '\\s*\\(\\s*' + escapeRegex(variable) + '\\s*,\\s*registrations\\s*\\)').test(optionsBody)) return null;
  const object = new RegExp('\\bconst\\s+' + escapeRegex(variable) + '(?:\\s*:\\s*[\\w$]+)?\\s*=\\s*\\{').exec(optionsBody);
  if (!object || !new RegExp('\\breturn\\s+' + escapeRegex(variable) + '\\b').test(optionsBody)) return null;
  const open = object.index + object[0].length - 1, close = matchBracket(optionsBody, open);
  if (close < 0) return null;
  // Follow the imported mode selector, then read the selected literal return.
  const selector = /\bconst\s+registrations\s*=\s*([\w$]+)\s*\(/.exec(factoryBody);
  const selectorImport = selector && ctx.getImportMappings(file, 'typescript').find(m => m.localName === selector[1]);
  const selectorFile = selectorImport && resolveModule(ctx, file, selectorImport.source);
  if (!selectorImport || !selectorFile) return null;
  const selectorNodes = ctx.getNodesInFile(selectorFile).filter(n => n.kind === 'function' && n.name === selectorImport.exportedName);
  if (selectorNodes.length !== 1) return null;
  const selectorSource = stripCommentsForRegex(ctx.readFile(selectorFile) ?? '', 'typescript').split('\n')
    .slice(selectorNodes[0]!.startLine - 1, selectorNodes[0]!.endLine).join('\n');
  const selected = new RegExp('case\\s+[\'\"]' + mode + '[\'\"]\\s*:\\s*return\\s*\\{([^}]+)\\}').exec(selectorSource);
  if (!selected || !/\bactivities\s*:\s*true\b/.test(selected[1]!)) return null;
  const gate = /if\s*\(\s*registrations\.activities\s*\)\s*\{/.exec(registrationBody);
  if (!gate) return null;
  const gateOpen = gate.index + gate[0].length - 1, gateClose = matchBracket(registrationBody, gateOpen);
  if (gateClose < 0) return null;
  const block = registrationBody.slice(gateOpen + 1, gateClose);
  const load = /\bconst\s+([\w$]+)\s*=\s*await\s+import\s*\(\s*(['"])([^'"]+)\2\s*\)/.exec(block);
  if (!load || !new RegExp('\\b' + escapeRegex(variable) + '\\.activities\\s*=\\s*' + escapeRegex(load[1]!) + '\\b').test(block)) return null;
  const registry = resolveModule(ctx, file, load[3]!);
  return registry ? { options: fields(optionsBody, open, close), registry } : null;
}

/** Follow real exports, including named aliases and wildcard barrels; do not search globally by name. */
function exported(ctx: ResolutionContext, file: string, name: string, seen = new Set<string>()): Node[] {
  const key = file + ':' + name;
  if (seen.has(key) || seen.size > 100) return []; seen.add(key);
  const direct = ctx.getNodesInFile(file).filter(n => n.kind === 'function' && n.name === name && n.isExported);
  const found = new Map(direct.map(n => [n.id, n]));
  for (const exp of ctx.getReExports?.(file, 'typescript') ?? []) {
    if (exp.kind === 'named' && exp.exportedName !== name) continue;
    const target = resolveModule(ctx, file, exp.source); if (!target) continue;
    for (const n of exported(ctx, target, exp.kind === 'named' ? exp.originalName : name, new Set(seen))) found.set(n.id, n);
  }
  return [...found.values()];
}

interface Worker { node: Node; registry: string; mode: string; connection: string; namespace: string; queue: string }

export async function temporalEdges(ctx: ResolutionContext, onYield: MaybeYield): Promise<{ edges: Edge[]; claims: TemporalClaim[] }> {
  const bindings = loadTemporalBindings(ctx.getProjectRoot());
  const claims = new Map<string, TemporalClaim>();
  const candidates = new Map<string, Map<string, Edge>>();
  for (const binding of bindings) {
    const workers: Worker[] = [];
    for (const spec of binding.workers) {
      if (spec.mode === 'workflow') continue;
      const source = stripCommentsForRegex(ctx.readFile(spec.file) ?? '', 'typescript');
      const factories = ctx.getNodesInFile(spec.file).filter(n => n.kind === 'function' && n.name === spec.factory);
      if (factories.length !== 1) continue;
      const factory = factories[0]!;
      const body = source.split('\n').slice(factory.startLine - 1, factory.endLine).join('\n');
      const workerImport = ctx.getImportMappings(spec.file, 'typescript').find(m => m.source === '@temporalio/worker' && m.exportedName === 'Worker');
      if (!workerImport) continue;
      const call = new RegExp('\\b' + escapeRegex(workerImport.localName) + '\\.create\\s*\\(\\s*(\\{|[\\w$]+\\s*\\))').exec(body);
      if (!call) continue;
      let options: Map<string, string>, registry: string | null;
      if (call[1] === '{') {
        const open = call.index + call[0].length - 1, close = matchBracket(body, open);
        if (close < 0) continue;
        options = fields(body, open, close);
        registry = moduleFor(ctx, spec.file, options.get('activities') ?? '');
      } else {
        if (!spec.optionsFactory || !spec.registrationFunction) continue;
        const built = builtOptions(ctx, spec.file, source, body, call[1]!.replace(/\s*\)$/, ''), spec.optionsFactory, spec.registrationFunction, spec.mode);
        if (!built) continue;
        options = built.options; registry = built.registry;
      }
      if (!registry || value(options.get('taskQueue'), source) !== binding.taskQueue ||
          value(options.get('namespace'), source) !== binding.namespace || options.get('enableNonLocalActivities') === 'false') continue;
      workers.push({ node: factory, registry, mode: spec.mode, connection: binding.connection, namespace: binding.namespace, queue: binding.taskQueue });
    }
    for (const file of binding.workflows) {
      await onYield();
      const source = stripCommentsForRegex(ctx.readFile(file) ?? '', 'typescript');
      const callSource = maskStrings(source);
      const proxyImport = ctx.getImportMappings(file, 'typescript').find(m => m.source === '@temporalio/workflow' && m.exportedName === 'proxyActivities');
      if (!proxyImport) continue;
      const nodes = ctx.getNodesInFile(file), lineAt = makeLineAt(source, 1);
      const proxy = new RegExp('\\bconst\\s+(\\{[^}]+\\}|[\\w$]+)\\s*=\\s*' + proxyImport.localName + '\\s*<\\s*typeof\\s+([\\w$]+)\\s*>\\s*\\(\\s*\\{', 'g');
      for (const match of source.matchAll(proxy)) {
        const open = match.index! + match[0].length - 1, close = matchBracket(source, open);
        if (close < 0) continue;
        const activityModule = moduleFor(ctx, file, match[2]!); if (!activityModule) continue;
        const options = fields(source, open, close);
        const queue = options.has('taskQueue') ? value(options.get('taskQueue'), source) : binding.taskQueue;
        const names: { local: string; exported: string }[] = [];
        if (match[1]!.startsWith('{')) {
          for (const entry of split(match[1]!.slice(1, -1))) {
            const pair = /^([\w$]+)(?:\s*:\s*([\w$]+))?$/.exec(entry);
            if (pair) names.push({ local: pair[2] ?? pair[1]!, exported: pair[1]! });
          }
        } else {
          const uses = new RegExp('\\b' + escapeRegex(match[1]!) + '\\.([\\w$]+)\\s*\\(', 'g');
          for (const use of callSource.matchAll(uses)) names.push({ local: match[1] + '.' + use[1], exported: use[1]! });
        }
        for (const name of names) {
          const targets = exported(ctx, activityModule, name.exported);
          const callRe = new RegExp('(?<![\\w$.])' + escapeRegex(name.local) + '\\s*\\(', 'g');
          for (const site of callSource.matchAll(callRe)) {
            const line = lineAt(site.index!); const from = enclosingFn(nodes, line); if (!from) continue;
            const rootName = escapeRegex(name.local.split('.')[0]!);
            const functionText = source.split('\n').slice(from.startLine - 1, from.endLine).join('\n');
            if (new RegExp('\\b' + rootName + '\\s*[:),=]').test(from.signature ?? '') ||
                new RegExp('\\b(?:const|let|var)\\s+' + rootName + '\\b').test(functionText)) continue;
            // A same-file callable declaration shadows the proxy. Leave it to ordinary resolution.
            if (nodes.some(n => n.kind === 'function' && n.name === name.local && n.id !== from.id)) continue;
            const claim = { source: from.id, line, name: name.local };
            const key = `${from.id}:${line}:${name.local}`; claims.set(key, claim);
            if (targets.length !== 1 || queue !== binding.taskQueue) continue;
            const target = targets[0]!;
            const eligible = workers.filter(w => {
              const registered = exported(ctx, w.registry, name.exported);
              return registered.length === 1 && registered[0]!.id === target.id;
            });
            if (!eligible.length) continue;
            const choices = candidates.get(key) ?? new Map<string, Edge>();
            const identity = `${binding.connection}:${binding.namespace}:${queue}:${target.id}`;
            choices.set(identity, {
              source: from.id, target: target.id, kind: 'calls', line, provenance: 'heuristic',
              metadata: {
                synthesizedBy: TEMPORAL_SYNTHESIZER, channel: 'temporal', activity: name.exported,
                connection: binding.connection, namespace: binding.namespace, taskQueue: queue,
                proxyAt: `${file}:${lineAt(match.index!)}`,
                registeredAt: `${eligible[0]!.node.filePath}:${eligible[0]!.node.startLine}`,
                workers: eligible.map(w => ({ name: w.node.name, file: w.node.filePath, line: w.node.startLine, mode: w.mode, registry: w.registry })),
                evidence: 'configured-deployment+typed-proxy+Worker.create+registry-export',
              },
            });
            candidates.set(key, choices);
          }
        }
      }
    }
  }
  const edges = [...candidates.values()].filter(c => c.size === 1).map(c => [...c.values()][0]!);
  return { edges, claims: [...claims.values()] };
}
