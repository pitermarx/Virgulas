import { signal, effect, createModel, type Signal } from "@preact/signals"
import { randomId } from "./crypto2.js"
import { log } from './utils.js';
import { parseMeta, advanceDueDate } from './meta.js';

// The document structure is an infinite tree of nodes
// a node is { id: string, parentId: string, text: string, description: string, children: string[], open: boolean, done: boolean|null }
// the nodes are stored in a flat map { [id: string]: node }
// there is always a root node with id 'root' and parentId null
// the node properties are signals, so that we can update them individually without replacing the whole doc
// the manipulations on the doc are done by updating the signals, and the view will react to the changes
// done: null = plain node (not a task), false = unchecked task, true = completed task

export type DoneState = boolean | null

export interface NodeInput {
    id?: string
    parentId?: string | null
    text?: string
    description?: string
    children?: string[]
    open?: boolean
    done?: DoneState
    lastModified?: number
}

export interface NodeSnapshot {
    id: string
    parentId: string | null
    text: string
    description: string
    children: string[]
    open: boolean
    done: DoneState
    lastModified: number
}

export interface NodeUpdate {
    text?: string
    description?: string
    parentId?: string | null
    open?: boolean
    done?: DoneState
}

export interface OutlineStats {
    wordCount: number
    charCount: number
    maxDepth: number
    collapsedCount: number
    openCount: number
    nodeCount: number
}

export interface SearchMatch {
    id: string
    text: string
    children: SearchMatch[]
    isMatch?: boolean
}

function nodeFactory(model: NodeInput = {}) {
    const id = model.id
    if (!id) {
        throw new Error('Node must have an id')
    }
    let parentId: string | null = model.parentId ?? null
    const text = signal(model.text || '')
    const description = signal(model.description || '')
    const children = signal<string[]>(model.children || [])
    const open = signal(model.open === undefined ? true : !!model.open)
    const done = signal<DoneState>(model.done !== undefined ? model.done : null)
    let lastModified = model.lastModified || 0

    // A pending task with rec:<n><y|m|w|d> and due:<date> advances its due date
    // instead of becoming done. Returns true if it advanced (and thus handled the transition).
    function tryAdvanceRecurrence() {
        const raw = text.peek()
        const { meta } = parseMeta(raw)
        if (!meta.due || !meta.rec) return false
        const nextDue = advanceDueDate(meta.due, meta.rec)
        if (!nextDue) return false
        // Replace only the due value in place, preserving token order/spacing.
        text.value = raw.replace(`due:${meta.due}`, `due:${nextDue}`)
        lastModified = Date.now()
        return true
    }

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
        get done() {
            return done
        },
        get lastModified() {
            return lastModified
        },
        get value() {
            return {
                id,
                parentId,
                text: text.value,
                description: description.value,
                children: children.value,
                open: open.value,
                done: done.value,
                lastModified
            }
        },
        peek() {
            return {
                id,
                parentId,
                text: text.peek(),
                description: description.peek(),
                children: children.peek(),
                open: open.peek(),
                done: done.peek(),
                lastModified
            }
        },
        toggleOpen() {
            open.value = !open.peek()
            lastModified = Date.now()
        },
        toggleDone() {
            const current = done.peek()
            if (current === null) { done.value = false }
            else if (current === false) {
                if (!tryAdvanceRecurrence()) done.value = true
            }
            else { done.value = null }  // cycle back to plain node
            lastModified = Date.now()
        },
        removeTaskMark() {
            done.value = null
            lastModified = Date.now()
        },
        checkboxToggleDone() {
            const current = done.peek()
            if (current === false && tryAdvanceRecurrence()) return
            // null → false (guard, promotes plain node), false → true, true → false. Never null.
            done.value = current === null ? false : !current
            lastModified = Date.now()
        },
        update(update: NodeUpdate) {
            let changed = false
            if (update.text !== undefined && update.text !== text.peek()) { text.value = update.text; changed = true }
            if (update.description !== undefined && update.description !== description.peek()) { description.value = update.description; changed = true }
            if (update.parentId !== undefined) parentId = update.parentId
            if (update.open !== undefined) open.value = !!update.open
            if (update.done !== undefined && update.done !== done.peek()) { done.value = update.done; changed = true }
            if (changed) lastModified = Date.now()
        },
        removeChild(childId: string) {
            children.value = children.peek().filter(id => id !== childId)
            lastModified = Date.now()
        },
        addChild(childId: string, index = -1) {
            const peek = children.peek()
            if (index < 0 || index >= peek.length) {
                children.value = [...peek, childId]
            } else {
                children.value = [...peek.slice(0, index), childId, ...peek.slice(index)]
            }
            lastModified = Date.now()
        },
        move(childId: string, direction: 'up' | 'down' = 'up') {
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
                lastModified = Date.now()
            } else if (direction === 'down' && index < peek.length - 1) {
                const newChildren = [...peek]
                const temp = newChildren[index + 1]
                newChildren[index + 1] = newChildren[index]
                newChildren[index] = temp
                children.value = newChildren
                lastModified = Date.now()
            } else {
                log('Cannot move child in that direction')
                return
            }
        },
        getChild(currentChildId: string, direction: 'next' | 'prev' = 'next'): string | null | undefined {
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
}

type NodeModelShape = ReturnType<typeof nodeFactory>
export type Node = NodeModelShape & { [Symbol.dispose](): void }
const NodeModel = createModel(nodeFactory as unknown as (...args: any[]) => any) as unknown as new (model?: NodeInput) => Node

function outlineFactory() {
    const rootNodeId = 'root'
    const modelVersion = 'v1' // for future compatibility, in case we need to change the structure
    const dataVersion = signal(0) // incremented on every change, but debounced to avoid excessive updates during rapid changes
    // Always-incrementing counter for structural rebuilds (reset/deserialize).
    // dataVersion alone is not enough: unlock paths batch deserialize, and when the
    // restored dataVersion equals the previous value (commonly 0), subscribers never
    // re-run even though the node map was fully replaced.
    const structureVersion = signal(0)
    const dirtyWrites = signal(0) // mark if there are unsaved changes, used to trigger version update
    const map = new Map<string, Node>()
    const zoomId = signal<string>(rootNodeId) // the currently zoomed in node, used for rendering and keyboard navigation


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

    function setVersion(newVersion: number) {
        dataVersion.value = newVersion
        dirtyWrites.value = 0
    }

    function addChild(parentId?: string, optionalData: NodeInput = {}, previousSiblingId?: string | false): Node | undefined {
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
            open: optionalData.open,
            done: optionalData.done !== undefined ? optionalData.done : null,
        })
        map.set(node.id, node)

        let idx
        if (previousSiblingId === false) {
            idx = 0
        } else {
            const baseIndex = previousSiblingId ? parent.children.peek().indexOf(previousSiblingId) : -1
            idx = baseIndex === -1 ? -1 : baseIndex + 1
        }
        parent.addChild(node.id, idx)

        dirtyWrites.value = dirtyWrites.peek() + 1
        return node
    }

    function deleteNode(id: string, force?: boolean) {
        if (id === zoomId.value) {
            log('Cannot delete the current node at the root level')
            return
        }


        function innerDelete(n: Node | undefined) {
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

        const parent = node.parentId ? map.get(node.parentId) : undefined
        if (parent) {
            if (parent.children.peek().length === 1 && parent.id === zoomId.value && !force) {
                log('Cannot delete the only child of the root node, skipping deletion to prevent empty outline')
                node.text.value = '' // instead of deleting the node, just clear its text to keep the outline from being empty
                const ch = node.children.peek()
                if (ch)
                    ch.map(i => map.get(i)).forEach(n => { if (n) deleteNode(n.id) })
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
            topLevel.forEach(id => deleteNode(id, true))
            root[Symbol.dispose]()
            map.delete(rootNodeId)
        }
        if (map.size > 0) {
            log('Warning: map not empty after reset, clearing remaining nodes')
            map.clear()
        }
        map.set(rootNodeId, new NodeModel({ id: rootNodeId, lastModified: 0 }))
        structureVersion.value = structureVersion.peek() + 1
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
                    lastModified: node.lastModified > 0 ? node.lastModified : undefined, // omit lastModified when 0 for backwards compat
                    done: node.done !== null && node.done !== undefined ? node.done : undefined, // omit done if null (not a task)
                }))
        }, null, pretty ? 2 : 0)
    }

    function deserialize(json: string) {
        log('Deserializing outline, version:', dataVersion.value)
        const previousZoomId = zoomId.peek()
        const obj = JSON.parse(json)
        if (obj.modelVersion !== modelVersion) {
            throw new Error(`Unsupported model version: ${obj.modelVersion}`)
        }
        if (!obj.nodes || typeof obj.nodes !== 'object') {
            throw new Error('Invalid data format: missing nodes')
        }

        // Null-prototype map so an id/parentId of `constructor`, `toString`, or
        // `__proto__` cannot resolve an inherited Object property and pass validation.
        const nodes: Record<string, any> = Object.create(null)
        for (const nodeData of obj.nodes) {
            nodes[nodeData.id] = nodeData
        }
        if (nodes[rootNodeId] === undefined) {
            throw new Error('Invalid data format: missing root node')
        }

        const visitedChildren = new Set()

        function validateNode(nodeData: any) {
            const isRoot = !nodeData.parentId && nodeData.id === rootNodeId
            const parent = nodes[nodeData.parentId]
            if (!isRoot && !parent) {
                log(`Node with id ${nodeData.id} has invalid parent, skipping`)
                return false
            }

            // children should be an array of valid ids
            nodeData.children = (nodeData.children || []).filter((childId: string) => {
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
        map.get(rootNodeId)!.children.value = validNodes.filter(n => n.parentId === rootNodeId).map(n => n.id)

        for (const nodeData of validNodes) {
            if (nodeData.id === rootNodeId) continue // root node is already created with its children, so we can skip it in the loop
            map.set(nodeData.id, new NodeModel({
                id: nodeData.id,
                parentId: nodeData.parentId,
                text: nodeData.text,
                description: nodeData.description,
                children: nodeData.children,
                open: nodeData.open,
                lastModified: nodeData.lastModified || 0,
                done: nodeData.done !== undefined ? nodeData.done : null,
            }))
        }
        if (previousZoomId !== rootNodeId && map.has(previousZoomId)) {
            zoomId.value = previousZoomId
        } else {
            if (previousZoomId !== rootNodeId) {
                log(`Zoomed node ${previousZoomId} not found in deserialized data, resetting zoom to root`)
            }
            zoomId.value = rootNodeId
        }
        // Always bump structureVersion so computeds that scan the map (e.g. groupedTasks)
        // re-evaluate even when dataVersion is unchanged inside a batch().
        structureVersion.value = structureVersion.peek() + 1
        setVersion(obj.dataVersion || 0)
    }


    function update(id: string, fn: (node: Node, parent: Node | undefined) => void) {
        const node = map.get(id)
        if (!node) {
            log('Node not found, cannot update')
            return
        }
        fn(node, node.parentId ? map.get(node.parentId) : undefined)
        dirtyWrites.value = dirtyWrites.peek() + 1
    }

    function moveUp(node: Node, parent: Node | undefined) {
        if (!parent) {
            log('Node has no parent, cannot move')
            return
        }
        const index = parent.children.peek().indexOf(node.id)
        if (index > 0) {
            parent.move(node.id, 'up')
        } else {
            // try to move to grandparent level
            const grandParent = parent.parentId ? map.get(parent.parentId) : undefined
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

    function moveDown(node: Node, parent: Node | undefined) {
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
            const grandParent = parent.parentId ? map.get(parent.parentId) : undefined
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

    function getVMD(nodeId: string, level = 0): string {
        const node = map.get(nodeId)
        if (!node) return ''
        const peek = node.peek()

        let result = '';
        const ch = peek.children
        level = nodeId === rootNodeId || level < 0 ? -1 : level // root node is not rendered, so it doesn't add to the indent level
        if (level >= 0) {
            const indent = '  '.repeat(level);
            const bullet = (ch.length > 0 && !peek.open) ? '+' : '-';
            let vmdText = peek.text
            if (peek.done !== null) vmdText = `${peek.done ? '[x]' : '[ ]'} ${vmdText}`
            result += `${indent}${bullet} ${vmdText}\n`;

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

    function parseNodeLine(rawNodeText: string): { text: string; done: DoneState } {
        let nodeText = rawNodeText.trim()
        let taskDone: DoneState = null
        const cbMatch = nodeText.match(/^\[([ xX])\]\s*(.*)/)
        if (cbMatch) { taskDone = cbMatch[1].toLowerCase() === 'x'; nodeText = cbMatch[2].trim() }
        return { text: nodeText, done: taskDone }
    }

    function setVMD(text: string, nodeId: string) {
        if (nodeId === rootNodeId) {
            log('Cannot set VMD on root node, skipping')
            return
        }
        const node = map.get(nodeId)
        if (!node) {
            log('Node not found, cannot set VMD')
            return
        }
        const parent = node.parentId ? map.get(node.parentId) : undefined
        if (!parent) {
            log('Parent node not found, cannot set VMD')
            return
        }
        const stack: { node: Node; indentLevel: number }[] = [{ node: parent, indentLevel: -1 }, { node, indentLevel: 0 }];
        const ser = serialize()
        try {
            // delete existing children before parsing new ones
            node.children.peek().forEach(id => deleteNode(id))

            const lines = text.split(/\r?\n/);
            let firstLine = true
            for (const line of lines) {
                if (!line.trim()) continue;

                // Match regular bullet points (-, +)
                const match = line.match(/^(\s*)([-+])(.*)$/);
                if (match) {
                    const [, indentStr, bullet, rawText] = match;
                    const parsed = parseNodeLine(rawText)
                    const nodeData = { ...parsed, open: bullet === '-' }

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
                        stack.push({ node: lastNode!, indentLevel: indentStr.length });
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

    function search(query: string): SearchMatch {
        // The query is normalized once here. Doing it inside the walk re-tested
        // the uppercase check and re-lowercased the query for every node and
        // every field.
        const lowerQuery = query.toLowerCase()
        const caseSensitive = /[A-Z]/.test(query)
        const includes = (text: string) => {
            if (!text) return false
            return caseSensitive ? text.includes(query) : text.toLowerCase().includes(lowerQuery)
        }

        function getMatches(nodeId: string): SearchMatch {
            const node = map.get(nodeId)
            if (!node) return { id: nodeId, text: '', children: [] }
            // Read the underlying signals directly. node.peek() allocates a full
            // snapshot object per node, which is pure garbage for this walk.
            const text = node.text.peek()
            const isMatch = includes(text) || includes(node.description.peek())
            const children: SearchMatch[] = []
            for (const childId of node.children.peek()) {
                const child = getMatches(childId)
                if (child.isMatch || child.children.length > 0) children.push(child)
            }
            return { id: nodeId, text, children, isMatch }
        }
        return getMatches(rootNodeId)
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

    function setRootVMD(text: string) {
        const root = map.get(zoomId.value)
        if (!root) return
        const serializedBeforeChange = serialize()
        try {
            // Delete all existing children of the zoom root
            const existingChildren = [...root.children.peek()]
            existingChildren.forEach(id => deleteNode(id, true))

            const stack = [{ node: root, indentLen: -1 }]
            const lines = text.split(/\r?\n/)
            for (const line of lines) {
                if (!line.trim()) continue

                const match = line.match(/^(\s*)([-+])\s?(.*)$/)
                if (match) {
                    const [, indentStr, bullet, rawNodeText] = match
                    const indentLen = indentStr.length
                    const parsed = parseNodeLine(rawNodeText)
                    const nodeData = { ...parsed, open: bullet === '-' }

                    // Pop stack until we find the right parent level
                    while (stack.length > 1 && stack[stack.length - 1].indentLen >= indentLen) {
                        stack.pop()
                    }

                    const parentNode = stack[stack.length - 1].node
                    const prevSiblingId = parentNode.children.peek().slice(-1)[0]
                    const newNode = addChild(parentNode.id, nodeData, prevSiblingId)
                    stack.push({ node: newNode!, indentLen })
                    continue
                }

                // Description lines must belong to a previously parsed node.
                if (stack.length === 1) {
                    throw new Error('Description line must follow a node bullet.')
                }

                const lastNode = stack[stack.length - 1].node
                const existing = lastNode.description.peek()
                let trimmed = line.trim()
                if (trimmed.startsWith('\\-') || trimmed.startsWith('\\+') || trimmed.startsWith('\\\\')) {
                    trimmed = trimmed.substring(1)
                }
                if (trimmed) {
                    lastNode.description.value = existing ? `${existing}\n${trimmed}` : trimmed
                }
            }

            dirtyWrites.value = dirtyWrites.peek() + 1
        } catch (error) {
            log('Error parsing root VMD, reverting to previous state', error)
            deserialize(serializedBeforeChange)
            throw new Error('Invalid VMD: each description line must belong to a node.')
        }
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
        structureVersion,
        dirtyWrites,
        get isDirty() {
            return dirtyWrites.value > 0
        },

        get nodeCount() {
            return map.size
        },

        getStats() {
            let wordCount = 0
            let charCount = 0
            let maxDepth = 0
            let collapsedCount = 0
            let openCount = 0

            function visit(id: string, depth: number) {
                const node = map.get(id)
                if (!node) return
                const peek = node.peek()
                if (id !== 'root') {
                    const text = peek.text || ''
                    charCount += text.length
                    if (text.trim()) {
                        wordCount += text.trim().split(/\s+/).length
                    }
                    if (depth > maxDepth) maxDepth = depth
                    if (peek.children.length > 0) {
                        if (peek.open) openCount++
                        else collapsedCount++
                    }
                }
                for (const childId of peek.children) {
                    visit(childId, depth + 1)
                }
            }
            visit('root', 0)

            return { wordCount, charCount, maxDepth, collapsedCount, openCount, nodeCount: map.size - 1 }
        },

        // search operations
        search,
        get: (id: string) => map.get(id),
        zoomId,
        getRoot: () => map.get(zoomId.value),
        zoomIn: (id: string) => zoomId.value = id,
        zoomOut: () => {
            const current = map.get(zoomId.value)
            if (current && current.parentId) {
                zoomId.value = current.parentId
            }
        },
        next: (id: string) => next(id, true),
        prev,
        nextSibling,
        prevSibling,

        getVMD: (id?: string) => getVMD(id || zoomId.value),
        setVMD,
        setRootVMD,
        serialize,
        deserialize,

        // mutations
        reset,
        addChild,
        deleteNode: (id: string) => deleteNode(id),
        update: (id: string, data: NodeUpdate) => update(id, node => node.update(data)),
        moveUp: (id: string) => update(id, moveUp),
        moveDown: (id: string) => update(id, moveDown),
        toggleOpen: (id: string) => update(id, node => node.toggleOpen()),
        updateNode: (id: string, { text, description }: { text?: string; description?: string }) => update(id, node => node.update({ text, description })),
        indent: (id: string) => update(id, indent),
        outdent: (id: string) => update(id, outdent),
        toggleDone: (id: string) => update(id, node => node.toggleDone()),
        checkboxToggleDone: (id: string) => update(id, node => node.checkboxToggleDone()),
        removeTaskMark: (id: string) => update(id, node => node.removeTaskMark()),
        getAllTasks: () => [...map.values()].filter(node => node.done.peek() !== null),
        updateTextRaw: (id: string, rawText: string) => update(id, node => {
            // Parse the [ ] / [x] prefix without trimming the rest of the text,
            // so that trailing spaces during editing are preserved.
            const cbMatch = rawText.match(/^\[([ xX])\]\s?(.*)$/)
            if (cbMatch) {
                const done = cbMatch[1].toLowerCase() === 'x'
                node.update({ text: cbMatch[2], done })
            } else {
                node.update({ text: rawText, done: null })
            }
        }),

    }
}

const OutlineModel = createModel(outlineFactory as unknown as (...args: any[]) => any) as unknown as new () => ReturnType<typeof outlineFactory>

const localDoc = new OutlineModel() // singleton instance of the document model, used by the app and tests
localDoc.reset() // initialize with root node
export default localDoc