/**
 * DIGraph.js -- @zakkster/lite-di-graph (v1.0.0)
 *
 * Pure formatters/exporters over a container 2.1.0 `describe()` snapshot. This is
 * a READ-ONLY, post-boot legibility surface: it turns the `{ nodes, edges, order }`
 * snapshot into JSON, Graphviz DOT, or Chrome Trace Event Format. It is NOT a
 * runtime tracer (that is @zakkster/lite-trace) and NOT a validator (boot() already
 * validated the graph before a snapshot can exist).
 *
 * Every exporter is PURE over its snapshot argument -- it never touches container
 * private state. `fromContainer(container)` is the one convenience that reaches a
 * container, and it only calls the PUBLIC `container.describe()`. Exporters fail
 * CLOSED: a malformed snapshot (a missing/renamed nodes/edges/order array, or a
 * node missing token/kind) throws a clear error rather than emitting half-valid
 * output or silently coercing.
 *
 * A formatter ALLOCATES per call by construction (it builds a fresh string). There
 * is no zero-B/op hot path here and this package never claims one. The container's
 * own `describe()` and `get()` are untouched by this code.
 *
 * @license MIT
 */

/** Three-place-synced version string (package.json + VERSION const + llms.txt). */
export const VERSION = '1.0.0';

// The single source of truth for the TYPES integer -> label mapping. Index is the
// TYPES tag: VALUE:0, SINGLETON:1, TRANSIENT:2, FACTORY:3, ALIAS:4. Frozen so a
// consumer cannot mutate the shared table. Kept here and NOWHERE else -- every
// exporter and nodeKind() reads through KIND_NAMES.
export const KIND_NAMES = Object.freeze([
    'VALUE',      // 0
    'SINGLETON',  // 1
    'TRANSIENT',  // 2
    'FACTORY',    // 3
    'ALIAS',      // 4
]);

/**
 * Map a TYPES integer kind to its stable label. Fail closed: an out-of-range or
 * non-integer kind throws rather than returning an "unknown" placeholder that a
 * consumer might trust. This is the ONE place the mapping lives.
 *
 * @param {number} kind The integer entry-type tag (0..4).
 * @returns {string} The stable kind label.
 */
export function nodeKind(kind) {
    if (typeof kind !== 'number' || (kind | 0) !== kind || kind < 0 || kind >= KIND_NAMES.length) {
        throw new TypeError(
            'nodeKind: expected an integer TYPES tag 0..' + (KIND_NAMES.length - 1) +
            ', got ' + describeValue(kind));
    }
    return KIND_NAMES[kind];
}

/**
 * Call the PUBLIC `container.describe()` and return its snapshot. This is the only
 * container-aware helper; the exporters themselves take the snapshot, so a caller
 * can write `toDOT(fromContainer(c))`. Fails closed if handed something without a
 * `describe` method (e.g. a container older than 2.1.0, where describe() does not
 * exist).
 *
 * @param {{ describe: () => object }} container A booted container (>= 2.1.0).
 * @returns {object} The `{ nodes, edges, order }` snapshot.
 */
export function fromContainer(container) {
    if (container == null || typeof container.describe !== 'function') {
        throw new TypeError(
            'fromContainer: expected a container with a describe() method ' +
            '(requires @zakkster/lite-di-container >= 2.1.0), got ' + describeValue(container));
    }
    return container.describe();
}

/**
 * Serialize a snapshot to a stable, round-trippable JSON string. `JSON.parse` of
 * the result yields an object with the same node count, the same edges, and the
 * same order. Each node is emitted with its integer `kind` AND a derived
 * `kindName`; FACTORY/VALUE nodes carry `opaqueDeps: true` so a consumer sees
 * "deps unknown", not "no deps"; ALIAS nodes carry `target`. Deterministic: keys
 * are written in a fixed order, arrays preserve snapshot order. Fails closed on a
 * dangling edge (a `from`/`to` absent from `nodes`) exactly as toDOT/toChromeTrace
 * do, so the round-trippable JSON is never a graph the sibling exporters reject.
 *
 * @param {object} snapshot A `describe()` snapshot.
 * @returns {string} A JSON document.
 */
export function toJSON(snapshot) {
    assertSnapshot(snapshot, 'toJSON');
    const nodes = snapshot.nodes;
    const outNodes = new Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        const rec = {
            token: tokenKey(n.token),
            kind: n.kind,
            kindName: nodeKind(n.kind),
            deps: normalizeDeps(n.deps),
        };
        if (n.opaqueDeps === true) rec.opaqueDeps = true;
        if (n.target !== undefined) rec.target = tokenKey(n.target);
        outNodes[i] = rec;
    }
    // Referential-integrity guard, identical to the ID-resolving exporters: every
    // edge endpoint must name a token present in `nodes`. toJSON emits the display
    // KEY (tokenKey), not the synthetic id, so the resolved id is discarded -- we
    // call resolveNodeId purely for its fail-closed check, so a dangling edge is an
    // error here too and the contract is enforced UNIFORMLY across all exporters.
    const ids = nodeIdentity(nodes);
    const edges = snapshot.edges;
    const outEdges = new Array(edges.length);
    for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        resolveNodeId(ids, e.from, 'toJSON', i, 'from');
        resolveNodeId(ids, e.to, 'toJSON', i, 'to');
        outEdges[i] = { from: tokenKey(e.from), to: tokenKey(e.to) };
    }
    const order = snapshot.order;
    const outOrder = new Array(order.length);
    for (let i = 0; i < order.length; i++) outOrder[i] = tokenKey(order[i]);

    return JSON.stringify({
        format: 'lite-di-graph',
        version: VERSION,
        nodes: outNodes,
        edges: outEdges,
        order: outOrder,
    }, null, 2);
}

/**
 * Serialize a snapshot to a Graphviz `digraph`. Every node is a DOT node labelled
 * with its token and kind name; FACTORY nodes are additionally labelled
 * "deps opaque" so a reader never mistakes an opaque closure for a leaf, and ALIAS
 * nodes show "-> target". Edges are emitted from the snapshot `edges` array (which
 * already excludes VALUE/ALIAS teardown edges -- an alias edge is a resolve edge,
 * not a teardown edge). Node/label text is escaped for DOT.
 *
 * @param {object} snapshot A `describe()` snapshot.
 * @returns {string} A Graphviz DOT document.
 */
export function toDOT(snapshot) {
    assertSnapshot(snapshot, 'toDOT');
    const nodes = snapshot.nodes;
    const edges = snapshot.edges;

    // Identity Map: actual token VALUE -> synthetic id. The synthetic id is the DOT
    // node id (so two distinct same-description symbols never collapse to one node);
    // tokenKey() is used ONLY as the human LABEL.
    const ids = nodeIdentity(nodes);

    let out = 'digraph DIGraph {\n';
    out += '  rankdir=LR;\n';
    out += '  node [shape=box, fontname="monospace"];\n';

    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        // The node's OWN id is its snapshot index -- NOT ids.get(token). Two multi
        // entries share one string token, so a token->id lookup would collapse both
        // declarations onto the last index's id (a node merge). Indexing directly
        // keeps every node declaration distinct. The ids Map is still the right
        // resolver for EDGE endpoints, where a token names the group.
        const id = '"n' + i + '"';
        // Compose the label from ESCAPED dynamic parts joined by literal "\n"
        // sequences (a single backslash-n, which DOT renders as a line break).
        // The "\n" separators must NOT be re-escaped, so they are built here
        // rather than run through dotEscape.
        let label = dotEscape(tokenKey(n.token)) + '\\n(' + nodeKind(n.kind) + ')';
        if (n.opaqueDeps === true) label += '\\ndeps opaque';
        if (n.target !== undefined) label += '\\n-> ' + dotEscape(tokenKey(n.target));
        out += '  ' + id + ' [label="' + label + '"];\n';
    }
    for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        const fromId = resolveNodeId(ids, e.from, 'toDOT', i, 'from');
        const toId = resolveNodeId(ids, e.to, 'toDOT', i, 'to');
        out += '  "' + fromId + '" -> "' + toId + '";\n';
    }
    out += '}\n';
    return out;
}

/**
 * Serialize a snapshot to Chrome Trace Event Format (the object consumed by
 * chrome://tracing / ui.perfetto.dev), returned as a JSON string. A DI graph has
 * no wall-clock timeline, so this is a DOCUMENTED minimal mapping, NOT a real
 * trace: each node becomes a complete ('X') event on a synthetic timeline (ts is
 * the node's teardown-order rank when it is a cached node, else its snapshot
 * index), carrying its kind/opaqueDeps/target/deps in `args`; each edge becomes a
 * matched flow-event pair ('s' at the source, 'f' at the target) so the dependency
 * arrows render as flows. This mirrors the `{ traceEvents, displayTimeUnit }` shape
 * that @zakkster/lite-trace's `toChromeTrace` emits, without depending on it.
 *
 * @param {object} snapshot A `describe()` snapshot.
 * @returns {string} A Chrome Trace Event Format JSON document.
 */
export function toChromeTrace(snapshot) {
    assertSnapshot(snapshot, 'toChromeTrace');
    const nodes = snapshot.nodes;
    const edges = snapshot.edges;
    const order = snapshot.order;

    // Identity Map: actual token VALUE -> synthetic id ('n0', 'n1', ...). Carried on
    // each node event and used as the edge flow endpoints so two DISTINCT
    // same-description symbols never collapse to one entry.
    const ids = nodeIdentity(nodes);

    // Rank cached tokens by teardown order, keyed on the ACTUAL token value (not its
    // string form) so symbol identity is preserved -- two distinct same-description
    // symbols get distinct ranks and never overwrite each other. A token absent from
    // the order falls back to its node index so ts is always defined and stable.
    const rank = new Map();
    for (let i = 0; i < order.length; i++) rank.set(order[i], i);
    const nodeIndex = new Map();
    for (let i = 0; i < nodes.length; i++) nodeIndex.set(nodes[i].token, i);

    const traceEvents = [];
    traceEvents.push({ name: 'process_name', ph: 'M', pid: 1, tid: 1, args: { name: 'lite-di-graph' } });
    traceEvents.push({ name: 'thread_name', ph: 'M', pid: 1, tid: 1, args: { name: 'dependency-graph' } });

    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        // Own id is the snapshot index (see toDOT): a token->id lookup would merge
        // two same-string-token multi entries onto one event id. Edge flow endpoints
        // still resolve through the ids Map, where a token names the group.
        const id = 'n' + i;
        const key = tokenKey(n.token);
        const ts = rank.has(n.token) ? rank.get(n.token) : i;
        const args = { id, kind: n.kind, kindName: nodeKind(n.kind), deps: normalizeDeps(n.deps) };
        if (n.opaqueDeps === true) args.opaqueDeps = true;
        if (n.target !== undefined) args.target = tokenKey(n.target);
        traceEvents.push({ name: key, cat: nodeKind(n.kind), ph: 'X', pid: 1, tid: 1, ts, dur: 1, args });
    }
    for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        // Resolve through the identity Map: fails closed on a dangling endpoint.
        const fromId = resolveNodeId(ids, e.from, 'toChromeTrace', i, 'from');
        const toId = resolveNodeId(ids, e.to, 'toChromeTrace', i, 'to');
        const fromTs = rank.has(e.from) ? rank.get(e.from) : nodeIndex.get(e.from);
        const toTs = rank.has(e.to) ? rank.get(e.to) : nodeIndex.get(e.to);
        traceEvents.push({ name: 'dep', cat: 'edge', ph: 's', id: i, pid: 1, tid: 1, ts: fromTs, args: { from: fromId, to: toId } });
        traceEvents.push({ name: 'dep', cat: 'edge', ph: 'f', id: i, bp: 'e', pid: 1, tid: 1, ts: toTs, args: { from: fromId, to: toId } });
    }

    return JSON.stringify({ displayTimeUnit: 'ns', traceEvents }, null, 2);
}

// ---------------------------------------------------------------------------
// Internal helpers (cold path -- allocation is fine here; a formatter allocates
// by construction). None of these read container private state.
// ---------------------------------------------------------------------------

// Fail closed on a malformed snapshot: the three arrays must exist and be arrays;
// every node must carry a string/symbol token and an integer kind; every edge must
// be an object whose from/to are string/symbol tokens. Throw a clear, named error
// -- never emit partial output, never leak a raw TypeError. `where` names the
// calling exporter. Cold path (runs once per export call) -- element-type checks
// are affordable here.
function assertSnapshot(snapshot, where) {
    if (snapshot == null || typeof snapshot !== 'object') {
        throw new TypeError(where + ': expected a describe() snapshot object, got ' + describeValue(snapshot));
    }
    if (!Array.isArray(snapshot.nodes)) {
        throw new TypeError(where + ": malformed snapshot -- 'nodes' must be an array, got " + describeValue(snapshot.nodes));
    }
    if (!Array.isArray(snapshot.edges)) {
        throw new TypeError(where + ": malformed snapshot -- 'edges' must be an array, got " + describeValue(snapshot.edges));
    }
    if (!Array.isArray(snapshot.order)) {
        throw new TypeError(where + ": malformed snapshot -- 'order' must be an array, got " + describeValue(snapshot.order));
    }
    const nodes = snapshot.nodes;
    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n == null || typeof n !== 'object') {
            throw new TypeError(where + ': malformed snapshot -- node[' + i + '] is not an object (' + describeValue(n) + ')');
        }
        if (!isToken(n.token)) {
            throw new TypeError(where + ': malformed snapshot -- node[' + i +
                "] has an invalid 'token' (" + describeValue(n.token) + '); a token must be a string or symbol');
        }
        if (typeof n.kind !== 'number' || (n.kind | 0) !== n.kind || n.kind < 0 || n.kind >= KIND_NAMES.length) {
            throw new TypeError(where + ': malformed snapshot -- node[' + i +
                "] has an invalid 'kind' (" + describeValue(n.kind) + ')');
        }
    }
    const edges = snapshot.edges;
    for (let i = 0; i < edges.length; i++) {
        const e = edges[i];
        if (e == null || typeof e !== 'object') {
            throw new TypeError(where + ': malformed snapshot -- edge[' + i + '] is not an object (' + describeValue(e) + ')');
        }
        if (!isToken(e.from)) {
            throw new TypeError(where + ': malformed snapshot -- edge[' + i +
                "] has an invalid 'from' (" + describeValue(e.from) + '); an edge endpoint must be a string or symbol');
        }
        if (!isToken(e.to)) {
            throw new TypeError(where + ': malformed snapshot -- edge[' + i +
                "] has an invalid 'to' (" + describeValue(e.to) + '); an edge endpoint must be a string or symbol');
        }
    }
}

// A token is a string or a symbol (container D-15). Nothing else is a valid token.
function isToken(v) {
    return typeof v === 'string' || typeof v === 'symbol';
}

// A token is a string or a symbol (container D-15). Render it as a stable string
// key for serialized output. A symbol becomes its Symbol(description) form so the
// output stays ASCII/JSON-safe and deterministic. Two DISTINCT same-description
// symbols share the SAME string here by design -- this is a display key, never a
// node identity. Node identity is preserved separately via nodeIdentity() keyed on
// the actual token value.
function tokenKey(token) {
    return typeof token === 'symbol' ? token.toString() : token;
}

// Build an identity Map from the ACTUAL token value -> a synthetic stable node id
// ('n0', 'n1', ...) drawn from the node's snapshot index. Keyed on the token VALUE
// so symbol identity is preserved: a string and a symbol behave the same, but two
// DISTINCT same-description symbols get DISTINCT ids and never merge. A snapshot has
// already passed assertSnapshot, so every node token is a valid string/symbol.
function nodeIdentity(nodes) {
    const ids = new Map();
    for (let i = 0; i < nodes.length; i++) ids.set(nodes[i].token, 'n' + i);
    return ids;
}

// Resolve an edge endpoint's token value to its synthetic node id. An endpoint that
// is not present in the node identity Map is a dangling edge -- FAIL CLOSED with the
// clean malformed-snapshot message rather than crashing or silently skipping.
function resolveNodeId(ids, token, where, edgeIndex, field) {
    const id = ids.get(token);
    if (id === undefined) {
        throw new TypeError(where + ': malformed snapshot -- edge[' + edgeIndex + '] ' + field +
            ' references a token absent from nodes (' + describeValue(token) + ')');
    }
    return id;
}

// A node's deps is always an array in a well-formed snapshot; copy it so the
// output never aliases the caller's snapshot array. FACTORY/VALUE/ALIAS carry [].
function normalizeDeps(deps) {
    if (!Array.isArray(deps)) return [];
    const out = new Array(deps.length);
    for (let i = 0; i < deps.length; i++) out[i] = tokenKey(deps[i]);
    return out;
}

// Escape a dynamic string for placement INSIDE a quoted DOT string: backslash and
// double-quote are escaped, and RAW control characters that would break the
// single-physical-line node declaration (newline, carriage return, tab) are folded
// to their two-character DOT escapes. A raw 0x0A in a token would otherwise split a
// node declaration across two physical lines and leak an unquoted line break into
// the label. Caller supplies the surrounding quotes and any literal "\n" line-break
// SEPARATORS -- those are built by the caller AFTER this runs and never pass through
// here, so they are never double-escaped.
function dotEscape(s) {
    let out = '';
    for (let i = 0; i < s.length; i++) {
        const ch = s[i];
        if (ch === '"' || ch === '\\') out += '\\' + ch;
        else if (ch === '\n') out += '\\n';
        else if (ch === '\r') out += '\\r';
        else if (ch === '\t') out += '\\t';
        else out += ch;
    }
    return out;
}

// Compact, safe description of an arbitrary value for an error message. Never
// throws, never stringifies a huge object.
function describeValue(v) {
    if (v === null) return 'null';
    const t = typeof v;
    if (t === 'undefined') return 'undefined';
    if (t === 'string') return "a string '" + (v.length > 32 ? v.slice(0, 32) + '...' : v) + "'";
    if (t === 'number' || t === 'boolean' || t === 'bigint') return t + ' ' + String(v);
    if (t === 'symbol') return v.toString();
    if (Array.isArray(v)) return 'an array (length ' + v.length + ')';
    if (t === 'function') return 'a function';
    return 'an object';
}
