# Cookbook -- @zakkster/lite-di-graph

Recipes, beginner to pro. This is a stub for the alpha; it grows alongside the
`@zakkster/lite-di-*` dependents line. Every snippet is runnable against the
shipped `@zakkster/lite-di-container` v2.1.0 `describe()` surface.

## 1. Render a booted container to DOT

```javascript
import { Container } from '@zakkster/lite-di-container';
import { fromContainer, toDOT } from '@zakkster/lite-di-graph';

const c = new Container();
c.value('cfg', { tag: 'T' });
c.singleton('svc', class { constructor(cfg) { this.cfg = cfg; } }, ['cfg']);
c.boot();

const dot = toDOT(fromContainer(c));
console.log(dot);            // pipe to: dot -Tsvg -o graph.svg
```

## 2. A snapshot, three views

`fromContainer` gives you one snapshot; format it as many ways as you need.

```javascript
import { fromContainer, toJSON, toDOT, toChromeTrace } from '@zakkster/lite-di-graph';

const snap = fromContainer(c);
const json  = toJSON(snap);          // round-trippable, diffable
const dot   = toDOT(snap);           // Graphviz
const trace = toChromeTrace(snap);   // Chrome Trace Event Format
```

## 3. Pipe a trace to a file for Perfetto

`toChromeTrace` emits the `{ traceEvents, displayTimeUnit }` document that
ui.perfetto.dev and chrome://tracing load directly.

```javascript
import { writeFileSync } from 'node:fs';
import { fromContainer, toChromeTrace } from '@zakkster/lite-di-graph';

writeFileSync('graph.trace.json', toChromeTrace(fromContainer(c)));
// open https://ui.perfetto.dev and load graph.trace.json
```

## 4. Detect opaque factory nodes in the JSON

FACTORY (and VALUE) nodes carry `opaqueDeps: true` -- their deps are a closure the
container cannot introspect, so they are flagged rather than shown as leaves.

```javascript
import { fromContainer, toJSON } from '@zakkster/lite-di-graph';

const graph = JSON.parse(toJSON(fromContainer(c)));
const opaque = graph.nodes.filter((n) => n.opaqueDeps === true);
for (const n of opaque) console.log(n.token, n.kindName, '(deps unknown)');
```

## 5. Format a hand-built snapshot (no container)

The exporters are pure over the snapshot, so you can format one you built
yourself -- useful in tests or when the graph comes from elsewhere.

```javascript
import { toDOT } from '@zakkster/lite-di-graph';

const snap = {
  nodes: [
    { token: 'a', kind: 1, deps: ['b'] },              // SINGLETON
    { token: 'b', kind: 0, deps: [], opaqueDeps: true } // VALUE
  ],
  edges: [{ from: 'a', to: 'b' }],
  order: ['a'],
};
console.log(toDOT(snap));    // "a" -> "b";
```

## 6. Fail closed on a malformed snapshot

A renamed or missing array is an error, not an empty document.

```javascript
import { toJSON } from '@zakkster/lite-di-graph';

toJSON({ node: [], edges: [], order: [] });  // throws: malformed snapshot -- 'nodes' must be an array
```
