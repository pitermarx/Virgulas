# VMD — Virgulas Markdown Format

VMD is a plain-text format for infinite nested outlines. A conformant parser produces a tree of items, each containing optional checkboxes, free-text content, and multi-line descriptions.

## 1. Document Structure

A VMD document is a sequence of lines. Parsing begins at the first line matching the **item pattern**. All preceding lines are silently ignored.

Every line is exactly one of:
- **Item line** — matches the item pattern.
- **Description line** — any line not matching the item pattern. Belongs to the nearest preceding item line.

### 1.1 Encoding, Characters & Line Endings
- Documents are UTF-8 text. A "character" means one Unicode scalar value (code point); all length/indentation counts in this spec (§2.3, §4) are counted in code points, not bytes or UTF-16 code units.
- Line terminators are `\n` or `\r\n`. A `\r` immediately preceding `\n` is part of the terminator and is never included in indentation, content, or description text. A bare `\r` not followed by `\n` is treated as an ordinary content character.

### 1.2 Conformance
Every input document has exactly one defined parse tree, however unusual its formatting — VMD parsers MUST NOT reject input. Constructs that look malformed (e.g. an unclosed code fence) still resolve deterministically per the rules below rather than producing an error.

## 2. Indentation & Normalization

All structural parsing uses normalized indentation:

1. **Tab Replacement:** Every `U+0009` (TAB) in leading whitespace is replaced with exactly one `U+0020` (SPACE) before parsing. No tab-stop alignment is applied. Mixed tabs and spaces are handled by direct 1:1 replacement.
2. **Indentation Definition:** Indentation is the contiguous sequence of whitespace characters at the start of a line, ending at the first non-whitespace character.
3. **Description Baseline:** For each contiguous description block, find the non-empty line with the minimum indentation length. Strip exactly that many characters from the start of every line in the block. Whitespace-only lines are preserved as empty lines in the output and are excluded from baseline calculation.

## 3. Item Lines & Nesting

An item line matches:
```
indent ("-"|"+") " " checkbox? content
```
- `indent` — normalized leading whitespace.
- `-` — marks the item as open. `+` — marks the item as collapsed.
- The marker **MUST** be followed by exactly one space. `-foo` is a description line.
- `checkbox` — optional. `[ ] ` (TODO) or `[x] ` / `[X] ` (DONE). The trailing space is mandatory.
- `content` — all remaining characters on the line. May be empty.

### 3.1 Nesting Rules
- An item's parent is the nearest preceding item line with strictly less indentation.
- Items with no such parent are root nodes.
- Siblings are items that resolve to the same parent.
- Description lines never affect parent resolution or indentation tracking.

## 4. Description Lines & Escaping

Description lines accumulate until the next item line or EOF. After baseline indentation is stripped, escaping is applied.

### 4.1 Escape Rules
Escape processing inspects the **first non-whitespace character** of the indentation-stripped line.
Any whitespace still remaining before it is skipped for this check and preserved verbatim in the output:

- If that character is `\`, inspect the character immediately following it.
- If next is `-`, `+`, or `\`, consume both characters and output the second character in its place.
- Otherwise, output `\` literally.
- If the first non-whitespace character is not `\`, no escape processing occurs on the line.
- No further escape processing occurs on the line. All subsequent backslashes are literal.

Examples:
- `\- foo` → `- foo`
- `\\- foo` → `\- foo`
- `\\\- foo` → `\\- foo`
- `\n foo` → `\n foo` (literal backslash)
- `  \- foo` (leading whitespace from baseline, then escape) → `  - foo`

## 5. Code Fences

- A description line that, after baseline stripping, consists solely of `` ``` `` opens or closes a code fence.
- Inside an open fence, VMD parsing (item detection, nesting, escaping) is suspended. All lines are appended literally to the current item's description.
- Fences may only appear within description blocks; a `` ``` `` line appearing before the first item line is ignored along with the rest of the preamble (§1) and has no special effect.
- An unclosed fence consumes all subsequent lines, including EOF, into the owning item's description.

## 6. Formal Grammar

```ebnf
document      := line*
line          := item_line | desc_line

item_line     := indent marker space checkbox? content
indent        := whitespace*
marker        := "-" | "+"
space         := " "
checkbox      := "[" (" " | "x" | "X") "] "
content       := char*

desc_line     := indent (escaped_line | plain_line)
escaped_line  := "\" ("-" | "+" | "\") char*
plain_line    := char*  ; any line not matching item_line
```

## 7. Worked Example

**Source:**
```
- Ship *VMD* spec
  Draft the full spec, get feedback, publish.

  \- this paragraph intentionally starts with a dash
  - [ ] Write grammar section (#notatag)
  + [x] Decide on escape character
    settled on backslash, see discussion (preserves leading space)
   example of whitespace baseline
    - Tell the team
  - [ ] Simplify the spec
```

**Parsed Structure:**
```json
[
  {
    "id": 1,
    "text": "Ship *VMD* spec",
    "open": true,
    "description": "Draft the full spec, get feedback, publish.\n\n- this paragraph intentionally starts with a dash",
    "children": [2, 3, 5]
  },
  {
    "id": 2,
    "text": "Write grammar section (#notatag)",
    "open": true,
    "status": "TODO"
  },
  {
    "id": 3,
    "text": "Decide on escape character",
    "open": false,
    "status": "DONE",
    "description": " settled on backslash, see discussion (preserves leading space)\nexample of whitespace baseline",
    "children": [4]
  },
  {
    "id": 4,
    "text": "Tell the team",
    "open": true
  },
  {
    "id": 5,
    "text": "Simplify the spec",
    "open": true,
    "status": "TODO"
  }
]
```
*Note: Baseline for item 3's description is 3 spaces (from `example of...`). Stripping 3 spaces leaves 1 leading space on the first line and 0 on the second. JSON shape is illustrative; `status` and `children` are omitted when absent.*

## 8. Extensions

VMD core defines only structure. Extensions layer conventions on top. Conforming parsers may ignore extensions.

### Layer A — Inline Markdown
Item content and description text may contain standard inline Markdown (emphasis, links, code spans). Block-level Markdown is permitted in descriptions only.

### Layer B — Tags & Mentions
- Syntax: `@identifier` or `#identifier`.
- Boundaries: Must be preceded by whitespace or start-of-line (after baseline stripping). Terminated only by whitespace or end-of-line. Punctuation is included in the identifier (e.g., `#C++`, `@user,`).
- Exclusions: Never scan inside inline backticks or code fences.

### Layer C — Metadata
Metadata is parsed only on item lines, anchored to the end of the content string. Implementations must define a registry of valid property names and optional value regexes.

**Registered Keys:**
- `due` — value must match `\d{4}-\d{2}-\d{2}` and represent a valid Gregorian calendar date (a `yyyy-MM-dd` date). Used to mark a task's due date. Overdue tasks (due date strictly before today) are highlighted and prioritized in the Tasks sidebar; the tasks toolbar icon is highlighted when any pending task is overdue.

**Parsing Pipeline (per item line):**
1. Extract checkbox (if present).
2. Scan remaining content for metadata.
3. Scan remaining content for tags/mentions.
4. Residual string becomes item `text`.

**Metadata Recognition Algorithm:**
1. Split item content into whitespace-delimited tokens.
2. Scan tokens **right-to-left**.
3. A token matches if it contains a colon, splits into `property:value` at the **first colon**, `property` exists in the registry, and `value` passes the optional regex.
4. **First match wins** (equivalent to last-on-line wins). Stop scanning immediately upon encountering any non-matching token, unregistered property, tag, or mention.
5. All tokens to the left of the stop point become content for subsequent pipeline stages.
6. Applies identically to `-` and `+` items.

### Extension Worked Example

**Source:**
```
- Dev Project
  This is the description.
  - [ ] Support #C++ tags
  - [x] Fix YAML block @rob
    ```yaml
    - list: priority:low
    + list: @bob #vmd
    ```
    The code block above did not trigger VMD nesting.
    \- neither does this
    -or this
- Final Item priority:high priority:low
```

**Parsed Structure:**
```json
[
  {
    "id": 1,
    "text": "Dev Project",
    "description": "This is the description.",
    "children": [2, 3],
    "open": true
  },
  {
    "id": 2,
    "text": "Support #C++ tags",
    "tags": ["C++"],
    "open": true,
    "status": "TODO"
  },
  {
    "id": 3,
    "text": "Fix YAML block",
    "mentions": ["rob"],
    "description": "```yaml\n- list: priority:low\n+ list: @bob #vmd\n```\nThe code block above did not trigger VMD nesting.\n- neither does this\n-or this",
    "open": true,
    "status": "DONE"
  },
  {
    "id": 4,
    "text": "Final Item",
    "open": true,
    "meta": {
      "priority": "low"
    }
  }
]
```
*Note: In item 4, backward scan hits `priority:low` first, claims it, and stops. `priority:high` becomes part of `text`. In item 3, `@rob` stops metadata scanning (none present), is extracted as a mention, and leaves `Fix YAML block` as text. Code fence content is literal. `-or this` requires no escape as it lacks the mandatory post-marker space.*