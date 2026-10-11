// 현장 3D 공용 도우미(4.9.1에 yard.ts에서 나눔): 종이 재질, CSS2D 이름표, 손실 칩, 하루 안의 단계 비율.

import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { clamp01 } from "./model";
import { STATE_INFO } from "../labels";

export const PAPER = new THREE.Color("#f4f0e6");
export const PAINT = new THREE.Color("#c8553d");

/** frac이 [a, b] 구간에서 0 → 1로 가는 비율 */
export const phase = (frac: number, [a, b]: readonly [number, number]) => clamp01((frac - a) / (b - a));

export function label(html: string, className: string): CSS2DObject {
  const div = document.createElement("div");
  div.className = className;
  div.innerHTML = html;
  return new CSS2DObject(div);
}

export function setLabel(obj: CSS2DObject, html: string): void {
  if (obj.element.innerHTML !== html) obj.element.innerHTML = html;
}

export function paperMaterial(color: THREE.Color = PAPER): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: color.clone(), side: THREE.DoubleSide, flatShading: true, roughness: 0.95 });
}


export function chipHtml(state: string, text: string): string {
  const info = STATE_INFO[state];
  const light = state === "material_wait" || state === "labor_wait";
  return `<span class="chip" style="background:${info?.color ?? "#898781"};color:${light ? "#1f2a24" : "#fff"}">${text}</span>`;
}
