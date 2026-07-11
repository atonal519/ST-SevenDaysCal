# 2026-07-10 — 事件线 (Storylines) Feature Development

**Project**: ST-SevenDaysCal — SillyTavern calendar/schedule planner extension  
**Repo**: git@github.com:atonal519/ST-SevenDaysCal.git  
**Commit**: `26c2954` (pushed to master, bypassed branch protection rule)

---

## Overview

Full implementation of a "事件线 (Storylines)" feature, allowing the user to replace the World Engine extension entirely. The concept: multiple named parallel plot threads, each with a stage and level, advancing independently from main character actions.

---

## Files Changed

| File | Change |
|------|--------|
| `state.js` | Added `buildStorylinesCacheKey()` |
| `index.js` | ~620 lines net added |
| `style.css` | ~172 lines net added |

---

## Features Implemented

### 1. "线" Tab in Panel Modal
- New fourth tab in the panel modal
- Displays LLM-generated storyline cards
- Stage colors borrowed from World Engine (see palette below)
- Level indicator: dot notation (●●○○)
- Each card shows: type badge, when marker, description

### 2. Inline Folded Block per AI Message
- Appended to every AI message DOM element via `CHARACTER_MESSAGE_RENDERED` event
- Uses `<details>/<summary>` with collapsed label `▶ 事件线 N条活跃`
- Always renders — shows "暂无" if no cache exists
- Theme-adaptive: `color: inherit` + `rgba(128,128,128,…)` backgrounds
- Semi-transparent, unobtrusive styling

### 3. Auto-Advance Modes
Saved in `extension_settings`:

- **Turn-based**: advances every N AI replies (default: every 2)
- **Time-based**: detects in-game date markers in message text (`第N天`, `周X`, `今天`, `明天`, etc.), advances when the in-game day changes

### 4. Continuity / Incremental Generation
- `triggerGenerateLines` does **not** clear cache before generating
- `runGenerateLines` reads existing raw text and feeds it back into the LLM prompt as "current tracked events"
- LLM advances existing threads rather than inventing new ones from scratch

### 5. Silent Mode
- `runGenerateLines(silent=true)` for background auto-advance
- No toasts, no settings popup, no error UI — fully transparent to the user

### 6. LLM Output Format

```
<storylines_widget>Line: name|type|stage|level|when
Desc: ...
</storylines_widget>
```

### 7. Stage Color Palette (from World Engine)

| Stage | Color |
|-------|-------|
| 萌芽 | `#d6b85a` |
| 发酵 | `#d98a3d` |
| 逼近 | `#cf5f3f` |
| 已爆发 | `#b93f3f` |
| 已消散 | `#888888` |
| 筹备 | `#7de9d9` |
| 执行 | `#58e8b3` |
| 关键 | `#2a8a5d` |
| 已完成 | `#1b5e3b` |
| 已失败 | `#888888` |

### 8. API Config Persistence Migration
- **Before**: localStorage
- **After**: `extension_settings[PLUGIN_ID]` + `saveSettingsDebounced()`
- Settings now survive browser cache clears
- Affected keys: `apiUrl`, `apiKey`, `apiModel`, `fabShow`, `linesInterval`, `linesMode`

### 9. Theme Auto-Detection
- Reads `--SmartThemeBodyColor` CSS variable via canvas luminance calculation
- `MutationObserver` on `document.documentElement` for live theme change detection
- Removed manual theme toggle button (was previously in UI)

### 10. FAB Toggle Relocation
- Moved from extension drawer checkbox to a `⊙` button in the topbar
- Extension drawer now has no content (effectively empty)

### 11. Panel Refresh Button Refactor
- Removed global regen button from topbar — was clipping the close button when the 4th tab was added
- Each panel now has its own inline refresh button
- Empty state shows a dedicated generate button

### 12. Back-fill on Init
- `backfillLinesInlineBlocks()` called on init and `CHAT_CHANGED`
- Injects inline blocks into the **last 10 AI messages** already present in DOM at load time

---

## Removed in This Session

- Fullscreen button
- Manual theme toggle button
- "打开日程" button from extension drawer
- All localStorage-based config keys (migrated to `extension_settings`)

---

## Known Issues / Not Yet Fixed

- **Horizontal resize (width) on mobile browser**: touch event handling for the resize handle may be getting intercepted by the browser. Not yet diagnosed. User will test on desktop first.

---

## Notes

- This feature was designed to make World Engine redundant for the user's use case — parallel storyline tracking with LLM-driven stage advancement feels more integrated and persistent than the World Engine approach.
- The `silent=true` auto-advance path is the primary production path; the manual "generate" button in the panel is for on-demand use.
- Continuity prompt design (feeding back existing raw output) is key to coherence across turns — without it, the LLM resets storylines each generation.
