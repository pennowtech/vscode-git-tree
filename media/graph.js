// GitTree graph webview: lane layout, SVG rendering, details pane, compare, context menu.
(function () {
  'use strict';

  const vscode = acquireVsCodeApi();

  const PALETTE = [
    '#0098fa', '#f97583', '#3fb950', '#d29922', '#a371f7',
    '#f778ba', '#39c5cf', '#fb8f44', '#84cc16', '#e6d54a'
  ];
  const ROW_H = 26;
  const LANE_W = 14;
  const NODE_R = 4;
  const MAX_LANES_SHOWN = 18;

  const el = (id) => document.getElementById(id);
  const rowsBody = el('rows');
  const detail = el('detailContent');
  const ctxMenu = el('ctxMenu');

  const state = {
    commits: [],
    rows: [],
    byRow: new Map(), // sha -> row element index
    head: { sha: '', branch: '' },
    repoName: '',
    scope: 'all',
    dateFormat: 'relative',
    fileFilter: null,
    statusCount: 0,
    branches: [],
    defaultCompareRef: 'HEAD',
    selected: null, // sha or 'WT'
    compareMark: null, // sha marked via "select for compare"
    compare: null, // {a,b} currently compared
    search: ''
    ,fileMode: savedFileMode()
  };

  function savedFileMode() {
    const value = vscode.getState();
    return value && value.fileMode === 'tree' ? 'tree' : 'list';
  }

  const saved = vscode.getState() || {};
  if (saved.detailW) document.getElementById('detailPane').style.flexBasis = saved.detailW + 'px';
  if (saved.scope) {
    state.scope = saved.scope;
    el('scopeSelect').value = saved.scope;
  }

  // ================================================================ helpers

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  function shortSha(sha) {
    return /^[0-9a-f]{7,}$/i.test(sha) ? sha.slice(0, 7) : sha;
  }

  function fmtDate(ms) {
    if (!ms) return '';
    if (state.dateFormat === 'absolute') return new Date(ms).toLocaleString();
    const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
    const units = [
      [31536000, 'yr'], [2592000, 'mo'], [604800, 'wk'],
      [86400, 'day'], [3600, 'hr'], [60, 'min']
    ];
    for (const [secs, label] of units) {
      if (s >= secs) {
        const n = Math.floor(s / secs);
        return `${n} ${label}${n > 1 && label !== 'mo' ? 's' : ''} ago`;
      }
    }
    return 'just now';
  }

  function fullDate(ms) {
    return ms ? new Date(ms).toLocaleString() : '';
  }

  // ============================================================ lane layout

  function layout(commits) {
    const lanes = []; // lanes[j] = sha this lane is waiting for (or null)
    const laneColor = [];
    let nextColor = 0;
    const rows = [];

    const firstFree = () => {
      let j = lanes.indexOf(null);
      if (j === -1) { j = lanes.length; lanes.push(null); laneColor.push(0); }
      return j;
    };

    for (const c of commits) {
      const row = { commit: c, inputs: [], passes: [], outputs: [], lane: 0, colorIdx: 0 };
      const waiting = [];
      for (let j = 0; j < lanes.length; j++) if (lanes[j] === c.sha) waiting.push(j);

      let lane;
      if (waiting.length === 0) {
        lane = firstFree();
        laneColor[lane] = nextColor++ % PALETTE.length;
      } else {
        lane = waiting[0];
      }
      row.lane = lane;
      row.colorIdx = laneColor[lane];

      for (const j of waiting) {
        row.inputs.push({ from: j, colorIdx: laneColor[j] });
        if (j !== lane) lanes[j] = null; // merged-in lane ends here
      }

      for (let j = 0; j < lanes.length; j++) {
        if (j !== lane && lanes[j] && lanes[j] !== c.sha) {
          row.passes.push({ lane: j, colorIdx: laneColor[j] });
        }
      }

      if (c.parents.length === 0) {
        lanes[lane] = null;
      } else {
        lanes[lane] = c.parents[0];
        row.outputs.push({ to: lane, colorIdx: laneColor[lane] });
        for (let k = 1; k < c.parents.length; k++) {
          const p = c.parents[k];
          let j = -1;
          for (let i = 0; i < lanes.length; i++) {
            if (i !== lane && lanes[i] === p) { j = i; break; }
          }
          if (j === -1) {
            j = firstFree();
            lanes[j] = p;
            laneColor[j] = nextColor++ % PALETTE.length;
          }
          row.outputs.push({ to: j, colorIdx: laneColor[j] });
        }
      }
      rows.push(row);
    }
    const maxLane = Math.min(
      MAX_LANES_SHOWN,
      rows.reduce((m, r) => {
        let rm = r.lane;
        for (const p of r.passes) rm = Math.max(rm, p.lane);
        for (const o of r.outputs) rm = Math.max(rm, o.to);
        for (const i of r.inputs) rm = Math.max(rm, i.from);
        return Math.max(m, rm);
      }, 0)
    );
    return { rows, laneCount: maxLane + 1 };
  }

  // ============================================================== rendering

  function laneX(j) {
    return 8 + j * LANE_W;
  }

  function rowSvg(row, laneCount, isWT) {
    const w = 8 + laneCount * LANE_W;
    const h = ROW_H;
    const mid = h / 2;
    let paths = '';
    const stroke = (ci) => PALETTE[ci % PALETTE.length];

    for (const p of row.passes) {
      const x = laneX(p.lane);
      paths += `<path d="M ${x} 0 L ${x} ${h}" stroke="${stroke(p.colorIdx)}" />`;
    }
    const xl = laneX(row.lane);
    for (const i of row.inputs) {
      const xf = laneX(i.from);
      paths += xf === xl
        ? `<path d="M ${xl} 0 L ${xl} ${mid}" stroke="${stroke(i.colorIdx)}" />`
        : `<path d="M ${xf} 0 C ${xf} ${mid * 0.6}, ${xl} ${mid * 0.4}, ${xl} ${mid}" stroke="${stroke(i.colorIdx)}" />`;
    }
    for (const o of row.outputs) {
      const xt = laneX(o.to);
      paths += xt === xl
        ? `<path d="M ${xl} ${mid} L ${xl} ${h}" stroke="${stroke(o.colorIdx)}" />`
        : `<path d="M ${xl} ${mid} C ${xl} ${mid + mid * 0.6}, ${xt} ${mid + mid * 0.4}, ${xt} ${h}" stroke="${stroke(o.colorIdx)}" />`;
    }
    const color = stroke(row.colorIdx);
    const isMerge = row.commit.parents.length > 1;
    const node = isWT
      ? `<circle cx="${xl}" cy="${mid}" r="${NODE_R}" fill="none" stroke="${color}" stroke-dasharray="2,2" />`
      : isMerge
        ? `<circle cx="${xl}" cy="${mid}" r="${NODE_R - 0.5}" fill="var(--vscode-editor-background)" stroke="${color}" stroke-width="2" />`
        : `<circle cx="${xl}" cy="${mid}" r="${NODE_R}" fill="${color}" stroke="none" />`;
    return `<svg width="${w}" height="${h}" fill="none" stroke-width="2">${paths}${node}</svg>`;
  }

  function refChips(commit, colorIdx) {
    if (!commit.refs || commit.refs.length === 0) return '';
    const color = PALETTE[colorIdx % PALETTE.length];
    let html = '';
    for (const ref of commit.refs) {
      const name = esc(ref.name);
      if (ref.type === 'tag') {
        html += `<span class="chip chip-tag" data-reftype="tag" data-refname="${name}" title="Tag: ${name}" style="--ref-color:${color}">⌂ ${name}</span>`;
      } else if (ref.type === 'remote') {
        html += `<span class="chip chip-remote" data-reftype="remote" data-refname="${name}" title="Remote branch: ${name}" style="--ref-color:${color}">☁ ${name}</span>`;
      } else if (ref.type === 'head') {
        html += `<span class="chip" data-reftype="head" data-refname="HEAD" title="Current HEAD" style="--ref-color:${color}"><span class="head-star">HEAD</span></span>`;
      } else {
        const star = ref.head ? '<span class="head-star">✓ </span>' : '';
        html += `<span class="chip" data-reftype="branch" data-refname="${name}" title="Branch: ${name}" style="--ref-color:${color}">${star}${name}</span>`;
      }
    }
    return html;
  }

  function renderGraph() {
    let commits = state.commits;
    // pseudo working-tree row so the layout draws its connection naturally
    const wtVisible =
      !state.fileFilter &&
      state.statusCount > 0 &&
      state.head.sha &&
      commits.some((c) => c.sha === state.head.sha);
    if (wtVisible) {
      commits = [
        { sha: 'WT', parents: [state.head.sha], author: '', email: '', time: Date.now(), refs: [], subject: '' },
        ...commits
      ];
    }
    const { rows, laneCount } = layout(commits);
    state.rows = rows;
    el('thGraph').style.width = 8 + laneCount * LANE_W + 8 + 'px';

    const html = [];
    for (const row of rows) {
      const c = row.commit;
      const isWT = c.sha === 'WT';
      const isHead = c.sha === state.head.sha;
      const cls = [
        'commit-row',
        isWT ? 'wt-row' : '',
        isHead ? 'head-row' : '',
        state.selected === c.sha ? 'selected' : '',
        state.compareMark === c.sha ? 'compare-marked' : '',
        compareEndpointClass(c)
      ].filter(Boolean).join(' ');
      const msg = isWT
        ? `<span class="msg-text">● Uncommitted changes (${state.statusCount} file${state.statusCount > 1 ? 's' : ''})</span>`
        : `<span class="msg-text">${c.signature === 'G' ? '✓ ' : c.signature === 'B' ? '⚠ ' : ''}${esc(c.subject)}</span>`;
      html.push(
        `<tr class="${cls}" data-sha="${esc(c.sha)}">` +
          `<td class="cell-refs">${isWT ? '' : refChips(c, row.colorIdx)}</td>` +
          `<td class="cell-graph">${rowSvg(row, laneCount, isWT)}</td>` +
          `<td class="cell-msg" title="${esc(c.subject)}">${msg}</td>` +
          `<td class="cell-author" title="${esc(c.email || '')}">${esc(c.author)}</td>` +
          `<td class="cell-date" title="${esc(fullDate(c.time))}">${isWT ? '' : esc(fmtDate(c.time))}</td>` +
          `<td class="cell-sha">${isWT ? '' : esc(shortSha(c.sha))}</td>` +
        `</tr>`
      );
    }
    rowsBody.innerHTML = html.join('');
    applySearch();
  }

  function compareEndpointClass(commit) {
    if (!state.compare) return '';
    const a = endpointMatchesCommit(state.compare.a, commit);
    const b = endpointMatchesCommit(state.compare.b, commit);
    if (a && b) return 'compare-endpoint compare-both';
    if (a) return 'compare-endpoint compare-left';
    if (b) return 'compare-endpoint compare-right';
    return '';
  }

  function endpointMatchesCommit(endpoint, commit) {
    if (!endpoint || !commit) return false;
    if ((endpoint === 'WT' || endpoint === 'Working Tree') && commit.sha === 'WT') return true;
    if (commit.sha === endpoint || commit.sha.startsWith(endpoint)) return true;
    if (endpoint === 'HEAD' && commit.sha === state.head.sha) return true;
    return (commit.refs || []).some((ref) => ref.name === endpoint);
  }

  // ========================================================== details pane

  function fileRowHtml(f, extra, depth = 0) {
    const idx = f.path.lastIndexOf('/');
    const dir = state.fileMode === 'tree' ? '' : (idx === -1 ? '' : f.path.slice(0, idx));
    const name = idx === -1 ? f.path : f.path.slice(idx + 1);
    const stats =
      f.additions != null || f.deletions != null
        ? `<span class="file-stats"><span class="stat-add">+${f.additions ?? 0}</span> <span class="stat-del">−${f.deletions ?? 0}</span></span>`
        : '';
    const rename = f.origPath ? ` title="${esc(f.origPath)} → ${esc(f.path)}"` : '';
    const workingActions = String(extra || '').includes('data-wt=')
      ? `<span class="file-actions">` +
        (f.staged
          ? `<button data-file-act="unstage" title="Unstage">−</button>`
          : `<button data-file-act="stage" title="Stage">＋</button>`) +
        `<button data-file-act="stashFile" title="Stash this file">▣</button>` +
        `<button data-file-act="reveal" title="Reveal in Explorer">◉</button>` +
        `<button data-file-act="terminal" title="Open containing folder in terminal">⌘</button>` +
        `<button data-file-act="discard" title="Discard changes">↶</button></span>`
      : '';
    return (
      `<div class="file-row tree-row status-${esc(f.status)}" style="--depth:${depth}" data-path="${esc(f.path)}" data-orig="${esc(f.origPath || '')}" data-status="${esc(f.status)}" ${extra || ''}${rename}>` +
        `<span class="tree-spacer"></span>` +
        `<span class="file-status fs-${esc(f.status)}">${esc(f.status)}</span>` +
        `<span class="file-name">${esc(name)}</span>` +
        `<span class="file-dir">${esc(dir)}</span>` +
        stats +
        workingActions +
      `</div>`
    );
  }

  function fileListHtml(files, extraFor) {
    if (state.fileMode === 'list') return `<div class="file-tree flat">${files.map((f) => fileRowHtml(f, extraFor(f), 0)).join('')}</div>`;
    const root = { folders: new Map(), files: [] };
    for (const file of files) {
      const parts = file.path.split('/');
      let node = root;
      parts.forEach((part, i) => {
        if (i === parts.length - 1) {
          node.files.push(file);
          return;
        }
        if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
        node = node.folders.get(part);
      });
    }
    const renderNode = (node, depth) => {
      const folders = [...node.folders.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) =>
        `<details class="file-folder" open>` +
          `<summary class="tree-row folder-row" style="--depth:${depth}"><span class="folder-icon"></span><span class="tree-name">${esc(name)}</span></summary>` +
          renderNode(child, depth + 1) +
        `</details>`
      ).join('');
      const leaves = node.files
        .sort((a, b) => a.path.localeCompare(b.path))
        .map((file) => fileRowHtml(file, extraFor(file), depth))
        .join('');
      return folders + leaves;
    };
    return `<div class="file-tree">${renderNode(root, 0)}</div>`;
  }

  function fileControls() {
    return `<div class="file-toolbar"><input class="file-filter" placeholder="Filter files…">` +
      `<button class="toggle-file-mode">${state.fileMode === 'tree' ? '☷ List' : '🌳 Tree'}</button></div>`;
  }

  function compareControls(source, target) {
    return `<div class="cmp-head inline-compare">` +
      `<span>Compare</span>` +
      `<select class="cmp-source cmp-ref-select" title="Comparison source">${refOptions(source, false)}</select>` +
      `<select class="cmp-target cmp-ref-select" title="Comparison target">${refOptions(target, true)}</select>` +
      `<button class="cmp-run" title="Compare selected refs">⇄</button>` +
    `</div>`;
  }

  function refOptions(current, includeWorking) {
    const refs = [...new Set(['HEAD', ...state.branches, ...(includeWorking ? ['Working Tree'] : [])])];
    if (!refs.includes(current)) refs.unshift(current);
    return refs.map((ref) => `<option value="${esc(ref)}"${ref === current ? ' selected' : ''}>${esc(ref)}</option>`).join('');
  }

  function wireFileControls() {
    const input = detail.querySelector('.file-filter');
    if (input) input.oninput = () => detail.querySelectorAll('.file-row').forEach((row) => {
      row.closest('[style*="padding-left"]')?.toggleAttribute('hidden', !row.dataset.path.toLowerCase().includes(input.value.toLowerCase()));
      row.hidden = !row.dataset.path.toLowerCase().includes(input.value.toLowerCase());
    });
    const toggle = detail.querySelector('.toggle-file-mode');
    if (toggle) toggle.onclick = () => {
      state.fileMode = state.fileMode === 'tree' ? 'list' : 'tree';
      vscode.setState({ ...(vscode.getState() || {}), fileMode: state.fileMode });
      if (state.lastDetails) renderDetails(state.lastDetails);
      else if (state.lastCompare) renderCompare(state.lastCompare);
    };
    const compare = detail.querySelector('.cmp-run');
    if (compare) compare.onclick = () => {
      const source = detail.querySelector('.cmp-source');
      const target = detail.querySelector('.cmp-target');
      if (!source || !target) return;
      post({ type: 'compare', a: source.value, b: target.value === 'Working Tree' ? 'WT' : target.value });
    };
  }

  function renderDetails(d) {
    state.lastDetails = d;
    state.lastCompare = null;
    state.compare = null;
    renderGraph();
    if (d.workingTree) {
      detail.innerHTML =
        `<div class="d-title">Uncommitted changes</div>` +
        `<div class="d-meta">${d.files.length} file(s) changed in the working tree. Click a file to diff against HEAD.</div>` +
        compareControls(state.defaultCompareRef, 'Working Tree') +
        `<div class="commit-box"><textarea id="commitMessage" rows="3" placeholder="Commit message…"></textarea>` +
          `<div class="d-actions"><button data-act="commit" class="primary">✓ Commit</button>` +
          `<button data-act="amendCommit">↺ Amend</button><button data-act="signCommit">🔏 Sign & Commit</button></div></div>` +
        fileControls().replace('</div>', '') +
          `<button data-act="openTerminal">⌘ Terminal</button></div>` +
        `<div class="d-actions">` +
          `<button data-act="stashSave">▣ Stash…</button>` +
          `<button data-act="stageAll">＋ Stage all</button><button data-act="unstageAll">− Unstage all</button>` +
        `</div>` +
        `<div class="d-section">Files</div>` +
        `<div id="workingFiles">${fileListHtml(d.files, (f) => `data-wt="1" data-staged="${f.staged ? 1 : 0}" data-untracked="${f.untracked ? 1 : 0}"`)}</div>`;
      wireFileControls();
      return;
    }
    const refs = d.refs && d.refs.length
      ? `<div class="d-meta">${d.refs.map((r) => esc(r.type === 'tag' ? '⌂ ' + r.name : r.name)).join(' · ')}</div>`
      : '';
    const parents = d.parents.length
      ? `<div class="d-meta">Parent${d.parents.length > 1 ? 's' : ''}: ` +
        d.parents.map((p) => `<span class="d-sha" data-goto="${esc(p)}">${shortSha(p)}</span>`).join(', ') +
        `</div>`
      : '<div class="d-meta">Root commit</div>';
    const totalAdd = d.files.reduce((s, f) => s + (f.additions || 0), 0);
    const totalDel = d.files.reduce((s, f) => s + (f.deletions || 0), 0);
    const bodyRest = d.body.split('\n').slice(1).join('\n').trim();
    detail.innerHTML =
      `<div class="d-meta"><span class="d-sha" data-copy="${esc(d.sha)}" title="Click to copy full SHA">${shortSha(d.sha)}</span>` +
        (d.isMerge ? ' · <b>merge commit</b>' : '') + `</div>` +
      `<div class="d-title">${esc(d.body.split('\n')[0])}</div>` +
      `<div class="d-meta">Author: <b>${esc(d.author)}</b> &lt;${esc(d.email)}&gt; · ${esc(fullDate(d.authorTime))}</div>` +
      (d.committer !== d.author ? `<div class="d-meta">Committer: ${esc(d.committer)} · ${esc(fullDate(d.commitTime))}</div>` : '') +
      refs + parents +
      (bodyRest ? `<div class="d-body">${esc(bodyRest)}</div>` : '') +
      compareControls(state.defaultCompareRef, d.sha) +
      `<div class="d-actions" data-sha="${esc(d.sha)}" data-merge="${d.isMerge ? 1 : 0}">` +
        `<button data-act="checkoutDetached">⇥ Checkout</button>` +
        `<button data-act="createBranch">⑂ Branch…</button>` +
        `<button data-act="createTag">⌂ Tag…</button>` +
        `<button data-act="cherryPick">✓ Cherry-pick</button>` +
        `<button data-act="revert">↶ Revert</button>` +
        `<button data-act="resetMenu">↺ Reset…</button>` +
        `<button data-act="copySha">⧉ Copy SHA</button>` +
      `</div>` +
      `<div class="d-section">Files changed (${d.files.length}) · <span class="stat-add">+${totalAdd}</span> <span class="stat-del">−${totalDel}</span></div>` + fileControls() +
      fileListHtml(d.files, () => `data-sha="${esc(d.sha)}"`);
    wireFileControls();
  }

  function renderCompare(r) {
    state.lastCompare = r;
    state.lastDetails = null;
    state.compare = { a: r.a, b: r.b };
    renderGraph();
    const totalAdd = r.files.reduce((sum, file) => sum + (file.additions || 0), 0);
    const totalDel = r.files.reduce((sum, file) => sum + (file.deletions || 0), 0);
    const compareFiles = fileListHtml(r.files, () => `data-cmp-a="${esc(r.a)}" data-cmp-b="${esc(r.b)}"`);
    const cmpCommit = (c) =>
      `<div class="cmp-commit"><span class="sha" data-goto="${esc(c.sha)}">${esc(c.sha)}</span>${esc(c.subject)}<span class="who">${esc(c.author)} · ${esc(fmtDate(c.time))}</span></div>`;
    detail.innerHTML =
      `<div class="compare-view">` +
        `<div class="compare-title"><span>Comparing References</span><button id="cmpClose" title="Back to commit details">×</button></div>` +
        `<div class="compare-refbar">` +
          `<select id="cmpSource" class="cmp-ref-select cmp-source" title="Comparison source">${refOptions(r.a, false)}</select>` +
          `<button id="cmpSwap" class="swap-button" title="Swap sides"${r.b === 'Working Tree' ? ' disabled' : ''}>⇄</button>` +
          `<select id="cmpTarget" class="cmp-ref-select cmp-target" title="Comparison target">${refOptions(r.b, true)}</select>` +
        `</div>` +
        `<div class="cmp-counts">` +
          `<b>${r.behind}</b> only in <code>${esc(r.a)}</code> · ` +
          `<b>${r.ahead}</b> only in <code>${esc(r.b)}</code>` +
        `</div>` +
        `<div class="files-changed-head">` +
          `<span class="files-title">Files changed</span>` +
          `<span class="file-count">${r.files.length}</span>` +
          `<span class="stat-add">+${totalAdd}</span>` +
          `<span class="stat-del">−${totalDel}</span>` +
          `<span class="files-actions"><button class="toggle-file-mode">${state.fileMode === 'tree' ? '☷' : '🌳'}</button></span>` +
        `</div>` +
        `<div class="compare-filter-row"><input class="file-filter" placeholder="Filter files…"><button class="filter-button" title="Filter">≡</button></div>` +
        `<div class="compare-files">${compareFiles}</div>` +
      `</div>` +
      (r.onlyInB.length
        ? `<div class="d-section">Only in ${esc(r.b)} (${r.onlyInB.length}${r.onlyInB.length >= 50 ? '+' : ''})</div>` +
          r.onlyInB.map(cmpCommit).join('')
        : '') +
      (r.onlyInA.length
        ? `<div class="d-section">Only in ${esc(r.a)} (${r.onlyInA.length}${r.onlyInA.length >= 50 ? '+' : ''})</div>` +
          r.onlyInA.map(cmpCommit).join('')
        : '');
    const swap = document.getElementById('cmpSwap');
    wireFileControls();
    if (swap && r.b !== 'Working Tree') swap.onclick = () => post({ type: 'compare', a: r.b, b: r.a });
    const source = document.getElementById('cmpSource');
    const target = document.getElementById('cmpTarget');
    if (source) source.onchange = () => post({ type: 'compare', a: source.value, b: target.value });
    if (target) target.onchange = () => post({ type: 'compare', a: source.value, b: target.value === 'Working Tree' ? 'WT' : target.value });
    const close = document.getElementById('cmpClose');
    if (close) {
      close.onclick = () => {
        state.compareMark = null;
        selectEndpoint(r.a);
      };
    }
  }

  function selectEndpoint(endpoint) {
    if (endpoint === 'WT' || endpoint === 'Working Tree') {
      selectRow('WT');
      return;
    }
    const sha = resolveEndpointSha(endpoint);
    if (sha) {
      selectRow(sha);
      rowsBody.querySelector(`tr[data-sha="${CSS.escape(sha)}"]`)?.scrollIntoView({ block: 'center' });
      return;
    }
    state.compare = null;
    renderGraph();
    detail.innerHTML = '<div class="detail-empty">Select a commit to see its details.</div>';
  }

  function resolveEndpointSha(endpoint) {
    if (!endpoint) return null;
    if (endpoint === 'HEAD') return state.head.sha || null;
    const exact = state.commits.find((commit) => commit.sha === endpoint);
    if (exact) return exact.sha;
    const byPrefix = state.commits.find((commit) => commit.sha.startsWith(endpoint));
    if (byPrefix) return byPrefix.sha;
    const byRef = state.commits.find((commit) => (commit.refs || []).some((ref) => ref.name === endpoint));
    return byRef ? byRef.sha : null;
  }

  // ============================================================ interaction

  function post(msg) {
    vscode.postMessage(msg);
  }

  function selectRow(sha) {
    state.selected = sha;
    for (const tr of rowsBody.querySelectorAll('tr')) {
      tr.classList.toggle('selected', tr.dataset.sha === sha);
    }
    if (sha === 'WT') post({ type: 'selectWorkingTree' });
    else post({ type: 'select', sha });
  }

  rowsBody.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip');
    const tr = e.target.closest('tr.commit-row');
    if (!tr) return;
    const sha = tr.dataset.sha;
    if (e.ctrlKey || e.metaKey) {
      // ctrl-click: compare with previously selected commit
      const other = state.compareMark || state.selected;
      if (other && other !== 'WT' && other !== sha && sha !== 'WT') {
        state.compareMark = other;
        renderGraph();
        post({ type: 'compare', a: other, b: sha });
        return;
      }
    }
    if (chip) {
      selectRow(sha); // chips select the row too; right-click gives ref actions
      return;
    }
    selectRow(sha);
  });

  rowsBody.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const chip = e.target.closest('.chip');
    const tr = e.target.closest('tr.commit-row');
    if (!tr) return;
    const sha = tr.dataset.sha;
    if (chip && chip.dataset.reftype !== 'head') {
      showRefMenu(e.pageX, e.pageY, chip.dataset.reftype, chip.dataset.refname, sha);
    } else if (sha !== 'WT') {
      showCommitMenu(e.pageX, e.pageY, sha);
    } else {
      showMenu(e.pageX, e.pageY, [
        { label: 'Stash Changes…', run: () => post({ type: 'action', action: 'stashSave', args: {} }) },
        { label: 'View Changed Files', run: () => selectRow('WT') }
      ]);
    }
  });

  // ---- context menus

  function showMenu(x, y, items) {
    ctxMenu.innerHTML = '';
    for (const item of items) {
      if (item === '-') {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        ctxMenu.appendChild(sep);
        continue;
      }
      if (item.label && !item.run) {
        const lbl = document.createElement('div');
        lbl.className = 'ctx-label';
        lbl.textContent = item.label;
        ctxMenu.appendChild(lbl);
        continue;
      }
      const div = document.createElement('div');
      div.className = 'ctx-item' + (item.danger ? ' danger' : '');
      div.textContent = item.label;
      div.onclick = () => {
        hideMenu();
        item.run();
      };
      ctxMenu.appendChild(div);
    }
    ctxMenu.style.display = 'block';
    const rect = ctxMenu.getBoundingClientRect();
    ctxMenu.style.left = Math.min(x, window.innerWidth - rect.width - 8) + 'px';
    ctxMenu.style.top = Math.min(y, window.innerHeight - rect.height - 8) + 'px';
  }

  function hideMenu() {
    ctxMenu.style.display = 'none';
  }
  document.addEventListener('click', hideMenu);
  document.addEventListener('keydown', (e) => e.key === 'Escape' && hideMenu());
  window.addEventListener('blur', hideMenu);

  function showCommitMenu(x, y, sha) {
    const act = (action, args) => () => post({ type: 'action', action, args });
    const items = [
      { label: shortSha(sha) },
      { label: 'View Details', run: () => selectRow(sha) },
      '-',
      { label: 'Checkout Commit (Detached)', run: act('checkoutDetached', { sha }) },
      { label: 'Create Branch Here…', run: act('createBranch', { startPoint: sha }) },
      { label: 'Create Tag Here…', run: act('createTag', { sha }) },
      '-',
      { label: 'Cherry-pick Commit', run: act('cherryPick', { sha }) },
      { label: 'Revert Commit', run: act('revert', { sha, isMerge: isMergeSha(sha) }) },
      { label: 'Interactive Rebase from Here…', run: act('interactiveRebase', { name: sha }) },
      '-',
      { label: 'Reset Current Branch Here — soft', run: act('reset', { sha, mode: 'soft' }) },
      { label: 'Reset Current Branch Here — mixed', run: act('reset', { sha, mode: 'mixed' }) },
      { label: 'Reset Current Branch Here — hard', danger: true, run: act('reset', { sha, mode: 'hard' }) },
      '-',
      { label: 'Compare with Working Changes', run: () => post({ type: 'compare', a: sha, b: 'WT' }) },
      state.compareMark && state.compareMark !== sha
        ? { label: `Compare with ${shortSha(state.compareMark)}`, run: () => post({ type: 'compare', a: state.compareMark, b: sha }) }
        : { label: 'Select for Compare', run: () => { state.compareMark = sha; renderGraph(); } },
      '-',
      { label: 'Copy SHA', run: () => post({ type: 'copy', text: sha }) },
      { label: 'Copy Message', run: () => post({ type: 'copy', text: subjectOf(sha) }) }
    ];
    showMenu(x, y, items);
  }

  function showRefMenu(x, y, type, name, sha) {
    const act = (action, args) => () => post({ type: 'action', action, args });
    let items = [{ label: name }];
    if (type === 'branch' || type === 'remote') {
      items = items.concat([
        { label: 'Switch Branch', run: act('checkoutBranch', { name, remote: type === 'remote' }) },
        { label: 'Merge into Current Branch', run: act('merge', { name }) },
        { label: 'Rebase Current Branch onto This', run: act('rebase', { name }) },
        { label: 'Interactive Rebase onto This…', run: act('interactiveRebase', { name }) },
        '-',
        { label: 'Compare with Working Changes', run: () => post({ type: 'compare', a: name, b: 'WT' }) },
        state.compareMark
          ? { label: `Compare with ${shortSha(state.compareMark)}`, run: () => post({ type: 'compare', a: state.compareMark, b: name }) }
          : { label: 'Select for Compare', run: () => { state.compareMark = sha; renderGraph(); } },
        '-'
      ]);
      if (type === 'branch') {
        items.push({ label: 'Rename Branch…', run: act('renameBranch', { name }) });
      }
      items.push({ label: 'Delete Branch…', danger: true, run: act('deleteBranch', { name, remote: type === 'remote' }) });
    } else if (type === 'tag') {
      items = items.concat([
        { label: 'Checkout Tag (Detached)', run: act('checkoutDetached', { sha: name }) },
        { label: `Compare with ${state.head.branch || 'HEAD'}`, run: () => post({ type: 'compare', a: state.head.branch || 'HEAD', b: name }) },
        '-',
        { label: 'Delete Tag…', danger: true, run: act('deleteTag', { name }) }
      ]);
    }
    items.push('-', { label: 'Copy Name', run: () => post({ type: 'copy', text: name }) });
    showMenu(x, y, items);
  }

  function isMergeSha(sha) {
    const c = state.commits.find((x) => x.sha === sha);
    return !!c && c.parents.length > 1;
  }
  function subjectOf(sha) {
    const c = state.commits.find((x) => x.sha === sha);
    return c ? c.subject : sha;
  }

  // ---- details pane events (delegated)

  detail.addEventListener('click', (e) => {
    const goto = e.target.closest('[data-goto]');
    if (goto) {
      const sha = resolveSha(goto.dataset.goto);
      if (sha) {
        selectRow(sha);
        const tr = rowsBody.querySelector(`tr[data-sha="${CSS.escape(sha)}"]`);
        if (tr) tr.scrollIntoView({ block: 'center' });
      }
      return;
    }
    const copyEl = e.target.closest('[data-copy]');
    if (copyEl) {
      post({ type: 'copy', text: copyEl.dataset.copy });
      return;
    }
    const btn = e.target.closest('button[data-act]');
    if (btn) {
      const wrap = btn.closest('.d-actions');
      const sha = wrap ? wrap.dataset.sha : undefined;
      const isMerge = wrap ? wrap.dataset.merge === '1' : false;
      switch (btn.dataset.act) {
        case 'checkoutDetached': post({ type: 'action', action: 'checkoutDetached', args: { sha } }); break;
        case 'createBranch': post({ type: 'action', action: 'createBranch', args: { startPoint: sha } }); break;
        case 'createTag': post({ type: 'action', action: 'createTag', args: { sha } }); break;
        case 'cherryPick': post({ type: 'action', action: 'cherryPick', args: { sha } }); break;
        case 'revert': post({ type: 'action', action: 'revert', args: { sha, isMerge } }); break;
        case 'stashSave': post({ type: 'action', action: 'stashSave', args: {} }); break;
        case 'stageAll': post({ type: 'action', action: 'stageAll', args: {} }); break;
        case 'unstageAll': post({ type: 'action', action: 'unstageAll', args: {} }); break;
        case 'commit': post({ type: 'action', action: 'commit', args: { message: el('commitMessage').value } }); break;
        case 'amendCommit': post({ type: 'action', action: 'commit', args: { message: el('commitMessage').value.trim(), amend: true } }); break;
        case 'signCommit': post({ type: 'action', action: 'commit', args: { message: el('commitMessage').value, sign: true } }); break;
        case 'compareBase': post({ type: 'compare', a: state.defaultCompareRef, b: 'WT' }); break;
        case 'openTerminal': post({ type: 'openTerminal' }); break;
        case 'copySha': post({ type: 'copy', text: sha }); break;
        case 'resetMenu': {
          const r = btn.getBoundingClientRect();
          showMenu(r.left, r.bottom + 4, [
            { label: 'Reset — soft (keep index & files)', run: () => post({ type: 'action', action: 'reset', args: { sha, mode: 'soft' } }) },
            { label: 'Reset — mixed (keep files)', run: () => post({ type: 'action', action: 'reset', args: { sha, mode: 'mixed' } }) },
            { label: 'Reset — hard (discard everything)', danger: true, run: () => post({ type: 'action', action: 'reset', args: { sha, mode: 'hard' } }) }
          ]);
          setTimeout(() => e.stopPropagation(), 0);
          break;
        }
      }
      return;
    }
    const fileRow = e.target.closest('.file-row');
    if (fileRow) {
      const d = fileRow.dataset;
      const fileAction = e.target.closest('[data-file-act]');
      if (fileAction) {
        const action = fileAction.dataset.fileAct;
        if (action === 'reveal') post({ type: 'revealFile', path: d.path });
        else if (action === 'terminal') post({ type: 'openTerminal', path: d.path });
        else post({ type: 'action', action, args: { path: d.path, untracked: d.untracked === '1' } });
        return;
      }
      if (d.cmpA) {
        post({ type: 'openFileDiff', sha: d.cmpB, base: d.cmpA, workingTree: d.cmpB === 'Working Tree', filePath: d.path, origPath: d.orig || undefined, status: d.status });
      } else if (d.wt) {
        post({ type: 'openFileDiff', workingTree: true, filePath: d.path, origPath: d.orig || undefined, status: d.status });
      } else {
        post({ type: 'openFileDiff', sha: d.sha, filePath: d.path, origPath: d.orig || undefined, status: d.status });
      }
    }
  });

  function resolveSha(prefix) {
    if (state.commits.some((c) => c.sha === prefix)) return prefix;
    const hit = state.commits.find((c) => c.sha.startsWith(prefix));
    return hit ? hit.sha : null;
  }

  // ---- toolbar

  el('scopeSelect').addEventListener('change', (e) => {
    state.scope = e.target.value;
    vscode.setState({ ...(vscode.getState() || {}), scope: state.scope });
    post({ type: 'reload', scope: state.scope });
  });
  el('btnRefresh').addEventListener('click', () => post({ type: 'reload', scope: state.scope }));
  el('btnFetch').addEventListener('click', () => post({ type: 'action', action: 'fetch', args: {} }));
  el('btnPull').addEventListener('click', () => post({ type: 'action', action: 'pull', args: {} }));
  el('btnPush').addEventListener('click', () => post({ type: 'action', action: 'push', args: {} }));
  el('btnStash').addEventListener('click', () => post({ type: 'action', action: 'stashSave', args: {} }));
  el('fileFilterChip').addEventListener('click', () => post({ type: 'reload', scope: state.scope, clearFileFilter: true }));

  let searchTimer;
  el('searchBox').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.search = e.target.value.trim().toLowerCase();
      applySearch();
    }, 150);
  });
  el('searchBox').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = rowsBody.querySelector('tr.commit-row:not(.dimmed)');
      if (first && state.search) first.scrollIntoView({ block: 'center' });
    }
  });

  function applySearch() {
    const q = state.search;
    for (const tr of rowsBody.querySelectorAll('tr.commit-row')) {
      if (!q) {
        tr.classList.remove('dimmed');
        continue;
      }
      const sha = tr.dataset.sha.toLowerCase();
      const c = state.commits.find((x) => x.sha === tr.dataset.sha);
      const hay = c ? `${c.subject} ${c.author} ${sha}`.toLowerCase() : sha;
      tr.classList.toggle('dimmed', !hay.includes(q));
    }
  }

  // ---- splitter drag

  (function initSplitter() {
    const splitter = el('splitter');
    const pane = el('detailPane');
    let dragging = false;
    splitter.addEventListener('mousedown', (e) => {
      dragging = true;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = Math.max(240, Math.min(window.innerWidth - 300, window.innerWidth - e.clientX));
      pane.style.flexBasis = w + 'px';
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      vscode.setState({ ...(vscode.getState() || {}), detailW: parseInt(pane.style.flexBasis, 10) || 420 });
    });
  })();

  // ============================================================== messages

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'graph': {
        state.commits = msg.commits;
        state.head = msg.head;
        state.repoName = msg.repoName;
        state.statusCount = msg.status.count;
        state.dateFormat = msg.dateFormat;
        state.fileFilter = msg.fileFilter;
        state.branches = msg.branches;
        state.defaultCompareRef = msg.defaultCompareRef || 'HEAD';
        el('repoName').textContent = msg.repoName;
        el('scopeInfo').textContent = `${msg.scope === 'current' ? 'Current branch only' : 'All refs'} · ${msg.commits.length} commits`;
        const chip = el('fileFilterChip');
        if (msg.fileFilter) {
          chip.textContent = '⏳ ' + msg.fileFilter + ' ✕';
          chip.style.display = '';
        } else {
          chip.style.display = 'none';
        }
        el('busy').style.display = 'none';
        renderGraph();
        // keep selection if the commit is still present
        if (state.selected && !state.commits.some((c) => c.sha === state.selected) && state.selected !== 'WT') {
          state.selected = null;
        }
        break;
      }
      case 'details':
        renderDetails(msg.details);
        break;
      case 'compareResult':
        renderCompare(msg.result);
        break;
      case 'startCompare':
        post({ type: 'compare', a: msg.a, b: msg.b });
        break;
      case 'revealCommit':
        selectRow(msg.sha);
        rowsBody.querySelector(`tr[data-sha="${CSS.escape(msg.sha)}"]`)?.scrollIntoView({ block: 'center' });
        break;
      case 'busy':
        el('busy').style.display = msg.busy ? 'block' : 'none';
        break;
    }
  });

  post({ type: 'ready', scope: state.scope });
})();
