import { signal } from '@preact/signals'
import outline from './outline.js'

// ── Search state ─────────────────────────────────────────────────────────────
// Owned here so both ui.js (rendering) and shortcuts.js (keyboard handling)
// can import without creating a circular dependency.

export const searchQuery = signal('')
export const searchResultIndex = signal(0)
export const currentSearchMatchId = signal(null)

export function resetSearchNavigation() {
    searchResultIndex.value = 0
    currentSearchMatchId.value = null
}

/** Flatten a nested search-result tree to an array of matching node IDs. */
export function flatMatches(node) {
    const acc = []
    if (node.isMatch) acc.push(node.id)
    for (const child of node.children || []) acc.push(...flatMatches(child))
    return acc
}

/**
 * Walk up the ancestor chain from `id` and return the first ancestor that is
 * either collapsed or has no parent — i.e. the node to zoom into when a search
 * result is clicked or confirmed with Enter.
 */
export function getFirstClosedParent(id) {
    if (!id) return null
    const node = outline.get(id)
    if (!node) return null
    if (!node.open.value || !node.parentId) return node.id
    return getFirstClosedParent(node.parentId)
}
