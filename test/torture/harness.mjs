/**
 * Shared torture harness for @zakkster/lite-di-graph.
 *
 * Adapted from the generic @zakkster/lite-di-* dependent harness. The ONE
 * material difference from the event-bus / cron harness: lite-di-graph is a
 * FORMATTER. It allocates a fresh string on every call BY CONSTRUCTION -- there
 * is no 0 B/op hot path here and this package never claims one. So the base
 * zero-GC RULES here allow up to ONE major collection over a formatting soak
 * (A-GRAPH-3: maxMajor <= 1), while still gating arrayBuffers growth at 0 (a
 * string formatter must not grow any backing store) and pause time.
 *
 * The alloc-domain control is therefore a LEAK/growth control, not a 0 B/op
 * control: the formatter's output is garbage (collectable), so its RETAINED
 * bytes-per-call is ~0 unless a build deliberately holds the output. DI_ALLOC_BREAK
 * retains every formatted string so retained bytes and arrayBuffers grow, and the
 * gate must reject -- that is the meaningful, trippable alloc-domain control.
 *
 *   - All scratch (containers, snapshots, sinks) is allocated ONCE by the tier,
 *     outside every measured loop.
 *   - `check(cond, thunk)` builds its message only on failure.
 *   - The PRNG is a seeded xorshift32; a thrown fault prints the seed to replay.
 *   - lite-gc-profiler is one-measurement-at-a-time; tiers run STRICTLY
 *     SEQUENTIALLY, never nested.
 *
 * @license MIT
 */

import { measureOps, checkNoGc } from '@zakkster/lite-gc-profiler';

/** Seed for every PRNG in the run. Override with TORTURE_SEED for replay. */
export const SEED = (() => {
    const raw = process.env.TORTURE_SEED;
    if (raw === undefined) return 0x9e3779b9;
    const n = Number(raw) >>> 0;
    return n === 0 ? 1 : n; // xorshift32 must never be seeded with 0
})();

/** Whole-suite control: retain formatted output in the alloc hot body (leak). */
export const BREAK = process.env.DI_TORTURE_BREAK === '1';

/** Alloc-domain control: retain EVERY formatted string so retained/AB bytes grow. */
export const ALLOC_BREAK = process.env.DI_ALLOC_BREAK === '1';

/**
 * Base zero-GC rules for a FORMATTER soak. maxMajor:1 per A-GRAPH-3 (the formatter
 * produces collectable garbage; one major over a 1e4+ soak is bounded, not a
 * leak). arrayBuffers growth stays hard-gated at 0 -- a string formatter allocates
 * NO backing stores, so any AB growth is the retain control biting.
 * `maxArrayBuffersGrowth` needs measureOps `stabilize:'deep'`.
 */
export const RULES = { maxMajor: 1, maxPauseMs: 4, maxArrayBuffersGrowth: 0 };

/**
 * Cross-tier stats, written by the alloc tier (gc + retained alloc) and the soak
 * tier (leak), read by the runner to emit one machine-readable GATE line.
 */
export const STATS = {
    leakSize: 0,
    leakTarget: 0,
    findings: 0,
    warnings: 0,
    gcMajor: 0,
    gcMinor: 0,
    gcMaxMs: 0,
    allocBytesPerOp: 0,
};

/** Seeded xorshift32. Returns a function yielding a uint32 each call. */
export function makePrng(seed) {
    let x = (seed >>> 0) || 1;
    return function next() {
        x ^= x << 13; x >>>= 0;
        x ^= x >> 17;
        x ^= x << 5; x >>>= 0;
        return x >>> 0;
    };
}

/** Fail the whole gate. stdout stays clean; the reason goes to stderr. */
export function die(msg) {
    process.stderr.write('torture: FAIL -- ' + msg +
        '\n  replay: TORTURE_SEED=' + SEED + ' node --expose-gc test/torture.mjs\n');
    process.exit(1);
}

/**
 * Assertion whose message is built ONLY on failure.
 * @param {boolean} cond
 * @param {() => string} msgThunk
 */
export function check(cond, msgThunk) {
    if (!cond) die(msgThunk());
}

/**
 * Run `fn(i)` under a single measured window and gate it against RULES.
 * measureOps with `stabilize:'deep'` makes `maxArrayBuffersGrowth` resolvable.
 *
 * @param {(i:number)=>void} fn      The formatting body under test.
 * @param {{ops:number, warmup?:number}} opts
 */
export function runOpsGate(fn, opts) {
    const res = measureOps(fn, {
        ops: opts.ops,
        warmup: opts.warmup === undefined ? 0 : opts.warmup,
        stabilize: 'deep',
    });
    return {
        report: checkNoGc(res.summary, RULES),
        summary: res.summary,
        bytesPerOp: res.bytesPerOp,
    };
}
