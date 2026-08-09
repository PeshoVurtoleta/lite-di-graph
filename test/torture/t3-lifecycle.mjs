/**
 * T3 -- lifecycle and fail-closed sequencing.
 *
 * lite-di-graph reaches a container only through the PUBLIC fromContainer ->
 * describe() boundary. The lifecycle contract it must honor:
 *
 *   - describe() before boot fails closed (the graph is only meaningful post-boot);
 *     fromContainer surfaces that throw, never a half-snapshot.
 *   - after shutdown a snapshot taken WHILE booted still formats (it is a pure
 *     value, decoupled from container state) -- the formatter never reaches back
 *     into the container.
 *   - every exporter fails closed on a malformed snapshot: a missing/renamed
 *     nodes/edges/order array, a node missing token/kind, or a non-object node.
 *     One malformed case per exporter, per the assertions.
 */

import { Container, TYPES } from '@zakkster/lite-di-container';
import { toJSON, toDOT, toChromeTrace, fromContainer } from '../../DIGraph.js';
import { check } from './harness.mjs';

const EXPORTERS = [['toJSON', toJSON], ['toDOT', toDOT], ['toChromeTrace', toChromeTrace]];

function eachThrows(input, rx, label) {
    for (const [name, fn] of EXPORTERS) {
        let threw = false;
        let msg = '';
        try { fn(input); } catch (e) { threw = true; msg = e.message; }
        check(threw && rx.test(msg),
            () => `T3.${label}: ${name} did not fail closed (threw=${threw} msg=${msg})`);
    }
}

export async function run() {
    // -- describe() pre-boot fails closed; fromContainer surfaces it ----------
    {
        const c = new Container();
        c.value('x', 1);
        let threw = false;
        try { fromContainer(c); } catch (e) { threw = /not booted/i.test(e.message); }
        check(threw, () => 'T3.preboot: fromContainer did not surface the pre-boot describe() throw');
    }

    // -- fromContainer fails closed on a non-container (no describe method) ----
    {
        for (const bad of [null, undefined, {}, { describe: 7 }]) {
            let threw = false;
            try { fromContainer(bad); } catch { threw = true; }
            check(threw, () => 'T3.fromContainer: a non-container did not fail closed');
        }
    }

    // -- A snapshot outlives the container: format after shutdown still works --
    {
        const c = new Container();
        c.value('cfg', {});
        c.singleton('svc', class { constructor(cfg) {} }, ['cfg']);
        c.boot();
        const snap = fromContainer(c);
        await c.shutdown();
        // The snapshot is a pure value; formatting must NOT reach back into the
        // now-shut-down container.
        let ok = true;
        try { toJSON(snap); toDOT(snap); toChromeTrace(snap); } catch { ok = false; }
        check(ok, () => 'T3.postshutdown: formatting a pre-shutdown snapshot threw');
    }

    // -- Malformed: renamed nodes array (one case per exporter) ---------------
    eachThrows({ node: [], edges: [], order: [] }, /malformed snapshot -- 'nodes'/, 'nodes');
    // -- Malformed: missing edges array ---------------------------------------
    eachThrows({ nodes: [], order: [] }, /malformed snapshot -- 'edges'/, 'edges');
    // -- Malformed: missing order array ---------------------------------------
    eachThrows({ nodes: [], edges: [] }, /malformed snapshot -- 'order'/, 'order');
    // -- Malformed: node with a non-string/symbol token -----------------------
    eachThrows({ nodes: [{ kind: TYPES.VALUE }], edges: [], order: [] }, /invalid 'token'/, 'token');
    // -- Malformed: node with an invalid kind ---------------------------------
    eachThrows({ nodes: [{ token: 'x', kind: 9 }], edges: [], order: [] }, /invalid 'kind'/, 'kind');
    // -- Malformed: a non-object node -----------------------------------------
    eachThrows({ nodes: [null], edges: [], order: [] }, /is not an object/, 'nonobject');
    // -- Malformed: not an object at all --------------------------------------
    eachThrows(null, /expected a describe\(\) snapshot object/, 'null');
}
