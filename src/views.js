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
      return commits.filter((c) => !this.authorFilter || c.author.toLowerCase().includes(this.authorFilter.toLowerCase())).map((c) => {
        const item = new vscode.TreeItem(c.subject || '(no message)');
        const publication = c.published === true ? 'pushed' : c.published === false ? 'unpushed' : 'local';
        const signing = c.signature === 'G' ? 'signed' : c.signature === 'B' ? 'bad signature' : '';
        item.description = [c.sha.slice(0, 7), publication, signing, timeAgo(c.time)].filter(Boolean).join(' · ');
        item.tooltip = `${c.author} · ${c.sha}`;
        item.iconPath = new vscode.ThemeIcon(c.signature === 'G' ? 'verified-filled' : 'git-commit');
        item.contextValue = 'gitTree.commit';
        item.commit = c;
        item.command = { command: 'gitTree.showCommit', title: 'Show Commit', arguments: [item] };
        return item;
      });
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
        item.tooltip = new vscode.MarkdownString(
          `**${b.name}** \`${b.sha}\`\n\n${b.subject || ''}\n\n` +
            (b.upstream ? `Tracks \`${b.upstream}\` ${b.track ? `(${b.track})` : ''}` : '_no upstream_')
        );
        const diverged = /ahead\s+\d+.*behind\s+\d+|behind\s+\d+.*ahead\s+\d+/i.test(b.track);
        const behind = /behind\s+\d+/i.test(b.track);
        const ahead = /ahead\s+\d+/i.test(b.track);
        const color = b.current ? 'charts.green' : diverged ? 'charts.orange' : behind ? 'charts.red' : ahead ? 'charts.blue' : undefined;
        item.iconPath = new vscode.ThemeIcon(b.current ? 'circle-filled' : 'git-branch', color ? new vscode.ThemeColor(color) : undefined);
        item.branch = b;
        return item;
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
  async getChildren(element) {
    const git = this.getGit();
    if (!git) return [];
    if (!element) {
      const status = await git.getStatus();
      this.decorations.update(git.root, status.files);
      this.onCount(status.count);
      const staged = status.files.filter((f) => f.x !== ' ' && f.x !== '?');
      const working = status.files.filter((f) => f.y !== ' ' || f.x === '?');
      return [
        changeGroup('Staged Changes', 'staged', staged, true),
        ...changeLevel(sortChanges(working, this.sortBy), false, [], this.viewMode, git)
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
    item.contextValue = 'gitTree.changeFolder';
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
  }
  async getChildren() {
    const git = this.getGit();
    if (!git) return [];
    const remote = await git.getRemoteUrl();
    const configuredAzure = parseAzureConfiguration();
    const info = configuredAzure || parseHostedRemote(remote);
    if (!info) return [messageItem('Origin is not hosted on GitHub, GitLab, or Azure DevOps.')];
    try {
      if (info.provider === 'azure') {
        const head = await git.getHead();
        const requests = await azurePullRequests(info, await this.getAzureDevOpsToken(), head.branch);
        if (!requests.length) return [messageItem(head.branch ? `No active Azure DevOps pull requests for ${head.branch}.` : 'No active Azure DevOps pull requests.')];
        return requests.map(pullRequestItem);
      }
      const requests = info.provider === 'github'
        ? await githubPullRequests(info)
        : await gitlabMergeRequests(info, await this.getGitLabToken());
      if (!requests.length) return [messageItem('No open pull/merge requests.')];
      return requests.map(pullRequestItem);
    } catch (error) {
      return [messageItem(`Unable to load requests: ${error.message}`)];
    }
  }
}

function pullRequestItem(pr) {
  const title = pr.number ? `#${pr.number} ${pr.title}` : pr.title;
  const comments = pr.commentsTotal != null ? ` · ${pr.commentsActive}/${pr.commentsTotal} comments` : '';
  const item = new vscode.TreeItem(title);
  item.description = `${pr.author} · ${pr.source} -> ${pr.target}${comments}`;
  item.tooltip = new vscode.MarkdownString([
    `**${pr.title}**`,
    '',
    `${pr.author} · ${pr.source} -> ${pr.target}`,
    pr.commentsTotal != null ? `${pr.commentsActive}/${pr.commentsTotal} active/total comments` : '',
    '',
    pr.url
  ].filter(Boolean).join('\n\n'));
  item.iconPath = new vscode.ThemeIcon(pr.draft ? 'git-pull-request-draft' : 'git-pull-request');
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
  const source = branch ? `&searchCriteria.sourceRefName=${encodeURIComponent(`refs/heads/${branch}`)}` : '';
  const url = `${info.baseUrl}/${encodeURIComponent(info.project)}/_apis/git/repositories/${encodeURIComponent(info.repo)}/pullrequests?searchCriteria.status=active${source}&api-version=7.1`;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`Azure DevOps returned ${response.status}`);
  const data = await response.json();
  return (data.value || []).map((pr) => ({
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
    draft: !!pr.isDraft,
    url: `${info.baseUrl}/${info.project}/_git/${info.repo}/pullrequest/${pr.pullRequestId}`,
    body: pr.description || '',
    state: pr.status,
    commentsActive: null,
    commentsTotal: null
  }));
}

function azureHeaders(token) {
  return {
    Accept: 'application/json',
    Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`
  };
}

async function githubPullRequests(info) {
  const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false });
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'GitTree-VSCode' };
  if (session) headers.Authorization = `Bearer ${session.accessToken}`;
  const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(info.owner)}/${encodeURIComponent(info.repo)}/pulls?state=open&per_page=50`, { headers });
  if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
  return (await response.json()).map((pr) => {
    const total = Number(pr.comments || 0) + Number(pr.review_comments || 0);
    return { provider: 'github', owner: info.owner, repo: info.repo, number: pr.number, title: pr.title, author: pr.user.login, source: pr.head.ref, target: pr.base.ref, draft: pr.draft, url: pr.html_url, body: pr.body || '', state: pr.state, commentsActive: total, commentsTotal: total };
  });
}

async function gitlabMergeRequests(info, token) {
  const headers = token ? { 'PRIVATE-TOKEN': token } : {};
  const project = encodeURIComponent(`${info.owner}/${info.repo}`);
  const response = await fetch(`https://gitlab.com/api/v4/projects/${project}/merge_requests?state=opened&per_page=50`, { headers });
  if (!response.ok) throw new Error(`GitLab returned ${response.status}`);
  return (await response.json()).map((pr) => ({ provider: 'gitlab', owner: info.owner, repo: info.repo, project: `${info.owner}/${info.repo}`, number: pr.iid, title: pr.title, author: pr.author.username, source: pr.source_branch, target: pr.target_branch, draft: pr.draft, url: pr.web_url, body: pr.description || '', state: pr.state, commentsActive: pr.user_notes_count, commentsTotal: pr.user_notes_count }));
}

function changeGroup(label, id, files, staged) {
  if (!files.length) return null;
  const item = new vscode.TreeItem(`${label} (${files.length})`, vscode.TreeItemCollapsibleState.Expanded);
  item.id = `changes:${id}`;
  item.contextValue = `gitTree.changeGroup.${id}`;
  item.files = files;
  item.staged = staged;
  item.iconPath = new vscode.ThemeIcon(staged ? 'checklist' : 'files');
  return item;
}

module.exports = { BranchesProvider, StashesProvider, TagsProvider, ChangesProvider, WorktreesProvider, SubmodulesProvider, PullRequestsProvider, ChangeDecorations };
