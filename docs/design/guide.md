# Studio design guide

Direction: **Control panel**. Studio is a dense working tool. It shows the state of machines and Tasks first, with little empty space and square corners.

New UI follows this guide. Existing screens move to it when they are next changed; there is no separate rollout.

## Principles

- State comes first: it should be possible to see at a glance what is running, waiting or broken on each machine.
- Density is for lists, status and tool calls. Long agent text stays readable: its line length is limited, and its size is not reduced further.
- State is never shown by colour alone; it always has a text label too.
- The accent marks the selected row and the primary action only. Status colours are used only for status.
- Text is in English and in sentence case. Use the terms from `CONTEXT.md`.

## Colour

Define these as CSS variables. Light and dark are both supported, following the browser's setting.

| Token | Light | Dark | Use |
|---|---|---|---|
| `--bg` | `#eceef2` | `#16191f` | Main background |
| `--side` | `#dfe2e9` | `#0f1115` | Sidebar and Task header |
| `--surface` | `#ffffff` | `#1e222a` | Inputs, user messages, permission requests |
| `--code` | `#f4f5f8` | `#0f1115` | Tool calls and output |
| `--fg` | `#15181f` | `#dce1ea` | Text |
| `--muted` | `#565d6d` | `#98a1b1` | Secondary text |
| `--line` | `#c6cbd6` | `#2f3540` | Borders |
| `--accent` | `#0a6c8f` | `#5ccbeb` | Selected row, primary button |
| `--on-accent` | `#ffffff` | `#0f1115` | Text on the accent |
| `--ok` | `#1a7350` | `#6ccfa2` | Online, completed tool call |
| `--wait` | `#8f5200` | `#f0b35a` | Waiting for a decision |
| `--bad` | `#b3261e` | `#ff8f85` | Errors |

## Type

- **UI and text:** IBM Plex Sans, weights 400, 500 and 600.
- **Commands, paths, output and times:** IBM Plex Mono, weights 400 and 500.
- Fonts are bundled with Studio, not loaded from a CDN, because Studio must work without internet access. Fall back to `system-ui` and `ui-monospace`.

| Use | Size |
|---|---|
| Task title | 15px, weight 600 |
| Agent and user text | 14px, line height 1.45, at most 80 characters wide |
| List rows, buttons, tool calls | 13px |
| Status, times, labels | 12px |

Times use tabular figures.

## Shape and spacing

- Spacing steps: 2, 4, 8, 12 and 16px.
- Corner radius is 2px everywhere, except round status dots.
- No shadows or gradients. Borders and background changes separate areas.
- Focus is a visible 2px outline in `--accent`.
- Text contrast meets WCAG AA.

## Layout

- A sidebar of about 250px, and a main panel that takes the rest.
- Below 720px, the sidebar stacks above the main panel.
- Main panel, top to bottom: Task header, log, message box.

## Components

- **Sidebar:** Tasks are grouped under their machine. The machine header shows a status dot, the name and the state in words. Each Task row shows the name and its state on the right.
- **Status dot:** filled when online, an empty ring when offline.
- **Buttons:** one primary button per area, filled with the accent. The others have a border and no fill. Destructive actions ask for confirmation.
- **Log:** one column of events, with the time on the left in mono. User messages sit on `--surface`. Agent text has no background.
- **Tool call:** a single row on `--code`, with the tool name, command or path in mono, and the result on the right. It expands to show details.
- **Permission request:** on `--surface` with a `--wait` border, a "Waiting for your decision" label, the command, and Allow, Always allow and Deny buttons.
- **Errors:** say what went wrong and what to do next, in `--bad`.
