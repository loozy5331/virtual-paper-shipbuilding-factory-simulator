// 적치장(3.0, 3.2 구획): 공정마다 칸(내업 공정은 큰길 건너편, PE장은 1도크 구획). 기다리는 블록을 정반 대신 여기에 둔다.
//   들어갈 차례를 기다리는 블록(작업장·자재 대기), 나눠 하기에서 먼저 끝나 짝을 기다리는 부분, 운반을 기다리는 블록.
// 탑재는 예외: 도크로 들어갈 블록은 도크 앞에서 기다린다.
// 그림 표시일 뿐 엔진 규칙은 그대로다(적치장 이동에는 시간·비용이 들지 않는다).
// 현장 3D(yard.ts)와 작업 현황 전경 2D(cctv.ts)가 같은 자리를 쓴다. Three.js를 모른다.

import type { Frame } from "./frame";
import { ST, STOCK_AT, STOCK_OF } from "./layout";

/** 적치장 칸 수. 칸의 자리와 크기는 layout.ts의 STOCK_AT, 공정마다 쓰는 칸은 STOCK_OF(도장·선행의장은 마감동 칸 하나, 4.0) */
export const STOCK_STATIONS = STOCK_AT.length;
/** 칸마다 이름표 색을 빌려 올 공정(가공 공장은 절단, 소조립, 중조립, 마감동은 도장, PE장) */
export const STOCK_COLOR_OF: number[] = [ST.cut, ST.sub, ST.block, ST.paint, ST.pe];

/** 칸 안의 자리: 3열 × 2줄(큰길 쪽부터), 넘치면 같은 자리에 겹친다. */
export function stockSpot(station: number, index: number): { x: number; z: number } {
  const k = index % 6, at = STOCK_AT[station];
  return { x: at.x + ((k % 3) - 1) * 1.4, z: at.z0 + at.dir * (0.9 + Math.floor(k / 3) * 1.5) };
}

/**
 * 적치장에 놓일 블록과 그 자리. 키: `q:배`(들어갈 차례), `o:배`(운반 대기), `w:배:작업장`(짝 대기).
 * station은 적치장 칸 번호(stockSpot에 그대로 넘긴다). 칸이 없는 공정(탑재·안벽의장·시운전)의 블록은 넣지 않는다.
 */
export function stockAssign(f: Frame): Map<string, { station: number; index: number; reason: "queue" | "outbound" | "pair" }> {
  const out = new Map<string, { station: number; index: number; reason: "queue" | "outbound" | "pair" }>();
  for (let slot = 0; slot < STOCK_STATIONS; slot++) {
    let i = 0;
    const here = (p: number) => STOCK_OF[p] === slot;
    for (const l of f.lots.filter((v) => v.place === "queue" && here(v.station)).sort((a, b) => a.slot - b.slot)) {
      out.set(`q:${l.ship}`, { station: slot, index: i++, reason: "queue" });
    }
    for (const l of f.lots.filter((v) => v.place === "outbound" && here(v.station)).sort((a, b) => a.slot - b.slot)) {
      out.set(`o:${l.ship}`, { station: slot, index: i++, reason: "outbound" });
    }
    for (const l of f.lots.filter((v) => v.place === "bench" && here(v.station) && v.parts)) {
      for (const pt of l.parts!) {
        if (pt.state === "pair_wait") out.set(`w:${l.ship}:${pt.unit}`, { station: slot, index: i++, reason: "pair" });
      }
    }
  }
  return out;
}
