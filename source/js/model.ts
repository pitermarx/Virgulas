// Shared document-model constants and errors.
//
// This module has no imports: both outline.ts (the live model) and
// docCodec.ts (the serialization boundary) depend on it. Keeping the shared
// pieces here lets the codecs validate and throw the typed error without
// importing the model back, so the VMD writer/parser can be shared without a
// circular dependency (outline.ts → docCodec.ts → model.ts).

/**
 * Document model version — the single source of truth shared by
 * outline.serialize()/deserialize() and the codecs in docCodec.ts.
 */
export const MODEL_VERSION = 'v1'

export class CorruptDocumentError extends Error {
    constructor(message = 'The decrypted document is corrupted or invalid.') {
        super(message)
        this.name = 'CorruptDocumentError'
    }
}
