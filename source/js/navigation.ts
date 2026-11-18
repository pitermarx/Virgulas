import type { Node } from './node.js'

// Keyboard navigation over the flat node map, constrained to what is visible:
// `next` drills into open children and walks up past the last sibling; `prev`
// lands on the last open descendant of the previous sibling. Both stop at the
// zoom boundary so navigation never leaves the current view.

export function createNavigation(map: Map<string, Node>, zoomId: { readonly value: string }, rootNodeId: string) {
    function lastOpenChild(id: string): string | null {
        const node = map.get(id)
        if (!node) return null
        const peek = node.peek()
        if (!peek.open || peek.children.length === 0) {
            return node.id
        }

        return lastOpenChild(peek.children[peek.children.length - 1])
    }

    function next(currentId: string, drillDown = true): string | null {
        const node = map.get(currentId)
        if (!node) return null
        if (drillDown) {
            const { open, children } = node.peek()
            if (open && children.length > 0) {
                return children[0]
            }
        }

        const parent = node.parentId ? map.get(node.parentId) : undefined
        if (!parent) return null

        const nextSiblingId = parent.getChild(currentId, 'next')
        if (nextSiblingId) {
            return nextSiblingId
        }

        // Keep keyboard navigation constrained to what is visible in the current zoom context.
        if (parent.id === zoomId.value && zoomId.value !== rootNodeId) {
            return null
        }

        return next(parent.id, false)
    }

    function prev(currentId: string): string | null {
        const node = map.get(currentId)
        if (!node) return null
        const parent = node.parentId ? map.get(node.parentId) : undefined
        if (!parent) return null
        const prevSiblingId = parent.getChild(currentId, 'prev')
        if (prevSiblingId) {
            return lastOpenChild(prevSiblingId)
        }

        if (parent.id === zoomId.value && zoomId.value !== rootNodeId) {
            return null
        }

        return parent.id
    }

    function nextSibling(id: string): string | null | undefined {
        const node = map.get(id)
        if (!node) return null
        const parent = node.parentId ? map.get(node.parentId) : undefined
        if (!parent) return null
        return parent.getChild(id, 'next')
    }

    function prevSibling(id: string): string | null | undefined {
        const node = map.get(id)
        if (!node) return null
        const parent = node.parentId ? map.get(node.parentId) : undefined
        if (!parent) return null
        return parent.getChild(id, 'prev')
    }

    return { next, prev, nextSibling, prevSibling }
}
