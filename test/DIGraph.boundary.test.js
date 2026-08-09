// @zakkster/lite-di-graph -- boundary + integration suite.
//
// This suite COVERS GAPS the happy-path DIGraph.test.js misses: a real
// end-to-end container pipeline (every kind + multi), structural validity of
// each exporter's output, snapshot isolation (purity), empty/minimal shapes,
// and a per-exporter fail-closed matrix (missing/renamed arrays, bad token
// types, malformed edges, out-of-range kinds, dangling endpoints).
//
// It also pins the multi-entry node-identity fix: two multi() entries share one
// string token, so a token-keyed synthetic-id lookup would MERGE their node
// declarations. The exporters must keep every node declaration distinct.
//
// node:test only. Peers: @zakkster/lite-di-container. Nothing else imported.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Container, TYPES } from '@zakkster/lite-di-container';
import {
    VERSION, KIND_NAMES, nodeKind, fromContainer, toJSON, toDOT, toChromeTrace,
} from '../DIGraph.js';

// A booted container covering every kind PLUS a 2-entry multi binding and a
// singleton depending on that multi group. `get()` caches a singleton so the
// teardown `order` is populated (not empty). Reused across the integration
// cases via fromContainer().
function e2eFixture() {
    const c = new Container();
    c.value('cfg', { tag: 'T' });
    c.singleton('svc', class { constructor(cfg) { this.cfg = cfg; } }, ['cfg']);
    c.transient('worker', class { constructor(svc) { this.svc = svc; } }, ['svc']);
    c.factory('built', () => ({ made: true }));
    c.alias('svcAlias', 'svc');
    c.multi('plugins', class A { }, []);
    c.multi('plugins', class B { }, []);
    c.singleton('host', class { constructor(p) { this.p = p; } }, ['plugins']);
    c.boot();
    c.get('svc');  // cache a singleton so `order` is non-empty
    // `host` depends on the multi token 'plugins' -- resolving it would throw
    // ('plugins' is multi; use getAll). We only need it REGISTERED so the
    // host -> plugins edge (an edge onto a duplicated token) exists in the graph.
    return c;
}

// ===========================================================================
// End-to-end via a real container (proves the real describe() -> exporter pipe)
// ===========================================================================

test('E2E: fromContainer -> all three exporters succeed on a full graph', () => {
    const c = e2eFixture();
    const snap = fromContainer(c);
    // Every exporter runs without throwing on a real snapshot.
    const json = toJSON(snap);
    const dot = toDOT(snap);
    const trace = toChromeTrace(snap);
    // toJSON node count == snapshot node count.
    const parsed = JSON.parse(json);
    assert.equal(parsed.nodes.length, snap.nodes.length, 'toJSON node count == snapshot');
    // toDOT declares exactly one node per snapshot node.
    const dotIds = [...dot.matchAll(/^ {2}"(n\d+)" \[label/gm)].map((m) => m[1]);
    assert.equal(dotIds.length, snap.nodes.length, 'DOT node-decl count == snapshot');
    // toChromeTrace has one 'X' event per node.
    const xs = JSON.parse(trace).traceEvents.filter((e) => e.ph === 'X');
    assert.equal(xs.length, snap.nodes.length, 'trace X-event count == snapshot');
});

test('E2E: a VALUE and a FACTORY node surface opaque-deps end-to-end', () => {
    const parsed = JSON.parse(toJSON(fromContainer(e2eFixture())));
    const value = parsed.nodes.find((n) => n.token === 'cfg');
    const factory = parsed.nodes.find((n) => n.token === 'built');
    assert.equal(value.kindName, 'VALUE');
    assert.equal(value.opaqueDeps, true, 'VALUE deps opaque, not empty');
    assert.equal(factory.kindName, 'FACTORY');
    assert.equal(factory.opaqueDeps, true, 'FACTORY deps opaque, not empty');
    assert.deepEqual(factory.deps, [], 'opaque factory has [] deps');
});

test('E2E: the alias resolve edge is present end-to-end', () => {
    const parsed = JSON.parse(toJSON(fromContainer(e2eFixture())));
    assert.ok(
        parsed.edges.some((e) => e.from === 'svcAlias' && e.to === 'svc'),
        'alias -> target edge present');
});

test('E2E: order reflects exactly the cached tokens, consistently across exporters', () => {
    const snap = fromContainer(e2eFixture());
    const json = JSON.parse(toJSON(snap));
    // toJSON order == snapshot order (string form), same length, same members.
    assert.deepEqual(json.order, snap.order.map(String));
    // Non-cached kinds never appear in order.
    assert.ok(!json.order.includes('worker'), 'TRANSIENT absent from order');
    assert.ok(!json.order.includes('built'), 'plain FACTORY absent from order');
    assert.ok(!json.order.includes('cfg'), 'VALUE absent from order');
    assert.ok(!json.order.includes('svcAlias'), 'ALIAS absent from order');
    // The cached singleton is present.
    assert.ok(json.order.includes('svc'), 'cached SINGLETON present in order');
});

test('E2E: two multi() entries under one token do NOT merge in DOT or trace', () => {
    // The gap the symbol-merge fix left open: duplicate STRING tokens. The two
    // 'plugins' nodes must remain two distinct declarations/events.
    const snap = fromContainer(e2eFixture());
    const pluginNodes = snap.nodes.filter((n) => n.token === 'plugins');
    assert.equal(pluginNodes.length, 2, 'fixture really has two plugins entries');

    const dot = toDOT(snap);
    const dotIds = [...dot.matchAll(/^ {2}"(n\d+)" \[label/gm)].map((m) => m[1]);
    assert.equal(new Set(dotIds).size, dotIds.length, 'every DOT node id is distinct');
    assert.equal(dotIds.length, snap.nodes.length, 'no node declaration was merged away');

    const xs = JSON.parse(toChromeTrace(snap)).traceEvents.filter((e) => e.ph === 'X');
    const traceIds = xs.map((e) => e.args.id);
    assert.equal(new Set(traceIds).size, traceIds.length, 'every trace event id is distinct');
    assert.equal(traceIds.length, snap.nodes.length, 'no trace event was merged away');
});

// ===========================================================================
// toDOT structural validity
// ===========================================================================

test('toDOT: output is a single well-formed digraph block', () => {
    const dot = toDOT(fromContainer(e2eFixture()));
    assert.match(dot, /^digraph DIGraph \{\n/, 'opens a digraph');
    assert.match(dot, /\n\}\n$/, 'closes the block');
    // Exactly one opening and one closing brace at block level.
    assert.equal((dot.match(/\{/g) || []).length, 1, 'exactly one opening brace');
    assert.equal((dot.match(/\}/g) || []).length, 1, 'exactly one closing brace');
});

test('toDOT: every edge endpoint id is a declared node id (no dangling)', () => {
    const dot = toDOT(fromContainer(e2eFixture()));
    const declared = new Set([...dot.matchAll(/^ {2}"(n\d+)" \[label/gm)].map((m) => m[1]));
    const endpoints = [...dot.matchAll(/^ {2}"(n\d+)" -> "(n\d+)";/gm)].flatMap((m) => [m[1], m[2]]);
    assert.ok(endpoints.length > 0, 'fixture has at least one edge');
    for (const ep of endpoints) {
        assert.ok(declared.has(ep), 'edge endpoint ' + ep + ' is a declared node id');
    }
});

test('toDOT: node id count == node count', () => {
    const snap = fromContainer(e2eFixture());
    const ids = [...toDOT(snap).matchAll(/^ {2}"(n\d+)" \[label/gm)].map((m) => m[1]);
    assert.equal(ids.length, snap.nodes.length);
    assert.equal(new Set(ids).size, snap.nodes.length, 'all ids distinct');
});

test('toDOT: labels with quote/brace/newline stay escaped inside the quoted string', () => {
    // Adversarial token text: a double-quote, a backslash, braces, and a real
    // newline. The emitted DOT must not contain a raw unescaped double-quote or a
    // raw newline INSIDE the label, or the digraph parse breaks.
    const nastyFrom = 'a"b\\c{d}e\nf';
    const snap = {
        nodes: [
            { token: nastyFrom, kind: TYPES.SINGLETON, deps: ['plain'] },
            { token: 'plain', kind: TYPES.VALUE, deps: [], opaqueDeps: true },
        ],
        edges: [{ from: nastyFrom, to: 'plain' }],
        order: [nastyFrom],
    };
    const dot = toDOT(snap);
    // Isolate the label body of the first node declaration.
    const m = dot.match(/^ {2}"n0" \[label="((?:[^"\\]|\\.)*)"\];$/m);
    assert.ok(m, 'node 0 label is a properly-terminated quoted DOT string');
    const body = m[1];
    // The raw double-quote from the token must appear escaped as \" in the body.
    assert.ok(body.includes('\\"'), 'raw quote is backslash-escaped');
    // The backslash from the token must appear escaped as \\.
    assert.ok(body.includes('\\\\'), 'raw backslash is backslash-escaped');
    // No RAW newline (0x0A) may sit inside the quoted label body.
    assert.ok(!body.includes('\n'), 'no raw newline inside the label');
});

// ===========================================================================
// toChromeTrace structural validity
// ===========================================================================

test('toChromeTrace: parses and has the documented { traceEvents, displayTimeUnit } shape', () => {
    const trace = JSON.parse(toChromeTrace(fromContainer(e2eFixture())));
    assert.equal(trace.displayTimeUnit, 'ns');
    assert.ok(Array.isArray(trace.traceEvents), 'traceEvents is an array');
    for (const ev of trace.traceEvents) {
        assert.equal(typeof ev.name, 'string', 'event has a name');
        assert.equal(typeof ev.ph, 'string', 'event has a phase');
        assert.equal(ev.pid, 1, 'event has pid 1');
        assert.equal(ev.tid, 1, 'event has tid 1');
    }
    // Node ('X') events carry ts/dur/args and a synthetic id in args.
    for (const ev of trace.traceEvents.filter((e) => e.ph === 'X')) {
        assert.equal(typeof ev.ts, 'number');
        assert.equal(typeof ev.dur, 'number');
        assert.match(ev.args.id, /^n\d+$/, 'X event carries a synthetic id');
    }
});

test('toChromeTrace: flow events reference declared synthetic node ids', () => {
    const snap = fromContainer(e2eFixture());
    const trace = JSON.parse(toChromeTrace(snap));
    const nodeIds = new Set(
        trace.traceEvents.filter((e) => e.ph === 'X').map((e) => e.args.id));
    const flows = trace.traceEvents.filter((e) => e.ph === 's' || e.ph === 'f');
    assert.equal(flows.length, snap.edges.length * 2, 'a matched s/f pair per edge');
    for (const f of flows) {
        assert.ok(nodeIds.has(f.args.from), 'flow from-id is a declared node id');
        assert.ok(nodeIds.has(f.args.to), 'flow to-id is a declared node id');
    }
});

test('toChromeTrace: distinct same-description symbols yield distinct ids AND events', () => {
    const a = Symbol('dup');
    const b = Symbol('dup');
    const snap = {
        nodes: [
            { token: a, kind: TYPES.SINGLETON, deps: [] },
            { token: b, kind: TYPES.SINGLETON, deps: [] },
        ],
        edges: [{ from: a, to: b }],
        order: [a, b],
    };
    const xs = JSON.parse(toChromeTrace(snap)).traceEvents.filter((e) => e.ph === 'X');
    assert.equal(xs.length, 2, 'two distinct events');
    assert.notEqual(xs[0].args.id, xs[1].args.id, 'two distinct ids');
});

// ===========================================================================
// Snapshot isolation (purity) -- an exporter must NOT mutate its input
// ===========================================================================

test('exporters do not mutate the snapshot (nodes/edges/order/deps unchanged)', () => {
    const snap = fromContainer(e2eFixture());
    // Deep structural clone of the parts that matter, for a before/after compare.
    const clone = (s) => ({
        nodes: s.nodes.map((n) => ({ ...n, deps: n.deps ? [...n.deps] : n.deps })),
        edges: s.edges.map((e) => ({ ...e })),
        order: [...s.order],
    });
    const before = clone(snap);
    // Capture identity of the dep arrays too -- an exporter must not splice them.
    const depRefs = snap.nodes.map((n) => n.deps);

    toJSON(snap);
    toDOT(snap);
    toChromeTrace(snap);

    const after = clone(snap);
    assert.deepEqual(after.nodes, before.nodes, 'nodes unchanged');
    assert.deepEqual(after.edges, before.edges, 'edges unchanged');
    assert.deepEqual(after.order, before.order, 'order unchanged');
    for (let i = 0; i < snap.nodes.length; i++) {
        assert.equal(snap.nodes[i].deps, depRefs[i], 'dep array identity unchanged (not aliased/replaced)');
    }
});

test('two exporter calls are independent (no shared mutable state leaks between)', () => {
    const snap = fromContainer(e2eFixture());
    const a1 = toJSON(snap);
    const b = toDOT(snap);       // interleave a different exporter
    const a2 = toJSON(snap);
    assert.equal(a1, a2, 'toJSON is deterministic and unaffected by an interleaved toDOT');
    assert.equal(b, toDOT(snap), 'toDOT is deterministic across repeated calls');
});

// ===========================================================================
// Empty + minimal
// ===========================================================================

test('empty booted container snapshot exports to valid empty outputs (no throw)', () => {
    const empty = { nodes: [], edges: [], order: [] };
    // toJSON: valid JSON, empty collections.
    const json = JSON.parse(toJSON(empty));
    assert.deepEqual(json.nodes, []);
    assert.deepEqual(json.edges, []);
    assert.deepEqual(json.order, []);
    // toDOT: a valid, empty digraph block.
    const dot = toDOT(empty);
    assert.match(dot, /^digraph DIGraph \{\n/);
    assert.match(dot, /\n\}\n$/);
    assert.equal([...dot.matchAll(/^ {2}"n\d+" \[label/gm)].length, 0, 'no node declarations');
    assert.equal([...dot.matchAll(/ -> /g)].length, 0, 'no edges');
    // toChromeTrace: parses, only the 2 metadata events, no X/flow events.
    const trace = JSON.parse(toChromeTrace(empty));
    assert.ok(Array.isArray(trace.traceEvents));
    assert.equal(trace.traceEvents.filter((e) => e.ph === 'X').length, 0);
    assert.equal(trace.traceEvents.filter((e) => e.ph === 's' || e.ph === 'f').length, 0);
});

test('a real empty booted container round-trips through fromContainer + exporters', () => {
    const c = new Container();
    c.boot();
    const snap = fromContainer(c);
    assert.deepEqual(snap.nodes, []);
    assert.doesNotThrow(() => toJSON(snap));
    assert.doesNotThrow(() => toDOT(snap));
    assert.doesNotThrow(() => toChromeTrace(snap));
});

// ===========================================================================
// Fail-closed matrix (assertSnapshot) -- EACH throws /malformed snapshot/ across
// all three exporters. Cover the gaps the happy-path suite leaves.
// ===========================================================================

const EXPORTERS = [['toJSON', toJSON], ['toDOT', toDOT], ['toChromeTrace', toChromeTrace]];

// Helper: assert every exporter rejects `bad` with the given message pattern.
function allFailClosed(bad, pattern) {
    for (const [name, fn] of EXPORTERS) {
        assert.throws(() => fn(bad), pattern, name + ' must fail closed');
    }
}

test('fail-closed: the snapshot itself is null/undefined/non-object', () => {
    for (const bad of [null, undefined, 42, 'x', true]) {
        for (const [name, fn] of EXPORTERS) {
            assert.throws(() => fn(bad), /expected a describe\(\) snapshot object/, name);
        }
    }
});

test('fail-closed: nodes array renamed AND non-array types', () => {
    allFailClosed({ node: [], edges: [], order: [] }, /malformed snapshot -- 'nodes'/);
    allFailClosed({ nodes: null, edges: [], order: [] }, /malformed snapshot -- 'nodes'/);
    allFailClosed({ nodes: {}, edges: [], order: [] }, /malformed snapshot -- 'nodes'/);
    allFailClosed({ nodes: undefined, edges: [], order: [] }, /malformed snapshot -- 'nodes'/);
});

test('fail-closed: edges array renamed AND non-array types', () => {
    allFailClosed({ nodes: [], edge: [], order: [] }, /malformed snapshot -- 'edges'/);
    allFailClosed({ nodes: [], edges: null, order: [] }, /malformed snapshot -- 'edges'/);
    allFailClosed({ nodes: [], edges: 'x', order: [] }, /malformed snapshot -- 'edges'/);
});

test('fail-closed: order array renamed AND non-array types', () => {
    allFailClosed({ nodes: [], edges: [], ordering: [] }, /malformed snapshot -- 'order'/);
    allFailClosed({ nodes: [], edges: [], order: null }, /malformed snapshot -- 'order'/);
    allFailClosed({ nodes: [], edges: [], order: {} }, /malformed snapshot -- 'order'/);
});

test('fail-closed: node token is number / object / null / undefined / NaN across ALL exporters', () => {
    for (const badTok of [42, { s: 1 }, null, undefined, NaN]) {
        allFailClosed(
            { nodes: [{ token: badTok, kind: 0 }], edges: [], order: [] },
            /malformed snapshot/);
    }
});

test('fail-closed: node kind out of 0..4, non-integer, or wrong type across ALL exporters', () => {
    for (const badKind of [5, -1, 1.5, '1', null, undefined, NaN, -0 === 0 ? 99 : 0]) {
        allFailClosed(
            { nodes: [{ token: 'x', kind: badKind }], edges: [], order: [] },
            /malformed snapshot/);
    }
    // Boundary integers that ARE valid must NOT throw (0 and N-1 == 4).
    assert.doesNotThrow(() => toJSON({ nodes: [{ token: 'x', kind: 0 }], edges: [], order: [] }));
    assert.doesNotThrow(() => toJSON({ nodes: [{ token: 'x', kind: 4, target: 'x' }], edges: [], order: [] }));
    // N == 5 (KIND_NAMES.length) is the first invalid tag.
    allFailClosed({ nodes: [{ token: 'x', kind: KIND_NAMES.length }], edges: [], order: [] }, /malformed snapshot/);
});

test('fail-closed: -0 kind is accepted (=== 0), documenting the numeric boundary', () => {
    // -0 | 0 === 0 and -0 >= 0, so -0 is the VALUE tag. This pins that the guard
    // treats negative zero as zero rather than rejecting it.
    const snap = { nodes: [{ token: 'x', kind: -0 }], edges: [], order: [] };
    assert.doesNotThrow(() => toJSON(snap));
    assert.equal(JSON.parse(toJSON(snap)).nodes[0].kindName, 'VALUE');
});

test('fail-closed: a node that is null/undefined/non-object across ALL exporters', () => {
    for (const badNode of [null, undefined, 42, 'x']) {
        allFailClosed({ nodes: [badNode], edges: [], order: [] }, /is not an object/);
    }
});

test('fail-closed: edge null / missing-from / missing-to / non-string endpoint across ALL exporters', () => {
    const node = { token: 'x', kind: 0 };
    allFailClosed({ nodes: [node], edges: [null], order: [] }, /malformed snapshot/);
    allFailClosed({ nodes: [node], edges: [undefined], order: [] }, /malformed snapshot/);
    allFailClosed({ nodes: [node], edges: [{ to: 'x' }], order: [] }, /invalid 'from'/);
    allFailClosed({ nodes: [node], edges: [{ from: 'x' }], order: [] }, /invalid 'to'/);
    allFailClosed({ nodes: [node], edges: [{ from: 42, to: 'x' }], order: [] }, /invalid 'from'/);
    allFailClosed({ nodes: [node], edges: [{ from: 'x', to: { o: 1 } }], order: [] }, /invalid 'to'/);
    allFailClosed({ nodes: [node], edges: [{ from: 'x', to: null }], order: [] }, /invalid 'to'/);
});

test('fail-closed: a dangling edge endpoint fails closed in the resolving exporters', () => {
    const bad = {
        nodes: [{ token: 'a', kind: TYPES.SINGLETON, deps: [] }],
        edges: [{ from: 'a', to: 'ghost' }],
        order: ['a'],
    };
    // toJSON does not resolve endpoints against nodes -- documented -- so it does
    // NOT throw here; the two resolving exporters MUST.
    assert.doesNotThrow(() => toJSON(bad), 'toJSON does not resolve endpoints');
    assert.throws(() => toDOT(bad), /malformed snapshot -- edge\[0\] to references a token absent/);
    assert.throws(() => toChromeTrace(bad), /malformed snapshot -- edge\[0\] to references a token absent/);
    // A dangling FROM endpoint too.
    const badFrom = {
        nodes: [{ token: 'a', kind: TYPES.SINGLETON, deps: [] }],
        edges: [{ from: 'ghost', to: 'a' }],
        order: ['a'],
    };
    assert.throws(() => toDOT(badFrom), /edge\[0\] from references a token absent/);
    assert.throws(() => toChromeTrace(badFrom), /edge\[0\] from references a token absent/);
});

// ===========================================================================
// Adversarial cases the planner did not enumerate
// ===========================================================================

test('adversarial: a malicious "toString" token property cannot inject DOT syntax', () => {
    // A string token that itself LOOKS like DOT structure must be inert: it stays
    // a single quoted label, and it must NOT create a second node/edge line.
    const inject = '"]; } malicious [label="pwned';
    const snap = {
        nodes: [{ token: inject, kind: TYPES.SINGLETON, deps: [] }],
        edges: [],
        order: [],
    };
    const dot = toDOT(snap);
    // The token legitimately contains braces, so raw brace COUNTS are meaningless
    // here. The security property is structural: exactly ONE node-declaration line
    // (no injected second node/edge), and the block closes with a lone `}` line.
    const decls = [...dot.matchAll(/^ {2}"n\d+" \[label="((?:[^"\\]|\\.)*)"\];$/gm)];
    assert.equal(decls.length, 1, 'exactly one node declaration, no injected node');
    const lines = dot.split('\n');
    assert.equal(lines[lines.length - 2], '}', 'block closes with a lone brace line');
    assert.ok(!/ -> /.test(dot), 'no injected edge line');
    // The injected quote is escaped inside the single label body.
    assert.ok(decls[0][1].includes('\\"'), 'injected quote escaped, not structural');
});

test('adversarial: a re-entrant getter on token does not corrupt output (token read is stable)', () => {
    // A snapshot whose node.token is backed by a getter that mutates a sibling on
    // each read. assertSnapshot reads token once for validation, the exporter reads
    // it again -- the output must remain internally consistent (node id count ==
    // node count, valid JSON), i.e. no exporter is derailed by a live accessor.
    let reads = 0;
    const node0 = { kind: TYPES.SINGLETON, deps: [] };
    Object.defineProperty(node0, 'token', {
        enumerable: true,
        get() { reads++; return 'shifty'; },
    });
    const snap = { nodes: [node0, { token: 'stable', kind: TYPES.VALUE, deps: [], opaqueDeps: true }], edges: [], order: [] };
    const json = JSON.parse(toJSON(snap));
    assert.equal(json.nodes.length, 2, 'both nodes serialized');
    assert.ok(reads > 0, 'the live getter was actually exercised');
    const dot = toDOT(snap);
    const ids = [...dot.matchAll(/^ {2}"n\d+" \[label/gm)];
    assert.equal(ids.length, 2, 'node id count == node count under a live accessor');
});

test('adversarial: N-large graph with a duplicated multi token stays 1:1 node<->id', () => {
    // Scale the duplicate-token hazard: many entries under ONE multi token. Every
    // node must still get its own id in DOT and its own event in the trace -- no
    // silent collapse at size.
    const N = 50;
    const nodes = [];
    for (let i = 0; i < N; i++) nodes.push({ token: 'group', kind: TYPES.SINGLETON, deps: [] });
    const snap = { nodes, edges: [], order: [] };
    const dotIds = [...toDOT(snap).matchAll(/^ {2}"(n\d+)" \[label/gm)].map((m) => m[1]);
    assert.equal(dotIds.length, N, 'N node declarations');
    assert.equal(new Set(dotIds).size, N, 'all N ids distinct despite one shared token');
    const xs = JSON.parse(toChromeTrace(snap)).traceEvents.filter((e) => e.ph === 'X');
    assert.equal(new Set(xs.map((e) => e.args.id)).size, N, 'all N trace ids distinct');
});

test('adversarial: an extra unknown property on a node is ignored, not echoed blindly', () => {
    // A node carrying a rogue field (e.g. a would-be "__proto__"-ish key or a
    // stray "kindName") must not leak into the serialized record beyond the fixed
    // documented key set -- the exporter derives kindName itself.
    const snap = {
        nodes: [{ token: 'x', kind: TYPES.SINGLETON, deps: [], kindName: 'HACKED', rogue: 1 }],
        edges: [],
        order: [],
    };
    const rec = JSON.parse(toJSON(snap)).nodes[0];
    assert.equal(rec.kindName, 'SINGLETON', 'kindName is derived, not passed through');
    assert.equal(rec.rogue, undefined, 'unknown field not echoed');
    assert.deepEqual(Object.keys(rec).sort(), ['deps', 'kind', 'kindName', 'token']);
});

// ===========================================================================
// VERSION three-place sync sanity (cheap guard; full sync verified out-of-band)
// ===========================================================================

test('VERSION is present and semver-shaped', () => {
    assert.match(VERSION, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/);
});
