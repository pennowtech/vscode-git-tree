# GitTree

A GitLens-style git experience for VS Code: a **colorful commit graph** with branch lanes on the left, a **rich details pane** on the right, plus branch/stash/tag management, compare, file history, diffs, and inline blame — all with **zero dependencies** (it drives the `git` CLI directly).

## Features

### Commit Graph (`Ctrl+Alt+G`)
- Colorful branch lanes (SVG), merge nodes, and a dedicated left-hand branches/tags column with theme-safe ref chips.
- Commit-signing indicators for valid and problematic signatures.
- **Uncommitted changes** pseudo-row at the top when the working tree is dirty.
- Toolbar: branch scope (all / current), live search (message, author, SHA), Fetch / Pull / Push / Stash / Refresh.
- Click a commit → the **right pane** shows author, dates, full message, parents (clickable), refs, and every changed file with `+/−` stats. Click a file to open a **VS Code diff editor**.
- Resizable splitter between graph and details; layout is remembered.

### Compare
- **Ctrl/Cmd-click** a second commit to compare it with the selected one.
- Right-click a commit or branch chip → *Select for Compare* / *Compare with Selected* / *Compare with HEAD / current branch*.
- `GitTree: Compare Two Refs…` command with quick-pick for branches and tags.
- Compare view shows ahead/behind counts, commits unique to each side, and all differing files (click to diff). One-click **swap** of sides.

### Right-click actions
- **Commits**: checkout (detached), create branch/tag here, cherry-pick, revert, reset (soft / mixed / hard), copy SHA / message.
- **Branch chips**: checkout, merge into current, rebase current onto, rename, delete, compare, copy name.
- **Tag chips**: checkout, compare, delete.
- Destructive actions always ask for confirmation first.

### Sidebar (GitTree activity bar icon)
- **Changes** — native file-theme icons, color decorations, right-aligned status, diffs, stage/unstage, discard, commit, amend, and signed commit workflows.
- Commit, amend, and signing actions are available from Changes; the graph working-tree details also provide a commit-message entry.
- Deleted files are red and struck through, while each file has only one right-aligned status indicator.
- The GitTree activity badge reports the current number of changed files.
- Changes can be viewed as a flat list or folder tree and sorted by path, filename, or status; advanced stash choices cover tracked, untracked, staged-only, and keep-index workflows.
- **Branches** — grouped by slash prefix, expandable commit history, current/tracking status, signature indicators, rebase and interactive rebase actions.
- Branch tracking icons distinguish ahead, behind, and diverged branches; current branches omit the redundant switch action. Branch tools include remote URL management and author filtering.
- **Stashes** — apply / pop / drop, create from the view title.
- **Tags** — checkout / compare / delete / create.
- **Worktrees** and **Submodules** — repository locations/status plus recursive submodule initialization/update.

### More
- **File History** — right-click a file (explorer or editor tab) → *GitTree: File History* shows the graph filtered to that file (follows renames).
- **Inline blame** — GitLens-style annotation at the end of the current line (`author, time ago · message · sha`). Toggle with *GitTree: Toggle Inline Blame*.
- **Full-file blame heatmap** — age-based, theme-aware line and overview-ruler highlighting.
- **GitHub/GitLab** — open the origin repository's pull/merge-request dashboard from the Branches view.
- **Pull Requests view** — loads GitHub, GitLab, or Azure DevOps requests with active/total comment counts. Selecting one opens its complete details and discussion inside VS Code, with an optional web link. Private GitLab/Azure tokens use VS Code Secret Storage.
- **Compare controls** — select any source/target branch, tag, commit, or the working tree; direct branch/commit compare actions target working changes.
- **Commit Graph view** — a dedicated, prominent sidebar entry opens the graph; graph scope text confirms whether all refs or only the current branch are loaded, and full ref names appear on hover.
- **Working-tree details** — filter files, switch between list/tree layouts, stage/unstage/discard/stash per file, reveal files, open their folder in a terminal, and complete commit/amend/sign workflows.
- **Status bar** — current branch; click to open the graph.
- Auto-refreshes when the repository changes (commits, checkouts, fetches…).

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `gitTree.maxCommits` | `500` | Max commits loaded in the graph |
| `gitTree.showRemoteBranches` | `true` | Include remote branches in the graph |
| `gitTree.blame.enabled` | `true` | Inline blame for the current line |
| `gitTree.dateFormat` | `relative` | `relative` or `absolute` dates |
| `gitTree.azureDevOps.repositoryUrl` | empty | Optional full Azure DevOps repository URL. Takes precedence over split Azure settings. |
| `gitTree.azureDevOps.endpoint` | empty | Azure DevOps base endpoint/collection URL, such as `https://dev.azure.com`, `https://dev.azure.com/my-org`, or an Azure DevOps Server collection URL. |
| `gitTree.azureDevOps.organization` | empty | Azure DevOps organization name when the endpoint does not already include it. |
| `gitTree.azureDevOps.project` | empty | Azure DevOps project name. |
| `gitTree.azureDevOps.repository` | empty | Azure DevOps repository name or ID. |

## Requirements

- `git` available on `PATH`.
- A workspace folder inside a git repository (multi-root: you'll be asked to pick one).

## Development

Open this folder in VS Code and press **F5** (no build step, no `npm install` needed). Package with `npx @vscode/vsce package`.

## Roadmap / ideas

- Blame gutter for the whole file & blame heatmap
- Interactive rebase editor
- Pull-request / issue linking in commit messages
- Commit signing indicators, worktree support, submodule views

## License

MIT
