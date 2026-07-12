'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs');

const { Git } = require('./git');
const { GraphPanel } = require('./graphPanel');
const { BranchesProvider, StashesProvider, TagsProvider, ChangesProvider, WorktreesProvider, SubmodulesProvider, PullRequestsProvider, ChangeDecorations } = require('./views');
const { BlameController } = require('./blame');
const { CommitViewProvider } = require('./commitView');
const { PullRequestPanel } = require('./prPanel');
const actions = require('./actions');

/** @type {Git | undefined} */
let git;
let statusBarItem;
let gitWatcher;
let providers = {};
let extensionContext;

async function activate(context) {
  extensionContext = context;
  await discoverRepo();

  // --- content provider that serves file contents at a git revision (for diffs)
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('gitTree.commitInput', new CommitViewProvider(async (message, mode) => {
      await actions.run(git, 'commit', { message, amend: mode === 'amend', sign: mode === 'sign' });
      refreshAll();
    })),
    vscode.workspace.registerTextDocumentContentProvider('gittree', {
      async provideTextDocumentContent(uri) {
        try {
          const q = JSON.parse(uri.query);
          if (q.empty) return '';
          const repo = new Git(q.repo);
          return await repo.showFile(q.rev, q.path);
        } catch (e) {
          return '';
        }
      }
    })
  );

  // --- sidebar tree views
  const getGit = () => git;
  providers.branches = new BranchesProvider(getGit);
  providers.stashes = new StashesProvider(getGit);
  providers.tags = new TagsProvider(getGit);
  const changeDecorations = new ChangeDecorations();
  let changesTree;
  providers.changes = new ChangesProvider(getGit, changeDecorations, (count) => {
    if (changesTree) changesTree.badge = count ? { value: count, tooltip: `${count} changed file${count === 1 ? '' : 's'}` } : undefined;
  });
  providers.worktrees = new WorktreesProvider(getGit);
  providers.submodules = new SubmodulesProvider(getGit);
  providers.pullRequests = new PullRequestsProvider(
    getGit,
    () => context.secrets.get('gitTree.gitLabToken'),
    () => context.secrets.get('gitTree.azureDevOpsToken')
  );
  changesTree = vscode.window.createTreeView('gitTree.changes', { treeDataProvider: providers.changes });
  context.subscriptions.push(
    vscode.window.registerFileDecorationProvider(changeDecorations),
    changeDecorations,
    (() => {
      const tree = vscode.window.createTreeView('gitTree.branches', { treeDataProvider: providers.branches, canSelectMany: true });
      tree.onDidChangeSelection((event) => {
        const refs = event.selection.filter((item) => item.branch || item.commit);
        if (refs.length !== 2) return;
        const [a, b] = refs.map(itemRef);
        const panel = GraphPanel.show(context, git);
        setTimeout(() => panel.post({ type: 'startCompare', a, b }), 300);
      }, null, context.subscriptions);
      return tree;
    })(),
    vscode.window.createTreeView('gitTree.stashes', { treeDataProvider: providers.stashes }),
    vscode.window.createTreeView('gitTree.tags', { treeDataProvider: providers.tags }),
    changesTree,
    vscode.window.createTreeView('gitTree.worktrees', { treeDataProvider: providers.worktrees }),
    vscode.window.createTreeView('gitTree.submodules', { treeDataProvider: providers.submodules }),
    vscode.window.createTreeView('gitTree.pullRequests', { treeDataProvider: providers.pullRequests })
  );

  // --- inline blame
  const blame = new BlameController(getGit);
  context.subscriptions.push(blame);

  // --- status bar: current branch, opens the graph
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
  statusBarItem.command = 'gitTree.showGraph';
  statusBarItem.tooltip = 'Open GitTree commit graph';
  context.subscriptions.push(statusBarItem);
  updateStatusBar();

  // --- react to repo changes (.git/HEAD, refs, index)
  setupGitWatcher(context);

  // --- commands ------------------------------------------------------------
  const register = (id, fn) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async (...args) => {
        try {
          if (!git && id !== 'gitTree.refresh' && id !== 'gitTree.openUserGuide') {
            await discoverRepo();
            if (!git) {
              vscode.window.showWarningMessage('No git repository found in this workspace.');
              return;
            }
          }
          await fn(...args);
        } catch (err) {
          const text = err && err.message ? err.message : String(err);
          if (text) vscode.window.showErrorMessage(text);
        }
        refreshAll();
      })
    );
  let selectedCompareRef;

  register('gitTree.showGraph', () => GraphPanel.show(context, git));
  register('gitTree.openUserGuide', async () => {
    const guide = vscode.Uri.file(path.join(context.extensionPath, 'docs', 'USER_GUIDE.md'));
    await vscode.commands.executeCommand('markdown.showPreview', guide);
  });
  register('gitTree.showHistory', async () => {
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active?.scheme === 'file') {
      const rel = path.relative(git.root, active.fsPath).replace(/\\/g, '/');
      if (rel && !rel.startsWith('..')) {
        GraphPanel.show(context, git, { file: rel });
        return;
      }
    }
    GraphPanel.show(context, git, { currentOnly: true });
  });

  register('gitTree.refresh', async () => {
    await discoverRepo();
  });
  context.subscriptions.push(
    vscode.commands.registerCommand('gitTree.refreshViews', () => refreshAll())
  );

  register('gitTree.fetch', () => actions.run(git, 'fetch', {}));
  register('gitTree.pull', () => actions.run(git, 'pull', {}));
  register('gitTree.push', () => actions.run(git, 'push', {}));
  register('gitTree.fetchBranch', async (item) => {
    const { remote, branch } = branchRemoteParts(item.branch);
    await git.fetchBranch(remote, branch);
  });
  register('gitTree.pullBranch', async (item) => {
    const { remote, branch } = branchRemoteParts(item.branch);
    await git.pullBranch(remote, branch);
  });
  register('gitTree.pushBranch', async (item) => {
    const branch = item.branch.name;
    const remote = item.branch.upstream?.split('/')[0] || 'origin';
    await git.pushBranch(remote, branch, !item.branch.upstream);
  });
  register('gitTree.createBranch', () => actions.run(git, 'createBranch', {}));
  register('gitTree.addRemote', async () => {
    const name = await vscode.window.showInputBox({ prompt: 'Remote name', value: 'origin' });
    if (!name) return;
    const url = await vscode.window.showInputBox({ prompt: `URL for remote '${name}'`, placeHolder: 'https://github.com/owner/repository.git' });
    if (url) await git.addRemote(name, url);
  });
  register('gitTree.setRemoteUrl', async () => {
    const remotes = await git.getRemotes();
    const name = await vscode.window.showQuickPick(remotes, { placeHolder: 'Select a remote' });
    if (!name) return;
    const current = (await git.exec(['remote', 'get-url', name])).trim();
    const url = await vscode.window.showInputBox({ prompt: `New URL for '${name}'`, value: current });
    if (url && url !== current) await git.setRemoteUrl(name, url);
  });
  register('gitTree.filterCommitsByAuthor', async () => {
    const author = await vscode.window.showInputBox({ prompt: 'Only show branch commits whose author contains', value: providers.branches.authorFilter || '' });
    if (author !== undefined) providers.branches.authorFilter = author.trim();
  });
  register('gitTree.clearCommitAuthorFilter', () => { providers.branches.authorFilter = ''; });
  register('gitTree.stashSave', () => actions.run(git, 'stashSave', {}));
  register('gitTree.stashAdvanced', async () => {
    const modes = [
      { label: 'Add stash - tracked changes', mode: 'tracked' },
      { label: 'Add stash - include untracked files', mode: 'untracked' },
      { label: 'Add stash - staged changes only', mode: 'staged' },
      { label: 'Add stash - keep staged changes', mode: 'keepIndex' },
      { label: 'Apply stash...', mode: 'apply' },
      { label: 'Pop stash...', mode: 'pop' },
      { label: 'Delete stash...', mode: 'drop' },
      { label: 'View stash...', mode: 'view' }
    ];
    const selected = await vscode.window.showQuickPick(modes, { placeHolder: 'Choose a stash action' });
    if (!selected) return;
    if (['apply', 'pop', 'drop', 'view'].includes(selected.mode)) {
      const stash = await pickStash();
      if (!stash) return;
      if (selected.mode === 'view') {
        await showStash(stash.ref);
        return;
      }
      await actions.run(git, selected.mode === 'apply' ? 'stashApply' : selected.mode === 'pop' ? 'stashPop' : 'stashDrop', { ref: stash.ref });
      return;
    }
    const message = await vscode.window.showInputBox({ prompt: 'Stash message (optional)' });
    if (message !== undefined) await git.stashSaveAdvanced(message, selected.mode);
  });
  register('gitTree.createTag', () => actions.run(git, 'createTag', {}));
  register('gitTree.setCommitMessage', async () => {
    const message = await vscode.window.showInputBox({
      prompt: 'Commit message', value: providers.changes.commitMessage || '',
      validateInput: (value) => value.trim() ? undefined : 'Commit message is required'
    });
    if (message !== undefined) providers.changes.commitMessage = message;
  });
  register('gitTree.commit', async () => {
    const message = providers.changes.commitMessage;
    await actions.run(git, 'commit', { message });
    if (message) providers.changes.commitMessage = '';
  });
  register('gitTree.stageAll', () => actions.run(git, 'stageAll', {}));
  register('gitTree.unstageAll', () => actions.run(git, 'unstageAll', {}));
  register('gitTree.changesViewList', () => { providers.changes.viewMode = 'list'; });
  register('gitTree.changesViewTree', () => { providers.changes.viewMode = 'tree'; });
  register('gitTree.changesSortPath', () => { providers.changes.sortBy = 'path'; });
  register('gitTree.changesSortName', () => { providers.changes.sortBy = 'name'; });
  register('gitTree.changesSortStatus', () => { providers.changes.sortBy = 'status'; });
  register('gitTree.toggleBlame', () => blame.toggle());
  register('gitTree.toggleBlameHeatmap', () => blame.toggleHeatmap());
  register('gitTree.amendCommit', () => actions.run(git, 'commit', { amend: true }));
  register('gitTree.signCommit', () => actions.run(git, 'commit', { sign: true }));
  register('gitTree.updateSubmodules', () => actions.run(git, 'updateSubmodules', {}));
  register('gitTree.syncSubmodules', () => actions.run(git, 'syncSubmodules', {}));
  register('gitTree.addWorktree', async () => {
    const target = await vscode.window.showInputBox({ prompt: 'New worktree folder (absolute or relative to repository)', placeHolder: '../my-worktree' });
    if (!target) return;
    const refs = await pickableRefs();
    const branch = await vscode.window.showQuickPick(['(new branch from HEAD)', ...refs], { placeHolder: 'Branch/ref for the worktree' });
    if (!branch) return;
    if (branch === '(new branch from HEAD)') {
      const name = await vscode.window.showInputBox({ prompt: 'New branch name' });
      if (!name) return;
      await git.exec(['worktree', 'add', '-b', name, target]);
    } else await git.addWorktree(target, branch);
  });
  register('gitTree.removeWorktree', (item) => actions.run(git, 'removeWorktree', { path: item.worktree.path }));
  register('gitTree.pruneWorktrees', () => actions.run(git, 'pruneWorktrees', {}));
  register('gitTree.lockWorktree', (item) => actions.run(git, 'lockWorktree', { path: item.worktree.path }));
  register('gitTree.unlockWorktree', (item) => actions.run(git, 'unlockWorktree', { path: item.worktree.path }));
  register('gitTree.openWorktree', async (item) =>
    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(item.worktree.path), { forceNewWindow: true })
  );
  register('gitTree.openSubmodule', async (item) =>
    vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(path.join(git.root, item.submodule.path)), { forceNewWindow: true })
  );
  register('gitTree.interactiveRebase', async (item) => {
    const ref = item?.branch?.name || await vscode.window.showInputBox({ prompt: 'Interactive rebase onto ref', value: 'HEAD~5' });
    if (!ref) return;
    const terminal = vscode.window.createTerminal({ name: 'GitTree Rebase', cwd: git.root });
    terminal.show();
    terminal.sendText(`git rebase -i ${shellQuote(ref)}`);
  });
  register('gitTree.rebaseContinue', () => actions.run(git, 'rebaseContinue', {}));
  register('gitTree.rebaseSkip', () => actions.run(git, 'rebaseSkip', {}));
  register('gitTree.rebaseAbort', () => actions.run(git, 'rebaseAbort', {}));
  register('gitTree.openPullRequests', async () => {
    const remote = await git.getRemoteUrl();
    const url = providerPullRequestUrl(remote);
    if (!url) throw new Error('Origin is not a recognized GitHub, GitLab, or Azure DevOps remote.');
    PullRequestPanel.showList(context, git, url);
  });
  register('gitTree.openPullRequest', (item) => PullRequestPanel.show(context, item.pullRequest, {
    getGitLabToken: () => context.secrets.get('gitTree.gitLabToken'),
    getAzureDevOpsToken: () => context.secrets.get('gitTree.azureDevOpsToken')
  }));
  register('gitTree.openPullRequestDetails', (item) => PullRequestPanel.show(context, item.pullRequest, {
    getGitLabToken: () => context.secrets.get('gitTree.gitLabToken'),
    getAzureDevOpsToken: () => context.secrets.get('gitTree.azureDevOpsToken')
  }));
  register('gitTree.openPullRequestWeb', (item) => vscode.env.openExternal(vscode.Uri.parse(item.pullRequest.url)));
  register('gitTree.setGitLabToken', async () => {
    const token = await vscode.window.showInputBox({
      prompt: 'GitLab personal access token', password: true, ignoreFocusOut: true
    });
    if (token) await context.secrets.store('gitTree.gitLabToken', token);
  });
  register('gitTree.setAzureDevOpsToken', async () => {
    const token = await vscode.window.showInputBox({
      prompt: 'Azure DevOps personal access token', password: true, ignoreFocusOut: true
    });
    if (token) await context.secrets.store('gitTree.azureDevOpsToken', token);
  });
  register('gitTree.createPullRequest', async (item) => {
    const remote = await git.getRemoteUrl();
    const rawSource = item?.branch?.name || (await git.getHead()).branch;
    const source = item?.branch?.remote ? rawSource.split('/').slice(1).join('/') : rawSource;
    const target = await git.getDefaultCompareRef();
    const url = providerCreatePullRequestUrl(remote, source, target);
    if (!url) throw new Error('Origin is not a recognized GitHub, GitLab, or Azure DevOps remote.');
    await vscode.env.openExternal(vscode.Uri.parse(url));
  });
  register('gitTree.openBranchOnRemote', async (item) => {
    const remote = await git.getRemoteUrl();
    const url = providerBranchUrl(remote, item.branch.name, item.branch.remote);
    if (!url) throw new Error('This remote provider does not expose a recognized branch URL.');
    await vscode.env.openExternal(vscode.Uri.parse(url));
  });
  register('gitTree.createTagAtBranch', (item) => actions.run(git, 'createTag', { sha: item.branch.name }));

  // tree-item commands (item is the TreeItem from views.js)
  register('gitTree.checkoutBranch', (item) =>
    actions.run(git, 'checkoutBranch', { name: item.branch.name, remote: item.branch.remote })
  );
  register('gitTree.mergeBranch', (item) => actions.run(git, 'merge', { name: item.branch.name }));
  register('gitTree.rebaseOntoBranch', (item) => actions.run(git, 'rebase', { name: item.branch.name }));
  register('gitTree.deleteBranch', (item) =>
    actions.run(git, 'deleteBranch', { name: item.branch.name, remote: item.branch.remote })
  );
  register('gitTree.renameBranch', (item) => actions.run(git, 'renameBranch', { name: item.branch.name }));
  register('gitTree.copyRefName', async (item) => {
    const name = item.branch ? item.branch.name : item.tag ? item.tag.name : '';
    await vscode.env.clipboard.writeText(name);
  });
  register('gitTree.compareWithCurrent', async (item) => {
    const ref = item.branch ? item.branch.name : item.tag.name;
    const panel = GraphPanel.show(context, git);
    setTimeout(() => panel.post({ type: 'startCompare', a: ref, b: 'WT' }), 400);
  });
  register('gitTree.selectForCompare', (item) => {
    selectedCompareRef = itemRef(item);
    vscode.window.setStatusBarMessage(`Selected ${selectedCompareRef} for comparison`, 4000);
  });
  register('gitTree.compareWithSelected', async (item) => {
    const ref = itemRef(item);
    if (!selectedCompareRef) {
      selectedCompareRef = ref;
      vscode.window.showInformationMessage(`${ref} selected. Choose another branch or commit and use Compare with Selected.`);
      return;
    }
    if (selectedCompareRef === ref) throw new Error('Select a different branch or commit for comparison.');
    const panel = GraphPanel.show(context, git);
    setTimeout(() => panel.post({ type: 'startCompare', a: selectedCompareRef, b: ref }), 400);
  });
  register('gitTree.openRefChanges', async (item) => {
    if (item.commit) {
      const details = await git.getCommitDetails(item.commit.sha);
      const base = details.parents[0] || null;
      return openNativeChanges(item.commit.subject || details.sha.slice(0, 7), base, details.sha, details.files);
    }
    const target = item.branch.name;
    let base = item.branch.upstream || await git.getDefaultCompareRef();
    if (!base || base === target) base = `${target}^`;
    const files = await git.getChangedFiles(base, target);
    return openNativeChanges(target, base, target, files);
  });
  register('gitTree.cherryPickCommit', (item) => actions.run(git, 'cherryPick', { sha: item.commit.sha }));
  register('gitTree.revertCommit', async (item) => {
    const details = await git.getCommitDetails(item.commit.sha);
    return actions.run(git, 'revert', { sha: item.commit.sha, isMerge: details.isMerge });
  });
  register('gitTree.createBranchAtCommit', (item) => actions.run(git, 'createBranch', { startPoint: item.commit.sha }));
  register('gitTree.createTagAtCommit', (item) => actions.run(git, 'createTag', { sha: item.commit.sha }));
  register('gitTree.checkoutCommit', (item) => actions.run(git, 'checkoutDetached', { sha: item.commit.sha }));
  register('gitTree.copyCommitSha', async (item) => vscode.env.clipboard.writeText(item.commit.sha));
  register('gitTree.showCommit', (item) => {
    const panel = GraphPanel.show(context, git);
    setTimeout(() => panel.post({ type: 'revealCommit', sha: item.commit.sha }), 250);
  });
  register('gitTree.compareRefs', async () => {
    const refs = await pickableRefs();
    const a = await vscode.window.showQuickPick(refs, { placeHolder: 'Compare: pick the FIRST ref (base)' });
    if (!a) return;
    const b = await vscode.window.showQuickPick(refs.filter((r) => r !== a), {
      placeHolder: `Compare ${a} with…`
    });
    if (!b) return;
    const panel = GraphPanel.show(context, git);
    setTimeout(() => panel.post({ type: 'startCompare', a, b }), 400);
  });

  register('gitTree.stashApply', (item) => actions.run(git, 'stashApply', { ref: item.stash.ref }));
  register('gitTree.stashPop', (item) => actions.run(git, 'stashPop', { ref: item.stash.ref }));
  register('gitTree.stashDrop', (item) => actions.run(git, 'stashDrop', { ref: item.stash.ref }));
  register('gitTree.stashView', (item) => showStash(item.stash.ref));

  register('gitTree.checkoutTag', (item) => actions.run(git, 'checkoutDetached', { sha: item.tag.name }));
  register('gitTree.deleteTag', (item) => actions.run(git, 'deleteTag', { name: item.tag.name }));
  register('gitTree.stageChange', (item) => actions.run(git, 'stage', { path: item.file.path }));
  register('gitTree.unstageChange', (item) => actions.run(git, 'unstage', { path: item.file.path }));
  register('gitTree.discardChange', (item) => actions.run(git, 'discard', {
    path: item.file.path,
    untracked: item.file.x === '?'
  }));
  register('gitTree.openChange', async (item) => {
    await openChangeFile(item.file.path, item.staged, item.file);
  });
  register('gitTree.openChangeFile', async (item) => openChangeAsFile(item));
  register('gitTree.revealChangeInExplorer', async (item) => revealChangeInExplorer(item));
  register('gitTree.copyChangePath', async (item) => copyChangePath(item, false));
  register('gitTree.copyChangeRelativePath', async (item) => copyChangePath(item, true));
  register('gitTree.addToGitignore', async (itemOrUri) => addToGitignore(itemOrUri));

  register('gitTree.fileHistory', async (uri) => {
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    if (!target || target.scheme !== 'file') {
      vscode.window.showWarningMessage('Open a file first.');
      return;
    }
    const rel = path.relative(git.root, target.fsPath).replace(/\\/g, '/');
    if (rel.startsWith('..')) {
      vscode.window.showWarningMessage('File is outside the repository.');
      return;
    }
    GraphPanel.show(context, git, { file: rel });
  });

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => discoverRepo().then(refreshAll))
  );
}

async function discoverRepo() {
  const folders = vscode.workspace.workspaceFolders || [];
  const roots = [];
  for (const f of folders) {
    if (f.uri.scheme !== 'file') continue;
    const root = await Git.discover(f.uri.fsPath);
    if (root && !roots.includes(root)) roots.push(root);
  }
  let root = roots[0];
  if (roots.length > 1) {
    // multiple repos: keep current one if still valid, otherwise ask
    if (git && roots.includes(git.root)) {
      root = git.root;
    } else {
      root = (await vscode.window.showQuickPick(roots, { placeHolder: 'Pick a repository' })) || roots[0];
    }
  }
  git = root ? new Git(root) : undefined;
  vscode.commands.executeCommand('setContext', 'gitTree.hasRepo', !!git);
  updateStatusBar();
}

function refreshAll() {
  providers.branches && providers.branches.refresh();
  providers.stashes && providers.stashes.refresh();
  providers.tags && providers.tags.refresh();
  providers.changes && providers.changes.refresh();
  providers.worktrees && providers.worktrees.refresh();
  providers.submodules && providers.submodules.refresh();
  providers.pullRequests && providers.pullRequests.refresh();
  if (GraphPanel.current) GraphPanel.current.refresh();
  updateStatusBar();
  if (git) git.isRebaseInProgress().then((active) => vscode.commands.executeCommand('setContext', 'gitTree.rebaseInProgress', active));
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function providerPullRequestUrl(remote) {
  const configuredAzure = azureConfiguration();
  if (configuredAzure) return `${configuredAzure.base}/${encodeURIComponent(configuredAzure.project)}/_git/${encodeURIComponent(configuredAzure.repo)}/pullrequests`;
  const hosted = remote.match(/(?:git@|https?:\/\/)(github\.com|gitlab\.com)[/:]([^/]+)\/(.+?)(?:\.git)?$/i);
  if (hosted) {
    const base = hosted[1].toLowerCase() === 'github.com' ? 'https://github.com' : 'https://gitlab.com';
    const suffix = hosted[1].toLowerCase() === 'github.com' ? 'pulls' : '-/merge_requests';
    return `${base}/${hosted[2]}/${hosted[3].replace(/\.git$/, '')}/${suffix}`;
  }
  const azure = parseAzureRemote(remote);
  if (azure) return `${azure.base}/${azure.project}/_git/${azure.repo}/pullrequests`;
  return null;
}

function providerCreatePullRequestUrl(remote, source, target) {
  const configuredAzure = azureConfiguration();
  const root = configuredAzure
    ? `${configuredAzure.base}/${encodeURIComponent(configuredAzure.project)}/_git/${encodeURIComponent(configuredAzure.repo)}/pullrequests`
    : providerPullRequestUrl(remote);
  if (!root || !source) return null;
  const cleanTarget = String(target).replace(/^origin\//, '');
  if (root.includes('github.com')) return root.replace(/\/pulls$/, `/compare/${encodeURIComponent(cleanTarget)}...${encodeURIComponent(source)}?expand=1`);
  if (root.includes('gitlab.com')) return root.replace(/-\/merge_requests$/, `-/merge_requests/new?merge_request[source_branch]=${encodeURIComponent(source)}&merge_request[target_branch]=${encodeURIComponent(cleanTarget)}`);
  return `${root}?sourceRef=${encodeURIComponent(source)}&targetRef=${encodeURIComponent(cleanTarget)}`;
}

function itemRef(item) {
  if (item?.branch) return item.branch.name;
  if (item?.commit) return item.commit.sha;
  if (item?.tag) return item.tag.name;
  throw new Error('No branch, commit, or tag was selected.');
}

function branchRemoteParts(branch) {
  if (branch.remote) {
    const [remote, ...parts] = branch.name.split('/');
    return { remote, branch: parts.join('/') };
  }
  if (branch.upstream) {
    const [remote, ...parts] = branch.upstream.split('/');
    return { remote, branch: parts.join('/') };
  }
  return { remote: 'origin', branch: branch.name };
}

function providerBranchUrl(remote, branch, isRemote) {
  const cleanBranch = isRemote ? branch.split('/').slice(1).join('/') : branch;
  const hosted = remote.match(/(?:git@|https?:\/\/)(github\.com|gitlab\.com)[/:]([^/]+)\/(.+?)(?:\.git)?$/i);
  if (hosted) {
    const repo = hosted[3].replace(/\.git$/, '');
    return hosted[1].toLowerCase() === 'github.com'
      ? `https://github.com/${hosted[2]}/${repo}/tree/${encodeURIComponent(cleanBranch)}`
      : `https://gitlab.com/${hosted[2]}/${repo}/-/tree/${encodeURIComponent(cleanBranch)}`;
  }
  const azure = azureConfiguration() || parseAzureRemote(remote);
  return azure ? `${azure.base}/${encodeURIComponent(azure.project)}/_git/${encodeURIComponent(azure.repo)}?version=GB${encodeURIComponent(cleanBranch)}` : null;
}

function parseAzureRemote(remote) {
  const parsed = parseAzureHttpsRemote(remote);
  if (parsed) return parsed;
  const ssh = remote.match(/^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/i);
  if (ssh) return { base: `https://dev.azure.com/${ssh[1]}`, org: ssh[1], project: ssh[2], repo: ssh[3].replace(/\.git$/, '') };
  return null;
}

function parseAzureHttpsRemote(remote) {
  if (!remote) return null;
  try {
    const url = new URL(remote.replace(/\.git$/i, ''));
    const segments = url.pathname.split('/').filter(Boolean);
    const gitIndex = segments.findIndex((part) => part.toLowerCase() === '_git');
    if (gitIndex < 1 || !segments[gitIndex + 1]) return null;
    const project = decodeURIComponent(segments[gitIndex - 1]);
    const repo = decodeURIComponent(segments.slice(gitIndex + 1).join('/')).replace(/\.git$/i, '');
    const baseSourceSegments = segments.slice(0, gitIndex - 1).map(decodeURIComponent);
    const baseSegments = baseSourceSegments.map(encodeURIComponent);
    const base = `${url.origin}${baseSegments.length ? `/${baseSegments.join('/')}` : ''}`;
    const org = url.hostname.endsWith('.visualstudio.com')
      ? url.hostname.replace(/\.visualstudio\.com$/i, '')
      : baseSourceSegments[baseSourceSegments.length - 1] || '';
    return { base, org, project, repo };
  } catch {
    return null;
  }
}

function azureConfiguration() {
  const config = vscode.workspace.getConfiguration('gitTree');
  const repositoryUrl = config.get('azureDevOps.repositoryUrl', '').trim();
  if (repositoryUrl) return parseAzureRemote(repositoryUrl);
  const endpoint = config.get('azureDevOps.endpoint', '').trim();
  const org = config.get('azureDevOps.organization', '').trim();
  const project = config.get('azureDevOps.project', '').trim();
  const repo = config.get('azureDevOps.repository', '').trim();
  if (!endpoint || !project || !repo) return null;
  const base = normalizeAzureBaseUrl(endpoint, org);
  return base ? { base, org, project, repo } : null;
}

function normalizeAzureBaseUrl(endpoint, org) {
  const cleanEndpoint = String(endpoint || '').replace(/\/+$/, '');
  if (!cleanEndpoint) return '';
  try {
    const url = new URL(cleanEndpoint);
    const segments = url.pathname.split('/').filter(Boolean);
    if (url.hostname.toLowerCase() === 'dev.azure.com' && org && segments[0]?.toLowerCase() !== org.toLowerCase()) {
      segments.unshift(org);
    }
    return `${url.origin}${segments.length ? `/${segments.map(encodeURIComponent).join('/')}` : ''}`;
  } catch {
    return '';
  }
}

async function pickStash() {
  const stashes = await git.getStashes();
  const selected = await vscode.window.showQuickPick(stashes.map((stash) => ({
    label: stash.ref,
    description: stash.message,
    stash
  })), { placeHolder: 'Select a stash' });
  return selected?.stash;
}

async function showStash(ref) {
  const doc = await vscode.workspace.openTextDocument({
    language: 'diff',
    content: await git.exec(['stash', 'show', '--patch', '--stat', ref]).catch((error) => error.message || String(error))
  });
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function updateStatusBar() {
  if (!statusBarItem) return;
  if (!git) {
    statusBarItem.hide();
    return;
  }
  try {
    const head = await git.getHead();
    statusBarItem.text = `$(git-branch) ${head.branch || head.sha.slice(0, 7) + ' (detached)'}`;
    statusBarItem.show();
  } catch (e) {
    statusBarItem.hide();
  }
}

let watchDebounce;
function setupGitWatcher(context) {
  if (gitWatcher) {
    gitWatcher.close();
    gitWatcher = undefined;
  }
  if (!git) return;
  let gitDir = path.join(git.root, '.git');
  try {
    if (!fs.existsSync(gitDir)) return;
    if (fs.statSync(gitDir).isFile()) {
      const pointer = fs.readFileSync(gitDir, 'utf8').match(/^gitdir:\s*(.+)$/m);
      if (!pointer) return;
      gitDir = path.resolve(git.root, pointer[1].trim());
    }
    if (!fs.statSync(gitDir).isDirectory()) return;
    gitWatcher = fs.watch(gitDir, { recursive: true }, (event, filename) => {
      if (!filename) return;
      const f = filename.replace(/\\/g, '/');
      // ignore high-churn internals; react to HEAD, refs, index, stash changes
      if (f.startsWith('objects/') || f.endsWith('.lock') || f.startsWith('logs/refs/remotes')) return;
      clearTimeout(watchDebounce);
      watchDebounce = setTimeout(refreshAll, 500);
    });
    context.subscriptions.push({ dispose: () => gitWatcher && gitWatcher.close() });
  } catch (e) {
    /* fs.watch can fail on some file systems; refresh stays manual */
  }
}

async function pickableRefs() {
  const [branches, tags] = await Promise.all([git.getBranches(), git.getTags()]);
  return [...branches.map((b) => b.name), ...tags.map((t) => t.name)];
}

async function openChangeFile(filePath, staged, file) {
  if (!file) {
    const status = await git.getStatus();
    file = status.files.find((candidate) => candidate.path === filePath) || { path: filePath, x: ' ', y: ' ' };
  }
  const revisionUri = (rev, empty = false) => vscode.Uri.from({
    scheme: 'gittree',
    path: '/' + filePath.replace(/\\/g, '/'),
    query: JSON.stringify({ repo: git.root, rev, path: filePath, empty })
  });
  const untracked = file.x === '?';
  const deleted = staged ? file.x === 'D' : file.y === 'D';
  const left = staged ? revisionUri('HEAD') : revisionUri(':0', untracked);
  const right = staged
    ? revisionUri(':0')
    : deleted ? revisionUri('', true) : vscode.Uri.file(path.join(git.root, filePath));
  await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(filePath)} (Changes)`);
}

function changeRelativePath(item) {
  if (!item) return '';
  if (item.file?.path) return item.file.path.replace(/\\/g, '/');
  if (item.resourceUri?.fsPath) return path.relative(git.root, item.resourceUri.fsPath).replace(/\\/g, '/');
  return '';
}

function changeAbsolutePath(item) {
  if (!item) return '';
  if (item.resourceUri?.fsPath) return item.resourceUri.fsPath;
  const relative = changeRelativePath(item);
  return relative ? path.join(git.root, relative) : '';
}

async function openChangeAsFile(item) {
  const absolutePath = changeAbsolutePath(item);
  if (!absolutePath) return;
  if (!fs.existsSync(absolutePath) || fs.statSync(absolutePath).isDirectory()) {
    vscode.window.showWarningMessage('This change cannot be opened as a normal file. It may be deleted or a folder.');
    return;
  }
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(absolutePath));
  await vscode.window.showTextDocument(doc, { preview: true });
}

async function revealChangeInExplorer(item) {
  const absolutePath = changeAbsolutePath(item);
  if (!absolutePath) return;
  const target = fs.existsSync(absolutePath)
    ? vscode.Uri.file(absolutePath)
    : vscode.Uri.file(path.dirname(absolutePath));
  await vscode.commands.executeCommand('revealInExplorer', target);
}

async function copyChangePath(item, relative) {
  const value = relative ? changeRelativePath(item) : changeAbsolutePath(item);
  if (!value) return;
  await vscode.env.clipboard.writeText(value);
  vscode.window.setStatusBarMessage(`Copied ${relative ? 'relative path' : 'path'}: ${value}`, 2500);
}

async function addToGitignore(itemOrUri) {
  const target = itemOrUri instanceof vscode.Uri
    ? itemOrUri.fsPath
    : changeAbsolutePath(itemOrUri);
  if (!target) throw new Error('Select a file or folder inside the repository.');
  const relative = path.relative(git.root, target).replace(/\\/g, '/');
  if (!relative || relative === '.' || relative.startsWith('../') || path.isAbsolute(relative)) {
    throw new Error('The selected path is outside the active repository.');
  }
  const isDirectory = fs.existsSync(target) && fs.statSync(target).isDirectory();
  const rule = `/${relative}${isDirectory ? '/' : ''}`;
  const ignorePath = path.join(git.root, '.gitignore');
  const existing = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, 'utf8') : '';
  const normalizedRule = normalizeIgnoreRule(rule);
  const alreadyIgnored = existing.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!'))
    .some((line) => normalizeIgnoreRule(line) === normalizedRule);
  if (alreadyIgnored) {
    vscode.window.showInformationMessage(`${relative} is already listed in .gitignore.`);
    return;
  }
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const prefix = existing && !existing.endsWith('\n') ? eol : '';
  fs.writeFileSync(ignorePath, `${existing}${prefix}${rule}${eol}`, 'utf8');
  vscode.window.setStatusBarMessage(`Added ${rule} to .gitignore`, 4000);
}

function normalizeIgnoreRule(rule) {
  return String(rule || '').trim().replace(/^\//, '').replace(/\/$/, '');
}

async function openCompareFile(filePath, compare) {
  if (!compare) return;
  const file = (compare.files || []).find((candidate) => candidate.path === filePath) || { path: filePath, status: 'M' };
  const b = compare.b === 'Working Tree' ? 'WT' : compare.b;
  const title = `${path.basename(filePath)} (${compare.a} ↔ ${compare.b})`;
  const gitUri = (rev, targetPath, empty = false) => vscode.Uri.from({
    scheme: 'gittree',
    path: '/' + targetPath.replace(/\\/g, '/'),
    query: JSON.stringify({ repo: git.root, rev, path: targetPath, empty })
  });
  const left = file.status === 'A' || file.status === 'U'
    ? gitUri(compare.a, filePath, true)
    : gitUri(compare.a, file.origPath || filePath);
  const right = b === 'WT'
    ? file.status === 'D'
      ? gitUri(compare.b, filePath, true)
      : vscode.Uri.file(path.join(git.root, filePath))
    : file.status === 'D'
      ? gitUri(compare.b, filePath, true)
      : gitUri(compare.b, filePath);
  await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
}

async function openNativeChanges(label, base, target, files) {
  const revisionUri = (rev, filePath, empty = false) => vscode.Uri.from({
    scheme: 'gittree',
    path: '/' + filePath.replace(/\\/g, '/'),
    query: JSON.stringify({ repo: git.root, rev, path: filePath, empty })
  });
  const resources = files.map((file) => {
    const display = vscode.Uri.file(path.join(git.root, file.path));
    const left = file.status === 'A' || !base
      ? revisionUri(base || target, file.path, true)
      : revisionUri(base, file.origPath || file.path);
    const right = file.status === 'D'
      ? revisionUri(target, file.path, true)
      : revisionUri(target, file.path);
    return [display, left, right];
  });
  if (!resources.length) {
    vscode.window.showInformationMessage(`No changes found for ${label}.`);
    return;
  }
  await vscode.commands.executeCommand('vscode.changes', `Changes: ${label}`, resources);
}

function deactivate() {
  if (gitWatcher) gitWatcher.close();
}

module.exports = { activate, deactivate };
