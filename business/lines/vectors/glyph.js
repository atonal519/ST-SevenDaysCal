import { parseVectorCue } from './codec.js';

const POOL_NODE = Object.freeze({
    setting: Object.freeze({ x: 6, y: 5 }),
    subject: Object.freeze({ x: 16, y: 5 }),
    timing: Object.freeze({ x: 20, y: 12 }),
    relation: Object.freeze({ x: 17, y: 18 }),
    resource: Object.freeze({ x: 10, y: 20 }),
    external: Object.freeze({ x: 4, y: 17 }),
});
const NODE_ORDER = Object.freeze(['setting', 'subject', 'timing', 'relation', 'resource', 'external']);

/** Build the compact six-node model used by the original sigil preview. */
export function vectorGlyphModel(value) {
    const parsed = parseVectorCue(value);
    if (!parsed || parsed.length !== 3) return null;
    const selected = new Set(parsed.map(item => item.poolId));
    if (selected.size !== 3 || [...selected].some(poolId => !POOL_NODE[poolId])) return null;
    const nodes = NODE_ORDER.map(poolId => Object.freeze({ ...POOL_NODE[poolId], selected: selected.has(poolId) }));
    const chosen = NODE_ORDER.filter(poolId => selected.has(poolId));
    const edges = Object.freeze([
        Object.freeze([POOL_NODE[chosen[0]], POOL_NODE[chosen[1]]]),
        Object.freeze([POOL_NODE[chosen[0]], POOL_NODE[chosen[2]]]),
        Object.freeze([POOL_NODE[chosen[1]], POOL_NODE[chosen[2]]]),
    ]);
    return Object.freeze({ nodes: Object.freeze(nodes), edges });
}

/** Return a stable, safe, decorative square glyph for a valid vector Cue. */
export function vectorGlyphSvg(value) {
    const model = vectorGlyphModel(value);
    if (!model) return '';
    const edges = model.edges.map(([from, to]) => `<line class="sp-line-glyph-edge" x1="${from.x}" y1="${from.y}" x2="${to.x}" y2="${to.y}" />`).join('');
    const nodes = model.nodes.map(node => `<circle class="sp-line-glyph-node${node.selected ? ' sp-line-glyph-node-selected' : ''}" cx="${node.x}" cy="${node.y}" r="1.35" />`).join('');
    return `<svg class="sp-line-vector-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${edges}${nodes}</svg>`;
}

export const renderVectorGlyph = vectorGlyphSvg;

/** Synchronize only already-mounted glyphs with the host theme. */
export function syncVectorGlyphTheme(root, theme, forced = false) {
    const host = root?.querySelectorAll ? root : null;
    if (!host || (theme !== 'day' && theme !== 'night')) return 0;
    const classes = ['sp-day', 'sp-night', 'sp-forced-day', 'sp-forced-night'];
    let count = 0;
    host.querySelectorAll('.sp-line-vector-glyph').forEach(glyph => {
        glyph.classList.remove(...classes);
        glyph.classList.add(`sp-${theme}`);
        if (forced) glyph.classList.add(`sp-forced-${theme}`);
        count++;
    });
    return count;
}
