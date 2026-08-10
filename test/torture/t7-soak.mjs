/**
 * T7 -- soak and retention (A-GRAPH-3). The AUTHORITY is FINALIZATION, not a counter
 * trick.
 *
 * N=10000 full build/discard cycles: each cycle builds a FRESH container, boots it,
 * takes a describe() snapshot, formats it three ways (toJSON/toDOT/toChromeTrace),
 * discards every string, shuts the container down, and tracks the SNAPSHOT with
 * lite-leak WITHOUT untracking it. The cleanup (NOOP) and tag (numeric cyc) capture
 * NOTHING (held-value contract), so the snapshot is held only WEAKLY by the tracker's
 * FinalizationRegistry. After the loop we settle HARD (>= 10 gc()+tick passes); a
 * snapshot that was really released is collected and decrements size(), one a formatter
 * pinned (cached input or output) is not. tracker.size() is then the count of snapshots
 * V8 could NOT reclaim -- the real leak witness.
 *
 * (An earlier track+immediate-untrack was VACUOUS: unregister decrements the live
 * counter synchronously, netting size() to 0 every cycle even if every snapshot were
 * retained forever, and the retention lane carried NO break control at all. Fixed here
 * per the promotion-ladder gate 2 -- a retention gate must FAIL on a retained object.)
 *
 * lite-di-graph is stateless functions -- there is no dispose() surface -- so the ONLY
 * retention risk is a formatter accidentally holding its input snapshot or its output
 * string. This tier proves neither happens.
 *
 * AUTHORITY GATE: tracker.size() <= RES with a clean audit, RES = max(16, CYCLES/1000).
 * DI_TORTURE_BREAK=1 retains each snapshot in a module-level sink so it can NEVER be
 * finalized -> size() stays ~CYCLES and BLOWS RES, tripping the residual gate DIRECTLY.
 * (In a full run an earlier tier's control may trip first; the soak gate is proven in
 * isolation: DI_TORTURE_BREAK=1 node -e "import('./test/torture/t7-soak.mjs').then(m=>m.run())".)
 *
 * SECONDARY (NOT the authority): a coarse heap-delta backstop bounding one-time growth
 * only -- deliberately loose. Tracking without untracking holds ~CYCLES leakRecords as
 * live working set, so the delta is heap-position-dependent; it catches only runaway.
 * Sub-phase 2 is an independent retain-then-release heap witness (unchanged).
 */

import { Container } from '@zakkster/lite-di-container';
import { createLeakTracker } from '@zakkster/lite-leak';
import { toJSON, toDOT, toChromeTrace, fromContainer } from '../../DIGraph.js';
import { check, BREAK, STATS } from './harness.mjs';

const CYCLES = 10000;     // N=10000 (A-GRAPH-3)
const NODES = 8;

/** AUTHORITY residual ceiling. Clean leaves single digits; a real leak leaves ~CYCLES. */
const RES = Math.max(16, (CYCLES / 1000) | 0); // 16

// SECONDARY loose catastrophe backstop (NOT the authority -- the residual is). Bounds
// ONE-TIME growth well above the observed plateau; re-anchored after measuring (see
// banner). Tracking without untracking holds ~CYCLES leakRecords live.
const HEAP_DELTA_LIMIT = 2 * 1024 * 1024;
const NOOP = function () {};

/** BREAK: retains each snapshot so it can NEVER be finalized -> size() stays ~CYCLES. */
const sink = [];

/** Hard settle: run FinalizationRegistry callbacks to ground before reading size(). */
async function settleHard() {
    for (let i = 0; i < 10; i++) {
        globalThis.gc();
        await new Promise((r) => setTimeout(r, 15));
    }
}

export async function run() {
    const tracker = createLeakTracker({
        name: 'graph-soak',
        onWarning: () => { STATS.warnings++; },
    });

    globalThis.gc();
    const heapBaseline = process.memoryUsage().heapUsed;

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

        await c.shutdown();

        // AUTHORITY: track the SNAPSHOT without untracking. cleanup/tag capture nothing
        // (held-value contract), so finalization decides its fate. A released snapshot
        // is collected (size--); a formatter-pinned one is not.
        tracker.track(snap, NOOP, cyc);
        if (BREAK) sink.push(snap); // pin -> can NEVER be finalized -> size() stays ~CYCLES.
    }

    await settleHard();

    const residual = tracker.size();
    const findings = tracker.audit();
    STATS.leakSize = residual;
    STATS.leakTarget = RES;
    STATS.findings = findings.length;

    check(findings.length === 0, () => `T7: lite-leak reported ${findings.length} findings`);
    // AUTHORITY: finalization residual. A real leak (pinned snapshot) leaves ~CYCLES.
    check(residual <= RES,
        () => `T7: AUTHORITY finalization residual size()=${residual} > ${RES} -- a snapshot outlived its cycle`);

    const heapAfter = process.memoryUsage().heapUsed;
    const delta = heapAfter - heapBaseline;
    // SECONDARY (NOT the authority): coarse one-time-growth backstop.
    check(delta < HEAP_DELTA_LIMIT,
        () => `T7.heap: (secondary) soak heap delta ${(delta / 1024).toFixed(1)} KB >= ${(HEAP_DELTA_LIMIT / 1024)} KB`);

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
    // Sanity: the formatter is deterministic -- the same snapshot yields equal output
    // across the batch (value equality; not a claim about instance identity).
    check(held[0] === held[BATCH - 1], () => 'T7.hold: deterministic formatter produced diverging output');

    for (let i = 0; i < BATCH; i++) held[i] = null; // release
    await c2.shutdown();
    globalThis.gc();
    const holdFinal = process.memoryUsage().heapUsed;
    check(holdFinal <= 2 * holdBaseline,
        () => `T7.hold: heap ${(holdFinal / 1024).toFixed(0)} KB > 2x baseline ${(holdBaseline / 1024).toFixed(0)} KB after release`);

    process.stderr.write('T7 soak: ' + CYCLES + ' build/format/discard cycles clean' +
        ' | AUTHORITY residual size()=' + residual + '/' + RES + ' findings=' + findings.length +
        ' | (secondary) heap delta=' + (delta / 1024).toFixed(1) + ' KB\n');
}
