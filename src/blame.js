// GitLens-style inline blame annotation for the current line.
'use strict';

const vscode = require('vscode');
const path = require('path');

const decorationType = vscode.window.createTextEditorDecorationType({
  after: {
    color: new vscode.ThemeColor('editorCodeLens.foreground'),
    margin: '0 0 0 3em',
    fontStyle: 'italic'
  }
});
const heatmapTypes = [0, 1, 2, 3, 4].map((i) => vscode.window.createTextEditorDecorationType({
  isWholeLine: true,
  backgroundColor: new vscode.ThemeColor(`gitTree.blameHeat${i}`),
  overviewRulerColor: new vscode.ThemeColor(`gitTree.blameHeat${i}`),
  overviewRulerLane: vscode.OverviewRulerLane.Left
}));

function timeAgo(ms) {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  const units = [
    [31536000, 'year'],
    [2592000, 'month'],
    [604800, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute']
  ];
  for (const [secs, label] of units) {
    if (s >= secs) {
      const n = Math.floor(s / secs);
      return `${n} ${label}${n > 1 ? 's' : ''} ago`;
    }
  }
  return 'just now';
}

class BlameController {
  /** @param {() => import('./git').Git | undefined} getGit */
  constructor(getGit) {
    this.getGit = getGit;
    this.enabled = vscode.workspace.getConfiguration('gitTree').get('blame.enabled', true);
    this.timer = undefined;
    this.heatmapEnabled = false;
    this.disposables = [
      vscode.window.onDidChangeTextEditorSelection((e) => this.schedule(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor((editor) => editor && this.schedule(editor)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gitTree.blame.enabled')) {
          this.enabled = vscode.workspace.getConfiguration('gitTree').get('blame.enabled', true);
          if (!this.enabled) this.clear();
        }
      })
    ];
  }

  async toggleHeatmap() {
    this.heatmapEnabled = !this.heatmapEnabled;
    if (!this.heatmapEnabled) {
      for (const editor of vscode.window.visibleTextEditors) for (const type of heatmapTypes) editor.setDecorations(type, []);
    } else if (vscode.window.activeTextEditor) {
      await this.renderHeatmap(vscode.window.activeTextEditor);
    }
    vscode.window.setStatusBarMessage(`Blame heatmap ${this.heatmapEnabled ? 'on' : 'off'}`, 3000);
  }

  async renderHeatmap(editor) {
    const git = this.getGit();
    if (!git || editor.document.uri.scheme !== 'file' || editor.document.isDirty) return;
    const rel = path.relative(git.root, editor.document.uri.fsPath);
    if (rel.startsWith('..')) return;
    const out = await git.exec(['blame', '--line-porcelain', '--', rel]).catch(() => '');
    const times = [...out.matchAll(/^author-time (\d+)$/gm)].map((m) => Number(m[1]) * 1000);
    const now = Date.now();
    const buckets = heatmapTypes.map(() => []);
    times.forEach((time, line) => {
      const days = (now - time) / 86400000;
      const bucket = days < 7 ? 4 : days < 30 ? 3 : days < 180 ? 2 : days < 365 ? 1 : 0;
      if (line < editor.document.lineCount) buckets[bucket].push(editor.document.lineAt(line).range);
    });
    buckets.forEach((ranges, i) => editor.setDecorations(heatmapTypes[i], ranges));
  }

  toggle() {
    this.enabled = !this.enabled;
    if (!this.enabled) this.clear();
    else if (vscode.window.activeTextEditor) this.schedule(vscode.window.activeTextEditor);
    vscode.window.setStatusBarMessage(`Inline blame ${this.enabled ? 'on' : 'off'}`, 3000);
  }

  clear() {
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(decorationType, []);
    }
  }

  schedule(editor) {
    if (!this.enabled || !editor || editor.document.uri.scheme !== 'file') return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.annotate(editor), 250);
  }

  async annotate(editor) {
    const git = this.getGit();
    if (!git || !this.enabled) return;
    const doc = editor.document;
    if (doc.isDirty) {
      editor.setDecorations(decorationType, []);
      return;
    }
    const rel = path.relative(git.root, doc.uri.fsPath);
    if (rel.startsWith('..')) return;
    const line = editor.selection.active.line;
    try {
      const blame = await git.blameLine(rel, line + 1);
      if (editor !== vscode.window.activeTextEditor || editor.selection.active.line !== line) return;
      const text = blame.uncommitted
        ? 'You · uncommitted changes'
        : `${blame.author}, ${timeAgo(blame.time)} · ${blame.summary} · ${blame.sha.slice(0, 7)}`;
      const range = doc.lineAt(line).range;
      editor.setDecorations(decorationType, [
        { range, renderOptions: { after: { contentText: `  ${text}` } } }
      ]);
      if (this.heatmapEnabled) await this.renderHeatmap(editor);
    } catch (e) {
      editor.setDecorations(decorationType, []); // file not tracked, etc.
    }
  }

  dispose() {
    clearTimeout(this.timer);
    this.disposables.forEach((d) => d.dispose());
    decorationType.dispose();
    heatmapTypes.forEach((type) => type.dispose());
  }
}

module.exports = { BlameController };
