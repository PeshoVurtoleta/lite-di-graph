# @zakkster/lite-di-graph

> Read-only formatters/exporters over a `@zakkster/lite-di-container` `describe()` snapshot: JSON, Graphviz DOT, and Chrome Trace Event Format. PURE over the snapshot, fail-closed on a malformed shape.

[![npm version](https://img.shields.io/npm/v/@zakkster/lite-di-graph.svg?style=for-the-badge&color=latest)](https://www.npmjs.com/package/@zakkster/lite-di-graph)
[![sponsor](https://img.shields.io/badge/sponsor-PeshoVurtoleta-ea4aaa.svg?logo=github)](https://github.com/sponsors/PeshoVurtoleta)
![Fail-Closed](https://img.shields.io/badge/fail--closed-yes-00C853?style=for-the-badge&logo=leaf&logoColor=white)
[![npm bundle size](https://img.shields.io/bundlephobia/minzip/@zakkster/lite-di-graph?style=for-the-badge)](https://bundlephobia.com/result?p=@zakkster/lite-di-graph)
[![npm downloads](https://img.shields.io/npm/dm/@zakkster/lite-di-graph?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-di-graph)
[![npm total downloads](https://img.shields.io/npm/dt/@zakkster/lite-di-graph?style=for-the-badge&color=blue)](https://www.npmjs.com/package/@zakkster/lite-di-graph)
![Tree-Shakeable](https://img.shields.io/badge/tree--shakeable-yes-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-Types-informational)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
[![license](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

## The graph exporter the DI ecosystem was missing

`@zakkster/lite-di-container` builds, wires, and tears down your object graph, and
since v2.1.0 it can hand you a `describe()` snapshot of that graph:
`{ nodes, edges, order }`. What it did not have was a way to SEE it -- to render
the snapshot as a Graphviz diagram, a round-trippable JSON document, or a Perfetto
trace. The container should not carry three serializers; that is a separate,
read-only concern.

`lite-di-graph` is that concern. It is a pure formatter: hand it a snapshot (or a
booted container via `fromContainer`) and it returns a string. It never touches
container private state, and every exporter fails CLOSED on a malformed snapshot
rather than emitting half-valid output.

```bash
npm install @zakkster/lite-di-graph
```

Peer dependency (not bundled, install it alongside):

```bash
npm install @zakkster/lite-di-container
```

```javascript
import { Container } from '@zakkster/lite-di-container';
import { fromContainer, toDOT } from '@zakkster/lite-di-graph';

const c = new Container();
c.value('cfg', { tag: 'T' });
c.singleton('svc', class { constructor(cfg) { this.cfg = cfg; } }, ['cfg']);
c.boot();

const dot = toDOT(fromContainer(c));   // a Graphviz `digraph` string
// pipe `dot` to `dot -Tsvg` to render the dependency graph
```

---

## Table of contents

- [Why this exists](#why-this-exists)
- [What you get](#what-you-get)
- [API reference](#api-reference)
  - [Functions](#functions)
  - [Kinds](#kinds)
  - [Constants](#constants)
- [Composability with the container](#composability-with-the-container)
- [Zero-GC design notes](#zero-gc-design-notes)
- [Design decisions worth knowing](#design-decisions-worth-knowing)
- [Testing](#testing)
- [What this is not](#what-this-is-not)
- [Ecosystem](#ecosystem)
- [License](#license)

## Why this exists

The container validates and wires the graph; a snapshot only exists AFTER a
successful `boot()`, so by the time you can format one it is already known-valid.
That leaves a legibility gap: you have a correct graph in memory and no way to
look at it. Serializing it well is finicky -- factory deps are opaque closures a
consumer must not mistake for leaves, aliases resolve to a target, tokens can be
symbols, and the output has to be deterministic to diff. That belongs in a small,
single-purpose, read-only package, not in the container's hot core.

## What you get

- Three exporters over one snapshot: `toJSON`, `toDOT`, `toChromeTrace`.
- `fromContainer(c)` so you can go straight from a booted container to output:
  `toDOT(fromContainer(c))`.
- Honest opacity: FACTORY and VALUE nodes carry `opaqueDeps: true` so a reader
  sees "deps unknown", never "no deps"; ALIAS nodes show their target edge.
- Deterministic output: keys in a fixed order, arrays in snapshot order, so two
  runs diff byte-for-byte.
- Fail-closed everywhere: a malformed snapshot throws a clear, named error rather
  than emitting a half-valid document.

## API reference

### Functions

```typescript
fromContainer(container: { describe(): object }): object
toJSON(snapshot: object): string
toDOT(snapshot: object): string
toChromeTrace(snapshot: object): string
nodeKind(kind: number): string
```

- `fromContainer` -- returns `container.describe()`. The one container-aware
  helper; it only calls the PUBLIC `describe()`. Throws a `TypeError` if handed
  anything without a `describe` method (a container older than 2.1.0, or a
  non-container), and surfaces the container's own throw if `describe()` is
  called before boot.
- `toJSON` -- a deterministic, round-trippable JSON string. `JSON.parse` yields
  the same node count, same edges, same order. Each node emits its integer `kind`
  and a derived `kindName`; opaque nodes carry `opaqueDeps: true`; ALIAS nodes
  carry `target`. Serializing the same snapshot twice is byte-identical.
- `toDOT` -- a Graphviz `digraph`; each node labelled token + kind name, FACTORY
  nodes labelled "deps opaque", ALIAS nodes labelled "-> target". Dynamic text is
  DOT-escaped.
- `toChromeTrace` -- a `{ traceEvents, displayTimeUnit }` JSON document for
  chrome://tracing / ui.perfetto.dev. A DI graph has no wall clock, so this is a
  documented minimal mapping: each node is a complete ('X') event on a synthetic
  timeline (ts = teardown-order rank, else node index), each edge a matched flow
  pair ('s'/'f'). Not a real timeline trace.
- `nodeKind` -- map a TYPES integer tag to its label. The ONE place the mapping
  lives. Throws a `TypeError` on any tag outside 0..4 (fail closed -- no "unknown"
  placeholder a consumer might trust).

### Kinds

`KIND_NAMES` is the frozen source-of-truth table; the index is the container's
TYPES tag.

| Tag | `KIND_NAMES[tag]` | Meaning                          | Notable in output           |
| --- | ----------------- | -------------------------------- | --------------------------- |
| 0   | `VALUE`           | a pre-built value                | `opaqueDeps`, no teardown edge |
| 1   | `SINGLETON`       | built once, cached               | real dep edges              |
| 2   | `TRANSIENT`       | built per resolve                | real dep edges              |
| 3   | `FACTORY`         | an opaque factory closure        | `opaqueDeps`, "deps opaque" |
| 4   | `ALIAS`           | resolves to another token        | `target` + alias->target edge |

### Constants

| Export       | Type                | Meaning                                            |
| ------------ | ------------------- | -------------------------------------------------- |
| `VERSION`    | `string`            | Three-place-synced version (`1.0.0-alpha.1`).      |
| `KIND_NAMES` | `readonly string[]` | Frozen `['VALUE','SINGLETON','TRANSIENT','FACTORY','ALIAS']`. |

No default export.

## Composability with the container

A full pipeline: wire and boot the container, then render the same snapshot three
ways.

```javascript
import { Container } from '@zakkster/lite-di-container';
import { fromContainer, toJSON, toDOT, toChromeTrace } from '@zakkster/lite-di-graph';
import { writeFileSync } from 'node:fs';

const c = new Container();
c.value('cfg', { tag: 'T' });
c.singleton('svc', class { constructor(cfg) { this.cfg = cfg; } }, ['cfg']);
c.transient('worker', class { constructor(svc) { this.svc = svc; } }, ['svc']);
c.factory('built', () => ({ made: true }));   // opaque deps
c.alias('svcAlias', 'svc');
c.boot();

const snap = fromContainer(c);                 // one snapshot, three views

writeFileSync('graph.json', toJSON(snap));     // round-trippable, diffable
writeFileSync('graph.dot', toDOT(snap));       // dot -Tsvg graph.dot -o graph.svg
writeFileSync('graph.trace.json', toChromeTrace(snap)); // load in ui.perfetto.dev

await c.shutdown();
```

## Zero-GC design notes

<details>
<summary>Allocation truth, measured and gated (click to expand)</summary>

Be honest about what this package is: a FORMATTER. It allocates strings by
construction -- there is no 0 B/op hot path here and this README does not claim
one. What `test/torture.mjs` gates is that the formatter is LEAK-FREE and
BOUNDED:

| Property                     | Result                | How it is gated                      |
| ---------------------------- | --------------------- | ------------------------------------ |
| retention (build/format/discard) | size returns to 0 | `@zakkster/lite-leak`, size 0        |
| heap                         | bounded across cycles | soak, peak stays near baseline       |
| major GC                     | none                  | `@zakkster/lite-gc-profiler`, `maxMajor: 0` |
| per-call output              | allocates by construction | recorded, NOT gated at zero        |

The container's own `describe()` and `get()` are untouched by this code -- the
exporters are pure over the snapshot argument and never reach into container
private state. Numbers reproduce with `node --expose-gc test/torture.mjs`.

</details>

## Design decisions worth knowing

- **Pure over the snapshot, not the container.** Every exporter takes a
  `{ nodes, edges, order }` object; `fromContainer` is the only container-aware
  helper and it only calls the public `describe()`. You can format a hand-built
  snapshot with no container anywhere.
- **Fail closed on a malformed snapshot.** A renamed or missing `nodes`/`edges`/
  `order` array, a node whose `token` is not a string/symbol or whose `kind` is
  not a valid integer, an edge that is not an object with string/symbol
  `from`/`to`, or an edge referencing an absent token, all throw the same clear,
  named `malformed snapshot` error. No half-valid document, no silent coercion.
- **Symbols get distinct IDs but shared labels.** Symbol tokens are rendered by
  their `.toString()` description in DOT/JSON/trace output. Distinct
  same-description symbols now get distinct node IDs (so they never merge), but
  their LABELS read identically -- a display ambiguity inherent to symbols, not a
  data loss.
- **Opaque deps are surfaced, not hidden.** FACTORY and VALUE nodes carry
  `opaqueDeps: true` and DOT prints "deps opaque", so an opaque closure is never
  mistaken for a leaf with no dependencies.
- **Deterministic by construction.** Keys are written in a fixed order and arrays
  preserve snapshot order, so two runs produce byte-identical output you can diff.
- **One source of truth for kinds.** The integer -> label mapping lives only in
  `KIND_NAMES`/`nodeKind`; every exporter reads through it, and an out-of-range
  tag throws rather than inventing an "unknown" label.
- **Not a validator.** boot() already validated the graph before a snapshot can
  exist, so these exporters do not re-check cycles or missing deps -- they format.

## Testing

- `npm test` -- 17 `node:test` cases (behavioural coverage), including a
  fail-closed case per exporter (malformed snapshot throws).
- `npm run torture` -- `node --expose-gc test/torture.mjs`: the retention and
  bounded-heap gates (leak-free via `@zakkster/lite-leak`, no major GC via
  `@zakkster/lite-gc-profiler`). A formatter allocates by construction, so this
  gate proves leak-free/bounded, not 0 B/op.
- `npm run verify` -- both, in order. `prepublishOnly` runs `verify`.

## What this is not

- Not a runtime tracer. There are no per-resolve timings or spans here; for that
  use `@zakkster/lite-trace`. `toChromeTrace` is a static snapshot mapping onto a
  synthetic timeline, not a recording.
- Not a validator. A snapshot only exists after a successful `boot()`, which
  already checked cycles and missing deps. These exporters format a known-valid
  graph.
- Not the container. Wiring, lifetimes, scopes, and teardown live in
  `@zakkster/lite-di-container` (the peer dependency).

## Ecosystem

- `@zakkster/lite-di-container` -- the DI container whose `describe()` (>=2.1.0)
  snapshot this package formats (peer dependency).
- `@zakkster/lite-di-event-bus` -- a sibling: DI-constructed event fan-out over a
  `multi` binding.
- `@zakkster/lite-di-cron` -- a sibling: DI-constructed scheduled jobs.
- `@zakkster/lite-gc-profiler` / `@zakkster/lite-leak` -- the GC and retention
  gates used in the torture tier.

## License

MIT (c) Zahary Shinikchiev <shinikchiev@yahoo.com>
