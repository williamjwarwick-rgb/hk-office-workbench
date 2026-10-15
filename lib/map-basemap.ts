export type BasemapProvider = "lands" | "osm";

export const BASEMAP_TIMEOUT_MS = 12_000;
export const BASEMAPS = {
  lands: {
    name: "香港地政总署",
    tiles: "https://mapapi.geodata.gov.hk/gs/api/v1.0.0/xyz/basemap/WGS84/{z}/{x}/{y}.png",
    labels: "https://mapapi.geodata.gov.hk/gs/api/v1.0.0/xyz/label/hk/tc/WGS84/{z}/{x}/{y}.png",
    attribution: '<a href="https://portal.csdi.gov.hk/" target="_blank" rel="noopener">Map from Lands Department</a>',
    maxNativeZoom: 20,
  },
  osm: {
    name: "OpenStreetMap",
    tiles: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
    labels: undefined,
    attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap contributors</a>',
    maxNativeZoom: 19,
  },
} as const;

/** A real tileload, not a source metadata event, makes a provider usable. */
export function createBasemapLoadGuard(callbacks: {
  onReady: (provider: BasemapProvider) => void;
  onSwitch: (provider: BasemapProvider) => void;
  onFallback: () => void;
}) {
  let generation = 0;
  let provider: BasemapProvider = "lands";
  let successfulTiles = 0;
  let failedTiles = 0;
  let disposed = false;
  let switchedAutomatically = false;
  let finished = false;
  const isCurrent = (token: number) => !disposed && !finished && token === generation;
  return {
    begin(next: BasemapProvider) {
      if (disposed) return -1;
      provider = next; successfulTiles = 0; failedTiles = 0; finished = false;
      return ++generation;
    },
    tileLoaded(token: number) {
      if (!isCurrent(token)) return false;
      successfulTiles += 1;
      if (successfulTiles === 1) callbacks.onReady(provider);
      return true;
    },
    tileFailed(token: number) { if (isCurrent(token)) failedTiles += 1; },
    hasSuccess(token: number) { return isCurrent(token) && successfulTiles > 0; },
    requestBatchFinished(token: number) {
      return isCurrent(token) && successfulTiles === 0 && failedTiles > 0;
    },
    expire(token: number) {
      if (!isCurrent(token) || successfulTiles > 0) return;
      finished = true;
      if (provider === "lands" && !switchedAutomatically) {
        switchedAutomatically = true;
        callbacks.onSwitch("osm");
      } else callbacks.onFallback();
    },
    dispose() { disposed = true; generation += 1; },
  };
}
