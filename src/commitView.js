'use strict';

const vscode = require('vscode');

class CommitViewProvider {
  constructor(runAction) {
    this.runAction = runAction;
  }

  resolveWebviewView(view) {
    view.webview.options = { enableScripts: true };
    view.webview.html = html(view.webview);
    view.webview.onDidReceiveMessage(async (message) => {
      if (!['commit', 'amend', 'sign'].includes(message.type)) return;
      const text = String(message.message || '').trim();
      if (!text && message.type !== 'amend') {
        vscode.window.showWarningMessage('Enter a commit message first.');
        return;
      }
      await this.runAction(text, message.type);
      view.webview.postMessage({ type: 'committed' });
    });
  }
}

function html(webview) {
  const nonce = String(Date.now());
  return `<!doctype html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
body{padding:4px 8px 6px;margin:0;color:var(--vscode-foreground);font-family:var(--vscode-font-family)}
textarea{width:100%;resize:vertical;min-height:48px;padding:6px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);font-family:inherit;box-sizing:border-box}
.actions{display:flex;gap:4px;margin-top:4px}.actions button{border:0;border-radius:2px;padding:4px 8px;cursor:pointer;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
.actions button:first-child{flex:1;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
button:hover{filter:brightness(1.12)}
</style></head><body><textarea id="message" placeholder="Commit message…" aria-label="Commit message"></textarea>
<div class="actions"><button data-action="commit" title="Commit staged changes">Commit</button><button data-action="amend" title="Amend last commit">Amend</button><button data-action="sign" title="Create signed commit">Sign</button></div>
<script nonce="${nonce}">const vscode=acquireVsCodeApi(),box=document.getElementById('message');box.value=(vscode.getState()||{}).message||'';box.oninput=()=>vscode.setState({message:box.value});document.querySelectorAll('button').forEach(b=>b.onclick=()=>vscode.postMessage({type:b.dataset.action,message:box.value}));window.addEventListener('message',e=>{if(e.data.type==='committed'){box.value='';vscode.setState({message:''})}});</script></body></html>`;
}

module.exports = { CommitViewProvider };
