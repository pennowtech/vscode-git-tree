'use strict';

const vscode = require('vscode');
const childProcess = require('child_process');
const util = require('util');

const execFile = util.promisify(childProcess.execFile);
const PR_DIFF_SCHEME = 'gittree-pr';
const prDiffDocuments = new Map();
let prDiffProviderRegistered = false;

class PullRequestPanel {
  static current;

  static show(context, pullRequest, tokens = {}) {
    ensurePrDiffProvider(context);
    let currentDetails = pullRequest;
    const panel = vscode.window.createWebviewPanel(
      'gitTree.pullRequest',
      pullRequest.number ? `PR #${pullRequest.number}` : 'Pull Requests',
      vscode.ViewColumn.One,
      { enableScripts: true }
    );
    panel.webview.html = shell(panel.webview, pullRequest);
    panel.webview.onDidReceiveMessage(async (message) => {
      if (message.type === 'open' && pullRequest.url) {
        vscode.env.openExternal(vscode.Uri.parse(pullRequest.url));
      }
      if (message.type === 'openFile' && message.path) {
        await openPrFileDiff(message.path, currentDetails);
      }
      if (message.type === 'ready') {
        const details = await loadDetails(pullRequest, tokens).catch((error) => ({
          ...pullRequest,
          loadError: error.message || String(error),
          files: [],
          comments: [],
          tasks: extractTasks(pullRequest)
        }));
        currentDetails = details;
        panel.webview.postMessage({ type: 'details', details });
      }
    });
    PullRequestPanel.current = panel;
    return panel;
  }

  static showList(context, git, url) {
    return PullRequestPanel.show(context, {
      title: 'Pull Requests',
      author: git.name,
      source: 'repository',
      target: 'remote',
      url,
      body: 'Open the pull request list for this repository.',
      commentsActive: null,
      commentsTotal: null
    });
  }
}

function ensurePrDiffProvider(context) {
  if (prDiffProviderRegistered) return;
  context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider(PR_DIFF_SCHEME, {
    provideTextDocumentContent(uri) {
      return prDiffDocuments.get(uri.query) || '';
    }
  }));
  prDiffProviderRegistered = true;
}

async function openPrFileDiff(filePath, pr) {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  if (!root) {
    vscode.window.showWarningMessage('Open a workspace folder to preview PR file diffs.');
    return;
  }
  const relativePath = String(filePath || '').replace(/^[/\\]+/, '');
  const file = (pr.files || []).find((entry) => entry.path === relativePath) || {};
  const targetContent = await gitShowAny(root.fsPath, refCandidates(pr.target, 'target'), relativePath);
  const sourceContent = await gitShowAny(root.fsPath, refCandidates(pr.source, 'source'), relativePath)
    ?? await localFileContent(root, relativePath);
  const leftContent = targetContent ?? '';
  const rightContent = sourceContent ?? '';
  if (targetContent == null && sourceContent == null) {
    vscode.window.showWarningMessage(`Unable to build a diff for ${relativePath}. The file was not found locally or in the available Git refs.`);
    return;
  }
  const leftLabel = pr.target || 'base';
  const rightLabel = pr.source || 'source';
  const left = virtualDiffUri(relativePath, `${leftLabel}`, leftContent);
  const right = virtualDiffUri(relativePath, `${rightLabel}`, rightContent);
  const status = file.status ? ` · ${file.status}` : '';
  await vscode.commands.executeCommand('vscode.diff', left, right, `${relativePath} (${leftLabel} ↔ ${rightLabel}${status})`, {
    viewColumn: vscode.ViewColumn.Beside,
    preview: true
  });
}

function refCandidates(ref, side) {
  const clean = String(ref || '').replace(/^refs\/heads\//, '').replace(/^origin\//, '');
  const candidates = [];
  if (clean) candidates.push(clean, `origin/${clean}`, `remotes/origin/${clean}`);
  if (side === 'source') candidates.push('HEAD');
  return [...new Set(candidates.filter(Boolean))];
}

async function gitShowAny(cwd, refs, filePath) {
  for (const ref of refs) {
    const content = await gitShow(cwd, ref, filePath).catch(() => null);
    if (content != null) return content;
  }
  return null;
}

async function gitShow(cwd, ref, filePath) {
  const { stdout } = await execFile('git', ['show', `${ref}:${filePath}`], {
    cwd,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true
  });
  return stdout;
}

async function localFileContent(root, filePath) {
  const uri = vscode.Uri.joinPath(root, ...filePath.split(/[\\/]+/).filter(Boolean));
  try {
    const data = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(data).toString('utf8');
  } catch {
    return null;
  }
}

function virtualDiffUri(filePath, label, content) {
  const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  prDiffDocuments.set(key, content);
  return vscode.Uri.from({
    scheme: PR_DIFF_SCHEME,
    authority: 'pr',
    path: `/${filePath}`,
    query: key,
    fragment: label
  });
}

async function loadDetails(pr, tokens) {
  if (pr.provider === 'github' && pr.owner && pr.repo && pr.number) return githubDetails(pr);
  if (pr.provider === 'gitlab' && pr.project && pr.number) return gitlabDetails(pr, tokens.getGitLabToken ? await tokens.getGitLabToken() : undefined);
  if (pr.provider === 'azure' && pr.baseUrl && pr.project && pr.repo && pr.number) return azureDetails(pr, tokens.getAzureDevOpsToken ? await tokens.getAzureDevOpsToken() : undefined);
  return { ...pr, files: [], comments: [], tasks: extractTasks(pr) };
}

async function githubDetails(pr) {
  const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: false });
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'GitTree-VSCode' };
  if (session) headers.Authorization = `Bearer ${session.accessToken}`;
  const base = `https://api.github.com/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/pulls/${pr.number}`;
  const optionalErrors = [];
  const optional = async (url, fallback) => json(url, headers).catch((error) => {
    optionalErrors.push(error.message || String(error));
    return fallback;
  });
  const [detail, files, issueComments, reviewComments, reviews] = await Promise.all([
    json(`${base}`, headers),
    json(`${base}/files?per_page=100`, headers),
    optional(`https://api.github.com/repos/${encodeURIComponent(pr.owner)}/${encodeURIComponent(pr.repo)}/issues/${pr.number}/comments?per_page=100`, []),
    optional(`${base}/comments?per_page=100`, []),
    optional(`${base}/reviews?per_page=100`, [])
  ]);
  const comments = [
    ...issueComments.map((c) => comment('Conversation', c.user?.login, c.body, c.html_url, null, null, c.created_at, null, { threadId: `conversation-${c.id}` })),
    ...reviews.filter((r) => r.body).map((r) => comment(`Review ${r.state || ''}`.trim(), r.user?.login, r.body, r.html_url, null, null, r.submitted_at, null, { threadId: `review-${r.id}` })),
    ...reviewComments.map((c) => comment('Code comment', c.user?.login, c.body, c.html_url, c.path, c.line || c.original_line, c.created_at, compactDiffHunk(c.diff_hunk, c.line || c.original_line), {
      threadId: `code-${c.in_reply_to_id || c.id}`,
      replyTo: c.in_reply_to_id,
      isReply: Boolean(c.in_reply_to_id)
    }))
  ];
  return {
    ...pr,
    body: detail.body || pr.body || '',
    state: detail.state || pr.state,
    files: files.map((f) => ({ path: f.filename, status: f.status, additions: f.additions, deletions: f.deletions, changes: f.changes })),
    comments,
    commentsActive: comments.length,
    commentsTotal: comments.length,
    commentsWarning: optionalErrors.length ? `Some GitHub comments could not be loaded. ${optionalErrors[0]}` : '',
    tasks: extractTasks({ ...pr, body: [detail.body, ...comments.map((c) => c.body)].filter(Boolean).join('\n') })
  };
}

async function gitlabDetails(pr, token) {
  const headers = token ? { 'PRIVATE-TOKEN': token } : {};
  const project = encodeURIComponent(pr.project);
  const base = `https://gitlab.com/api/v4/projects/${project}/merge_requests/${pr.number}`;
  const [detail, changes, notes, discussions] = await Promise.all([
    json(base, headers),
    json(`${base}/changes`, headers),
    json(`${base}/notes?per_page=100`, headers),
    json(`${base}/discussions?per_page=100`, headers)
  ]);
  const discussionComments = discussions.flatMap((d) => (d.notes || []).map((n, index) => {
    const pos = n.position || {};
    return comment('Code discussion', n.author?.username, n.body, n.web_url, pos.new_path || pos.old_path, pos.new_line || pos.old_line, n.created_at, null, {
      threadId: `discussion-${d.id}`,
      isReply: index > 0,
      replyTo: index > 0 ? d.notes?.[0]?.id : null,
      resolved: d.resolved
    });
  }));
  const comments = [
    ...notes.filter((n) => !n.system).map((n) => comment('Conversation', n.author?.username, n.body, n.web_url, null, null, n.created_at, null, { threadId: `note-${n.id}` })),
    ...discussionComments
  ];
  return {
    ...pr,
    body: detail.description || pr.body || '',
    state: detail.state || pr.state,
    files: (changes.changes || []).map((f) => ({ path: f.new_path || f.old_path, status: f.deleted_file ? 'deleted' : f.new_file ? 'added' : f.renamed_file ? 'renamed' : 'modified', additions: null, deletions: null, changes: null })),
    comments,
    commentsActive: comments.length,
    commentsTotal: comments.length,
    tasks: extractTasks({ ...pr, body: [detail.description, ...comments.map((c) => c.body)].filter(Boolean).join('\n') })
  };
}

async function azureDetails(pr, token) {
  if (!token) throw new Error('Azure DevOps token is not set. Run "Set Azure DevOps Token Securely..." first.');
  const headers = azureHeaders(token);
  const repo = encodeURIComponent(pr.repo);
  const project = encodeURIComponent(pr.project);
  const base = `${pr.baseUrl}/${project}/_apis/git/repositories/${repo}/pullRequests/${pr.number}`;
  const [detail, iterations, threads, workItemRefs] = await Promise.all([
    json(`${base}?api-version=7.1`, headers),
    json(`${base}/iterations?api-version=7.1`, headers),
    json(`${base}/threads?api-version=7.1`, headers),
    json(`${base}/workitems?api-version=7.1`, headers).catch(() => ({ value: [] }))
  ]);
  const changes = await azurePullRequestChanges(base, headers, iterations.value || []);
  const workItems = await azureWorkItems(pr, token, workItemRefs.value || []);
  let comments = (threads.value || []).flatMap((thread) => {
    const ctx = thread.threadContext || {};
    const file = ctx.filePath || ctx.rightFileStart?.path || ctx.leftFileStart?.path || '';
    const line = ctx.rightFileStart?.line || ctx.leftFileStart?.line || ctx.line;
    const status = thread.status ? ` (${thread.status})` : '';
    const rootCommentId = (thread.comments || [])[0]?.id;
    return (thread.comments || []).map((c, index) =>
      comment(`Code thread${status}`, c.author?.displayName || c.author?.uniqueName, c.content, null, file, line, c.publishedDate, null, {
        threadId: azureThreadId(thread, c, rootCommentId, file, line),
        commentId: c.id,
        isReply: index > 0 || Boolean(c.parentCommentId),
        replyTo: c.parentCommentId || (index > 0 ? rootCommentId : null),
        status: thread.status
      })
    );
  });
  comments = await attachAzureCodeSnippets(pr, detail, headers, comments);
  return {
    ...pr,
    body: detail.description || pr.body || '',
    state: detail.status || pr.state,
    author: detail.createdBy?.displayName || pr.author,
    files: azureChangeEntries(changes).map((entry) => ({
      path: entry.item?.path || entry.changeTrackingId || '(unknown)',
      status: entry.changeType || 'modified',
      additions: null,
      deletions: null,
      changes: null
    })),
    comments,
    commentsActive: comments.filter((c) => !/\(closed\)|\(fixed\)/i.test(c.type)).length,
    commentsTotal: comments.length,
    tasks: mergeTasks(extractTasks({ ...pr, body: [detail.description, ...comments.map((c) => c.body)].filter(Boolean).join('\n') }), workItems)
  };
}

async function azurePullRequestChanges(base, headers, iterations) {
  const sorted = [...iterations].sort((a, b) => (b.id || 0) - (a.id || 0));
  for (const iteration of sorted) {
    const changes = await json(`${base}/iterations/${iteration.id}/changes?api-version=7.1`, headers).catch(() => null);
    if (azureChangeEntries(changes).length) return changes;
  }
  return { changeEntries: [] };
}

function azureChangeEntries(changes) {
  return changes?.changeEntries || changes?.changes || changes?.value || [];
}

async function azureWorkItems(pr, token, refs) {
  if (!refs.length) return [];
  const headers = azureHeaders(token);
  const ids = refs.map((ref) => String(ref.id || '').trim()).filter(Boolean);
  if (!ids.length) return [];
  const url = `${pr.baseUrl}/${encodeURIComponent(pr.project)}/_apis/wit/workitems?ids=${ids.join(',')}&api-version=7.1`;
  const data = await json(url, headers).catch(() => ({ value: [] }));
  return (data.value || []).map((item) => ({
    id: String(item.id),
    type: item.fields?.['System.WorkItemType'] || 'Work Item',
    title: item.fields?.['System.Title'] || '',
    state: item.fields?.['System.State'] || '',
    url: `${pr.baseUrl}/${encodeURIComponent(pr.project)}/_workitems/edit/${item.id}`
  }));
}

function azureThreadId(thread, commentInfo, rootCommentId, file, line) {
  const threadId = thread.id || thread.threadId;
  if (threadId != null) return `azure-thread-${threadId}`;
  const parentId = commentInfo.parentCommentId || rootCommentId;
  if (parentId != null) return `azure-comment-${parentId}`;
  return `azure-location-${file || 'conversation'}-${line || 'root'}`;
}

async function attachAzureCodeSnippets(pr, detail, headers, comments) {
  const sourceCommit = detail.lastMergeSourceCommit?.commitId || detail.lastMergeCommit?.commitId || '';
  const sourceBranch = (detail.sourceRefName || '').replace(/^refs\/heads\//, '');
  const version = sourceCommit || sourceBranch;
  if (!version) return comments;
  const versionType = sourceCommit ? 'commit' : 'branch';
  const files = [...new Set(comments.map((c) => c.file).filter(Boolean))].slice(0, 25);
  const snippets = new Map();
  await Promise.all(files.map(async (file) => {
    const content = await azureFileContent(pr, headers, file, version, versionType).catch(() => '');
    if (content) snippets.set(file, content);
  }));
  const firstByThread = new Set();
  return comments.map((c) => {
    if (c.isReply || firstByThread.has(c.threadId)) return c;
    firstByThread.add(c.threadId);
    const content = snippets.get(c.file);
    if (!content || !c.line) return c;
    return { ...c, snippet: codeSnippet(content, Number(c.line), 3) };
  });
}

async function azureFileContent(pr, headers, file, version, versionType) {
  const url = `${pr.baseUrl}/${encodeURIComponent(pr.project)}/_apis/git/repositories/${encodeURIComponent(pr.repo)}/items?path=${encodeURIComponent(file)}&includeContent=true&versionDescriptor.version=${encodeURIComponent(version)}&versionDescriptor.versionType=${encodeURIComponent(versionType)}&api-version=7.1`;
  const data = await json(url, headers);
  return typeof data.content === 'string' ? data.content : '';
}

function codeSnippet(content, line, context) {
  if (!Number.isFinite(line) || line < 1) return '';
  const lines = String(content).replace(/\r\n/g, '\n').split('\n');
  const start = Math.max(1, line - context);
  const end = Math.min(lines.length, line + context);
  const width = String(end).length;
  const snippet = [];
  for (let current = start; current <= end; current += 1) {
    const marker = current === line ? '>' : ' ';
    snippet.push(`${marker} ${String(current).padStart(width, ' ')} | ${lines[current - 1] ?? ''}`);
  }
  return snippet.join('\n');
}

function compactDiffHunk(hunk, targetLine, context = 4) {
  if (!hunk) return '';
  const lines = String(hunk).replace(/\r\n/g, '\n').split('\n');
  if (lines.length <= context * 2 + 3) return hunk;
  const parsed = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of lines) {
    const header = line.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      parsed.push({ text: line, header: true });
      continue;
    }
    const current = { text: line, oldLine: null, newLine: null };
    if (line.startsWith('+')) {
      current.newLine = newLine;
      newLine += 1;
    } else if (line.startsWith('-')) {
      current.oldLine = oldLine;
      oldLine += 1;
    } else {
      current.oldLine = oldLine;
      current.newLine = newLine;
      oldLine += 1;
      newLine += 1;
    }
    parsed.push(current);
  }
  const target = Number(targetLine);
  let index = Number.isFinite(target)
    ? parsed.findIndex((entry) => entry.newLine === target || entry.oldLine === target)
    : -1;
  if (index < 0) index = Math.max(0, parsed.length - context - 1);
  const start = Math.max(0, index - context);
  const end = Math.min(parsed.length, index + context + 1);
  const visible = parsed.slice(start, end).map((entry) => entry.text);
  if (start > 0) visible.unshift('…');
  if (end < parsed.length) visible.push('…');
  return visible.join('\n');
}

async function json(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

function azureHeaders(token) {
  return {
    Accept: 'application/json',
    Authorization: `Basic ${Buffer.from(`:${token}`).toString('base64')}`
  };
}

function comment(type, author, body, url, file, line, createdAt, diff, extra = {}) {
  return { type, author: author || 'unknown', body: body || '', url, file, line, createdAt, diff, ...extra };
}

function extractTasks(pr) {
  const text = `${pr.title || ''}\n${pr.body || ''}`;
  const taskIds = new Set();
  const patterns = [
    /(?:fix(?:es)?|close(?:s)?|resolve(?:s)?)\s+#(\d+)/gi,
    /\b(?:AB#|ADO#|AZ#)(\d+)\b/gi,
    /\b[A-Z][A-Z0-9]+-\d+\b/g
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) taskIds.add(match[1] ? `#${match[1]}` : match[0]);
  }
  const checkboxMatches = [...text.matchAll(/^\s*[-*]\s+\[( |x|X)\]\s+(.+)$/gm)].map((m) => ({
    done: m[1].toLowerCase() === 'x',
    text: m[2]
  }));
  return { ids: [...taskIds], checklist: checkboxMatches };
}

function mergeTasks(tasks, workItems) {
  return { ...tasks, workItems };
}

function shell(webview, pr) {
  const nonce = String(Date.now());
  return `<!doctype html><html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'">
<style>
body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font-family:var(--vscode-font-family);line-height:1.45}.shell{max-width:1080px;padding:18px 22px}.eyebrow{color:var(--vscode-descriptionForeground);font-size:12px;text-transform:uppercase;letter-spacing:.06em}
h1{font-size:22px;line-height:1.25;margin:4px 0 10px}.meta{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px;color:var(--vscode-descriptionForeground)}.pill{border:1px solid var(--vscode-panel-border);border-radius:999px;padding:2px 9px;background:var(--vscode-editorWidget-background)}
button{border:0;border-radius:3px;padding:6px 12px;cursor:pointer;color:var(--vscode-button-foreground);background:var(--vscode-button-background);font-family:inherit}button:hover{background:var(--vscode-button-hoverBackground)}
.tabs{display:flex;gap:4px;margin:16px 0 8px;border-bottom:1px solid var(--vscode-panel-border)}.tab{border:0;border-radius:4px 4px 0 0;padding:7px 12px;color:var(--vscode-descriptionForeground);background:transparent}.tab:hover{background:var(--vscode-list-hoverBackground)}.tab.active{color:var(--vscode-foreground);background:var(--vscode-editorWidget-background);box-shadow:inset 0 -2px 0 var(--vscode-textLink-foreground)}
.section{margin-top:18px;padding-top:10px;border-top:1px solid var(--vscode-panel-border)}.section h2{font-size:14px;text-transform:uppercase;color:var(--vscode-descriptionForeground);letter-spacing:.04em;margin:0 0 8px}.body{white-space:pre-wrap}.file,.task{padding:7px 9px;border-radius:4px;margin:3px 0;background:var(--vscode-editorWidget-background)}
.file{display:flex;gap:8px;align-items:center;border:1px solid transparent;cursor:pointer}.file:hover{border-color:var(--vscode-focusBorder);background:var(--vscode-list-hoverBackground)}.path{font-family:var(--vscode-editor-font-family);font-weight:600}.status-badge{min-width:18px;text-align:center;font-weight:700;font-family:var(--vscode-editor-font-family)}.status-a{color:var(--vscode-gitDecoration-addedResourceForeground,#2da44e)}.status-d{color:var(--vscode-gitDecoration-deletedResourceForeground,#cf222e);text-decoration:line-through}.status-m{color:var(--vscode-gitDecoration-modifiedResourceForeground,#d29922)}.status-r{color:var(--vscode-gitDecoration-renamedResourceForeground,#a371f7)}.stats{margin-left:auto}.add{color:var(--vscode-gitDecoration-addedResourceForeground,#81b88b)}.del{color:var(--vscode-gitDecoration-deletedResourceForeground,#c74e39)}
.thread{border:1px solid var(--vscode-panel-border);border-radius:7px;margin:10px 0;background:var(--vscode-editorWidget-background);overflow:hidden}.thread-head{display:flex;gap:8px;align-items:center;padding:7px 10px;color:var(--vscode-descriptionForeground);font-size:.9em;background:var(--vscode-sideBarSectionHeader-background)}.thread-count{margin-left:auto}.comment{padding:10px 12px;border-top:1px solid var(--vscode-panel-border);background:var(--vscode-editorWidget-background);box-shadow:0 1px 0 rgba(0,0,0,.05)}.comment:first-child{border-top:0}.comment.reply{margin-left:22px;border-left:2px solid var(--vscode-textLink-foreground)}.reply-label{color:var(--vscode-textLink-foreground);font-size:.85em;margin-right:6px}.comment-head{color:var(--vscode-descriptionForeground);font-size:.9em;margin-bottom:6px}.comment-file{font-family:var(--vscode-editor-font-family);color:var(--vscode-textLink-foreground)}
.markdown{white-space:normal}.markdown p{margin:0 0 8px}.markdown h1,.markdown h2,.markdown h3{margin:10px 0 6px;text-transform:none;letter-spacing:0;color:var(--vscode-foreground)}.markdown h1{font-size:20px}.markdown h2{font-size:17px}.markdown h3{font-size:15px}.markdown ul{margin:4px 0 8px 20px;padding:0}.markdown li{margin:2px 0}.markdown code{font-family:var(--vscode-editor-font-family);background:var(--vscode-textCodeBlock-background);padding:1px 4px;border-radius:3px}.markdown a{color:var(--vscode-textLink-foreground);text-decoration:none}.markdown a:hover{text-decoration:underline}
pre{white-space:pre-wrap;overflow:auto;background:var(--vscode-textCodeBlock-background);padding:7px;border-radius:3px}.code-snippet{margin-top:8px;border-left:3px solid var(--vscode-textLink-foreground)}.muted{color:var(--vscode-descriptionForeground)}
</style></head><body><main class="shell" id="app"><div class="muted">Loading pull request details...</div></main>
<script nonce="${nonce}">
const vscode=acquireVsCodeApi(),initial=${JSON.stringify(pr).replace(/</g, '\\u003c')};let currentPr=initial,activeTab='overview';
function esc(v){return String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function render(pr){currentPr=pr;const title=pr.number?'#'+pr.number+' '+pr.title:pr.title;const comments=pr.commentsTotal==null?'Comments unavailable':pr.commentsActive+'/'+pr.commentsTotal+' comments';const fileCount=(pr.files||[]).length;document.getElementById('app').innerHTML='<div class="eyebrow">'+esc(pr.provider||'repository')+'</div><h1>'+esc(title)+'</h1><div class="meta"><span class="pill">'+esc(pr.author||'')+'</span><span class="pill">'+esc(pr.source||'')+' -> '+esc(pr.target||'')+'</span><span class="pill">'+esc(pr.state||'open')+'</span><span class="pill">'+esc(comments)+'</span></div><button id="open">Open on web</button>'+(pr.loadError?'<div class="section"><b>'+esc(pr.loadError)+'</b></div>':'')+tabs(fileCount)+'<div id="tab-body">'+tabBody(pr)+'</div>';document.getElementById('open').onclick=()=>vscode.postMessage({type:'open'});document.querySelectorAll('.tab').forEach(b=>b.onclick=()=>{activeTab=b.dataset.tab;render(currentPr)});document.querySelectorAll('.file').forEach(row=>row.onclick=()=>vscode.postMessage({type:'openFile',path:row.dataset.path}));}
function tabs(fileCount){return '<nav class="tabs"><button class="tab '+(activeTab==='overview'?'active':'')+'" data-tab="overview">Overview</button><button class="tab '+(activeTab==='files'?'active':'')+'" data-tab="files">Files changed '+fileCount+'</button></nav>'}
function tabBody(pr){if(activeTab==='files')return files(pr.files||[]);return section('Description', '<div class="body markdown">'+md(pr.body||'No description.')+'</div>')+tasks(pr.tasks)+commentsHtml(pr.comments||[])}
function section(title,html){return '<section class="section"><h2>'+title+'</h2>'+html+'</section>'}
function inlineMd(s){const tick=String.fromCharCode(96);return s.replace(/\\*\\*([^*]+)\\*\\*/g,'<strong>$1</strong>').replace(/\\*([^*]+)\\*/g,'<em>$1</em>').replace(new RegExp(tick+'([^'+tick+']+)'+tick,'g'),'<code>$1</code>').replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g,'<a href="$2">$1</a>')}
function md(value){const lines=String(value??'').replace(/\\r\\n/g,'\\n').split('\\n');let html='',list=false;for(const raw of lines){const line=esc(raw).trimEnd();const bullet=line.match(/^\\s*[-*]\\s+(.+)$/);if(bullet){if(!list){html+='<ul>';list=true}html+='<li>'+inlineMd(bullet[1])+'</li>';continue}if(list){html+='</ul>';list=false}if(!line.trim()){continue}const heading=line.match(/^(#{1,3})\\s+(.+)$/);if(heading){html+='<h'+heading[1].length+'>'+inlineMd(heading[2])+'</h'+heading[1].length+'>';continue}html+='<p>'+inlineMd(line)+'</p>'}if(list)html+='</ul>';return html}
function tasks(t){if(!t||(!t.ids?.length&&!t.checklist?.length&&!t.workItems?.length))return section('Linked tasks','<div class="muted">No linked task references found.</div>');return section('Linked tasks',(t.workItems||[]).map(x=>'<div class="task"><b>'+esc(x.type)+' '+esc(x.id)+'</b> · '+esc(x.state)+'<br>'+esc(x.title)+'</div>').join('')+(t.ids||[]).map(x=>'<div class="task">'+esc(x)+'</div>').join('')+(t.checklist||[]).map(x=>'<div class="task">'+(x.done?'☑':'☐')+' '+esc(x.text)+'</div>').join(''))}
function files(list){if(!list.length)return section('Files changed','<div class="muted">No file details available.</div>');return section('Files changed',list.map(f=>{const code=statusCode(f.status);return '<div class="file" data-path="'+esc(f.path)+'" title="Open diff beside PR view"><span class="status-badge status-'+esc(code.toLowerCase())+'">'+esc(code)+'</span><span class="path">'+esc(f.path)+'</span><span class="stats"><span class="add">+'+esc(f.additions??'')+'</span> <span class="del">-'+esc(f.deletions??'')+'</span></span></div>'}).join(''))}
function statusCode(status){const value=String(status||'modified').toLowerCase();if(['added','add','new','a'].includes(value))return 'A';if(['removed','deleted','delete','d'].includes(value))return 'D';if(['renamed','rename','r'].includes(value))return 'R';return 'M'}
function commentsHtml(list){const warning=currentPr.commentsWarning?'<div class="task">'+esc(currentPr.commentsWarning)+'</div>':'';if(!list.length)return section('Comments',warning+'<div class="muted">No comments loaded.</div>');const groups=[];const seen=new Map();for(const c of list){const key=c.threadId||('single-'+groups.length);if(!seen.has(key)){seen.set(key,{key,items:[]});groups.push(seen.get(key))}seen.get(key).items.push(c)}return section('Comments',warning+groups.map(threadHtml).join(''))}
function threadHtml(group){const first=group.items[0]||{};const file=first.file?' · <span class="comment-file">'+esc(first.file)+(first.line?':'+esc(first.line):'')+'</span>':'';const status=first.status?' · '+esc(first.status):'';return '<div class="thread"><div class="thread-head"><span>'+esc(first.type||'Comment thread')+file+status+'</span><span class="thread-count">'+group.items.length+' '+(group.items.length===1?'comment':'comments')+'</span></div>'+group.items.map(commentHtml).join('')+'</div>'}
function commentHtml(c){const code=c.isReply?'':(c.snippet||c.diff);return '<div class="comment '+(c.isReply?'reply':'')+'"><div class="comment-head">'+(c.isReply?'<span class="reply-label">Reply</span>':'')+esc(c.author)+' · '+esc(c.createdAt||'')+'</div><div class="body markdown">'+md(c.body)+'</div>'+(code?'<pre class="code-snippet">'+esc(code)+'</pre>':'')+'</div>'}
render(initial);window.addEventListener('message',e=>{if(e.data.type==='details')render(e.data.details)});vscode.postMessage({type:'ready'});
</script></body></html>`;
}

module.exports = { PullRequestPanel };
