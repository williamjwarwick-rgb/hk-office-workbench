import { filterSnapshot, hongKongDate, validIsoDate } from "./data-utils";
import type { Market, NewsArticle } from "./data-utils";

type PublishedData = { market: Market; news: NewsArticle[]; buildings: Record<string, unknown>[]; updates: Record<string, unknown> };
type SnapshotSummary = { id: string; title: string; month: string; cutoff: string; createdAt: string };
type Snapshot = SnapshotSummary & Record<string, unknown>;
type Bookmark = { id: string; createdAt: string };
/** This new namespace is deliberately separate from every previously authenticated account. */
const DATABASE_NAME = "hk-office-public-local-v1";
const LOCAL_WARNING = "浏览器本地存储不可用；公共资料仍可阅读，但收藏与快照无法保存。请检查浏览器的存储权限。";
const RELOAD_MESSAGE = "已重新载入最近发布的公共数据；此操作不会现场抓取来源网站。数据观察期、来源检查时间及自动发布状态见“数据与口径”。";

export interface PublicLocalStore {
  listBookmarks(): Promise<string[]>;
  setBookmark(id: string, selected: boolean, createdAt: string): Promise<void>;
  listSnapshots(): Promise<SnapshotSummary[]>;
  getSnapshot(id: string): Promise<Snapshot | undefined>;
  addSnapshot(snapshot: Snapshot): Promise<void>;
}
function summary(s: Snapshot): SnapshotSummary { return { id: s.id, title: s.title, month: s.month, cutoff: s.cutoff, createdAt: s.createdAt }; }
function localError(): Error { return new Error("未能保存或读取本机记录，操作未确认成功；请检查浏览器存储权限及剩余空间，稍后重试。"); }
function copy<T>(value: T): T { return structuredClone(value); }

/** All promises wait for transaction completion, not merely request success. */
export function createIndexedDbStore(factory: () => IDBFactory | undefined = () => globalThis.indexedDB): PublicLocalStore {
  let opening: Promise<IDBDatabase> | undefined;
  function open(): Promise<IDBDatabase> {
    if (opening) return opening;
    opening = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest, settled = false;
      const timer = setTimeout(() => fail(), 12000);
      const fail = () => { if (!settled) { settled = true; clearTimeout(timer); reject(localError()); } };
      try { const provider = factory(); if (!provider) return fail(); request = provider.open(DATABASE_NAME, 1); } catch { return fail(); }
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("bookmarks")) db.createObjectStore("bookmarks", { keyPath: "id" });
        if (!db.objectStoreNames.contains("snapshots")) db.createObjectStore("snapshots", { keyPath: "id" });
      };
      request.onerror = fail;
      request.onblocked = fail;
      request.onsuccess = () => {
        if (settled) { request.result.close(); return; }
        settled = true; clearTimeout(timer);
        request.result.onversionchange = () => { request.result.close(); opening = undefined; };
        resolve(request.result);
      };
    }).catch(error => { opening = undefined; throw error; });
    return opening;
  }
  async function transact<T>(name: "bookmarks" | "snapshots", mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      let transaction: IDBTransaction, result: T, settled = false;
      const fail = () => { if (!settled) { settled = true; clearTimeout(timer); reject(localError()); } };
      const timer = setTimeout(() => { try { transaction?.abort(); } catch {} fail(); }, 12000);
      try {
        transaction = db.transaction(name, mode);
        transaction.oncomplete = () => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
        transaction.onabort = fail;
        transaction.onerror = fail;
        const request = action(transaction.objectStore(name));
        request.onsuccess = () => { result = request.result; };
        request.onerror = fail;
      } catch { fail(); }
    });
  }
  return {
    async listBookmarks() { const rows = await transact<Bookmark[]>("bookmarks", "readonly", store => store.getAll()); return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(row => row.id); },
    async setBookmark(id, selected, createdAt) {
      if (selected) await transact("bookmarks", "readwrite", store => store.put({ id, createdAt }));
      else await transact("bookmarks", "readwrite", store => store.delete(id));
    },
    async listSnapshots() { const rows = await transact<Snapshot[]>("snapshots", "readonly", store => store.getAll()); return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100).map(summary); },
    async getSnapshot(id) { return transact<Snapshot | undefined>("snapshots", "readonly", store => store.get(id)); },
    async addSnapshot(snapshot) { await transact("snapshots", "readwrite", store => store.add(copy(snapshot))); },
  };
}

type ApiOptions = { baseUrl?: string; fetcher?: typeof fetch; store?: PublicLocalStore; now?: () => Date; uuid?: () => string };
/** Injectable boundaries permit network-free validation without a server, credentials, or account IDs. */
export function createPublicApi(options: ApiOptions = {}) {
  const base = options.baseUrl ?? (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env?.BASE_URL ?? "/";
  const dataUrl = `${base.endsWith("/") ? base : `${base}/`}data/workbench.json`;
  const fetcher = options.fetcher ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const local = options.store ?? createIndexedDbStore();
  const now = options.now ?? (() => new Date());
  const uuid = options.uuid ?? (() => crypto.randomUUID());
  let published: PublishedData | undefined;
  async function readPublished(reload = false): Promise<PublishedData> {
    if (published && !reload) return copy(published);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetcher(dataUrl, { cache: "no-store", credentials: "omit", signal: controller.signal });
      if (!response.ok) throw new Error(`公共资料载入失败（${response.status}），请稍后重试。`);
      let data: any;
      try { data = await response.json(); } catch { throw new Error("公共资料格式无效，未替换当前数据。请稍后重试。"); }
      if (!data || !data.market || !Array.isArray(data.market.series) || !Array.isArray(data.market.districts) || !Array.isArray(data.news) || data.news.some((n: any) => !n || typeof n.id !== "string") || !Array.isArray(data.buildings) || !data.updates || typeof data.updates !== "object" || Array.isArray(data.updates)) throw new Error("公共资料结构不完整，未替换当前数据。");
      // Never import bookmarks, private snapshots, session details, or arbitrary top-level properties.
      published = copy({ market: data.market, news: data.news, buildings: data.buildings, updates: data.updates });
      return copy(published);
    } catch (error) { if (controller.signal.aborted) throw new Error("公共资料载入超时，请检查网络后重试。"); throw error; }
    finally { clearTimeout(timer); }
  }
  return async function api(url: string, method = "GET", body?: any): Promise<any> {
    if (typeof url !== "string" || !url.startsWith("/api/") || url.includes("#")) throw new Error("不支持的本地操作。");
    const target = new URL(url, "https://public-workbench.invalid"), path = target.pathname;
    const verb = String(method).toUpperCase();
    if (verb === "GET" && body !== undefined) throw new Error("读取操作不接受写入参数。");
    if (path === "/api/workbench" && verb === "GET") {
      const data = await readPublished(true);
      try { const [bookmarks, snapshots] = await Promise.all([local.listBookmarks(), local.listSnapshots()]); return { ...data, bookmarks, snapshots, localStorageWarning: null }; }
      catch { return { ...data, bookmarks: [], snapshots: [], localStorageWarning: LOCAL_WARNING }; }
    }
    if (path === "/api/refresh" && verb === "POST") { const data = await readPublished(true); return { updates: { ...data.updates, skipped: true, message: RELOAD_MESSAGE } }; }
    if (path === "/api/bookmarks" && verb === "POST") {
      if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.id !== "string" || !body.id.trim() || body.id.length > 200 || typeof body.selected !== "boolean") throw new Error("收藏参数无效。");
      if (body.selected && !(await readPublished()).news.some(item => item.id === body.id)) throw new Error("新闻不存在，无法加入收藏。");
      await local.setBookmark(body.id, body.selected, now().toISOString());
      return { bookmarks: await local.listBookmarks() };
    }
    if (path === "/api/snapshots" && verb === "GET") {
      const id = target.searchParams.get("id");
      if (!id) return { snapshots: await local.listSnapshots() };
      if (id.length > 200) throw new Error("快照编号无效。");
      const snapshot = await local.getSnapshot(id);
      if (!snapshot) throw new Error("本机未找到此快照；其他设备或清除浏览器数据前的记录不会自动同步。");
      return copy(snapshot);
    }
    if (path === "/api/snapshots" && verb === "POST") {
      if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.title !== "string" || !body.title.trim() || body.title.length > 150 || typeof body.month !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(body.month) || !validIsoDate(body.cutoff) || body.cutoff > hongKongDate(now())) throw new Error("请填写标题、报告月份和有效截止日期（不得晚于香港今日）。");
      if (body.notes !== undefined && (typeof body.notes !== "string" || body.notes.length > 20000)) throw new Error("备注格式无效或超过20,000字。");
      if (body.selectedNewsIds !== undefined && (!Array.isArray(body.selectedNewsIds) || body.selectedNewsIds.length > 1000 || body.selectedNewsIds.some((id: unknown) => typeof id !== "string" || id.length > 200))) throw new Error("新闻选择无效。");
      const data = await readPublished(), selectedNewsIds: string[] = [...new Set<string>(body.selectedNewsIds || [])];
      if (selectedNewsIds.some(id => !data.news.some(item => item.id === id))) throw new Error("所选新闻不在当前公开资料内，请重新载入后选择。");
      const payload: Snapshot = { id: uuid(), title: body.title.trim(), month: body.month, cutoff: body.cutoff, notes: body.notes || "", createdAt: now().toISOString(), ...filterSnapshot(data.market, data.news, body.cutoff, selectedNewsIds), buildings: copy(data.buildings), buildingsTemporalNote: "楼宇资料按本次创建时的可得版本冻结；各字段观察期独立保留，不声称其在历史截止日全部已公开。", updates: copy(data.updates), selectedNewsIds, storageNote: "此快照仅保存在当前浏览器，不上传网站、不跨设备同步；清除网站数据可能删除记录，请及时导出。" };
      // add(), never put(): an existing frozen edition cannot be overwritten, including on ID collision.
      await local.addSnapshot(payload);
      return { snapshot: summary(payload), snapshots: await local.listSnapshots() };
    }
    throw new Error("不支持此操作；公开版只允许读取已发布资料和保存本机研究记录。");
  };
}
export const api = createPublicApi();
