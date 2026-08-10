/**
 * Reference app -- a dependency-graph exporter (gate-3 downstream consumer).
 *
 * Proves @zakkster/lite-di-graph "in anger": take a REAL booted container, snapshot
 * its dependency graph with the container's own public describe(), and render that
 * snapshot to the three shipped formats -- stable JSON, Graphviz DOT, and Chrome Trace
 * Event Format -- the artifacts you would hand to another tool, drop into a repo, or
 * load into Graphviz / ui.perfetto.dev.
 *
 * It exercises the ENTIRE public surface end-to-end, not in fragments:
 *   - fromContainer(container)  -> the snapshot, via the container's PUBLIC describe()
 *   - toJSON(snapshot)          -> deterministic, round-trippable JSON
 *   - toDOT(snapshot)           -> a Graphviz digraph
 *   - toChromeTrace(snapshot)   -> Chrome Trace Event Format JSON
 *   - nodeKind(kind) / KIND_NAMES  -> the integer->label source of truth
 *   - VERSION
 *   - the fail-closed contract: a malformed snapshot, and a non-container handed to
 *     fromContainer, throw named errors instead of emitting half-valid output.
 *
 * The graph registers ONE of every registration kind (value / singleton / transient /
 * factory / alias) with real dependency wiring, so every KIND_NAMES label, the opaque-
 * deps marker, the alias target, and real resolve edges all appear in the output.
 *
 * It is self-verifying: every claim is asserted with node:assert, so a broken contract
 * exits non-zero. Run it: `npm run example` (or `node examples/export-graph.mjs`).
 * ASCII-only; the only imports are the two @zakkster packages and node:assert.
 *
 * NOTE: @zakkster/lite-di-container is a PEER dependency of this package -- install it
 * alongside (`npm i @zakkster/lite-di-container`) to run this example from a tarball.
 */

import assert from 'node:assert/strict';
import { Container } from '@zakkster/lite-di-container';
import {
    fromContainer, toJSON, toDOT, toChromeTrace, nodeKind, KIND_NAMES, VERSION,
} from '@zakkster/lite-di-graph';

/** Tiny ASCII logger -- a demo prints, but never from library source. */
const out = (line) => process.stdout.write(line + '\n');

// ---------------------------------------------------------------------------
// A realistic service container: one of every registration kind, wired with
// real constructor deps so the snapshot carries real resolve edges.
// ---------------------------------------------------------------------------
class Logger {}
class Db { constructor(config) { this.config = config; } }
class Repo { constructor(db, logger) { this.db = db; this.logger = logger; } }

const c = new Container();
c.value('config', { url: 'postgres://localhost/app' });   // VALUE  (deps opaque)
c.singleton('logger', Logger);                            // SINGLETON
c.singleton('db', Db, ['config']);                        // SINGLETON -> config
c.transient('repo', Repo, ['db', 'logger']);              // TRANSIENT -> db, logger
c.factory('clock', () => ({ now: 0 }));                   // FACTORY (deps opaque)
c.alias('log', 'logger');                                 // ALIAS -> logger
c.boot();
c.get('repo'); // resolve so cached singletons populate the teardown order

out('export-graph reference app -- @zakkster/lite-di-graph v' + VERSION);

// ---------------------------------------------------------------------------
// Snapshot the booted container via its own PUBLIC describe(), through
// fromContainer -- the one convenience that reaches a container.
// ---------------------------------------------------------------------------
const snap = fromContainer(c);
out('snapshot: ' + snap.nodes.length + ' nodes, ' + snap.edges.length +
    ' edge(s), teardown order [' + snap.order.join(', ') + ']');

assert.equal(snap.nodes.length, 6, 'expected one node per registration');
// Every KIND_NAMES label is present exactly once -> all five kinds exercised.
const kindsSeen = snap.nodes.map((n) => nodeKind(n.kind)).sort();
assert.deepEqual(kindsSeen, ['ALIAS', 'FACTORY', 'SINGLETON', 'SINGLETON', 'TRANSIENT', 'VALUE']);
// VALUE and FACTORY nodes are structurally opaque; the alias carries its target.
assert.ok(snap.nodes.find((n) => n.token === 'config').opaqueDeps === true);
assert.ok(snap.nodes.find((n) => n.token === 'clock').opaqueDeps === true);
assert.equal(snap.nodes.find((n) => n.token === 'log').target, 'logger');

// ---------------------------------------------------------------------------
// nodeKind / KIND_NAMES -- the integer->label source of truth.
// ---------------------------------------------------------------------------
assert.equal(KIND_NAMES.length, 5);
assert.ok(Object.isFrozen(KIND_NAMES), 'KIND_NAMES must be frozen');
assert.deepEqual([...KIND_NAMES], ['VALUE', 'SINGLETON', 'TRANSIENT', 'FACTORY', 'ALIAS']);
for (let k = 0; k < KIND_NAMES.length; k++) assert.equal(nodeKind(k), KIND_NAMES[k]);

// ---------------------------------------------------------------------------
// toJSON -- deterministic and round-trippable.
// ---------------------------------------------------------------------------
const json = toJSON(snap);
const parsed = JSON.parse(json);
assert.equal(parsed.nodes.length, snap.nodes.length, 'round-trip preserves node count');
const endpoints = (e) => e.from + '->' + e.to;
assert.deepEqual(
    parsed.edges.map(endpoints).sort(), snap.edges.map(endpoints).sort(),
    'round-trip preserves edge endpoints (content, not just count)',
);
assert.deepEqual(parsed.order, snap.order, 'round-trip preserves teardown order');
assert.equal(toJSON(snap), json, 'serializing the same snapshot twice is byte-identical');
// each node emits BOTH its integer kind and the derived kindName.
const dbJson = parsed.nodes.find((n) => n.token === 'db');
assert.equal(dbJson.kind, 1);
assert.equal(dbJson.kindName, 'SINGLETON');

// ---------------------------------------------------------------------------
// toDOT -- a Graphviz digraph, labelled and escaped.
// ---------------------------------------------------------------------------
const dot = toDOT(snap);
assert.ok(dot.startsWith('digraph'), 'DOT must be a digraph');
assert.ok(dot.includes('(VALUE)') && dot.includes('(ALIAS)'), 'DOT labels the kinds');
assert.ok(dot.includes('deps opaque'), 'FACTORY/VALUE nodes are labelled deps opaque');
assert.ok(dot.includes('-> logger'), 'ALIAS node labels its target');

// ---------------------------------------------------------------------------
// toChromeTrace -- Chrome Trace Event Format (a documented minimal mapping).
// ---------------------------------------------------------------------------
const trace = JSON.parse(toChromeTrace(snap));
assert.ok(Array.isArray(trace.traceEvents), 'trace carries a traceEvents array');
assert.equal(typeof trace.displayTimeUnit, 'string');
// one complete ('X') event per node.
const completeEvents = trace.traceEvents.filter((e) => e.ph === 'X');
assert.equal(completeEvents.length, snap.nodes.length, 'one complete event per node');

// ---------------------------------------------------------------------------
// FAIL-CLOSED, proven: malformed input throws named errors, never half-output.
// ---------------------------------------------------------------------------
const throwsOn = (fn, label) => {
    let e = null;
    try { fn(); } catch (err) { e = err; }
    assert.ok(e instanceof Error, label + ' MUST fail closed (throw), not emit partial output');
    return e;
};
throwsOn(() => nodeKind(5), 'nodeKind out of range');
throwsOn(() => nodeKind(1.5), 'nodeKind non-integer');
// structural malformation is rejected by every exporter (here: toJSON).
throwsOn(() => toJSON({ nodes: 'not-an-array', edges: [], order: [] }), 'toJSON on a non-array nodes');
throwsOn(() => toJSON({ nodes: snap.nodes, edges: [null], order: [] }), 'toJSON on a null edge');
// REFERENTIAL integrity (an edge to a token absent from nodes) is enforced by the
// exporters that resolve node IDs -- toDOT and toChromeTrace. (toJSON is a faithful
// serializer of the snapshot's SHAPE and does not itself resolve references, so this
// dangling edge is routed through the exporters that do.)
const dangling = { nodes: snap.nodes, edges: [{ from: 'db', to: 'ghost' }], order: [] };
throwsOn(() => toDOT(dangling), 'toDOT on a dangling edge');
throwsOn(() => toChromeTrace(dangling), 'toChromeTrace on a dangling edge');
throwsOn(() => fromContainer({}), 'fromContainer on a non-container');

out('fail-closed: nodeKind range, structural malformation, dangling edge (DOT/trace), ' +
    'non-container all threw');

// ---------------------------------------------------------------------------
// Show the real artifact a user would hand to Graphviz.
// ---------------------------------------------------------------------------
out('\n-- Graphviz DOT ------------------------------------------------------');
out(dot);

await c.shutdown();
out('reference app: OK (every contract asserted)');
