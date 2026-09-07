# Temporal activity routing — experimental local extension

This extension gives typed activity calls worker registration evidence in the
existing explore, node, callers, and impact queries. It does not contact Temporal.

Add an explicit deployment binding to the indexed project's `codegraph.json`:

```json
{
  "temporal": [{
    "connection": "jobs-cluster (configured)",
    "namespace": "settings.TEMPORAL_NAMESPACE",
    "taskQueue": "jobs",
    "workflows": ["service/src/jobs.workflow.ts"],
    "workers": [{
      "file": "service/src/worker.ts",
      "factory": "createJobsWorker",
      "mode": "all"
    }]
  }]
}
```

Use exact project-relative file paths. The connection label identifies the
configured deployment; source analysis does not verify the cluster address.
Namespace and task queue must match worker options as a literal, an unambiguous
file-local constant, or the same symbolic configuration expression. Symbols
such as `settings.TEMPORAL_NAMESPACE` do not prove equal environment values.
The binding supplies the workflow's inherited queue and selected worker mode.
Verify these inputs against deployment configuration before relying on a route.

## Supported patterns

- Imported `proxyActivities<typeof activities>({...})`, with a namespace type
  import. Destructured proxies, local aliases, and namespace member calls work.
- An imported `Worker.create({...})` in the named factory, with a namespace
  activity registry. Named exports, aliases, wildcard barrels, and service-local
  TypeScript path aliases resolve to indexed activity functions.
- A narrow options-builder adapter: add `optionsFactory` and
  `registrationFunction` to the worker entry. It recognizes a same-file
  `const workerOptions = await buildWorkerOptions(...)` passed to Worker.create;
  the builder's literal options object; an imported mode selector with literal
  switch returns; and a dynamic registry import assigned to
  `workerOptions.activities` inside `if (registrations.activities)`.
  The registration variable must be named `registrations`. This covers the
  tested Compute worker pattern, not arbitrary JavaScript data flow.
- Configured `all` and `activity` modes can supply activities. `workflow` mode
  cannot. The options-builder adapter also checks the selected source branch.

The activity type export and worker registry must resolve to the same function.
Conflicting destinations yield no link. A recognized proxy call replaces the
ordinary name-based call inference at that site. Edge metadata records the
proxy declaration, queue, namespace, connection label, worker factory, selected
mode, and registry. Edges remain heuristic static evidence.

## Updates and limits

Index and sync replace derived edges. Removing a registered activity removes
its derived call. Source watching refreshes registry and worker edits. With a
Temporal binding present, changes to in-scope `tsconfig*.json` and
`jsconfig*.json` also trigger sync. If an extended config has a different name,
run sync after editing it. Excluded directory trees are not portable watch
targets. Alias resolution reads configuration afresh on each synthesis pass.

Removing the binding removes its derived edges. Rebuild the index to restore
ordinary name-based inferences that this extension previously suppressed.
Unsupported syntax can still receive ordinary upstream name-based links;
only links labelled Temporal carry this extension's evidence.

This slice does not resolve workflow client start/execute wrappers, signals,
queries, child workflows, local activities, worker deployment versions, or
runtime worker availability. Explicit proxy queues that differ from the binding
are unsupported. String templates and complex shadowing are not fully analyzed.
The worker factory must be an indexed named function. Connections, inherited
workflow queues, and selected modes are configuration assumptions, not discoveries.

Use the normal build and native CLI described in
[the OpenAPI experiment](openapi-generated-clients.md). Run the Temporal
integration suite with `npm test -- --project engine __tests__/temporal-integration.test.ts`.
The real comparison covers one Lab activity-to-Compute HTTP flow and one Compute
activity registration across three modes. It measures retrieval evidence and
invalidation, not agent issue-solving success.

Temporal reference semantics:
[proxyActivities](https://typescript.temporal.io/api/namespaces/workflow#proxyactivities)
and [WorkerOptions](https://typescript.temporal.io/api/interfaces/worker.WorkerOptions).
