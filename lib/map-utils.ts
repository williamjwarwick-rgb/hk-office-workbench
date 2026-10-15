export const OFFICE_MAP_COLORS = {
  paper: "#fff1e5", ink: "#252d30", teal: "#0d6268", unknown: "#9b9b95",
};

export function normalizeOfficeGrade(value: string | undefined): string {
  const grade = (value || "").toUpperCase();
  if (/甲|GRADE\s*A|^A\+?$/.test(grade)) return "A";
  if (/乙|GRADE\s*B|^B$/.test(grade)) return "B";
  if (/丙|GRADE\s*C|^C$/.test(grade)) return "C";
  return "unknown";
}

export function officeGradeLabel(value: string | undefined): string {
  return ({ A: "甲级", B: "乙级", C: "丙级" } as Record<string, string>)[normalizeOfficeGrade(value)] || value || "级别未披露";
}

export function normalizeOfficeSearch(value: string): string {
  const variants: Record<string, string> = { 灣: "湾", 區: "区", 東: "东", 樓: "楼", 廈: "厦", 園: "园", 國: "国", 際: "际", 場: "场", 貿: "贸", 產: "产", 豐: "丰", 廣: "广", 鰂: "鲗", 魚: "鱼", 環: "环", 觀: "观", 銅: "铜", 鑼: "锣", 銀: "银", 華: "华", 龍: "龙", 鐘: "钟", 寶: "宝", 體: "体", 會: "会" };
  return value.toLocaleLowerCase().replace(/[灣區東樓廈園國際場貿產豐廣鰂魚環觀銅鑼銀華龍鐘寶體會]/g, char => variants[char]);
}

export function validMapCoordinate(longitude: number, latitude: number): boolean {
  return Number.isFinite(longitude) && Number.isFinite(latitude) && longitude > 113.7 && longitude < 114.6 && latitude > 22.1 && latitude < 22.7;
}

export function metricColor(value: number | null, metric: "rent" | "occupancy"): string {
  if (value == null || !Number.isFinite(value)) return OFFICE_MAP_COLORS.unknown;
  if (metric === "occupancy") return value >= 95 ? "#0d6268" : value >= 85 ? "#41878b" : value >= 70 ? "#81adb0" : "#bccfcd";
  return value >= 80 ? "#174b52" : value >= 50 ? "#0d757c" : value >= 30 ? "#5c9da0" : "#a5c9c8";
}

/** Schematic projection of verified WGS84 coordinates; never creates coastlines. */
export function projectOfficePoint(longitude: number, latitude: number) {
  return { x: (longitude - 114.16) * Math.cos(22.3 * Math.PI / 180) * 7000 + 450, y: (22.32 - latitude) * 7000 + 260 };
}

export function safePublicUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === "https:" || url.protocol === "http:" ? url.href : undefined; } catch { return undefined; }
}
