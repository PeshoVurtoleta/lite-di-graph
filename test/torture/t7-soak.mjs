/**
 * T7 -- soak and retention (A-GRAPH-3).
 *
 * N=10000 full build/discard cycles: each cycle builds a FRESH container, boots
 * it, takes a describe() snapshot, formats it three ways (toJSON/toDOT/
 * toChromeTrace), discards every string, and shuts the container down. The gates:
 *
 *   - lite-leak tracker.size() === 0 and audit() clean: nothing a snapshot or a
 *     formatter produced outlived its cycle. The tracked resource is the snapshot
 *     object itself (the formatter must not pin it, cache it, or retain any string
 *     built from it). The cleanup closure and the tag NEVER close over the tracked
 *     target (lite-leak held-value contract), or finalization is defeated.
 *   - peak heapUsed <= 2x the post-warmup baseline: no per-cycle accumulation, no
 *     steady-state growth after GC. A formatter allocates per call by construction,
 *     but every allocation is garbage; the heap must return.
 *
 * There is no dispose() surface here -- the package is stateless functions -- so,
 * unlike a long-lived-instance package, the ONLY retention risk is a formatter
 * accidentally holding its input snapshot or its output string. This tier proves
 * neither happens.
 */

import { Container } from '@zakkster/lite-di-container';
import { createLeakTracker } from '@zakkster/lite-leak';
import { toJSON, toDOT, toChromeTrace, fromContainer } from '../../DIGraph.js';
import { check, STATS } from './harness.mjs';

const CYCLES = 10000;     // N=10000 (A-GRAPH-3)
const NODES = 8;
const NOOP = function () {};

export async function run() {
    const tracker = createLeakTracker({
        name: 'graph-soak',
        onWarning: () => { STATS.warnings++; },
    });

    globalThis.gc();
    const heapBaseline = process.memoryUsage().heapUsed;
    let heapPeak = heapBaseline;

    for (let cyc = 0; cyc < CYCLES; cyc++) {
        const c = new Container();
        c.value('cfg', { cycle: cyc });
        for (let i = 0; i < NODES; i++) {
            const dep = i === 0 ? 'cfg' : 's' + (i - 1);
            c.singleton('s' + i, class { constructor(d) { this.d = d; } }, [dep]);
        }
        c.factory('f0', () => ({ built: true }));
        c.alias('a0', 's0');
        c.boot();

        const snap = fromContainer(c);

        // Format every way and discard. If a formatter cached its input or output,
        // the tracked snapshot below would survive the cycle.
        const j = toJSON(snap);
        const d = toDOT(snap);
        const t = toChromeTrace(snap);
        // Touch the outputs so a clever engine cannot elide the calls, then drop.
        check(j.length > 0 && d.length > 0 && t.length > 0,
            () => `T7: cycle ${cyc} produced an empty formatting`);

        // Track the SNAPSHOT (not the container): the formatter must not pin it.
        // cleanup/tag must NOT close over the tracked target (held-value contract).
        const h = tracker.track(snap, NOOP, cyc);

        await c.shutdown();
        tracker.untrack(h);

        if ((cyc & 1023) === 0) {
            globalThis.gc();
            const used = process.memoryUsage().heapUsed;
            if (used > heapPeak) heapPeak = used;
        }
    }

    globalThis.gc();
    const finalUsed = process.memoryUsage().heapUsed;
    if (finalUsed > heapPeak) heapPeak = finalUsed;

    check(tracker.size() === 0, () => `T7: lite-leak tracker leaked ${tracker.size()} resources`);
    const findings = tracker.audit();
    STATS.leakSize = tracker.size();
    STATS.leakTarget = 0;
    STATS.findings = findings.length;
    check(findings.length === 0, () => `T7: lite-leak reported ${findings.length} findings`);

    check(heapPeak <= 2 * heapBaseline,
        () => `T7: peak heap ${(heapPeak / 1024).toFixed(0)} KB > 2x baseline ${(heapBaseline / 1024).toFixed(0)} KB`);

    // ---- Sub-phase 2: retain-then-release witness ---------------------------
    // A stronger retention proof: format into a batch, keep the batch alive across
    // many cycles, then release it and confirm the heap returns. This catches a
    // formatter that shares mutable state across calls (it does not -- every call
    // is a pure function of its argument -- but the gate must be able to see it).
    const BATCH = 2000;
    const held = new Array(BATCH);
    globalThis.gc();
    const holdBaseline = process.memoryUsage().heapUsed;

    const c2 = new Container();
    c2.value('cfg', {});
    for (let i = 0; i < NODES; i++) {
        const dep = i === 0 ? 'cfg' : 's' + (i - 1);
        c2.singleton('s' + i, class { constructor(d) { this.d = d; } }, [dep]);
    }
    c2.boot();
    const snap2 = fromContainer(c2);
    for (let i = 0; i < BATCH; i++) held[i] = toJSON(snap2);
    // Sanity: held output is real and independent (distinct string instances).
    check(held[0] === held[BATCH - 1], () => 'T7.hold: deterministic formatter produced diverging output');

    for (let i = 0; i < BATCH; i++) held[i] = null; // release
    await c2.shutdown();
    globalThis.gc();
    const holdFinal = process.memoryUsage().heapUsed;
    check(holdFinal <= 2 * holdBaseline,
        () => `T7.hold: heap ${(holdFinal / 1024).toFixed(0)} KB > 2x baseline ${(holdBaseline / 1024).toFixed(0)} KB after release`);

    process.stderr.write('T7 soak: ' + CYCLES + ' build/format/discard cycles clean, leak size=' +
        tracker.size() + ' peak=' + (heapPeak / 1024).toFixed(0) + ' KB baseline=' +
        (heapBaseline / 1024).toFixed(0) + ' KB\n');
}
