// Webview client side script
(function() {
  const vscode = acquireVsCodeApi();

  let commits = [];
  let conflictedFiles = [];
  let isPaused = false;
  let isInteractive = false;
  let selectedCommitIndex = -1;

  // DOM Elements
  const branchBadge = document.getElementById('branchBadge');
  const ontoInfo = document.getElementById('ontoInfo');
  const statusBanner = document.getElementById('statusBanner');
  const bannerText = document.getElementById('bannerText');
  const conflictsSection = document.getElementById('conflictsSection');
  const conflictCount = document.getElementById('conflictCount');
  const conflictSearch = document.getElementById('conflictSearch');
  const conflictList = document.getElementById('conflictList');
  const commitsList = document.getElementById('commitsList');
  const btnAbort = document.getElementById('btnAbort');
  const btnSkip = document.getElementById('btnSkip');
  const btnAction = document.getElementById('btnAction');
  const rebaseSplitter = document.getElementById('rebaseSplitter');

  // Request initial data
  vscode.postMessage({ type: 'ready' });

  // Handle messages from the extension
  window.addEventListener('message', event => {
    const msg = event.data;
    switch (msg.type) {
      case 'init':
        commits = msg.commits || [];
        conflictedFiles = msg.conflictedFiles || [];
        isPaused = !!msg.paused;
        isInteractive = !!msg.interactive;

        branchBadge.innerText = msg.branch || 'HEAD';
        ontoInfo.innerText = msg.onto ? `onto ${msg.onto}` : '';
        if (msg.ontoSubject) {
          ontoInfo.title = msg.ontoSubject;
        }

        updateUI();
        break;

      case 'conflicts':
        conflictedFiles = msg.conflictedFiles || [];
        renderConflicts();
        break;

      case 'empty':
        commitsList.innerHTML = '<div class="loading">No active interactive rebase.</div>';
        break;
    }
  });

  function updateUI() {
    const titleEl = document.querySelector('.header h1');
    if (titleEl) {
      titleEl.innerText = isInteractive ? 'Interactive Git Rebase' : 'Git Rebase';
    }

    if (isPaused) {
      statusBanner.style.display = 'flex';
      bannerText.innerText = 'Rebase paused due to conflicts';
      conflictsSection.style.display = 'flex';
      rebaseSplitter.style.display = 'block';
      btnSkip.style.display = 'inline-block';
      btnAction.innerText = 'Continue';
    } else {
      statusBanner.style.display = 'none';
      conflictsSection.style.display = 'none';
      rebaseSplitter.style.display = 'none';
      btnSkip.style.display = 'none';
      btnAction.innerText = isInteractive ? 'Start Rebase' : 'Apply';
    }

    renderCommits();
    renderConflicts();
  }

  function renderCommits() {
    if (!commits || commits.length === 0) {
      commitsList.innerHTML = '<div class="loading">No commits to display.</div>';
      return;
    }

    commitsList.innerHTML = '';
    
    // We reverse the list for visual timeline, so the newest is at the top
    const renderedList = [...commits];

    renderedList.forEach((commit, idx) => {
      const row = document.createElement('div');
      row.className = `commit-row status-${commit.status || 'todo'} action-${commit.action}`;
      if (idx === selectedCommitIndex) {
        row.classList.add('selected');
      }
      row.dataset.index = idx;

      // Only allow drag and drop if not paused on conflict and in interactive setup phase
      if (isInteractive && !isPaused && commit.status !== 'done' && commit.status !== 'current') {
        row.draggable = true;
        setupDragEvents(row);
      }

      // Timeline Connector Dot
      const dot = document.createElement('div');
      dot.className = 'timeline-dot';
      row.appendChild(dot);

      // Action element (Select dropdown for editing, Badge for static display)
      let actionEl;
      if (isPaused || commit.status === 'done' || commit.status === 'current') {
        actionEl = document.createElement('span');
        actionEl.className = `action-badge action-${commit.action}`;
        actionEl.innerText = commit.action ? commit.action.toUpperCase() : 'PICK';
      } else {
        actionEl = document.createElement('select');
        actionEl.className = 'action-select';
        const actionsList = ['pick', 'reword', 'edit', 'squash', 'fixup', 'drop'];
        actionsList.forEach(act => {
          const opt = document.createElement('option');
          opt.value = act;
          opt.innerText = act;
          if (commit.action === act) opt.selected = true;
          actionEl.appendChild(opt);
        });
        actionEl.addEventListener('change', (e) => {
          commit.action = e.target.value;
          row.className = `commit-row status-${commit.status || 'todo'} action-${commit.action}`;
          if (idx === selectedCommitIndex) row.classList.add('selected');
        });
      }
      row.appendChild(actionEl);

      // Message Input / Text
      const msgInput = document.createElement('input');
      msgInput.className = 'commit-msg-input';
      msgInput.value = commit.subject || '';
      msgInput.type = 'text';
      msgInput.disabled = isPaused || commit.status === 'done' || commit.status === 'current' || (commit.action !== 'reword' && commit.action !== 'edit');
      
      msgInput.addEventListener('change', (e) => {
        commit.subject = e.target.value;
      });
      row.appendChild(msgInput);

      // Meta (SHA, Author, Time)
      const meta = document.createElement('div');
      meta.className = 'commit-meta';

      const shaSpan = document.createElement('span');
      shaSpan.className = 'commit-sha';
      shaSpan.innerText = commit.sha ? commit.sha.slice(0, 7) : 'N/A';
      meta.appendChild(shaSpan);

      if (commit.author) {
        const authorSpan = document.createElement('span');
        authorSpan.className = 'commit-author';
        authorSpan.innerText = commit.author;
        authorSpan.title = commit.author;
        meta.appendChild(authorSpan);
      }

      row.appendChild(meta);

      // Drag Handle
      if (isInteractive && !isPaused && commit.status !== 'done' && commit.status !== 'current') {
        const handle = document.createElement('div');
        handle.className = 'drag-handle';
        handle.innerHTML = '<span></span><span></span><span></span>';
        row.appendChild(handle);
      }

      // Selection Click
      row.addEventListener('click', (e) => {
        if (e.target.tagName !== 'SELECT' && e.target.tagName !== 'INPUT') {
          selectRow(idx);
        }
      });

      commitsList.appendChild(row);
    });
  }

  function selectRow(index) {
    selectedCommitIndex = index;
    const rows = commitsList.querySelectorAll('.commit-row');
    rows.forEach(r => r.classList.remove('selected'));
    if (index >= 0 && index < rows.length) {
      rows[index].classList.add('selected');
    }
  }

  // Drag and Drop implementation
  let dragSrcEl = null;

  function setupDragEvents(row) {
    row.addEventListener('dragstart', function(e) {
      row.classList.add('dragging');
      dragSrcEl = this;
      e.dataTransfer.effectAllowed = 'move';
    });

    row.addEventListener('dragover', function(e) {
      if (e.preventDefault) {
        e.preventDefault();
      }
      return false;
    });

    row.addEventListener('drop', function(e) {
      e.stopPropagation();
      if (dragSrcEl !== this) {
        const srcIdx = parseInt(dragSrcEl.dataset.index, 10);
        const targetIdx = parseInt(this.dataset.index, 10);

        // Reorder commits array
        const temp = commits[srcIdx];
        commits.splice(srcIdx, 1);
        commits.splice(targetIdx, 0, temp);

        selectedCommitIndex = targetIdx;
        renderCommits();
      }
      return false;
    });

    row.addEventListener('dragend', function() {
      row.classList.remove('dragging');
    });
  }

  // Conflicts view rendering
  function renderConflicts() {
    conflictCount.innerText = `${conflictedFiles.length} conflicted file${conflictedFiles.length === 1 ? '' : 's'}`;
    conflictList.innerHTML = '';

    const filterText = conflictSearch.value.toLowerCase();
    const filtered = conflictedFiles.filter(f => f.path.toLowerCase().includes(filterText));

    if (filtered.length === 0) {
      conflictList.innerHTML = '<div class="loading">No conflicts to display.</div>';
      return;
    }

    filtered.forEach(file => {
      const item = document.createElement('div');
      item.className = 'file-item';
      item.title = file.path;

      const details = document.createElement('div');
      details.className = 'file-details';

      const name = document.createElement('span');
      name.className = 'file-name';
      name.innerText = file.path.split('/').pop();
      details.appendChild(name);

      const path = document.createElement('span');
      path.className = 'file-path';
      path.innerText = file.path;
      details.appendChild(path);

      item.appendChild(details);

      // If we have marker count, show a badge
      if (file.conflictCount > 0) {
        const badge = document.createElement('span');
        badge.className = 'conflict-badge';
        badge.innerText = `⚠️ ${file.conflictCount}`;
        badge.title = `${file.conflictCount} conflict markers remaining`;
        item.appendChild(badge);
      } else if (file.conflictCount === 0) {
        const badge = document.createElement('span');
        badge.className = 'conflict-badge resolved';
        badge.innerText = `! 0`;
        badge.title = `No conflict markers remaining`;
        item.appendChild(badge);
      }

      // Actions (Stage / Unstage)
      const actions = document.createElement('div');
      actions.className = 'file-actions';

      const isStaged = file.status && file.status[0] !== 'U' && file.status[0] !== 'A' && file.status[0] !== 'D';

      // Stage Button (shows + if unstaged, ✓ if staged)
      const btnStage = document.createElement('button');
      if (isStaged) {
        btnStage.innerText = '✓';
        btnStage.className = 'btn-staged';
        btnStage.title = 'Staged (Click to unstage)';
      } else {
        btnStage.innerText = '+';
        btnStage.className = 'btn-stage-plus';
        btnStage.title = 'Stage file';
      }
      btnStage.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isStaged) {
          vscode.postMessage({ type: 'unstageFile', path: file.path });
        } else {
          vscode.postMessage({ type: 'stageFile', path: file.path });
        }
      });
      actions.appendChild(btnStage);

      item.appendChild(actions);

      item.addEventListener('click', () => {
        vscode.postMessage({ type: 'openDiff', path: file.path });
      });

      conflictList.appendChild(item);
    });
  }

  conflictSearch.addEventListener('input', renderConflicts);

  // Footer Actions
  btnAbort.addEventListener('click', () => {
    vscode.postMessage({ type: 'abort' });
  });

  btnSkip.addEventListener('click', () => {
    vscode.postMessage({ type: 'skip' });
  });

  btnAction.addEventListener('click', () => {
    if (isPaused) {
      vscode.postMessage({ type: 'continue' });
    } else {
      vscode.postMessage({ type: 'apply', commits });
    }
  });

  // Keyboard Shortcuts Navigation
  window.addEventListener('keydown', e => {
    if (selectedCommitIndex === -1 && commits.length > 0) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        selectRow(0);
        return;
      }
    }

    const commit = commits[selectedCommitIndex];
    if (!commit || commit.status === 'done' || commit.status === 'current' || isPaused) {
      return;
    }

    const key = e.key.toLowerCase();
    
    // Actions shortcuts: p: pick, r: reword, e: edit, s: squash, f: fixup, d: drop
    if (['p', 'r', 'e', 's', 'f', 'd'].includes(key) && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT') {
      const mapping = { p: 'pick', r: 'reword', e: 'edit', s: 'squash', f: 'fixup', d: 'drop' };
      commit.action = mapping[key];
      renderCommits();
      e.preventDefault();
    }

    // Alt + Up/Down to reorder
    if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const targetIdx = e.key === 'ArrowUp' ? selectedCommitIndex - 1 : selectedCommitIndex + 1;
      if (targetIdx >= 0 && targetIdx < commits.length) {
        const temp = commits[selectedCommitIndex];
        commits.splice(selectedCommitIndex, 1);
        commits.splice(targetIdx, 0, temp);
        selectedCommitIndex = targetIdx;
        renderCommits();
      }
    }

    // Ctrl + Enter to apply
    if (e.ctrlKey && e.key === 'Enter') {
      btnAction.click();
    }
  });

  // Splitter Resize dragging logic
  let isResizing = false;
  rebaseSplitter.addEventListener('mousedown', function(e) {
    isResizing = true;
    document.body.style.cursor = 'col-resize';
  });

  window.addEventListener('mousemove', function(e) {
    if (!isResizing) return;
    const conflictsRect = conflictsSection.getBoundingClientRect();
    const newWidth = e.clientX - conflictsRect.left;
    if (newWidth > 150 && newWidth < 600) {
      conflictsSection.style.width = `${newWidth}px`;
    }
  });

  window.addEventListener('mouseup', function(e) {
    if (isResizing) {
      isResizing = false;
      document.body.style.cursor = '';
    }
  });

})();
