// Rendering/interaction fixture only. Every API and external request is blocked
// or answered locally; no account authentication or provider is exercised.
export const org = { id: 'parity-org', name: 'Synthetic parity organization', createdAt:'2026-10-22T09:00:00Z', role: 'admin', libraryAccess: 'write' };
export const project = { id: 'parity-project', orgId: org.id, name: 'Parity workspace', status: 'ready', access: 'write' };
export const folder = { id: 'parity-folder', name: 'Long folder with retained references and supporting records', rootPath: '.WovenMatter/Records', referencePaths: ['Reference inputs'], pinned: true, position: 0 };
export const base = `/enterprise/organizations/${org.id}`;
export const workspace = `${base}/workspaces/${project.id}?folder=all&conversation=parity-chat`;
export const markdown = (revision = 1) => `## Complete retained response\n\nRevision ${revision}\n\n\`\`\`js\nconst revision = ${revision};\n\`\`\`\n\n| Item | Revision |\n| --- | ---: |\n| Record | ${revision} |\n\n[Protected source](/enterprise/api/files/parity-file/content)\n\n[Unsafe](javascript:alert(1))\n\n![Remote image](https://example.invalid/tracker.png)\n\n<script>window.unsafeMarkdown = true</script>`;
export async function parityFixture(page, { theme = 'green', emptyModels = false, baseURL } = {}) {
  const origin = new URL(baseURL).origin;
  const state = {
    revision: 1, disabled: false, createdBy: 'parity-owner', reads: [], writes: [], external: [], unknown: [],
    models: emptyModels ? [] : [{ id: 'parity-model', name: 'Synthetic selected model', provider: 'openai', thinkingLevels: ['off', 'high'] }, { id: 'other-model', name: 'Other synthetic model', provider: 'openrouter', thinkingLevels: [] }],
  };
  await page.addInitScript(() => {
    // Multiple fixture registrations can share a Page. Init scripts persist
    // across navigations; install document globals only once per document.
    if (window.paritySources) return;
    window.paritySources = [];
    window.EventSource = class extends EventTarget {
      constructor(url) {
        super(); this.url = url; window.paritySources.push(this);
        setTimeout(() => this.onopen?.(new Event('open')), 0);
      }
      close() { window.paritySources = window.paritySources.filter((source) => source !== this); }
    };
    window.clipboardWrites = [];
    window.pendingClipboard = [];
    window.holdClipboard = false;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (text) => {
      window.clipboardWrites.push(text);
      return window.holdClipboard ? new Promise((resolve, reject) => window.pendingClipboard.push({ resolve, reject })) : Promise.resolve();
    } } });
  });
  const chat = () => ({ id: 'parity-chat', title: 'Retained parity conversation', mode: 'write', effectiveMode: 'write', harness: 'pi', pi: {}, createdBy: state.createdBy, folderId: folder.id, workingDirectory: folder.rootPath, workspaceLocked: state.disabled, model: emptyModels ? '' : 'parity-model', lastEventId: 0 });
  const asset = { id: 'parity-asset', projectId: null, name: 'Parity asset', url: '/enterprise/reports/parity-asset', visibility: 'organization', status: 'draft', canManage: true, canEdit: true, revision: 1, document: { version: 1, blocks: [] }, versions: [] };
  await page.context().route('**/*', async (route) => {
    const url = new URL(route.request().url());
    // baseURL comes from the test configuration; no external requests escape.
    if (url.origin !== origin) { state.external.push(url.href); return route.abort('blockedbyclient'); }
    if (url.pathname.startsWith('/enterprise/reports/parity-asset/')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic draft</title><p>Isolated draft preview</p>' });
    if (!url.pathname.startsWith('/enterprise/api/')) return route.continue();
    const path = url.pathname.slice('/enterprise/api'.length);
    if (route.request().method() !== 'GET') { state.writes.push(path); return route.fulfill({ status: 403, json: { error: { message: 'Fixture forbids mutations' } } }); }
    state.reads.push(path);
    if (path === '/files/parity-file/content') return route.fulfill({ headers: { 'content-type': 'text/plain', 'content-disposition': 'inline; filename=parity.txt' }, body: 'Complete synthetic protected source.' });
    let result;
    const list = (items) => ({ items });
    if (path === '/session') result = { user: { id: 'parity-owner', role: 'owner', name: 'Synthetic owner', email: 'parity@example.test', theme }, csrfToken: null };
    else if (path === '/organizations') result = list([org]);
    else if (path === '/hosts') result = list([{ id: 'local', name: 'Synthetic host' }]);
    else if (path.endsWith('/projects')) result = list([project]);
    else if (path === `/projects/${project.id}`) result = project;
    else if (path.endsWith('/agent-settings')) result = { defaultHarness: 'pi', agents: {} };
    else if (path.includes('/workspace-content')) result = list([]);
    else if (path.endsWith('/folders')) result = list([folder]);
    else if (path.endsWith('/conversations')) result = list([chat()]);
    else if (path === '/conversations/parity-chat') result = chat();
    else if (path.endsWith('/messages')) result = { items: [{ id: 'parity-response', role: 'assistant', content: markdown(state.revision), citations: [{ label: 'Retained citation', url: '/enterprise/api/files/parity-file/content?projectId=parity-project&versionId=parity-version', page: 2 }], createdAt: '2026-10-18T12:00:00Z' }], hasMore: false };
    else if (path.endsWith('/runs')) result = list(state.disabled ? [{ id: 'parity-run', status: 'running' }] : []);
    else if (path.endsWith('/activities')) result = { items: [], cursor: '0', hasMore: false };
    else if (path.endsWith('/inference/models')) result = list(state.models);
    else if (path.endsWith('/inference/accounts')) result = { configured: true, items: [
      { id: 'parity-key', label: 'OpenAI key fixture', provider: 'openai', type: 'api_key', priority: 3, enabled: true, status: 'active' },
      { id: 'parity-sub', label: 'OpenAI subscription fixture', provider: 'openai', type: 'subscription', priority: 5, enabled: true, status: 'active' },
      { id: 'router-key', label: 'OpenRouter fixture', provider: 'openrouter', type: 'api_key', priority: 1, enabled: false, status: 'active' },
    ] };
    else if (path.endsWith('/inference/usage') || path.endsWith('/inference/oauth')) result = list([]);
    else if (path.endsWith('/assets')) result = list([asset]);
    else if (path === '/assets/parity-asset') result = asset;
    else if (path === '/assets/parity-asset/agent') result = { conversation: chat(), state: 'idle', sources: [] };
    else if (path === '/files') result = { items: [], access: 'write' };
    else if (path.endsWith('/library/share-targets')) result = list([project]);
    else if (path.endsWith('/members') || path.includes('/archive')) result = list([]);
    else { state.unknown.push(path); result = list([]); }
    return route.fulfill({ json: result });
  });
  state.refresh = async (type = 'assistant.snapshot') => {
    const read = page.waitForResponse((response) => new URL(response.url()).pathname.endsWith('/conversations/parity-chat/messages'));
    await page.evaluate((type) => {
      const source = window.paritySources.find((source) => source.url.includes('/conversations/parity-chat/events'));
      if (!source) throw Error('Conversation event subscription missing');
      source.dispatchEvent(new MessageEvent(type, { data: JSON.stringify({ type }) }));
    }, type);
    await read;
  };
  return state;
}

// Independently gate each Connections resource without clocks or network access.
export async function connectionResources(page) {
  const bodies = {
    accounts: { configured: true, items: [{ id: 'state-key', label: 'Retained organization key', provider: 'openrouter', type: 'api_key', priority: 7, enabled: false, status: 'cooldown' }] },
    models: { items: [{ id: 'state-model', name: 'Retained available model', provider: 'openrouter' }] },
    usage: { items: [{ provider: 'openrouter', successes: 23, failures: 4 }] },
  };
  const resources = Object.fromEntries(Object.keys(bodies).map(name => {
    const entry = { mode: 'loading', reads: 0, pending: [] };
    entry.reply = mode => { entry.mode = mode; entry.pending.splice(0).forEach(resolve => resolve()); };
    return [name, entry];
  }));
  await page.route(/\/inference\/(accounts|models|usage)$/, async route => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1);
    const entry = resources[name];
    entry.reads++;
    if (entry.mode === 'loading') await new Promise(resolve => entry.pending.push(resolve));
    if (['error', 'forbidden'].includes(entry.mode)) return route.fulfill({ status: entry.mode === 'error' ? 503 : 403, json: { error: { message: `Synthetic ${name} unavailable` } } });
    return route.fulfill({ json: entry.mode === 'empty' ? { ...bodies[name], items: [] } : bodies[name] });
  });
  return resources;
}
