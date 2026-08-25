// Manages the "Interactive Rebase" webview panel.
'use strict';

const vscode = require('vscode');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

class RebasePanel {
  static current = undefined;

  /**
   * @param {import('./git').Git} git
   * @param {string} [ref] optional ref when starting a new rebase
   */
  static show(git, ref = '') {
    const column = vscode.ViewColumn.One;
    if (RebasePanel.current) {
      RebasePanel.current.git = git;
      if (ref) {
        RebasePanel.current.startRebase(ref);
      } else {
        RebasePanel.current.refresh();
      }
      RebasePanel.current.panel.reveal(column);
      return RebasePanel.current;
    }
    const extension = vscode.extensions.getExtension('pennowtech.git-tree');
    const extensionPath = extension.extensionPath;
    const panel = vscode.window.createWebviewPanel('gitTree.rebase', 'GitTree Rebase', column, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(extensionPath, 'media'))]
    });
    RebasePanel.current = new RebasePanel(panel, git, extensionPath);
    if (ref) {
      RebasePanel.current.startRebase(ref);
    }
    return RebasePanel.current;
  }

  constructor(panel, git, extensionPath) {
    this.panel = panel;
    this.git = git;
    this.extensionPath = extensionPath;
    this.disposables = [];

    panel.iconPath = vscode.Uri.file(path.join(extensionPath, 'resources', 'gittree.svg'));
    panel.webview.html = this.getHtml();
    panel.onDidDispose(() => this.dispose(), null, this.disposables);
    panel.webview.onDidReceiveMessage((msg) => this.onMessage(msg), null, this.disposables);

    // Watch for file status changes to auto-refresh conflict details
    const fileWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.git.root, '**/*'));
    fileWatcher.onDidChange(() => this.refreshConflicts(), null, this.disposables);
    fileWatcher.onDidCreate(() => this.refreshConflicts(), null, this.disposables);
    fileWatcher.onDidDelete(() => this.refreshConflicts(), null, this.disposables);
    this.disposables.push(fileWatcher);
  }

  dispose() {
    if (RebasePanel.current === this) {
      RebasePanel.current = undefined;
    }
    if (this.panel) {
      const p = this.panel;
      this.panel = undefined;
      p.dispose();
    }
    this.disposables.forEach((d) => d.dispose());
  }

  post(msg) {
    this.panel.webview.postMessage(msg);
  }

  async startRebase(ref) {
    // Run the rebase in the background
    vscode.window.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: `Rebasing current branch onto ${ref}`,
      cancellable: false
    }, async () => {
      try {
        await this.git.startInteractiveRebase(ref);
        vscode.window.showInformationMessage('Rebase completed successfully.');
        this.dispose();
        await vscode.commands.executeCommand('gitTree.refresh');
      } catch (err) {
        // If rebase paused due to conflicts, we keep the webview open
        const conflict = await this.git.isRebaseInProgress();
        if (conflict) {
          vscode.window.showWarningMessage('Rebase paused due to conflicts. Please resolve conflicts to continue.');
          this.refresh();
        } else {
          vscode.window.showErrorMessage(`Rebase failed: ${err.message || err}`);
          this.dispose();
          await vscode.commands.executeCommand('gitTree.refresh');
        }
      }
    });

    // Wait and check if the git-rebase-todo.json is written, then reload panel
    let checkCount = 0;
    const checkFile = setInterval(async () => {
      checkCount++;
      const jsonPath = await this.getTodoJsonPath();
      if (jsonPath && fs.existsSync(jsonPath)) {
        clearInterval(checkFile);
        this.refresh();
      }
      if (checkCount > 100) {
        clearInterval(checkFile);
      }
    }, 100);
  }

  async getTodoJsonPath() {
    try {
      const gitDir = (await this.git.exec(['rev-parse', '--git-dir'])).trim();
      const absGitDir = path.isAbsolute(gitDir) ? gitDir : path.resolve(this.git.root, gitDir);
      return path.join(absGitDir, 'rebase-merge', 'git-rebase-todo.json');
    } catch (e) {
      return null;
    }
  }

  async refresh() {
    const jsonPath = await this.getTodoJsonPath();
    const isPaused = await this.git.isRebaseInProgress();

    if (jsonPath && fs.existsSync(jsonPath)) {
      try {
        const state = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
        this.post({
          type: 'init',
          commits: state.todo,
          interactive: true,
          branch: await this.getCurrentBranch(),
          onto: 'HEAD'
        });
      } catch (e) {
        vscode.window.showErrorMessage('Failed to read interactive rebase configuration.');
      }
    } else if (isPaused) {
      const state = await this.git.getRebaseState();
      const conflicts = await this.git.getConflictedFiles();
      if (state) {
        this.post({
          type: 'init',
          commits: state.commits,
          branch: state.branch,
          onto: state.onto,
          ontoSubject: state.ontoSubject,
          conflictedFiles: conflicts,
          paused: true,
          interactive: false
        });
      }
    } else {
      // Rebase is not active, close the panel
      this.dispose();
    }
  }

  async getCurrentBranch() {
    const head = await this.git.getHead().catch(() => ({}));
    return head.branch || 'HEAD';
  }

  async refreshConflicts() {
    const isPaused = await this.git.isRebaseInProgress();
    if (isPaused) {
      const conflicts = await this.git.getConflictedFiles();
      this.post({
        type: 'conflicts',
        conflictedFiles: conflicts
      });
    }
  }

  async onMessage(msg) {
    switch (msg.type) {
      case 'ready':
        await this.refresh();
        break;

      case 'apply': {
        const jsonPath = await this.getTodoJsonPath();
        if (jsonPath && fs.existsSync(jsonPath)) {
          try {
            const state = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            state.todo = msg.commits;
            state.status = 'apply';
            fs.writeFileSync(jsonPath, JSON.stringify(state), 'utf8');
          } catch (e) {
            vscode.window.showErrorMessage('Failed to apply rebase actions.');
          }
        }
        break;
      }

      case 'abort': {
        const jsonPath = await this.getTodoJsonPath();
        if (jsonPath && fs.existsSync(jsonPath)) {
          try {
            const state = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
            state.status = 'abort';
            fs.writeFileSync(jsonPath, JSON.stringify(state), 'utf8');
            this.dispose();
            await vscode.commands.executeCommand('gitTree.refresh');
          } catch (e) {}
        } else {
          // If paused due to conflicts
          vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: 'Aborting rebase...',
            cancellable: false
          }, async () => {
            try {
              await this.git.rebaseAbort();
            } catch (err) {
              vscode.window.showErrorMessage(`Failed to abort rebase: ${err.message || err}`);
            } finally {
              this.dispose();
              await vscode.commands.executeCommand('gitTree.refresh');
            }
          });
        }
        break;
      }

      case 'continue': {
        vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: 'Continuing rebase...',
          cancellable: false
        }, async () => {
          try {
            await this.git.rebaseContinue();
            vscode.window.showInformationMessage('Rebase completed successfully.');
            this.dispose();
            // Refresh views
            await vscode.commands.executeCommand('gitTree.refresh');
          } catch (err) {
            const conflict = await this.git.isRebaseInProgress();
            if (conflict) {
              vscode.window.showWarningMessage('Rebase paused due to further conflicts.');
              this.refresh();
            } else {
              vscode.window.showErrorMessage(`Rebase failed: ${err.message || err}`);
              this.dispose();
            }
          }
        });
        break;
      }

      case 'skip': {
        vscode.window.withProgress({
          location: vscode.ProgressLocation.Notification,
          title: 'Skipping commit...',
          cancellable: false
        }, async () => {
          try {
            await this.git.rebaseSkip();
            vscode.window.showInformationMessage('Rebase completed successfully.');
            this.dispose();
            await vscode.commands.executeCommand('gitTree.refresh');
          } catch (err) {
            const conflict = await this.git.isRebaseInProgress();
            if (conflict) {
              vscode.window.showWarningMessage('Rebase paused due to conflicts.');
              this.refresh();
            } else {
              vscode.window.showErrorMessage(`Rebase failed: ${err.message || err}`);
              this.dispose();
            }
          }
        });
        break;
      }

      case 'stageFile': {
        let hasConflicts = false;
        try {
          const fs = require('fs');
          const absPath = path.resolve(this.git.root, msg.path);
          if (fs.existsSync(absPath)) {
            const content = fs.readFileSync(absPath, 'utf8');
            if (content.includes('<<<<<<< ')) {
              hasConflicts = true;
            }
          }
        } catch (e) {}

        if (hasConflicts) {
          const choice = await vscode.window.showWarningMessage(
            `The file '${msg.path}' still contains unresolved conflict markers. Are you sure you want to stage it?`,
            { modal: true },
            'Stage Anyway'
          );
          if (choice !== 'Stage Anyway') {
            break;
          }
        }
        await this.git.stage(msg.path);
        await this.refreshConflicts();
        break;
      }

      case 'unstageFile':
        await this.git.unstage(msg.path);
        await this.refreshConflicts();
        break;

      case 'openDiff': {
        const uri = vscode.Uri.file(path.join(this.git.root, msg.path));
        await vscode.window.showTextDocument(uri);
        break;
      }
    }
  }

  getHtml() {
    const webview = this.panel.webview;
    const mediaUri = (f) =>
      webview.asWebviewUri(vscode.Uri.file(path.join(this.extensionPath, 'media', f)));
    const nonce = crypto.randomBytes(16).toString('hex');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data:;">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${mediaUri('rebase.css')}" rel="stylesheet">
<title>GitTree Rebase</title>
</head>
<body>
  <div id="app">
    <div class="header">
      <div class="title-row">
        <span class="icon">⚡</span>
        <h1>Interactive Git Rebase</h1>
        <span class="branch-badge" id="branchBadge">...</span>
        <span class="onto-info" id="ontoInfo">...</span>
      </div>
      <div id="statusBanner" class="banner danger" style="display:none">
        <span class="banner-icon">⚠️</span>
        <span class="banner-text" id="bannerText">Rebase paused due to conflicts</span>
      </div>
    </div>

    <div class="content-area">
      <!-- Conflicted Files View -->
      <div id="conflictsSection" class="conflicts-section" style="display:none">
        <div class="section-header">
          <span id="conflictCount">0 conflicted files</span>
        </div>
        <div class="search-bar">
          <input type="text" id="conflictSearch" placeholder="Filter conflicted files...">
        </div>
        <div class="file-list" id="conflictList"></div>
      </div>
      <div id="rebaseSplitter" class="rebase-splitter" style="display:none" title="Drag to resize"></div>

      <!-- Commits List View -->
      <div class="commits-section">
        <div class="commits-list" id="commitsList">
          <div class="loading">Loading commits...</div>
        </div>
      </div>
    </div>

    <div class="footer">
      <div class="shortcuts-legend">
        <span class="shortcut"><b>P</b> pick</span>
        <span class="shortcut"><b>R</b> reword</span>
        <span class="shortcut"><b>E</b> edit</span>
        <span class="shortcut"><b>S</b> squash</span>
        <span class="shortcut"><b>F</b> fixup</span>
        <span class="shortcut"><b>D</b> drop</span>
        <span class="shortcut"><b>Alt + ↑/↓</b> move</span>
      </div>
      <div class="actions-row">
        <button id="btnAbort" class="btn secondary">Abort</button>
        <button id="btnSkip" class="btn secondary" style="display:none">Skip</button>
        <button id="btnAction" class="btn primary">Start Rebase</button>
      </div>
    </div>
  </div>
  <script nonce="${nonce}" src="${mediaUri('rebase.js')}"></script>
</body>
</html>`;
  }
}

module.exports = { RebasePanel };
