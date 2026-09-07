# Boltz CodeGraph distribution

This fork adds opt-in OpenAPI generated-client and Temporal activity routing
extensions to upstream commit b9ca4b7981116909900368cc1686a1074cd4d4c1.

- [OpenAPI extension](docs/openapi-generated-clients.md): generated Hey API
  client to OpenAPI operation to Fastify route and handler.
- [Temporal activity extension](docs/temporal-activities.md): typed activity
  proxies to actual worker registrations, with configured queue and mode evidence.

The extensions use internal CodeGraph APIs. They are not npm plugins. Project
paths and deployment bindings belong in the consuming repository's codegraph.json.
These links describe static configured dependencies, not observed runtime traffic.

The boltz branch is the maintained distribution branch. Keep main as the
upstream baseline. Pin consumers to an exact Boltz release. To release, update
package.json and package-lock.json together, then run the Boltz release workflow
on the reviewed commit. It tests and builds macOS/Linux ARM64 and x64 bundles
with the native kernel and Node v24.16.0, and publishes GitHub assets and SHA256SUMS.
The Intel macOS archive is cross-built; the other three archive launchers are
executed on their matching runners. No package is published to upstream npm.

Install the bundles with Mise's github:boltz-bio/codegraph backend. The bin/
launcher uses its adjacent runtime and libraries; keep the complete archive.
Only supported syntax receives extension evidence. General Temporal client
launch, signals, child workflows, and dynamic deployment discovery remain outside
this version's scope.
