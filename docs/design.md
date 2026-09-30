# Virgulas Design System

This document captures the minimum visual and interaction rules needed to reproduce the current UI design, independent of implementation details.

## 1. Design Principles

- Calm, paper-like canvas with low-contrast surfaces.
- Dense but readable information layout for writing and editing.
- Subtle affordances: state changes rely on color, border, and small motion.
- Utility-first visual language: neutral base + one primary accent.
- Mobile and desktop use the same visual system with spacing adjustments.

## 2. Color System

Use semantic tokens instead of hardcoded colors.

### Light Theme

- Background (`--color-background`): `#f7f5f0`
- Surface (`--color-surface`): `#fdfbf7`
- Border (`--color-border`): `#ddd9d0`
- Border subtle (`--color-border-subtle`): `#ece9e2`
- Text primary (`--color-text-primary`): `#1a1814`
- Text muted (`--color-text-muted`): `#6b6760`
- Text faint (`--color-text-faint`): `#6f6b63`
- Accent primary (`--color-accent-primary`): `#2a5caa`
- Accent soft (`--color-accent-soft`): `#e8eef8`
- Hover surface (`--color-hover-surface`): `#f0ede6`
- Selected surface (`--color-selected-surface`): `#e8eef8`
- Danger (`--color-danger`): `#c0392b`
- Search match (`--color-search-match`): `#fff8e1`
- Search current (`--color-search-current`): `#fff0b0`
- Overlay (`--color-overlay`): `rgba(20, 18, 14, 0.45)`
- Success (`--color-success`): `#2e7d32`
- Error (`--color-error`): `#d32f2f`
- Synced (`--color-synced`): `#4caf50`
- Syncing (`--color-syncing`): `#f39c12`
- Offline (`--color-offline`): `#7f8c8d`
- Tag chip (`--color-tag-chip-bg` / `--color-tag-chip-text`): `#e4f2d8` / `#2d6a2f`
- Mention chip (`--color-mention-chip-bg` / `--color-mention-chip-text`): `#efe6f8` / `#6b3fa0`
- Due chip (`--color-due-chip-bg` / `--color-due-chip-text`): `#fdf0d5` / `#8a5a00`
- Recurrence chip (`--color-rec-chip-bg` / `--color-rec-chip-text`): `#dff2ef` / `#1b7265`

### Dark Theme

Applies to `[data-theme="dark"]`, and to the OS dark preference when no explicit theme is set.

- Background (`--color-background`): `#1a1714`
- Surface (`--color-surface`): `#242220`
- Border (`--color-border`): `#3a3733`
- Border subtle (`--color-border-subtle`): `#2e2c2a`
- Text primary (`--color-text-primary`): `#ede9e3`
- Text muted (`--color-text-muted`): `#9b9790`
- Text faint (`--color-text-faint`): `#8a867e`
- Accent primary (`--color-accent-primary`): `#5c8ed6`
- Accent soft (`--color-accent-soft`): `#1c2c46`
- Hover surface (`--color-hover-surface`): `#2e2c28`
- Selected surface (`--color-selected-surface`): `#1c2c46`
- Danger (`--color-danger`): `#e8715f`
- Search match (`--color-search-match`): `#473a18`
- Search current (`--color-search-current`): `#6a5318`
- Overlay (`--color-overlay`): `rgba(0, 0, 0, 0.7)`
- Tag chip: `#2b3f2c` / `#98d89d`
- Mention chip: `#2d2440` / `#b794f4`
- Due chip: `#3a2f1a` / `#e8b84b`
- Recurrence chip: `#183833` / `#5fcbb8`
- `--color-success`, `--color-error`, `--color-synced`, `--color-syncing`, and `--color-offline` are shared with the light theme.

## 3. Typography

### Font Families

- Sans: Inter, then system sans fallbacks
- Mono: system monospace stack (SFMono/Consolas/Menlo/Courier-like fallbacks)

### Type Scale

- 10px, 11px, 12px, 13px, 14px, 15px, 16px, 18px, 30px
- Primary document text: 1rem
- Description text: 0.875rem
- Inline code text: 0.875em

### Text Roles

- Primary content: regular weight, high contrast
- Muted metadata/help text: medium-low contrast
- Faint hints and secondary chrome: the lowest tier of text, still meeting WCAG AA (≥4.5:1) against the background — never use it for body copy
- Section emphasis: 600 weight

## 4. Spacing System

Base spacing tokens (`--space-1` … `--space-6`):

- `--space-1`: 4px
- `--space-2`: 8px
- `--space-3`: 12px
- `--space-4`: 16px
- `--space-5`: 20px
- `--space-6`: 24px

Finer values (1, 2, 6, 10, 14, 28, 32, 40 px) may appear for one-off adjustments, but
standard rhythm should use the tokens.

Usage guidance:

- Tight vertical rhythm for list rows (2-6px)
- Standard internal padding for controls (8-12px)
- Modal and larger containers use 20-24px

## 5. Shape, Border, and Elevation

### Corner Radius

- `--radius-xs`: 2px
- `--radius-sm`: 4px
- `--radius-md`: 8px
- `--radius-lg`: 12px
- `--radius-full`: 9999px (pill / full circle)

### Borders

- 1px borders for most controls and surfaces
- Use subtle border color for separators

### Shadows

- Small: soft outline for pinned bars
- Medium: moderate control elevation
- Large: modal elevation

## 6. Motion and Interaction

- Standard transition (`--transition-base`): 150ms
- Standard easing (`--ease-base`): `cubic-bezier(0.4, 0, 0.2, 1)`
- Use transitions for color, border, box-shadow, transform, and opacity
- Loading spinner: continuous linear rotation (~0.8s)
- Splash/intro fade: longer fade (~700ms)
- `prefers-reduced-motion: reduce` collapses `--transition-base` to zero, drops the splash fade, and disables the locked-canvas blur fade

## 7. Layout Structure

- Main content is centered with a readable max width (800px; wide mode removes the cap).
- A fixed top utility/search region can appear above content.
- A fixed bottom status/action bar is always docked.
- Content padding adapts when top utility region is visible.
- Mobile reduces top spacing and keeps interaction density compact.

## 8. Component Patterns

### Editable List Rows

- Row contains a small leading marker + content area.
- Row states: default, hover, focused, selected, search-match, search-current.
  - Hover: subtle warm surface tint (`--color-hover-surface`).
  - Focused (keyboard focus / editing): accent-soft background (`--color-accent-soft`) + a 3px left-side solid border in `--color-accent-primary`. Visually distinct from hover so the user always knows which node is active.
  - Selected (multi-select): selected-surface background (`--color-selected-surface`).
- Nested hierarchy uses visual indentation and a subtle guide line.
- Collapsed parent state uses a stronger marker treatment.

### Text Editing Surface

- Inline editable text with visible caret in accent color.
- Empty editable areas show low-contrast placeholder text.
- Inline rich text support for bold, italic, links, and code style.
- Optional image content scales within available width.

### Secondary Description Content

- Description is visually subordinate to main text.
- In read mode, preview truncates to two lines; "…" appended when more exist.
- Placeholder hint appears when empty in interactive states.
- In edit mode, the textarea auto-grows to reveal all content (no fixed height, no scroll).

### Search UI

- Hidden by default, shown as fixed horizontal panel.
- Toggled by `Escape` when no node is focused; `Escape` again dismisses it.
- Includes text input, result counter (`x/y`), and close action.
- Focus ring uses accent-tinted halo.

### Buttons

- Neutral button: surface background + border.
- Primary button: filled accent background, white text.
- Danger button: filled danger background, white text.
- Icon button variant: compact square-ish footprint.

### Inputs and Textareas

- Surface-toned background with 1px border.
- Focus state: accent border + 3px soft halo.
- Monospace treatment for code/raw/conflict editing contexts.

### Modal

- Centered dialog over dimmed, slightly blurred backdrop.
- Three-part structure: header, scrollable body, footer actions.
- Width optimized for desktop, capped on small viewports.

### Data/Shortcut Tables

- Simple row separators using subtle borders.
- Dense cell padding for quick scan.
- Keyboard token styling uses inset keycaps.

### Status Indicators

- Compact icon-sized indicators for storage/sync states.
- State color mapping:
  - Neutral/offline/pending: muted/faint tones
  - Syncing: accent
  - Synced/success: green
  - Error/conflict: danger

### Toast Feedback

- Centered above bottom bar.
- High-contrast inverted color treatment.
- Appears/disappears via opacity transition.

### Splash Experience

- Full-screen blocking layer during initialization.
- Centered logo, name, and tagline.
- Exit via fade-out transition.

## 9. Accessibility Baseline

- Ensure visible keyboard focus for all interactive elements.
  - Controls on a surface (buttons, toolbar/close icons, panel rows, pills) draw a 2px accent outline with a 2px offset (`--focus-outline`); full-bleed panel rows use a negative offset so the ring stays inside the scroll container.
  - Text fields use an accent border plus a 3px soft accent halo (`--focus-halo`), matching the search and dialog inputs.
- Text editing surfaces (node text, descriptions, passphrase and dialog fields) show an accent-coloured caret.
- Body text and meaningful small text meet WCAG AA contrast (≥4.5:1) in both themes; colour-only indicators clamp to their background deliberately.
- Keep touch targets comfortable on mobile: status-bar buttons, close controls, and Tasks panel pills grow on coarse pointers.
- Avoid relying on color alone where practical (pair with icon/shape/state).
- Exactly one `<h1>` per page; the shell exposes a `<main id="main-content">` landmark and a `contentinfo` status bar.
- A skip link is the first focusable element and moves focus to the main landmark without changing the URL hash.
- Form errors are text, tied to their input (`aria-invalid` + `aria-describedby`) and announced (`role="alert"`); success confirmations use `role="status"`.
- Background content is `inert` while a modal owns the screen.
- Respect `prefers-reduced-motion` and `forced-colors`; keep the focus ring visible under the user's own palette.

## 10. Implementation Notes

- Implement all visuals through design tokens (colors, spacing, typography, radius, shadows, timing).
- Keep component states explicit and consistent across themes.
- Keep markdown/read-mode and edit-mode styles visually distinct.
