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

- Background: `#f7f5f0`
- Surface: `#fdfbf7`
- Border: `#ddd9d0`
- Border (subtle): `#ece9e2`
- Text (primary): `#1a1814`
- Text (muted): `#6b6760`
- Text (faint): `#aaa79f`
- Accent (primary): `#2a5caa`
- Accent (soft background): `#e8eef8`
- Hover surface: `#f0ede6`
- Selected surface: `#e8eef8`
- Danger: `#c0392b`
- Search match: `#fff8e1`
- Search current match: `#fff0b0`
- Overlay: `rgba(20, 18, 14, 0.45)`
- Success: `#2e7d32`
- Error: `#d32f2f`
- Synced state: `#4caf50`

### Dark Theme

- Background: `#1a1714`
- Surface: `#242220`
- Border: `#3a3733`
- Border (subtle): `#2e2c2a`
- Text (primary): `#ede9e3`
- Text (muted): `#9b9790`
- Text (faint): `#605d58`
- Accent (primary): `#5c8ed6`
- Accent (soft background): `#1c2c46`
- Hover surface: `#2e2c28`
- Selected surface: `#1c2c46`
- Danger: `#e05c4a`
- Search match: `#473a18`
- Search current match: `#6a5318`

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
- Faint placeholders/hints: low contrast
- Section emphasis: 600 weight

## 4. Spacing System

Base spacing scale (px):

- 0, 1, 2, 4, 6, 8, 10, 12, 14, 16, 20, 24, 28, 32, 40

Usage guidance:

- Tight vertical rhythm for list rows (2-6px)
- Standard internal padding for controls (8-12px)
- Modal and larger containers use 20-24px

## 5. Shape, Border, and Elevation

### Corner Radius

- 2px, 3px, 4px, 6px, 8px, 12px, full circle

### Borders

- 1px borders for most controls and surfaces
- Use subtle border color for separators

### Shadows

- Small: soft outline for pinned bars
- Medium: moderate control elevation
- Large: modal elevation

## 6. Motion and Interaction

- Standard transition duration: 150ms
- Standard easing: `cubic-bezier(0.4, 0, 0.2, 1)`
- Use transitions for color, border, box-shadow, transform, and opacity
- Loading spinner: continuous linear rotation (~0.8s)
- Splash/intro fade: longer fade (~700ms)

## 7. Layout Structure

- Main content is centered with a readable max width (~760px).
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
- Preserve sufficient contrast in both themes for text and controls.
- Keep touch targets comfortable on mobile.
- Avoid relying on color alone where practical (pair with icon/shape/state).

## 10. Implementation Notes

- Implement all visuals through design tokens (colors, spacing, typography, radius, shadows, timing).
- Keep component states explicit and consistent across themes.
- Keep markdown/read-mode and edit-mode styles visually distinct.
