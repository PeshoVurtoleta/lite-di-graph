// Type declarations for @zakkster/lite-di-graph.
// The container is a peer dependency (>= 2.1.0); its snapshot type is imported by name.

import type { DescribeSnapshot } from '@zakkster/lite-di-container';

/** Three-place-synced version string (package.json + VERSION const + llms.txt). */
export declare const VERSION: string;

/**
 * The TYPES integer -> label mapping, indexed by tag
 * (VALUE:0, SINGLETON:1, TRANSIENT:2, FACTORY:3, ALIAS:4). Frozen; the single
 * source of truth every exporter reads through.
 */
export declare const KIND_NAMES: readonly ['VALUE', 'SINGLETON', 'TRANSIENT', 'FACTORY', 'ALIAS'];

/** The stable kind labels {@link nodeKind} returns. */
export type KindName = (typeof KIND_NAMES)[number];

/**
 * Map a TYPES integer kind to its stable label. Throws a TypeError on an
 * out-of-range or non-integer kind (fail closed -- never an "unknown" placeholder).
 */
export declare function nodeKind(kind: number): KindName;

/**
 * Call the PUBLIC `container.describe()` and return its snapshot, so a caller can
 * write `toDOT(fromContainer(c))`. Throws if handed something without a
 * `describe()` method (e.g. a container older than 2.1.0).
 */
export declare function fromContainer(container: { describe(): DescribeSnapshot }): DescribeSnapshot;

/**
 * Serialize a snapshot to a stable, round-trippable JSON string. `JSON.parse` of
 * the result preserves node count, edges, and order; each node carries its integer
 * `kind` plus a derived `kindName`, FACTORY/VALUE nodes keep `opaqueDeps: true`,
 * and ALIAS nodes keep `target`. Throws on a malformed snapshot (fail closed).
 */
export declare function toJSON(snapshot: DescribeSnapshot): string;

/**
 * Serialize a snapshot to a Graphviz `digraph`. Nodes are labelled with token +
 * kind name; FACTORY nodes are labelled "deps opaque"; ALIAS nodes show their
 * target. Edges come from the snapshot `edges` array. Throws on a malformed
 * snapshot (fail closed).
 */
export declare function toDOT(snapshot: DescribeSnapshot): string;

/**
 * Serialize a snapshot to Chrome Trace Event Format (a `{ traceEvents,
 * displayTimeUnit }` object) as a JSON string, for chrome://tracing / Perfetto. A
 * DI graph has no wall clock, so this is a documented minimal mapping: nodes are
 * complete ('X') events on a synthetic timeline (ts = teardown rank or node
 * index), edges are matched flow-event pairs. Throws on a malformed snapshot.
 */
export declare function toChromeTrace(snapshot: DescribeSnapshot): string;
