// 공용 적치장(3.0): 큰길 건너편, 공정마다 맞은편 칸. 기다리는 블록을 정반 대신 여기에 둔다.
//   들어갈 차례를 기다리는 블록(작업장·자재 대기), 나눠 하기에서 먼저 끝나 짝을 기다리는 부분, 운반을 기다리는 블록.
// 탑재는 예외: 도크로 들어갈 블록은 도크 앞에서 기다린다.
// 그림 표시일 뿐 엔진 규칙은 그대로다(적치장 이동에는 시간·비용이 들지 않는다).
// 현장 3D(yard.ts)와 작업 현황 전경 2D(cctv.ts)가 같은 자리를 쓴다. Three.js를 모른다.

import type { Frame } from "./frame";
import { LANE_Z, STATION_X } from "./layout";

/** 적치장 앞(큰길 쪽) 끝과 깊이 */
export const STOCK_Z0 = LANE_Z + 0.8;
export const STOCK_D = 3.4;
/** 칸의 반폭 */
export const STOCK_HALF = 2.2;
/** 적치장 칸이 있는 공정 수(탑재 제외) */
export const STOCK_STATIONS = 3;

/** 칸 안의 자리: 3열 × 2줄, 넘치면 같은 자리에 겹친다. */
export function stockSpot(station: number, index: number): { x: number; z: number } {
  const k = index % 6;
  return { x: STATION_X[station] + ((k % 3) - 1) * 1.4, z: STOCK_Z0 + 0.9 + Math.floor(k / 3) * 1.5 };
}

/** 적치장에 놓일 블록과 그 자리. 키: `q:배`(들어갈 차례), `o:배`(운반 대기), `w:배:작업장`(짝 대기). */
export function stockAssign(f: Frame): Map<string, { station: number; index: number; reason: "queue" | "outbound" | "pair" }> {
  const out = new Map<string, { station: number; index: number; reason: "queue" | "outbound" | "pair" }>();
  for (let p = 0; p < STOCK_STATIONS; p++) {
    let i = 0;
    for (const l of f.lots.filter((v) => v.place === "queue" && v.station === p).sort((a, b) => a.slot - b.slot)) {
      out.set(`q:${l.ship}`, { station: p, index: i++, reason: "queue" });
    }
    for (const l of f.lots.filter((v) => v.place === "outbound" && v.station === p).sort((a, b) => a.slot - b.slot)) {
      out.set(`o:${l.ship}`, { station: p, index: i++, reason: "outbound" });
    }
    for (const l of f.lots.filter((v) => v.place === "bench" && v.station === p && v.parts)) {
      for (const pt of l.parts!) {
        if (pt.state === "pair_wait") out.set(`w:${l.ship}:${pt.unit}`, { station: p, index: i++, reason: "pair" });
      }
    }
  }
  return out;
}
