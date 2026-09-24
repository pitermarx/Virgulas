import { signal, computed } from '@preact/signals'
import outline, { type SearchMatch } from './outline.js'

// ── Search state ─────────────────────────────────────────────────────────────
// Owned here so both ui.js (rendering) and shortcuts.js (keyboard handling)
// can import without creating a circular dependency.

export const searchQuery = signal('')
export const searchResultIndex = signal(0)
export const currentSearchMatchId = signal<string | null>(null)

export function resetSearchNavigation() {
    searchResultIndex.value = 0
    currentSearchMatchId.value = null
}

export interface SearchResults {
    /** Matching node ids in document order; what keyboard navigation cycles. */
    ids: string[]
    /** Result tree for the results panel, or null when there is no query. */
    tree: SearchMatch | null
}

const NO_RESULTS: SearchResults = { ids: [], tree: null }

/**
 * The search walk is shared through a single-slot `computed`, so the toolbar
 * counter, the results panel and the keyboard handler all reuse one traversal
 * instead of each rebuilding the tree (it used to run three times per keystroke).
 *
 * A `computed` memoizes exactly one value, so this cannot accumulate a result per
 * query the way a Map keyed by query would.
 *
 * `search()` deliberately reads nodes with `peek()` so it does not subscribe to
 * every node in the document, which also means it subscribes to nothing: the
 * invalidation signals have to be read explicitly or this would go stale.
 * Same set as `groupedTasks` (tasks.ts): `dirtyWrites` increments synchronously on
 * every mutation while `dataVersion` is debounced, and `structureVersion` covers a
 * reset/deserialize that restores an equal `dataVersion`.
 */
export const searchResults = computed<SearchResults>(() => {
    const query = searchQuery.value
    if (!query) return NO_RESULTS

    void outline.dirtyWrites.value
    void outline.structureVersion.value

    const tree = outline.search(query)
    return { ids: flatMatches(tree), tree }
})

/** Flatten a nested search-result tree to an array of matching node IDs. */
export function flatMatches(node: SearchMatch): string[] {
    const acc: string[] = []
    if (node.isMatch) acc.push(node.id)
    for (const child of node.children || []) acc.push(...flatMatches(child))
    return acc
}

/**
 * Walk up the ancestor chain from `id` and return the first ancestor that is
 * either collapsed or has no parent — i.e. the node to zoom into when a search
 * result is clicked or confirmed with Enter.
 */
export function getFirstClosedParent(id: string | null): string | null {
    if (!id) return null
    const node = outline.get(id)
    if (!node) return null
    if (!node.open.value || !node.parentId) return node.id
    return getFirstClosedParent(node.parentId)
}
