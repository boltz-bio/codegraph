# OpenAPI generated clients — experimental local extension

This branch connects a generated Hey API SDK function to an indexed server
route. The route connects to its handler. Native explore, callers, and impact
queries can then cross an HTTP service boundary.

Add explicit service mappings to the indexed project's `codegraph.json`:

```json
{
  "include": ["backend/src/sdk/**"],
  "openapi": [
    {
      "service": "jobs-api",
      "schema": "api/openapi.json",
      "clients": ["backend/src/sdk/sdk.gen.ts"],
      "routes": [
        { "directory": "api/src/routes/internal", "prefix": "/api/internal" }
      ]
    }
  ]
}
```

All paths are relative to the indexed project root. Client entries name exact
files. Route entries name directories or exact files. `include` is needed only
when generated source is gitignored. Explicit exclusions still win. No schema
or code is downloaded. A missing, invalid, or unsupported schema yields no
edges for that binding and reports a warning.

Run the normal source build (`npm ci`, then `npm run build`) with Node 22.5–24.
Create a fresh experimental index with `codegraph init <project>` using
this branch's CLI. An existing index can retain unchanged extracted files;
use a separate snapshot with a fresh index when comparing extractor changes.
Run `codegraph explore "caller generatedSdkFunction handler" --path <project>`.
Use `codegraph serve --mcp --path <project>` for an agent connection.

## Evidence and limits

- Requires an OpenAPI 3 JSON document with inline path operations. JSON schema
  references inside request/response types do not affect route matching.
  YAML and referenced Path Item/Operation objects are not supported.
- Recognizes expression-bodied SDK functions bearing the Hey API generated
  marker, with a literal `url` and a known HTTP method.
- Requires matching method and normalized path in the client, contract, and
  one server route. `{id}` and `:id` parameters normalize to the same segment.
  The path alone does not infer service identity.
- Route prefixes are explicit configuration. Verify them against server
  registration code. This experiment does not evaluate nested Fastify plugin
  registration or environment-specific service discovery.
- The Fastify addition covers `fastify.get/post/put/patch/delete/head/options`
  shorthand and named handlers. Object-form `fastify.route({...})`, receiver
  aliases, and arbitrary computed routing remain outside this experiment.
- Identical routes in other configured service directories stay separate.
  Multiple candidates in one service, or conflicting client/service bindings,
  yield no link. No match is chosen by file order.
- Edges are marked heuristic HTTP edges. Metadata records the configured
  service, method, URL, optional operation ID, contract JSON pointer, and route
  registration location. The source route serves as the operation node.
- The mapping describes a configured destination. A caller can override the
  SDK's client, base URL, or URL at runtime. Explore labels this limit explicitly.
  This is a static dependency graph, not a runtime trace.

## Updates and validation

Indexing and each sync atomically replace this extension's edges. Source edits,
route deletion, contract-only edits, and removed configuration cannot leave its
old edges in place. The watcher schedules a sync for explicitly configured
contracts even when the JSON file itself is ignored by source indexing.
Contract parent directories must remain within the watch scope; files under
excluded directory trees are not a portable watch target.

Run `npm test -- --project engine __tests__/openapi-integration.test.ts` for
real parser/SQLite tests of native flow and impact, route and schema changes,
ambiguity, service isolation, idempotence, and live contract watching.

This is a bounded prototype. It has one real monorepo flow validated on macOS
and synthetic integration cases. It has no agent A/B study or Linux/Windows
watcher validation. It does not implement the proposed npm plugin loader.
