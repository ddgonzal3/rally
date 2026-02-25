# Rally Design Specification

This document defines Rally's visual design language. It is used by AI agents to evaluate screenshots for visual compliance. All values are extracted from the current codebase.

## 1. Design Principles

- **macOS-native feel**: frosted glass surfaces, native traffic lights, system fonts
- **Dark theme**: specific neutral palette with minimal accent colors
- **Information density**: balanced with breathing room — not cramped, not wasteful
- **No gratuitous color**: color only for semantic meaning (errors, warnings, success). All icons and buttons are neutral unless explicitly colored.
- **No backdrop overlays on modals**: modals float above content without dimming

## 2. Color System

### Backgrounds

| Token | Value | Usage |
|-------|-------|-------|
| App background | `#1a1a1a` | Root container, sidebar |
| Terminal background | `#1b1b1b` | Terminal containers |
| Modal background | `linear-gradient(180deg, rgba(37,39,44,0.95), rgba(30,33,38,0.96))` | Full modals (AddWorkspace, Commit) |
| Modal footer | `rgba(16, 19, 24, 0.36)` | Modal footer areas |
| Panel/input background | `#1e1e1e` | Quick open modal, ship terminal |
| Input field | `#14181f` | Modal inputs |
| Rename input | `#2a2d2e` | Inline rename fields |
| Quick open input | `#3c3c3c` | Search/filter inputs |
| Active workspace | `#2a2a2a` | Selected sidebar item |
| Ship pill | `#2a2a2a` | Ship status indicator |
| Ship toolbar | `#252525` | Ship toolbar row |
| Hover state | `rgba(255, 255, 255, 0.06)` | General hover (implicit) |
| Active/selected (list) | `#04395e` | Quick open selected item |

### Frosted Glass (dropdowns/popovers)

```css
background: rgba(36, 36, 36, 0.78);
backdrop-filter: blur(20px) saturate(180%);
border: 1px solid rgba(255, 255, 255, 0.12);
```

### Text

| Token | Value | Usage |
|-------|-------|-------|
| Primary text | `#d0d0d0` – `#eee` | Titlebar, active items |
| Workspace item | `#ddd` | Sidebar workspace names |
| Active workspace | `#eee` | Selected workspace name |
| Modal title | `#eceff4` | Dialog titles |
| Modal subtitle | `#9da8b7` | Dialog subtitles |
| Input text | `#edf1f7` | Form input values |
| Label text | `#9aa4b1` | Form labels |
| Secondary text | `#999` | Inactive activity icons, muted labels |
| Muted text | `#666` – `#777` | Very low emphasis |
| Quick open filename | `#e3e3e3` | File search results (primary) |
| Quick open path | `#bbbbbb` | File search results (secondary) |
| Placeholder text | `#989898` | Input placeholders |
| Highlight/match | `#2aaaff` | Search match highlighting |

### Semantic Colors

| Token | Value | Usage |
|-------|-------|-------|
| Error | `#e06c75` / `#f29b9b` | Error states, error text |
| Warning | `#f59e0b` / `#e8b930` | Manual review, warnings |
| Success | `#7ddf7d` | Auto merge, success states |

### Icons

| Token | Value | Usage |
|-------|-------|-------|
| Default icon | `#999` – `#aaa` | Sidebar add button, inactive icons |
| Active icon | `#ddd` | Activity bar active, sidebar visible toggle |
| Activity bar inactive | `#bbb` | Inactive tab icons |

### Borders

| Token | Value | Usage |
|-------|-------|-------|
| Standard border | `#2a2a2a` | Titlebar, activity bar, resize lines |
| Sidebar header | `#333` | Sidebar section dividers |
| Modal border | `#343a45` | Modal outer border |
| Modal section | `#2e3440` | Modal header/footer borders |
| Modal input border | `#323a48` | Input field borders |
| Input focus | `#007acc` / `#007fd4` | Focused input border (VS Code blue) |
| Quick open border | `#454545` | Quick open modal border |
| Dashed border | `#3d4552` | Empty state indicators |

## 3. Typography

### Font Families

| Context | Value |
|---------|-------|
| UI text | `-apple-system, BlinkMacSystemFont, sans-serif` |
| Terminal | `Menlo, Monaco, 'Courier New', monospace` |
| Ship terminal | `'SF Mono', 'Fira Code', 'Cascadia Code', monospace` |

### Font Sizes

| Element | Size |
|---------|------|
| App titlebar | 13px |
| Sidebar header | 11px |
| Sidebar workspace item | 13px |
| Modal title | 18px |
| Modal subtitle | 11px |
| Modal label | 11px |
| Modal input | 13px |
| Modal button | 11.5px |
| Terminal | 13px |
| Quick open input | 14px |
| Quick open results | 13px |
| Ship pill title | 12px |
| Ship pill subtitle | 11px |
| Ship pill extra | 10px |
| Search panel | 13px |

### Font Weights

| Element | Weight |
|---------|--------|
| Regular text | 400 (normal) |
| Modal input text | 520 |
| Workspace name | 600 |
| Modal title | 620 |
| Quick open filename | 625 |
| Titlebar text | 700 |
| Sidebar header title | 700 |
| Modal label | 700 |
| Modal button text | 700 |
| Search match highlight | 700 |

## 4. Spacing System

### Component Padding

| Element | Padding |
|---------|---------|
| Sidebar header | `0 8px 0 12px` |
| Workspace item | `10px 20px 10px 16px` |
| Terminal container | `4px` |
| Modal header | `11px 14px 9px` |
| Modal body | `10px 14px 12px` |
| Modal footer | `9px 14px 11px` |
| Quick open input wrapper | `6px 6px 4px` |
| Quick open input field | `5px 8px` |
| Quick open result item | `0 8px` |
| Ship status footer | `8px 12px` |

### Gaps (flexbox)

| Element | Gap |
|---------|-----|
| Activity bar icons | 2px |
| Modal title wrapper | 2px |
| Modal body sections | 12px |
| Path list items | 4px |
| Path item content | 6px |
| Ship toolbar | 8px |
| Quick open result | 6px |

## 5. Component Specifications

### Activity Bar
- Width: **46px**
- Button size: **32×32px**
- Icon color: inactive `#bbb`, active `#ddd`
- Background: `#1a1a1a`
- Border right: `1px solid #2a2a2a`

### Sidebar
- Min width: **120px**, Max width: **400px**
- Background: `#1a1a1a`
- Header height: **29px**
- Header font: 11px, weight 700, text transform uppercase
- Header border bottom: `1px solid #333`
- Workspace item: font 13px, weight 600, color `#ddd`
- Active workspace: background `#2a2a2a`, color `#eee`
- Add button icon color: `#aaa`

### Titlebar
- Height: **34px**
- Left padding: **70px** (room for traffic lights)
- Background: `#1a1a1a`
- Border bottom: `1px solid #2a2a2a`
- Text: 13px, weight 700, color `#d0d0d0`
- Z-index: **100**

### Terminal
- Background: `#1b1b1b`
- Font: `Menlo, Monaco, 'Courier New', monospace` at 13px
- Foreground: `#d4d4d4`
- Cursor: bar style, width 2, blink enabled, color `#aeafad`
- Selection: `#44444488`
- Container padding: 4px

### Modals/Dialogs
- **No backdrop overlay** — modals float without dimming
- Background: gradient `rgba(37,39,44,0.95)` to `rgba(30,33,38,0.96)`
- Border: `1px solid #343a45`
- Border radius: **10px**
- Box shadow: `0 24px 60px rgba(0,0,0,0.52), 0 0 0 1px rgba(255,255,255,0.03)`
- Width: 420px (standard modals)
- Z-index: **1000**

### Quick Open
- Position: absolute, top 24%
- Width: `min(62%, 700px)`
- Max height: `min(36vh, 430px)`
- Background: `#1e1e1e`
- Border: `1px solid #454545`
- Border radius: **6px**
- Box shadow: `0 5px 18px rgba(0,0,0,0.5)`
- Z-index: **2550**

### Buttons
- Default: neutral colors, no accent
- Border radius: **4px**
- Font weight: 700
- Font size: 11.5px (modal context)

### File Explorer
- Indent per level: variable (tree structure)
- Icon size: matches adjacent icons
- Icons: neutral color (`#999`)

### Resize Handle
- Width: **6px** (visible), **8px** (hit area)
- Z-index: **10**
- Color: `#2a2a2a` (line)

## 6. Layout Rules

- Sidebar always on the left
- Activity bar to the left of sidebar
- Titlebar spans full width, 34px tall
- Main content fills remaining space after sidebar
- Pane grid: children divide space proportionally
- File explorer: between sidebar and panes when visible
  - Min width: 120px, Max width: 500px

## 7. Box Shadows

| Element | Value |
|---------|-------|
| Dragging workspace | `0 8px 20px rgba(0,0,0,0.38)` |
| Modal | `0 24px 60px rgba(0,0,0,0.52), 0 0 0 1px rgba(255,255,255,0.03)` |
| Quick open | `0 5px 18px rgba(0,0,0,0.5)` |
| Ship pill | `0 4px 20px rgba(0,0,0,0.5)` |

## 8. Z-Index Hierarchy

| Element | Z-Index |
|---------|---------|
| Quick open overlay | 2550 |
| Ship status pill | 1001 |
| Modal overlay | 1000 |
| Titlebar | 100 |
| Resize handle | 10 |
| Dragging workspace | 4 |

## 9. Transitions & Animation

| Element | Value |
|---------|-------|
| Workspace reorder | `transform 170ms cubic-bezier(0.2, 0, 0, 1)` |
| Workspace item hover | `box-shadow, background 120ms` |
| Ship pill width | `0.2s ease` |
| Scrollbar thumb | `0.2s` |
| Search tree twistie | `0.1s ease` |

## 10. Scrollbar Styling

```css
::-webkit-scrollbar { width: 6px; height: 0; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: transparent; border-radius: 3px; transition: background 0.2s; }
:hover::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.15); }
:hover::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.25); }
::-webkit-scrollbar-corner { background: transparent; }
```

## 11. Terminal ANSI Colors

```
black:   #1e1e1e    bright black:   (default)
red:     #df7d7d    bright red:     (default)
green:   #7ddf7d    bright green:   (default)
yellow:  #dfdf7d    bright yellow:  (default)
blue:    #7d7ddf    bright blue:    (default)
magenta: #df7ddf    bright magenta: (default)
cyan:    #7ddfdf    bright cyan:    (default)
white:   #e0e0e0    bright white:   (default)
```

## 12. Anti-Patterns (Things That Should Never Appear)

- Colored buttons or icons without explicit request
- Font mismatches between adjacent elements (size, family, weight)
- Non-frosted dropdown/popover backgrounds (must use frosted glass)
- Backdrop overlays behind modals (no dimming/blurring of background)
- Misaligned icons relative to neighboring text
- Inconsistent spacing between same-type elements
- System default scrollbar styling (should use custom thin scrollbars)
