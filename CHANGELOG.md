# Changelog

All notable changes to `@zakkster/lite-di-graph` are documented here. The format
follows Keep a Changelog; the project uses semantic versioning. The version is
synced in three places at once: `package.json`, the `VERSION` const in
`DIGraph.js`, and this file's top entry.

## [Unreleased]

### Fixed
- `toJSON` now fails closed on a DANGLING edge (a `from`/`to` referencing a token
  absent from `nodes`), throwing the same `malformed snapshot -- edge[i] <field>
  references a token absent from nodes` error that `toDOT`/`toChromeTrace` already
  threw. Previously `toJSON` emitted such an edge silently, contradicting the
  documented "checked per exporter" fail-closed contract (llms.txt, README) and
  producing round-trippable JSON that the sibling exporters would then reject.
  Referential integrity is now enforced UNIFORMLY across all three exporters via
  the shared `resolveNodeId` guard. Behavior change: code that previously received
  JSON from a dangling snapshot now throws -- toward already-documented behavior.
  A `node:test` case asserting `toJSON` throws on a dangling `from` and a dangling
  `to` closes the coverage gap (the prior suite asserted the lenient behavior).

## [1.0.0-alpha.1] - 2026-08-09

First scoped release: a read-only legibility surface over the
`@zakkster/lite-di-container` (>=2.1.0) `describe()` snapshot. Pure over the
snapshot, fail-closed on a malformed shape.

### Added
- `fromContainer(container)` -- the one container-aware convenience; calls the
  container's PUBLIC `describe()` so a caller can write `toDOT(fromContainer(c))`.
  Fails closed if handed anything without a `describe` method (a container older
  than 2.1.0, or a non-container).
- `toJSON(snapshot)` -- deterministic, round-trippable JSON. `JSON.parse` yields
  the same node count, same edges, same order. Each node emits its integer `kind`
  and a derived `kindName`; opaque nodes carry `opaqueDeps: true`; ALIAS nodes
  carry `target`. Serializing the same snapshot twice is byte-identical.
- `toDOT(snapshot)` -- a Graphviz `digraph`; nodes labelled token + kind name,
  FACTORY nodes labelled "deps opaque", ALIAS nodes labelled "-> target". All
  dynamic node/label text is DOT-escaped.
- `toChromeTrace(snapshot)` -- a `{ traceEvents, displayTimeUnit }` JSON document
  for chrome://tracing / ui.perfetto.dev. A DOCUMENTED minimal mapping (a DI
  graph has no wall clock): each node is a complete ('X') event on a synthetic
  timeline, each edge a matched flow pair ('s'/'f'). Not a real timeline trace.
- `nodeKind(kind)` and the frozen `KIND_NAMES` table -- the single source of
  truth for the TYPES integer -> label mapping (VALUE:0, SINGLETON:1,
  TRANSIENT:2, FACTORY:3, ALIAS:4).
- `VERSION` -- the three-place-synced version string.

### Fail-closed contract
- Every exporter validates its snapshot: `nodes`/`edges`/`order` must each be an
  array, and every node must carry a `token` and an integer `kind` in range. A
  renamed or missing array throws a clear, named TypeError -- never a half-valid
  document or a silent coercion.
- `nodeKind` throws on any tag outside 0..4 rather than returning an "unknown"
  placeholder a consumer might trust.
- Factory (and value) deps are structurally opaque: those nodes carry
  `opaqueDeps: true` so a consumer reads "deps unknown", never "no deps".

### Proven
- `node --expose-gc --test test/*.test.js`: 17 behavioural cases, including a
  fail-closed case per exporter (malformed snapshot throws).
- `node --expose-gc test/torture.mjs`: leak-free and bounded. A formatter
  allocates strings by construction, so this is NOT a 0 B/op path; the gate is
  that build/format/discard cycles retain nothing (lite-leak size 0), the heap
  stays bounded, and no MAJOR GC fires (`@zakkster/lite-gc-profiler`,
  `maxMajor: 0`). The container's own `describe()`/`get()` are untouched.
- ASCII-only source; zero runtime dependencies (the container is a peer
  dependency, not bundled).

[Unreleased]: https://www.npmjs.com/package/@zakkster/lite-di-graph
[1.0.0-alpha.1]: https://www.npmjs.com/package/@zakkster/lite-di-graph
