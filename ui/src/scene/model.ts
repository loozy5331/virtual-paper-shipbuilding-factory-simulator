// 종이배 모양(hullTris)과 접힘 보간(2.0 시안에서 가져옴). 현장 3D(yard.ts)가 쓴다.

type V3 = [number, number, number];
export interface Tri { v: V3[]; side: number; lift: number }

export const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
export const clamp01 = (t: number) => Math.min(1, Math.max(0, t));

/**
 * 선체 접기 모양(4.19): 고물·이물 끝(x, 높이), 평평한 갑판(가운데 몸통)의 반 길이, 용골의 반 길이.
 * 기본은 끝이 길고 위로 들린 종이배. 자동차운반선처럼 높은 상자를 얹는 배는 끝을 짧고 낮게, 몸통을 길게 접는다
 */
export interface HullShape { stern: [number, number]; bow: [number, number]; body: number; keel: number }
export const PAPER_BOAT: HullShape = { stern: [-1.15, 0.52], bow: [1.15, 0.52], body: 0.45, keel: 0.7 };

// 종이배: 용골(x축)을 가운데 두고 양옆 면이 V자로 선다. 옆면을 눕히면 종이 한 장이 된다.
export function hullTris(shape: HullShape = PAPER_BOAT): Tri[] {
  const K0: V3 = [-shape.keel, 0, 0], K1: V3 = [shape.keel, 0, 0];
  const B: V3 = [shape.stern[0], shape.stern[1], 0], S: V3 = [shape.bow[0], shape.bow[1], 0];
  const out: Tri[] = [];
  for (const side of [1, -1]) {
    const P0: V3 = [-shape.body, 0.4, 0.4 * side], P1: V3 = [shape.body, 0.4, 0.4 * side];
    for (const v of [[K0, K1, P1], [K0, P1, P0], [K0, P0, B], [K1, S, P1]] as V3[][]) out.push({ v, side, lift: 0.01 });
  }
  return out;
}

/** 펼친 종이 위의 자리. 옆면을 용골 둘레로 눕힌 위치다. */
export function flatOf(v: V3, tri: Tri): V3 {
  return [v[0], tri.lift, tri.side * (Math.abs(v[2]) + v[1])];
}
