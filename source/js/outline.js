import { signal, createModel } from "@preact/signals"

const debug = new URLSearchParams(window.location.search).get('debug')
export const log = debug === 'true' || window.outlinedebug ? console.log.bind(console, '[debug outline]') : () => { }

// The document structure is an infinite tree of nodes
// a node is { id: string, parentId: string, text: string, description: string, children: string[], open: boolean }
// the nodes are stored in a flat map { [id: string]: node }
// there is always a root node with id 'root' and parentId null
// the node properties are signals, so that we can update them individually without replacing the whole doc
// the manipulations on the doc are done by updating the signals, and the view will react to the changes

const NodeModel = createModel((model = {}) => {
    const id = model.id || crypto.randomUUID()
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
    }
});

const OutlineModel = createModel(() => {
    const rootNodeId = 'root'
    const modelVersion = 'v1' // for future compatibility, in case we need to change the structure
    const dataVersion = signal(0) // incremented on every change
    const map = new Map()

    function addNewNode(parentId, optionalData = {}) {
        const parent = map.get(parentId) || map.get(rootNodeId)
        if (!parent) {
            console.error('Parent node not found, cannot add new node')
            return
        }
        const node = new NodeModel({
            parentId: parent.id,
            id: optionalData.id,
            text: optionalData.text,
            description: optionalData.description,
            open: optionalData.open
        })
        map.set(node.id, node)
        parent.addChild(node.id)
        dataVersion.value = dataVersion.peek() + 1
        return node
    }

    function deleteNode(id) {
        if (id === rootNodeId) {
            log('Cannot delete root node')
            return
        }

        function innerDelete(nodeId) {
            const node = map.get(nodeId)
            if (node) {
                node.children.peek().forEach(innerDelete)
                map.delete(nodeId)
                node[Symbol.dispose]()
            }
            return node
        }

        const node = innerDelete(id)
        if (!node) {
            return
        }

        const parent = map.get(node.parentId)
        if (parent) {
            parent.removeChild(id)
        }
        dataVersion.value = dataVersion.peek() + 1
    }

    function reset() {
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
        dataVersion.value = 0
    }

    function serialize(pretty = false) {
        return JSON.stringify({
            modelVersion,
            dataVersion: dataVersion.peek(),
            nodes: Object.fromEntries([...map.values()].map(node => [node.id, node.peek()]))
        }, null, pretty ? 2 : 0)
    }

    function deserialize(json) {
        const obj = JSON.parse(json)
        if (obj.modelVersion !== modelVersion) {
            throw new Error(`Unsupported model version: ${obj.modelVersion}`)
        }
        if (!obj.nodes || typeof obj.nodes !== 'object') {
            throw new Error('Invalid data format: missing nodes')
        }
        if (obj.nodes[rootNodeId] === undefined) {
            throw new Error('Invalid data format: missing root node')
        }

        const visitedChildren = new Set()

        function validateNode(nodeData) {
            const isRoot = !nodeData.parentId && nodeData.id === rootNodeId
            const parent = obj.nodes[nodeData.parentId]
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
                const child = obj.nodes[childId]
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

        const validNodes = Object.values(obj.nodes).filter(validateNode)

        reset()

        for (const nodeData of validNodes) {
            map.set(nodeData.id, new NodeModel({
                id: nodeData.id,
                parentId: nodeData.parentId,
                text: nodeData.text,
                description: nodeData.description,
                children: nodeData.children,
                open: nodeData.open
            }))
        }
        dataVersion.value = obj.dataVersion || 0
    }

    function update(id, fn) {
        const node = map.get(id)
        if (!node) {
            log('Node not found, cannot update')
            return
        }
        fn(node, map.get(node.parentId))
        dataVersion.value = dataVersion.peek() + 1
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
        const version = dataVersion.peek() + 1
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
                        let lastNode = addNewNode(lastOnStack.node.id, nodeData)
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
            dataVersion.value = version
        }
        catch (error) {
            log('Error parsing VMD, reverting to previous state', error)
            deserialize(ser)
        }
    }

    return {
        version: dataVersion,
        get: (id) => map.get(id),
        getRoot: () => map.get(rootNodeId),
        reset,
        getVMD: (id) => getVMD(id || rootNodeId),
        setVMD,
        serialize,
        deserialize,
        addNewNode,
        deleteNode,
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