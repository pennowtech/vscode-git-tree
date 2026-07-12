// Manages the "Commit Graph" webview panel (graph on the left, details on the right).
'use strict';

const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');

class GraphPanel {
  static current = undefined;

  /**
   * @param {vscode.ExtensionContext} context
   * @param {import('./git').Git} git
   * @param {{file?: string}} [options] optional file-history filter
   */
  static show(context, git, options = {}) {
    const column = vscode.ViewColumn.One;
    if (GraphPanel.current) {
      GraphPanel.current.git = git;
      GraphPanel.current.fileFilter = options.file;
      if (options.currentOnly) GraphPanel.current.scope = 'current';
      GraphPanel.current.panel.reveal(column);
      GraphPanel.current.refresh();
      return GraphPanel.current;
    }
    const panel = vscode.window.createWebviewPanel('gitTree.graph', 'GitTree Graph', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(context.extensionPath, 'media'))]
    });
    GraphPanel.current = new GraphPanel(context, panel, git, options.file, !!options.currentOnly);
    return GraphPanel.current;
  }

  constructor(context, panel, git, fileFilter, currentOnly) {
    this.context = context;
    this.panel = panel;
    this.git = git;
    this.fileFilter = fileFilter;
    this.disposables = [];
    this.scope = fileFilter || currentOnly ? 'current' : 'all'; // 'all' | 'current'

    panel.iconPath = vscode.Uri.file(path.join(context.extensionPath, 'resources', 'gittree.svg'));
    panel.webview.html = this.getHtml();
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);
  }

  dispose() {
    GraphPanel.current = undefined;
    this.disposables.forEach((d) => d.dispose());
  }

  post(msg) {
    this.panel.webview.postMessage(msg);
  }

  async onMessage(msg) {
    const actions = require('./actions');
    try {
      switch (msg.type) {
        case 'ready':
        case 'reload':
          if (msg.scope) this.scope = msg.scope;
          if (msg.type === 'reload' && msg.clearFileFilter) this.fileFilter = undefined;
          await this.refresh();
          break;
        case 'select':
          await this.sendDetails(msg.sha);
          break;
        case 'selectWorkingTree':
          await this.sendWorkingTreeDetails();
          break;
        case 'compare':
          await this.sendCompare(msg.a, msg.b);
          break;
        case 'openFileDiff':
          await this.openFileDiff(msg);
          break;
        case 'openFile': {
          const uri = vscode.Uri.file(path.join(this.git.root, msg.path));
          await vscode.window.showTextDocument(uri, { preview: true });
          break;
        }
        case 'revealFile': {
          const uri = vscode.Uri.file(path.join(this.git.root, msg.path));
          await vscode.commands.executeCommand('revealInExplorer', uri);
          break;
        }
        case 'openTerminal': {
          const target = msg.path ? path.dirname(path.join(this.git.root, msg.path)) : this.git.root;
          vscode.window.createTerminal({ name: 'GitTree', cwd: target }).show();
          break;
        }
        case 'copy':
          await vscode.env.clipboard.writeText(msg.text);
          vscode.window.setStatusBarMessage('Copied to clipboard', 2000);
          break;
        case 'action':
          if (msg.action === 'interactiveRebase') {
            const ref = msg.args?.name || 'HEAD~5';
            const terminal = vscode.window.createTerminal({ name: 'Interactive Rebase', cwd: this.git.root });
            terminal.show();
            terminal.sendText(`git rebase -i ${shellQuote(ref)}`);
            break;
          }
          await actions.run(this.git, msg.action, msg.args || {});
          await this.refresh();
          vscode.commands.executeCommand('gitTree.refreshViews');
          break;
      }
    } catch (err) {
      const text = err && err.message ? err.message : String(err);
      if (text) vscode.window.showErrorMessage(text);
      this.post({ type: 'busy', busy: false });
    }
  }

  async refresh() {
    if (!this.git) return;
    this.post({ type: 'busy', busy: true });
    const config = vscode.workspace.getConfiguration('gitTree');
    const [commits, head, status, branches] = await Promise.all([
      this.git.getLog({
        maxCount: config.get('maxCommits', 500),
        all: this.scope === 'all' && !this.fileFilter,
        includeRemotes: config.get('showRemoteBranches', true),
        file: this.fileFilter
      }),
      this.git.getHead(),
      this.git.getStatus(),
      this.git.getBranches()
    ]);
    this.panel.title = this.fileFilter
      ? `History: ${path.basename(this.fileFilter)}`
      : `${this.git.name} Graph`;
    this.post({
      type: 'graph',
      repoName: this.git.name,
      fileFilter: this.fileFilter || null,
      scope: this.scope,
      dateFormat: config.get('dateFormat', 'relative'),
      commits,
      head,
      status: { count: status.count },
      branches: branches.map((b) => b.name),
      defaultCompareRef: await this.git.getDefaultCompareRef()
    });
  }

  async sendDetails(sha) {
    const details = await this.git.getCommitDetails(sha);
    this.post({ type: 'details', details });
  }

  async sendWorkingTreeDetails() {
    const [status, head] = await Promise.all([this.git.getStatus(), this.git.getHead()]);
    const staged = [];
    const unstaged = [];
    for (const f of status.files) {
      const untracked = f.x === '?';
      if (untracked) {
        unstaged.push({
          status: 'U', path: f.path, origPath: f.origPath,
          additions: null, deletions: null, x: '?', y: '?', staged: false, untracked: true
        });
        continue;
      }
      // A file can be both staged (index vs HEAD) and unstaged (worktree vs index).
      if (f.x !== ' ') {
        staged.push({
          status: f.x, path: f.path, origPath: f.origPath,
          additions: null, deletions: null, x: f.x, y: f.y, staged: true, untracked: false
        });
      }
      if (f.y !== ' ') {
        unstaged.push({
          status: f.y, path: f.path, origPath: f.origPath,
          additions: null, deletions: null, x: f.x, y: f.y, staged: false, untracked: false
        });
      }
    }
    this.post({
      type: 'details',
      details: {
        workingTree: true,
        branch: head.branch || '',
        detached: !head.branch,
        headSha: head.sha,
        staged,
        unstaged
      }
    });
  }

  async sendCompare(a, b) {
    const result = b === 'WT' || b === 'Working Tree'
      ? await this.git.getCompareWorking(a)
      : await this.git.getCompare(a, b);
    this.post({ type: 'compareResult', result });
  }

  /** Open a VS Code diff editor for one file of a commit / compare / working tree. */
  async openFileDiff({ sha, base, filePath, origPath, status, workingTree, staged, untracked }) {
    const root = this.git.root;
    const workingFile = vscode.Uri.file(path.join(root, filePath));
    let left, right, title;
    if (workingTree && base) {
      // Compare a ref against the working tree: base ↔ working file
      title = `${path.basename(filePath)} (${short(base)} ↔ Working Tree)`;
      left = status === 'A' || status === 'U'
        ? emptyUri(root, filePath)
        : gitUri(root, base, origPath || filePath);
      right = status === 'D' ? emptyUri(root, filePath) : workingFile;
    } else if (workingTree && staged) {
      // Staged: HEAD ↔ index (:0)
      title = `${path.basename(filePath)} (Staged)`;
      left = status === 'A' ? emptyUri(root, filePath) : gitUri(root, 'HEAD', origPath || filePath);
      right = status === 'D' ? emptyUri(root, filePath) : gitUri(root, ':0', filePath);
    } else if (workingTree) {
      // Unstaged: index (:0) ↔ working tree
      title = `${path.basename(filePath)} (Working Tree)`;
      left = untracked || status === 'A' || status === 'U'
        ? emptyUri(root, filePath)
        : gitUri(root, ':0', origPath || filePath);
      right = status === 'D' ? emptyUri(root, filePath) : workingFile;
    } else {
      // Commit or compare: base ↔ sha
      title = `${path.basename(filePath)} (${base ? `${short(base)} ↔ ${short(sha)}` : short(sha)})`;
      right = status === 'D' ? emptyUri(root, filePath) : gitUri(root, sha, filePath);
      const leftRev = base || `${sha}^`;
      left = status === 'A' || status === 'U'
        ? emptyUri(root, filePath)
        : gitUri(root, leftRev, origPath || filePath);
    }
    await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
  }

  getHtml() {
    const webview = this.panel.webview;
    const mediaUri = (f) =>
      webview.asWebviewUri(vscode.Uri.file(path.join(this.context.extensionPath, 'media', f)));
    const nonce = crypto.randomBytes(16).toString('hex');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${mediaUri('graph.css')}" rel="stylesheet">
<title>GitTree Graph</title>
</head>
<body>
  <div id="toolbar">
    <span id="repoName" class="repo-name"></span>
    <span id="scopeInfo" class="scope-info" title="The active graph scope and number of loaded commits"></span>
    <span id="fileFilterChip" class="chip chip-filter" style="display:none" title="Click to clear file filter"></span>
    <select id="scopeSelect" title="Which branches to show">
      <option value="all">All refs (branches + tags)</option>
      <option value="current">Current branch only</option>
    </select>
    <input id="searchBox" type="text" placeholder="Search message / author / SHA…" spellcheck="false">
    <span class="spacer"></span>
    <button id="btnFetch" title="Fetch (all remotes, prune)">⇣ Fetch</button>
    <button id="btnPull" title="Pull">↓ Pull</button>
    <button id="btnPush" title="Push">↑ Push</button>
    <button id="btnStash" title="Stash working changes">▣ Stash</button>
    <button id="btnRefresh" title="Refresh">⟳</button>
  </div>
  <div id="main">
    <div id="graphPane">
      <table id="graphTable">
        <thead>
          <tr><th class="col-refs">Branches / Tags</th><th id="thGraph">Graph</th><th>Message</th><th class="col-author">Author</th><th class="col-date">Date</th><th class="col-sha">SHA</th></tr>
        </thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <div id="splitter" title="Drag to resize"></div>
    <div id="detailPane">
      <div id="detailContent" class="detail-empty">Select a commit to see its details.<br><br>
        <span class="hint">Ctrl/Cmd-click a second commit to compare two commits.<br>Right-click rows or branch chips for actions.</span>
      </div>
    </div>
  </div>
  <div id="ctxMenu" class="ctx-menu" style="display:none"></div>
  <div id="busy" style="display:none"><div class="busy-bar"></div></div>
  <script nonce="${nonce}" src="${mediaUri('graph.js')}"></script>
</body>
</html>`;
  }
}

function short(sha) {
  return /^[0-9a-f]{7,}$/i.test(sha) ? sha.slice(0, 7) : sha;
}

/** URI served by the gittree content provider registered in extension.js */
function gitUri(repoRoot, rev, filePath) {
  return vscode.Uri.from({
    scheme: 'gittree',
    path: '/' + filePath.replace(/\\/g, '/'),
    query: JSON.stringify({ repo: repoRoot, rev, path: filePath })
  });
}

function emptyUri(repoRoot, filePath) {
  return vscode.Uri.from({
    scheme: 'gittree',
    path: '/' + filePath.replace(/\\/g, '/'),
    query: JSON.stringify({ repo: repoRoot, empty: true })
  });
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

module.exports = { GraphPanel };
