import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const dir = await mkdtemp(join(tmpdir(), 'office-public-test-'));
const transpile = value => ts.transpileModule(value, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText;
await writeFile(join(dir, 'data-utils.mjs'), transpile(await readFile(new URL('../lib/data-utils.ts', import.meta.url), 'utf8')));
await writeFile(join(dir, 'public-store.mjs'), transpile(await readFile(new URL('../lib/public-store.ts', import.meta.url), 'utf8')).replaceAll('"./data-utils"', '"./data-utils.mjs"'));
const { createPublicApi, createIndexedDbStore } = await import(pathToFileURL(join(dir, 'public-store.mjs')));
test.after(() => rm(dir, { recursive: true, force: true }));
const clone = value => structuredClone(value);
const source = () => ({ market: { series: [{ id: 'rent', points: [{ period: '2026-08', value: 100, publishedAt: '2026-09-10' }, { period: '2026-09', value: 102, publishedAt: '2026-10-01' }] }], districts: [], headlines: [] }, news: [{ id: 'n1', title: 'Earlier', date: '2026-09-20' }, { id: 'n2', title: 'Later', publishedAt: '2026-09-30T16:30:00Z' }], buildings: [{ id: 'b1', rent: 30 }], updates: { status: 'published', lastCheckedAt: '2026-10-01T02:00:00Z' }, bookmarks: ['private-record'], snapshots: [{ id: 'private' }], owner: 'never-import' });
function memoryStore() {
  const bookmarks = new Map(), snapshots = new Map();
  return {
    async listBookmarks() { return [...bookmarks.keys()]; },
    async setBookmark(id, selected, createdAt) { if (selected) bookmarks.set(id, createdAt); else bookmarks.delete(id); },
    async listSnapshots() { return [...snapshots.values()].map(({ id, title, month, cutoff, createdAt }) => ({ id, title, month, cutoff, createdAt })); },
    async getSnapshot(id) { return clone(snapshots.get(id)); },
    async addSnapshot(snapshot) { if (snapshots.has(snapshot.id)) throw new Error('duplicate'); snapshots.set(snapshot.id, clone(snapshot)); },
  };
}
function setup(extra = {}) {
  let data = source(), requests = [], count = 0;
  const store = extra.store || memoryStore();
  const api = createPublicApi({ baseUrl: '/hk-office/', store, now: () => new Date('2026-10-14T16:15:00Z'), uuid: () => `snapshot-${++count}`, fetcher: async (url, options) => { requests.push({ url, options }); return { ok: true, json: async () => clone(data) }; }, ...extra });
  return { api, requests, store, change: value => { data = value; } };
}
const input = () => ({ title: ' September report ', month: '2026-09', cutoff: '2026-09-30', notes: 'my research', selectedNewsIds: ['n1', 'n2'] });

test('project-relative public read omits credentials and never imports old accounts or records', async () => {
  const { api, requests } = setup(); const result = await api('/api/workbench');
  assert.equal(requests[0].url, '/hk-office/data/workbench.json'); assert.equal(requests[0].options.credentials, 'omit');
  assert.deepEqual(result.bookmarks, []); assert.deepEqual(result.snapshots, []); assert.equal(result.owner, undefined);
  assert.equal(result.market.series[0].points[0].value, 100);
});
test('bookmark writes are local, reject unknown selected IDs and preserve exact boolean semantics', async () => {
  const { api, requests } = setup(); await api('/api/workbench');
  assert.deepEqual(await api('/api/bookmarks', 'POST', { id: 'n1', selected: true }), { bookmarks: ['n1'] });
  assert.deepEqual((await api('/api/workbench')).bookmarks, ['n1']);
  await assert.rejects(api('/api/bookmarks', 'POST', { id: 'n1', selected: 'false' }), /参数/);
  await assert.rejects(api('/api/bookmarks', 'POST', { id: 'missing', selected: true }), /不存在/);
  await api('/api/bookmarks', 'POST', { id: 'n1', selected: false });
  assert.deepEqual((await api('/api/workbench')).bookmarks, []);
  assert.ok(requests.every(r => !r.options.method || r.options.method === 'GET'));
});
test('snapshot freezes known observation and publication cutoffs including Hong Kong midnight', async () => {
  const { api } = setup(); const saved = await api('/api/snapshots', 'POST', input());
  const snap = await api(`/api/snapshots?id=${saved.snapshot.id}`);
  assert.equal(snap.title, 'September report'); assert.deepEqual(snap.news.map(n => n.id), ['n1']);
  assert.deepEqual(snap.market.series[0].points.map(p => p.period), ['2026-08']);
  assert.match(snap.storageNote, /不跨设备/); assert.match(snap.historicalPublicationCaveat, /不能视为/);
  assert.equal((await api('/api/snapshots')).snapshots.length, 1);
});
test('existing snapshots remain frozen after public refresh and returned-object mutation', async () => {
  const { api, change } = setup(); const { snapshot } = await api('/api/snapshots', 'POST', input());
  const first = await api(`/api/snapshots?id=${snapshot.id}`); first.buildings[0].rent = 999;
  const changed = source(); changed.market.series[0].points[0].value = 222; changed.buildings[0].rent = 88; change(changed);
  await api('/api/refresh', 'POST', {});
  const frozen = await api(`/api/snapshots?id=${snapshot.id}`);
  assert.equal(frozen.market.series[0].points[0].value, 100); assert.equal(frozen.buildings[0].rent, 30);
});
test('snapshot dates use Hong Kong today, reject invalid calendar dates and malformed body', async () => {
  const { api } = setup(); await api('/api/snapshots', 'POST', { ...input(), cutoff: '2026-10-15' });
  for (const bad of [null, [], { ...input(), cutoff: '2026-10-16' }, { ...input(), cutoff: '2026-02-30' }, { ...input(), month: '2026-13' }, { ...input(), title: ' ' }, { ...input(), notes: 8 }, { ...input(), selectedNewsIds: [5] }, { ...input(), selectedNewsIds: ['unknown'] }]) await assert.rejects(api('/api/snapshots', 'POST', bad));
});
test('empty selected news freezes no articles and deduplicates explicit selections', async () => {
  const { api } = setup(); const empty = await api('/api/snapshots', 'POST', { ...input(), selectedNewsIds: [] });
  assert.deepEqual((await api(`/api/snapshots?id=${empty.snapshot.id}`)).news, []);
  const saved = await api('/api/snapshots', 'POST', { ...input(), selectedNewsIds: ['n1', 'n1'] });
  assert.deepEqual((await api(`/api/snapshots?id=${saved.snapshot.id}`)).selectedNewsIds, ['n1']);
});
test('refresh reloads the published JSON, reports skipped collection and preserves actual source timestamp', async () => {
  const { api, requests } = setup(); const result = await api('/api/refresh', 'POST', {});
  assert.equal(result.updates.skipped, true); assert.match(result.updates.message, /不会现场抓取/);
  assert.equal(result.updates.lastCheckedAt, '2026-10-01T02:00:00Z'); assert.equal(requests.length, 1);
});
test('unsupported endpoints, methods and body-on-GET cannot become mutations or remote calls', async () => {
  const { api, requests } = setup();
  for (const args of [['/api/service/source', 'POST', {}], ['/api/session'], ['/api/workbench', 'POST', {}], ['/api/snapshots', 'DELETE'], ['https://other.test/api/workbench'], ['/api/workbench', 'GET', {}]]) await assert.rejects(api(...args));
  assert.equal(requests.length, 0);
});
test('storage failures keep public reading available but never claim local write success', async () => {
  const fail = async () => { throw new Error('quota exhausted'); };
  const { api } = setup({ store: { listBookmarks: fail, listSnapshots: fail, getSnapshot: fail, setBookmark: fail, addSnapshot: fail } });
  const result = await api('/api/workbench'); assert.match(result.localStorageWarning, /存储不可用/); assert.ok(result.news.length);
  await assert.rejects(api('/api/bookmarks', 'POST', { id: 'n1', selected: true }), /quota/);
  await assert.rejects(api('/api/snapshots', 'POST', input()), /quota/);
});
test('public read rejects non-JSON, bad structures and HTTP errors without false refresh success', async () => {
  for (const fetcher of [async () => ({ ok: false, status: 503 }), async () => ({ ok: true, json: async () => { throw new Error(); } }), async () => ({ ok: true, json: async () => ({ news: [] }) })]) {
    const { api } = setup({ fetcher }); await assert.rejects(api('/api/refresh', 'POST', {}));
  }
});
test('separate browser storage has no cross-device records and duplicate snapshot IDs cannot overwrite', async () => {
  const one = setup({ uuid: () => 'same-id' }), two = setup();
  const original = await one.api('/api/snapshots', 'POST', input());
  await assert.rejects(one.api('/api/snapshots', 'POST', { ...input(), notes: 'overwrite' }), /duplicate/);
  assert.equal((await one.api(`/api/snapshots?id=${original.snapshot.id}`)).notes, 'my research');
  await assert.rejects(two.api(`/api/snapshots?id=${original.snapshot.id}`), /本机未找到/);
});

/** Minimal IDB event fixture tests the production transaction wrapper's lifecycle,
 * particularly request success followed by abort (a real quota/commit failure pattern).
 * This is not a substitute for real-browser IndexedDB QA. */
function fakeFactory({ abortAfterSuccess = false, blocked = false } = {}) {
  const state = { bookmarks: new Map(), snapshots: new Map() };
  const db = { objectStoreNames: { contains: () => true }, close() {}, transaction(name) {
    const tx = { abort() { tx.onabort?.(); }, objectStore() {
      const request = work => { const req = {}; queueMicrotask(() => { try { req.result = clone(work()); req.onsuccess?.(); queueMicrotask(() => { if (abortAfterSuccess) tx.onabort?.(); else tx.oncomplete?.(); }); } catch { req.onerror?.(); tx.onabort?.(); } }); return req; };
      return { getAll: () => request(() => [...state[name].values()]), get: id => request(() => state[name].get(id)), put: value => request(() => { state[name].set(value.id, clone(value)); return value.id; }), add: value => request(() => { if (state[name].has(value.id)) throw new Error(); state[name].set(value.id, clone(value)); return value.id; }), delete: id => request(() => { state[name].delete(id); }) };
    } }; return tx;
  } };
  return { open() { const req = {}; queueMicrotask(() => { if (blocked) req.onblocked?.(); else { req.result = db; req.onsuccess?.(); } }); return req; } };
}
test('actual IndexedDB wrapper persists across adapter instances and returns summaries', async () => {
  const factory = fakeFactory(), store = createIndexedDbStore(() => factory), other = createIndexedDbStore(() => factory);
  await store.setBookmark('n1', true, '2026-10-01'); assert.deepEqual(await other.listBookmarks(), ['n1']);
  await store.addSnapshot({ id: 's1', title: 'T', month: '2026-09', cutoff: '2026-09-30', createdAt: '2026-10-01', notes: 'frozen' });
  assert.equal((await other.getSnapshot('s1')).notes, 'frozen'); assert.equal((await store.listSnapshots())[0].notes, undefined);
  await assert.rejects(store.addSnapshot({ id: 's1' }));
  await store.setBookmark('n1', false, '2026-10-02'); assert.deepEqual(await other.listBookmarks(), []);
});
test('request success followed by transaction abort rejects instead of falsely confirming a save', async () => {
  const store = createIndexedDbStore(() => fakeFactory({ abortAfterSuccess: true }));
  await assert.rejects(store.setBookmark('n1', true, '2026-10-01'), /未能保存/);
  await assert.rejects(store.addSnapshot({ id: 's1' }), /未能保存/);
});
test('missing or blocked IndexedDB fails explicitly and can be retried', async () => {
  const missing = createIndexedDbStore(() => undefined); await assert.rejects(missing.listBookmarks(), /未能保存/); await assert.rejects(missing.listBookmarks(), /未能保存/);
  const blocked = createIndexedDbStore(() => fakeFactory({ blocked: true })); await assert.rejects(blocked.listSnapshots(), /未能保存/);
});
