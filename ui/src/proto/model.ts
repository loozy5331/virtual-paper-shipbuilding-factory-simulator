// 3D 시안(main.ts)과 2.5D 시안(iso.ts)이 함께 쓰는 장면 모델.
// 작업장 배치, 종이배 모양, 한 척의 시간표가 여기 있다. 그리는 방법만 두 시안이 다르다.

export type V3 = [number, number, number];
export type Tool = "knife" | "glue" | "brush" | "hammer";
export interface Tri { v: V3[]; side: number; lift: number }

export const STATIONS: { name: string; color: string; tool: Tool; workers: number; caption: string }[] = [
  { name: "재단", color: "#2a78d6", tool: "knife", workers: 1, caption: "① 재단 · 소인이 걸리버의 종이를 배 크기로 잘라 냅니다" },
  { name: "풀칠", color: "#e87ba4", tool: "glue", workers: 2, caption: "② 풀칠 · 소인 둘이 종이를 접고 붙여 배 모양을 만듭니다" },
  { name: "물감칠", color: "#008300", tool: "brush", workers: 1, caption: "③ 물감칠 · 선체에 물감을 칠합니다" },
  { name: "의장", color: "#4a3aa7", tool: "hammer", workers: 2, caption: "④ 의장 · 숙련공이 깃발을 답니다" },
];
export const SKILLED_STATION = 3;
export const BENCH_X = [-6, -2, 2, 6];

export const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
export const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

// 종이배: 용골(x축)을 가운데 두고 양옆 면이 V자로 선다. 옆면을 눕히면 종이 한 장이 된다.
export function hullTris(): Tri[] {
  const K0: V3 = [-0.7, 0, 0], K1: V3 = [0.7, 0, 0];
  const B: V3 = [-1.15, 0.52, 0], S: V3 = [1.15, 0.52, 0];
  const out: Tri[] = [];
  for (const side of [1, -1]) {
    const P0: V3 = [-0.45, 0.4, 0.4 * side], P1: V3 = [0.45, 0.4, 0.4 * side];
    for (const v of [[K0, K1, P1], [K0, P1, P0], [K0, P0, B], [K1, S, P1]] as V3[][]) out.push({ v, side, lift: 0.01 });
  }
  return out;
}

export function sailTris(): Tri[] {
  return [1, -1].map((side) => ({
    v: [[-0.5, 0.4, 0.012 * side], [0.5, 0.4, 0.012 * side], [0, 1.25, 0.012 * side]] as V3[],
    side, lift: 0.02,
  }));
}

/** 펼친 종이 위의 자리. 옆면을 용골 둘레로 눕힌 위치다. */
export function flatOf(v: V3, tri: Tri): V3 {
  return [v[0], tri.lift, tri.side * (Math.abs(v[2]) + v[1])];
}

/** 접힘 정도 t(0 펼침 ~ 1 완성)에서 삼각형 꼭짓점 위치. */
export function foldTri(tri: Tri, t: number): V3[] {
  const e = ease(clamp01(t));
  return tri.v.map((v) => {
    const f = flatOf(v, tri);
    return [f[0] + (v[0] - f[0]) * e, f[1] + (v[1] - f[1]) * e, f[2] + (v[2] - f[2]) * e] as V3;
  });
}

// 한 척의 시간표: 재단 → 이동 → 풀칠 → 이동 → 물감칠(불량이면 재작업) → 이동 → 의장 → 진수
export type Phase =
  | { kind: "process"; station: number; dur: number }
  | { kind: "rework"; station: number; dur: number }
  | { kind: "move"; from: number; dur: number }
  | { kind: "launch"; dur: number }
  | { kind: "rest"; dur: number };

/** 물감칠 칸의 순서. 이 칸이 끝나기 전이면 불량 토글을 지금 배에도 반영할 수 있다. */
export const PAINT_PHASE_INDEX = 4;

export function buildSchedule(defect: boolean): Phase[] {
  const work = 3.2;
  const phases: Phase[] = [];
  STATIONS.forEach((_, i) => {
    phases.push({ kind: "process", station: i, dur: work });
    if (i === 2 && defect) phases.push({ kind: "rework", station: i, dur: work * 0.5 });
    phases.push(i < STATIONS.length - 1 ? { kind: "move", from: i, dur: 0.9 } : { kind: "launch", dur: 1.6 });
  });
  phases.push({ kind: "rest", dur: 0.8 });
  return phases;
}

export const REWORK_CAPTION = "③ 물감칠 · 검사에서 불량이 나와 작업량의 절반을 다시 칠합니다 (재작업)";
export const LAUNCH_CAPTION = "인도 · 완성한 배를 물그릇에 진수합니다";
