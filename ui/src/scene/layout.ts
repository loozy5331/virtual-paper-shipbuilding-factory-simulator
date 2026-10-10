// 해안 조선소 야드의 배치(3.2). 현장 3D(yard.ts, coast.ts), 작업 현황 2D(cctv.ts), 공용 적치장(stock.ts)이 같은 자리를 쓴다.
// 자리를 고칠 때는 여기 한 곳만 고친다. Three.js를 모른다. 단위는 대략 소인 키의 4배, x는 오른쪽(바다 쪽), z는 앞(카메라 쪽).
//
// 구획(D38): 공정이 늘면 야드 전체를 한 화면에 담을 수 없어 실제 조선소처럼 나눈다. 카메라는 구획 하나씩 옮겨 다닌다.
//   내업 구획(왼쪽, 공용): 가공 공장(절단·가공, D43), 소조립·중조립 공장, 블록 마감동(도장·선행의장, 4.0), 물류창고, 연구소, 작업대기소, 차고, 적치장
//   1도크 구획(큰길 뒤)·2도크 구획(큰길 앞): PE장, 도크, 골리앗 크레인. PE장 적치장과 탑재 대기 줄은 1도크 구획에
//   안벽 구획: 매립 안벽의 정박 자리(안벽의장, 4.0), 만 밖 바다(시운전), 인도한 배
// 큰길(가로)이 내업에서 두 도크 구획 사이를 지나 안벽까지 간다. 구획은 그림일 뿐 엔진 규칙이 아니다.
// PE장 작업장과 도크의 짝도 그림에서만: 도크가 둘이면 PE장 1호는 1도크, 2·3호는 2도크 구획. 도크가 하나면 PE장은 모두 1도크 구획.

export type SectorId = "shop" | "dock1" | "dock2" | "quay";
export interface Sector { id: SectorId; name: string; x0: number; x1: number; z0: number; z1: number }

/** 정반 폭, 첫 줄 정반 깊이, 뒷줄 정반 깊이, 정반 두께 */
export const MAT_W = 3.2, MAT_D = 2.6, MAT2_D = 2.3, MAT_TOP = 0.08;
/** 공장의 1호·2호·3호 작업장 줄(3.0): 1호 뒤로 한 줄씩 */
export const UNIT_Z = [0, -2.85, -5.65];
export const unitZ = (unit: number) => UNIT_Z[unit] ?? 0;
export const unitDepth = (unit: number) => (unit === 0 ? MAT_D : MAT2_D);

/** 큰길(운반로)과 탑재 앞 대기 줄 */
export const LANE_Z = 3.7;
export const QUEUE_Z = 2.2;
/** 해안: 오른쪽 안벽(이 너머가 바다) */
export const SHORE_X = 11.2;

/** 공정 번호(4.0, 공정 10개): 화면 코드는 숫자 대신 이 이름을 쓴다(rules.json의 공정 순서와 같다) */
export const ST = { cut: 0, proc: 1, sub: 2, block: 3, paint: 4, preout: 5, pe: 6, dock: 7, quay: 8, trial: 9 } as const;
/** 내업 공장(벽과 지붕이 있는 공정): 절단, 가공, 소조립, 중조립, 도장, 선행의장 */
export const isShop = (station: number) => station <= ST.preout;

/**
 * 공정의 가운데 x: 가공 공장의 절단·가공(같은 건물, D43), 소조립·중조립, 블록 마감동의 도장·선행의장(같은 건물, 4.0), PE장, 탑재(도크),
 * 안벽의장(매립 안벽 1번 정박 자리), 시운전(만 밖 바다)
 */
export const STATION_X = [-36.6, -30.8, -24, -18.5, -12.6, -7.9, 3.4, 8.5, 14.4, 36];
/**
 * 컨베이어벨트(D43, 4.0.1): 둘이다. 가공 공장 안 절단 → 가공(잘라 낸 판), 가공 공장 → 소조립 공장(굽힌 판, 샛길 위를 다리로 지난다).
 * from = 벨트에 판을 올리는 공정(그 공정이 일하는 날 판이 흐른다). 그림만이고 엔진은 둘 다 다음 날 들어간다.
 */
export interface Conveyor { from: number; x0: number; x1: number; z: number; y: number; w: number }
export const CONVEYORS: Conveyor[] = [
  { from: 0, x0: STATION_X[0] + MAT_W / 2 + 0.05, x1: STATION_X[1] - MAT_W / 2 - 0.05, z: -0.7, y: 0.55, w: 0.55 },
  { from: 1, x0: STATION_X[1] + MAT_W / 2 + 0.45, x1: STATION_X[2] - MAT_W / 2 - 0.45, z: -0.7, y: 0.55, w: 0.55 },
];
/** 안벽의장 정박 자리 사이 간격, 안벽 앞 물 위 줄(z) */
const BERTH_GAP = 3.6, BERTH_Z = 10.6;
/** 도크 줄: 1도크는 큰길 뒤, 2도크는 큰길 앞(큰길을 사이에 두고 마주 본다) */
export const DOCK_Z = [0, 2 * LANE_Z];
export const dockZ = (unit: number) => DOCK_Z[unit] ?? 0;
/** 도크 앞 대기 줄(큰길 쪽) */
export const dockQueueZ = (unit: number) => (unit === 0 ? QUEUE_Z : 2 * LANE_Z - QUEUE_Z);

/** 작업장 하나의 정반 자리. docks = 도크(탑재 작업장) 수. */
export function benchAt(station: number, unit: number, docks: number): { x: number; z: number; d: number } {
  const x = STATION_X[station];
  if (station === ST.dock) return { x, z: dockZ(unit), d: MAT_D };
  // 안벽의장: 매립 안벽 앞 물 위에 나란히(정박 자리), 시운전: 만 밖 바다에 한 줄씩
  if (station === ST.quay) return { x: x + unit * BERTH_GAP, z: BERTH_Z, d: MAT_D };
  if (station === ST.trial) return { x, z: LANE_Z - unit * 2.4, d: MAT_D };
  if (station === ST.pe && docks >= 2 && unit > 0) {
    // 2도크 구획: 큰길에서 앞으로 한 줄씩(2호가 큰길 쪽)
    return { x, z: DOCK_Z[1] + (unit - 1) * (MAT_D / 2 + MAT2_D / 2 + 0.4), d: unit === 1 ? MAT_D : MAT2_D };
  }
  return { x, z: unitZ(unit), d: unitDepth(unit) };
}

/** 정반이 큰길에 바로 닿는가(아니면 샛길로 드나든다) */
export const nearLane = (z: number) => Math.abs(z - LANE_Z) < 4.5;

/** 작업장의 구역(벽·구획선·도크)이 차지하는 바닥. 소조립·중조립은 벽, PE장은 노란 구획선, 탑재는 드라이 도크. */
export function areaBounds(station: number, unit: number, docks: number): { x0: number; x1: number; z0: number; z1: number } {
  if (station === ST.quay) return quayWorkArea(unit);
  const { x, z, d } = benchAt(station, unit, docks);
  const pad = isShop(station) ? 0.45 : station === ST.pe ? 0.4 : 0.6;
  // 큰길 쪽 가장자리를 조금 더 넓힌다(첫 줄 앞의 공정 이름 자리)
  const roadSide = d === MAT_D ? 0.35 : 0.05;
  const front = z <= LANE_Z ? roadSide : 0.3, back = z <= LANE_Z ? 0.3 : roadSide;
  return { x0: x - MAT_W / 2 - pad, x1: x + MAT_W / 2 + pad, z0: z - d / 2 - back, z1: z + d / 2 + front };
}

/** 작업장이 있는 구획 */
export function sectorOf(station: number, unit: number, docks: number): SectorId {
  if (isShop(station)) return "shop";
  if (station >= ST.quay) return "quay";
  if (station === ST.dock) return unit === 0 ? "dock1" : "dock2";
  return docks >= 2 && unit > 0 ? "dock2" : "dock1";
}

/**
 * 샛길: 큰길에서 큰길에 닿지 않는 뒷줄 작업장으로 드나드는 길(벽을 뚫고 지나가지 않게).
 * 가공 공장 왼쪽, 소조립 왼쪽(가공 공장 오른쪽), 소조립·중조립 사이, 중조립·마감동 사이, 마감동 오른쪽, PE장 왼쪽, PE장·도크 사이
 */
export const SPUR_X = [STATION_X[ST.cut] - MAT_W / 2 - 1.45, (STATION_X[ST.proc] + MAT_W / 2 + STATION_X[ST.sub] - MAT_W / 2) / 2, (STATION_X[ST.sub] + STATION_X[ST.block]) / 2,
  STATION_X[ST.block] + MAT_W / 2 + 1.05, STATION_X[ST.preout] + MAT_W / 2 + 0.85,
  STATION_X[ST.pe] - MAT_W / 2 - 0.95, (STATION_X[ST.pe] + MAT_W / 2 + 0.4 + STATION_X[ST.dock] - MAT_W / 2 - 0.6) / 2];
/** 공정마다 들어가는 샛길(왼쪽)과 나오는 샛길(오른쪽): SPUR_X 번호. 절단·가공, 도장·선행의장은 같은 건물이라 안에서 옮긴다. −1은 샛길 없음 */
export const SPUR_IN = [0, 0, 1, 2, 3, 3, 5, 5, -1, -1], SPUR_OUT = [1, 1, 2, 3, 4, 4, 6, 6, -1, -1];

/** 트랜스포터 차고(큰길 왼쪽 끝), 작업대기소, 물류창고 선반 셋, 연구소: 모두 내업 구획 */
export const DEPOT = { x: -42.6, z: LANE_Z };
export const LOUNGE = { x: -42.2, z: -4.4 };
export const SHELF_X = [-22.2, -19.7, -17.2], SHELF_Z = -9.6;
/** 연구소(3.2): 내업 구획 왼쪽 아래(큰길 앞, 차고 옆). 둘레에 나무를 심어 가리고 큰길 쪽 출입구 하나만 둔다(보안). */
export const LAB = { x: -40.4, z: 8.7 };
/** 연구소를 둘러싼 나무 자리: 직사각형 둘레를 따라, 큰길 쪽 가운데는 출입구로 비운다 */
export const LAB_TREES: { x: number; z: number }[] = (() => {
  const out: { x: number; z: number }[] = [];
  const x0 = LAB.x - 3.1, x1 = LAB.x + 3.1, z0 = LAB.z - 2.4, z1 = LAB.z + 2.5, step = 1.05;
  for (let x = x0; x <= x1 + 1e-6; x += (x1 - x0) / Math.round((x1 - x0) / step)) {
    out.push({ x, z: z1 });
    if (Math.abs(x - LAB.x) > 1.0) out.push({ x, z: z0 });   // 출입구
  }
  for (let z = z0 + step; z < z1 - 0.3; z += step) out.push({ x: x0, z }, { x: x1, z });
  return out;
})();

/** 적치장 칸(공정마다, 탑재 제외): 칸 가운데 x, 큰길 쪽 끝 z, 큰길에서 멀어지는 방향. 내업 공정은 큰길 건너편, PE장은 1도크 구획 왼쪽 */
export const STOCK_D = 3.4, STOCK_HALF = 2.2;
export const STOCK_AT = [
  { x: (STATION_X[ST.cut] + STATION_X[ST.proc]) / 2, z0: LANE_Z + 0.8, dir: 1 },   // 가공 공장(절단·가공 함께, D43)
  { x: STATION_X[ST.sub], z0: LANE_Z + 0.8, dir: 1 },
  { x: STATION_X[ST.block], z0: LANE_Z + 0.8, dir: 1 },
  { x: (STATION_X[ST.paint] + STATION_X[ST.preout]) / 2, z0: LANE_Z + 0.8, dir: 1 },   // 블록 마감동(도장·선행의장 함께)
  { x: -1.8, z0: LANE_Z - 0.8, dir: -1 },
];
/** 공정마다 쓰는 적치장 칸(STOCK_AT 번호). −1은 적치장 없음(탑재는 도크 앞, 안벽의장·시운전은 물 위) */
export const STOCK_OF = [0, 0, 1, 2, 3, 3, 4, -1, -1, -1];
/** 적치장 칸 이름(STOCK_AT 번호 순서) */
export const STOCK_NAME = ["가공 공장 적치장", "적치장", "적치장", "마감동 적치장", "적치장"];

/** 골리앗 크레인(탑재 도크 둘레)과 트랜스포터의 위험 반경(3.0 안전). 팻말에는 "반경 10m"로 적는다. */
export const CRANE_R = 2.9;
export const CART_R = 1.4;
/** 관리자의 안전한 자리: 내업과 도크 구획 사이 큰길 앞(크레인·트랜스포터 반경 밖) */
export const SAFE_SPOT = { x: -1.5, z: LANE_Z + 1.9 };

/**
 * 매립한 안벽(3.2): 등대가 없는 앞쪽 곶과 야드 사이 바다를 메운 땅. 큰길 앞쪽 야드에 붙어 있고, 뒤쪽(만 쪽) 가장자리가 안벽이다.
 * 4.0 안벽의장·시운전이 여기서 한다. 지금은 인도한 배를 대 두는 곳(그림만).
 */
export const QUAY = { x0: SHORE_X, x1: 23, z0: 11.4, z1: 15.7 };

/**
 * 안벽의장 작업 구역(4.0): 정박 자리마다 안벽 위에 노란 구획선. 작업자는 이 안에 서서 배에 의장품을 단다(그림만).
 * 정박 자리는 2도크 모서리에서 떼어 안벽을 따라 넉넉히 둔다(BERTH_GAP).
 */
export function quayWorkArea(unit: number): { x0: number; x1: number; z0: number; z1: number } {
  const x = STATION_X[ST.quay] + unit * BERTH_GAP;
  return { x0: x - MAT_W / 2 - 0.3, x1: x + MAT_W / 2 + 0.3, z0: QUAY.z0 + 0.3, z1: QUAY.z0 + 3.1 };
}
/** 안벽의장 작업자가 서는 줄(z): 작업 구역 안, 안벽 가장자리 가까이 */
export const QUAY_WORK_Z = QUAY.z0 + 1.0;

/** 인도한 배: 안벽의장 정박 자리 바깥에 네 척씩 두 줄(겹대기). 안쪽 줄(안벽 바로 앞)은 안벽의장이 쓴다(4.0) */
export function seaSpot(i: number): { x: number; z: number } {
  return { x: QUAY.x0 + 1.7 + (i % 4) * 2.6, z: QUAY.z0 - 2.2 - Math.floor(i / 4) * 1.3 };
}

/** 안벽의장·시운전 차례를 기다리는 배: 정박 자리 오른쪽 물 위(만 입구 쪽)에 한 줄 */
export function quayQueueSpot(slot: number): { x: number; z: number } {
  return { x: QUAY.x1 + 1.6, z: BERTH_Z - slot * 1.3 };
}

/**
 * 자재 납품(3.2, 그림만): 입고일마다 길(해상·육로)마다 마차 한 대가 입고일 아침 물류창고 뒷문에 닿는다.
 *   해상(종이 = 철판): 배가 먼바다에서 등대 곶 바깥 부두(PIER)로 와서(입고 사흘 전) 이튿날 아침 짐을 마차에 넘긴다.
 *     마차는 부두에서 만의 뒤쪽 물가를 따라 굽은 길(SUPPLY_ROUTE)로 이틀 동안 달린다.
 *   육로(물감·깃발 = 의장품과 기타 자재): 마차가 뒷산 능선을 넘는 산길(LAND_ROUTE)로 사흘 동안 내려온다.
 * 창고 뒤에서 상자를 내린 뒤 왼쪽 길(SUPPLY_EXIT)로 야드를 빠져나간다.
 */
export const SEA_MATERIALS = ["paper"];
/** 등대 곶 바깥(바다 쪽) 부두: 육지 쪽 끝 x0, 바다 쪽 끝 x1 */
export const PIER = { x0: 28.4, x1: 31.4, z: -5.0 };
/** 배가 먼바다에서 부두까지 오는 물길(만 입구 너비의 바다 띠 안) */
export const SHIP_ROUTE = [{ x: 78, z: -2.5 }, { x: 52, z: -3.6 }, { x: 38, z: -4.6 }, { x: PIER.x1 + 0.9, z: PIER.z + 0.05 }];
export const SUPPLY_ROUTE = [
  { x: PIER.x0 + 0.8, z: PIER.z }, { x: 26.6, z: -5.4 }, { x: 25.2, z: -8.6 }, { x: 20, z: -9.4 }, { x: 13, z: -9.2 }, { x: 6, z: -10.8 },
  { x: -2, z: -13.0 }, { x: -9, z: -12.9 }, { x: -14.5, z: -12.7 }, { x: -19.7, z: -12.6 },
];
/** 산길: 뒷산 능선(높이 약 7)을 굽이굽이 넘어 야드 뒤로 내려와 창고 뒷문에 닿는다 */
export const LAND_ROUTE = [
  { x: -11, z: -54 }, { x: -15, z: -45 }, { x: -12, z: -38 }, { x: -15.5, z: -30 }, { x: -13, z: -22 },
  { x: -15, z: -16 }, { x: -17.5, z: -13.3 }, { x: -19.7, z: -12.6 },
];
/** 창고 뒤에서 왼쪽으로 야드를 빠져나가는 길 */
export const SUPPLY_EXIT = [{ x: -19.7, z: -12.6 }, { x: -34, z: -12.6 }, { x: -54, z: -12.2 }];
/** 납품 길을 지나는 날 수(입고일 며칠 전에 출발하나) */
export const SUPPLY_DAYS = 3;

/** 점 여럿을 지나는 부드러운 곡선(Catmull-Rom)을 촘촘한 점으로. 길이 비율로 자리를 찾을 수 있게 누적 길이를 단다. */
export interface Route { pts: { x: number; z: number }[]; len: number[] }
export function route(points: { x: number; z: number }[], step = 0.4): Route {
  const pts: { x: number; z: number }[] = [];
  const at = (i: number) => points[Math.max(0, Math.min(points.length - 1, i))];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const n = Math.max(2, Math.ceil(Math.hypot(p2.x - p1.x, p2.z - p1.z) / step));
    for (let k = 0; k < n; k++) {
      const t = k / n, t2 = t * t, t3 = t2 * t;
      const c = (a: number, b: number, d: number, e: number) =>
        0.5 * (2 * b + (-a + d) * t + (2 * a - 5 * b + 4 * d - e) * t2 + (-a + 3 * b - 3 * d + e) * t3);
      pts.push({ x: c(p0.x, p1.x, p2.x, p3.x), z: c(p0.z, p1.z, p2.z, p3.z) });
    }
  }
  pts.push(points[points.length - 1]);
  const len = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z));
  return { pts, len };
}
/** 꺾인 길(직선 구간만): 샛길·큰길처럼 직각으로 도는 길 */
export function polyline(points: { x: number; z: number }[]): Route {
  const len = [0];
  for (let i = 1; i < points.length; i++) len.push(len[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z));
  return { pts: points, len };
}

/**
 * T1 자재 키트(4.0, D39): 차고 → 샛길로 물류창고 앞(키트 싣는 자리) → 다시 샛길로 큰길 → 그 공정 앞(큰길 위).
 * 앞 구간(pick)은 하루의 준비 시간 안에, 뒤 구간(drop)은 그 뒤에 달린다. 하루 끝에는 그 공정 앞에 서 있다.
 */
export const KIT_PICK = { x: SHELF_X[1], z: SHELF_Z + 1.5 };
/** 뒷길(4.0.1): 물류창고 앞, 공장 뒷벽과 창고 사이의 가로 도로. 샛길이 모두 여기까지 이어진다. T1이 창고와 공장 사이를 이 길로 다닌다 */
export const BACK_LANE_Z = KIT_PICK.z;
export function kitRoutes(station: number): { pick: Route; drop: Route } {
  // 차고(큰길 왼쪽 끝) → 가공 공장 왼쪽 샛길 → 뒷길 → 창고 앞. 내릴 때는 뒷길에서 그 공정의 들어가는 샛길로 내려와 큰길로
  const first = SPUR_X[0], down = SPUR_X[Math.max(0, SPUR_IN[station] ?? 0)];
  return {
    pick: polyline([{ x: DEPOT.x, z: LANE_Z }, { x: first, z: LANE_Z }, { x: first, z: BACK_LANE_Z }, KIT_PICK]),
    drop: polyline([KIT_PICK, { x: down, z: BACK_LANE_Z }, { x: down, z: LANE_Z }, { x: STATION_X[station] - 1.4, z: LANE_Z }]),
  };
}

/** 길 위 u(0~1) 자리와 나아가는 방향(xz 평면 각도, +x가 0) */
export function along(r: Route, u: number): { x: number; z: number; angle: number } {
  const total = r.len[r.len.length - 1], d = Math.max(0, Math.min(1, u)) * total;
  let i = 1;
  while (i < r.len.length - 1 && r.len[i] < d) i++;
  const a = r.pts[i - 1], b = r.pts[i], seg = r.len[i] - r.len[i - 1] || 1, k = (d - r.len[i - 1]) / seg;
  return { x: a.x + (b.x - a.x) * k, z: a.z + (b.z - a.z) * k, angle: Math.atan2(b.z - a.z, b.x - a.x) };
}

/** 구획의 바닥 범위. 2도크 구획은 도크가 하나뿐이어도 "증설 예정지"로 남는다. */
export const SECTORS: Sector[] = [
  { id: "shop", name: "내업 구획", x0: -44.4, x1: -4.8, z0: -13.6, z1: 11.7 },
  { id: "dock1", name: "1도크 구획", x0: -4.5, x1: SHORE_X, z0: -7.6, z1: LANE_Z - 0.75 },
  { id: "dock2", name: "2도크 구획", x0: -4.5, x1: SHORE_X, z0: LANE_Z + 0.75, z1: 12.4 },
  { id: "quay", name: "안벽 구획", x0: SHORE_X, x1: QUAY.x1 + 0.8, z0: 7.4, z1: QUAY.z1 + 0.4 },
];
export const sector = (id: SectorId) => SECTORS.find((s) => s.id === id)!;

/** 그 회차의 구획 범위: 도크가 둘이면 PE장 2·3호가 2도크 구획으로 가서 1도크 구획 뒤쪽 땅은 쓰지 않는다. */
export function sectorBounds(id: SectorId, docks: number): Sector {
  const sec = sector(id);
  return id === "dock1" && docks >= 2 ? { ...sec, z0: -2.4 } : sec;
}

/** 야드 왼쪽 끝, 만의 가운데 z와 반폭, 곶 끝의 x, 곶 사이 물길 반폭 */
export const YARD_X0 = -46;
export const BAY_C = LANE_Z;
export const BAY_Z = 12;
export const MOUTH_X = 27;
export const BAY_MOUTH = 3.5;
/** 포장된 야드의 앞뒤 끝(z) */
export const YARD_Z0 = -14, YARD_Z1 = 15;

/** 언덕(반구를 늘린 모양): ㄷ자 산과 만의 두 팔, 곶 끝. 바닥 높이(groundY)를 함께 쓰려고 자리만 여기 둔다. color는 초록 번호 */
export interface Hill { x: number; z: number; rx: number; h: number; rz: number; color: number }
export const HILLS: Hill[] = (() => {
  const out: Hill[] = [];
  // ㄷ자: 뒤(멀리, 크게), 왼쪽, 앞(카메라 뒤라 거의 안 보임)
  for (let k = 0; k < 9; k++) out.push({ x: -50 + k * 12, z: -36 - (k % 2) * 3, rx: 11, h: 8 + (k % 3) * 2, rz: 7, color: k % 5 });
  for (let k = 0; k < 6; k++) out.push({ x: -58 - (k % 2) * 2, z: -24 + k * 12, rx: 7, h: 6 + (k % 2) * 2, rz: 9, color: (k + 2) % 5 });
  for (let k = 0; k < 8; k++) out.push({ x: -44 + k * 13, z: 42 + (k % 2) * 2, rx: 10, h: 6, rz: 6, color: (k + 1) % 5 });
  // 오른쪽 두 팔: 만을 따라 뻗다가 끝에서 안쪽으로 굽는다(곶). 물길은 남긴다. 뒤쪽 곶 끝에 등대
  for (const side of [-1, 1]) {
    out.push({ x: 18, z: BAY_C + side * (BAY_Z + 6), rx: 8, h: 5, rz: 5, color: 2 });
    out.push({ x: MOUTH_X + 1, z: BAY_C + side * (BAY_Z + 2), rx: 5, h: 3.6, rz: 5, color: 3 });
    out.push({ x: MOUTH_X, z: BAY_C + side * (BAY_MOUTH + 3.2), rx: 2.6, h: 2.2, rz: 3.2, color: 4 });
  }
  return out;
})();
/** 언덕 바닥 높이(밑면 y = −0.5) */
export const HILL_BASE = -0.5;

/** 그 자리 땅 높이: 포장된 야드·안벽 0, 풀밭 −0.02, 언덕 위면 그 높이(납품 길과 마차가 땅을 따라간다) */
export function groundY(x: number, z: number): number {
  const paved = (x >= YARD_X0 && x <= SHORE_X && z >= YARD_Z0 && z <= YARD_Z1)
    || (x >= QUAY.x0 && x <= QUAY.x1 && z >= QUAY.z0 && z <= QUAY.z1);
  let y = paved ? 0 : -0.02;
  for (const hl of HILLS) {
    const v = 1 - ((x - hl.x) / hl.rx) ** 2 - ((z - hl.z) / hl.rz) ** 2;
    if (v > 0) y = Math.max(y, HILL_BASE + hl.h * Math.sqrt(v));
  }
  return y;
}
