// @zakkster/lite-di-graph -- node:test suite.
// Behavioural coverage; the allocation and retention gates live in test/torture.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Container, TYPES } from '@zakkster/lite-di-container';
import {
    VERSION, KIND_NAMES, nodeKind, fromContainer, toJSON, toDOT, toChromeTrace,
} from '../DIGraph.js';

// A booted container covering every kind: VALUE, SINGLETON (with a dep edge),
// TRANSIENT (with a dep edge), FACTORY (opaque), ALIAS (target edge). Reused by
// several cases via fromContainer().
function bootFixture() {
    const c = new Container();
    c.value('cfg', { tag: 'T' });
    c.singleton('svc', class { constructor(cfg) { this.cfg = cfg; } }, ['cfg']);
    c.transient('worker', class { constructor(svc) { this.svc = svc; } }, ['svc']);
    c.factory('built', () => ({ made: true }));
    c.alias('svcAlias', 'svc');
    c.boot();
    return c;
}

test('VERSION is a three-place-synced string', () => {
    assert.equal(typeof VERSION, 'string');
    assert.match(VERSION, /^\d+\.\d+\.\d+/);
});

test('KIND_NAMES is frozen and maps the TYPES integers in order', () => {
    assert.ok(Object.isFrozen(KIND_NAMES));
    assert.equal(KIND_NAMES[TYPES.VALUE], 'VALUE');
    assert.equal(KIND_NAMES[TYPES.SINGLETON], 'SINGLETON');
    assert.equal(KIND_NAMES[TYPES.TRANSIENT], 'TRANSIENT');
    assert.equal(KIND_NAMES[TYPES.FACTORY], 'FACTORY');
    assert.equal(KIND_NAMES[TYPES.ALIAS], 'ALIAS');
});

test('nodeKind maps every TYPES tag and fails closed on a bad tag', () => {
    assert.equal(nodeKind(TYPES.VALUE), 'VALUE');
    assert.equal(nodeKind(TYPES.ALIAS), 'ALIAS');
    assert.throws(() => nodeKind(5), TypeError);
    assert.throws(() => nodeKind(-1), TypeError);
    assert.throws(() => nodeKind(1.5), TypeError);
    assert.throws(() => nodeKind('1'), TypeError);
});

test('fromContainer requires a describe() method (>= 2.1.0)', () => {
    assert.throws(() => fromContainer(null), TypeError);
    assert.throws(() => fromContainer({}), TypeError);
    const c = bootFixture();
    const snap = fromContainer(c);
    assert.ok(Array.isArray(snap.nodes) && Array.isArray(snap.edges) && Array.isArray(snap.order));
});

// -- A-GRAPH-1 -------------------------------------------------------------
test('A-GRAPH-1: toJSON round-trips node count and edges', () => {
    const snap = fromContainer(bootFixture());
    const parsed = JSON.parse(toJSON(snap));
    assert.equal(parsed.nodes.length, snap.nodes.length, 'node count preserved');
    assert.equal(parsed.edges.length, snap.edges.length, 'edge count preserved');
    // Every snapshot edge survives byte-for-byte.
    for (let i = 0; i < snap.edges.length; i++) {
        assert.equal(parsed.edges[i].from, snap.edges[i].from);
        assert.equal(parsed.edges[i].to, snap.edges[i].to);
    }
    // Order preserved.
    assert.deepEqual(parsed.order, snap.order.map(String));
    // Deterministic: serializing the same snapshot twice is byte-identical.
    assert.equal(toJSON(snap), toJSON(snap));
});

// -- A-GRAPH-2 -------------------------------------------------------------
test('A-GRAPH-2: a VALUE node serializes with the VALUE label and no teardown edge', () => {
    const snap = fromContainer(bootFixture());
    const parsed = JSON.parse(toJSON(snap));
    const value = parsed.nodes.find((n) => n.token === 'cfg');
    assert.ok(value, 'cfg node present');
    assert.equal(value.kind, TYPES.VALUE);
    assert.equal(value.kindName, 'VALUE');
    assert.equal(value.opaqueDeps, true, 'VALUE deps are opaque, not empty');
    // A VALUE token never appears as an edge source (no teardown edge) and never
    // in the teardown order.
    assert.ok(!parsed.edges.some((e) => e.from === 'cfg'), 'VALUE has no outgoing teardown edge');
    assert.ok(!parsed.order.includes('cfg'), 'VALUE absent from teardown order');
});

test('A-GRAPH-2: a FACTORY node shows the opaque-deps flag', () => {
    const snap = fromContainer(bootFixture());
    const parsed = JSON.parse(toJSON(snap));
    const factory = parsed.nodes.find((n) => n.token === 'built');
    assert.equal(factory.kind, TYPES.FACTORY);
    assert.equal(factory.kindName, 'FACTORY');
    assert.equal(factory.opaqueDeps, true, 'FACTORY deps flagged opaque, not "no deps"');
    assert.deepEqual(factory.deps, []);
    // DOT surfaces the flag to a human reader.
    assert.match(toDOT(snap), /built\\n\(FACTORY\)\\ndeps opaque/);
});

test('A-GRAPH-2: an ALIAS node shows its target edge', () => {
    const snap = fromContainer(bootFixture());
    const parsed = JSON.parse(toJSON(snap));
    const alias = parsed.nodes.find((n) => n.token === 'svcAlias');
    assert.equal(alias.kind, TYPES.ALIAS);
    assert.equal(alias.kindName, 'ALIAS');
    assert.equal(alias.target, 'svc');
    // The alias -> target edge is present in edges (a resolve edge, not a teardown edge).
    assert.ok(parsed.edges.some((e) => e.from === 'svcAlias' && e.to === 'svc'));
    // ALIAS is never a teardown edge target rank -- it is absent from the order.
    assert.ok(!parsed.order.includes('svcAlias'));
});

test('SINGLETON/TRANSIENT deps produce real edges', () => {
    const snap = fromContainer(bootFixture());
    assert.ok(snap.edges.some((e) => e.from === 'svc' && e.to === 'cfg'));
    assert.ok(snap.edges.some((e) => e.from === 'worker' && e.to === 'svc'));
});

test('toDOT emits a digraph with a node and edge per snapshot entry', () => {
    const snap = fromContainer(bootFixture());
    const dot = toDOT(snap);
    assert.match(dot, /^digraph DIGraph \{/);
    // Node ids are SYNTHETIC ('n0', 'n1', ...); the token is the LABEL only.
    assert.match(dot, /"n\d+" \[label="cfg\\n\(VALUE\)/);
    // Edges reference the synthetic ids, resolved from node index.
    const iSvc = snap.nodes.findIndex((n) => n.token === 'svc');
    const iCfg = snap.nodes.findIndex((n) => n.token === 'cfg');
    assert.match(dot, new RegExp('"n' + iSvc + '" -> "n' + iCfg + '";'));
    assert.match(dot, /\}\n$/);
});

test('toChromeTrace emits a valid { traceEvents, displayTimeUnit } document', () => {
    const snap = fromContainer(bootFixture());
    const trace = JSON.parse(toChromeTrace(snap));
    assert.equal(trace.displayTimeUnit, 'ns');
    assert.ok(Array.isArray(trace.traceEvents));
    // One 'X' event per node, plus a matched flow pair ('s'/'f') per edge, plus 2 metadata.
    const xs = trace.traceEvents.filter((e) => e.ph === 'X');
    const flows = trace.traceEvents.filter((e) => e.ph === 's' || e.ph === 'f');
    assert.equal(xs.length, snap.nodes.length);
    assert.equal(flows.length, snap.edges.length * 2);
    // The FACTORY node's args carry the opaque flag so a trace consumer sees it.
    const builtEv = xs.find((e) => e.name === 'built');
    assert.equal(builtEv.args.opaqueDeps, true);
});

// -- Fail closed: one malformed case per exporter --------------------------
test('every exporter fails closed on a missing/renamed nodes array', () => {
    const bad = { node: [], edges: [], order: [] }; // renamed nodes -> node
    assert.throws(() => toJSON(bad), /malformed snapshot -- 'nodes'/);
    assert.throws(() => toDOT(bad), /malformed snapshot -- 'nodes'/);
    assert.throws(() => toChromeTrace(bad), /malformed snapshot -- 'nodes'/);
});

test('every exporter fails closed on a missing edges array', () => {
    const bad = { nodes: [], order: [] };
    assert.throws(() => toJSON(bad), /malformed snapshot -- 'edges'/);
    assert.throws(() => toDOT(bad), /malformed snapshot -- 'edges'/);
    assert.throws(() => toChromeTrace(bad), /malformed snapshot -- 'edges'/);
});

test('every exporter fails closed on a missing order array', () => {
    const bad = { nodes: [], edges: [] };
    assert.throws(() => toJSON(bad), /malformed snapshot -- 'order'/);
    assert.throws(() => toDOT(bad), /malformed snapshot -- 'order'/);
    assert.throws(() => toChromeTrace(bad), /malformed snapshot -- 'order'/);
});

test('every exporter fails closed on a node missing token or kind', () => {
    const noToken = { nodes: [{ kind: 0 }], edges: [], order: [] };
    assert.throws(() => toJSON(noToken), /invalid 'token'/);
    assert.throws(() => toDOT(noToken), /invalid 'token'/);
    assert.throws(() => toChromeTrace(noToken), /invalid 'token'/);

    const badKind = { nodes: [{ token: 'x', kind: 9 }], edges: [], order: [] };
    assert.throws(() => toJSON(badKind), /invalid 'kind'/);
    assert.throws(() => toDOT(badKind), /invalid 'kind'/);
    assert.throws(() => toChromeTrace(badKind), /invalid 'kind'/);

    const nonObject = { nodes: [null], edges: [], order: [] };
    assert.throws(() => toJSON(nonObject), /is not an object/);
});

test('exporters are pure: they do not read container private state', () => {
    // Hand-built snapshot with no container anywhere -- exporters must work.
    const snap = {
        nodes: [
            { token: 'a', kind: TYPES.SINGLETON, deps: ['b'] },
            { token: 'b', kind: TYPES.VALUE, deps: [], opaqueDeps: true },
        ],
        edges: [{ from: 'a', to: 'b' }],
        order: ['a'],
    };
    assert.equal(JSON.parse(toJSON(snap)).nodes.length, 2);
    // Node ids are synthetic: 'a' is n0, 'b' is n1.
    assert.match(toDOT(snap), /"n0" -> "n1";/);
    assert.equal(JSON.parse(toChromeTrace(snap)).traceEvents.filter((e) => e.ph === 'X').length, 2);
});

test('describe() before boot fails closed (fromContainer surfaces it)', () => {
    const c = new Container();
    c.value('x', 1);
    assert.throws(() => fromContainer(c), /not booted/i);
});

// -- Fix 1 guard: two DISTINCT same-description symbols must never merge ----
test('distinct same-description symbols get distinct node ids across all exporters', () => {
    const a = Symbol('svc');
    const b = Symbol('svc'); // distinct identity, identical description
    assert.notEqual(a, b);
    const snap = {
        nodes: [
            { token: a, kind: TYPES.SINGLETON, deps: [] },
            { token: b, kind: TYPES.SINGLETON, deps: [] },
        ],
        edges: [{ from: a, to: b }],
        order: [a, b],
    };

    // toJSON keeps BOTH nodes.
    const json = JSON.parse(toJSON(snap));
    assert.equal(json.nodes.length, 2, 'toJSON preserves both distinct symbols');

    // toDOT: two DISTINCT synthetic node ids -- not merged.
    const dot = toDOT(snap);
    assert.match(dot, /"n0" \[label="Symbol\(svc\)/);
    assert.match(dot, /"n1" \[label="Symbol\(svc\)/);
    assert.match(dot, /"n0" -> "n1";/);

    // toChromeTrace: two DISTINCT 'X' entries with distinct synthetic ids.
    const trace = JSON.parse(toChromeTrace(snap));
    const xs = trace.traceEvents.filter((e) => e.ph === 'X');
    assert.equal(xs.length, 2, 'two distinct trace entries');
    const traceIds = xs.map((e) => e.args.id);
    assert.deepEqual(traceIds, ['n0', 'n1']);
    assert.notEqual(traceIds[0], traceIds[1]);
});

// -- Fix 2 guard: element-type fail-closed across all three exporters ------
test('a numeric token fails closed with the malformed-snapshot message', () => {
    const bad = { nodes: [{ token: 42, kind: 0 }], edges: [], order: [] };
    assert.throws(() => toJSON(bad), /malformed snapshot/);
    assert.throws(() => toDOT(bad), /malformed snapshot/);
    assert.throws(() => toChromeTrace(bad), /malformed snapshot/);
});

test('an edge missing from ({to:"x"}) fails closed across all exporters', () => {
    const bad = { nodes: [{ token: 'x', kind: 0 }], edges: [{ to: 'x' }], order: [] };
    assert.throws(() => toJSON(bad), /malformed snapshot/);
    assert.throws(() => toDOT(bad), /malformed snapshot/);
    assert.throws(() => toChromeTrace(bad), /malformed snapshot/);
});

test('a null edge fails closed across all exporters', () => {
    const bad = { nodes: [{ token: 'x', kind: 0 }], edges: [null], order: [] };
    assert.throws(() => toJSON(bad), /malformed snapshot/);
    assert.throws(() => toDOT(bad), /malformed snapshot/);
    assert.throws(() => toChromeTrace(bad), /malformed snapshot/);
});

test('a dangling edge (endpoint absent from nodes) fails closed', () => {
    const bad = {
        nodes: [{ token: 'a', kind: TYPES.SINGLETON, deps: [] }],
        edges: [{ from: 'a', to: 'ghost' }],
        order: ['a'],
    };
    // The fail-closed contract is enforced UNIFORMLY: all three exporters reject a
    // dangling endpoint (referential integrity), not just the ID-resolving two.
    assert.throws(() => toJSON(bad), /malformed snapshot -- edge\[0\] to references a token absent/);
    assert.throws(() => toDOT(bad), /malformed snapshot/);
    assert.throws(() => toChromeTrace(bad), /malformed snapshot/);
});
