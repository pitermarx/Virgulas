import { signal, effect, createModel } from "@preact/signals"
import { randomId, UnsupportedVersionError } from "./crypto2.js"
import { CorruptDocumentError, MODEL_VERSION, type OutlineDoc, type OutlineNode } from './model.js'
import { NodeModel, type Node, type NodeInput, type NodeUpdate } from './node.js'
import { createNavigation } from './navigation.js'
import { createTreeOps } from './treeOps.js'
import { createVmdEditor } from './vmdEditor.js'
import { log } from './utils.js';

// The model version and the corrupt-document error live in model.ts so the
// codecs can share the VMD implementation without importing this module back.
export { CorruptDocumentError, MODEL_VERSION } from './model.js'
// The per-node signal model lives in node.ts; the type re-exports keep the
// existing import sites (tasks, inbox) working through this module.
export type { DoneState, Node, NodeInput, NodeUpdate } from './node.js'

// The document structure is an infinite tree of nodes stored in a flat map
// { [id: string]: node }, with a root node with id 'root' and parentId null.
// The node signals live in node.ts; this module owns the document: the map,
// the versions, CRUD, validation on load, and the search-tree walk. Tree
// mutations (treeOps.ts), keyboard navigation (navigation.ts) and the VMD
// editing surface (vmdEditor.ts) operate on this state through injected
// references, so the document has exactly one owner.

export interface SearchMatch {
    id: string
    text: string
    children: SearchMatch[]
    isMatch?: boolean
}

function outlineFactory() {
    const rootNodeId = 'root'
    const modelVersion = MODEL_VERSION
    const dataVersion = signal(0) // incremented on every change, but debounced to avoid excessive updates during rapid changes
    // Always-incrementing counter for structural rebuilds (reset/deserialize).
    // dataVersion alone is not enough: unlock paths batch deserialize, and when the
    // restored dataVersion equals the previous value (commonly 0), subscribers never
    // re-run even though the node map was fully replaced.
    const structureVersion = signal(0)
    const dirtyWrites = signal(0)
    const map = new Map<string, Node>()
    const zoomId = signal<string>(rootNodeId)

    // The satellite modules operate on this state through injected references.
    // The functions they receive (addChild, deleteNode, serialize, deserialize)
    // are declarations below and hoist, so the wiring can sit with the state.
    const tree = createTreeOps(map)
    const nav = createNavigation(map, zoomId, rootNodeId)
    const vmd = createVmdEditor({
        map,
        rootNodeId,
        zoomId,
        addChild,
        deleteNode,
        serialize,
        deserialize,
        markDirty: () => { dirtyWrites.value = dirtyWrites.peek() + 1 },
    })


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

        // An explicit id comes from deserialized or VMD-parsed trees; a duplicate
        // would silently fork the node's children across two parents.
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


    /**
     * The live document as a plain value (OutlineDoc): every node snapshot plus
     * the document-level fields. This is the model-side entry point the storage
     * seam consumes; serialize() is only the JSON-text wrapper around it.
     */
    function snapshot(): OutlineDoc {
        const nodes: OutlineNode[] = []
        for (const node of map.values()) {
            // Read the node's signals directly: an intermediate peek()
            // snapshot per node doubles the allocation on every save (perf-04).
            const description = node.description.peek()
            const children = node.children.peek()
            const open = node.open.peek()
            const done = node.done.peek()
            const lastModified = node.lastModified
            nodes.push({
                id: node.id,
                parentId: node.parentId,
                text: node.text.peek(),
                description: description === '' ? undefined : description, // omit description if empty to save space
                children: children.length > 0 ? [...children] : undefined, // copy: the value must not alias the live model
                open: open === true ? undefined : open, // omit open if true to save space, since most nodes are open by default
                lastModified: lastModified > 0 ? lastModified : undefined, // omit lastModified when 0 for backwards compat
                done: done !== null && done !== undefined ? done : undefined, // omit done if null (not a task)
            })
        }
        return { modelVersion, dataVersion: dataVersion.peek(), nodes }
    }

    function serialize(pretty = false) {
        return JSON.stringify(snapshot(), null, pretty ? 2 : 0)
    }

    function deserialize(json: string) {
        let obj: any
        try {
            obj = JSON.parse(json)
        } catch {
            throw new CorruptDocumentError('The decrypted document is not valid JSON.')
        }
        load(obj)
    }

    /**
     * Loads an already-parsed document value with the same validation and
     * model sanitisation as deserialize(). The storage seam calls this directly,
     * so a store read never round-trips through JSON text in orchestration.
     */
    function load(obj: OutlineDoc) {
        log('Deserializing outline, version:', dataVersion.value)

        const previousZoomId = zoomId.peek()
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
            throw new CorruptDocumentError()
        }
        if (typeof obj.modelVersion !== 'string') {
            throw new CorruptDocumentError('The decrypted document has no model version.')
        }
        if (obj.modelVersion !== modelVersion) {
            throw new UnsupportedVersionError(`This document uses unsupported model version ${obj.modelVersion}. Reload the app to get the latest version.`)
        }
        if (!Array.isArray(obj.nodes)) {
            throw new CorruptDocumentError('The decrypted document has an invalid node list.')
        }

        // Null-prototype map so an id/parentId of `constructor`, `toString`, or
        // `__proto__` cannot resolve an inherited Object property and pass validation.
        const nodes: Record<string, any> = Object.create(null)
        for (const nodeData of obj.nodes) {
            if (!nodeData || typeof nodeData !== 'object' || Array.isArray(nodeData)
                || typeof nodeData.id !== 'string' || !nodeData.id
                || (nodeData.children !== undefined && !Array.isArray(nodeData.children))) {
                throw new CorruptDocumentError('The decrypted document contains an invalid node.')
            }
            nodes[nodeData.id] = nodeData
        }
        if (nodes[rootNodeId] === undefined) {
            throw new CorruptDocumentError('The decrypted document is missing its root node.')
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
        const restoredNodes = validNodes
            .filter(nodeData => nodeData.id !== rootNodeId)
            .map(nodeData => [nodeData.id, new NodeModel({
                id: nodeData.id,
                parentId: nodeData.parentId,
                text: nodeData.text,
                description: nodeData.description,
                children: nodeData.children,
                open: nodeData.open,
                lastModified: nodeData.lastModified || 0,
                done: nodeData.done !== undefined ? nodeData.done : null,
            })] as const)

        reset()
        // The root is recreated by reset(), not restored like the other nodes,
        // which dropped its timestamp and broke load-then-save identity
        // (test-02). Rebuild it from the stored node when there is one.
        const storedRoot = validNodes.find(n => n.id === rootNodeId)
        const rootChildIds = new Set(storedRoot?.children ?? [])
        const rootChildren = [
            ...(storedRoot?.children ?? []),
            ...validNodes.filter(n => n.parentId === rootNodeId && !rootChildIds.has(n.id)).map(n => n.id),
        ]
        const placeholderRoot = map.get(rootNodeId)!
        if (storedRoot) {
            placeholderRoot[Symbol.dispose]()
            map.set(rootNodeId, new NodeModel({
                id: rootNodeId,
                parentId: null,
                text: storedRoot.text,
                description: storedRoot.description,
                children: rootChildren,
                open: storedRoot.open,
                lastModified: storedRoot.lastModified || 0,
                done: storedRoot.done ?? null,
            }))
        } else {
            placeholderRoot.children.value = rootChildren
        }

        for (const [id, node] of restoredNodes) map.set(id, node)
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
        next: (id: string) => nav.next(id, true),
        prev: nav.prev,
        nextSibling: nav.nextSibling,
        prevSibling: nav.prevSibling,

        getVMD: (id?: string) => vmd.getVMD(id || zoomId.value),
        setVMD: vmd.setVMD,
        setRootVMD: vmd.setRootVMD,
        snapshot,
        // Codec-parsed documents carry no model version; supply it before load
        // validates the value. Shared by the storage seam and the intro loader.
        loadDocument: (doc: OutlineDoc) => load({ modelVersion: MODEL_VERSION, dataVersion: 0, ...doc }),
        load,
        serialize,
        deserialize,

        // mutations
        reset,
        addChild,
        deleteNode: (id: string) => deleteNode(id),
        update: (id: string, data: NodeUpdate) => update(id, node => node.update(data)),
        moveUp: (id: string) => update(id, tree.moveUp),
        moveDown: (id: string) => update(id, tree.moveDown),
        toggleOpen: (id: string) => update(id, node => node.toggleOpen()),
        updateNode: (id: string, { text, description }: { text?: string; description?: string }) => update(id, node => node.update({ text, description })),
        indent: (id: string) => update(id, tree.indent),
        outdent: (id: string) => update(id, tree.outdent),
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