'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));

function walk(dir, predicate, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, predicate, out);
    else if (predicate(full)) out.push(full);
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
}

function testSyntax() {
  const jsFiles = walk(root, (file) => file.endsWith('.js'));
  for (const file of jsFiles) {
    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
  }
  readJson('package.json');
  console.log(`✓ syntax checked ${jsFiles.length} JS files and package.json`);
}

function testManifestCommands() {
  const pkg = readJson('package.json');
  const extensionSource = fs.readFileSync(path.join(root, 'src', 'extension.js'), 'utf8');
  const commandIds = (pkg.contributes.commands || []).map((command) => command.command);
  assert(commandIds.length > 0, 'No contributed commands found.');
  assert.strictEqual(new Set(commandIds).size, commandIds.length, 'Duplicate contributed command IDs found.');

  const registeredCommands = new Set([
    ...[...extensionSource.matchAll(/register\('([^']+)'/g)].map((m) => m[1]),
    ...[...extensionSource.matchAll(/registerCommand\('([^']+)'/g)].map((m) => m[1])
  ]);
  for (const command of commandIds) {
    assert(registeredCommands.has(command), `Contributed command is not registered: ${command}`);
  }

  const menuCommands = Object.values(pkg.contributes.menus || {})
    .flat()
    .map((item) => item.command)
    .filter(Boolean);
  for (const command of menuCommands) {
    assert(commandIds.includes(command), `Menu references a non-contributed command: ${command}`);
  }
  console.log(`✓ verified ${commandIds.length} commands and ${menuCommands.length} menu entries`);
}

function testManifestViewsAndConfig() {
  const pkg = readJson('package.json');
  assert.deepStrictEqual(pkg.extensionKind, ['workspace'], 'GitTree must run in the Node workspace extension host.');
  assert.strictEqual(pkg.capabilities?.virtualWorkspaces?.supported, false, 'Virtual workspaces must remain unsupported.');
  assert.strictEqual(pkg.capabilities?.untrustedWorkspaces?.supported, false, 'Untrusted workspaces must remain unsupported.');
  assert(pkg.main && !pkg.browser, 'GitTree must expose a Node main entry and no Web Worker entry.');
  const containers = pkg.contributes.viewsContainers?.activitybar || [];
  assert(containers.some((container) => container.id === 'gitTree'), 'GitTree activity bar container missing.');

  const views = pkg.contributes.views?.gitTree || [];
  const expectedViews = [
    'gitTree.commitInput',
    'gitTree.changes',
    'gitTree.branches',
    'gitTree.stashes',
    'gitTree.tags',
    'gitTree.worktrees',
    'gitTree.submodules',
    'gitTree.pullRequests'
  ];
  for (const view of expectedViews) {
    assert(views.some((entry) => entry.id === view), `Missing view contribution: ${view}`);
  }

  const settings = pkg.contributes.configuration?.properties || {};
  for (const setting of [
    'gitTree.maxCommits',
    'gitTree.showRemoteBranches',
    'gitTree.blame.enabled',
    'gitTree.dateFormat',
    'gitTree.azureDevOps.repositoryUrl',
    'gitTree.azureDevOps.endpoint',
    'gitTree.azureDevOps.organization',
    'gitTree.azureDevOps.project',
    'gitTree.azureDevOps.repository'
  ]) {
    assert(settings[setting], `Missing setting: ${setting}`);
  }
  console.log(`✓ verified ${views.length} views and ${Object.keys(settings).length} settings`);
}

function testGitParsers() {
  const { _test } = require(path.join(root, 'src', 'git.js'));
  const refs = _test.parseRefs('HEAD -> main, tag: v1.0.0, origin/main, feature/x');
  assert.deepStrictEqual(refs, [
    { type: 'branch', name: 'main', head: true },
    { type: 'tag', name: 'v1.0.0' },
    { type: 'remote', name: 'origin/main' },
    { type: 'remote', name: 'feature/x' }
  ]);

  const files = _test.zipFileStats(
    ['A\tREADME.md', 'M\tsrc/index.js', 'D\told.js', 'R100\told-name.js\tnew-name.js'].join('\n'),
    ['10\t0\tREADME.md', '3\t2\tsrc/index.js', '0\t4\told.js', '1\t1\told-name.js => new-name.js'].join('\n')
  );
  assert.deepStrictEqual(files.map((file) => file.status), ['A', 'M', 'D', 'R']);
  assert.strictEqual(files[0].additions, 10);
  assert.strictEqual(files[1].deletions, 2);
  assert.strictEqual(files[2].path, 'old.js');
  assert.strictEqual(files[3].origPath, 'old-name.js');
  assert.strictEqual(files[3].path, 'new-name.js');
  console.log('✓ verified Git ref and changed-file parsers');
}

function testFeatureSurface() {
  const pkg = readJson('package.json');
  const commands = new Set((pkg.contributes.commands || []).map((command) => command.command));
  const required = [
    'gitTree.showGraph',
    'gitTree.openChange',
    'gitTree.openChangeFile',
    'gitTree.revealChangeInExplorer',
    'gitTree.copyChangePath',
    'gitTree.copyChangeRelativePath',
    'gitTree.checkoutBranch',
    'gitTree.compareRefs',
    'gitTree.interactiveRebase',
    'gitTree.stashAdvanced',
    'gitTree.openPullRequests',
    'gitTree.openPullRequestDetails',
    'gitTree.setAzureDevOpsToken',
    'gitTree.fileHistory',
    'gitTree.toggleBlame'
  ];
  for (const command of required) assert(commands.has(command), `Missing feature command: ${command}`);

  const sourceChecks = [
    ['src/views.js', /PullRequestsProvider/, 'Pull Requests provider'],
    ['src/views.js', /ChangesProvider/, 'Changes provider'],
    ['src/views.js', /BranchesProvider/, 'Branches provider'],
    ['src/prPanel.js', /vscode\.diff/, 'PR file diff opening'],
    ['src/prPanel.js', /azurePullRequestChanges/, 'Azure PR changes fallback'],
    ['src/graphPanel.js', /GraphPanel/, 'Commit graph panel'],
    ['src/blame.js', /BlameController/, 'Inline blame controller'],
    ['src/commitView.js', /CommitViewProvider/, 'Commit input webview']
  ];
  for (const [file, pattern, label] of sourceChecks) {
    assert(pattern.test(fs.readFileSync(path.join(root, file), 'utf8')), `Missing feature surface: ${label}`);
  }
  console.log(`✓ verified feature surface for ${required.length} core commands`);
}

function main() {
  if (!args.has('--unit-only')) testSyntax();
  if (!args.has('--syntax-only')) {
    testManifestCommands();
    testManifestViewsAndConfig();
    testGitParsers();
    testFeatureSurface();
  }
  console.log('All tests passed.');
}

main();
