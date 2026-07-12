# GitTree User Guide

This guide covers daily GitTree use. Steps are short. Commands use their displayed VS Code names.

## 1. Before you start

You need:

- VS Code 1.90 or newer.
- Git on `PATH`.
- A workspace inside a Git repository.
- A trusted workspace.

Open the GitTree icon in the Activity Bar.

In WSL, SSH, Dev Containers, or Codespaces, install GitTree in the remote workspace. It requires the Node workspace extension host and the Git CLI. It does not run in the Web Worker host.

To reopen this guide:

- Select the book icon in Changes, Branches, or Pull Requests.
- Or run **Open User Guide** from the Command Palette.

## 2. Main views

| View | Use it for |
| --- | --- |
| Commit | Enter a message. Commit, amend, or sign. |
| Changes | Review and manage local file changes. |
| Branches | Browse, switch, sync, compare, merge, and rebase. |
| Stashes | Create, inspect, apply, pop, or delete stashes. |
| Tags | Create, checkout, compare, or delete tags. |
| Worktrees | Add, open, lock, unlock, remove, or prune worktrees. |
| Submodules | Open, update, initialize, or synchronize submodules. |
| Pull Requests | Review GitHub, GitLab, or Azure DevOps requests. |

## 3. Open the commit graph

Choose one option:

- Run **Show Commit Graph**.
- Press `Ctrl+Alt+G`.
- On macOS, press `Cmd+Alt+G`.
- Select the branch name in the status bar.

The graph shows:

- Commit lanes.
- Branches and tags.
- Merge points.
- Authors and dates.
- Commit signatures.
- Working changes.

Use the top toolbar to:

- Search commits.
- Show all refs.
- Show only the current branch.
- Fetch, pull, push, stash, or refresh.

Hover over a shortened branch bubble to see its full name.

## 4. Review a commit

1. Select a commit.
2. Review its message and metadata.
3. Review the changed-file list.
4. Select a file to open its diff.

To review every file together:

1. Right-click the commit.
2. Select **Open Changes**.
3. Use VS Code's multi-file changes editor.

## 5. Compare revisions

### Compare two graph commits

1. Select the first commit.
2. Hold `Ctrl` or `Cmd`.
3. Select the second commit.

### Compare from the context menu

1. Right-click a branch or commit.
2. Select **Select for Compare**.
3. Right-click another branch or commit.
4. Select **Compare with Selected**.

### Compare two refs from the Command Palette

1. Run **Compare Two Refs…**.
2. Pick the base ref.
3. Pick the target ref.

### Compare with local work

Right-click a branch or commit. Select **Compare with Working Changes**.

Graph colors identify the source and target rows.

## 6. Work with local changes

Open the **Changes** view.

### File states

| Code | Meaning |
| --- | --- |
| A | Added |
| M | Modified |
| D | Deleted |
| R | Renamed |
| C | Conflicted |
| U | Untracked |

### Review a file

- Select a file to open its diff.
- Right-click it for more actions.

Available actions include:

- Open File.
- Reveal in Explorer.
- Copy Path.
- Copy Relative Path.
- Stage.
- Unstage.
- Discard.

Discard asks for confirmation.

### Change the layout

Use the view menu to:

- View as Tree.
- View as List.
- Sort by Path.
- Sort by Name.
- Sort by Status.

### Stage files

- Select the plus icon to stage a file.
- Select **Stage All Changes** to stage everything.
- Select the minus icon to unstage a file.
- Select **Unstage All Changes** to clear the index.

## 7. Create a commit

1. Stage the required files.
2. Enter a message in the **Commit** view.
3. Select **Commit**.

Other workflows:

- **Amend Last Commit** keeps the existing message when no new message is supplied.
- **Sign and Commit…** creates a signed commit.
- Configure Git signing before using signed commits.

## 8. Work with branches

Expand a branch to see recent commits.

Branch indicators show:

- Current branch.
- Upstream branch.
- Ahead count.
- Behind count.
- Diverged state.
- Last update time.

Right-click a branch for:

- Switch Branch.
- Fetch Branch.
- Pull Branch.
- Push Branch.
- Open Changes.
- Select for Compare.
- Compare with Selected.
- Compare with Working Changes.
- Merge into Current Branch.
- Rebase Current Branch onto This.
- Interactive Rebase.
- Create Pull/Merge Request.
- Create Tag at Branch.
- Open Branch on Remote.
- Rename Branch.
- Delete Branch.
- Copy Name.

The current branch does not show **Switch Branch**.

## 9. Work with commits

Expand a branch. Right-click a commit.

Available actions include:

- Show Commit in Graph.
- Open Changes.
- Select for Compare.
- Compare with Selected.
- Cherry-pick Commit.
- Revert Commit.
- Create Branch at Commit.
- Create Tag at Commit.
- Checkout Commit.
- Copy Commit ID.

Checkout Commit uses detached HEAD mode.

## 10. Merge and rebase

### Merge

1. Switch to the receiving branch.
2. Right-click the source branch.
3. Select **Merge into Current Branch**.
4. Confirm the action.

### Rebase

1. Switch to the branch you want to move.
2. Right-click the new base branch.
3. Select **Rebase Current Branch onto This**.

### Interactive rebase

1. Right-click a branch or commit.
2. Select **Interactive Rebase…**.
3. Edit the Git rebase plan in the terminal/editor.

During a rebase, use:

- Continue Rebase.
- Skip Rebase Commit.
- Abort Rebase.

## 11. Use stashes

Open the **Stashes** view.

You can:

- Create a stash.
- Include untracked files.
- Stash staged files only.
- Keep staged files in the index.
- View a stash.
- Apply a stash.
- Pop a stash.
- Delete a stash.

Apply keeps the stash. Pop removes it after a successful apply.

## 12. Use tags

Open the **Tags** view or use a branch/commit context menu.

You can:

- Create a lightweight tag.
- Create an annotated tag.
- Checkout a tag in detached mode.
- Compare a tag.
- Delete a local tag.

## 13. Use worktrees

Open the **Worktrees** view.

You can:

- Add a worktree.
- Open it in a new window.
- Lock or unlock it.
- Remove it.
- Prune stale worktree records.

Check uncommitted work before removing a worktree.

## 14. Use submodules

Open the **Submodules** view.

You can:

- Open a submodule in a new window.
- Initialize missing submodules.
- Update submodules recursively.
- Synchronize submodule URLs.

## 15. View file history

1. Right-click a file in Explorer or an editor tab.
2. Select **File History**.

The graph filters to that file. GitTree follows detected renames.

## 16. Use blame

### Inline blame

Run **Toggle Inline Blame**.

The active line shows:

- Author.
- Relative time.
- Commit message.
- Commit ID.

### Heatmap

Run **Toggle Full-file Blame Heatmap**.

Older and newer lines use different colors. The overview ruler is also updated.

## 17. Review pull requests

Open the **Pull Requests** view.

The current-branch request is highlighted when detected.

Select a request to view:

- Description.
- Author and state.
- Source and target branches.
- Linked tasks or work items.
- Changed files.
- Addition and deletion counts.
- Markdown comments.
- Comment threads and replies.
- Code context for root code comments.
- Active and total comment counts.

Select a changed file to open its native diff.

Use **Open on web** for provider-specific actions.

## 18. Configure authentication

### GitHub

Sign in to GitHub through VS Code. Grant repository access when requested.

If a private repository returns `404`:

- Check the active GitHub account.
- Check repository access.
- Check organization SSO authorization.

If GitHub returns `403`:

- Check token/session scopes.
- Check API rate limits.
- Check organization restrictions.

### GitLab

1. Run **Set GitLab Token Securely…**.
2. Enter a personal access token.

VS Code Secret Storage holds the token.

### Azure DevOps

Set a full repository URL:

```json
{
  "gitTree.azureDevOps.repositoryUrl": "https://dev.azure.com/my-org/my-project/_git/my-repo"
}
```

Or use split settings:

```json
{
  "gitTree.azureDevOps.endpoint": "https://dev.azure.com",
  "gitTree.azureDevOps.organization": "my-org",
  "gitTree.azureDevOps.project": "my-project",
  "gitTree.azureDevOps.repository": "my-repo"
}
```

Then:

1. Run **Set Azure DevOps Token Securely…**.
2. Enter an active PAT.

Azure DevOps does not show an existing PAT value again. Create or regenerate a token if its value was not saved.

## 19. Settings reference

| Setting | Purpose |
| --- | --- |
| `gitTree.maxCommits` | Limit graph history. |
| `gitTree.showRemoteBranches` | Include remote branches. |
| `gitTree.blame.enabled` | Enable inline blame. |
| `gitTree.dateFormat` | Use relative or absolute dates. |
| `gitTree.azureDevOps.repositoryUrl` | Set the full Azure repository URL. |
| `gitTree.azureDevOps.endpoint` | Set the cloud/server endpoint. |
| `gitTree.azureDevOps.organization` | Set the organization. |
| `gitTree.azureDevOps.project` | Set the project. |
| `gitTree.azureDevOps.repository` | Set the repository name or ID. |

## 20. Refresh and reload

GitTree watches repository changes. Use **Refresh** if data looks stale.

For extension development:

- Press `F5` to open the Extension Development Host.
- Press `Ctrl+R` inside that window after code changes.
- Reload after changing commands, menus, views, or settings.

Normal users should not need to restart VS Code after routine Git operations.

## 21. Troubleshooting

### No repository found

- Open a folder inside a Git repository.
- Check that Git works in the terminal.
- Run **Refresh**.

### A command is missing

- Confirm the correct item is selected.
- Some commands appear only in context menus.
- Reload VS Code after installing a development build.

### Extension is assigned to the Web Worker host

- Install the latest GitTree build.
- Use desktop VS Code, WSL, SSH, a Dev Container, or a Codespace with a workspace host.
- In a remote window, install GitTree on the remote side.
- Remove any `remote.extensionKind` override for `pennowtech.git-tree`.
- Trust the workspace.
- Reload the extension host after reinstalling.

GitTree cannot run in `vscode.dev` or `github.dev`. It requires Node.js and the Git CLI.

### Pull requests do not load

- Check the remote URL.
- Check provider authentication.
- Check PAT/session permissions.
- Check Azure repository settings.
- Try the provider URL in a browser.

### A diff is empty

- Confirm that the selected refs differ.
- Refresh the repository.
- Fetch remote branches.
- Check whether the file is binary.

### Branch data is stale

- Run **Fetch**.
- Run **Refresh**.
- Check the configured upstream branch.

## 22. Safety notes

- Review files before discard, reset, delete, or force operations.
- Commit or stash work before rebasing.
- Push important commits before rewriting history.
- Check the current branch before merge or rebase.
- Keep PATs out of workspace files.

GitTree stores supported provider tokens in VS Code Secret Storage.
