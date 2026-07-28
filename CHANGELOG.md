# Changelog

## 0.0.4

- Replace the Activity Bar icon with a larger, theme-aware Git wordmark.
- Document how to hide or disable VS Code's built-in Source Control integration.
- Ship a fresh extension version so updated views, icons, and per-file untracked counts load without stale v0.0.3 caches.

## 0.0.3

- Tint complete commit rows with their primary branch-lane color in light and dark themes.
- Add subtle lane-colored dividers between commit rows.
- Keep branch and tag capsules readable with neutral theme backgrounds and colored outlines.

## 0.0.1

Initial release.

- Commit graph with colorful branch lanes, ref chips, merge nodes, and an uncommitted-changes row.
- Details pane: commit metadata, full message, parents, changed files with stats, click-to-diff.
- Compare any two commits / branches / tags (ctrl-click, context menu, or `GitTree: Compare Two Refs…`).
- Context-menu actions: checkout, branch, tag, cherry-pick, revert, reset, merge, rebase, rename, delete.
- Sidebar views: Branches (local/remote with tracking info), Stashes, Tags.
- File history (follows renames), inline blame for the current line, status-bar branch indicator.
- Fetch / pull / push / stash from the graph toolbar; auto-refresh on repository changes.
