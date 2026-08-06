// Generic VMD.md Layer C metadata parser.
// Implements the metadata recognition algorithm from docs/VMD.md §8:
//   1. Split item content into whitespace-delimited tokens.
//   2. Scan tokens right-to-left.
//   3. A token matches if it contains a colon, splits into `property:value`
//      at the first colon, `property` exists in the registry, and `value`
//      passes the optional regex.
//   4. First match wins (last-on-line wins). Stop scanning immediately upon
//      encountering any non-matching token, unregistered property, tag, or mention.
//   5. All tokens to the left of the stop point become content.
//
// The registry recognises `due` (a date) and `rec` (a recurrence interval).
// `rec` only has an effect on a task that also carries a `due` date.

const META_REGISTRY = {
    due: /^\d{4}-\d{2}-\d{2}$/,
    rec: /^\d*(y|m|w|d)$/
}

const TOKEN_RE = /\S+/g

/**
 * Parse metadata from the end of a text string.
 * @param {string} text
 * @returns {{ meta: Record<string, string>, text: string }}
 */
export function parseMeta(text) {
    const meta = {}
    const tokens = String(text || '').match(TOKEN_RE) || []
    if (tokens.length === 0) return { meta, text: String(text || '') }

    let stopIndex = tokens.length // index of first token to keep in text

    for (let i = tokens.length - 1; i >= 0; i--) {
        const token = tokens[i]
        const colonIdx = token.indexOf(':')
        if (colonIdx === -1) {
            // Non-matching token (no colon) → stop scanning.
            // Keep everything including this token (i + 1).
            stopIndex = i + 1
            break
        }
        const property = token.slice(0, colonIdx)
        const value = token.slice(colonIdx + 1)
        const regex = META_REGISTRY[property]
        if (!regex || !regex.test(value) || (property === 'due' && !isValidDueDate(value))) {
            // Unregistered property or invalid value → stop scanning.
            // Keep everything including this token (i + 1).
            stopIndex = i + 1
            break
        }
        // First match wins (last-on-line wins): only set if not already present.
        if (!(property in meta)) {
            meta[property] = value
        }
        stopIndex = i
    }

    const residual = tokens.slice(0, stopIndex).join(' ')
    return { meta, text: residual }
}

/**
 * Append metadata back to text (round-trip).
 * @param {string} text
 * @param {Record<string, string>} meta
 * @returns {string}
 */
export function formatMeta(text, meta) {
    const parts = [String(text || '')]
    for (const [key, value] of Object.entries(meta)) {
        parts.push(`${key}:${value}`)
    }
    return parts.filter(Boolean).join(' ')
}

export function isValidDueDate(dueStr) {
    return parseDate(dueStr) !== null
}

/**
 * Check if a yyyy-MM-dd due date is strictly before today (local timezone).
 * @param {string} dueStr
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isOverdue(dueStr, now = new Date()) {
    const due = parseDate(dueStr)
    if (!due) return false
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    return due < today
}

/**
 * Format a yyyy-MM-dd date for display.
 * Omits the year when it matches the current year.
 * @param {string} dueStr
 * @param {Date} [now]
 * @returns {string}
 */
export function formatDueDate(dueStr, now = new Date()) {
    const due = parseDate(dueStr)
    if (!due) return dueStr
    const month = due.toLocaleString('en-US', { month: 'short' })
    const day = due.getDate()
    if (due.getFullYear() === now.getFullYear()) {
        return `${month} ${day}`
    }
    return `${month} ${day}, ${due.getFullYear()}`
}

/**
 * Parse a yyyy-MM-dd string as a local date (not UTC).
 * @param {string} str
 * @returns {Date|null}
 */
function parseDate(str) {
    if (!META_REGISTRY.due.test(str)) return null
    const [y, m, d] = str.split('-').map(Number)
    const date = new Date(y, m - 1, d)
    // Validate the date is real (e.g. 2026-02-30 rolls over to March)
    if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
        return null
    }
    return date
}

function parseRecurrence(recStr) {
    const match = META_REGISTRY.rec.exec(String(recStr || ''))
    if (!match) return null
    const count = match[0].slice(0, -1) ? parseInt(match[0].slice(0, -1), 10) : 1
    return { count, unit: match[1] }
}

function daysInMonth(year, monthIndex) {
    return new Date(year, monthIndex + 1, 0).getDate()
}

function formatDateISO(date) {
    const y = date.getFullYear()
    const m = String(date.getMonth() + 1).padStart(2, '0')
    const d = String(date.getDate()).padStart(2, '0')
    return `${y}-${m}-${d}`
}

/**
 * Advance a yyyy-MM-dd due date by a rec:\d*(y|m|w|d) interval.
 * Advances from the due date itself (not from today), so a late check-off
 * still lands on the next natural occurrence.
 * Month/year steps keep the same day-of-month, clamped to the last valid
 * day of the resulting month (e.g. Jan 31 + 1m -> Feb 28/29).
 * @param {string} dueStr
 * @param {string} recStr
 * @returns {string|null} next due date in yyyy-MM-dd, or null if inputs are invalid
 */
export function advanceDueDate(dueStr, recStr) {
    const due = parseDate(dueStr)
    const rec = parseRecurrence(recStr)
    if (!due || !rec) return null

    let year = due.getFullYear()
    let month = due.getMonth()
    const day = due.getDate()

    if (rec.unit === 'd') return formatDateISO(new Date(year, month, day + rec.count))
    if (rec.unit === 'w') return formatDateISO(new Date(year, month, day + rec.count * 7))

    if (rec.unit === 'm') {
        month += rec.count
        year += Math.floor(month / 12)
        month = ((month % 12) + 12) % 12
    } else {
        year += rec.count
    }
    return formatDateISO(new Date(year, month, Math.min(day, daysInMonth(year, month))))
}

/**
 * Check if a yyyy-MM-dd due date is strictly after today (local timezone).
 * @param {string} dueStr
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isFutureDue(dueStr, now = new Date()) {
    const due = parseDate(dueStr)
    if (!due) return false
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    return due > today
}

/**
 * Number of calendar days between today and a yyyy-MM-dd due date (today = 0).
 * @param {string} dueStr
 * @param {Date} [now]
 * @returns {number|null}
 */
export function daysUntilDue(dueStr, now = new Date()) {
    const due = parseDate(dueStr)
    if (!due) return null
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    return Math.round((due - today) / 86400000)
}