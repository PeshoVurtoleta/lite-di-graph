# Changelog

All notable changes to `@zakkster/lite-di-graph` are documented here. The format
follows Keep a Changelog; the project uses semantic versioning. The version is
synced in three places at once: `package.json`, the `VERSION` const in
`DIGraph.js`, and this file's top entry.

## [1.0.0] - 2026-08-11

Promotion to stable. The public surface is frozen exactly as shipped at
`1.0.0-alpha.1` -- `nodeKind`, `KIND_NAMES`, `fromContainer`, `toJSON`, `toDOT`,
`toChromeTrace`, `VERSION` -- with ONE behavior correction (below) that brings
`toJSON` into line with its already-documented fail-closed contract before the API
freezes. No exports added or removed.

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

### Changed
- The retention gate is now a real finalization residual, not a `size() === 0`
  tautology. The 10,000-cycle build/format/discard soak previously did `track()` then
  `untrack()` and asserted `size() === 0`; it now tracks each `describe()` snapshot
  WITHOUT untracking, settles hard, and asserts the finalization residual
  `size() <= 16`. `DI_TORTURE_BREAK` pins the snapshot so the residual trips the gate
  DIRECTLY (~10,000), not merely a heap backstop. Clean residual is 0/16. Behavior
  unchanged -- this is the gate that now PROVES leak-freedom.

### Proven
- Downstream consumer: `examples/export-graph.mjs`, a self-verifying app that boots a
  real container with ONE of every registration kind (value / singleton / transient /
  factory / alias, wired with real deps -> real resolve edges), snapshots it via
  `fromContainer`, renders all three exporters plus `nodeKind` / `KIND_NAMES` /
  `VERSION`, and asserts round-trip determinism (endpoint content + byte-identical
  re-serialize), the integer -> label mapping, and the fail-closed throws (a dangling
  edge routed through every exporter). Every contract asserted with `node:assert`;
  `npm run example` is a hard gate folded into `verify` / `prepublishOnly`.
- `node --expose-gc test/torture.mjs`: a formatter ALLOCATES per call by construction,
  so this is NOT a 0 B/op path and never claims one; the gate is that
  build/format/discard cycles retain nothing (finalization residual 0/16), the heap
  stays bounded, and no MAJOR GC fires (`@zakkster/lite-gc-profiler`, `maxMajor: 0`).
  The container's own `describe()` / `get()` are untouched. All three break switches
  (`DI_ASCII_BREAK`, `DI_ALLOC_BREAK`, `DI_TORTURE_BREAK`) force a non-zero exit.
- `node:test`: 53/53 pass, including a fail-closed case per exporter and the new
  dangling-edge cases in both the behavior and boundary suites.

### API frozen at 1.0.0
The public surface is exactly `nodeKind`, `KIND_NAMES`, `fromContainer`, `toJSON`,
`toDOT`, `toChromeTrace`, and `VERSION`. No default export. Deliberately NOT included
-- any would be a post-1.0.0 (1.1) change, never a 1.0.x slip:
- NOT a runtime tracer (per-resolve timings, spans) -- that is lite-trace.
- NOT a validator (cycles, missing deps) -- `boot()` already validated; a snapshot
  cannot exist for an invalid graph.
- NOT the container -- `@zakkster/lite-di-container` (>= 2.1.0) is a PEER dependency.
- No additional export formats and no mutation surface -- every exporter is PURE over
  its snapshot argument, and referential integrity is now enforced uniformly across
  all three.

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

[1.0.0]: https://www.npmjs.com/package/@zakkster/lite-di-graph
[1.0.0-alpha.1]: https://www.npmjs.com/package/@zakkster/lite-di-graph
