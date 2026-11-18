import type { Node } from './node.js'
import { log } from './utils.js'

// Tree mutations over the flat node map: sibling moves (with the edge
// promotion to the grandparent), indent and outdent. Every operation takes
// the node and its resolved parent, matching outline.update(id, fn)'s call
// shape, and mutates through the node signals so the view reacts.

/**
 * Move a node among its siblings, or out to the grandparent when it is
 * already at the requested edge. `up` lands before the old parent, `down`
 * after it.
 */
export function createTreeOps(map: Map<string, Node>) {
    function moveToSiblingEdge(node: Node, parent: Node | undefined, direction: 'up' | 'down') {
        if (!parent) {
            log('Node has no parent, cannot move')
            return
        }
        const siblings = parent.children.peek()
        const index = siblings.indexOf(node.id)
        const atEdge = direction === 'up' ? index === 0 : index === siblings.length - 1
        if (!atEdge) {
            parent.move(node.id, direction)
            return
        }
        const grandParent = parent.parentId ? map.get(parent.parentId) : undefined
        if (!grandParent) {
            log(`Parent has no grandparent, cannot move ${direction}`)
            return
        }
        parent.removeChild(node.id)
        const parentIndex = grandParent.children.peek().indexOf(parent.id)
        grandParent.addChild(node.id, direction === 'up' ? parentIndex : parentIndex + 1)
        node.update({ parentId: grandParent.id })
    }

    function moveUp(node: Node, parent: Node | undefined) {
        moveToSiblingEdge(node, parent, 'up')
    }

    function moveDown(node: Node, parent: Node | undefined) {
        moveToSiblingEdge(node, parent, 'down')
    }

    function indent(node: Node, parent: Node | undefined) {
        if (!parent) {
            log('Node has no parent, cannot indent')
            return
        }

        const ch = parent.children.peek()
        const index = ch.indexOf(node.id)
        if (index > 0) {
            const newParentId = ch[index - 1]
            const newParent = map.get(newParentId)
            if (!newParent) {
                log('New parent not found, cannot indent')
                return
            }
            parent.removeChild(node.id) // Remove from current parent
            newParent.addChild(node.id) // Add to new parent as last child
            node.update({ parentId: newParent.id }) // Update parentId of the moved node
            newParent.update({ open: true }) // make sure the new parent is open to show the moved node
        } else {
            log('Node is first child, cannot indent')
            return
        }
    }

    function outdent(node: Node, parent: Node | undefined) {
        if (!parent) {
            log('Node has no parent, cannot outdent')
            return
        }
        const grandParent = parent.parentId ? map.get(parent.parentId) : undefined
        if (!grandParent) {
            log('Parent has no grandparent, cannot outdent')
            return
        }
        // get children of parent that are after the current node, and move them to be children of the current node, so that they stay with the current node when it is outdented
        const siblings = parent.children.peek()
        const index = siblings.indexOf(node.id)
        const siblingsToMove = siblings.slice(index + 1)
        const siblingsToStay = siblings.slice(0, index + 1)
        parent.children.value = siblingsToStay
        if (siblingsToMove.length > 0) {
            node.open.value = true // make sure the node is open to show the moved children
            node.children.value = [...node.children.peek(), ...siblingsToMove]
            siblingsToMove.forEach(siblingId => {
                map.get(siblingId)!.update({ parentId: node.id }) // Update parentId of the moved node
            })
        }
        parent.removeChild(node.id) // Remove from current parent
        grandParent.addChild(node.id, grandParent.children.peek().indexOf(parent.id) + 1) // Add to grandparent after the parent
        node.update({ parentId: grandParent.id }) // Update parentId of the moved node
        log('Node outdented successfully')
    }

    return { moveUp, moveDown, indent, outdent }
}
