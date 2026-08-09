/**
 * @zakkster/lite-di-graph -- torture gate.
 *
 * DONE-WHEN is a single command:
 *
 *     node --expose-gc test/torture.mjs        -> prints exactly "ok", exit 0
 *     npm run torture
 *
 * Tiers run STRICTLY SEQUENTIALLY -- lite-gc-profiler is one-measurement-at-a-time,
 * never nested, never concurrent:
 *
 *     T0  exporter laws            T3  lifecycle + fail-closed
 *     T6  bounded alloc (A-GRAPH-3)  T7  soak + lite-leak (A-GRAPH-3)
 *     T9  controls (must be able to fail)
 *
 * lite-di-graph is a FORMATTER: it allocates a fresh string on every call by
 * construction. The alloc gate is therefore BOUNDED (retained bytes/call == 0,
 * arrayBuffers growth == 0, maxMajor <= 1) -- NOT 0 B/op. There is no 0 B/op hot
 * path in this package and none is claimed.
 *
 * A tier signals failure via die() (exits non-zero). In BREAK mode
 * (DI_TORTURE_BREAK or DI_ALLOC_BREAK) the whole suite must exit non-zero; the
 * backstop below trips if a control failed to.
 *
 * @license MIT
 */

import { SEED, BREAK, ALLOC_BREAK, STATS } from './torture/harness.mjs';
import { run as t0 } from './torture/t0-laws.mjs';
import { run as t3 } from './torture/t3-lifecycle.mjs';
import { run as t6 } from './torture/t6-alloc.mjs';
import { run as t7 } from './torture/t7-soak.mjs';
import { run as t9 } from './torture/t9-controls.mjs';

const TIERS = [
    ['T0 laws', t0],
    ['T3 lifecycle', t3],
    ['T6 alloc', t6],
    ['T7 soak', t7],
    ['T9 controls', t9],
];

async function main() {
    if (typeof globalThis.gc !== 'function') {
        process.stderr.write(
            'torture: FAIL -- run with --expose-gc:  node --expose-gc test/torture.mjs\n');
        process.exit(1);
    }

    for (const [name, run] of TIERS) {
        try {
            await run();
        } catch (err) {
            process.stderr.write(
                'torture: FAIL -- ' + name + ' threw: ' + (err && err.stack || err) +
                '\n  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs\n');
            process.exit(1);
        }
    }

    // Reaching here in BREAK mode means a control did not trip -- a fault.
    if (BREAK || ALLOC_BREAK) {
        process.stderr.write(
            'torture: FAIL -- a BREAK env var was set but the gate still passed\n');
        process.exit(1);
    }

    // One machine-readable GATE line on stderr; stdout stays exactly "ok".
    process.stderr.write(
        'GATE leak=size ' + STATS.leakSize + '/' + STATS.leakTarget +
        ' findings=' + STATS.findings + ' warnings=' + STATS.warnings +
        ' | gc major=' + STATS.gcMajor + ' minor=' + STATS.gcMinor +
        ' maxMs=' + STATS.gcMaxMs.toFixed(2) +
        ' | alloc=' + STATS.allocBytesPerOp.toFixed(3) + ' B/op\n');

    process.stdout.write('ok\n');
    process.exit(0);
}

main();
