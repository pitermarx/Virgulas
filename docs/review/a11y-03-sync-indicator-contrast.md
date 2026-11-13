# The sync indicator is low-contrast and colour-coded

- **Severity:** Low
- **Confidence:** verified (contrast computed from the design tokens)
- **Spec impact:** none (the visually hidden status text already exists)

## Description

WCAG 1.4.11 asks for 3:1 contrast on meaningful non-text elements. Against the light background (`#f7f5f0`):

| Token | Value | Contrast |
| --- | --- | --- |
| `--color-synced` | `#4caf50` | 2.55:1 |
| `--color-syncing` | `#f39c12` | 2.01:1 |
| `--color-offline` | `#7f8c8d` | 3.19:1 |

The dot is the only visual cue and differs by hue (red/green pairs affect colour-blind users); the state text is only in `title` and a visually hidden span. Text tokens pass AA in light and dark themes, except `--color-text-faint` on `--color-surface` in dark (`#8a867e` on `#242220`, 4.37:1).

## Evidence

- [source/css/base.css](../../source/css/base.css)
- [source/js/ui.ts](../../source/js/ui.ts#L619)

## Suggested fix

Darken the light-theme dot colours to at least 3:1, add a shape or icon per state (check, spinner, exclamation, cloud-off), and show the label text on wide layouts. Lighten `--color-text-faint` on dark surfaces slightly.

## Tests

A unit test that computes contrast for all token pairs and fails below the threshold.

<!-- roadmap -->
## Roadmap position

- **Phase:** [0A — Quick wins (code)](README.md#phase-0a)
- **Size:** S
- **Do these first:** —
- **Unblocks:** —
- **Its decision changes how these are built:** —
- **Shaped by:** —
- **Related:** [a11y-04](a11y-04-no-automated-accessibility-testing.md)
