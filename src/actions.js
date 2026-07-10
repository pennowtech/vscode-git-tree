// Git actions shared by the graph webview and the sidebar tree views.
// Every destructive action confirms with a modal dialog first.
'use strict';

const vscode = require('vscode');

/**
 * @param {import('./git').Git} git
 * @param {string} action
 * @param {object} args
 */
async function run(git, action, args) {
  switch (action) {
    case 'checkoutBranch': {
      let ref = args.name;
      // checking out a remote branch creates/switches to the local tracking branch
      const m = ref.match(/^[^/]+\/(.+)$/);
      if (args.remote && m) ref = m[1];
      await progress(`Checking out ${ref}`, () => git.checkout(ref));
      return info(`Checked out ${ref}`);
    }
    case 'checkoutDetached': {
      await progress(`Checking out ${short(args.sha)}`, () => git.checkoutDetached(args.sha));
      return info(`HEAD detached at ${short(args.sha)}`);
    }
    case 'createBranch': {
      const name = await vscode.window.showInputBox({
        prompt: args.startPoint
          ? `New branch at ${short(args.startPoint)}`
          : 'New branch from current HEAD',
        placeHolder: 'branch name',
        validateInput: validRefName
      });
      if (!name) return;
      const switchTo = await pick(`Switch to '${name}' after creating it?`, ['Create and Switch', 'Just Create']);
      if (!switchTo) return;
      await git.createBranch(name, args.startPoint, switchTo === 'Create and Switch');
      return info(`Created branch ${name}`);
    }
    case 'deleteBranch': {
      const ok = await confirm(`Delete branch '${args.name}'?`, 'Delete');
      if (!ok) return;
      if (args.remote) {
        const m = args.name.match(/^([^/]+)\/(.+)$/);
        if (!m) throw new Error(`Cannot parse remote branch ${args.name}`);
        await progress(`Deleting ${args.name} on remote`, () => git.deleteRemoteBranch(m[1], m[2]));
      } else {
        try {
          await git.deleteBranch(args.name, false);
        } catch (err) {
          const force = await confirm(
            `'${args.name}' is not fully merged. Force delete?\n\n${err.message}`,
            'Force Delete'
          );
          if (!force) return;
          await git.deleteBranch(args.name, true);
        }
      }
      return info(`Deleted branch ${args.name}`);
    }
    case 'renameBranch': {
      const newName = await vscode.window.showInputBox({
        prompt: `Rename branch '${args.name}' to:`,
        value: args.name,
        validateInput: validRefName
      });
      if (!newName || newName === args.name) return;
      await git.renameBranch(args.name, newName);
      return info(`Renamed to ${newName}`);
    }
    case 'merge': {
      const ok = await confirm(`Merge '${args.name}' into the current branch?`, 'Merge');
      if (!ok) return;
      await progress(`Merging ${args.name}`, () => git.merge(args.name));
      return info(`Merged ${args.name}`);
    }
    case 'rebase': {
      const ok = await confirm(`Rebase the current branch onto '${args.name}'?`, 'Rebase');
      if (!ok) return;
      await progress(`Rebasing onto ${args.name}`, () => git.rebase(args.name));
      return info(`Rebased onto ${args.name}`);
    }
    case 'rebaseContinue':
      return progress('Continuing rebase', () => git.rebaseContinue());
    case 'rebaseSkip': {
      const ok = await confirm('Skip the current commit in the active rebase?', 'Skip Commit');
      if (ok) return progress('Skipping rebase commit', () => git.rebaseSkip());
      return;
    }
    case 'rebaseAbort': {
      const ok = await confirm('Abort the active rebase and restore the original branch?', 'Abort Rebase');
      if (ok) return progress('Aborting rebase', () => git.rebaseAbort());
      return;
    }
    case 'cherryPick': {
      await progress(`Cherry-picking ${short(args.sha)}`, () => git.cherryPick(args.sha));
      return info(`Cherry-picked ${short(args.sha)}`);
    }
    case 'revert': {
      const ok = await confirm(`Revert commit ${short(args.sha)}? A new revert commit will be created.`, 'Revert');
      if (!ok) return;
      await progress(`Reverting ${short(args.sha)}`, () => git.revert(args.sha, args.isMerge));
      return info(`Reverted ${short(args.sha)}`);
    }
    case 'reset': {
      const mode = args.mode;
      const warning =
        mode === 'hard'
          ? `HARD reset to ${short(args.sha)}? All uncommitted changes AND commits after it on this branch will be LOST.`
          : `${mode} reset the current branch to ${short(args.sha)}?`;
      const ok = await confirm(warning, mode === 'hard' ? 'Hard Reset' : 'Reset');
      if (!ok) return;
      await git.reset(args.sha, mode);
      return info(`Reset (${mode}) to ${short(args.sha)}`);
    }
    case 'createTag': {
      const name = await vscode.window.showInputBox({
        prompt: args.sha ? `New tag at ${short(args.sha)}` : 'New tag at HEAD',
        placeHolder: 'v1.0.0',
        validateInput: validRefName
      });
      if (!name) return;
      const message = await vscode.window.showInputBox({
        prompt: 'Tag message (leave empty for a lightweight tag)'
      });
      if (message === undefined) return;
      await git.createTag(name, args.sha, message);
      return info(`Created tag ${name}`);
    }
    case 'deleteTag': {
      const ok = await confirm(`Delete tag '${args.name}' (local only)?`, 'Delete');
      if (!ok) return;
      await git.deleteTag(args.name);
      return info(`Deleted tag ${args.name}`);
    }
    case 'stashSave': {
      const message = await vscode.window.showInputBox({ prompt: 'Stash message (optional)' });
      if (message === undefined) return;
      const untracked = await pick('Include untracked files?', ['Include Untracked', 'Tracked Only']);
      if (!untracked) return;
      await git.stashSave(message, untracked === 'Include Untracked');
      return info('Changes stashed');
    }
    case 'stashApply':
      await progress('Applying stash', () => git.stashApply(args.ref));
      return info(`Applied ${args.ref}`);
    case 'stashPop':
      await progress('Popping stash', () => git.stashPop(args.ref));
      return info(`Popped ${args.ref}`);
    case 'stashDrop': {
      const ok = await confirm(`Drop ${args.ref}? Its changes will be lost.`, 'Drop');
      if (!ok) return;
      await git.stashDrop(args.ref);
      return info(`Dropped ${args.ref}`);
    }
    case 'stashFile':
      await progress(`Stashing ${args.path}`, () => git.stashFile(args.path));
      return info(`Stashed ${args.path}`);
    case 'fetch':
      return progress('Fetching all remotes', () => git.fetch());
    case 'pull':
      return progress('Pulling', () => git.pull());
    case 'push':
      return progress('Pushing', () => git.push());
    case 'stage':
      return git.stage(args.path);
    case 'stageAll':
      return git.stageAll();
    case 'unstage':
      return git.unstage(args.path);
    case 'unstageAll':
      return git.unstageAll();
    case 'discard': {
      const ok = await confirm(
        `Discard changes in '${args.path}'? This cannot be undone.`,
        'Discard Changes'
      );
      if (!ok) return;
      await git.discard(args.path, args.untracked);
      return info(`Discarded changes in ${args.path}`);
    }
    case 'commit': {
      let message = typeof args.message === 'string' ? args.message.trim() : '';
      if (!message && !args.amend) {
        message = await vscode.window.showInputBox({
          prompt: 'Commit staged changes',
          placeHolder: 'Commit message',
          validateInput: (value) => value.trim() ? undefined : 'Commit message is required'
        });
      }
      if (!message && !args.amend) return;
      await progress(args.amend ? 'Amending commit' : 'Committing staged changes', () =>
        git.commit(message, { amend: !!args.amend, sign: !!args.sign })
      );
      return info('Commit created');
    }
    case 'updateSubmodules':
      return progress('Updating submodules', () => git.updateSubmodules());
    case 'syncSubmodules':
      return progress('Synchronizing submodule URLs', () => git.syncSubmodules());
    case 'removeWorktree': {
      const ok = await confirm(`Remove worktree '${args.path}'?`, 'Remove Worktree');
      if (!ok) return;
      return progress('Removing worktree', () => git.removeWorktree(args.path, !!args.force));
    }
    case 'pruneWorktrees':
      return progress('Pruning stale worktrees', () => git.pruneWorktrees());
    case 'lockWorktree':
      return git.lockWorktree(args.path);
    case 'unlockWorktree':
      return git.unlockWorktree(args.path);
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

function short(sha) {
  return /^[0-9a-f]{7,}$/i.test(sha) ? sha.slice(0, 7) : sha;
}

function info(message) {
  vscode.window.setStatusBarMessage(message, 4000);
}

async function confirm(message, actionLabel) {
  const choice = await vscode.window.showWarningMessage(message, { modal: true }, actionLabel);
  return choice === actionLabel;
}

async function pick(placeHolder, items) {
  return vscode.window.showQuickPick(items, { placeHolder });
}

function progress(title, task) {
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `${title}…` },
    task
  );
}

function validRefName(value) {
  if (!value || !value.trim()) return 'Name is required';
  if (/[\s~^:?*\[\\]|\.\.|@\{|^-|\/$|\.lock$/.test(value)) return 'Invalid ref name';
  return undefined;
}

module.exports = { run };
