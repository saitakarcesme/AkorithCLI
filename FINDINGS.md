# Akorith CLI terminal UI findings

## Baseline diagnosis

- The prompt is a normal `readline` line prefixed with a bottom-border glyph, so typed text is not enclosed by a real composer.
- The composer is appended after output instead of being anchored to terminal rows, so it moves upward and downward with transcript growth.
- The splash is cleared after the first prompt, which also removes the Akorith identity instead of retaining a compact header.
- Resize handling redraws individual overlays without a shared viewport model; old rows, stale widths, and asymmetric margins can remain.
- Width helpers disagree about minimum widths (`36`, `44`, `52`, and raw terminal width), creating overflow on narrow terminals.
- Panels assume enough horizontal space for multiple columns and lose useful information instead of switching layouts.
- Input wrapping is delegated to `readline`, so borders and metadata cannot follow multi-line input reliably.
- Cursor placement is inferred from printed row counts and becomes wrong after wrapped input, resize, or wide Unicode.
- Output and composer share the terminal's normal scrollback region; there is no reserved header/content/footer layout.
- The startup screen uses fixed body row counts, causing excessive empty space at some heights and clipping at others.

## Feature backlog derived from Claude Code, Codex CLI, and terminal UX conventions

1. Persistent compact Akorith header after a session starts.
2. Bottom-anchored, fully closed multi-line composer.
3. Responsive compact/regular/wide layout breakpoints.
4. A dedicated scrollable transcript viewport between header and composer.
5. Stable cursor restoration after every repaint and resize.
6. Multi-line editing with deterministic wrapping inside the composer.
7. Prompt history navigation with draft restoration.
8. Paste-safe input handling and visible paste indicators for large blocks.
9. Composer metadata showing model, permission mode, context, and token totals.
10. Context/token usage progress meter with warning thresholds.
11. Working-directory and git branch/status information in the persistent header.
12. Provider connection/availability indicator in the header.
13. Queue depth and running-state indicators while a turn is active.
14. Discoverable shortcut hint row that adapts to terminal width.
15. Compact fallback UI for terminals below 60 columns or 16 rows.
16. Overlay viewport constraints with scrolling for model/session/command/review pickers.
17. Transcript search and jump affordance matching `/timeline` expectations.
18. Clear interruption/exit guard state without corrupting the composer.
19. Reduced-motion and monochrome-compatible rendering.
20. Deterministic screen snapshots across a viewport test matrix.
21. Screen-reader/plain-output fallback when stdout is not a TTY.
22. Inline error/status notices that do not displace the composer.
23. Session title and turn count retained in the header.
24. Resize debouncing to avoid repaint storms and half-drawn frames.
25. Cleanup of alternate-screen, cursor, and scroll-region state on every exit path.

## Acceptance criteria

- Header remains visible from launch through completed and interrupted turns.
- Composer remains on the bottom edge and input stays inside all four borders.
- Every rendered row fits the active terminal width from 40 to 220 columns.
- Layout remains usable from 12 to 80 rows and reflows without stale artifacts.
- Core commands, pickers, sessions, review browser, provider output, interrupts, and exit cleanup remain functional.
- Automated tests and PTY screenshots cover representative compact, regular, wide, short, and tall viewports.
