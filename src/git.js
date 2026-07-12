// Thin async wrapper around the git CLI. No external dependencies.
'use strict';

const cp = require('child_process');
const path = require('path');

const SEP = '\x1f'; // unit separator, safe inside pretty formats
const REC = '\x1e'; // record separator

class GitError extends Error {
  constructor(message, args) {
    super(message);
    this.name = 'GitError';
    this.args = args;
  }
}

class Git {
  /** @param {string} repoRoot absolute path to the repository root */
  constructor(repoRoot) {
    this.root = repoRoot;
  }

  exec(args, opts = {}) {
    return new Promise((resolve, reject) => {
      cp.execFile(
        'git',
        args,
        { cwd: this.root, maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts },
        (err, stdout, stderr) => {
          if (err) {
            reject(new GitError((stderr || err.message || '').trim(), args));
          } else {
            resolve(stdout);
          }
        }
      );
    });
  }

  /** Find the repository root that contains dir, or null. */
  static async discover(dir) {
    return new Promise((resolve) => {
      cp.execFile(
        'git',
        ['rev-parse', '--show-toplevel'],
        { cwd: dir, windowsHide: true },
        (err, stdout) => resolve(err ? null : stdout.trim())
      );
    });
  }

  get name() {
    return path.basename(this.root);
  }

  // ---------------------------------------------------------------- queries

  async getHead() {
    const out = await this.exec(['rev-parse', 'HEAD', '--abbrev-ref', 'HEAD']).catch(() => '');
    const [sha = '', branch = ''] = out.split('\n').map((s) => s.trim());
    return { sha, branch: branch === 'HEAD' ? '' : branch }; // '' => detached
  }

  /**
   * Commit list for the graph.
   * @param {{maxCount?:number, all?:boolean, includeRemotes?:boolean, file?:string}} opts
   */
  async getLog(opts = {}) {
    const args = [
      'log',
      '--date-order',
      `--pretty=format:%H${SEP}%P${SEP}%an${SEP}%ae${SEP}%at${SEP}%D${SEP}%s${SEP}%G?${REC}`,
      '-n',
      String(opts.maxCount || 500)
    ];
    if (opts.file) {
      args.push('--follow', '--', opts.file);
    } else if (opts.all !== false) {
      args.push('--branches', '--tags', 'HEAD');
      if (opts.includeRemotes !== false) args.push('--remotes');
    }
    const out = await this.exec(args).catch(() => '');
    const commits = [];
    for (const rec of out.split(REC)) {
      const line = rec.replace(/^\n/, '');
      if (!line) continue;
      const [sha, parents, author, email, time, refs, subject, signature] = line.split(SEP);
      if (!sha) continue;
      commits.push({
        sha,
        parents: parents ? parents.split(' ') : [],
        author,
        email,
        time: Number(time) * 1000,
        refs: parseRefs(refs),
        subject: subject || '',
        signature: signature || 'N'
      });
    }
    return commits;
  }

  /** Working tree status. Returns {files:[{x,y,path,origPath}], count}. */
  async getStatus() {
    // -z avoids quoted/escaped paths and makes renames unambiguous.
    // -uall lists each untracked file individually instead of collapsing a new
    // directory into a single "folder/" entry.
    const out = await this.exec(['status', '--porcelain=v1', '-z', '-uall']).catch(() => '');
    const files = [];
    const records = out.split('\0');
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record) continue;
      const x = record[0];
      const y = record[1];
      let filePath = record.slice(3);
      let origPath;
      if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
        // In porcelain -z output the destination is in the first record and
        // the source follows as another NUL-terminated field.
        origPath = records[++i] || undefined;
      }
      files.push({ x, y, path: filePath, origPath });
    }
    return { files, count: files.length };
  }

  /** Full details of one commit: metadata + changed files with stats. */
  async getCommitDetails(sha) {
    const metaOut = await this.exec([
      'show',
      '-s',
      `--format=%H${SEP}%an${SEP}%ae${SEP}%at${SEP}%cn${SEP}%ct${SEP}%P${SEP}%D${SEP}%B`,
      sha
    ]);
    const [hash, author, email, atime, committer, ctime, parents, refs, ...bodyParts] =
      metaOut.split(SEP);
    const body = bodyParts.join(SEP).replace(/\s+$/, '');
    const parentList = parents ? parents.split(' ').filter(Boolean) : [];

    const files = await this.getChangedFiles(
      parentList.length ? `${sha}^` : null,
      sha,
      parentList.length > 1 ? parentList[0] : null
    );

    return {
      sha: hash,
      author,
      email,
      authorTime: Number(atime) * 1000,
      committer,
      commitTime: Number(ctime) * 1000,
      parents: parentList,
      refs: parseRefs(refs),
      body,
      files,
      isMerge: parentList.length > 1
    };
  }

  /**
   * Changed files between two revs (or a root commit when base is null).
   * Returns [{status,path,origPath,additions,deletions}].
   */
  async getChangedFiles(base, target, mergeFirstParent) {
    let nameStatus, numstat;
    if (base === null) {
      // root commit
      nameStatus = await this.exec(['diff-tree', '-r', '-M', '--root', '--name-status', '--format=', target]);
      numstat = await this.exec(['diff-tree', '-r', '-M', '--root', '--numstat', '--format=', target]);
    } else {
      const from = mergeFirstParent || base;
      nameStatus = await this.exec(['diff', '--name-status', '-M', from, target]);
      numstat = await this.exec(['diff', '--numstat', '-M', from, target]);
    }
    return zipFileStats(nameStatus, numstat);
  }

  /** Compare two refs/commits: ahead/behind counts, commit lists, changed files. */
  async getCompare(a, b) {
    const files = await this.getChangedFiles(a, b).catch(() => []);
    let behind = 0;
    let ahead = 0;
    try {
      const counts = await this.exec(['rev-list', '--left-right', '--count', `${a}...${b}`]);
      const [l, r] = counts.trim().split(/\s+/).map(Number);
      behind = l; // commits only in a
      ahead = r; // commits only in b
    } catch (e) {
      /* unrelated histories etc. */
    }
    const listArgs = (range) => [
      'log',
      `--pretty=format:%h${SEP}%an${SEP}%at${SEP}%s${REC}`,
      '-n',
      '50',
      range
    ];
    const parseList = (out) =>
      out
        .split(REC)
        .map((r) => r.replace(/^\n/, ''))
        .filter(Boolean)
        .map((r) => {
          const [sha, author, time, subject] = r.split(SEP);
          return { sha, author, time: Number(time) * 1000, subject };
        });
    const onlyInB = parseList(await this.exec(listArgs(`${a}..${b}`)).catch(() => ''));
    const onlyInA = parseList(await this.exec(listArgs(`${b}..${a}`)).catch(() => ''));
    return { a, b, ahead, behind, files, onlyInA, onlyInB };
  }

  async getCompareWorking(base) {
    const result = await this.getCompare(base, 'HEAD');
    result.b = 'Working Tree';
    result.files = await this.getChangedFiles(base, 'HEAD').catch(() => []);
    const working = await this.exec(['diff', '--name-status', '-M', base]).catch(() => '');
    const stats = await this.exec(['diff', '--numstat', '-M', base]).catch(() => '');
    result.files = zipFileStats(working, stats);
    const status = await this.getStatus();
    for (const file of status.files.filter((f) => f.x === '?')) {
      if (!result.files.some((f) => f.path === file.path)) {
        result.files.push({ status: 'U', path: file.path, additions: null, deletions: null });
      }
    }
    return result;
  }

  /** Local + remote branches with tracking info. */
  async getBranches() {
    const fmt = [
      '%(refname)',
      '%(refname:short)',
      '%(objectname:short)',
      '%(upstream:short)',
      '%(upstream:track)',
      '%(committerdate:unix)',
      '%(subject)',
      '%(HEAD)'
    ].join(SEP);
    const out = await this.exec([
      'for-each-ref',
      `--format=${fmt}`,
      '--sort=-committerdate',
      'refs/heads',
      'refs/remotes'
    ]).catch(() => '');
    const branches = [];
    for (const line of out.split('\n')) {
      if (!line.trim()) continue;
      const [refname, short, sha, upstream, track, time, subject, head] = line.split(SEP);
      if (refname.endsWith('/HEAD')) continue; // skip symbolic refs like origin/HEAD
      branches.push({
        name: short,
        sha,
        remote: refname.startsWith('refs/remotes/'),
        upstream: upstream || null,
        track: (track || '').replace(/[\[\]]/g, ''),
        time: Number(time) * 1000,
        subject,
        current: head === '*'
      });
    }
    return branches;
  }

  async getLastCommitMessage() {
    return (await this.exec(['log', '-1', '--pretty=%B']).catch(() => '')).trim();
  }

  async getBranchLog(ref, maxCount = 25, upstream) {
    const out = await this.exec([
      'log', `--pretty=format:%H${SEP}%an${SEP}%at${SEP}%s${SEP}%G?${REC}`,
      '-n', String(maxCount), ref
    ]).catch(() => '');
    const unpublished = upstream
      ? new Set((await this.exec(['rev-list', ref, '--not', upstream]).catch(() => '')).trim().split('\n').filter(Boolean))
      : new Set();
    return out.split(REC).map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
      const [sha, author, time, subject, signature] = r.split(SEP);
      return { sha, author, time: Number(time) * 1000, subject, signature, published: upstream ? !unpublished.has(sha) : null };
    });
  }

  async getCommitStats(sha) {
    const statusOut = await this.exec(['diff-tree', '--root', '--no-commit-id', '--name-status', '-r', '-M', sha]).catch(() => '');
    const numstatOut = await this.exec(['diff-tree', '--root', '--no-commit-id', '--numstat', '-r', '-M', sha]).catch(() => '');
    const statusCounts = { added: 0, modified: 0, deleted: 0, renamed: 0, files: 0 };
    for (const line of statusOut.split('\n')) {
      if (!line.trim()) continue;
      statusCounts.files += 1;
      const status = line[0];
      if (status === 'A') statusCounts.added += 1;
      else if (status === 'D') statusCounts.deleted += 1;
      else if (status === 'R') statusCounts.renamed += 1;
      else statusCounts.modified += 1;
    }
    let additions = 0;
    let deletions = 0;
    for (const line of numstatOut.split('\n')) {
      if (!line.trim()) continue;
      const [add, del] = line.split(/\s+/);
      additions += Number(add) || 0;
      deletions += Number(del) || 0;
    }
    return { ...statusCounts, additions, deletions };
  }

  async getWorktrees() {
    const out = await this.exec(['worktree', 'list', '--porcelain']).catch(() => '');
    return out.trim().split(/\n\n+/).filter(Boolean).map((block) => {
      const fields = Object.fromEntries(block.split('\n').map((line) => {
        const i = line.indexOf(' ');
        return i < 0 ? [line, true] : [line.slice(0, i), line.slice(i + 1)];
      }));
      return { path: fields.worktree, sha: fields.HEAD, branch: (fields.branch || '').replace('refs/heads/', ''), bare: !!fields.bare, locked: !!fields.locked };
    });
  }

  async getSubmodules() {
    const out = await this.exec(['submodule', 'status', '--recursive']).catch(() => '');
    return out.split('\n').filter(Boolean).map((line) => {
      const state = line[0];
      const [sha, modulePath, ...description] = line.slice(1).trim().split(/\s+/);
      return { state, sha, path: modulePath, description: description.join(' ') };
    });
  }

  async getDefaultCompareRef() {
    const upstream = await this.exec(['rev-parse', '--abbrev-ref', '@{upstream}']).catch(() => '');
    if (upstream.trim()) return upstream.trim();
    for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
      const ok = await this.exec(['rev-parse', '--verify', candidate]).catch(() => '');
      if (ok.trim()) return candidate;
    }
    return 'HEAD';
  }

  async getRemoteUrl() {
    return (await this.exec(['remote', 'get-url', 'origin']).catch(() => '')).trim();
  }
  async getRemotes() {
    return (await this.exec(['remote']).catch(() => '')).split('\n').map((x) => x.trim()).filter(Boolean);
  }

  async isRebaseInProgress() {
    const merge = (await this.exec(['rev-parse', '--git-path', 'rebase-merge']).catch(() => '')).trim();
    const apply = (await this.exec(['rev-parse', '--git-path', 'rebase-apply']).catch(() => '')).trim();
    return [merge, apply].some((p) => p && require('fs').existsSync(require('path').resolve(this.root, p)));
  }

  async getStashes() {
    const out = await this.exec([
      'stash',
      'list',
      `--pretty=format:%gd${SEP}%at${SEP}%gs`
    ]).catch(() => '');
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref, time, message] = line.split(SEP);
        return { ref, time: Number(time) * 1000, message };
      });
  }

  async getTags() {
    const fmt = ['%(refname:short)', '%(objectname:short)', '%(creatordate:unix)', '%(subject)'].join(SEP);
    const out = await this.exec([
      'for-each-ref',
      `--format=${fmt}`,
      '--sort=-creatordate',
      'refs/tags'
    ]).catch(() => '');
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [name, sha, time, subject] = line.split(SEP);
        return { name, sha, time: Number(time) * 1000, subject };
      });
  }

  /** File content at a revision ('' if it did not exist). */
  async showFile(rev, filePath) {
    const rel = filePath.replace(/\\/g, '/');
    return this.exec(['show', `${rev}:${rel}`]).catch(() => '');
  }

  async blameLine(filePath, line) {
    const out = await this.exec([
      'blame',
      '-L',
      `${line},${line}`,
      '--porcelain',
      '--',
      filePath
    ]);
    const lines = out.split('\n');
    const sha = (lines[0] || '').split(' ')[0];
    const get = (key) => {
      const l = lines.find((x) => x.startsWith(key + ' '));
      return l ? l.slice(key.length + 1) : '';
    };
    return {
      sha,
      author: get('author'),
      time: Number(get('author-time')) * 1000,
      summary: get('summary'),
      uncommitted: /^0+$/.test(sha)
    };
  }

  // ---------------------------------------------------------------- actions

  checkout(ref) { return this.exec(['checkout', ref]); }
  checkoutDetached(sha) { return this.exec(['checkout', '--detach', sha]); }
  createBranch(name, startPoint, switchTo) {
    return switchTo
      ? this.exec(['checkout', '-b', name, ...(startPoint ? [startPoint] : [])])
      : this.exec(['branch', name, ...(startPoint ? [startPoint] : [])]);
  }
  deleteBranch(name, force) { return this.exec(['branch', force ? '-D' : '-d', name]); }
  deleteRemoteBranch(remote, name) { return this.exec(['push', remote, '--delete', name]); }
  renameBranch(oldName, newName) { return this.exec(['branch', '-m', oldName, newName]); }
  merge(ref) { return this.exec(['merge', ref]); }
  rebase(ref) { return this.exec(['rebase', ref]); }
  rebaseContinue() { return this.exec(['rebase', '--continue']); }
  rebaseSkip() { return this.exec(['rebase', '--skip']); }
  rebaseAbort() { return this.exec(['rebase', '--abort']); }
  cherryPick(sha) { return this.exec(['cherry-pick', sha]); }
  revert(sha, isMerge) { return this.exec(['revert', '--no-edit', ...(isMerge ? ['-m', '1'] : []), sha]); }
  reset(sha, mode) { return this.exec(['reset', `--${mode}`, sha]); }
  createTag(name, sha, message) {
    return message
      ? this.exec(['tag', '-a', name, '-m', message, ...(sha ? [sha] : [])])
      : this.exec(['tag', name, ...(sha ? [sha] : [])]);
  }
  deleteTag(name) { return this.exec(['tag', '-d', name]); }
  stashSave(message, includeUntracked) {
    return this.exec(['stash', 'push', ...(includeUntracked ? ['-u'] : []), ...(message ? ['-m', message] : [])]);
  }
  stashSaveAdvanced(message, mode) {
    const flag = mode === 'untracked' ? '-u' : mode === 'staged' ? '--staged' : mode === 'keepIndex' ? '--keep-index' : null;
    return this.exec(['stash', 'push', ...(flag ? [flag] : []), ...(message ? ['-m', message] : [])]);
  }
  stashApply(ref) { return this.exec(['stash', 'apply', ref]); }
  stashPop(ref) { return this.exec(['stash', 'pop', ref]); }
  stashDrop(ref) { return this.exec(['stash', 'drop', ref]); }
  stashFile(filePath) { return this.exec(['stash', 'push', '--', filePath]); }
  fetch() { return this.exec(['fetch', '--all', '--prune']); }
  pull() { return this.exec(['pull']); }
  push() { return this.exec(['push']); }
  fetchBranch(remote, branch) { return this.exec(['fetch', remote, branch, '--prune']); }
  pullBranch(remote, branch) { return this.exec(['pull', remote, branch]); }
  pushBranch(remote, branch, setUpstream = false) {
    return this.exec(['push', ...(setUpstream ? ['--set-upstream'] : []), remote, branch]);
  }
  addRemote(name, url) { return this.exec(['remote', 'add', name, url]); }
  setRemoteUrl(name, url) { return this.exec(['remote', 'set-url', name, url]); }
  stage(filePath) { return this.exec(['add', '--', filePath]); }
  stageAll() { return this.exec(['add', '-A']); }
  unstage(filePath) { return this.exec(['reset', '-q', 'HEAD', '--', filePath]); }
  unstageAll() { return this.exec(['reset', '-q', 'HEAD', '--', '.']); }
  discard(filePath, untracked) {
    return untracked
      ? this.exec(['clean', '-f', '--', filePath])
      : this.exec(['restore', '--worktree', '--', filePath]);
  }
  commit(message, opts = {}) {
    if (opts.amend && !message) {
      return this.exec(['commit', '--amend', '--no-edit', ...(opts.sign ? ['-S'] : [])]);
    }
    return this.exec(['commit', ...(opts.amend ? ['--amend'] : []), ...(opts.sign ? ['-S'] : []), '-m', message]);
  }
  updateSubmodules() { return this.exec(['submodule', 'update', '--init', '--recursive']); }
  syncSubmodules() { return this.exec(['submodule', 'sync', '--recursive']); }
  addWorktree(worktreePath, branch) { return this.exec(['worktree', 'add', worktreePath, ...(branch ? [branch] : [])]); }
  removeWorktree(worktreePath, force = false) { return this.exec(['worktree', 'remove', ...(force ? ['--force'] : []), worktreePath]); }
  pruneWorktrees() { return this.exec(['worktree', 'prune']); }
  lockWorktree(worktreePath) { return this.exec(['worktree', 'lock', worktreePath]); }
  unlockWorktree(worktreePath) { return this.exec(['worktree', 'unlock', worktreePath]); }
}

// -------------------------------------------------------------------- utils

function parseRefs(refString) {
  // %D -> "HEAD -> main, origin/main, tag: v1.0"
  const refs = [];
  if (!refString) return refs;
  for (let part of refString.split(', ')) {
    part = part.trim();
    if (!part) continue;
    if (part === 'HEAD') {
      refs.push({ type: 'head', name: 'HEAD' });
    } else if (part.startsWith('HEAD -> ')) {
      refs.push({ type: 'branch', name: part.slice(8), head: true });
    } else if (part.startsWith('tag: ')) {
      refs.push({ type: 'tag', name: part.slice(5) });
    } else if (/^[^/]+\//.test(part)) {
      refs.push({ type: 'remote', name: part });
    } else {
      refs.push({ type: 'branch', name: part });
    }
  }
  return refs;
}

function unquote(p) {
  if (p.startsWith('"') && p.endsWith('"')) {
    try {
      return JSON.parse(p);
    } catch (e) {
      return p.slice(1, -1);
    }
  }
  return p;
}

function zipFileStats(nameStatusOut, numstatOut) {
  const stats = new Map();
  for (const line of numstatOut.split('\n')) {
    if (!line.trim()) continue;
    const [add, del, ...rest] = line.split('\t');
    let p = rest.join('\t');
    // renames come as "old\tnew" already split, or "{old => new}" style; keep last segment
    if (rest.length === 2) p = rest[1];
    stats.set(unquote(p), {
      additions: add === '-' ? null : Number(add),
      deletions: del === '-' ? null : Number(del)
    });
  }
  const files = [];
  for (const line of nameStatusOut.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0][0];
    let filePath, origPath;
    if (status === 'R' || status === 'C') {
      origPath = unquote(parts[1]);
      filePath = unquote(parts[2]);
    } else {
      filePath = unquote(parts[1]);
    }
    const s = stats.get(filePath) || { additions: null, deletions: null };
    files.push({ status, path: filePath, origPath, additions: s.additions, deletions: s.deletions });
  }
  return files;
}

module.exports = { Git, GitError, _test: { parseRefs, zipFileStats } };
