// 종이배 모양(hullTris)과 접힘 보간(2.0 시안에서 가져옴). 현장 3D(yard.ts)가 쓴다.

type V3 = [number, number, number];
export interface Tri { v: V3[]; side: number; lift: number }

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

/** 펼친 종이 위의 자리. 옆면을 용골 둘레로 눕힌 위치다. */
export function flatOf(v: V3, tri: Tri): V3 {
  return [v[0], tri.lift, tri.side * (Math.abs(v[2]) + v[1])];
}
