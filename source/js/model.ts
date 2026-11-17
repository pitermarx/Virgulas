// Shared document-model types, constants and errors.
//
// This module has no imports. outline.ts (the live model), docCodec.ts (the
// serialization boundary), storage.ts (the contracts) and the decorators all
// depend on it, and it depends on none of them, so the layering stays acyclic:
// model -> storage -> docCodec -> decorators -> persistence.

/** A serialized document node - the shape outline.serialize() emits. */
export interface OutlineNode {
    id: string
    parentId?: string | null
    text?: string
    description?: string
    children?: string[]
    open?: boolean
    done?: boolean | null
    lastModified?: number
    [key: string]: any
}

/**
 * A whole document value: the node list (always including the 'root' node)
 * plus any document-level metadata (modelVersion, dataVersion, …).
 */
export interface OutlineDoc {
    nodes: OutlineNode[]
    [key: string]: any
}

export interface DocCodec {
    serialize(doc: OutlineDoc): string
    /** Validates; throws StoreError('invalid-document' | 'unsupported-runtime'),
     * with the underlying typed error preserved as `cause`. */
    parse(text: string): OutlineDoc
}

/**
 * Document model version - the single source of truth shared by
 * outline.serialize()/deserialize() and the codecs in docCodec.ts.
 */
export const MODEL_VERSION = 'v1'

export class CorruptDocumentError extends Error {
    constructor(message = 'The decrypted document is corrupted or invalid.') {
        super(message)
        this.name = 'CorruptDocumentError'
    }
}
