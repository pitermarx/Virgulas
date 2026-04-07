import { signal, effect, createModel } from "@preact/signals"
import { randomId } from "./crypto2.js";
import { log } from './utils.js';

// The document structure is an infinite tree of nodes
// a node is { id: string, parentId: string, text: string, description: string, children: string[], open: boolean }
// the nodes are stored in a flat map { [id: string]: node }
// there is always a root node with id 'root' and parentId null
// the node properties are signals, so that we can update them individually without replacing the whole doc
// the manipulations on the doc are done by updating the signals, and the view will react to the changes

const NodeModel = createModel((model = {}) => {
    const id = model.id
    if (!id) {
        throw new Error('Node must have an id')
    }
    let parentId = model.parentId
    const text = signal(model.text || '')
    const description = signal(model.description || '')
    const children = signal(model.children || [])
    const open = signal(model.open === undefined ? true : !!model.open)

    return {
        get id() {
            return id
        },
        get parentId() {
            return parentId
        },
        get text() {
            return text
        },
        get description() {
            return description
        },
        get children() {
            return children
        },
        get open() {
            return open
        },
        get value() {
            return {
                id,
                parentId,
                text: text.value,
                description: description.value,
                children: children.value,
                open: open.value
            }
        },
        peek() {
            return {
                id,
                parentId,
                text: text.peek(),
                description: description.peek(),
                children: children.peek(),
                open: open.peek()
            }
        },
        toggleOpen() {
            open.value = !open.peek()
        },
        update(update) {
            if (update.text !== undefined) text.value = update.text
            if (update.description !== undefined) description.value = update.description
            if (update.parentId !== undefined) parentId = update.parentId
            if (update.open !== undefined) open.value = !!update.open
        },
        removeChild(childId) {
            children.value = children.peek().filter(id => id !== childId)
        },
        addChild(childId, index = -1) {
            const peek = children.peek()
            if (index < 0 || index >= peek.length) {
                children.value = [...peek, childId]
            } else {
                children.value = [...peek.slice(0, index), childId, ...peek.slice(index)]
            }
        },
        move(childId, direction = 'up') {
            const peek = children.peek()
            const index = peek.indexOf(childId)
            if (index === -1) {
                log('Child not found, cannot move')
                return
            }
            if (direction === 'up' && index > 0) {
                const newChildren = [...peek]
                const temp = newChildren[index - 1]
                newChildren[index - 1] = newChildren[index]
                newChildren[index] = temp
                children.value = newChildren
            } else if (direction === 'down' && index < peek.length - 1) {
                const newChildren = [...peek]
                const temp = newChildren[index + 1]
                newChildren[index + 1] = newChildren[index]
                newChildren[index] = temp
                children.value = newChildren
            } else {
                log('Cannot move child in that direction')
                return
            }
        },
        getChild(currentChildId, direction = 'next') {
            const peek = children.peek()
            const index = peek.indexOf(currentChildId)
            if (index === -1) {
                log('Child not found, cannot get sibling')
                return null
            }
            if (direction === 'prev') {
                if (index <= 0) {
                    return null
                }
                return peek[index - 1]

            }
            else if (direction === 'next') {
                if (index === peek.length - 1) {
                    return null
                }
                return peek[index + 1]
            }
        },
    }
});

const OutlineModel = createModel(() => {
    const rootNodeId = 'root'
    const modelVersion = 'v1' // for future compatibility, in case we need to change the structure
    const dataVersion = signal(0) // incremented on every change, but debounced to avoid excessive updates during rapid changes
    const dirtyWrites = signal(0) // mark if there are unsaved changes, used to trigger version update
    const map = new Map()
    const zoomId = signal(rootNodeId) // the currently zoomed in node, used for rendering and keyboard navigation

    function getNewId() {
        let id = randomId()
        for (let i = 0; i < 5; i++) { // in the unlikely event of a collision, try up to 5 times to generate a unique id
            if (!map.has(id)) {
                return id
            }
            log('Collision detected for id:', id, 'generating a new one')
            id = randomId()
        }

        throw new Error('Failed to generate a unique id after 5 attempts, this is extremely unlikely. Consider using a more robust id generation strategy if this happens frequently.')
    }

    function setVersion(newVersion) {
        dataVersion.value = newVersion
        dirtyWrites.value = 0
    }

    function addChild(parentId, optionalData = {}, previousSiblingId) {
        const parent = map.get(parentId || zoomId.value)
        if (!parent) {
            console.error('Parent node not found, cannot add new node')
            return
        }

        // I think if i remove this, i just get synchronized nodes, which is cool, 
        // but needs more tests to make sure there are no edge cases where it causes problems
        // so for now I'm keeping this check in place to prevent potential issues with duplicate ids
        if (optionalData.id && map.has(optionalData.id)) {
            console.error('Node with id already exists, cannot add new node with duplicate id')
            return
        }

        const node = new NodeModel({
            parentId: parent.id,
            id: optionalData.id || getNewId(),
            text: optionalData.text,
            description: optionalData.description,
            open: optionalData.open
        })
        map.set(node.id, node)

        const baseIndex = parent.children.peek().indexOf(previousSiblingId)
        const idx = baseIndex === -1 ? -1 : baseIndex + 1
        parent.addChild(node.id, idx)

        dirtyWrites.value = dirtyWrites.peek() + 1
        return node
    }

    function deleteNode(id, force) {
        if (id === zoomId.value) {
            log('Cannot delete the current node at the root level')
            return
        }


        function innerDelete(n) {
            if (n) {
                const ch = n.children.peek()
                if (ch) ch.map(i => map.get(i)).forEach(innerDelete)
                map.delete(n.id)
                n[Symbol.dispose]()
            }
        }

        const node = map.get(id)
        if (!node) {
            return
        }

        const parent = map.get(node.parentId)
        if (parent) {
            if (parent.children.peek().length === 1 && parent.id === zoomId.value && !force) {
                log('Cannot delete the only child of the root node, skipping deletion to prevent empty outline')
                node.text.value = '' // instead of deleting the node, just clear its text to keep the outline from being empty
                const ch = node.children.peek()
                if (ch)
                    ch.map(i => map.get(i)).forEach(deleteNode)
            }
            else {
                innerDelete(node)
                parent.removeChild(id)
            }
        }

        dirtyWrites.value = dirtyWrites.peek() + 1
    }

    function reset() {
        zoomId.value = rootNodeId
        const root = map.get(rootNodeId);
        if (root) {
            const topLevel = root.children.peek()
            topLevel.forEach(deleteNode)
            root[Symbol.dispose]()
            map.delete(rootNodeId)
        }
        if (map.size > 0) {
            log('Warning: map not empty after reset, clearing remaining nodes')
            map.clear()
        }
        map.set(rootNodeId, new NodeModel({ id: rootNodeId }))
        setVersion(0)
    }

    function serialize(pretty = false) {
        return JSON.stringify({
            modelVersion,
            dataVersion: dataVersion.peek(),
            nodes: [...map.values()]
                .map(node => node.peek())
                .map(node => ({
                    id: node.id,
                    parentId: node.parentId,
                    text: node.text,
                    description: node.description === '' ? undefined : node.description, // omit description if empty to save space
                    children: node.children.length > 0 ? node.children : undefined, // omit children if empty to save space
                    open: node.open === true ? undefined : node.open, // omit open if true to save space, since most nodes are open by default
                }))
        }, null, pretty ? 2 : 0)
    }

    function deserialize(json) {
        log('Deserializing outline, version:', dataVersion.value)
        const obj = JSON.parse(json)
        if (obj.modelVersion !== modelVersion) {
            throw new Error(`Unsupported model version: ${obj.modelVersion}`)
        }
        if (!obj.nodes || typeof obj.nodes !== 'object') {
            throw new Error('Invalid data format: missing nodes')
        }

        const nodes = Object.fromEntries(obj.nodes.map(n => [n.id, n]))
        if (nodes[rootNodeId] === undefined) {
            throw new Error('Invalid data format: missing root node')
        }

        const visitedChildren = new Set()

        function validateNode(nodeData) {
            const isRoot = !nodeData.parentId && nodeData.id === rootNodeId
            const parent = nodes[nodeData.parentId]
            if (!isRoot && !parent) {
                log(`Node with id ${nodeData.id} has invalid parent, skipping`)
                return false
            }

            // children should be an array of valid ids
            nodeData.children = (nodeData.children || []).filter(childId => {
                // child should not be itself
                if (childId === nodeData.id) {
                    log(`Node with id ${nodeData.id} has itself as child, skipping child ${childId}`)
                    return false
                }
                // child should exist in the node list
                const child = nodes[childId]
                if (!child) {
                    log(`Node with id ${nodeData.id} has invalid child ${childId}, skipping child`)
                    return false
                }
                // children's parentId should be the current node
                if (child.parentId !== nodeData.id) {
                    log(`Node with id ${nodeData.id} has child ${childId} whose parentId is ${child.parentId}, skipping child`)
                    return false
                }
                // child should not be a duplicate
                if (visitedChildren.has(childId)) {
                    log(`Node with id ${nodeData.id} has duplicate child ${childId}, skipping duplicate child`)
                    return false
                }
                visitedChildren.add(childId)
                return true
            })

            return true
        }

        const validNodes = Object.values(nodes).filter(validateNode)
        reset()
        map.get(rootNodeId).children.value = validNodes.filter(n => n.parentId === rootNodeId).map(n => n.id)

        for (const nodeData of validNodes) {
            if (nodeData.id === rootNodeId) continue // root node is already created with its children, so we can skip it in the loop
            map.set(nodeData.id, new NodeModel({
                id: nodeData.id,
                parentId: nodeData.parentId,
                text: nodeData.text,
                description: nodeData.description,
                children: nodeData.children,
                open: nodeData.open
            }))
        }
        if (zoomId.value !== rootNodeId && !map.has(zoomId.value)) {
            log(`Zoomed node ${zoomId.value} not found in deserialized data, resetting zoom to root`)
            zoomId.value = rootNodeId
        }
        setVersion(obj.dataVersion || 0)
    }

    function update(id, fn) {
        const node = map.get(id)
        if (!node) {
            log('Node not found, cannot update')
            return
        }
        fn(node, map.get(node.parentId))
        dirtyWrites.value = dirtyWrites.peek() + 1
    }

    function moveUp(node, parent) {
        if (!parent) {
            log('Node has no parent, cannot move')
            return
        }
        const index = parent.children.peek().indexOf(node.id)
        if (index > 0) {
            parent.move(node.id, 'up')
        } else {
            // try to move to grandparent level
            const grandParent = map.get(parent.parentId)
            if (grandParent) {
                parent.removeChild(node.id) // Remove from current parent
                const parentIndex = grandParent.children.peek().indexOf(parent.id)
                grandParent.addChild(node.id, parentIndex) // Add to grandparent before the parent
                node.update({ parentId: grandParent.id }) // Update parentId of the moved node
            } else {
                log('Parent has no grandparent, cannot move up')
                return
            }
        }
    }

    function moveDown(node, parent) {
        if (!parent) {
            log('Node has no parent, cannot move')
            return
        }
        const ch = parent.children.peek()
        const index = ch.indexOf(node.id)
        if (index < ch.length - 1) {
            parent.move(node.id, 'down')
        } else {
            // try to move to grandparent level
            const grandParent = map.get(parent.parentId)
            if (grandParent) {
                parent.removeChild(node.id) // Remove from current parent
                const parentIndex = grandParent.children.peek().indexOf(parent.id)
                grandParent.addChild(node.id, parentIndex + 1) // Add to grandparent after the parent
                node.update({ parentId: grandParent.id }) // Update parentId of the moved node
            } else {
                log('Parent has no grandparent, cannot move down')
                return
            }
        }
    }

    function indent(node, parent) {
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

    function outdent(node, parent) {
        if (!parent) {
            log('Node has no parent, cannot outdent')
            return
        }
        const grandParent = map.get(parent.parentId)
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
                map.get(siblingId).update({ parentId: node.id }) // Update parentId of the moved node
            })
        }
        parent.removeChild(node.id) // Remove from current parent
        grandParent.addChild(node.id, grandParent.children.peek().indexOf(parent.id) + 1) // Add to grandparent after the parent
        node.update({ parentId: grandParent.id }) // Update parentId of the moved node
        log('Node outdented successfully')
    }

    function getVMD(nodeId, level = 0) {
        const node = map.get(nodeId)
        if (!node) return ''
        const peek = node.peek()

        let result = '';
        const ch = peek.children
        level = nodeId === rootNodeId || level < 0 ? -1 : level // root node is not rendered, so it doesn't add to the indent level
        if (level >= 0) {
            const indent = '  '.repeat(level);
            const bullet = (ch.length > 0 && !peek.open) ? '+' : '-';
            result += `${indent}${bullet} ${peek.text}\n`;

            if (peek.description) {
                const descIndent = '  '.repeat(level + 1);
                const lines = peek.description.split('\n');
                for (const line of lines) {
                    result += `${descIndent}${line}\n`;
                }
            }
        }

        for (const child of ch) {
            result += getVMD(child, level + 1);
        }

        return result;
    }

    function setVMD(text, nodeId) {
        if (nodeId === rootNodeId) {
            log('Cannot set VMD on root node, skipping')
            return
        }
        const node = map.get(nodeId)
        if (!node) {
            log('Node not found, cannot set VMD')
            return
        }
        const parent = map.get(node.parentId)
        if (!parent) {
            log('Parent node not found, cannot set VMD')
            return
        }
        const stack = [{ node: parent, indentLevel: -1 }, { node, indentLevel: 0 }];
        const ser = serialize()
        try {
            // delete existing children before parsing new ones
            node.children.peek().forEach(deleteNode)

            const lines = text.split(/\r?\n/);
            let firstLine = true
            for (const line of lines) {
                if (!line.trim()) continue;

                // Match regular bullet points (-, +)
                const match = line.match(/^(\s*)([-+])(.*)$/);
                if (match) {
                    const [, indentStr, bullet, text] = match;
                    const nodeData = { text: text.trim(), open: bullet === '-' }

                    // Pop stack until we find the correct parent level
                    while (stack.length > 1 && stack[stack.length - 1].indentLevel >= indentStr.length) {
                        if (!firstLine) stack.pop();
                        else break
                    }

                    const lastOnStack = stack[stack.length - 1]
                    if (lastOnStack.indentLevel === indentStr.length) {
                        lastOnStack.node.update(nodeData)
                    } else {
                        const c = lastOnStack.node.children.peek()
                        const prevSiblingId = c[c.length - 1]
                        let lastNode = addChild(lastOnStack.node.id, nodeData, prevSiblingId)
                        stack.push({ node: lastNode, indentLevel: indentStr.length });
                    }
                } else {
                    // Handle description lines (indented content without bullets)
                    const lastOnStack = stack[stack.length - 1].node
                    const existingDescription = lastOnStack.description.peek()
                    let trimmedLine = line.trim();
                    if (trimmedLine.startsWith('`-') || trimmedLine.startsWith('`+') || trimmedLine.startsWith('``')) {
                        // remove the escape character for lines that start with what would look like a bullet point
                        // so that users can have description lines that look like bullet points without them being parsed as such
                        trimmedLine = trimmedLine.substring(1)
                    }
                    lastOnStack.description.value = existingDescription ? `${existingDescription}\n${trimmedLine}` : trimmedLine
                }
                firstLine = false
            }
            dirtyWrites.value = dirtyWrites.peek() + 1
        }
        catch (error) {
            log('Error parsing VMD, reverting to previous state', error)
            deserialize(ser)
        }
    }

    function lastOpenChild(id) {
        const node = map.get(id)
        if (!node) return null
        const peek = node.peek()
        if (!peek.open || peek.children.length === 0) {
            return node.id
        }

        return lastOpenChild(peek.children[peek.children.length - 1])
    }

    function next(currentId, drillDown = true) {
        const node = map.get(currentId)
        if (!node) return null
        if (drillDown) {
            const { open, children } = node.peek()
            if (open && children.length > 0) {
                return children[0]
            }
        }

        const parent = map.get(node.parentId)
        if (!parent) return null

        return parent.getChild(currentId, 'next') || next(parent.id, false)
    }

    function prev(currentId) {
        const node = map.get(currentId)
        if (!node) return null
        const parent = map.get(node.parentId)
        if (!parent) return null
        const prevSiblingId = parent.getChild(currentId, 'prev')
        return lastOpenChild(prevSiblingId) || parent.id
    }

    let dirtyDebounceTimeout = 800 // ms, time to wait after a change before updating the version, to allow for batching multiple changes together
    effect(() => {
        dirtyWrites.value // subscribe to changes on dirtyWrites to trigger version update
        let t = setTimeout(() => {
            const dirtyCount = dirtyWrites.peek()
            if (dirtyCount > 0) {
                log(`Data changed, updating version (dirtyWrites=${dirtyCount})`)
                setVersion(dataVersion.peek() + 1)
            }
        }, dirtyDebounceTimeout)
        return () => clearTimeout(t)
    })

    function smartCaseIncludes(text, query) {
        if (!query || !text) return false;
        const hasUppercase = /[A-Z]/.test(query);
        if (hasUppercase) {
            return text.includes(query);
        }
        return text.toLowerCase().includes(query.toLowerCase());
    }

    function search(query) {
        function getMatches(nodeId) {
            const node = map.get(nodeId)
            if (!node) return { id: nodeId, text: '', children: [] }
            const peek = node.peek()
            const isMatch = smartCaseIncludes(peek.text, query) || smartCaseIncludes(peek.description, query)
            const children = peek.children.map(getMatches).filter(n => n.isMatch || n.children.length > 0)
            return { id: nodeId, text: peek.text, children, isMatch }
        }
        return getMatches(rootNodeId)
    }

    return {
        get dirtyDebounceTimeout() {
            return dirtyDebounceTimeout
        },
        set dirtyDebounceTimeout(value) {
            if (typeof value !== 'number' || value < 0) {
                throw new Error('dirtyDebounceTimeout must be a non-negative number')
            }
            dirtyDebounceTimeout = value
        },
        version: dataVersion,
        get isDirty() {
            return dirtyWrites.value > 0
        },

        // search operations
        search,
        get: (id) => map.get(id),
        zoomId,
        getRoot: () => map.get(zoomId.value),
        zoomIn: (id) => zoomId.value = id,
        zoomOut: () => {
            const current = map.get(zoomId.value)
            if (current && current.parentId) {
                zoomId.value = current.parentId
            }
        },
        next: (id) => next(id, true),
        prev,

        getVMD: (id) => getVMD(id || zoomId.value),
        setVMD,
        serialize,
        deserialize,

        // mutations
        reset,
        addChild,
        deleteNode: (id) => deleteNode(id),
        update: (id, data) => update(id, node => node.update(data)),
        moveUp: (id) => update(id, moveUp),
        moveDown: (id) => update(id, moveDown),
        toggleOpen: (id) => update(id, node => node.toggleOpen()),
        updateNode: (id, { text, description }) => update(id, node => node.update({ text, description })),
        indent: (id) => update(id, indent),
        outdent: (id) => update(id, outdent),
    }
})

const localDoc = new OutlineModel() // singleton instance of the document model, used by the app and tests
localDoc.reset() // initialize with root node
export default localDoc