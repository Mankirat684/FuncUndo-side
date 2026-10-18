# Change Log

All notable changes to the "chronos" (FuncUndo) extension will be documented in this file.

## [0.1.0] - 2026-09-28

### Added
- **Function-Scoped Undo & Redo:** Granular `Ctrl+Alt+Z` and `Ctrl+Alt+Y` keyboard shortcuts to navigate function versions without disturbing surrounding code.
- **SQLite History Storage:** Embedded WASM SQLite database persistence via Drizzle ORM, with per-file debounced auto-saving on file save.
- **Tree-Sitter AST Scope Extraction:** High-performance background worker parsing functions, class methods, and nested closures with line-range drift resolution.
- **Minimalist Status Bar Integration:** Context-aware status bar item on the bottom-right displaying the current function name and available revision count.
- **Tracked Functions Sidebar:** Native tree view organizing tracked files, functions, and timestamped versions in an Activity Bar container.
- **Side-by-Side Diff Viewer:** Click any snapshot in the tree view to compare historical states directly against the live file using VS Code's native diff editor.
- **Rename-Merge Workflow:** Safely stitch together the revision histories of functions across renames using atomic transactions.
- **Cross-File Blast Radius Analysis:** Incremental dependency resolution tracking function callers and callees across workspace files.