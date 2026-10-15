/** Pure parsing/validation functions: safe to test without a Worker or database. */
export type Point = { period: string; value: number | null; provisional?: boolean; sampleFlag?: string | null; publishedAt?: string | null; [key: string]: unknown };
export type Series = { id: string; points: Point[]; sourceId?: string; publishedAt?: string | null; [key: string]: unknown };
export type NewsArticle = { id: string; title: string; url?: string; sourceUrl?: string; publishedAt?: string; date?: string; category?: string; [key: string]: unknown };
export type Market = { series: Series[]; districts: Record<string, unknown>[]; sources?: Record<string, unknown>[]; headlines?: Record<string, unknown>[]; [key: string]: unknown };
export const SQFT_PER_SQM = 10.763910416709722;
export const CATEGORIES = ["market", "leasing", "investment", "supply"] as const;
export function parseCsv(input: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = "", quoted = false;
  const text = input.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { field += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(field); field = ""; }
    else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && text[i + 1] === '\n') i++; row.push(field); if (row.some(v => v.trim())) rows.push(row); row = []; field = ""; }
    else field += c;
  }
  if (quoted) throw new Error("CSV 引号未闭合，拒绝更新");
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}
export function numeric(value: string | undefined): number | null {
  if (!value || /^(?:n\/?a|nil|-|—|\*)$/i.test(value.trim())) return null;
  const v = value.replace(/,/g, "").trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(v)) return null;
  const n = Number(v); return Number.isFinite(n) ? n : null;
}
export function csvMonth(value: string): string | null { const m = value.trim().match(/^(0[1-9]|1[0-2])-(\d{4})$/); return m ? `${m[2]}-${m[1]}` : null; }
function seriesPoints(rows: string[][], col: number): Point[] {
  const points: Point[] = [];
  for (const r of rows) {
    const period = csvMonth(r[0] ?? ""); if (!period || period < "2016-01") continue;
    if (r.length <= col + 1) throw new Error(`CSV ${period} 列数改变`);
    const remark = r[col + 1] || "";
    points.push({ period, value: numeric(r[col]), provisional: /P/i.test(remark), sampleFlag: /X/i.test(remark) ? "fewer_than_5" : null });
  }
  if (points.length < 12 || points.filter(p => p.value !== null).length < 6) throw new Error("有效观察值不足，拒绝替换历史序列");
  if (new Set(points.map(p => p.period)).size !== points.length) throw new Error("CSV 存在重复月份");
  return points.sort((a, b) => a.period.localeCompare(b.period));
}
export function parseRvdRentalCsv(input: string): Record<string, Point[]> {
  const rows = parseCsv(input), hi = rows.findIndex(r => r[0]?.trim() === "Month" && r.includes("Grade A"));
  if (hi < 0) throw new Error("RVD租金指数表头不匹配");
  const result: Record<string, Point[]> = {};
  for (const grade of ["A", "B", "C", "Overall"]) {
    const col = rows[hi].indexOf(grade === "Overall" ? grade : `Grade ${grade}`);
    if (col < 1) throw new Error(`RVD ${grade}列不存在`);
    result[`rvd-rent-${grade.toLowerCase()}`] = seriesPoints(rows.slice(hi + 1), col);
  }
  return result;
}
export const DISTRICT_NAMES: Record<string, string> = {
  "sheung-wan": "Sheung Wan", "central": "Central", "wan-chai-causeway-bay": "Wan Chai / Causeway Bay", "north-point-quarry-bay": "North Point / Quarry Bay", "tsim-sha-tsui": "Tsim Sha Tsui", "yau-ma-tei-mong-kok": "Yau Ma Tei / Mong Kok", "kowloon-bay-kwun-tong": "Kowloon Bay / Kwun Tong",
};
export function parseRvdDistrictCsv(input: string): Record<string, Point[]> {
  const rows = parseCsv(input), hi = rows.findIndex(r => r[0]?.trim() === "Month" && r.includes("Grade A Central"));
  if (hi < 0) throw new Error("RVD分区平均租金表头不匹配");
  const result: Record<string, Point[]> = {};
  for (const grade of ["A", "B", "C"]) for (const [id, name] of Object.entries(DISTRICT_NAMES)) {
    const col = rows[hi].indexOf(`Grade ${grade} ${name}`);
    if (col < 1) throw new Error(`RVD ${grade} ${name}列不存在`);
    result[`rvd-district-${id}-${grade.toLowerCase()}`] = seriesPoints(rows.slice(hi + 1), col);
  }
  return result;
}
export function validateSeriesContinuity(points: Record<string, Point[]>, current: { id: string; points: Point[] }[]): void {
  for (const [id, values] of Object.entries(points)) {
    const existing = current.find(s => s.id === id);
    if (!values.length) throw new Error(`${id}没有观察值`);
    if (existing?.points.length) {
      if (values.at(-1)!.period < existing.points.at(-1)!.period) throw new Error(`${id}最新观察期倒退，待复核`);
      // YTD is an explicitly labelled rolling cumulative observation, not an annual history.
      if (!id.includes("-ytd-")) {
        const periods = new Set(values.map(p => p.period));
        if (existing.points.some(p => !periods.has(p.period))) throw new Error(`${id}遗漏已有历史观察期，拒绝缩短序列`);
      }
    }
    if (values.some(p => p.value !== null && ((p.value < 0 && !id.includes("takeup")) || Math.abs(p.value) > 1000000000 || (id.startsWith("rvd-vacancy-") && p.value > 100)))) throw new Error(`${id}数值范围异常`);
  }
}
export function applyRvdPoints(market: Market, incoming: Record<string, Point[]>): Market {
  const series = market.series.map(s => incoming[s.id] ? { ...s, points: incoming[s.id], publishedAt: null } : s);
  const districts = market.districts.map(d => {
    const points = incoming[`rvd-district-${d.districtId}-${String(d.grade).toLowerCase()}`];
    if (!points) return d;
    const p = points[points.length - 1]; return { ...d, rent: p.value, rentPsf: p.value === null ? null : Math.round(p.value / SQFT_PER_SQM * 100) / 100, period: p.period, provisional: p.provisional, sampleFlag: p.sampleFlag };
  });
  const latest = incoming["rvd-rent-a"]?.at(-1), ytd = incoming["rvd-completions-ytd-overall"]?.at(-1);
  const headlines = market.headlines?.map(h => ytd && h.provider === "RVD" && /年内累计落成/.test(String(h.title)) ? { ...h, value: ytd.value, period: ytd.period, note: "所有级别；临时年内累计数字，观察期见期间，非全年。" } : latest && h.provider === "RVD" && h.unit === "1999=100" && /甲/.test(String(h.title)) ? { ...h, value: latest.value, period: latest.period } : h);
  return { ...market, series, districts, ...(headlines ? { headlines } : {}) };
}
export function parseRvdAdditionalCsv(input: string, kind: "price" | "sales" | "completions" | "stock" | "takeup" | "vacancy"): Record<string, Point[]> {
  if (kind === "price") return Object.fromEntries(Object.entries(parseRvdRentalCsv(input)).map(([id, points]) => [id.replace("rvd-rent-", "rvd-price-"), points]));
  const rows = parseCsv(input), headerIndex = rows.findIndex(r => r[0]?.trim() === (kind === "sales" ? "Month" : "Year"));
  if (headerIndex < 0) throw new Error(`RVD ${kind}表头改变`);
  const h = rows[headerIndex], data = rows.slice(headerIndex + 1), out: Record<string, Point[]> = {};
  if (kind === "sales") {
    for (const [id, column] of [["count", "Offices Number"], ["value", "Offices Consideration"]]) {
      const col = h.indexOf(column); if (col < 1) throw new Error("RVD 写字楼买卖字段缺失");
      out[`rvd-sales-${id}`] = seriesPoints(data, col);
    }
    return out;
  }
  const grades = ["A", "B", "C", "Overall"];
  for (const [gi, grade] of grades.entries()) {
    const col = kind === "completions" || kind === "vacancy" ? gi * 2 + 1 : gi + 1;
    const expected = grade === "Overall" ? "Total" : `Grade ${grade}`;
    if (!h[col]?.startsWith(expected)) throw new Error(`RVD ${kind} ${grade}列改变`);
    const points: Point[] = [], vacant: Point[] = [], ytd: Point[] = [];
    for (const row of data) {
      if (!/^\d{4}$/.test(row[0]) || row[0] < "2016") continue;
      if (row.length !== h.length) throw new Error(`RVD ${kind}列数改变`);
      let value = numeric(row[col]);
      if (kind === "completions" && row[col].trim() === "-") value = 0;
      const cutoff = kind === "completions" ? row[col + 1]?.match(/up to (\d{2})\.(\d{2})\.(\d{4})/i) : null;
      if (cutoff) { ytd.push({ period: `${row[0]}-01/${cutoff[3]}-${cutoff[2]}`, value, provisional: true }); continue; }
      if (kind === "vacancy") { const ratio = numeric(row[col + 1]); points.push({ period: row[0], value: ratio === null ? null : Math.round(ratio * 1000) / 10 }); vacant.push({ period: row[0], value }); }
      else points.push({ period: row[0], value });
    }
    if (points.length < 5) throw new Error(`RVD ${kind}历史数据不足`);
    out[`rvd-${kind}-${grade.toLowerCase()}`] = points;
    if (kind === "vacancy") out[`rvd-vacant-area-${grade.toLowerCase()}`] = vacant;
    if (ytd.length) out[`rvd-completions-ytd-${grade.toLowerCase()}`] = ytd;
  }
  return out;
}
export function parseRvdDistrictVacancy(input: string): Record<string, unknown>[] {
  const rows = parseCsv(input), hi = rows.findIndex(r => r[0] === "District / Sub-districts");
  if (hi < 0 || rows[hi].length !== 14) throw new Error("RVD分区存量表头改变");
  const year = rows[hi][2].match(/Stock at (\d{4}) year-end/); if (!year) throw new Error("分区存量年份不明确");
  const results: Record<string, unknown>[] = [];
  for (const row of rows.slice(hi + 1)) {
    if (!row[0] || row.length !== 14) continue;
    for (const [i, grade] of ["A", "B", "C", "Overall"].entries()) {
      const vacancy = numeric(row[10 + i]);
      if (vacancy !== null && (vacancy < 0 || vacancy > 100)) throw new Error("分区空置率异常");
      results.push({ nameEn: row[0], grade, period: `${year[1]}-12-31`, stock: numeric(row[2 + i]), vacantArea: numeric(row[6 + i]), vacancy, nonVacantRatio: vacancy === null ? null : Math.round((100 - vacancy) * 10) / 10, unit: "m²", areaBasis: "IFA", sourceId: "rvd-district-stock", sourceUrl: "https://www.rvd.gov.hk/datagovhk/Off_Stock_and_Vacancy_by_Grade_and_District_Eng.csv", scope: row[1] === "S" ? "subdistrict" : "district_or_total", note: "非空置比例由100%-官方空置率计算；不等同业主已签约出租率。" });
    }
  }
  if (results.length < 20) throw new Error("分区存量记录不足");
  return results;
}
export function applyDistrictVacancy(market: Market, incoming: Record<string, unknown>[]): Market {
  const existing = Array.isArray(market.districtVacancy) ? market.districtVacancy as Record<string, unknown>[] : [];
  const result = [...existing];
  for (const item of incoming) {
    const i = result.findIndex(old => old.nameEn === item.nameEn && old.grade === item.grade);
    if (i < 0) result.push(item);
    else if (String(item.period) > String(result[i].period)) result[i] = { ...result[i], ...item };
  }
  return { ...market, districtVacancy: result };
}
export function decodeEntities(input: string): string {
  return input.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[a-f0-9]+);/gi, m => {
    const basic: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
    if (basic[m.toLowerCase()]) return basic[m.toLowerCase()];
    const n = m.toLowerCase().startsWith("&#x") ? parseInt(m.slice(3, -1), 16) : parseInt(m.slice(2, -1), 10);
    return Number.isFinite(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  });
}
export function plainText(input: string): string { return decodeEntities(input).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }
export function canonicalUrl(input: string): string {
  try { const u = new URL(input); if (!/^https?:$/.test(u.protocol)) return ""; u.hash = ""; for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid)/i.test(k)) u.searchParams.delete(k); return u.toString(); } catch { return ""; }
}
export function newsCategory(text: string): typeof CATEGORIES[number] {
  if (/落成|供应|供應|重建|改用途|规划|規劃|地積比|地积比|新项目|新項目|completion|redevelopment|pipeline|new supply|planning application/i.test(text)) return "supply";
  if (/收购|收購|放售|出售|买卖|買賣|招标|招標|拍卖|拍賣|银主|銀主|acquisition|disposal|sale of|tender|investment deal/i.test(text)) return "investment";
  if (/租赁|租賃|承租|租约|租約|续租|續租|扩租|擴租|退租|迁址|遷址|搬遷|搬迁|lease|leasing|tenant|relocat/i.test(text)) return "leasing";
  return "market";
}
export function isOfficeRelevant(text: string): boolean {
  if (/写字楼|寫字樓|甲厦|甲廈|商廈|商厦|office (?:market|rent|lease|leasing|space|building|vacancy)|commercial property|commercial real estate/i.test(text)) return true;
  return /香港|Hong Kong|港府/i.test(text) && /利率|就业|就業|失业|失業|经济|經濟|金融|银行|銀行|税务|稅務|企业|企業|上市|保险|保險|人工智能|inflation|employment|econom|bank|financial|interest rate|IPO|insurance|artificial intelligence|tariff/i.test(text);
}
export function ruleImpact(text: string): { impact: "positive" | "negative" | "mixed" | "neutral"; impactReason: string; confidence: "low"; evidenceStatus: string; scope: string } {
  const base = { confidence: "low" as const, evidenceStatus: "系统规则初判，待复核；不代表全港净需求判断", scope: "新闻涉及物业／片区，具体范围待核实" };
  const office = /写字楼|寫字樓|甲厦|甲廈|商厦|商廈|办公室|辦公室|office(?:s| space| building| market)?/i.test(text);
  const negativePhrase = /(?:并未|並未|没有|沒有|未有|未曾|尚未|否认|否認|不会|不會|无意|無意|not|never|no|without).{0,16}(?:扩租|擴租|新租|承租|租下|expan|leas|rent|退租|缩租|縮租|关闭|關閉|clos|reduc)/i.test(text);
  const proposed = /拟|擬|计划|計劃|考虑|考慮|洽谈|洽談|传闻|傳聞|或将|或將|may |might |plans? to|planning to|considering|rumou?r/i.test(text);
  if (negativePhrase || proposed) return { ...base, impact: "neutral", impactReason: "存在否定、计划或未落实表述，不能据此确认租赁需求增减。" };
  if (office && /搬迁|搬遷|迁址|遷址|relocat|moving (?:its |their )?office/i.test(text)) return { ...base, impact: "mixed", impactReason: "迁址可能支持新址需求、释放旧址空间；缺乏两端同口径面积时不能判断全港净增。" };
  if (/减息|減息|降息|rate cut|cuts? interest rate/i.test(text)) return { ...base, impact: "mixed", scope: "宏观融资及资产估值；租赁传导待验证", impactReason: "融资成本下降可能支持估值与经营，但减息原因及企业用房需求仍需核实，租赁影响并非单向。" };
  if (office && /新增供应|新增供應|新供应|新供應|落成|new supply|new completions?|completed office/i.test(text)) return { ...base, impact: "mixed", impactReason: "新增空间提高可选择供应，可能增加邻近租赁竞争；实际影响取决于预租及新增需求。" };
  const contraction = office && /退租|缩租|縮租|关闭.{0,8}办公室|關閉.{0,8}辦公室|vacat(?:e|ed|ing)|clos(?:e|ed|ing).{0,16}office|reduc(?:e|ed|ing).{0,16}office|downsized|downsizing/i.test(text);
  const expansion = office && /新租|扩租|擴租|承租|租下|租用|租出|signed.{0,20}(?:new )?lease|secured.{0,20}(?:new )?lease|\bleased\b|\bexpanded\b|has rented|have rented/i.test(text);
  if (contraction && expansion) return { ...base, impact: "mixed", impactReason: "文本同时涉及增租及释放空间，需逐宗核对面积、时间及原址后判断净影响。" };
  if (contraction) return { ...base, impact: "negative", impactReason: "明确退租、缩租或关闭办公室可能减少相关物业占用、增加可租空间；范围及实际交还时间待复核。" };
  if (expansion) return { ...base, impact: "positive", impactReason: "明确新租或扩租为相关物业／片区提供租赁需求证据；未核对旧址，不能据此宣称全港净增长。" };
  return { ...base, impact: "neutral", impactReason: "尚无足够明确的租赁空间增减证据；保留事实摘要，影响方向待复核。" };
}
function tag(xml: string, name: string): string { return xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${name}>`, "i"))?.[1] ?? ""; }
export function parseRss(xml: string, source: { id: string; name: string; language: string; url: string }, now = new Date()): NewsArticle[] {
  if (!/<(?:rss|feed)\b/i.test(xml)) throw new Error("源未返回 RSS/Atom 文档");
  const items = [...xml.matchAll(/<(item|entry)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)];
  const articles: NewsArticle[] = [];
  for (const match of items) {
    const item = match[2], title = plainText(tag(item, "title"));
    const summary = plainText(tag(item, "description") || tag(item, "summary"));
    if (!title || !isOfficeRelevant(`${title} ${summary}`)) continue;
    const url = canonicalUrl(decodeEntities(tag(item, "link").trim()) || (item.match(/<link\b[^>]*href=["']([^"']+)/i)?.[1] ?? ""));
    const rawDate = plainText(tag(item, "pubDate") || tag(item, "published") || tag(item, "updated"));
    const date = new Date(rawDate);
    if (!url || !Number.isFinite(date.valueOf()) || date.valueOf() > now.valueOf() + 86400000) continue;
    const judgement = ruleImpact(`${title} ${summary}`);
    // A URL-based key avoids duplicate imports on repeated runs; cross-language aliases remain reviewable.
    articles.push({ id: `feed-${smallHash(url)}`, title, originalTitle: title, summary: summary.slice(0, 1600), url, sourceUrl: url, source: source.name, sourceId: source.id, language: source.language, publishedAt: date.toISOString(), date: hongKongDate(date), eventDate: null, category: newsCategory(`${title} ${summary}`), ...judgement, impactLabel: judgement.impact === "positive" ? "潜在利好 · 待复核" : judgement.impact === "negative" ? "潜在利空 · 待复核" : judgement.impact === "mixed" ? "影响分化 · 待复核" : "方向待复核", reviewStatus: "pending", provenance: "official_feed", fetchedAt: now.toISOString(), evidence: [{ url, source: source.name }] });
  }
  return articles;
}
export function smallHash(text: string): string { let hash = 2166136261; for (let i = 0; i < text.length; i++) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); } return (hash >>> 0).toString(16); }
export function mergeNews(existing: NewsArticle[], incoming: NewsArticle[]): NewsArticle[] {
  const result = [...existing]; const seen = new Set(existing.flatMap(n => [n.id, canonicalUrl(String(n.url || n.sourceUrl || ""))]).filter(Boolean));
  for (const n of incoming) { const url = canonicalUrl(String(n.url || n.sourceUrl || "")); if (seen.has(n.id) || seen.has(url)) continue; result.push(n); seen.add(n.id); if (url) seen.add(url); }
  return result.sort((a, b) => String(b.publishedAt || b.date || "").localeCompare(String(a.publishedAt || a.date || "")));
}
export function periodEnd(period: string): string | null {
  if (/^\d{4}-\d{2}\/\d{4}-\d{2}$/.test(period)) return periodEnd(period.split("/")[1]);
  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) return period;
  let y: number, month: number;
  if (/^\d{4}-\d{2}$/.test(period)) { y = Number(period.slice(0, 4)); month = Number(period.slice(5)); }
  else if (/^\d{4}[- ]?Q[1-4]$/i.test(period)) { y = Number(period.slice(0, 4)); month = Number(period.at(-1)) * 3; }
  else if (/^\d{4}$/.test(period)) { y = Number(period); month = 12; }
  else return null;
  if (month < 1 || month > 12) return null;
  return new Date(Date.UTC(y, month, 0)).toISOString().slice(0, 10);
}
export function publicationDay(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value); return Number.isFinite(date.valueOf()) ? hongKongDate(date) : null;
}
export function filterSnapshot(market: Market, news: NewsArticle[], cutoff: string, selectedIds?: string[]) {
  const selection = new Set(selectedIds), selectAll = selectedIds === undefined, excludedSeries: string[] = [];
  const sourceDate = (item: Record<string, unknown>) => {
    if (Object.hasOwn(item, "publishedAt")) return publicationDay(item.publishedAt);
    const source = market.sources?.find(s => (item.sourceId && s.id === item.sourceId) || (item.sourceUrl && s.url === item.sourceUrl));
    return publicationDay(source?.publishedAt);
  };
  const series = market.series.flatMap(s => {
    const points = s.points.filter(p => {
      const end = periodEnd(p.period);
      // A point with its own source/publication metadata must not inherit the newest report's date.
      const hasOwnMetadata = Object.hasOwn(p, "publishedAt") || p.sourceId || p.sourceUrl;
      const publication = hasOwnMetadata ? sourceDate(p) : sourceDate(s);
      return end !== null && end <= cutoff && (!publication || publication <= cutoff);
    });
    if (!points.length) { excludedSeries.push(s.id); return []; }
    const latest = points.at(-1)!;
    return [{ ...s, points, publishedAt: Object.hasOwn(latest, "publishedAt") ? latest.publishedAt : s.publishedAt, ...(latest.sourceUrl ? { sourceUrl: latest.sourceUrl } : {}), ...(latest.sourceId ? { sourceId: latest.sourceId } : {}) }];
  });
  const districts = market.districts.flatMap(d => {
    const s = series.find(x => x.id === `rvd-district-${d.districtId}-${String(d.grade).toLowerCase()}`), p = s?.points.at(-1);
    if (!p) return [];
    const vacancyDate = periodEnd(String(d.vacancyPeriod || ""));
    const vacancyPublication = sourceDate({ sourceUrl: d.vacancySourceUrl });
    const clearVacancy = !vacancyDate || vacancyDate > cutoff || Boolean(vacancyPublication && vacancyPublication > cutoff);
    return [{ ...d, period: p.period, rent: p.value, rentPsf: p.value === null ? null : Math.round(p.value / SQFT_PER_SQM * 100) / 100, provisional: p.provisional, sampleFlag: p.sampleFlag, ...(clearVacancy ? { vacancy: null, occupancy: null, nonVacantRatio: null, stock: null, vacantArea: null, vacancyPeriod: null, vacancySourceUrl: null, vacancyNote: "截止日期内无已验证的分区空置资料" } : {}) }];
  });
  const articles = news.filter(n => { const date = publicationDay(n.publishedAt || n.date); return date && date <= cutoff && (selectAll || selection.has(n.id)); });
  const districtVacancy = Array.isArray(market.districtVacancy) ? (market.districtVacancy as Record<string, unknown>[]).filter(d => { const end = periodEnd(String(d.period || "")), publication = sourceDate(d); return end && end <= cutoff && (!publication || publication <= cutoff); }) : undefined;
  const headlines = market.headlines?.filter(h => { const p = periodEnd(String(h.period ?? "")), publication = sourceDate(h); return p !== null && p <= cutoff && (!publication || publication <= cutoff); });
  return { market: { ...market, series, districts, headlines, ...(districtVacancy ? { districtVacancy } : {}) }, news: articles, snapshotMethod: "latest_verified_values_filtered_by_observation_period_and_known_publication_date", historicalPublicationCaveat: "按观察期及已知发布日期（香港时间）筛选后冻结当前已验证版本；发布日期缺失及日后修订的序列不能证明在历史截止日已公开，不能视为严格的历史信息集回测。", excludedSeries };
}
export function validIsoDate(value: unknown): value is string { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value; }
export function hongKongDate(date = new Date()): string { return new Date(date.valueOf() + 8 * 3600000).toISOString().slice(0, 10); }
