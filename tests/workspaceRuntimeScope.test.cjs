const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');
const { spawn } = require('node:child_process');
const { fileURLToPath } = require('node:url');

class MockUri {
  constructor(fsPath, scheme = 'file') {
    this.scheme = scheme;
    this.fsPath = scheme === 'file' ? path.resolve(fsPath) : fsPath;
    this.path = this.fsPath.replace(/\\/g, '/');
  }
  static file(fsPath) { return new MockUri(fsPath); }
  static parse(value) {
    if (value.startsWith('file://')) return new MockUri(fileURLToPath(value));
    const separator = value.indexOf(':');
    if (separator <= 0) throw new Error(`invalid uri: ${value}`);
    return new MockUri(value.slice(separator + 1), value.slice(0, separator));
  }
  static joinPath(base, ...segments) { return new MockUri(path.join(base.fsPath, ...segments), base.scheme); }
  toString() {
    if (this.scheme !== 'file') return `${this.scheme}:${this.path}`;
    const normalized = this.path.replace(/^([A-Z]):/, (_, drive) => `${drive.toLowerCase()}:`);
    return `file://${normalized.startsWith('/') ? '' : '/'}${normalized}`;
  }
}

const vscodeMock = {
  Uri: MockUri,
  FileType: { File: 1, Directory: 2 },
  workspace: {
    fs: {
      createDirectory: (uri) => fs.mkdir(uri.fsPath, { recursive: true }),
      readDirectory: async (uri) => (await fs.readdir(uri.fsPath, { withFileTypes: true }))
        .map((entry) => [entry.name, entry.isDirectory() ? 2 : 1]),
      readFile: (uri) => fs.readFile(uri.fsPath),
      writeFile: async (uri, data) => {
        await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
        await fs.writeFile(uri.fsPath, data);
      },
      stat: async (uri) => {
        const stat = await fs.stat(uri.fsPath);
        return { type: stat.isDirectory() ? 2 : 1, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs };
      },
      copy: (source, target, options) => fs.cp(source.fsPath, target.fsPath, {
        recursive: true,
        force: !!options?.overwrite,
        errorOnExist: !options?.overwrite
      }),
      rename: async (source, target, options) => {
        if (options?.overwrite) await fs.rm(target.fsPath, { recursive: true, force: true });
        await fs.mkdir(path.dirname(target.fsPath), { recursive: true });
        await fs.rename(source.fsPath, target.fsPath);
      },
      delete: (uri, options) => fs.rm(uri.fsPath, { recursive: !!options?.recursive, force: false })
    }
  }
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscodeMock;
  return originalLoad.call(this, request, parent, isMain);
};

const {
  createWorkspaceScopeIdentity,
  resolveWorkspaceRuntimeRoot,
  workspaceLegacyPartitionManifestUri,
  workspaceScopedRuntimeRoot
} = require('../dist/extension/backend/capabilities/vscodeStorage/workspaceScope.js');
const legacyPartition = require('../dist/extension/backend/capabilities/vscodeStorage/legacyPartition.js');
const { createVscodeStoragePaths } = require('../dist/extension/backend/capabilities/vscodeStorage/paths.js');
const { copyStorageRootForMigration } = require('../dist/extension/backend/capabilities/vscodeStorage/migration.js');
const { createEmptyClientState } = require('../dist/extension/shared/clientStateSchema.js');
const { createClientStateSkeletonPatch } = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateSkeletonPatch.js');
const clientStateStore = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateStore.js');
const skeletonTransaction = require('../dist/extension/backend/capabilities/vscodeStorage/clientStateSkeletonTransaction.js');
const historyStore = require('../dist/extension/backend/capabilities/vscodeStorage/conversationHistoryStore.js');

function folderScope(...folders) {
  return createWorkspaceScopeIdentity({ workspaceFolderUris: folders.map(MockUri.file) });
}

async function exists(target) {
  try { await fs.access(target); return true; } catch { return false; }
}

function message(conversationId, suffix, data) {
  return {
    id: `message-${suffix}`,
    conversationId,
    role: 'user',
    content: { parts: data ? [{ inlineData: { mimeType: 'text/plain', data, name: `${suffix}.txt` } }] : [{ text: suffix }] },
    status: 'complete',
    createdAt: 10,
    seq: 1
  };
}

async function saveSkeleton(paths, state) {
  await clientStateStore.saveClientStateSkeletonToStores(
    paths,
    createClientStateSkeletonPatch(createEmptyClientState(), state)
  );
}

async function loadSkeleton(paths) {
  const pin = await skeletonTransaction.openClientStateSkeletonSnapshot(paths, 'workspace-runtime-test');
  if (!pin) return createEmptyClientState();
  try {
    return await clientStateStore.loadClientStateSkeletonSnapshotFromStores(paths, pin) ?? createEmptyClientState();
  } finally {
    await skeletonTransaction.releaseClientStateSkeletonSnapshot(paths, pin);
  }
}

async function seedLegacyFixture(rootPath) {
  const workspaceA = path.join(rootPath, 'workspace-a');
  const workspaceB = path.join(rootPath, 'workspace-b');
  await Promise.all([fs.mkdir(workspaceA, { recursive: true }), fs.mkdir(workspaceB, { recursive: true })]);
  const root = MockUri.file(rootPath);
  const paths = createVscodeStoragePaths(root, root);
  const state = createEmptyClientState();
  const ids = ['conversation-a', 'conversation-b', 'conversation-unbound', 'conversation-invalid', 'conversation-empty'];
  state.conversations.push(...ids.map((id) => ({ id, title: id })));
  state.projectContexts.push(
    { id: 'project-a', kind: 'folder', uri: MockUri.file(workspaceA).toString(), name: 'A', createdAt: 1, updatedAt: 1 },
    { id: 'project-b', kind: 'folder', uri: MockUri.file(workspaceB).toString(), name: 'B', createdAt: 1, updatedAt: 1 },
    { id: 'project-invalid', kind: 'folder', uri: MockUri.file(path.join(rootPath, 'deleted-workspace')).toString(), name: 'gone', createdAt: 1, updatedAt: 1 }
  );
  state.conversationProjectLinks.push(
    { id: 'link-project-a', conversationId: 'conversation-a', projectContextId: 'project-a', role: 'primary', createdAt: 1, updatedAt: 1 },
    { id: 'link-project-b', conversationId: 'conversation-b', projectContextId: 'project-b', role: 'primary', createdAt: 1, updatedAt: 1 },
    { id: 'link-project-invalid', conversationId: 'conversation-invalid', projectContextId: 'project-invalid', role: 'primary', createdAt: 1, updatedAt: 1 }
  );
  state.conversationBranchLinks.push({
    id: 'cross-scope-branch', sourceConversationId: 'conversation-a', targetConversationId: 'conversation-b',
    branchFromMessageId: 'message-a', createdAt: 1, updatedAt: 1
  });
  await saveSkeleton(paths, state);

  const details = new Map([
    ['conversation-a', message('conversation-a', 'a', Buffer.from('attachment-a').toString('base64'))],
    ['conversation-b', message('conversation-b', 'b')],
    ['conversation-unbound', message('conversation-unbound', 'unbound')],
    ['conversation-invalid', message('conversation-invalid', 'invalid')]
  ]);
  for (const [conversationId, record] of details) {
    const detail = createEmptyClientState();
    detail.messages.push(record);
    await clientStateStore.saveConversationRenderDetailToStores(paths, conversationId, createEmptyClientState(), detail);
  }
  for (const id of ids) {
    await historyStore.upsertConversationHistoryEntryInStore(paths, {
      id, title: id, preview: id, messageCount: id === 'conversation-empty' ? 0 : 1,
      status: id === 'conversation-empty' ? 'empty' : 'complete', isRunning: false, updatedAt: 10
    });
  }
  await fs.mkdir(path.join(rootPath, 'settings'), { recursive: true });
  await fs.writeFile(path.join(rootPath, 'settings', 'conversation-conversation-empty-common.json'), JSON.stringify({ conversationId: 'conversation-empty', name: 'must-discard' }));
  await fs.writeFile(path.join(rootPath, 'settings', 'conversation-conversation-a-common.json'), JSON.stringify({ conversationId: 'conversation-a', name: 'A settings' }));
  return { root, paths, workspaceA, workspaceB };
}

async function scopeConversationIds(root, scope) {
  const runtime = workspaceScopedRuntimeRoot(root, scope.scopeKey);
  const state = await loadSkeleton(createVscodeStoragePaths(runtime, root));
  return state.conversations.map((conversation) => conversation.id).sort();
}

function startResolverChild(modulePath, rootPath, workspacePath) {
  const script = String.raw`
const fs = require('node:fs/promises'); const path = require('node:path'); const Module = require('node:module'); const {fileURLToPath}=require('node:url');
class Uri { constructor(p,s='file'){this.scheme=s;this.fsPath=s==='file'?path.resolve(p):p;this.path=this.fsPath.split(path.sep).join('/');}
static file(p){return new Uri(p)} static parse(v){if(v.startsWith('file://'))return new Uri(fileURLToPath(v));const i=v.indexOf(':');return new Uri(v.slice(i+1),v.slice(0,i));}
static joinPath(b,...s){return new Uri(path.join(b.fsPath,...s),b.scheme)} toString(){if(this.scheme!=='file')return this.scheme+':'+this.path;const n=this.path.replace(/^([A-Z]):/,(_,d)=>d.toLowerCase()+':');return 'file://'+(n.startsWith('/')?'':'/')+n}}
const v={Uri,FileType:{File:1,Directory:2},workspace:{fs:{createDirectory:u=>fs.mkdir(u.fsPath,{recursive:true}),readDirectory:async u=>(await fs.readdir(u.fsPath,{withFileTypes:true})).map(e=>[e.name,e.isDirectory()?2:1]),readFile:u=>fs.readFile(u.fsPath),writeFile:async(u,d)=>{await fs.mkdir(path.dirname(u.fsPath),{recursive:true});await fs.writeFile(u.fsPath,d)},stat:async u=>{const s=await fs.stat(u.fsPath);return{type:s.isDirectory()?2:1,size:s.size,mtime:s.mtimeMs,ctime:s.ctimeMs}},copy:(a,b,o)=>fs.cp(a.fsPath,b.fsPath,{recursive:true,force:!!o?.overwrite,errorOnExist:!o?.overwrite}),rename:async(a,b,o)=>{if(o?.overwrite)await fs.rm(b.fsPath,{recursive:true,force:true});await fs.mkdir(path.dirname(b.fsPath),{recursive:true});await fs.rename(a.fsPath,b.fsPath)},delete:(u,o)=>fs.rm(u.fsPath,{recursive:!!o?.recursive,force:false})}}};
const old=Module._load;Module._load=function(r,p,m){return r==='vscode'?v:old.call(this,r,p,m)};
const api=require(process.argv[1]);const root=Uri.file(process.argv[2]);const scope=api.createWorkspaceScopeIdentity({workspaceFolderUris:[Uri.file(process.argv[3])]});
process.send({type:'ready'});process.on('message',async m=>{if(m!=='go')return;try{const runtime=await api.resolveWorkspaceRuntimeRoot(root,scope);process.send({type:'result',runtimePath:runtime.fsPath,scopeKey:scope.scopeKey})}catch(e){process.send({type:'error',message:e?.stack||String(e)})}finally{process.disconnect()}});`;
  const child = spawn(process.execPath, ['-e', script, modulePath, rootPath, workspacePath], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  let stderr = ''; child.stderr.on('data', (chunk) => { stderr += chunk; });
  const waitFor = (type) => new Promise((resolve, reject) => {
    const onMessage = (message) => { if (message?.type === type) { cleanup(); resolve(message); } else if (message?.type === 'error') { cleanup(); reject(new Error(message.message)); } };
    const onExit = (code) => { cleanup(); reject(new Error(`child exited ${code}: ${stderr}`)); };
    const cleanup = () => { child.off('message', onMessage); child.off('exit', onExit); };
    child.on('message', onMessage); child.on('exit', onExit);
  });
  return { child, ready: waitFor('ready'), result: waitFor('result') };
}

test('workspace scope prefers saved workspace file and folder identity is order-independent', () => {
  const folderA = MockUri.file('/workspace/a');
  const folderB = MockUri.file('/workspace/b');
  const workspaceFile = MockUri.file('/workspaces/project.code-workspace');
  const byFileA = createWorkspaceScopeIdentity({ workspaceFileUri: workspaceFile, workspaceFolderUris: [folderA] });
  const byFileB = createWorkspaceScopeIdentity({ workspaceFileUri: workspaceFile, workspaceFolderUris: [folderB] });
  assert.equal(byFileA.scopeKey, byFileB.scopeKey);
  assert.equal(byFileA.source, 'workspaceFile');
  assert.equal(byFileA.canClaimLegacy, true);
  const ordered = createWorkspaceScopeIdentity({ workspaceFolderUris: [folderA, folderB, folderA] });
  const reversed = createWorkspaceScopeIdentity({ workspaceFolderUris: [folderB, folderA] });
  assert.equal(ordered.scopeKey, reversed.scopeKey);
  assert.equal(ordered.scopeKey.length, 64);
  assert.doesNotMatch(ordered.scopeKey, /workspace/i);
});

test('different workspaces isolate runtime indexes while sharing global configuration settings', () => {
  const configurationRoot = MockUri.file('/limcode-data');
  const pathsA = createVscodeStoragePaths(workspaceScopedRuntimeRoot(configurationRoot, folderScope('/workspace/a').scopeKey), configurationRoot);
  const pathsB = createVscodeStoragePaths(workspaceScopedRuntimeRoot(configurationRoot, folderScope('/workspace/b').scopeKey), configurationRoot);
  assert.notEqual(pathsA.conversationsIndexPath, pathsB.conversationsIndexPath);
  assert.notEqual(pathsA.conversationSettingsRootUri.fsPath, pathsB.conversationSettingsRootUri.fsPath);
  assert.equal(pathsA.settingsRootPath, pathsB.settingsRootPath);
  assert.equal(pathsA.globalStoragePath, pathsB.globalStoragePath);
});

test('legacy partition assigns matched and unbound non-empty conversations and fully discards empty conversations', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-legacy-partition-'));
  try {
    const fixture = await seedLegacyFixture(rootPath);
    const scopeA = folderScope(fixture.workspaceA);
    const scopeB = folderScope(fixture.workspaceB);
    const runtimeA = await resolveWorkspaceRuntimeRoot(fixture.root, scopeA);
    const runtimeB = await resolveWorkspaceRuntimeRoot(fixture.root, scopeB);
    assert.equal(runtimeA.fsPath, workspaceScopedRuntimeRoot(fixture.root, scopeA.scopeKey).fsPath);
    assert.equal(runtimeB.fsPath, workspaceScopedRuntimeRoot(fixture.root, scopeB.scopeKey).fsPath);
    assert.deepEqual(await scopeConversationIds(fixture.root, scopeA), ['conversation-a', 'conversation-invalid', 'conversation-unbound']);
    assert.deepEqual(await scopeConversationIds(fixture.root, scopeB), ['conversation-b']);

    const manifest = JSON.parse(await fs.readFile(workspaceLegacyPartitionManifestUri(fixture.root).fsPath, 'utf8'));
    assert.equal(manifest.status, 'committed');
    assert.equal(manifest.firstWorkspaceScopeKey, scopeA.scopeKey);
    assert.deepEqual(manifest.audit, { matched: 2, unboundAssignedToFirst: 2, discardedEmpty: 1, failed: 0 });
    assert.equal(manifest.crossScopeOrigins.length, 1);
    assert.equal(await exists(path.join(runtimeA.fsPath, 'settings', 'conversation-conversation-empty-common.json')), false);
    assert.equal(await exists(path.join(runtimeB.fsPath, 'settings', 'conversation-conversation-empty-common.json')), false);
    assert.equal(await exists(path.join(rootPath, 'settings', 'conversation-conversation-empty-common.json')), true, 'legacy source remains rollback archive');

    const detailA = await clientStateStore.loadConversationDetailFromStores(createVscodeStoragePaths(runtimeA, fixture.root), 'conversation-a');
    const attachment = detailA.messages[0].content.parts[0].inlineData;
    assert.ok(attachment.attachmentId, 'reachable attachment is re-externalized into target scope');
    assert.equal(await exists(path.join(runtimeA.fsPath, 'attachments')), true);

    for (let restart = 0; restart < 3; restart += 1) {
      await resolveWorkspaceRuntimeRoot(fixture.root, restart % 2 ? scopeB : scopeA);
    }
    const afterRestart = JSON.parse(await fs.readFile(workspaceLegacyPartitionManifestUri(fixture.root).fsPath, 'utf8'));
    assert.equal(afterRestart.committedAt, manifest.committedAt);
    assert.deepEqual(await scopeConversationIds(fixture.root, scopeA), ['conversation-a', 'conversation-invalid', 'conversation-unbound']);
  } finally {
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('empty window cannot become first workspace and crash recovery keeps frozen firstWorkspaceScopeKey', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-legacy-recovery-'));
  try {
    const fixture = await seedLegacyFixture(rootPath);
    const empty = createWorkspaceScopeIdentity({ storageUri: MockUri.file(path.join(rootPath, 'empty-window')) });
    await resolveWorkspaceRuntimeRoot(fixture.root, empty);
    assert.equal(await exists(workspaceLegacyPartitionManifestUri(fixture.root).fsPath), false);

    const scopeA = folderScope(fixture.workspaceA);
    let injected = false;
    legacyPartition.__legacyPartitionTestHooks.afterScopePublished = async () => {
      if (!injected) { injected = true; throw new Error('simulated crash after scope publish'); }
    };
    await assert.rejects(() => resolveWorkspaceRuntimeRoot(fixture.root, scopeA), /simulated crash/);
    const preparing = JSON.parse(await fs.readFile(workspaceLegacyPartitionManifestUri(fixture.root).fsPath, 'utf8'));
    assert.equal(preparing.status, 'preparing');
    assert.equal(preparing.firstWorkspaceScopeKey, scopeA.scopeKey);

    legacyPartition.__legacyPartitionTestHooks.afterScopePublished = undefined;
    await resolveWorkspaceRuntimeRoot(fixture.root, folderScope(fixture.workspaceB));
    const committed = JSON.parse(await fs.readFile(workspaceLegacyPartitionManifestUri(fixture.root).fsPath, 'utf8'));
    assert.equal(committed.status, 'committed');
    assert.equal(committed.firstWorkspaceScopeKey, scopeA.scopeKey);
    assert.deepEqual(await scopeConversationIds(fixture.root, scopeA), ['conversation-a', 'conversation-invalid', 'conversation-unbound']);
  } finally {
    legacyPartition.__legacyPartitionTestHooks.afterScopePublished = undefined;
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('first workspace competition is atomic across real child processes', async () => {
  const rootPath = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-legacy-child-race-'));
  const modulePath = require.resolve('../dist/extension/backend/capabilities/vscodeStorage/workspaceScope.js');
  let childA; let childB;
  try {
    const fixture = await seedLegacyFixture(rootPath);
    childA = startResolverChild(modulePath, rootPath, fixture.workspaceA);
    childB = startResolverChild(modulePath, rootPath, fixture.workspaceB);
    await Promise.all([childA.ready, childB.ready]);
    childA.child.send('go'); childB.child.send('go');
    const results = await Promise.all([childA.result, childB.result]);
    const manifest = JSON.parse(await fs.readFile(workspaceLegacyPartitionManifestUri(fixture.root).fsPath, 'utf8'));
    assert.equal(manifest.status, 'committed');
    assert.ok(results.some((result) => result.scopeKey === manifest.firstWorkspaceScopeKey));
    const first = results.find((result) => result.scopeKey === manifest.firstWorkspaceScopeKey);
    const firstState = await loadSkeleton(createVscodeStoragePaths(MockUri.file(first.runtimePath), fixture.root));
    assert.ok(firstState.conversations.some((conversation) => conversation.id === 'conversation-unbound'));
    const allIds = [];
    for (const result of results) {
      const state = await loadSkeleton(createVscodeStoragePaths(MockUri.file(result.runtimePath), fixture.root));
      allIds.push(...state.conversations.map((conversation) => conversation.id));
    }
    assert.equal(allIds.length, new Set(allIds).size, 'partition must not duplicate conversation IDs');
    assert.equal(allIds.includes('conversation-empty'), false);
  } finally {
    childA?.child.kill(); childB?.child.kill();
    await fs.rm(rootPath, { recursive: true, force: true });
  }
});

test('data-root migration includes committed partition manifest and scoped runtime trees', async () => {
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'limcode-workspace-migration-'));
  try {
    const source = MockUri.file(path.join(tempRoot, 'source'));
    const target = MockUri.file(path.join(tempRoot, 'target'));
    const fixture = await seedLegacyFixture(source.fsPath);
    await resolveWorkspaceRuntimeRoot(source, folderScope(fixture.workspaceA));
    const result = await copyStorageRootForMigration(source, target);
    assert.ok(result.copiedEntries.includes('.limcode-workspace-runtimes'));
    assert.equal(await exists(workspaceLegacyPartitionManifestUri(target).fsPath), true);
    assert.equal(await exists(path.join(target.fsPath, '.limcode-workspace-runtimes', 'scopes')), true);
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('restore vscode mock', () => { Module._load = originalLoad; });
