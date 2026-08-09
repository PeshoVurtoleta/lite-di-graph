/**
 * T0 -- exporter laws.
 *
 * Properties that must hold for ANY booted topology, checked over a seeded corpus
 * of random containers. These are the observable contract of the formatters:
 * round-trip fidelity (node count + edges), the kind-label mapping, the opaque-
 * deps flag on FACTORY/VALUE, the ALIAS target edge, and that VALUE/ALIAS never
 * carry a teardown-order rank. Purity is proven by feeding a hand-built snapshot
 * (no container) through every exporter.
 */

import { Container, TYPES } from '@zakkster/lite-di-container';
import { toJSON, toDOT, toChromeTrace, fromContainer, nodeKind, KIND_NAMES } from '../../DIGraph.js';
import { makePrng, SEED, check } from './harness.mjs';

// Build a random but VALID booted container: a chain of singletons over a value,
// plus one factory, one transient, and one alias. Every dep points backwards so
// the graph is acyclic and boot() succeeds.
function buildContainer(rnd) {
    const c = new Container();
    c.value('cfg', { seed: 1 });
    const tokens = ['cfg'];
    const nSingles = 1 + (rnd() % 5);
    for (let i = 0; i < nSingles; i++) {
        const dep = tokens[rnd() % tokens.length];
        const name = 's' + i;
        c.singleton(name, class { constructor(d) { this.d = d; } }, [dep]);
        tokens.push(name);
    }
    c.transient('t0', class { constructor(d) { this.d = d; } }, [tokens[rnd() % tokens.length]]);
    c.factory('f0', () => ({ built: true }));
    c.alias('aliasS0', 's0');
    c.boot();
    return c;
}

export async function run() {
    const prng = makePrng(SEED);

    // -- Law 1: nodeKind maps exactly the five TYPES tags, fails closed else ---
    check(KIND_NAMES.length === 5, () => 'T0.kinds: KIND_NAMES must have exactly 5 entries');
    check(nodeKind(TYPES.VALUE) === 'VALUE' && nodeKind(TYPES.ALIAS) === 'ALIAS',
        () => 'T0.kinds: nodeKind mislabeled a boundary tag');
    let threw = false;
    try { nodeKind(5); } catch { threw = true; }
    check(threw, () => 'T0.kinds: nodeKind(5) did not fail closed');

    // -- Law 2: round-trip fidelity over a seeded corpus ----------------------
    for (let g = 0; g < 40; g++) {
        const c = buildContainer(prng);
        const snap = fromContainer(c);
        const parsed = JSON.parse(toJSON(snap));

        check(parsed.nodes.length === snap.nodes.length,
            () => `T0.roundtrip: graph ${g} node count ${parsed.nodes.length} != ${snap.nodes.length} (seed=${SEED})`);
        check(parsed.edges.length === snap.edges.length,
            () => `T0.roundtrip: graph ${g} edge count ${parsed.edges.length} != ${snap.edges.length} (seed=${SEED})`);
        for (let e = 0; e < snap.edges.length; e++) {
            check(parsed.edges[e].from === snap.edges[e].from && parsed.edges[e].to === snap.edges[e].to,
                () => `T0.roundtrip: graph ${g} edge ${e} diverged (seed=${SEED})`);
        }
        // Determinism: same snapshot -> byte-identical JSON.
        check(toJSON(snap) === toJSON(snap),
            () => `T0.roundtrip: graph ${g} toJSON not deterministic (seed=${SEED})`);

        // -- Law 3: VALUE/FACTORY carry opaqueDeps + no teardown rank ---------
        for (const n of parsed.nodes) {
            if (n.kind === TYPES.VALUE || n.kind === TYPES.FACTORY) {
                check(n.opaqueDeps === true,
                    () => `T0.opaque: graph ${g} node '${n.token}' (${n.kindName}) missing opaqueDeps flag`);
                check(n.deps.length === 0,
                    () => `T0.opaque: graph ${g} node '${n.token}' opaque yet has deps`);
            }
            if (n.kind === TYPES.VALUE || n.kind === TYPES.ALIAS) {
                check(!parsed.order.includes(n.token),
                    () => `T0.order: graph ${g} ${n.kindName} '${n.token}' must not carry a teardown rank`);
            }
            check(n.kindName === KIND_NAMES[n.kind],
                () => `T0.label: graph ${g} node '${n.token}' kindName mismatch`);
        }

        // -- Law 4: ALIAS carries target + a target edge ----------------------
        const alias = parsed.nodes.find((n) => n.kind === TYPES.ALIAS);
        check(alias !== undefined && alias.target === 's0',
            () => `T0.alias: graph ${g} alias target wrong (seed=${SEED})`);
        check(parsed.edges.some((e) => e.from === 'aliasS0' && e.to === 's0'),
            () => `T0.alias: graph ${g} alias target edge missing (seed=${SEED})`);

        // -- Law 5: DOT + ChromeTrace are structurally complete ---------------
        const dot = toDOT(snap);
        check(dot.startsWith('digraph DIGraph {') && dot.endsWith('}\n'),
            () => `T0.dot: graph ${g} DOT envelope malformed (seed=${SEED})`);
        const trace = JSON.parse(toChromeTrace(snap));
        const xs = trace.traceEvents.filter((ev) => ev.ph === 'X');
        const flows = trace.traceEvents.filter((ev) => ev.ph === 's' || ev.ph === 'f');
        check(xs.length === snap.nodes.length,
            () => `T0.trace: graph ${g} X-event count ${xs.length} != ${snap.nodes.length} (seed=${SEED})`);
        check(flows.length === snap.edges.length * 2,
            () => `T0.trace: graph ${g} flow count ${flows.length} != ${snap.edges.length * 2} (seed=${SEED})`);

        await c.shutdown();
    }

    // -- Law 6: purity -- exporters operate on a hand-built snapshot ----------
    {
        const snap = {
            nodes: [
                { token: 'a', kind: TYPES.SINGLETON, deps: ['b'] },
                { token: 'b', kind: TYPES.VALUE, deps: [], opaqueDeps: true },
            ],
            edges: [{ from: 'a', to: 'b' }],
            order: ['a'],
        };
        check(JSON.parse(toJSON(snap)).nodes.length === 2, () => 'T0.pure: toJSON failed on a bare snapshot');
        // Node ids are SYNTHETIC ('a' is n0, 'b' is n1); tokens are labels only.
        check(/"n0" -> "n1";/.test(toDOT(snap)), () => 'T0.pure: toDOT failed on a bare snapshot');
        check(JSON.parse(toChromeTrace(snap)).traceEvents.some((e) => e.ph === 'X'),
            () => 'T0.pure: toChromeTrace failed on a bare snapshot');
    }
}
