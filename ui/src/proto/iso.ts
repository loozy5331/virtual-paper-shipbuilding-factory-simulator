// 시안 2.5D: 걸리버의 책상 위 조선소를 비스듬히 내려다본 고정 시점으로 그린다.
// WebGL 없이 SVG만 쓴다. 3D 시안과 같은 장면 모델(model.ts)을 평행 투영해 다각형으로 그리고,
// 앞뒤 순서는 깊이로 정렬해 겹친다(화가 알고리즘).

import {
  BENCH_X, buildSchedule, clamp01, ease, foldTri, hullTris, LAUNCH_CAPTION, PAINT_PHASE_INDEX, REWORK_CAPTION,
  sailTris, SKILLED_STATION, STATIONS, type Phase, type Tool, type Tri, type V3,
} from "./model";

// ---------------------------------------------------------------------------
// 투영: 시점을 y축으로 YAW만큼 돌리고 PITCH만큼 내려다본다. 원근이 없는 평행 투영이다.
// ---------------------------------------------------------------------------

const YAW = (25 * Math.PI) / 180;
const PITCH = (34 * Math.PI) / 180;
const S = 46;
const cY = Math.cos(YAW), sY = Math.sin(YAW), cP = Math.cos(PITCH), sP = Math.sin(PITCH);
const VIEW: V3 = [sY * cP, sP, cY * cP];          // 화면 쪽을 향하는 방향
const LIGHT: V3 = norm([-0.5, 1, 0.55]);

function proj(p: V3): [number, number] {
  const xr = p[0] * cY - p[2] * sY;
  const zr = p[0] * sY + p[2] * cY;
  return [xr * S, (zr * sP - p[1] * cP) * S];
}
function depth(p: V3): number {
  return p[0] * VIEW[0] + p[1] * VIEW[1] + p[2] * VIEW[2];
}
function norm(v: V3): V3 {
  const l = Math.hypot(...v) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
function pts(points: V3[]): string {
  return points.map((p) => proj(p).map((n) => n.toFixed(1)).join(",")).join(" ");
}

const MAT_TOP = 0.08;
const CUP: V3 = [10.8, 0, 0.6];
const WATER_Y = 1.42;

// ---------------------------------------------------------------------------
// 색
// ---------------------------------------------------------------------------

type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const rgb = (c: RGB, f = 1) => `rgb(${c.map((v) => Math.round(Math.min(255, Math.max(0, v * f)))).join(",")})`;
const mix = (a: RGB, b: RGB, t: number): RGB => a.map((v, i) => v + (b[i] - v) * t) as RGB;

const PAPER = hex("#f4f0e6");
const PAINT = hex("#c8553d");
const DAY_BG = hex("#e9e1d1");
const NIGHT_BG = hex("#1b2231");
const REWORK = hex("#ec835a");

/** 면의 밝기: 화면을 향하도록 법선을 뒤집고, 빛과 이루는 각으로 정한다. */
function lightFactor(p: V3[]): number {
  const a: V3 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]];
  const b: V3 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
  let n = norm([a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]);
  if (n[0] * VIEW[0] + n[1] * VIEW[1] + n[2] * VIEW[2] < 0) n = [-n[0], -n[1], -n[2]];
  return 0.62 + 0.4 * Math.max(0, n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2]);
}

// ---------------------------------------------------------------------------
// SVG 도우미
// ---------------------------------------------------------------------------

const NS = "http://www.w3.org/2000/svg";
function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.append(e);
  return e;
}

const svg = el("svg", { class: "iso", preserveAspectRatio: "xMidYMid meet" });
document.getElementById("stage")!.append(svg);
const defs = el("defs", {}, svg);
const layerBack = el("g", {}, svg);       // 책상, 작업대, 소품, 견본 배, 물그릇 뒤쪽
const layerDyn = el("g", {}, svg);        // 소인과 배: 매 프레임 깊이로 정렬
const layerFront = el("g", {}, svg);      // 물그릇 앞 벽
const nightRect = el("rect", { fill: "#0c1430", opacity: 0, style: "mix-blend-mode:multiply" }, svg);
const layerGlow = el("g", { style: "mix-blend-mode:screen" }, svg);
const layerFlame = el("g", {}, svg);
const layerLabel = el("g", { class: "labels-svg" }, svg);

// 보이는 범위로 viewBox를 맞춘다.
{
  const corners: V3[] = [[-8.6, 0, 3.4], [-8.6, 0, -9.6], [14.2, 0, 3.4], [14.2, 0, -9.6], [-1, 5, -7.6], [10.8, 1.8, 3.6]];
  const xy = corners.map(proj);
  const xs = xy.map((p) => p[0]), ys = xy.map((p) => p[1]);
  const pad = 30;
  const box = [Math.min(...xs) - pad, Math.min(...ys) - pad - 40, Math.max(...xs) - Math.min(...xs) + pad * 2, Math.max(...ys) - Math.min(...ys) + pad * 2 + 70];
  svg.setAttribute("viewBox", box.join(" "));
  Object.entries({ x: box[0] - 2000, y: box[1] - 2000, width: box[2] + 4000, height: box[3] + 4000 })
    .forEach(([k, v]) => nightRect.setAttribute(k, String(v)));
}

function poly(parent: Element, points: V3[], fill: string, extra: Record<string, string | number> = {}): SVGPolygonElement {
  return el("polygon", { points: pts(points), fill, ...extra }, parent);
}

/** 축에 나란한 상자. 보이는 세 면(위, 앞 z+, 오른쪽 x+)만 그린다. */
function box(parent: Element, x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: string): void {
  const c = hex(color);
  poly(parent, [[x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]], rgb(c, 1.02));
  poly(parent, [[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], rgb(c, 0.8));
  poly(parent, [[x1, y0, z0], [x1, y0, z1], [x1, y1, z1], [x1, y1, z0]], rgb(c, 0.64));
}

/** 세운 원기둥. 수평 원은 평행 투영하면 축에 나란한 타원이 된다. */
function cylinder(parent: Element, x: number, z: number, r0: number, r1: number, y0: number, y1: number, color: string, top?: string): void {
  const [bx, by] = proj([x, y0, z]);
  const [tx, ty] = proj([x, y1, z]);
  const c = hex(color);
  const g = el("g", {}, parent);
  el("path", {
    d: `M${bx - r0 * S},${by} A${r0 * S},${r0 * S * sP} 0 0 0 ${bx + r0 * S},${by} L${tx + r1 * S},${ty} A${r1 * S},${r1 * S * sP} 0 0 1 ${tx - r1 * S},${ty} Z`,
    fill: rgb(c, 0.82),
  }, g);
  el("ellipse", { cx: tx, cy: ty, rx: r1 * S, ry: r1 * S * sP, fill: top ?? rgb(c, 1.02) }, g);
}

function pill(text: string, at: V3, opts: { dot?: string; bold?: boolean; sub?: string; className?: string } = {}): SVGGElement {
  const [x, y] = proj(at);
  const g = el("g", { transform: `translate(${x.toFixed(1)},${y.toFixed(1)})`, class: opts.className ?? "pill" }, layerLabel);
  const bg = el("rect", { rx: 12, fill: "rgba(255,255,255,0.93)" }, g);
  const t = el("text", { x: opts.dot ? 8 : 0, y: opts.sub ? -2 : 5, "text-anchor": "middle", "font-size": 14, "font-weight": opts.bold === false ? 500 : 700, fill: "#1f2a24" }, g);
  t.textContent = text;
  let sub: SVGTextElement | null = null;
  if (opts.sub) {
    sub = el("text", { x: 0, y: 15, "text-anchor": "middle", "font-size": 12, fill: "#4b5a51" }, g);
    sub.textContent = opts.sub;
  }
  const w = Math.max(t.getBBox().width, sub?.getBBox().width ?? 0) + (opts.dot ? 34 : 22);
  const h = opts.sub ? 42 : 26;
  Object.entries({ x: -w / 2, y: -h / 2 + (opts.sub ? 2 : 0), width: w, height: h }).forEach(([k, v]) => bg.setAttribute(k, String(v)));
  if (opts.dot) el("rect", { x: -w / 2 + 11, y: -5, width: 10, height: 10, rx: 3, fill: opts.dot }, g);
  return g;
}

// ---------------------------------------------------------------------------
// 정적 장면
// ---------------------------------------------------------------------------

// 책상: 나뭇결을 책상면 위의 선으로 그려 시점과 함께 기울게 한다.
{
  const D = { x0: -11, x1: 17, z0: -12, z1: 5.6 };
  poly(layerBack, [[D.x0, 0, D.z0], [D.x1, 0, D.z0], [D.x1, 0, D.z1], [D.x0, 0, D.z1]], "#c79f74");
  const grain = el("g", { fill: "none", "stroke-linecap": "round" }, layerBack);
  for (let i = 0; i < 70; i++) {
    const z = D.z0 + i * ((D.z1 - D.z0) / 70) + Math.random() * 0.15;
    const line: V3[] = [];
    for (let x = D.x0; x <= D.x1; x += 1) line.push([x, 0, z + Math.sin(x / 3 + i) * 0.06]);
    el("polyline", {
      points: pts(line),
      stroke: `rgba(${90 + Math.random() * 30},${55 + Math.random() * 20},30,${(0.06 + Math.random() * 0.12).toFixed(2)})`,
      "stroke-width": (1 + Math.random() * 2.4).toFixed(1),
    }, grain);
  }
  poly(layerBack, [[D.x0, -1, D.z1], [D.x1, -1, D.z1], [D.x1, 0, D.z1], [D.x0, 0, D.z1]], "#a47e57");
  poly(layerBack, [[D.x1, -1, D.z0], [D.x1, -1, D.z1], [D.x1, 0, D.z1], [D.x1, 0, D.z0]], "#8d6a47");
}

// 걸리버가 접은 견본 배
interface Face { points: V3[]; shaded: RGB; fill: string; depth: number }

function boatFaces(fold: number, paint: number, place: { at: V3; scale: number; yaw: number; roll?: number; pitch?: number }): Face[] {
  const hullColor = mix(PAPER, PAINT, clamp01(paint));
  const out: Face[] = [];
  const cr = Math.cos(place.roll ?? 0), sr = Math.sin(place.roll ?? 0);
  const cpi = Math.cos(place.pitch ?? 0), spi = Math.sin(place.pitch ?? 0);
  const cyw = Math.cos(place.yaw), syw = Math.sin(place.yaw);
  const tf = (v: V3): V3 => {
    // z축 기울기(앞뒤 끄덕임) → x축 기울기(옆 흔들림) → y축 회전 → 크기 → 위치
    let [x, y, z] = v;
    [x, y] = [x * cr - y * sr, x * sr + y * cr];
    [y, z] = [y * cpi - z * spi, y * spi + z * cpi];
    [x, z] = [x * cyw + z * syw, -x * syw + z * cyw];
    return [x * place.scale + place.at[0], y * place.scale + place.at[1], z * place.scale + place.at[2]];
  };
  const add = (tris: Tri[], color: RGB) => {
    for (const tri of tris) {
      const p = foldTri(tri, fold).map(tf);
      const f = lightFactor(p);
      const shaded = color.map((v) => v * f) as RGB;
      out.push({ points: p, shaded, fill: rgb(shaded), depth: (depth(p[0]) + depth(p[1]) + depth(p[2])) / 3 });
    }
  };
  add(hullTris(), hullColor);
  add(sailTris(), PAPER);
  return out;
}

{
  const faces = boatFaces(1, 0, { at: [-1, 0, -7.6], scale: 3.8, yaw: 0.12 });
  faces.sort((a, b) => a.depth - b.depth);
  // 바닥 그림자
  const shadow: V3[] = [[-5.6, 0, -7.2], [3.6, 0, -8.4], [3.9, 0, -6.2], [-5.2, 0, -5.4]];
  poly(layerBack, shadow, "rgba(70,45,20,0.16)");
  for (const f of faces) poly(layerBack, f.points, f.fill, { stroke: "#d6cfbf", "stroke-width": 0.8, "stroke-linejoin": "round" });
}

// 걸리버의 연필
box(layerBack, 1.2, 2.0, 0, 0.8, -6.9, -6.1, "#e7a3a3");
box(layerBack, 2.0, 2.4, 0, 0.82, -6.92, -6.08, "#b9b9b9");
box(layerBack, 2.4, 13.5, 0, 0.8, -6.9, -6.1, "#f2c230");
poly(layerBack, [[13.5, 0.8, -6.9], [13.5, 0.8, -6.1], [15, 0.42, -6.5]], "#ead0a4");
poly(layerBack, [[13.5, 0, -6.1], [13.5, 0.8, -6.1], [15, 0.42, -6.5]], "#c9a272");
poly(layerBack, [[14.55, 0.53, -6.62], [14.55, 0.53, -6.38], [15, 0.42, -6.5]], "#3a3a3a");

// 작업대, 이름표, 자재 더미, 촛불
const candlePoints: V3[] = [];
STATIONS.forEach((st, i) => {
  const x = BENCH_X[i];
  box(layerBack, x - 1.7, x + 1.7, 0, MAT_TOP, -1.3, 1.3, st.color);
  pill(st.name, [x, 0, 1.9], { dot: st.color });
  cylinder(layerBack, x + 1.45, -1.05, 0.12, 0.11, MAT_TOP, MAT_TOP + 0.5, "#f3e6c8");
  candlePoints.push([x + 1.45, MAT_TOP + 0.6, -1.05]);
});
for (let k = 0; k < 6; k++) box(layerBack, BENCH_X[0] - 1.55, BENCH_X[0] - 0.65, k * 0.036, k * 0.036 + 0.034, -2.3, -1.6, "#f7f3ea");
["#c8553d", "#2a78d6", "#fab219"].forEach((c, k) =>
  cylinder(layerBack, BENCH_X[2] - 1.2 + k * 0.42, -1.95, 0.17, 0.17, 0, 0.28, "#d9d4c8", c));
for (let k = 0; k < 4; k++) {
  const [x0, y0] = proj([BENCH_X[3] - 1.2 + k * 0.08, 0, -1.95]);
  el("line", { x1: x0, y1: y0, x2: x0 + (k - 1.5) * 3, y2: y0 - 0.5 * S * cP, stroke: "#6b4a2b", "stroke-width": 1.6 }, layerBack);
}

// 물그릇: 받침 접시, 안쪽 벽과 물(뒤), 바깥 앞 벽(앞)
cylinder(layerBack, CUP[0], CUP[2], 3.1, 2.95, 0, 0.12, "#e9e7df", "#f3f2ec");
{
  const [cx, cyTop] = proj([CUP[0], 1.6, CUP[2]]);
  const [, cyWater] = proj([CUP[0], WATER_Y, CUP[2]]);
  const [, cyBot] = proj([CUP[0], 0.12, CUP[2]]);
  const rTop = 2.4 * S, rBot = 2.0 * S;
  el("ellipse", { cx, cy: cyTop, rx: rTop, ry: rTop * sP, fill: "#dcd8cd" }, layerBack);
  el("ellipse", { cx, cy: cyWater, rx: 2.28 * S, ry: 2.28 * S * sP, fill: "#4f8fc0" }, layerBack);
  el("ellipse", { cx: cx - 20, cy: cyWater - 6, rx: 1.3 * S, ry: 1.3 * S * sP * 0.5, fill: "rgba(255,255,255,0.18)" }, layerBack);
  const grad = el("linearGradient", { id: "cupWall", x1: 0, x2: 1, y1: 0, y2: 0 }, defs);
  el("stop", { offset: "0", "stop-color": "#d9d6cc" }, grad);
  el("stop", { offset: "0.35", "stop-color": "#fbfaf6" }, grad);
  el("stop", { offset: "1", "stop-color": "#c9c5b9" }, grad);
  el("path", {
    d: `M${cx - rTop},${cyTop} L${cx - rBot},${cyBot} A${rBot},${rBot * sP} 0 0 0 ${cx + rBot},${cyBot} L${cx + rTop},${cyTop} A${rTop},${rTop * sP} 0 0 1 ${cx - rTop},${cyTop} Z`,
    fill: "url(#cupWall)",
  }, layerFront);
  el("path", { d: `M${cx - rTop},${cyTop} A${rTop},${rTop * sP} 0 0 0 ${cx + rTop},${cyTop}`, fill: "none", stroke: "#b8b3a6", "stroke-width": 1.2 }, layerFront);
}
pill("물그릇 · 진수", [CUP[0], 0, CUP[2] + 3.4]);
pill("걸리버가 접은 견본", [-1, 0.3, -5.4], { sub: "소인들은 이 배를 보고 같은 모양으로 만듭니다", className: "pill big" });

// 촛불의 불빛과 불꽃: 잔업(밤)에만 보인다.
const glowGrad = el("radialGradient", { id: "glow" }, defs);
el("stop", { offset: "0", "stop-color": "#ffcf7a", "stop-opacity": 0.95 }, glowGrad);
el("stop", { offset: "0.45", "stop-color": "#ff9f45", "stop-opacity": 0.35 }, glowGrad);
el("stop", { offset: "1", "stop-color": "#ff9f45", "stop-opacity": 0 }, glowGrad);
const candles = candlePoints.map((p) => {
  const [x, y] = proj(p);
  const glow = el("circle", { cx: x, cy: y + 20, r: 3.4 * S, fill: "url(#glow)", opacity: 0 }, layerGlow);
  const flame = el("ellipse", { cx: x, cy: y, rx: 3.2, ry: 7, fill: "#ffd27a", opacity: 0 }, layerFlame);
  return { glow, flame, y };
});

// ---------------------------------------------------------------------------
// 소인: 옆모습 그림을 관절마다 돌려 움직인다. 발 위치는 장면 좌표에서 투영한다.
// ---------------------------------------------------------------------------

// 실제 비율대로면 20px 남짓이라 발표 화면에서 안 보인다. 1.6배 키워 그린다.
const SPRITE_SCALE = ((0.69 * S * cP) / 26) * 1.6;

function toolSvg(kind: Tool, parent: Element): void {
  if (kind === "knife") {
    el("rect", { x: -0.2, y: -11, width: 1.2, height: 6, fill: "#c9ced6", stroke: "#8e949c", "stroke-width": 0.3 }, parent);
  } else if (kind === "hammer") {
    el("rect", { x: 0, y: -11, width: 0.9, height: 6.5, fill: "#7a5532" }, parent);
    el("rect", { x: -1.6, y: -5.4, width: 4.2, height: 2, rx: 0.4, fill: "#555b63" }, parent);
  } else {
    el("rect", { x: 0, y: -11, width: 0.9, height: 5.5, fill: "#7a5532" }, parent);
    el("path", { d: "M-0.4,-5.6 L1.3,-5.6 L0.45,-3 Z", fill: kind === "brush" ? "#c8553d" : "#fafafa" }, parent);
  }
}

class Worker {
  readonly root: SVGGElement;
  private readonly inner: SVGGElement;
  private readonly armF: SVGGElement;
  private readonly armB: SVGGElement;
  private readonly legF: SVGGElement;
  private readonly legB: SVGGElement;
  private readonly head: SVGGElement;
  private pos: V3;
  private target: V3;
  private workLeft = 0;
  private phase = Math.random() * 10;
  private flip = 1;
  private bob = 0;
  depth = 0;

  constructor(color: string, tool: Tool, private readonly benchX: number, private readonly side: number, skilled: boolean) {
    const tunic = hex(color);
    const skin = "#f0c8a0";
    this.root = el("g", {}, layerDyn);
    el("ellipse", { cx: 0, cy: 0, rx: 8, ry: 2.6, fill: "rgba(40,25,10,0.25)" }, this.root);
    this.inner = el("g", {}, this.root);
    this.armB = el("g", {}, this.inner);
    el("rect", { x: -1.6, y: -19, width: 2.8, height: 8, rx: 1.2, fill: rgb(tunic, 0.72) }, this.armB);
    el("circle", { cx: -0.2, cy: -11, r: 1.5, fill: "#d9b08a" }, this.armB);
    this.legB = el("g", {}, this.inner);
    el("rect", { x: -2.6, y: -9.5, width: 3.4, height: 9.5, rx: 1, fill: "#45352a" }, this.legB);
    el("rect", { x: -2.8, y: -1.7, width: 5, height: 1.9, rx: 0.7, fill: "#241c15" }, this.legB);
    this.legF = el("g", {}, this.inner);
    el("rect", { x: -0.8, y: -9.5, width: 3.4, height: 9.5, rx: 1, fill: "#5b4636" }, this.legF);
    el("rect", { x: -1, y: -1.7, width: 5, height: 1.9, rx: 0.7, fill: "#2e241c" }, this.legF);
    el("path", { d: "M-4.8,-8.6 L4.8,-8.6 L3.5,-19.8 L-3.5,-19.8 Z", fill: rgb(tunic) }, this.inner);
    el("rect", { x: -4.4, y: -11.6, width: 8.8, height: 1.5, fill: "#3b2a1c" }, this.inner);
    this.head = el("g", {}, this.inner);
    el("circle", { cx: 0.4, cy: -23.8, r: 3.9, fill: skin }, this.head);
    el("path", { d: "M-3.5,-23 C-3.8,-28 3.6,-29.2 4.4,-25 C2.2,-26 0,-25.6 -1.2,-22.4 Z", fill: "#5a3b22" }, this.head);
    el("circle", { cx: 2.6, cy: -24, r: 0.6, fill: "#1c1c1c" }, this.head);
    if (skilled) {
      el("ellipse", { cx: 0.4, cy: -27.2, rx: 5.2, ry: 1.2, fill: "#2b2b3a" }, this.head);
      el("rect", { x: -2.5, y: -32.6, width: 5.8, height: 5.6, rx: 0.8, fill: "#2b2b3a" }, this.head);
      el("rect", { x: -2.5, y: -28.7, width: 5.8, height: 1.3, fill: "#e0b13a" }, this.head);
    }
    this.armF = el("g", {}, this.inner);
    el("rect", { x: -0.9, y: -19, width: 2.8, height: 8, rx: 1.2, fill: rgb(tunic, 1.08) }, this.armF);
    el("circle", { cx: 0.5, cy: -11, r: 1.6, fill: skin }, this.armF);
    toolSvg(tool, this.armF);
    if (skilled) {
      const tag = el("g", { transform: "translate(0,-40)" }, this.root);
      el("rect", { x: -13, y: -6, width: 26, height: 11, rx: 3, fill: "#2b2b3a" }, tag);
      const t = el("text", { x: 0, y: 2.4, "text-anchor": "middle", "font-size": 7.5, "font-weight": 700, fill: "#f3d27a" }, tag);
      t.textContent = "숙련공";
    }
    this.pos = [benchX + 1.35 * (side > 0 ? -1 : 1), MAT_TOP, side * 1.0];
    this.target = [...this.pos];
  }

  update(dt: number, working: boolean, speed: number): void {
    this.phase += dt * speed;
    if (working) {
      if (this.workLeft > 0) this.workLeft -= dt * speed;
      else if (Math.hypot(this.target[0] - this.pos[0], this.target[2] - this.pos[2]) < 0.04) {
        this.target = [this.benchX + (Math.random() - 0.5) * 1.8, MAT_TOP, this.side * (0.62 + Math.random() * 0.15)];
        this.workLeft = 1.1 + Math.random() * 1.2;
      }
    } else {
      this.target = [this.benchX + 1.35 * (this.side > 0 ? -1 : 1), MAT_TOP, this.side * 1.0];
      this.workLeft = 0;
    }

    const dx = this.target[0] - this.pos[0], dz = this.target[2] - this.pos[2];
    const dist = Math.hypot(dx, dz);
    const walking = dist > 0.04 && this.workLeft <= 0;
    if (walking) {
      const step = Math.min(dist, 0.75 * speed * dt);
      this.pos[0] += (dx / dist) * step;
      this.pos[2] += (dz / dist) * step;
      const screenDx = proj(this.target)[0] - proj(this.pos)[0];
      if (Math.abs(screenDx) > 0.5) this.flip = screenDx > 0 ? 1 : -1;
    } else if (working) {
      // 일할 때는 배(작업대 가운데)를 본다.
      this.flip = proj([this.benchX, 0, 0])[0] >= proj(this.pos)[0] ? 1 : -1;
    }

    const p = this.phase;
    const rot = (g: SVGGElement, deg: number, px: number, py: number) => g.setAttribute("transform", `rotate(${deg.toFixed(1)} ${px} ${py})`);
    if (walking) {
      const swing = Math.sin(p * 9) * 30;
      rot(this.legF, swing, 1, -9); rot(this.legB, -swing, -1, -9);
      rot(this.armF, -swing * 0.8, 0.5, -18.5); rot(this.armB, swing * 0.8, -0.3, -18.5);
      this.head.setAttribute("transform", "");
      this.bob = Math.abs(Math.sin(p * 9)) * 0.9;
    } else if (working && this.workLeft > 0) {
      rot(this.legF, 0, 1, -9); rot(this.legB, 0, -1, -9);
      rot(this.armF, -78 + Math.sin(p * 11) * 38, 0.5, -18.5);
      rot(this.armB, -50 + Math.sin(p * 11 + 1.5) * 8, -0.3, -18.5);
      this.head.setAttribute("transform", `rotate(${(8 + Math.sin(p * 11) * 3).toFixed(1)} 0.4 -20)`);
      this.bob = Math.abs(Math.sin(p * 5.5)) * 0.5;
    } else {
      rot(this.legF, 0, 1, -9); rot(this.legB, 0, -1, -9);
      rot(this.armF, Math.sin(p * 1.5) * 3, 0.5, -18.5); rot(this.armB, -Math.sin(p * 1.5) * 3, -0.3, -18.5);
      this.head.setAttribute("transform", `rotate(${(Math.sin(p * 0.7) * 6).toFixed(1)} 0.4 -20)`);
      this.bob = Math.sin(p * 2) * 0.2;
    }

    const [sx, sy] = proj(this.pos);
    this.root.setAttribute("transform", `translate(${sx.toFixed(1)},${(sy - this.bob).toFixed(1)}) scale(${SPRITE_SCALE.toFixed(3)})`);
    this.inner.setAttribute("transform", `scale(${this.flip},1)`);
    this.depth = depth([this.pos[0], 0.3, this.pos[2]]);
  }
}

const crews: Worker[][] = STATIONS.map((st, i) =>
  Array.from({ length: st.workers }, (_, k) => new Worker(st.color, st.tool, BENCH_X[i], k % 2 === 0 ? 1 : -1, i === SKILLED_STATION && k === 0)));

// ---------------------------------------------------------------------------
// 종이배(움직이는 것)
// ---------------------------------------------------------------------------

class Boat {
  fold = 0;
  paint = 0;
  flag = 0;
  at: V3 = [BENCH_X[0], MAT_TOP, 0];
  yaw = 0;
  roll = 0;
  pitch = 0;
  floatPhase = Math.random() * Math.PI * 2;
  readonly floatSpot: V3 = [CUP[0] + (Math.random() - 0.5) * 2, WATER_Y, CUP[2] + (Math.random() - 0.5) * 1.6];
  readonly faces: SVGPolygonElement[] = Array.from({ length: 10 }, () =>
    el("polygon", { stroke: "#d6cfbf", "stroke-width": 0.6, "stroke-linejoin": "round" }, layerDyn));
  readonly flagGroup = el("g", {}, layerDyn);
  private readonly stick = el("line", { stroke: "#6b4a2b", "stroke-width": 1.6 }, this.flagGroup);
  private readonly cloth = el("polygon", { fill: "#c0392b" }, this.flagGroup);
  emissive = 0;
  depthItems: { node: Element; depth: number }[] = [];

  render(t: number): void {
    const faces = boatFaces(this.fold, this.paint, { at: this.at, scale: 1, yaw: this.yaw, roll: this.roll, pitch: this.pitch });
    this.depthItems = [];
    faces.forEach((f, i) => {
      const node = this.faces[i];
      node.setAttribute("points", pts(f.points));
      // 재작업 중에는 선체(앞의 8면)가 주황으로 깜박인다.
      node.setAttribute("fill", i < 8 && this.emissive > 0 ? rgb(mix(f.shaded, REWORK, this.emissive * 0.7)) : f.fill);
      this.depthItems.push({ node, depth: f.depth });
    });
    this.flagGroup.style.display = this.flag > 0.01 ? "" : "none";
    if (this.flag > 0.01) {
      const top: V3 = [this.at[0], this.at[1] + 1.2, this.at[2]];
      const [x0, y0] = proj(top);
      const h = 0.55 * S * cP * this.flag;
      const wave = Math.sin(t * 4) * 2;
      this.stick.setAttribute("x1", String(x0)); this.stick.setAttribute("y1", String(y0));
      this.stick.setAttribute("x2", String(x0)); this.stick.setAttribute("y2", String(y0 - h));
      const w = 15 * this.flag;
      this.cloth.setAttribute("points", `${x0},${y0 - h} ${x0 + w},${y0 - h + 4 * this.flag + wave} ${x0},${y0 - h + 8 * this.flag}`);
      this.depthItems.push({ node: this.flagGroup, depth: depth(top) + 0.5 });
    }
  }

  remove(): void {
    this.faces.forEach((f) => f.remove());
    this.flagGroup.remove();
  }
}

// 재단할 때의 큰 종이와 자투리
const cutGroup = el("g", {}, layerDyn);
const sheet = poly(cutGroup, [[BENCH_X[0] - 1.5, MAT_TOP + 0.004, -1.45], [BENCH_X[0] + 1.5, MAT_TOP + 0.004, -1.45], [BENCH_X[0] + 1.5, MAT_TOP + 0.004, 1.45], [BENCH_X[0] - 1.5, MAT_TOP + 0.004, 1.45]], "#f7f3ea", { stroke: "#e2dccd", "stroke-width": 0.8 });
const scraps = Array.from({ length: 9 }, (_, i) => {
  const a = (i / 9) * Math.PI * 2;
  return { node: el("polygon", { fill: "#f4f0e6", stroke: "#d6cfbf", "stroke-width": 0.5 }, cutGroup), a };
});

function setCut(p: number): void {
  sheet.setAttribute("opacity", String(1 - ease(clamp01(p * 1.2))));
  for (const [i, s] of scraps.entries()) {
    const q = clamp01(p * 1.4 - i * 0.04);
    s.node.style.display = q > 0 ? "" : "none";
    const r = 1.3 + q * 0.9;
    const c: V3 = [BENCH_X[0] + Math.cos(s.a) * r, MAT_TOP + 0.02 + Math.sin(Math.PI * q) * 0.35, Math.sin(s.a) * r * 0.95];
    const rot = q * 4 + i;
    const tri: V3[] = [0, 1, 2].map((k) => [c[0] + Math.cos(rot + k * 2.1) * 0.16, c[1], c[2] + Math.sin(rot + k * 2.1) * 0.16]);
    s.node.setAttribute("points", pts(tri));
  }
}

// 불량 경고
const badge = el("g", { style: "display:none" }, layerLabel);
el("rect", { x: -62, y: -15, width: 124, height: 28, rx: 8, fill: "#ec835a" }, badge);
const badgeText = el("text", { x: 0, y: 5, "text-anchor": "middle", "font-size": 14, "font-weight": 800, fill: "#2b1408" }, badge);
badgeText.textContent = "불량 → 재작업";

// ---------------------------------------------------------------------------
// 시간표 진행 (model.ts의 시간표를 3D 시안과 똑같이 쓴다)
// ---------------------------------------------------------------------------

const ui = { overtime: false, defect: false, fast: false };
const workSpeed = () => (ui.fast ? 1.5 : 1) * (ui.overtime ? 1.25 : 1);

let boat = new Boat();
const floating: Boat[] = [];
let schedule = buildSchedule(ui.defect);
let phaseIndex = 0;
let phaseTime = 0;
const caption = document.getElementById("caption")!;
const bench = (i: number): V3 => [BENCH_X[i], MAT_TOP, 0];
const lerp3 = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

function startNewBoat(): void {
  floating.push(boat);
  if (floating.length > 3) floating.shift()!.remove();
  boat = new Boat();
  schedule = buildSchedule(ui.defect);
  phaseIndex = 0;
  phaseTime = 0;
}

function applyPhase(phase: Phase, p: number): number | null {
  badge.style.display = "none";
  boat.emissive = 0;
  cutGroup.style.display = phase.kind === "process" && phase.station === 0 ? "" : "none";
  boat.roll = 0;
  switch (phase.kind) {
    case "process":
      boat.at = bench(phase.station);
      boat.yaw = 0;
      if (phase.station === 0) setCut(p);
      if (phase.station === 1) boat.fold = p;
      if (phase.station === 2) boat.paint = p;
      if (phase.station === 3) boat.fold = 1, boat.flag = ease(p);
      caption.textContent = STATIONS[phase.station].caption;
      return phase.station;
    case "rework": {
      boat.at = bench(phase.station);
      badge.style.display = "";
      const [bx, by] = proj([boat.at[0], boat.at[1] + 1.9, boat.at[2]]);
      badge.setAttribute("transform", `translate(${bx},${by})`);
      boat.emissive = (Math.sin(p * Math.PI * 6) + 1) / 2;
      boat.paint = 0.55 + 0.45 * p;
      caption.textContent = REWORK_CAPTION;
      return phase.station;
    }
    case "move": {
      const e = ease(p);
      boat.at = lerp3(bench(phase.from), bench(phase.from + 1), e);
      boat.at[1] += Math.sin(Math.PI * e) * 0.9;
      boat.roll = Math.sin(Math.PI * e) * -0.15;
      caption.textContent = `${STATIONS[phase.from + 1].name} 작업대로 옮기는 중`;
      return null;
    }
    case "launch": {
      const e = ease(p);
      boat.at = lerp3(bench(3), boat.floatSpot, e);
      boat.at[1] += Math.sin(Math.PI * e) * 2.6;
      boat.yaw = e * 0.8;
      caption.textContent = LAUNCH_CAPTION;
      return null;
    }
    case "rest":
      caption.textContent = "다음 배를 시작합니다";
      return null;
  }
}

// ---------------------------------------------------------------------------
// 루프
// ---------------------------------------------------------------------------

let night = 0;
let last = performance.now();
let elapsed = 0;

function frame(now: number): void {
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;
  elapsed += dt;
  const speed = workSpeed();

  const phase = schedule[phaseIndex];
  phaseTime += dt * (phase.kind === "process" || phase.kind === "rework" ? speed : 1);
  const active = applyPhase(phase, clamp01(phaseTime / phase.dur));
  if (phaseTime >= phase.dur) {
    phaseIndex++;
    phaseTime = 0;
    if (phaseIndex >= schedule.length) startNewBoat();
  }

  crews.forEach((crew, i) => crew.forEach((w) => w.update(dt, active === i, speed)));
  for (const b of floating) {
    b.floatPhase += dt;
    b.at = [b.floatSpot[0], WATER_Y + Math.sin(b.floatPhase * 1.6) * 0.04, b.floatSpot[2]];
    b.roll = Math.sin(b.floatPhase * 1.3) * 0.05;
    b.pitch = Math.sin(b.floatPhase * 1.1) * 0.05;
  }

  // 깊이 순서로 다시 붙인다. 재단 종이는 언제나 맨 아래.
  const items: { node: Element; depth: number }[] = [{ node: cutGroup, depth: -1e9 }];
  for (const b of [...floating, boat]) {
    b.render(elapsed);
    items.push(...b.depthItems);
  }
  for (const crew of crews) for (const w of crew) items.push({ node: w.root, depth: w.depth });
  items.sort((a, b) => a.depth - b.depth);
  for (const it of items) layerDyn.append(it.node);

  // 잔업(밤)
  night += ((ui.overtime ? 1 : 0) - night) * Math.min(1, dt * 2.5);
  nightRect.setAttribute("opacity", (night * 0.62).toFixed(3));
  document.body.style.background = rgb(mix(DAY_BG, NIGHT_BG, night));
  candles.forEach((c, i) => {
    const flicker = 1 + Math.sin(elapsed * 13 + i * 2) * 0.12 + Math.sin(elapsed * 29 + i) * 0.06;
    c.glow.setAttribute("opacity", (night * 0.85 * flicker).toFixed(3));
    c.flame.setAttribute("opacity", (night > 0.05 ? 1 : 0).toString());
    c.flame.setAttribute("ry", (7 * flicker).toFixed(2));
    c.flame.setAttribute("cy", (c.y - 7 * (flicker - 1)).toFixed(2));
  });

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

document.querySelectorAll<HTMLButtonElement>("[data-toggle]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const k = btn.dataset.toggle as keyof typeof ui;
    ui[k] = !ui[k];
    btn.classList.toggle("on", ui[k]);
    if (k === "defect" && phaseIndex <= PAINT_PHASE_INDEX) {
      schedule = [...schedule.slice(0, phaseIndex), ...buildSchedule(ui.defect).slice(phaseIndex)];
    }
  });
});
