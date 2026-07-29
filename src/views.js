// Sidebar tree views: Branches, Stashes, Tags.
'use strict';

const vscode = require('vscode');

function timeAgo(ms) {
  if (!ms) return '';
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  const units = [
    [31536000, 'y'],
    [2592000, 'mo'],
    [604800, 'w'],
    [86400, 'd'],
    [3600, 'h'],
    [60, 'm']
  ];
  for (const [secs, label] of units) {
    if (s >= secs) return `${Math.floor(s / secs)}${label} ago`;
  }
  return 'just now';
}

class BaseProvider {
  constructor(getGit) {
    this.getGit = getGit;
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
  }
  refresh() {
    this._onDidChangeTreeData.fire();
  }
  getTreeItem(element) {
    return element;
  }
}

class BranchesProvider extends BaseProvider {
  async getChildren(element) {
    const git = this.getGit();
    if (!git) return [];
    if (!element) {
      const local = new vscode.TreeItem('Local', vscode.TreeItemCollapsibleState.Expanded);
      local.id = 'group:local';
      local.iconPath = new vscode.ThemeIcon('repo');
      const remote = new vscode.TreeItem('Remote', vscode.TreeItemCollapsibleState.Collapsed);
      remote.id = 'group:remote';
      remote.iconPath = new vscode.ThemeIcon('cloud');
      return [local, remote];
    }
    if (element.branch) {
      const commits = await git.getBranchLog(element.branch.name, 25, element.branch.upstream);
      const filtered = commits.filter((c) => !this.authorFilter || c.author.toLowerCase().includes(this.authorFilter.toLowerCase()));
      return Promise.all(filtered.map(async (c) => {
        const stats = await git.getCommitStats(c.sha).catch(() => null);
        const item = new vscode.TreeItem(c.subject || '(no message)');
        const publication = c.published === true ? 'pushed' : c.published === false ? 'unpushed' : 'local';
        const signing = c.signature === 'G' ? 'signed' : c.signature === 'B' ? 'bad signature' : '';
        item.description = [c.sha.slice(0, 7), publication, signing, timeAgo(c.time)].filter(Boolean).join(' · ');
        item.tooltip = commitTooltip(c, publication, signing, stats);
        item.iconPath = new vscode.ThemeIcon(c.signature === 'G' ? 'verified-filled' : 'git-commit');
        item.contextValue = 'gitTree.commit';
        item.commit = { ...c, stats };
        item.command = { command: 'gitTree.showCommit', title: 'Show Commit', arguments: [item] };
        return item;
      }));
    }
    const branches = await git.getBranches();
    const wantRemote = element.remote ?? element.id === 'group:remote';
    const prefix = element.branchPrefix || [];
    return branchLevel(branches.filter((b) => b.remote === wantRemote), wantRemote, prefix);
  }
}

function branchLevel(branches, remote, prefix) {
  const atLevel = branches.filter((b) => prefix.every((part, i) => b.name.split('/')[i] === part));
  const folders = new Set();
  const leaves = [];
  for (const branch of atLevel) {
    const parts = branch.name.split('/');
    if (parts.length > prefix.length + 1) folders.add(parts[prefix.length]);
    else if (parts.length === prefix.length + 1) leaves.push(branchItem(branch, prefix.length > 0));
  }
  const folderItems = [...folders].sort().map((name) => {
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Collapsed);
    item.branchPrefix = [...prefix, name];
    item.remote = remote;
    item.contextValue = 'gitTree.branchFolder';
    item.iconPath = new vscode.ThemeIcon(remote && prefix.length === 0 ? 'remote' : 'folder');
    return item;
  });
  return [...folderItems, ...leaves];
}

function branchItem(b, trimPrefix = false) {
        const label = trimPrefix ? b.name.split('/').pop() : b.name;
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.Collapsed);
        item.id = 'branch:' + b.name;
        item.contextValue = b.current ? 'gitTree.branchCurrent' : b.remote ? 'gitTree.branchRemote' : 'gitTree.branch';
        item.description = [
          b.current ? '✓ current' : '',
          b.track,
          timeAgo(b.time)
        ]
          .filter(Boolean)
          .join(' · ');
        item.tooltip = branchTooltip(b);
        const diverged = /ahead\s+\d+.*behind\s+\d+|behind\s+\d+.*ahead\s+\d+/i.test(b.track);
        const behind = /behind\s+\d+/i.test(b.track);
        const ahead = /ahead\s+\d+/i.test(b.track);
        const color = b.current ? 'charts.green' : diverged ? 'charts.orange' : behind ? 'charts.red' : ahead ? 'charts.blue' : undefined;
        item.iconPath = new vscode.ThemeIcon(b.current ? 'circle-filled' : 'git-branch', color ? new vscode.ThemeColor(color) : undefined);
        item.branch = b;
        return item;
}

function commitTooltip(commit, publication, signing, stats) {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.supportThemeIcons = true;
  const statLine = stats
    ? [
        `$(${codicon('diff-added')}) <span style="color:var(--vscode-gitDecoration-addedResourceForeground)">${stats.added} added</span>`,
        `$(${codicon('diff-modified')}) <span style="color:var(--vscode-gitDecoration-modifiedResourceForeground)">${stats.modified} modified</span>`,
        `$(${codicon('diff-removed')}) <span style="color:var(--vscode-gitDecoration-deletedResourceForeground)">${stats.deleted} deleted</span>`,
        stats.renamed ? `$(${codicon('replace')}) <span style="color:var(--vscode-gitDecoration-renamedResourceForeground)">${stats.renamed} renamed</span>` : ''
      ].filter(Boolean).join(' &nbsp; ')
    : '';
  tooltip.value = [
    `**${escapeMarkdown(commit.subject || '(no message)')}**`,
    '',
    `Committed by **${escapeMarkdown(commit.author || 'unknown')}** · ${new Date(commit.time).toLocaleString()} · ${timeAgo(commit.time)}`,
    [publication, signing].filter(Boolean).length ? [publication, signing].filter(Boolean).join(' · ') : '',
    stats ? `Files changed: **${stats.files}**` : '',
    statLine || ''
  ].filter(Boolean).join('\n\n');
  return tooltip;
}

function branchTooltip(branch) {
  const tooltip = new vscode.MarkdownString(undefined, true);
  tooltip.supportThemeIcons = true;
  tooltip.value = [
    `**${escapeMarkdown(branch.name)}**`,
    '',
    `Latest commit: \`${branch.sha}\``,
    branch.subject ? escapeMarkdown(branch.subject) : '',
    '',
    branch.current ? '$(circle-filled) Current branch' : '',
    branch.remote ? '$(cloud) Remote branch' : '$(repo) Local branch',
    branch.upstream ? `Tracks \`${branch.upstream}\`${branch.track ? ` (${escapeMarkdown(branch.track)})` : ''}` : '_No upstream_',
    branch.time ? `Updated ${timeAgo(branch.time)} · ${new Date(branch.time).toLocaleString()}` : ''
  ].filter(Boolean).join('\n\n');
  return tooltip;
}

function codicon(name) { return name; }

function escapeMarkdown(value) {
  return String(value || '').replace(/[\\`*_{}[\]()#+\-.!|>]/g, '\\$&');
}

class StashesProvider extends BaseProvider {
  async getChildren(element) {
    const git = this.getGit();
    if (!git || element) return [];
    const stashes = await git.getStashes();
    return stashes.map((s) => {
      const item = new vscode.TreeItem(s.message || s.ref);
      item.id = 'stash:' + s.ref;
      item.contextValue = 'gitTree.stash';
      item.description = `${s.ref} · ${timeAgo(s.time)}`;
      item.iconPath = new vscode.ThemeIcon('archive');
      item.stash = s;
      return item;
    });
  }
}

class TagsProvider extends BaseProvider {
  async getChildren(element) {
    const git = this.getGit();
    if (!git || element) return [];
    const tags = await git.getTags();
    return tags.map((t) => {
      const item = new vscode.TreeItem(t.name);
      item.id = 'tag:' + t.name;
      item.contextValue = 'gitTree.tag';
      item.description = `${t.sha} · ${timeAgo(t.time)}`;
      item.tooltip = t.subject || t.name;
      item.iconPath = new vscode.ThemeIcon('tag');
      item.tag = t;
      return item;
    });
  }
}

class ChangesProvider extends BaseProvider {
  constructor(getGit, decorations, onCount) {
    super(getGit);
    this.decorations = decorations;
    this.onCount = onCount;
    this.viewMode = 'tree';
    this.sortBy = 'path';
  }
  async updateStatus() {
    const git = this.getGit();
    if (!git) {
      this.onCount(0);
      return { files: [], count: 0 };
    }
    const status = await git.getStatus();
    this.decorations.update(git.root, status.files);
    this.onCount(status.count);
    return status;
  }
  refresh() {
    super.refresh();
    // Tree data is resolved lazily by VS Code. Update the badge separately so
    // it remains current even while the Changes view is collapsed or hidden.
    this.updateStatus().catch(() => {});
  }
  async getChildren(element) {
    const git = this.getGit();
    if (!git) return [];
    if (!element) {
      const status = await this.updateStatus();
      const staged = status.files.filter((f) => f.x !== ' ' && f.x !== '?');
      const working = status.files.filter((f) => f.y !== ' ' || f.x === '?');
      return [
        changeGroup('Staged Changes', 'staged', staged, true),
        changeGroup('Unstaged Changes', 'working', sortChanges(working, this.sortBy), false)
      ].filter(Boolean);
    }
    if (element.changeFolder) {
      return changeLevel(element.files, element.staged, element.changePrefix, this.viewMode, git);
    }
    return changeLevel(sortChanges(element.files, this.sortBy), element.staged, [], this.viewMode, git);
  }
}

function changeLevel(files, staged, prefix, viewMode, git) {
  if (viewMode !== 'tree') return files.map((file) => changeItem(file, staged, git));
  const folders = new Map();
  const leaves = [];
  for (const file of files) {
    const parts = file.path.split('/');
    if (parts.length > prefix.length + 1) folders.set(parts[prefix.length], true);
    else leaves.push(changeItem(file, staged, git));
  }
  return [...folders.keys()].sort().map((name) => {
    const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Expanded);
    item.changeFolder = true;
    item.changePrefix = [...prefix, name];
    item.resourceUri = vscode.Uri.file(require('path').join(git.root, ...item.changePrefix));
    item.files = files.filter((f) => item.changePrefix.every((part, i) => f.path.split('/')[i] === part));
    item.staged = staged;
    item.contextValue = staged ? 'gitTree.changeFolderStaged' : 'gitTree.changeFolderWorking';
    return item;
  }).concat(leaves);
}

function changeItem(file, staged, git) {
      const status = staged ? file.x : (file.x === '?' ? 'U' : file.y);
      const item = new vscode.TreeItem(vscode.Uri.file(require('path').join(git.root, file.path)));
      const name = require('path').basename(file.path);
      item.label = status === 'D' ? strike(name) : name;
      const dir = require('path').dirname(file.path);
      item.description = dir === '.' ? '' : dir;
      item.tooltip = new vscode.MarkdownString([
        `**${statusName(status)}**`,
        '',
        file.origPath ? `\`${file.origPath}\` -> \`${file.path}\`` : `\`${file.path}\``
      ].join('\n'));
      item.contextValue = `${staged ? 'gitTree.changeStaged' : 'gitTree.changeWorking'}.${status}`;
      item.resourceUri = vscode.Uri.file(require('path').join(git.root, file.path));
      item.file = file;
      item.staged = staged;
      item.command = {
        command: 'gitTree.openChange',
        title: 'Open Changes',
        arguments: [item]
      };
      return item;
}

function strike(value) { return [...value].map((char) => `${char}\u0336`).join(''); }

function sortChanges(files, sortBy) {
  const copy = [...files];
  if (sortBy === 'status') return copy.sort((a, b) => `${a.x}${a.y}`.localeCompare(`${b.x}${b.y}`) || a.path.localeCompare(b.path));
  if (sortBy === 'name') return copy.sort((a, b) => require('path').basename(a.path).localeCompare(require('path').basename(b.path)));
  return copy.sort((a, b) => a.path.localeCompare(b.path));
}

class ChangeDecorations {
  constructor() {
    this.statuses = new Map();
    this._onDidChangeFileDecorations = new vscode.EventEmitter();
    this.onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;
  }
  update(root, files) {
    this.statuses.clear();
    for (const file of files) {
      const uri = vscode.Uri.file(require('path').join(root, file.path));
      const status = file.x === '?' ? 'U' : file.y !== ' ' ? file.y : file.x;
      this.statuses.set(uri.toString(), status);
    }
    this._onDidChangeFileDecorations.fire(undefined);
  }
  provideFileDecoration(uri) {
    const status = this.statuses.get(uri.toString());
    if (!status) return undefined;
    const color = status === 'A' || status === 'U' ? 'gitDecoration.addedResourceForeground'
      : status === 'D' ? 'gitDecoration.deletedResourceForeground'
        : status === 'R' ? 'gitDecoration.renamedResourceForeground'
          : status === 'C' ? 'gitDecoration.conflictingResourceForeground'
            : 'gitDecoration.modifiedResourceForeground';
    return { tooltip: statusName(status), color: new vscode.ThemeColor(color), propagate: false };
  }
  dispose() { this._onDidChangeFileDecorations.dispose(); }
}

function statusName(status) {
  return ({ A: 'Added', U: 'Untracked', M: 'Modified', D: 'Deleted', R: 'Renamed', C: 'Conflicted' })[status] || status;
}

class WorktreesProvider extends BaseProvider {
  async getChildren() {
    const git = this.getGit();
    if (!git) return [];
    return (await git.getWorktrees()).map((w) => {
      const item = new vscode.TreeItem(w.branch || w.path);
      item.description = w.path;
      item.tooltip = `${w.sha || ''}\n${w.path}`;
      item.iconPath = new vscode.ThemeIcon('repo');
      item.worktree = w;
      item.contextValue = w.locked ? 'gitTree.worktreeLocked' : 'gitTree.worktree';
      return item;
    });
  }
}

class SubmodulesProvider extends BaseProvider {
  async getChildren() {
    const git = this.getGit();
    if (!git) return [];
    return (await git.getSubmodules()).map((s) => {
      const item = new vscode.TreeItem(s.path);
      item.description = `${s.state === '+' ? 'modified' : s.state === '-' ? 'not initialized' : 'ready'} · ${s.sha.slice(0, 7)}`;
      item.iconPath = new vscode.ThemeIcon('repo-clone');
      item.submodule = s;
      item.contextValue = 'gitTree.submodule';
      return item;
    });
  }
}

class PullRequestsProvider extends BaseProvider {
  constructor(getGit, getGitLabToken, getAzureDevOpsToken) {
    super(getGit);
    this.getGitLabToken = getGitLabToken;
    this.getAzureDevOpsToken = getAzureDevOpsToken;
    this.loadPromise = null;
    this.lastItems = null;
  }
  async getChildren() {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.loadChildren();
    try {
      const items = await this.loadPromise;
      this.lastItems = items;
      return items;
    } catch (error) {
      if (this.lastItems) return this.lastItems;
      return [messageItem(`Unable to load requests: ${error.message}`)];
    } finally {
      this.loadPromise = null;
    }
  }
  async loadChildren() {
    const git = this.getGit();
    if (!git) return [];
    const remote = await git.getRemoteUrl();
    const configuredAzure = parseAzureConfiguration();
    const info = configuredAzure || parseHostedRemote(remote);
    if (!info) return [messageItem('Origin is not hosted on GitHub, GitLab, or Azure DevOps.')];
    const head = await git.getHead();
    if (info.provider === 'azure') {
      const requests = await azurePullRequests(info, await this.getAzureDevOpsToken(), head.branch);
      if (!requests.length) return [messageItem('No active Azure DevOps pull requests created by the current user.')];
      return requests.map(pullRequestItem);
    }
    const requests = info.provider === 'github'
      ? await githubPullRequests(info, head.branch)
      : await gitlabMergeRequests(info, await this.getGitLabToken(), head.branch);
    if (!requests.length) return [messageItem('No open pull/merge requests created by the current user.')];
    return requests.map(pullRequestItem);
  }
}

function pullRequestItem(pr) {
  const title = pr.number ? `${pr.currentBranch ? '● ' : ''}#${pr.number} ${pr.title}` : pr.title;
  const comments = pr.commentsTotal != null ? ` · ${pr.commentsActive}/${pr.commentsTotal} comments` : '';
  const current = pr.currentBranch ? ' · current branch' : '';
  const item = new vscode.TreeItem(title);
  item.description = `${pr.author} · ${pr.source} -> ${pr.target}${comments}${current}`;
  item.tooltip = new vscode.MarkdownString([
    `**${pr.title}**`,
    '',
    `${pr.author} · ${pr.source} -> ${pr.target}`,
    pr.currentBranch ? 'Matches the current working branch.' : '',
    pr.commentsTotal != null ? `${pr.commentsActive}/${pr.commentsTotal} active/total comments` : '',
    '',
    pr.url
  ].filter(Boolean).join('\n\n'));
  item.iconPath = new vscode.ThemeIcon(
    pr.draft ? 'git-pull-request-draft' : 'git-pull-request',
    pr.currentBranch ? new vscode.ThemeColor('charts.green') : undefined
  );
  item.contextValue = 'gitTree.pullRequest';
  item.pullRequest = pr;
  item.command = { command: 'gitTree.openPullRequestDetails', title: 'Open Pull Request Details', arguments: [item] };
  return item;
}

function messageItem(text) {
  const item = new vscode.TreeItem(text);
  item.iconPath = new vscode.ThemeIcon('info');
  return item;
}

function parseHostedRemote(remote) {
  const match = remote.match(/(?:git@|https?:\/\/)(github\.com|gitlab\.com)[/:]([^/]+)\/(.+?)(?:\.git)?$/i);
  if (!match) {
    const azure = parseAzureRemote(remote);
    return azure ? { provider: 'azure', ...azure } : null;
  }
  return { provider: match[1].toLowerCase().startsWith('github') ? 'github' : 'gitlab', owner: match[2], repo: match[3].replace(/\.git$/, '') };
}

function parseAzureRemote(remote) {
  const parsed = parseAzureHttpsRemote(remote);
  if (parsed) return parsed;
  const visualStudio = remote.match(/^https:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/(.+?)(?:\.git)?$/i);
  if (visualStudio) return { url: `https://${visualStudio[1]}.visualstudio.com/${visualStudio[2]}/_git/${visualStudio[3].replace(/\.git$/, '')}/pullrequests`, baseUrl: `https://${visualStudio[1]}.visualstudio.com`, org: visualStudio[1], project: visualStudio[2], repo: visualStudio[3].replace(/\.git$/, '') };
  const ssh = remote.match(/^git@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/(.+?)(?:\.git)?$/i);
  if (ssh) return { url: `https://dev.azure.com/${ssh[1]}/${ssh[2]}/_git/${ssh[3].replace(/\.git$/, '')}/pullrequests`, baseUrl: `https://dev.azure.com/${ssh[1]}`, org: ssh[1], project: ssh[2], repo: ssh[3].replace(/\.git$/, '') };
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
    const baseUrl = `${url.origin}${baseSegments.length ? `/${baseSegments.join('/')}` : ''}`;
    const org = url.hostname.endsWith('.visualstudio.com')
      ? url.hostname.replace(/\.visualstudio\.com$/i, '')
      : baseSourceSegments[baseSourceSegments.length - 1] || '';
    return { url: `${baseUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequests`, baseUrl, org, project, repo };
  } catch {
    return null;
  }
}

function parseAzureConfiguration() {
  const config = vscode.workspace.getConfiguration('gitTree');
  const repositoryUrl = config.get('azureDevOps.repositoryUrl', '').trim();
  if (repositoryUrl) {
    const parsed = parseAzureRemote(repositoryUrl);
    return parsed ? { provider: 'azure', ...parsed } : null;
  }
  const endpoint = config.get('azureDevOps.endpoint', '').trim();
  const org = config.get('azureDevOps.organization', '').trim();
  const project = config.get('azureDevOps.project', '').trim();
  const repo = config.get('azureDevOps.repository', '').trim();
  if (!endpoint || !project || !repo) return null;
  const baseUrl = normalizeAzureBaseUrl(endpoint, org);
  if (!baseUrl) return null;
  return {
    provider: 'azure',
    url: `${baseUrl}/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}/pullrequests`,
    baseUrl,
    org,
    project,
    repo
  };
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

async function azurePullRequests(info, token, branch) {
  if (!token) throw new Error('Azure DevOps token is not set. Run "Set Azure DevOps Token Securely..." first.');
  const headers = azureHeaders(token);
  const url = `${info.baseUrl}/${encodeURIComponent(info.project)}/_apis/git/repositories/${encodeURIComponent(info.repo)}/pullrequests?searchCriteria.status=active&api-version=7.1`;
  const [currentUser, response] = await Promise.all([
    azureCurrentUser(info, headers),
    fetchWithRetry(url, { headers })
  ]);
  if (!response.ok) throw new Error(`Azure DevOps returned ${response.status}`);
  const data = await response.json();
  return (data.value || []).filter((pr) => isAzureCurrentUserPr(pr, currentUser)).map((pr) => ({
    provider: 'azure',
    org: info.org,
    project: info.project,
    repo: info.repo,
    baseUrl: info.baseUrl,
    number: pr.pullRequestId,
    title: pr.title,
    author: pr.createdBy?.displayName || pr.createdBy?.uniqueName || 'unknown',
    source: String(pr.sourceRefName || '').replace(/^refs\/heads\//, ''),
    target: String(pr.targetRefName || '').replace(/^refs\/heads\//, ''),
    currentBranch: branchMatches(pr.sourceRefName, branch),
    draft: !!pr.isDraft,
    url: `${info.baseUrl}/${info.project}/_git/${info.repo}/pullrequest/${pr.pullRequestId}`,
    body: pr.description || '',
    state: pr.status,
    commentsActive: null,
    commentsTotal: null
  }));
}

async function azureCurrentUser(info, headers) {
  const data = await fetchWithRetry(`${info.baseUrl}/_apis/connectionData?api-version=7.1-preview.1`, { headers }, 2)
    .then((response) => response.ok ? response.json() : null)
    .catch(() => null);
  return data?.authenticatedUser || null;
}

function isAzureCurrentUserPr(pr, user) {
  if (!user) return true;
  const createdBy = pr.createdBy || {};
  return [createdBy.id, createdBy.uniqueName, createdBy.displayName]
    .filter(Boolean)
    .some((value) => [user.id, user.uniqueName, user.providerDisplayName, user.displayName]
      .filter(Boolean)
      .some((candidate) => String(candidate).toLowerCase() === String(value).toLowerCase()));
}

function azureHeaders(token) {
  return {
    Accept: 'application/json',
    Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`
  };
}

async function githubPullRequests(info, branch) {
  const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false });
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'GitTree-VSCode' };
  if (session) headers.Authorization = `Bearer ${session.accessToken}`;
  const user = session?.account?.label || session?.account?.id || '';
  const url = `https://api.github.com/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}/pulls?state=open&per_page=100`;
  let response = await fetchWithRetry(url, { headers });
  if (response.status === 404 && headers.Authorization) {
    const fallbackHeaders = { Accept: headers.Accept, 'User-Agent': headers['User-Agent'] };
    response = await fetchWithRetry(url, { headers: fallbackHeaders });
  }
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  return (await response.json()).map((pr) => {
    const total = Number(pr.comments || 0) + Number(pr.review_comments || 0);
    return { provider: 'github', owner: info.owner, repo: info.repo, number: pr.number, title: pr.title, author: pr.user.login, source: pr.head.ref, target: pr.base.ref, currentBranch: branchMatches(pr.head.ref, branch), draft: pr.draft, url: pr.html_url, body: pr.body || '', state: pr.state, commentsActive: total, commentsTotal: total };
  }).filter((pr) => !user || String(pr.author).toLowerCase() === String(user).toLowerCase());
}

async function gitlabMergeRequests(info, token, branch) {
  const headers = token ? { 'PRIVATE-TOKEN': token } : {};
  const project = encodeURIComponent(`${info.owner}/${info.repo}`);
  const [user, response] = await Promise.all([
    token ? fetchWithRetry('https://gitlab.com/api/v4/user', { headers }, 2).then((result) => result.ok ? result.json() : null).catch(() => null) : null,
    fetchWithRetry(`https://gitlab.com/api/v4/projects/${project}/merge_requests?state=opened&per_page=100`, { headers })
  ]);
  if (!response.ok) throw new Error(`GitLab returned ${response.status}`);
  return (await response.json())
    .map((pr) => ({ provider: 'gitlab', owner: info.owner, repo: info.repo, project: `${info.owner}/${info.repo}`, number: pr.iid, title: pr.title, author: pr.author.username, source: pr.source_branch, target: pr.target_branch, currentBranch: branchMatches(pr.source_branch, branch), draft: pr.draft, url: pr.web_url, body: pr.description || '', state: pr.state, commentsActive: pr.user_notes_count, commentsTotal: pr.user_notes_count }))
    .filter((pr) => !user || String(pr.author).toLowerCase() === String(user.username).toLowerCase());
}

async function fetchWithRetry(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal });
      if (!isTransientStatus(response.status) || attempt === attempts - 1) return response;
      lastError = new Error(`${url} returned ${response.status}`);
    } catch (error) {
      lastError = error;
      if (attempt === attempts - 1) throw error;
    } finally {
      clearTimeout(timeout);
    }
    await delay(300 * (2 ** attempt));
  }
  throw lastError || new Error(`Unable to load ${url}`);
}

function isTransientStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function branchMatches(ref, branch) {
  const cleanRef = String(ref || '').replace(/^refs\/heads\//, '').replace(/^origin\//, '');
  const cleanBranch = String(branch || '').replace(/^refs\/heads\//, '').replace(/^origin\//, '');
  return Boolean(cleanRef && cleanBranch && cleanRef === cleanBranch);
}

function changeGroup(label, id, files, staged) {
  if (!files.length) return null;
  const item = new vscode.TreeItem(`${label} (${files.length})`, vscode.TreeItemCollapsibleState.Expanded);
  item.id = `changes:${id}`;
  item.contextValue = `gitTree.changeGroup.${id}`;
  item.files = files;
  item.staged = staged;
  item.description = staged ? 'INDEX' : 'WORKING TREE';
  item.iconPath = new vscode.ThemeIcon(
    staged ? 'pass-filled' : 'edit',
    new vscode.ThemeColor(staged
      ? 'gitDecoration.stageModifiedResourceForeground'
      : 'gitDecoration.modifiedResourceForeground')
  );
  return item;
}

module.exports = { BranchesProvider, StashesProvider, TagsProvider, ChangesProvider, WorktreesProvider, SubmodulesProvider, PullRequestsProvider, ChangeDecorations };
