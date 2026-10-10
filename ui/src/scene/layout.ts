// 해안 조선소 야드의 배치(3.2). 현장 3D(yard.ts, coast.ts), 작업 현황 전경 2D(cctv.ts), 공용 적치장(stock.ts)이 같은 자리를 쓴다.
// 자리를 고칠 때는 여기 한 곳만 고친다. Three.js를 모른다. 단위는 대략 소인 키의 4배, x는 오른쪽(바다 쪽), z는 앞(큰길 쪽).

/** 공정(소조립·중조립·대조립·탑재)의 가운데 x */
export const STATION_X = [-9, -3.5, 2, 8.5];
/** 정반 폭, 1호 정반 깊이, 2호·3호 정반 깊이, 정반 두께 */
export const MAT_W = 3.2, MAT_D = 2.6, MAT2_D = 2.3, MAT_TOP = 0.08;
/** 1호·2호·3호 작업장 줄(3.0): 1호 뒤로 한 줄씩 */
export const UNIT_Z = [0, -2.85, -5.65];
export const unitZ = (unit: number) => UNIT_Z[unit] ?? 0;
export const unitDepth = (unit: number) => (unit === 0 ? MAT_D : MAT2_D);

/** 작업장 하나의 구역(벽·구획선·도크)이 차지하는 바닥. 소조립·중조립은 벽, 대조립은 노란 구획선, 탑재는 드라이 도크. */
export function areaBounds(station: number, unit: number): { x0: number; x1: number; z0: number; z1: number } {
  const x = STATION_X[station], zc = unitZ(unit), d = unitDepth(unit);
  const pad = station < 2 ? 0.45 : station === 2 ? 0.4 : 0.6;
  return { x0: x - MAT_W / 2 - pad, x1: x + MAT_W / 2 + pad, z0: zc - d / 2 - 0.3, z1: zc + d / 2 + (unit === 0 ? 0.35 : 0.05) };
}

/** 탑재 앞 대기 줄, 큰길(운반로) */
export const QUEUE_Z = 2.2;
export const LANE_Z = 3.7;
/** 샛길: 소조립 왼쪽, 그리고 이웃한 공정의 작업장 사이 가운데(벽·구획선·도크를 피한다) */
export const SPUR_X = [STATION_X[0] - MAT_W / 2 - 1.45, (STATION_X[0] + STATION_X[1]) / 2,
  (STATION_X[1] + STATION_X[2] - 0.05) / 2, (STATION_X[2] + MAT_W / 2 + 0.4 + STATION_X[3] - MAT_W / 2 - 0.6) / 2];
/** 트랜스포터 차고(큰길 왼쪽 끝), 작업대기소(소조립 작업장 벽과 겹치지 않게 왼쪽으로) */
export const DEPOT = { x: -16, z: LANE_Z };
export const LOUNGE = { x: -15.6, z: -4.4 };
/** 물류창고 구역의 선반 셋(벽으로 묶음, 3호 작업장 뒤), 연구소 */
export const SHELF_X = [-7.2, -4.7, -2.2], SHELF_Z = -9.6;
export const LAB = { x: 4.6, z: -10.4 };

/** 골리앗 크레인(탑재 도크 둘레)과 트랜스포터의 위험 반경(3.0 안전). 팻말에는 "반경 10m"로 적는다. */
export const CRANE_R = 2.9;
export const CART_R = 1.4;

/** 해안: 오른쪽 안벽(이 너머가 바다), 야드 왼쪽 끝, 만의 폭(±), 곶 끝의 x, 곶 사이 물길 반폭 */
export const SHORE_X = 11.2;
export const YARD_X0 = -21;
export const BAY_Z = 10;
export const MOUTH_X = 23.5;
export const BAY_MOUTH = 3.5;
