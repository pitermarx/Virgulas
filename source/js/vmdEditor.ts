import { parseVmdNodeLine, parseVmdTree, vmdNodeId, writeVmd } from './docCodec.js'
import type { Node, NodeInput } from './node.js'
import type { OutlineDoc } from './model.js'
import { log } from './utils.js'

// The VMD editing surface over the live model. Two paths, two parsers:
//   - setVMD edits one node's subtree in place, line by line, using the
//     per-node editor parser (parseVmdNodeLine) with its backtick escape.
//   - setRootVMD replaces the zoom root's children by parsing the whole text
//     with the codec's pure parser (parseVmdTree) first — an invalid document
//     never touches the live tree — then replaying it through addChild.
//
// Everything shared (the node map, zoom, CRUD, serialize/deserialize for the
// revert-on-error paths, the dirty counter) is injected by outline.ts, which
// remains the single owner of the document state.

export interface VmdEditorContext {
    map: Map<string, Node>
    rootNodeId: string
    zoomId: { readonly value: string }
    addChild: (parentId?: string, data?: NodeInput, previousSiblingId?: string | false) => Node | undefined
    deleteNode: (id: string, force?: boolean) => void
    serialize: () => string
    deserialize: (json: string) => void
    markDirty: () => void
}

export function createVmdEditor(ctx: VmdEditorContext) {
    const { map, rootNodeId, zoomId, addChild, deleteNode, serialize, deserialize, markDirty } = ctx

    function getVMD(nodeId: string, level = 0): string {
        // The writer is shared with vmdCodec (docCodec.ts): the root is a
        // container and is not rendered, so its children start at level 0.
        return writeVmd(nodeId, id => map.get(id)?.peek(), nodeId === rootNodeId || level < 0 ? -1 : level)
    }

    /** Append a VMD-parsed child, preferring the stable positional ID shared
     * with vmdCodec (see vmdNodeId there). */
    function addVmdChild(parentId: string, nodeData: NodeInput, siblingIndex: number, previousSiblingId: string | false): Node | undefined {
        const stable = addChild(parentId, { ...nodeData, id: vmdNodeId(parentId, siblingIndex) }, previousSiblingId)
        if (stable) return stable
        // The positional ID can only be taken if the same VMD was parsed into a
        // subtree that still holds it. Fall back to a fresh ID so the rest of the
        // document still parses instead of aborting.
        return addChild(parentId, nodeData, previousSiblingId)
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
                    const parsed = parseVmdNodeLine(rawText)
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
                        const lastNode = addVmdChild(lastOnStack.node.id, nodeData, c.length, prevSiblingId)
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
            markDirty()
        }
        catch (error) {
            log('Error parsing VMD, reverting to previous state', error)
            deserialize(ser)
        }
    }

    function setRootVMD(text: string) {
        const root = map.get(zoomId.value)
        if (!root) return

        // Parse first: an invalid VMD leaves the live document untouched. The
        // parser is the codec's (docCodec.parseVmdTree), so File import and the
        // root editor cannot disagree about the format.
        let parsedDoc: OutlineDoc
        try {
            parsedDoc = parseVmdTree(text)
        } catch (error) {
            log('Error parsing root VMD, document left unchanged', error)
            throw new Error('Invalid VMD: each description line must belong to a node.')
        }

        const serializedBeforeChange = serialize()
        try {
            const byId = new Map(parsedDoc.nodes.map(node => [node.id, node]))
            const parsedRoot = byId.get('root')!

            // Delete all existing children of the zoom root, then replay the
            // parsed tree onto it through addChild so IDs, open/done state and
            // the dirty counter keep the live-model semantics.
            const existingChildren = [...root.children.peek()]
            existingChildren.forEach(id => deleteNode(id, true))

            const appendParsed = (parentId: string, parsedParentId: string) => {
                const parsedParent = byId.get(parsedParentId)!
                for (const parsedChildId of parsedParent.children || []) {
                    const parsedChild = byId.get(parsedChildId)!
                    const siblings = map.get(parentId)!.children.peek()
                    const previousSiblingId = siblings[siblings.length - 1]
                    const newNode = addVmdChild(parentId, {
                        text: parsedChild.text,
                        description: parsedChild.description,
                        done: parsedChild.done ?? null,
                        open: parsedChild.open ?? true
                    }, siblings.length, previousSiblingId)
                    if (newNode) appendParsed(newNode.id, parsedChildId)
                }
            }
            appendParsed(root.id, parsedRoot.id)

            markDirty()
        } catch (error) {
            log('Error parsing root VMD, reverting to previous state', error)
            deserialize(serializedBeforeChange)
            throw new Error('Invalid VMD: each description line must belong to a node.')
        }
    }

    return { getVMD, setVMD, setRootVMD }
}
