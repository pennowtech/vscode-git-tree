'use strict';

const vscode = require('vscode');

class CommitViewProvider {
  constructor(version, getGit, runAction) {
    this.version = version;
    this.getGit = getGit;
    this.runAction = runAction;
    this.state = { rebase: false, merge: false, cherryPick: false, revert: false };
  }

  updateState(state) {
    this.state = state;
    if (this.view) {
      this.view.webview.postMessage({ type: 'conflictState', state });
    }
  }

  resolveWebviewView(view) {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = html(view.webview, this.state, this.version);
    view.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'ready') {
        view.webview.postMessage({ type: 'conflictState', state: this.state });
      } else if (message.type === 'generateMessage') {
        try {
          if (!vscode.lm) {
            vscode.window.showErrorMessage('Language Model API is not supported in this version of VS Code.');
            return;
          }
          const activeGit = this.getGit();
          if (!activeGit) {
            vscode.window.showErrorMessage('No active Git repository.');
            return;
          }

          view.webview.postMessage({ type: 'generating' });

          let diff = await activeGit.exec(['diff', '--cached']).catch(() => '');
          if (!diff.trim()) {
            diff = await activeGit.exec(['diff']).catch(() => '');
          }
          if (!diff.trim()) {
            vscode.window.showWarningMessage('No staged or unstaged changes found to generate a commit message.');
            view.webview.postMessage({ type: 'generationFailed' });
            return;
          }

          let [model] = await vscode.lm.selectChatModels({ vendor: 'copilot', family: 'gpt-4o-mini' });
          if (!model) {
            [model] = await vscode.lm.selectChatModels({ vendor: 'copilot' });
          }
          if (!model) {
            [model] = await vscode.lm.selectChatModels({});
          }
          if (!model) {
            vscode.window.showErrorMessage('No AI chat models (GitHub Copilot, Claude, etc.) are available in VS Code.');
            view.webview.postMessage({ type: 'generationFailed' });
            return;
          }

          const prompt = `Generate a concise, professional git commit message based on the following git diff. Output ONLY the commit message text. Do not wrap it in quotes, code blocks, or write any markdown formatting:\n\n${diff.slice(0, 15000)}`;

          let chatMessage;
          if (vscode.LanguageModelChatMessage.User) {
            chatMessage = vscode.LanguageModelChatMessage.User(prompt);
          } else {
            chatMessage = new vscode.LanguageModelChatMessage(vscode.LanguageModelChatMessageRole.User, prompt);
          }

          const chatResponse = await model.sendRequest([chatMessage], {}, new vscode.CancellationTokenSource().token);
          let fullText = '';
          for await (const fragment of chatResponse.text) {
            fullText += fragment;
          }

          view.webview.postMessage({ type: 'setMessage', message: fullText.trim() });
        } catch (err) {
          vscode.window.showErrorMessage('Failed to generate commit message: ' + (err.message || err));
          view.webview.postMessage({ type: 'generationFailed' });
        }
      } else if (['commit', 'amend', 'sign'].includes(message.type)) {
        const text = String(message.message || '').trim();
        if (!text && message.type !== 'amend') {
          vscode.window.showWarningMessage('Enter a commit message first.');
          return;
        }
        await this.runAction(text, message.type);
        view.webview.postMessage({ type: 'committed' });
      } else {
        await this.runAction('', message.type);
      }
    });
  }
}

function html(webview, state = { rebase: false, merge: false, cherryPick: false, revert: false }, version = '') {
  const nonce = String(Date.now());
  return `<!doctype html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
body{padding:4px 8px 6px;margin:0;color:var(--vscode-foreground);font-family:var(--vscode-font-family)}
textarea{width:100%;resize:vertical;min-height:48px;padding:6px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border,transparent);font-family:inherit;box-sizing:border-box}
.actions{display:flex;gap:4px;margin-top:4px}.actions button{border:0;border-radius:2px;padding:4px 8px;cursor:pointer;color:var(--vscode-button-secondaryForeground);background:var(--vscode-button-secondaryBackground)}
.actions button:first-child{flex:1;color:var(--vscode-button-foreground);background:var(--vscode-button-background)}
button:hover{filter:brightness(1.12)}
button:disabled{opacity:0.5;cursor:not-allowed}
#conflict-banner{padding:6px 8px;margin-bottom:6px;border-radius:2px;background:var(--vscode-button-secondaryBackground);border-left:3px solid var(--vscode-button-background);font-size:12px;line-height:1.4}
#conflict-text{font-weight:bold;margin-bottom:4px}
.version{font-size:10px;color:var(--vscode-descriptionForeground);text-align:center;margin-top:16px;opacity:0.65;font-family:var(--vscode-font-family);letter-spacing:0.5px;border-top:1px solid var(--vscode-widget-border,rgba(255,255,255,0.1));padding-top:6px}
</style></head><body>
<div id="conflict-banner" style="display:none">
  <div id="conflict-text"></div>
  <div id="conflict-buttons" class="actions"></div>
</div>
<textarea id="message" placeholder="Commit message…" aria-label="Commit message"></textarea>
<div id="normal-actions" class="actions">
  <button data-action="commit" title="Commit staged changes">Commit</button>
  <button data-action="amend" title="Amend last commit">Amend</button>
  <button data-action="sign" title="Create signed commit">Sign</button>
  <button id="btn-generate" data-action="generateMessage" title="Generate commit message using AI" style="flex:none;width:32px;padding:4px 0;display:flex;align-items:center;justify-content:center">✨</button>
</div>
${version ? `<div class="version">Version ${version}</div>` : ''}
<script nonce="${nonce}">
const vscode=acquireVsCodeApi(),box=document.getElementById('message');
box.value=(vscode.getState()||{}).message||'';
box.oninput=()=>vscode.setState({message:box.value});

const normalActions=document.getElementById('normal-actions');
const banner=document.getElementById('conflict-banner');
const text=document.getElementById('conflict-text');
const buttons=document.getElementById('conflict-buttons');

function updateUI(state) {
  if (!state) return;
  if (state.rebase) {
    banner.style.display = 'block';
    text.innerText = 'Rebase in Progress';
    buttons.innerHTML = \`
      <button data-action="rebaseContinue" style="flex:1;color:var(--vscode-button-foreground);background:var(--vscode-button-background)" title="Continue rebase">Continue</button>
      <button data-action="rebaseSkip" title="Skip current commit">Skip</button>
      <button data-action="rebaseAbort" title="Abort rebase">Abort</button>
    \`;
    box.style.display = 'none';
    normalActions.style.display = 'none';
  } else if (state.merge) {
    banner.style.display = 'block';
    text.innerText = 'Merge in Progress';
    buttons.innerHTML = \`
      <button data-action="mergeAbort" style="flex:1" title="Abort merge">Abort Merge</button>
    \`;
    box.style.display = 'block';
    normalActions.style.display = 'flex';
  } else if (state.cherryPick) {
    banner.style.display = 'block';
    text.innerText = 'Cherry-pick in Progress';
    buttons.innerHTML = \`
      <button data-action="cherryPickAbort" style="flex:1" title="Abort cherry-pick">Abort Cherry-pick</button>
    \`;
    box.style.display = 'block';
    normalActions.style.display = 'flex';
  } else if (state.revert) {
    banner.style.display = 'block';
    text.innerText = 'Revert in Progress';
    buttons.innerHTML = \`
      <button data-action="revertAbort" style="flex:1" title="Abort revert">Abort Revert</button>
    \`;
    box.style.display = 'block';
    normalActions.style.display = 'flex';
  } else {
    banner.style.display = 'none';
    box.style.display = 'block';
    normalActions.style.display = 'flex';
  }
  buttons.querySelectorAll('button').forEach(b => {
    b.onclick = () => vscode.postMessage({ type: b.dataset.action });
  });
}

document.querySelectorAll('#normal-actions button').forEach(b=>b.onclick=()=>vscode.postMessage({type:b.dataset.action,message:box.value}));

window.addEventListener('message',e=>{
  if(e.data.type==='committed'){
    box.value='';
    vscode.setState({message:''});
  } else if(e.data.type==='conflictState'){
    updateUI(e.data.state);
  } else if(e.data.type==='generating'){
    box.placeholder = 'Generating message with AI...';
    box.disabled = true;
    document.querySelectorAll('.actions button').forEach(b => b.disabled = true);
  } else if(e.data.type==='setMessage'){
    box.placeholder = 'Commit message…';
    box.disabled = false;
    box.value = e.data.message;
    vscode.setState({message:box.value});
    document.querySelectorAll('.actions button').forEach(b => b.disabled = false);
  } else if(e.data.type==='generationFailed'){
    box.placeholder = 'Commit message…';
    box.disabled = false;
    document.querySelectorAll('.actions button').forEach(b => b.disabled = false);
  }
});

updateUI(${JSON.stringify(state)});
vscode.postMessage({ type: 'ready' });
</script></body></html>`;
}

module.exports = { CommitViewProvider };
