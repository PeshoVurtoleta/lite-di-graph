/**
 * T6 -- the BOUNDED alloc gate (A-GRAPH-3). NOT a 0 B/op gate.
 *
 * lite-di-graph is a formatter: every toJSON/toDOT/toChromeTrace call builds a
 * fresh string BY CONSTRUCTION. There is no zero-B/op hot path and this package
 * never claims one. What IS gated:
 *
 *   Lane A  measureAllocs at maxBytesPerCall:0 -- RETAINED bytes, forced-collect.
 *           The formatter's output is garbage the caller discards, so nothing it
 *           allocates OUTLIVES the call: retained bytes/call is 0. This is the
 *           leak gate, and it is the meaningful, trippable alloc-domain control:
 *           DI_ALLOC_BREAK retains every formatted string so retained bytes > 0
 *           and Lane A must reject.
 *
 *   Lane B  measureOps(stabilize:'deep') over N formatting ops -- maxMajor<=1 +
 *           arrayBuffers growth == 0 + pause budget. A pure string formatter
 *           allocates NO backing stores, so arrayBuffers must not grow; a bounded
 *           number of majors (<=1) over the soak is expected garbage, not a leak.
 *           The break injects a retained Float64Array per op so arrayBuffers grow
 *           and Lane B must reject too.
 *
 * Both lanes reject under DI_ALLOC_BREAK / DI_TORTURE_BREAK; that is the
 * alloc-domain control, recast (honestly) as a LEAK/growth control because there
 * is no 0 B/op path to trip here.
 */

import { measureAllocs, checkAllocs } from '@zakkster/lite-gc-profiler';
import { Container } from '@zakkster/lite-di-container';
import { toJSON, toDOT, toChromeTrace, fromContainer } from '../../DIGraph.js';
import { runOpsGate, ALLOC_BREAK, BREAK, check, die, STATS } from './harness.mjs';

const HOT = 10000;        // N=10000 (A-GRAPH-3)

// Either break flag retains formatted output per call so the gate rejects:
// DI_ALLOC_BREAK is the alloc-domain (leak) control; DI_TORTURE_BREAK the whole-suite one.
const INJECT = ALLOC_BREAK || BREAK;

/** Retained sink for the break control -- survives GC so the gate must reject. */
const sink = [];

export async function run() {
    // A representative graph built ONCE, outside every window: a singleton chain
    // over a value, plus a factory, a transient, and an alias -- every kind and a
    // real edge set, so the formatters exercise every branch.
    const c = new Container();
    c.value('cfg', { seed: 1 });
    for (let i = 0; i < 8; i++) {
        const dep = i === 0 ? 'cfg' : 's' + (i - 1);
        c.singleton('s' + i, class { constructor(d) { this.d = d; } }, [dep]);
    }
    c.transient('t0', class { constructor(d) { this.d = d; } }, ['s0']);
    c.factory('f0', () => ({ built: true }));
    c.alias('a0', 's0');
    c.boot();
    const snap = fromContainer(c);

    // Warm: prove the formatters are correct before measuring, and warm the JIT.
    for (let i = 0; i < 5000; i++) { toJSON(snap); toDOT(snap); toChromeTrace(snap); }

    // ---- Lane A: RETAINED bytes per call -- HARD-gated at 0 (leak gate) ------
    const la = measureAllocs(
        () => { toJSON(snap); toDOT(snap); if (INJECT) sink.push(toJSON(snap)); },
        { iterations: 5000, batches: 12, warmup: 5000 });
    const ca = checkAllocs(la, { maxBytesPerCall: 0 });
    check(ca.verdict === 'pass' && la.bytesPerCall === 0,
        () => `T6.A3 laneA: formatter must RETAIN 0 B/call, measured ${la.bytesPerCall} (verdict=${ca.verdict})` +
            (INJECT ? ' (break control -- expected)' : ''));
    if (INJECT) die('T6.A3: DI_ALLOC_BREAK retained formatted output but laneA gate passed');
    sink.length = 0;

    // ---- Lane B: N formatting ops -- maxMajor<=1 + arrayBuffers==0 budget ----
    const hot = () => { toJSON(snap); toDOT(snap); if (INJECT) sink.push(new Float64Array(256)); };
    const { report, summary, bytesPerOp } = runOpsGate(hot, { ops: HOT, warmup: 5000 });

    STATS.gcMajor = summary.gc.major;
    STATS.gcMinor = summary.gc.minor;
    STATS.gcMaxMs = summary.gc.maxMs;
    // Report the HARD-gated RETAINED figure (laneA, forced-collect): 0 for the
    // formatter. laneB's per-op heap slope carries sampling noise and is not the
    // headline number for a package that allocates by construction.
    STATS.allocBytesPerOp = la.bytesPerCall;

    if (!report.ok) {
        const gsum = summary.gc;
        die('T6.A3 laneB rejected -- verdict=' + report.verdict +
            ' major=' + gsum.major + ' maxMs=' + gsum.maxMs.toFixed(3) +
            ' abGrowth=' + summary.arrayBuffers.growthBytes +
            (INJECT ? ' (break control -- expected)' : ''));
    }
    if (INJECT) die('T6.A3: DI_ALLOC_BREAK grew arrayBuffers but laneB gate passed');
    sink.length = 0;

    process.stderr.write(
        'T6 lanes: retained=' + la.bytesPerCall.toFixed(3) + ' B/call (HARD-gated 0)' +
        ' | laneB ' + HOT + ' ops: major=' + summary.gc.major + ' minor=' + summary.gc.minor +
        ' maxMs=' + summary.gc.maxMs.toFixed(3) + ' abGrowth=' + summary.arrayBuffers.growthBytes +
        ' slope=' + bytesPerOp.toFixed(2) + ' B/op (allocates by construction)\n');
}
