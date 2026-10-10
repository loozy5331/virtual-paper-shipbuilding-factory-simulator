// 해안 조선소 야드의 배치(3.2). 현장 3D(yard.ts, coast.ts), 작업 현황 2D(cctv.ts), 공용 적치장(stock.ts)이 같은 자리를 쓴다.
// 자리를 고칠 때는 여기 한 곳만 고친다. Three.js를 모른다. 단위는 대략 소인 키의 4배, x는 오른쪽(바다 쪽), z는 앞(카메라 쪽).
//
// 구획(D38): 공정이 늘면 야드 전체를 한 화면에 담을 수 없어 실제 조선소처럼 나눈다. 카메라는 구획 하나씩 옮겨 다닌다.
//   내업 구획(왼쪽, 공용): 소조립·중조립 공장, 물류창고, 연구소, 작업대기소, 트랜스포터 차고, 두 공정의 적치장
//   1도크 구획(큰길 뒤)·2도크 구획(큰길 앞): PE장, 도크, 골리앗 크레인. PE장 적치장과 탑재 대기 줄은 1도크 구획에
//   안벽 구획(바다): 인도한 배
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

/** 공정의 가운데 x: 소조립·중조립(내업), PE장, 탑재(도크) */
export const STATION_X = [-24, -18.5, 3.4, 8.5];
/** 도크 줄: 1도크는 큰길 뒤, 2도크는 큰길 앞(큰길을 사이에 두고 마주 본다) */
export const DOCK_Z = [0, 2 * LANE_Z];
export const dockZ = (unit: number) => DOCK_Z[unit] ?? 0;
/** 도크 앞 대기 줄(큰길 쪽) */
export const dockQueueZ = (unit: number) => (unit === 0 ? QUEUE_Z : 2 * LANE_Z - QUEUE_Z);

/** 작업장 하나의 정반 자리. docks = 도크(탑재 작업장) 수. */
export function benchAt(station: number, unit: number, docks: number): { x: number; z: number; d: number } {
  const x = STATION_X[station];
  if (station === 3) return { x, z: dockZ(unit), d: MAT_D };
  if (station === 2 && docks >= 2 && unit > 0) {
    // 2도크 구획: 큰길에서 앞으로 한 줄씩(2호가 큰길 쪽)
    return { x, z: DOCK_Z[1] + (unit - 1) * (MAT_D / 2 + MAT2_D / 2 + 0.4), d: unit === 1 ? MAT_D : MAT2_D };
  }
  return { x, z: unitZ(unit), d: unitDepth(unit) };
}

/** 정반이 큰길에 바로 닿는가(아니면 샛길로 드나든다) */
export const nearLane = (z: number) => Math.abs(z - LANE_Z) < 4.5;

/** 작업장의 구역(벽·구획선·도크)이 차지하는 바닥. 소조립·중조립은 벽, PE장은 노란 구획선, 탑재는 드라이 도크. */
export function areaBounds(station: number, unit: number, docks: number): { x0: number; x1: number; z0: number; z1: number } {
  const { x, z, d } = benchAt(station, unit, docks);
  const pad = station < 2 ? 0.45 : station === 2 ? 0.4 : 0.6;
  // 큰길 쪽 가장자리를 조금 더 넓힌다(첫 줄 앞의 공정 이름 자리)
  const roadSide = d === MAT_D ? 0.35 : 0.05;
  const front = z <= LANE_Z ? roadSide : 0.3, back = z <= LANE_Z ? 0.3 : roadSide;
  return { x0: x - MAT_W / 2 - pad, x1: x + MAT_W / 2 + pad, z0: z - d / 2 - back, z1: z + d / 2 + front };
}

/** 작업장이 있는 구획 */
export function sectorOf(station: number, unit: number, docks: number): SectorId {
  if (station < 2) return "shop";
  if (station === 3) return unit === 0 ? "dock1" : "dock2";
  return docks >= 2 && unit > 0 ? "dock2" : "dock1";
}

/** 샛길: 큰길에서 큰길에 닿지 않는 뒷줄 작업장으로 드나드는 길(벽을 뚫고 지나가지 않게). */
export const SPUR_X = [STATION_X[0] - MAT_W / 2 - 1.45, (STATION_X[0] + STATION_X[1]) / 2, STATION_X[1] + MAT_W / 2 + 1.05,
  STATION_X[2] - MAT_W / 2 - 0.95, (STATION_X[2] + MAT_W / 2 + 0.4 + STATION_X[3] - MAT_W / 2 - 0.6) / 2];
/** 공정마다 들어가는 샛길(왼쪽)과 나오는 샛길(오른쪽): SPUR_X 번호 */
export const SPUR_IN = [0, 1, 3, 3], SPUR_OUT = [1, 2, 4, 4];

/** 트랜스포터 차고(큰길 왼쪽 끝), 작업대기소, 물류창고 선반 셋, 연구소: 모두 내업 구획 */
export const DEPOT = { x: -31, z: LANE_Z };
export const LOUNGE = { x: -30.6, z: -4.4 };
export const SHELF_X = [-22.2, -19.7, -17.2], SHELF_Z = -9.6;
export const LAB = { x: -13.2, z: -3.4 };

/** 적치장 칸(공정마다, 탑재 제외): 칸 가운데 x, 큰길 쪽 끝 z, 큰길에서 멀어지는 방향. 내업 두 공정은 큰길 건너편, PE장은 1도크 구획 왼쪽 */
export const STOCK_D = 3.4, STOCK_HALF = 2.2;
export const STOCK_AT = [
  { x: STATION_X[0], z0: LANE_Z + 0.8, dir: 1 },
  { x: STATION_X[1], z0: LANE_Z + 0.8, dir: 1 },
  { x: -1.8, z0: LANE_Z - 0.8, dir: -1 },
];

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

/** 인도한 배: 안벽에 나란히 네 척씩, 다섯째부터는 바깥에 한 줄 더(겹대기) */
export function seaSpot(i: number): { x: number; z: number } {
  return { x: QUAY.x0 + 1.7 + (i % 4) * 2.6, z: QUAY.z0 - 0.8 - Math.floor(i / 4) * 1.25 };
}

/** 자재 납품 길(3.2): 야드 왼쪽 끝에서 물류창고 앞까지. 입고 날 마차가 이 길로 들어와 상자를 내린다(그림만). */
export const SUPPLY = { x0: -44, z: -7.95 };

/** 구획의 바닥 범위. 2도크 구획은 도크가 하나뿐이어도 "증설 예정지"로 남는다. */
export const SECTORS: Sector[] = [
  { id: "shop", name: "내업 구획", x0: -33.5, x1: -11, z0: -11.2, z1: 8.4 },
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
export const YARD_X0 = -36;
export const BAY_C = LANE_Z;
export const BAY_Z = 12;
export const MOUTH_X = 27;
export const BAY_MOUTH = 3.5;
