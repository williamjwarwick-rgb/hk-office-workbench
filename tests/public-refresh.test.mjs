import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SOURCES, publicDataOnly, scheduleState, refreshPublicData, updateDataFile } from '../scripts/update-data.mjs';
import { parseRvdRentalCsv } from '../lib/data-utils.ts';

const now = new Date('2026-10-15T01:00:00.000Z');
const fixture = name => readFile(new URL(`./fixtures/raw/${name}`, import.meta.url), 'utf8');
const seed = {
  market: JSON.parse(await readFile(new URL('../data/market.json', import.meta.url), 'utf8')),
  news: JSON.parse(await readFile(new URL('../data/news.json', import.meta.url), 'utf8')),
  buildings: JSON.parse(await readFile(new URL('../data/buildings.json', import.meta.url), 'utf8')),
  updates: { sources: [], status: 'seed_verified', lastCheckedAt: null,
    scheduleEnabled: true, schedule: { provider: 'chatgpt', enabled: true, automationId: 'old-private-task' } },
};
const csvFiles = {
  'rvd-rental': 'rvd_rent_index.csv', 'rvd-district-rents': 'rvd_district_rents.csv',
  'rvd-price-index': 'rvd_price_index.csv', 'rvd-office-sales': 'rvd_office_sales.csv',
  'rvd-completions': 'rvd_completions.csv', 'rvd-stock': 'rvd_stock.csv',
  'rvd-takeup': 'rvd_takeup.csv', 'rvd-vacancy': 'rvd_vacancy.csv',
  'rvd-district-stock': 'rvd_district_stock.csv',
};
const rss = (language = 'zh-Hant') => `<?xml version="1.0"?><rss><channel><title>Government</title><item><title>${language === 'en' ? 'Hong Kong office leasing market update' : '香港寫字樓租賃市場更新'}</title><link>https://www.info.gov.hk/gia/general/202610/15/P2026101500123${language === 'en' ? '.htm' : '.html'}</link><description>香港寫字樓市場、企業租賃需求資料</description><pubDate>Thu, 15 Oct 2026 00:30:00 GMT</pubDate></item></channel></rss>`;
async function fixtureFetch(url) {
  const source = SOURCES.find(source => source.url === url);
  if (!source) throw new Error('Unexpected URL: fixture tests never use network');
  if (csvFiles[source.id]) return new Response(await fixture(csvFiles[source.id]));
  if (source.kind === 'rss') return new Response(rss(source.language));
  return new Response('<!doctype html><html><head><title>Report list</title></head><body><a href="/reports/hong-kong-marketbeat.pdf">Public quarterly report</a></body></html>');
}

test('only public research fields survive export; imported private state is stripped', () => {
  const input = structuredClone(seed);
  input.bookmarks = ['private-news']; input.snapshots = [{ owner: 'private@example.com' }];
  input.accounts = ['private@example.com']; input.market.credentials = 'secret';
  input.updates.serviceToken = 'secret';
  const output = publicDataOnly(input);
  assert.deepEqual(Object.keys(output), ['market', 'news', 'buildings', 'updates']);
  assert.equal(output.market.credentials, undefined);
  assert.equal(output.updates.serviceToken, undefined);
  assert.equal(JSON.stringify(output).includes('private@example.com'), false);
  assert.throws(() => publicDataOnly({ market: {} }), /不完整/);
});

test('GitHub schedule is verified only by an actual Actions schedule event', () => {
  const fakeOld = seed.updates.schedule;
  const push = scheduleState(fakeOld, { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push' }, now.toISOString());
  assert.equal(push.enabled, false); assert.equal(push.lastEvent, 'push');
  assert.equal(scheduleState(fakeOld, { GITHUB_EVENT_NAME: 'schedule' }, now.toISOString()).enabled, false);
  const scheduled = scheduleState(fakeOld, { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'schedule', GITHUB_REPOSITORY: 'owner/research', GITHUB_RUN_ID: '12345' }, now.toISOString());
  assert.equal(scheduled.enabled, true); assert.equal(scheduled.verification, 'observed_schedule_event');
  assert.equal(scheduled.lastScheduledRunUrl, 'https://github.com/owner/research/actions/runs/12345');
  const manual = scheduleState(scheduled, { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'workflow_dispatch' }, now.toISOString());
  assert.equal(manual.enabled, true); assert.equal(manual.lastEvent, 'workflow_dispatch');
  assert.equal(manual.lastScheduledAt, scheduled.lastScheduledAt);
  assert.equal(JSON.stringify(push).includes('old-private-task'), false);
});

test('all 17 sources parse fixtures, preserve series history and deduplicate language variants', async () => {
  assert.equal(SOURCES.length, 17);
  const data = await refreshPublicData(seed, { fetchImpl: fixtureFetch, now, env: {} });
  assert.equal(data.updates.status, 'success');
  assert.equal(data.updates.successfulSourceCount, 17);
  assert.equal(data.updates.scheduleEnabled, false);
  assert.equal(data.updates.trigger, 'local');
  assert.equal(data.buildings.length, seed.buildings.length);
  for (const series of seed.market.series) {
    const refreshed = data.market.series.find(candidate => candidate.id === series.id);
    if (!series.id.includes('-ytd-')) assert.ok(refreshed.points.length >= series.points.length, series.id);
  }
  const article = data.news.find(article => article.url?.includes('P2026101500123'));
  assert.ok(article); assert.equal(article.reviewStatus, 'pending'); assert.equal(article.confidence, 'low');
  assert.equal(data.news.filter(article => article.url?.includes('P2026101500123')).length, 1);
  assert.ok(article.languageVariants.some(variant => variant.language === 'en'));
  const again = await refreshPublicData(data, { fetchImpl: fixtureFetch, now, env: {} });
  assert.equal(again.news.length, data.news.length);
  assert.equal(again.updates.sources.find(source => source.id === 'rvd-rental').status, 'unchanged');
  assert.equal(data.market.series.find(series => series.id === 'rvd-rent-a').points.at(-1).sourceId, 'rvd-rental');
});

test('rejected or older upstream data cannot shorten observations or remove old provenance', async () => {
  const input = structuredClone(seed), rental = input.market.series.find(series => series.id === 'rvd-rent-a');
  rental.points.push({ period: '2099-01', value: 100, sourceUrl: 'https://www.rvd.gov.hk/verified-future-csv' });
  input.updates.sources = [{ id: 'rvd-rental', hash: 'old-verified-hash', lastSuccessfulAt: '2026-10-01T00:00:00.000Z' }];
  const data = await refreshPublicData(input, { fetchImpl: fixtureFetch, now, env: {}, sources: [SOURCES[0]] });
  assert.equal(data.updates.status, 'failed');
  assert.deepEqual(data.market.series, input.market.series);
  assert.equal(data.updates.sources[0].hash, 'old-verified-hash');
  assert.equal(data.updates.sources[0].lastSuccessfulAt, '2026-10-01T00:00:00.000Z');
  assert.match(data.updates.sources[0].message, /观察期倒退/);
});

test('an unchanged observation retains its known publication date', async () => {
  const input = structuredClone(seed), parsed = parseRvdRentalCsv(await fixture('rvd_rent_index.csv'));
  const series = input.market.series.find(series => series.id === 'rvd-rent-a');
  series.points = parsed['rvd-rent-a'].map(point => ({ ...point, publishedAt: '2026-09-30', note: 'verified publication date' }));
  const data = await refreshPublicData(input, { fetchImpl: fixtureFetch, now, env: {}, sources: [SOURCES[0]] });
  const point = data.market.series.find(series => series.id === 'rvd-rent-a').points.at(-1);
  assert.equal(point.publishedAt, '2026-09-30'); assert.equal(point.note, 'verified publication date');
});

test('total upstream failure writes visible status atomically while retaining all public records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'public-workbench-'));
  try {
    const path = join(directory, 'workbench.json');
    await writeFile(path, JSON.stringify(seed));
    const updates = await updateDataFile(path, { fetchImpl: async () => new Response('upstream unavailable', { status: 503 }), now, env: {} });
    assert.equal(updates.status, 'failed'); assert.equal(updates.successfulSourceCount, 0);
    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.deepEqual(saved.market.series, seed.market.series);
    assert.deepEqual(saved.news, seed.news); assert.deepEqual(saved.buildings, seed.buildings);
    assert.equal(saved.updates.sources.length, 17);
    assert.deepEqual(await readdir(directory), ['workbench.json']);
    await assert.rejects(() => updateDataFile(join(directory, 'missing.json'), { fetchImpl: fixtureFetch }), { code: 'ENOENT' });
    assert.deepEqual(await readdir(directory), ['workbench.json']);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('partial failure retains the failed source while applying valid other sources', async () => {
  const data = await refreshPublicData(seed, { fetchImpl: async url => url === SOURCES[0].url
    ? new Response('<html>Unexpected error</html>') : fixtureFetch(url), now, env: {}, sources: SOURCES.slice(0, 2) });
  assert.equal(data.updates.status, 'partial'); assert.equal(data.updates.successfulSourceCount, 1);
  assert.deepEqual(data.market.series.find(series => series.id === 'rvd-rent-a'), seed.market.series.find(series => series.id === 'rvd-rent-a'));
  assert.equal(data.updates.sources.find(source => source.id === 'rvd-district-rents').status, 'updated');
});
