"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Map as LeafletMap, Marker as LeafletMarker, TileLayer } from "leaflet";
import "leaflet/dist/leaflet.css";
import { BASEMAPS, BASEMAP_TIMEOUT_MS, createBasemapLoadGuard, type BasemapProvider } from "@/lib/map-basemap";
import "./map.css";
import { metricColor, normalizeOfficeGrade, normalizeOfficeSearch, officeGradeLabel, projectOfficePoint, safePublicUrl, validMapCoordinate } from "@/lib/map-utils";

type Note = string | string[];
export type OfficeBuilding = {
  id: string; name: string; nameEn?: string; district: string; grade: string;
  longitude: number; latitude: number; coordinateSource?: string; coordinatePrecision?: string;
  owner?: string; address?: string;
  rent: { value?: number | null; min?: number | null; max?: number | null; unit: string; areaBasis: string; type: string; period: string; sourceUrl: string; note?: string } | null;
  occupancy: { value: number; period: string; basis: string; sourceUrl: string; note?: string } | null;
  tenants: { name: string; status: string; period: string; sourceUrl: string; note?: string }[];
  notes?: Note; sourceUrl?: string;
};
export type OfficeDistrict = {
  id: string; name: string; grade: string; rent: number | null; period: string;
  unit: string; areaBasis: string; sourceUrl: string; longitude: number; latitude: number; sampleFlag?: string | null; rentPsf?: number | null; nonVacantRatio?: number | null; vacancy?: number | null; vacancyPeriod?: string; vacancySourceUrl?: string; vacancyNote?: string; provisional?: boolean;
};
export type OfficeDistrictVacancy = { name: string; nameEn?: string; grade: string; period: string; stock: number | null; vacantArea?: number | null; vacancy: number | null; nonVacantRatio?: number | null; unit: string; areaBasis: string; sourceUrl: string; note?: string; scope?: string };
type Props = { buildings: OfficeBuilding[]; districts: OfficeDistrict[]; districtVacancy?: OfficeDistrictVacancy[] };
type Metric = "rent" | "occupancy";
type DistrictGroup = { id: string; name: string; longitude: number; latitude: number; rows: OfficeDistrict[] };
type MapPoint = { id: string; name: string; longitude: number; latitude: number; value: number | null; label: string; kind: "building" | "district" };

function formatNumber(value: number): string { return value.toLocaleString("en-HK", { maximumFractionDigits: 1 }); }
function rentText(rent: OfficeBuilding["rent"]): string {
  if (!rent) return "未披露";
  if (typeof rent.value === "number") return formatNumber(rent.value);
  if (typeof rent.min === "number" && typeof rent.max === "number") return `${formatNumber(rent.min)}–${formatNumber(rent.max)}`;
  if (typeof rent.min === "number") return `≥ ${formatNumber(rent.min)}`;
  if (typeof rent.max === "number") return `≤ ${formatNumber(rent.max)}`;
  return "未披露";
}
function LinkSource({ href, children = "查看原始来源" }: { href?: string; children?: React.ReactNode }) {
  const url = safePublicUrl(href);
  return url ? <a className="map-source" href={url} target="_blank" rel="noopener noreferrer">{children}<span aria-hidden="true"> ↗</span></a> : <span className="map-muted">来源未披露</span>;
}
function PinIcon() { return <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.3"/></svg>; }

export default function OfficeMap({ buildings, districts, districtVacancy = [] }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const markersRef = useRef<LeafletMarker[]>([]);
  const useCoordinatesRef = useRef<() => void>(() => {});
  const lastViewRef = useRef<{ center: [number, number]; zoom: number } | null>(null);
  const [mapInitialized, setMapInitialized] = useState(false);
  const [mapGeneration, setMapGeneration] = useState(0);
  const [requestedProvider, setRequestedProvider] = useState<BasemapProvider>("lands");
  const [activeProvider, setActiveProvider] = useState<BasemapProvider>("lands");
  const [mapStatus, setMapStatus] = useState<"loading" | "ready" | "fallback">("loading");
  const [mapError, setMapError] = useState("");
  const [retry, setRetry] = useState(0);
  const [layer, setLayer] = useState<"building" | "district">("building");
  const [metric, setMetric] = useState<Metric>("rent");
  const [grade, setGrade] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [mapZoom, setMapZoom] = useState(12.3);
  const [fallbackReset, setFallbackReset] = useState(0);
  const query = normalizeOfficeSearch(search.trim());

  const visibleBuildings = useMemo(() => buildings.filter(b => validMapCoordinate(b.longitude, b.latitude) && (grade === "all" || normalizeOfficeGrade(b.grade) === grade) && (!query || normalizeOfficeSearch(`${b.name} ${b.nameEn || ""} ${b.district} ${b.address || ""}`).includes(query))), [buildings, grade, query]);
  const districtGroups = useMemo(() => {
    const groups = new Map<string, DistrictGroup>();
    districts.filter(d => validMapCoordinate(d.longitude, d.latitude) && (grade === "all" || normalizeOfficeGrade(d.grade) === grade) && (!query || normalizeOfficeSearch(d.name).includes(query))).forEach(d => {
      const group = groups.get(d.name) || { id: `district:${d.name}`, name: d.name, longitude: d.longitude, latitude: d.latitude, rows: [] };
      group.rows.push(d); groups.set(d.name, group);
    });
    return Array.from(groups.values());
  }, [districts, grade, query]);
  const points = useMemo<MapPoint[]>(() => layer === "building" ? visibleBuildings.map(b => {
    const value = metric === "occupancy" ? b.occupancy?.value ?? null : b.rent?.type.includes("叫租") ? b.rent?.value ?? b.rent?.min ?? b.rent?.max ?? null : null;
    return { id: b.id, name: b.name, longitude: b.longitude, latitude: b.latitude, value, label: metric === "occupancy" ? b.occupancy ? `${formatNumber(b.occupancy.value)}%` : "未披露" : rentText(b.rent), kind: "building" };
  }) : districtGroups.map(d => ({ id: d.id, name: d.name, longitude: d.longitude, latitude: d.latitude, value: d.rows.length === 1 ? metric === "occupancy" ? d.rows[0].nonVacantRatio ?? null : d.rows[0].rentPsf ?? (d.rows[0].rent == null ? null : d.rows[0].rent / 10.7639104) : null, label: d.rows.length !== 1 ? "甲 / 乙 / 丙 · 点击比较" : metric === "occupancy" ? d.rows[0].nonVacantRatio == null ? "未披露" : `${formatNumber(d.rows[0].nonVacantRatio)}% 非空置` : d.rows[0].rent == null ? "无成交数据" : `${formatNumber(d.rows[0].rent)} 港元/㎡/月`, kind: "district" })), [visibleBuildings, districtGroups, layer, metric]);
  const selectedBuilding = layer === "building" ? visibleBuildings.find(b => b.id === selectedId) : undefined;
  const selectedDistrict = layer === "district" ? districtGroups.find(d => d.id === selectedId) : undefined;
  const hasSelection = Boolean(selectedBuilding || selectedDistrict);
  const knownCount = visibleBuildings.filter(b => metric === "occupancy" ? b.occupancy != null : b.rent != null).length;

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let stopped = false;
    let finalized = false;
    let providerTimer: ReturnType<typeof setTimeout> | undefined;
    let importTimer: ReturnType<typeof setTimeout> | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let resizeFrame: number | undefined;
    let baseLayer: TileLayer | undefined;
    let labelLayer: TileLayer | undefined;
    let guard: ReturnType<typeof createBasemapLoadGuard> | undefined;
    const clearTimers = () => { clearTimeout(providerTimer); clearTimeout(importTimer); };
    const fallback = (message: string) => {
      if (stopped || finalized) return;
      finalized = true;
      clearTimers(); guard?.dispose();
      baseLayer?.off(); labelLayer?.off();
      resizeObserver?.disconnect();
      if (resizeFrame != null) cancelAnimationFrame(resizeFrame);
      setMapError(message); setMapStatus("fallback"); setMapInitialized(false);
      if (mapRef.current) {
        const center = mapRef.current.getCenter();
        lastViewRef.current = { center: [center.lat, center.lng], zoom: mapRef.current.getZoom() };
        mapRef.current.remove(); mapRef.current = null;
      }
    };
    useCoordinatesRef.current = () => fallback("已切换至真实坐标示意。楼宇及来源仍可查看。");
    setMapInitialized(false); setMapStatus("loading"); setMapError(""); setActiveProvider(requestedProvider);
    // This timer also covers a module download that never resolves.
    importTimer = setTimeout(() => fallback("地图组件未能完成加载，已切换至真实坐标示意。"), BASEMAP_TIMEOUT_MS);
    import("leaflet").then((L) => {
      if (stopped || finalized) return;
      clearTimeout(importTimer);
      try {
        const map = L.map(container, {
          minZoom: 10, maxZoom: 19, zoomControl: false,
          attributionControl: true, maxBounds: [[22.12, 113.8], [22.62, 114.5]],
          maxBoundsViscosity: 0.8, preferCanvas: false,
          zoomAnimation: true, fadeAnimation: true,
        });
        mapRef.current = map;
        map.attributionControl.setPrefix(false);
        if (lastViewRef.current) map.setView(lastViewRef.current.center, lastViewRef.current.zoom);
        else map.fitBounds([[22.265, 114.10], [22.34, 114.245]], { padding: [45, 45] });
        L.control.zoom({ position: "topright" }).addTo(map);
        L.control.scale({ imperial: false, position: "bottomleft" }).addTo(map);
        const labelsPane = map.createPane("office-map-labels");
        labelsPane.style.zIndex = "350"; labelsPane.style.pointerEvents = "none";
        map.on("zoomend", () => { if (!stopped && !finalized) setMapZoom(map.getZoom()); });
        setMapZoom(map.getZoom()); setMapInitialized(true); setMapGeneration(value => value + 1);
        const resize = () => {
          if (stopped || finalized || mapRef.current !== map) return;
          if (resizeFrame != null) cancelAnimationFrame(resizeFrame);
          resizeFrame = requestAnimationFrame(() => {
            if (!stopped && !finalized && mapRef.current === map) map.invalidateSize({ pan: false, debounceMoveend: true });
          });
        };
        if (typeof ResizeObserver !== "undefined") {
          resizeObserver = new ResizeObserver(resize); resizeObserver.observe(container);
        }
        resize();
        const startProvider = (provider: BasemapProvider, automatic = false) => {
          if (stopped || finalized || mapRef.current !== map || !guard) return;
          clearTimeout(providerTimer);
          baseLayer?.off(); labelLayer?.off();
          baseLayer?.remove(); labelLayer?.remove(); baseLayer = undefined; labelLayer = undefined;
          const token = guard.begin(provider);
          const source = BASEMAPS[provider];
          setActiveProvider(provider); setMapStatus("loading");
          setMapError(automatic ? "香港地政总署底图暂未连接，正在尝试 OpenStreetMap 备用底图。" : "");
          baseLayer = L.tileLayer(source.tiles, {
            minZoom: 10, maxZoom: 19, maxNativeZoom: source.maxNativeZoom,
            attribution: source.attribution, noWrap: true, keepBuffer: 1,
            updateWhenIdle: true, updateWhenZooming: false,
            className: "map-base-tiles", referrerPolicy: "strict-origin-when-cross-origin",
          });
          baseLayer.on("tileload", () => {
            if (stopped || finalized) return;
            if (guard?.tileLoaded(token)) clearTimeout(providerTimer);
          });
          // Individual failed tiles never remove an otherwise usable map.
          baseLayer.on("tileerror", () => { if (!stopped && !finalized) guard?.tileFailed(token); });
          baseLayer.on("load", () => {
            if (!stopped && !finalized && guard?.requestBatchFinished(token)) guard.expire(token);
          });
          providerTimer = setTimeout(() => { if (!stopped && !finalized) guard?.expire(token); }, BASEMAP_TIMEOUT_MS);
          baseLayer.addTo(map);
          if (source.labels) {
            labelLayer = L.tileLayer(source.labels, {
              pane: "office-map-labels", minZoom: 10, maxZoom: 19, maxNativeZoom: 20,
              noWrap: true, keepBuffer: 1, updateWhenIdle: true, updateWhenZooming: false,
              className: "map-label-tiles", referrerPolicy: "strict-origin-when-cross-origin",
            });
            labelLayer.addTo(map);
          }
        };
        guard = createBasemapLoadGuard({
          onReady: () => { if (!stopped && !finalized) { setMapStatus("ready"); setMapError(""); } },
          onSwitch: provider => startProvider(provider, true),
          onFallback: () => fallback("街道底图暂时无法连接，已切换至真实坐标示意；楼宇及来源仍可查看。"),
        });
        startProvider(requestedProvider);
      } catch (error) {
        console.error("Office map initialization failed", error);
        fallback("地图未能初始化，已切换至真实坐标示意。");
      }
    }).catch((error) => {
      console.error("Office map module failed to load", error);
      fallback("地图组件无法加载，已切换至真实坐标示意。");
    });
    return () => {
      stopped = true; clearTimers(); guard?.dispose();
      baseLayer?.off(); labelLayer?.off(); resizeObserver?.disconnect();
      if (resizeFrame != null) cancelAnimationFrame(resizeFrame);
      useCoordinatesRef.current = () => {};
      markersRef.current.forEach(marker => marker.remove()); markersRef.current = [];
      if (mapRef.current) {
        const center = mapRef.current.getCenter();
        lastViewRef.current = { center: [center.lat, center.lng], zoom: mapRef.current.getZoom() };
        mapRef.current.remove(); mapRef.current = null;
      }
    };
  }, [retry, requestedProvider]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapInitialized) return;
    let stopped = false;
    markersRef.current.forEach(marker => marker.remove()); markersRef.current = [];
    import("leaflet").then((L) => {
      if (stopped || mapRef.current !== map) return;
      points.forEach(point => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `map-pin ${point.kind === "district" ? "map-pin-region" : ""} ${selectedId === point.id ? "map-pin-selected" : ""} ${mapZoom >= 15.5 ? "map-pin-detailed" : ""}`;
        button.style.setProperty("--map-pin-color", metricColor(point.value, metric));
        button.setAttribute("aria-label", `${point.name}，${metric === "rent" ? "租金" : "出租率"}${point.label}，查看资料`);
        const dot = document.createElement("span"); dot.className = "map-pin-dot";
        const label = document.createElement("span"); label.className = "map-pin-label";
        const name = document.createElement("strong"); name.textContent = point.name;
        const value = document.createElement("span"); value.textContent = point.label;
        label.appendChild(name); label.appendChild(value); button.appendChild(dot); button.appendChild(label);
        L.DomEvent.disableClickPropagation(button);
        button.addEventListener("click", () => setSelectedId(point.id));
        const icon = L.divIcon({ html: button, className: "map-marker-shell", iconSize: [26, 26], iconAnchor: [13, 13] });
        markersRef.current.push(L.marker([point.latitude, point.longitude], { icon, keyboard: false, riseOnHover: true, zIndexOffset: selectedId === point.id ? 1000 : 0 }).addTo(map));
      });
    });
    return () => { stopped = true; markersRef.current.forEach(marker => marker.remove()); markersRef.current = []; };
  }, [points, selectedId, metric, mapInitialized, mapGeneration, mapZoom]);

  const resetView = () => {
    const valid = buildings.filter(b => validMapCoordinate(b.longitude, b.latitude));
    if (valid.length > 0) mapRef.current?.fitBounds([[Math.min(...valid.map(b => b.latitude)), Math.min(...valid.map(b => b.longitude))], [Math.max(...valid.map(b => b.latitude)), Math.max(...valid.map(b => b.longitude))]], { padding: [65, 65], maxZoom: 14, duration: 0.7 });
    setFallbackReset(v => v + 1);
  };
  const chooseLayer = (next: "building" | "district") => { setLayer(next); setSelectedId(null); };

  return <section className="map-workspace" aria-label="香港写字楼地图">
    <div className="map-toolbar">
      <div className="map-toggle" aria-label="地图层级"><button type="button" className={layer === "building" ? "map-active" : ""} onClick={() => chooseLayer("building")}>楼宇观察</button><button type="button" className={layer === "district" ? "map-active" : ""} onClick={() => chooseLayer("district")}>片区数据</button></div>
      <div className="map-toggle" aria-label="地图指标"><button type="button" className={metric === "rent" ? "map-active" : ""} onClick={() => setMetric("rent")}>租金</button><button type="button" className={metric === "occupancy" ? "map-active" : ""} onClick={() => setMetric("occupancy")}>{layer === "district" ? "非空置比例" : "出租率"}</button></div>
      <label className="map-grade"><span className="map-sr-only">楼宇级别</span><select value={grade} onChange={e => setGrade(e.target.value)}><option value="all">全部级别</option><option value="A">甲级</option><option value="B">乙级</option><option value="C">丙级</option><option value="unknown">未确认级别</option></select></label>
      <label className="map-search"><svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m15.5 15.5 5 5"/></svg><span className="map-sr-only">搜索楼宇或片区</span><input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索楼宇、片区…"/><button type="button" className="map-search-clear" onClick={() => setSearch("")} hidden={!search} aria-label="清除搜索">×</button></label>
      <button type="button" className="map-reset" onClick={resetView}>显示全部</button>
    </div>
    <div className="map-context"><span><strong>{points.length}</strong> {layer === "building" ? "幢已收录楼宇" : "个办公分区"}{layer === "building" && ` · ${knownCount} 幢披露当前所选指标`}</span><span>{layer === "district" ? "区域标记为定位点，不代表分区边界" : "公开资料样本 · 非全港楼宇普查"}</span></div>
    <div className="map-body">
      <div className="map-canvas-area">
        <div ref={containerRef} className={`map-canvas ${mapStatus === "fallback" ? "map-canvas-hidden" : ""}`} aria-label="可缩放的香港街道地图"/>
        <div className="map-provider-control"><label><span className="map-sr-only">底图来源</span><select value={activeProvider} onChange={e => { setRequestedProvider(e.target.value as BasemapProvider); setRetry(value => value + 1); }}><option value="lands">香港地政总署</option><option value="osm">OpenStreetMap</option></select></label><button type="button" onClick={() => { setRequestedProvider(activeProvider); setRetry(value => value + 1); }}>重试</button></div>
        {mapStatus === "loading" && <div className="map-loading" role="status"><span className="map-loading-dot"/><span>{mapError || `正在连接${BASEMAPS[activeProvider].name}底图…`}</span><button type="button" onClick={() => useCoordinatesRef.current()}>坐标示意</button></div>}
        {activeProvider === "lands" && mapStatus !== "fallback" && <a className="map-lands-credit" href="https://portal.csdi.gov.hk/" target="_blank" rel="noopener noreferrer"><img src={`${import.meta.env.BASE_URL}maps/lands-department-logo.png`} alt="地政总署 Lands Department"/><span>Map from Lands Department<small>CSDI Portal ↗</small></span></a>}
        {mapStatus === "fallback" && <><CoordinateFallback points={points} metric={metric} selectedId={selectedId} onSelect={setSelectedId} resetToken={fallbackReset}/><div className="map-fallback-banner" role="status"><span>{mapError}</span><button type="button" onClick={() => { setRequestedProvider("lands"); setRetry(v => v + 1); }}>重试底图</button></div></>}
        <div className="map-map-caption"><span className="map-eyebrow">HONG KONG OFFICE MONITOR</span><strong>{layer === "building" ? "楼宇观察地图" : "办公片区比较"}</strong><span>{metric === "rent" ? layer === "building" ? "叫租、披露租金分列；点击查看口径" : "RVD 分级平均租金 · 观察期见详情" : (layer === "district" ? "2025 年底 · 100% 减官方空置率" : "仅显示公开披露；未知值不作估算")}</span></div>
        {points.length === 0 && <div className="map-no-results">没有符合筛选条件的记录。<button type="button" onClick={() => { setSearch(""); setGrade("all"); }}>清除筛选</button></div>}
        <div className="map-legend"><span>{metric === "rent" ? (layer === "building" ? "公开叫租：低 → 高" : "分级租金：低 → 高") : (layer === "district" ? "非空置：低 → 高" : "出租率：低 → 高")}</span><div className="map-legend-ramp"><i style={{ background: metricColor(metric === "rent" ? 20 : 60, metric) }}/><i style={{ background: metricColor(metric === "rent" ? 35 : 75, metric) }}/><i style={{ background: metricColor(metric === "rent" ? 60 : 90, metric) }}/><i style={{ background: metricColor(metric === "rent" ? 90 : 98, metric) }}/></div><span className="map-legend-unknown"><i/>未披露／不可比较</span><small>{metric === "rent" ? layer === "building" ? "仅叫租着色，范围取下限；其他租金请点开查看" : "选单一级别显示色阶；原值单位港元/㎡/月" : (layer === "district" ? "非空置不等同已签约出租率；年份见详情" : "披露时点及物业范围可能不同")}</small></div>
      </div>
      <aside className="map-detail" aria-label="楼宇及片区详情" aria-live="polite">
        {selectedBuilding ? <BuildingDetail building={selectedBuilding} onClose={() => setSelectedId(null)}/> : selectedDistrict ? <DistrictDetail group={selectedDistrict} onClose={() => setSelectedId(null)}/> : <div className="map-empty-detail"><span className="map-empty-icon"><PinIcon/></span><div className="map-eyebrow">PROPERTY INTELLIGENCE</div><h3>{layer === "building" ? "从一幢楼开始" : "选择一个办公片区"}</h3><p>{layer === "building" ? "点击地图上的标记，查阅公开租金、出租率、租户证据及原始来源。" : "比较甲、乙、丙级写字楼的平均租金；不同级别保持独立，不混合计算。"}</p><div className="map-detail-note"><strong>看数，也看口径</strong><p>挂牌叫租不等于成交租金；业主组合数据不分摊到单幢。未披露的数据留空。</p></div><div className="map-building-list-label">{layer === "building" ? "当前楼宇" : "当前片区"}</div><div className="map-building-list">{points.slice(0, 8).map(p => <button type="button" key={p.id} onClick={() => { setSelectedId(p.id); mapRef.current?.flyTo([p.latitude, p.longitude], 15, { duration: 0.65 }); }}><span>{p.name}</span><span aria-hidden="true">↗</span></button>)}</div></div>}
        {!hasSelection && layer === "district" && metric === "occupancy" && <p className="map-data-warning">片区为2025年底官方非空置比例，非业主已签约出租率；选择单一级别可显示色阶。</p>}
      </aside>
    </div>
    {districtVacancy.length > 0 && layer === "district" && <AnnualDistrictTable rows={districtVacancy} grade={grade} search={query}/>}
    <div className="map-footnote">地图按核实坐标定位；价格、面积口径及披露日期以每条来源为准。底图在线按需加载，未预抓取或批量下载。灰色表示缺少可比数值，不表示零租金或空置。</div>
  </section>;
}

function BuildingDetail({ building: b, onClose }: { building: OfficeBuilding; onClose: () => void }) {
  const notes = Array.isArray(b.notes) ? b.notes : b.notes ? [b.notes] : [];
  return <><div className="map-detail-heading"><div className="map-eyebrow">{b.district} · {officeGradeLabel(b.grade)}</div><button type="button" className="map-close" onClick={onClose} aria-label="关闭楼宇详情">×</button><h3>{b.name}</h3>{b.nameEn && <p className="map-building-en">{b.nameEn}</p>}<p className="map-address">{b.address || "地址未披露"}</p></div>
    <div className="map-detail-section"><div className="map-field-heading"><h4>租金</h4><span>{b.rent?.type || "未披露"}</span></div><div className="map-metric-number">{rentText(b.rent)}</div>{b.rent && <><p className="map-metric-unit">{b.rent.unit}</p><dl className="map-metadata"><div><dt>面积口径</dt><dd>{b.rent.areaBasis || "未披露"}</dd></div><div><dt>观察日期</dt><dd>{b.rent.period || "未披露"}</dd></div></dl>{b.rent.note && <p className="map-field-note">{b.rent.note}</p>}<LinkSource href={b.rent.sourceUrl}/></>}</div>
    <div className="map-detail-section"><div className="map-field-heading"><h4>出租率</h4><span>按公开披露</span></div><div className="map-metric-number">{b.occupancy ? `${formatNumber(b.occupancy.value)}%` : "未披露"}</div>{b.occupancy ? <><dl className="map-metadata"><div><dt>观察日期</dt><dd>{b.occupancy.period}</dd></div><div><dt>统计范围</dt><dd>{b.occupancy.basis}</dd></div></dl>{b.occupancy.note && <p className="map-field-note">{b.occupancy.note}</p>}<LinkSource href={b.occupancy.sourceUrl}/></> : <p className="map-field-note">未以挂牌数量或片区均值估算该楼宇出租率。</p>}</div>
    <div className="map-detail-section"><div className="map-field-heading"><h4>已公开核实租户</h4><span>{b.tenants?.length || 0} 条证据</span></div>{b.tenants?.length ? b.tenants.map((tenant, i) => <div className="map-tenant" key={`${tenant.name}-${i}`}><strong>{tenant.name}</strong><span className="map-tenant-status">{tenant.status}</span><p>{tenant.period || "日期未披露"}</p>{tenant.note && <p>{tenant.note}</p>}<LinkSource href={tenant.sourceUrl}>租户证据</LinkSource></div>) : <p className="map-field-note">暂无已收录的租户证据，不代表楼宇没有租户。</p>}<p className="map-disclaimer">部分公开记录，不构成完整租户名册。</p></div>
    <div className="map-detail-section"><h4>物业与定位</h4><dl className="map-metadata"><div><dt>业主</dt><dd>{b.owner || "未披露"}</dd></div><div><dt>坐标精度</dt><dd>{b.coordinatePrecision || "楼宇定位点"}</dd></div><div><dt>经纬度</dt><dd>{b.longitude.toFixed(5)}, {b.latitude.toFixed(5)}</dd></div></dl>{b.coordinateSource && <LinkSource href={b.coordinateSource}>定位依据</LinkSource>}{b.sourceUrl && <p><LinkSource href={b.sourceUrl}>物业来源</LinkSource></p>}{notes.map((note, i) => <p className="map-field-note" key={i}>{note}</p>)}</div></>;
}

function DistrictDetail({ group, onClose }: { group: DistrictGroup; onClose: () => void }) {
  return <><div className="map-detail-heading"><div className="map-eyebrow">RVD · OFFICE SUB-DISTRICT</div><button type="button" className="map-close" onClick={onClose} aria-label="关闭片区详情">×</button><h3>{group.name}</h3><p className="map-address">官方办公分区 · 点位示意</p></div><div className="map-detail-section"><h4>不同级别平均租金</h4>{group.rows.map(row => <div className="map-district-row" key={row.id}><div className="map-field-heading"><strong>{officeGradeLabel(row.grade)}</strong><span>{row.period}</span></div><div className="map-metric-number">{row.rent == null ? "无成交数据" : formatNumber(row.rent)}</div><p className="map-metric-unit">{row.unit} · {row.areaBasis}</p>{row.provisional && <p className="map-field-note">临时数字</p>}{row.sampleFlag && <p className="map-field-note">{row.sampleFlag}</p>}<LinkSource href={row.sourceUrl}/></div>)}<p className="map-disclaimer">不同期平均租金受成交样本构成影响，不能直接视为同质物业涨跌；走势判断请参照租金指数。</p></div><div className="map-detail-section"><h4>官方非空置比例</h4>{group.rows.map(row => <div className="map-district-row" key={`${row.id}-vacancy`}><div className="map-field-heading"><strong>{officeGradeLabel(row.grade)}</strong><span>{row.vacancyPeriod || "观察期未披露"}</span></div><div className="map-metric-number">{row.nonVacantRatio == null ? "未披露" : `${formatNumber(row.nonVacantRatio)}%`}</div><p className="map-field-note">{row.vacancyNote || "100% 减官方空置率；非业主已签约出租率。"}</p><LinkSource href={row.vacancySourceUrl}/></div>)}</div></>;
}

function AnnualDistrictTable({ rows, grade, search }: { rows: OfficeDistrictVacancy[]; grade: string; search: string }) {
  const districts = ["中西區", "灣仔", "東區", "南區", "油尖旺", "深水埗", "九龍城", "黃大仙", "觀塘", "葵青", "荃灣", "屯門", "元朗", "北區", "大埔", "沙田", "西貢", "離島"];
  const grades = grade === "all" ? ["A", "B", "C"] : [grade];
  const grouped = districts.map(name => ({ name, values: rows.filter(row => row.name === name) })).filter(group => group.values.length > 0 && (!search || normalizeOfficeSearch(`${group.name} ${group.values[0]?.nameEn || ""}`).includes(search)));
  const source = rows.find(row => districts.includes(row.name));
  return <details className="map-annual-panel"><summary><span>18区年度空置率</span><span className="map-annual-date">{source?.period || "观察期见来源"} · 官方年末数据</span><span className="map-annual-expand">展开比较 ＋</span></summary><div className="map-annual-content"><p>行政区与办公分区分别呈现。以下为年度空置率，不作为上方楼宇或分区点位的推算值。</p><div className="map-annual-scroll"><table><thead><tr><th scope="col">行政区</th>{grades.map(g => <th scope="col" key={g}>{officeGradeLabel(g)}空置率</th>)}</tr></thead><tbody>{grouped.map(group => <tr key={group.name}><th scope="row">{group.name}</th>{grades.map(g => { const row = group.values.find(item => normalizeOfficeGrade(item.grade) === g); return <td key={g}>{row?.vacancy == null ? "未披露" : `${formatNumber(row.vacancy)}%`}</td>; })}</tr>)}</tbody></table>{grouped.length === 0 && <p>没有符合当前搜索条件的行政区。</p>}</div><div className="map-annual-source"><span>RVD · IFA 面积口径 · 无存量或无统计值不填零</span><LinkSource href={source?.sourceUrl}>年度原始表 T17</LinkSource></div></div></details>;
}

function CoordinateFallback({ points, metric, selectedId, onSelect, resetToken }: { points: MapPoint[]; metric: Metric; selectedId: string | null; onSelect: (id: string) => void; resetToken: number }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const projected = useMemo(() => points.map(p => ({ ...p, ...projectOfficePoint(p.longitude, p.latitude) })), [points]);
  const initialView = useMemo(() => {
    if (!projected.length) return { x: 0, y: 0, width: 900, height: 620 };
    const xs = projected.map(p => p.x), ys = projected.map(p => p.y);
    const width = Math.max(450, Math.max(...xs) - Math.min(...xs) + 160);
    const height = Math.max(400, Math.max(...ys) - Math.min(...ys) + 190);
    return { x: (Math.max(...xs) + Math.min(...xs) - width) / 2, y: (Math.max(...ys) + Math.min(...ys) - height) / 2, width, height };
  }, [projected]);
  const [view, setView] = useState(initialView);
  const drag = useRef<{ x: number; y: number; view: typeof view } | null>(null);
  useEffect(() => setView(initialView), [initialView, resetToken]);
  const zoom = (factor: number) => setView(v => { const width = Math.min(5000, Math.max(100, v.width * factor)); const height = v.height * width / v.width; return { x: v.x + (v.width - width) / 2, y: v.y + (v.height - height) / 2, width, height }; });
  useEffect(() => {
    const svg = svgRef.current; if (!svg) return;
    const wheel = (event: WheelEvent) => { event.preventDefault(); const factor = event.deltaY > 0 ? 1.13 : 0.885; setView(v => { const rect = svg.getBoundingClientRect(); const fx = (event.clientX - rect.left) / rect.width, fy = (event.clientY - rect.top) / rect.height; const width = Math.min(5000, Math.max(100, v.width * factor)), height = v.height * width / v.width; return { x: v.x + (v.width - width) * fx, y: v.y + (v.height - height) * fy, width, height }; }); };
    svg.addEventListener("wheel", wheel, { passive: false }); return () => svg.removeEventListener("wheel", wheel);
  }, []);
  const scale = Math.max(0.5, view.width / 900);
  return <div className="map-fallback"><svg ref={svgRef} className="map-coordinate-svg" viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`} aria-label="真实经纬度散点示意，无街道底图；可拖动和缩放" onPointerDown={e => { if (e.target !== e.currentTarget && !(e.target instanceof SVGRectElement)) return; drag.current = { x: e.clientX, y: e.clientY, view }; e.currentTarget.setPointerCapture(e.pointerId); }} onPointerMove={e => { if (!drag.current) return; const rect = e.currentTarget.getBoundingClientRect(); const d = drag.current; setView({ ...d.view, x: d.view.x - (e.clientX - d.x) / rect.width * d.view.width, y: d.view.y - (e.clientY - d.y) / rect.height * d.view.height }); }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <defs><pattern id="office-map-coordinate-grid" width="100" height="100" patternUnits="userSpaceOnUse"><path d="M 100 0 L 0 0 0 100" fill="none" stroke="#d8d0c5" strokeWidth="0.8"/></pattern></defs><rect x={view.x} y={view.y} width={view.width} height={view.height} fill="url(#office-map-coordinate-grid)"/>
      {projected.map(p => <g key={p.id} role="button" tabIndex={0} aria-label={`${p.name}，${p.label}`} onClick={() => onSelect(p.id)} onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(p.id); } }} style={{ cursor: "pointer" }}><circle cx={p.x} cy={p.y} r={(p.id === selectedId ? 10 : 7) * scale} fill={metricColor(p.value, metric)} stroke={p.id === selectedId ? "#252d30" : "#fffaf5"} strokeWidth={2.2 * scale}/><title>{p.name} · {p.label}</title>{(p.kind === "district" || p.id === selectedId || view.width < 500) && <text x={p.x + 12 * scale} y={p.y + 4 * scale} fontSize={12 * scale} fill="#252d30" paintOrder="stroke" stroke="#fff1e5" strokeWidth={3 * scale} strokeLinejoin="round">{p.name}</text>}</g>)}
    </svg><div className="map-fallback-controls"><button type="button" onClick={() => zoom(0.75)} aria-label="放大坐标示意">+</button><button type="button" onClick={() => zoom(1.333)} aria-label="缩小坐标示意">−</button></div><div className="map-coordinate-disclaimer">坐标示意 · 无街道底图 · 北 ↑<br/><span>点位使用核实经纬度，网格不是街道或行政边界</span></div></div>;
}
