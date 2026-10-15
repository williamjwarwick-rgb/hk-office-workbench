#!/usr/bin/env node
/** Node 22: node --experimental-strip-types scripts/update-data.mjs [data-file]
 * Refresh public research data without a Worker, account or database.
 * Upstream failures are recorded and published; invalid/missing local data fails closed.
 */
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  applyRvdPoints, applyDistrictVacancy, validateSeriesContinuity,
  parseRvdAdditionalCsv, parseRvdDistrictVacancy, parseRvdRentalCsv,
  parseRvdDistrictCsv, parseRss, mergeNews, hongKongDate,
} from '../lib/data-utils.ts';

export const SOURCES = Object.freeze([
  { id: 'rvd-rental', name: '差估署租金指数', url: 'https://www.rvd.gov.hk/datagovhk/2.3M.csv', kind: 'rental' },
  { id: 'rvd-district-rents', name: '差估署分区平均租金', url: 'https://www.rvd.gov.hk/datagovhk/2.1M.csv', kind: 'district' },
  { id: 'rvd-price-index', name: '差估署写字楼售价指数', url: 'https://www.rvd.gov.hk/datagovhk/2.4M.csv', kind: 'price' },
  { id: 'rvd-office-sales', name: '差估署写字楼买卖量额', url: 'https://www.rvd.gov.hk/datagovhk/7.4.csv', kind: 'sales' },
  { id: 'rvd-completions', name: '差估署落成量', url: 'https://www.rvd.gov.hk/datagovhk/Private_Offices-Completions.csv', kind: 'completions' },
  { id: 'rvd-stock', name: '差估署写字楼存量', url: 'https://www.rvd.gov.hk/datagovhk/Private_Offices-Stock.csv', kind: 'stock' },
  { id: 'rvd-takeup', name: '差估署写字楼吸纳量', url: 'https://www.rvd.gov.hk/datagovhk/Private_Offices-Take-up.csv', kind: 'takeup' },
  { id: 'rvd-vacancy', name: '差估署写字楼空置', url: 'https://www.rvd.gov.hk/datagovhk/Private_Offices-Vacancy.csv', kind: 'vacancy' },
  { id: 'rvd-district-stock', name: '差估署分区存量及空置', url: 'https://www.rvd.gov.hk/datagovhk/Off_Stock_and_Vacancy_by_Grade_and_District_Eng.csv', kind: 'district-vacancy' },
  { id: 'govhk-tc', name: '香港政府新闻公报', url: 'https://www.info.gov.hk/gia/rss/general_zh.xml', kind: 'rss', language: 'zh-Hant' },
  { id: 'govhk-en', name: 'Hong Kong Government', url: 'https://www.info.gov.hk/gia/rss/general_en.xml', kind: 'rss', language: 'en' },
  { id: 'govhk-sc', name: '香港政府新闻公报（简体）', url: 'https://sc.isd.gov.hk/TuniS/www.info.gov.hk/gia/rss/general_zh.xml', kind: 'rss', language: 'zh-Hans' },
  { id: 'rthk-tc', name: '香港电台财经新闻', url: 'https://rthk.hk/rthk/news/rss/c_expressnews_cfinance.xml', kind: 'rss', language: 'zh-Hant' },
  { id: 'rthk-en', name: 'RTHK Finance', url: 'https://rthk.hk/rthk/news/rss/e_expressnews_efinance.xml', kind: 'rss', language: 'en' },
  { id: 'censtatd-tc', name: '政府统计处新闻', url: 'https://www.censtatd.gov.hk/data/tc/press_release/rss.xml', kind: 'rss', language: 'zh-Hant' },
  { id: 'jll-discovery', name: 'JLL月报入口监测', url: 'https://www.jll.com/en-hk/insights/market-dynamics/hong-kong-monthly', kind: 'discovery' },
  { id: 'cw-discovery', name: 'C&W MarketBeat入口监测', url: 'https://www.cushmanwakefield.com/en/greater-china/insights/marketbeats/hong-kong-marketbeat', kind: 'discovery' },
]);

const hash = text => createHash('sha256').update(text).digest('hex');
// `owner` is deliberately allowed: it names a building's publicly disclosed landlord.
const sensitiveKey = /^(?:accounts?|users?|bookmarks?|snapshots?|sessions?|password(?:hash)?|allowedEmails|(?:service|access|refresh|auth)?token|(?:session|service)?secret|apiKey|credentials?)$/i;
function stripPrivateFields(value) {
  if (Array.isArray(value)) return value.map(stripPrivateFields);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !sensitiveKey.test(key)).map(([key, item]) => [key, stripPrivateFields(item)]));
}
export function publicDataOnly(input) {
  if (!input || !Array.isArray(input.market?.series) || !Array.isArray(input.market?.districts)
    || !Array.isArray(input.news) || !Array.isArray(input.buildings) || !Array.isArray(input.updates?.sources)) {
    throw new Error('本地公开数据结构不完整；拒绝以空白资料替换现有网站。');
  }
  const result = stripPrivateFields({ market: input.market, news: input.news, buildings: input.buildings, updates: input.updates });
  for (const series of result.market.series) {
    if (!series.id || !Array.isArray(series.points)) throw new Error('本地指标序列结构不完整。');
  }
  return result;
}

/** Never import the old ChatGPT scheduler's enabled flag as evidence for GitHub. */
export function scheduleState(previous, env, checkedAt) {
  const isActions = env.GITHUB_ACTIONS === 'true';
  const event = isActions ? String(env.GITHUB_EVENT_NAME || 'unknown') : 'local';
  const repository = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY || '') ? env.GITHUB_REPOSITORY : null;
  const runId = /^\d+$/.test(env.GITHUB_RUN_ID || '') ? env.GITHUB_RUN_ID : null;
  const runUrl = isActions && repository && runId ? `https://github.com/${repository}/actions/runs/${runId}` : null;
  const prior = previous?.provider === 'github-actions' && previous?.verification === 'observed_schedule_event'
    && previous?.lastScheduledAt && !Number.isNaN(Date.parse(previous.lastScheduledAt)) ? previous : null;
  const observed = isActions && event === 'schedule';
  return {
    provider: 'github-actions', timezone: 'Asia/Hong_Kong', cron: '0 1 * * *',
    intendedTime: '09:00', enabled: observed || Boolean(prior),
    verification: observed || prior ? 'observed_schedule_event' : 'awaiting_first_schedule_event',
    lastScheduledAt: observed ? checkedAt : prior?.lastScheduledAt || null,
    lastScheduledRunUrl: observed ? runUrl : prior?.lastScheduledRunUrl || null,
    lastEvent: event, lastRunUrl: runUrl,
    note: '香港时间每日09:00为计划时间；GitHub Actions可能排队延迟。仅实际schedule事件记录用于验证自动运行。',
  };
}

function eventKey(article) {
  const url = String(article.url || article.sourceUrl || '');
  const government = url.match(/\/P(\d{13,})\.(?:htm|html)/i);
  return government ? `gov-P${government[1]}` : url;
}
export function deduplicateLanguages(existing, incoming) {
  const result = structuredClone(existing), keys = new Map(result.map(article => [eventKey(article), article]));
  for (const article of incoming) {
    const key = eventKey(article), original = keys.get(key);
    if (original) {
      if (original.language !== article.language) {
        const aliases = Array.isArray(original.languageVariants) ? original.languageVariants : [];
        if (!aliases.some(alias => alias.url === (article.url || article.sourceUrl))) {
          original.languageVariants = [...aliases, { title: article.title, language: article.language, url: article.url || article.sourceUrl }];
        }
      }
    } else { result.push(article); keys.set(key, article); }
  }
  // A verified report can support several distinct curated records; never collapse
  // those existing records just because they cite the same report URL.
  return mergeNews(result, []);
}

async function limitedText(response) {
  const maxBytes = 5_000_000;
  if (Number(response.headers.get('content-length')) > maxBytes) throw new Error('文件超过解析大小限制');
  if (!response.body) throw new Error('源内容为空');
  const reader = response.body.getReader(), parts = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new Error('文件超过解析大小限制'); }
      parts.push(value);
    }
  } finally { reader.releaseLock(); }
  const text = Buffer.concat(parts).toString('utf8');
  if (text.length < 80) throw new Error('源内容为空或过短');
  return text;
}

/** Preserve observation metadata for unchanged points, without inventing publication dates. */
function pointProvenance(points, series, source, checkedAt) {
  return Object.fromEntries(Object.entries(points).map(([id, values]) => {
    const previous = new Map((series.find(s => s.id === id)?.points || []).map(point => [point.period, point]));
    return [id, values.map(point => {
      const old = previous.get(point.period);
      return { ...(old || {}), ...point, sourceId: source.id, sourceUrl: source.url,
        fetchedAt: checkedAt, publishedAt: old && old.value === point.value ? old.publishedAt || null : null };
    })];
  }));
}

export async function refreshPublicData(input, { fetchImpl = fetch, now = new Date(), env = process.env, sources = SOURCES } = {}) {
  const data = publicDataOnly(input), checkedAt = now.toISOString(), day = hongKongDate(now);
  const schedule = scheduleState(data.updates.schedule, env, checkedAt);
  const results = await Promise.all(sources.map(async source => {
    const previous = data.updates.sources.find(item => item.id === source.id);
    const status = { id: source.id, name: source.name, url: source.url, checkedAt, status: 'failed',
      lastSuccessfulAt: previous?.lastSuccessfulAt || null, ...(previous?.hash ? { hash: previous.hash } : {}) };
    try {
      const response = await fetchImpl(source.url, { signal: AbortSignal.timeout(18000), redirect: 'follow',
        headers: { Accept: source.kind === 'rss' ? 'application/rss+xml, application/xml, text/xml' : 'text/csv, text/html, */*' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await limitedText(response), contentHash = hash(text), unchanged = previous?.hash === contentHash;
      let parsed;
      if (source.kind === 'district-vacancy') {
        const districtVacancy = parseRvdDistrictVacancy(text);
        Object.assign(status, { status: unchanged ? 'unchanged' : 'checked', count: districtVacancy.length,
          message: '分区存量CSV已校验；仅更新观察期更新的记录，较旧CSV不覆盖较新年报。' });
        parsed = { districtVacancy };
      } else if (source.kind !== 'rss' && source.kind !== 'discovery') {
        const rawPoints = source.kind === 'rental' ? parseRvdRentalCsv(text) : source.kind === 'district'
          ? parseRvdDistrictCsv(text) : parseRvdAdditionalCsv(text, source.kind);
        validateSeriesContinuity(rawPoints, data.market.series);
        const points = pointProvenance(rawPoints, data.market.series, source, checkedAt);
        Object.assign(status, { status: unchanged ? 'unchanged' : 'updated', count: Object.values(points).reduce((sum, list) => sum + list.length, 0),
          message: '已校验官方CSV及历史观察期连续性；观察期仍以原始数据月份为准。' });
        parsed = { points };
      } else if (source.kind === 'rss') {
        const articles = parseRss(text, { ...source, language: source.language || 'unknown' }, now);
        for (const article of articles) article.id = `feed-${hash(String(article.url)).slice(0, 24)}`;
        Object.assign(status, { status: unchanged ? 'unchanged' : 'checked', count: articles.length,
          message: `${articles.length}条相关候选；保守规则初判，全部低置信待复核。` });
        parsed = { articles };
      } else {
        if (!/<html|<!doctype/i.test(text)) throw new Error('报告入口未返回HTML');
        const links = [...new Set([...text.matchAll(/href=["']([^"']+(?:\.pdf|marketbeat|hong-kong-monthly)[^"']*)["']/gi)].map(match => {
          try { const url = new URL(match[1].replace(/&amp;/g, '&'), source.url); return /^https?:$/.test(url.protocol) ? url.toString() : ''; } catch { return ''; }
        }).filter(Boolean))].slice(0, 30);
        Object.assign(status, { status: previous?.hash && !unchanged ? 'review_required' : 'checked', count: links.length,
          discoveredLinks: links, message: `公开入口已检查；${links.length}条候选链接；数字保留上次已验证版本，需复核新报告。` });
        parsed = {};
      }
      Object.assign(status, { hash: contentHash, lastSuccessfulAt: checkedAt });
      return { status, ...parsed };
    } catch (error) {
      status.status = 'failed';
      status.message = `${error instanceof Error ? error.message : '采集失败'}；保留上一版已验证资料`;
      return { status };
    }
  }));
  for (const result of results) {
    if (result.points) data.market = applyRvdPoints(data.market, result.points);
    if (result.districtVacancy) data.market = applyDistrictVacancy(data.market, result.districtVacancy);
  }
  data.news = deduplicateLanguages(data.news, results.flatMap(result => result.articles || []));
  const sourceMap = new Map(data.updates.sources.map(source => [source.id, source]));
  for (const { status } of results) sourceMap.set(status.id, status);
  const successful = results.filter(result => result.status.status !== 'failed').length;
  const complete = successful === results.length && results.length > 0;
  const previous = data.updates;
  // Explicit fields prevent an old service scheduler, account metadata or private run details being republished.
  data.updates = {
    lastCheckedAt: checkedAt, lastSuccessfulAt: complete ? checkedAt : previous.lastSuccessfulAt || null,
    lastCompleteSuccessAt: complete ? checkedAt : previous.lastCompleteSuccessAt || null,
    lastPartialSuccessAt: successful > 0 ? checkedAt : previous.lastPartialSuccessAt || null,
    status: complete ? 'success' : successful > 0 ? 'partial' : 'failed', sources: [...sourceMap.values()],
    runId: `${day}-${randomUUID()}`, trigger: schedule.lastEvent === 'schedule' ? 'scheduled' : schedule.lastEvent,
    scheduleEnabled: schedule.enabled, schedule,
    checkedSourceCount: results.length, successfulSourceCount: successful,
    message: complete ? '来源检查完成；新商业报告数字仍须人工复核。'
      : successful > 0 ? '部分来源不可用；失败来源保留上一版资料。' : '所有来源检查失败；已保留全部上一版资料并公开故障状态。',
  };
  data.market.sources = (data.market.sources || []).map(source => {
    const update = sourceMap.get(String(source.id));
    return update ? { ...source, lastChecked: update.checkedAt, accessStatus: update.status,
      sha256: update.hash || source.sha256, lastRefreshMessage: update.message } : source;
  });
  return publicDataOnly(data);
}

export async function atomicWriteJson(path, value) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o644);
    await handle.writeFile(`${JSON.stringify(publicDataOnly(value))}\n`, 'utf8');
    await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, path);
  } finally {
    if (handle) await handle.close();
    await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export async function updateDataFile(path, options = {}) {
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, 'wx', 0o600).catch(error => {
    if (error.code === 'EEXIST') throw new Error('已有本地更新锁；确认没有其他任务后再移除 .lock 文件。');
    throw error;
  });
  try {
    await lock.writeFile(String(process.pid));
    // Read under the lock: never apply an earlier read over another writer's output.
    // Missing or malformed data fails instead of creating a blank baseline.
    const input = publicDataOnly(JSON.parse(await readFile(path, 'utf8')));
    const result = await refreshPublicData(input, options);
    await atomicWriteJson(path, result);
    return result.updates;
  } finally { await lock.close(); await unlink(lockPath); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const path = resolve(process.argv[2] || `${project}/public/data/workbench.json`);
  updateDataFile(path).then(updates => {
    console.log(JSON.stringify({ status: updates.status, checkedAt: updates.lastCheckedAt, trigger: updates.trigger,
      sources: updates.checkedSourceCount, successful: updates.successfulSourceCount, scheduleVerified: updates.scheduleEnabled }));
    for (const source of updates.sources.filter(source => source.checkedAt === updates.lastCheckedAt && source.status === 'failed')) console.warn(`${source.id}: ${source.message}`);
  }).catch(error => { console.error(`公开资料更新失败：${error.message}`); process.exitCode = 1; });
}
