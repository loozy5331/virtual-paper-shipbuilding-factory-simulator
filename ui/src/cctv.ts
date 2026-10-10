// 관제실 작업 현황(2.1): 높은 곳에서 조선소를 내려다본 2D 정지 화면. 기호도를 대신한다.
// 3.2(D38): 전경은 없다. 구획(내업, 1도크, 2도크, 안벽) 하나를 화면 가득 그린다. 공정이 늘어도 구획 안만 커진다.
// 화면에는 "CCTV"라는 말을 쓰지 않는다(감시처럼 느껴져서, 사용자 결정). 파일 이름만 옛 이름이다.
// 바로 위에서 30도쯤 기운 시점이다(바닥은 위에서, 사람·블록·선반은 앞면이 조금 보인다).
// 배치는 현장 3D(scene/yard.ts)와 같은 좌표를 쓴다. 작업모를 쓰고 나가면 같은 자리가 3D로 보인다.
// 구획을 바꾸면 같은 그림의 viewBox만 그 구획으로 옮긴다(그림을 따로 그리지 않는다).
//
// 사람은 단색 기호(둥근 몸 + 고깔모자, 역할 색)로만 그린다. 얼굴·체격·이름을 그릴 자리가 없어 익명이 구조로 보장된다.
// 애니메이션은 넣지 않는다: 날짜가 바뀔 때만 다시 그린다. 3D와 같은 scene/frame.ts의 Frame을 그리기만 한다.

import type { Scenario } from "./api";
import { s } from "./dom";
import { HAT, STATE_INFO, STATION_COLOR } from "./labels";
import type { Frame, LotView } from "./scene/frame";
import type { TrackPick } from "./track";
import { STOCK_STATIONS, stockAssign, stockSpot } from "./scene/stock";
// 배치는 현장 3D와 같은 scene/layout.ts
import { areaBounds, BAY_C, BAY_MOUTH, benchAt, CRANE_R, DEPOT, dockZ, LAB, LANE_Z, LOUNGE, MAT_D, MAT_W, MAT2_D, MOUTH_X, QUEUE_Z,
  along, LAB_TREES, QUAY, route, seaSpot, sectorBounds, SUPPLY_DAYS, SUPPLY_EXIT, SUPPLY_ROUTE, sectorOf, SECTORS, SHELF_X, SHELF_Z, SHORE_X, SPUR_X, STATION_X, STOCK_AT, STOCK_D, STOCK_HALF, UNIT_Z,
  type SectorId } from "./scene/layout";

// ----- 투영: 위에서 30도 기운 정사영 -----
const S = 30;                        // 1 단위 = 30px
const DEPTH = Math.cos(Math.PI / 6); // 바닥 깊이는 0.87배로 줄고
const RISE = Math.sin(Math.PI / 6);  // 높이는 0.5배로 보인다
const X0 = -34.5, Z0 = -12.2, TOP = 34;

const px = (x: number) => (x - X0) * S;
const py = (z: number, h = 0) => TOP + (z - Z0) * S * DEPTH - h * S * RISE;

const INK = "#c9d3cc";
const PAPER = "#ece6d8";
const PAPER_SIDE = "#b9b2a4";
const EDGE = "#4d5852";

/** 그릴 것 하나와 깊이(z). 뒤(작은 z)부터 그린다. */
interface Item { z: number; el: SVGElement }

/** 상자: 윗면(x·z 직사각형) + 앞면(높이). 위에서 기운 정사영이라 옆면은 보이지 않는다. */
function box(x: number, z: number, w: number, d: number, h: number, top: string, front: string): SVGElement {
  const x0 = px(x - w / 2), x1 = px(x + w / 2);
  const zb = z - d / 2, zf = z + d / 2;
  return s("g", null,
    s("rect", { x: x0, y: py(zb, h), width: x1 - x0, height: py(zf, h) - py(zb, h), fill: top, stroke: EDGE, "stroke-width": 0.6 }),
    s("rect", { x: x0, y: py(zf, h), width: x1 - x0, height: py(zf, 0) - py(zf, h), fill: front, stroke: EDGE, "stroke-width": 0.6 }));
}

/** 사람 기호: 그림자, 몸, 머리, 고깔모자. 얼굴은 없다. sit이면 낮게. */
function person(x: number, z: number, hat: string, sit = false): SVGElement {
  const cx = px(x), base = py(z, sit ? 0.25 : 0);
  const body = sit ? 9 : 14;
  return s("g", { class: "cc-person" },
    s("ellipse", { cx, cy: py(z), rx: 7, ry: 3, fill: "rgba(0,0,0,0.35)" }),
    s("rect", { x: cx - 5, y: base - body, width: 10, height: body, rx: 4, fill: INK }),
    s("circle", { cx, cy: base - body - 4, r: 4.5, fill: INK }),
    s("path", { d: `M${cx - 6} ${base - body - 6} L${cx + 1.5} ${base - body - 19} L${cx + 6} ${base - body - 6} Z`, fill: hat, stroke: "#2b2b2b", "stroke-width": 0.8 }));
}

function robot(x: number, z: number): SVGElement {
  const cx = px(x), b = py(z);
  return s("g", { class: "cc-robot" },
    s("rect", { x: cx - 6, y: b - 5, width: 12, height: 5, rx: 1, fill: "#9aa3a8" }),
    s("path", { d: `M${cx} ${b - 5} L${cx - 3} ${b - 18} L${cx + 8} ${b - 23}`, stroke: "#9aa3a8", "stroke-width": 3, fill: "none", "stroke-linecap": "round" }));
}

/** 다 지은 배를 위에서 비스듬히 본 모양: 선체(앞이 뾰족) + 선종별 갑판 구조물, 선실은 고물(왼쪽). */
function ship(x: number, z: number, kind: string, scale = 1): SVGElement {
  const k = scale * S;
  const cx = px(x), cy = py(z);
  const len = kind === "VLCC" ? 1.45 : kind === "LNG" ? 1.35 : 1.3;   // 반 길이(단위)
  const half = 0.42;                                                     // 반 폭
  const deckY = cy - 0.3 * k;                                            // 갑판 높이만큼 위로
  const g = s("g", { class: "cc-ship" });
  // 선체 옆면(앞쪽에 보이는 띠)과 갑판
  g.append(
    s("path", { d: `M${cx - len * k} ${deckY} L${cx + len * k} ${deckY} L${cx + (len - 0.3) * k} ${cy} L${cx - (len - 0.25) * k} ${cy} Z`, fill: PAPER_SIDE, stroke: EDGE, "stroke-width": 0.6 }),
    s("path", { d: `M${cx - len * k} ${deckY} L${cx - (len - 0.2) * k} ${deckY - half * k * DEPTH} L${cx + (len - 0.45) * k} ${deckY - half * k * DEPTH} L${cx + len * k} ${deckY - half * k * DEPTH * 0.5} L${cx + len * k} ${deckY} Z`, fill: PAPER, stroke: EDGE, "stroke-width": 0.6 }));
  const deckMid = deckY - half * k * DEPTH * 0.5;
  const blk = (bx: number, w: number, d: number, h: number, fill: string) => {
    const x0 = cx + (bx - w / 2) * k, top = deckMid - (d / 2) * k * DEPTH - h * k * RISE;
    g.append(
      s("rect", { x: x0, y: top, width: w * k, height: d * k * DEPTH, fill, stroke: EDGE, "stroke-width": 0.5 }),
      s("rect", { x: x0, y: top + d * k * DEPTH, width: w * k, height: h * k * RISE, fill: PAPER_SIDE, stroke: EDGE, "stroke-width": 0.5 }));
  };
  if (kind === "CONT") {
    const kraft = ["#efe7d4", "#d9cba8", "#e6dcc6"];
    for (let bay = 0; bay < 4; bay++) blk(-0.35 + bay * 0.38, 0.32, 0.7, 0.3, kraft[bay % kraft.length]);
  } else if (kind === "LNG") {
    for (let t = 0; t < 4; t++) {
      const tx = cx + (-0.35 + t * 0.4) * k;
      g.append(s("ellipse", { cx: tx, cy: deckMid - 0.12 * k, rx: 0.19 * k, ry: 0.19 * k * 0.9, fill: PAPER, stroke: EDGE, "stroke-width": 0.6 }),
        s("path", { d: `M${tx - 0.1 * k} ${deckMid - 0.2 * k} q${0.06 * k} ${-0.06 * k} ${0.14 * k} ${-0.02 * k}`, stroke: "#ffffff", "stroke-width": 1.2, fill: "none" }));
    }
  } else {
    g.append(s("line", { x1: cx - 0.5 * k, x2: cx + 0.9 * k, y1: deckMid, y2: deckMid, stroke: PAPER_SIDE, "stroke-width": Math.max(1.5, 0.06 * k) }));
    blk(0.2, 0.1, 0.55, 0.05, PAPER_SIDE);
  }
  // 선미 선실(창문 선)
  blk(-len + 0.42, 0.34, 0.62, 0.55, PAPER);
  const wy = deckMid - 0.31 * k * DEPTH - 0.55 * k * RISE + 0.62 * k * DEPTH;
  g.append(s("line", { x1: cx + (-len + 0.27) * k, x2: cx + (-len + 0.57) * k, y1: wy + 0.12 * k * RISE, y2: wy + 0.12 * k * RISE, stroke: "#3a3f3c", "stroke-width": 1 }));
  return g;
}

/** 로트: 조립 단계(부재 → 소블록 12 → 중블록 6 → 대블록 3 → 배). 정지 화면이라 정수 단계로만. */
function lot(x: number, z: number, form: number, scale = 1, kind = "VLCC"): SVGElement {
  const stage = Math.min(4, Math.floor(form + 1e-6));
  const g = s("g", { class: "cc-lot" });
  // 보이지 않는 누름 영역: 블록 조각 사이를 눌러도 정반(확대)이 아니라 블록(추적 상자)이 잡히게(3.1)
  const hw = (stage === 4 ? 1.5 : 0.85) * scale, hd = 0.6 * scale;
  g.append(s("rect", { x: px(x - hw), y: py(z - hd, 0.7 * scale), width: hw * 2 * S, height: py(z + hd) - py(z - hd, 0.7 * scale), fill: "transparent" }));
  const b = (bx: number, bz: number, w: number, d: number, h: number) =>
    g.append(box(x + bx * scale, z + bz * scale, w * scale, d * scale, h * scale, PAPER, PAPER_SIDE));
  if (stage === 0) {
    b(0, 0, 1.4, 1.0, 0.08);
  } else if (stage === 1) {
    for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) b(-0.6 + c * 0.4, -0.4 + r * 0.4, 0.32, 0.32, 0.25);
  } else if (stage === 2) {
    for (let r = 0; r < 2; r++) for (let c = 0; c < 3; c++) b(-0.5 + c * 0.5, -0.25 + r * 0.5, 0.44, 0.44, 0.35);
  } else if (stage === 3) {
    for (let c = 0; c < 3; c++) b(-0.6 + c * 0.6, 0, 0.55, 0.7, 0.5);
  } else {
    g.append(ship(x, z, kind, scale));
  }
  return g;
}

/** 배 이름표(로트 위). 오늘 기준 지연이면 빨간 테두리, 손실 상태면 왼쪽에 그 색 띠. */
function chip(x: number, z: number, h: number, l: LotView, late: boolean): SVGElement {
  const cx = px(x), cy = py(z, h);
  const info = l.state === "work" ? null : STATE_INFO[l.state];
  const g = s("g", { class: "cc-chip" },
    s("title", null, `${l.ship}${info ? ` · ${info.name}` : ""}`),
    s("rect", { x: cx - 15, y: cy - 16, width: 30, height: 15, rx: 3, class: late ? "late" : "" }),
    s("text", { x: cx + (info ? 2 : 0), y: cy - 4.5 }, l.ship));
  if (info) g.append(s("rect", { x: cx - 15, y: cy - 16, width: 5, height: 15, rx: 2, fill: info.color }));
  return g;
}

function tag(x: number, y: number, text: string, cls = "cc-tag"): SVGElement {
  return s("text", { x, y, class: cls }, text);
}

/** 벽만 있는 작업장·구역(지붕 없음, 앞은 열림): 뒷벽은 앞면이 보이고, 옆벽은 위에서 본 띠. door = 뒷벽의 문(물류창고 뒷문) */
function walls(x0: number, x1: number, z0: number, z1: number, h: number, door?: { x: number; w: number }): SVGElement {
  const t = 0.14, top = "#a3ada6", front = "#7d8a83";
  const back = door
    ? [box((x0 + door.x - door.w / 2) / 2, z0, door.x - door.w / 2 - x0, t, h, top, front), box((door.x + door.w / 2 + x1) / 2, z0, x1 - door.x - door.w / 2, t, h, top, front)]
    : [box((x0 + x1) / 2, z0, x1 - x0, t, h, top, front)];
  return s("g", { class: "cc-walls" },
    ...back,
    box(x0, (z0 + z1) / 2, t, z1 - z0, h, top, front),
    box(x1, (z0 + z1) / 2, t, z1 - z0, h, top, front));
}

/** 드라이 도크: 콘크리트 테두리(뒤·앞·왼쪽)와 바다 쪽 문(오른쪽, 어두운 강철). */
function dock(x0: number, x1: number, z0: number, z1: number): SVGElement {
  const rim = "#8f8a80";
  return s("g", { class: "cc-dock" },
    s("rect", { x: px(x0), y: py(z0, 0.3), width: (x1 - x0) * S, height: (z1 - z0) * S * DEPTH, fill: "none", stroke: rim, "stroke-width": 4 }),
    s("line", { x1: px(x1), x2: px(x1), y1: py(z0, 0.3), y2: py(z1, 0.3), stroke: "#4e5a63", "stroke-width": 6 }));
}

export interface CctvOptions {
  /** 볼 구획(전경은 없다, D38) */
  focus: SectorId;
  /** 구획 가장자리에 보이는 이웃 구획의 작업장을 누르면 그 구획으로 */
  onSector: (id: SectorId) => void;
  /** 추적 중인 배(3.1). 그 배의 블록만 진하게, 나머지 블록은 흐리게, 선반에는 그 배 몫 수량 */
  track: string | null;
  /** 블록이나 선반을 눌렀다(자재·블록 추적 상자) */
  onPick: (pick: TrackPick) => void;
}

export function renderCctv(frame: Frame, scenario: Scenario, opts: CctvOptions): SVGElement {
  const docks = frame.stations[3]?.units.length ?? 1;
  const due = Object.fromEntries(scenario.orders.map((o) => [o.id, o.due_day]));
  // 지연 표시는 오늘 기준(최종 결과를 미리 알려 주지 않게).
  const lateNow = (l: LotView) => (l.place === "sea" ? l.late : frame.day > due[l.ship]);
  const items: Item[] = [];
  const add = (z: number, el: SVGElement) => items.push({ z, el });
  // 누를 수 있는 것(자재·블록 추적, 3.1): 정반을 누르면 확대지만, 블록이나 선반을 누르면 정보 상자다.
  const pickable = (el: SVGElement, pick: TrackPick, label: string): SVGElement => {
    el.classList.add("cc-pick");
    el.setAttribute("role", "button");
    el.setAttribute("tabindex", "0");
    el.setAttribute("aria-label", label);
    el.addEventListener("click", (e) => { e.stopPropagation(); opts.onPick(pick); });
    el.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") { e.stopPropagation(); opts.onPick(pick); } });
    return el;
  };
  // 블록 하나(그림 + 이름표 등)를 묶어 누를 수 있게 하고, 추적 중이면 그 배만 진하게
  const block = (l: LotView, ...els: SVGElement[]): SVGElement => {
    const g = s("g", { class: opts.track === null ? "" : opts.track === l.ship ? "tracked" : "untracked" }, ...els);
    return pickable(g, { kind: "ship", ship: l.ship }, `${l.ship} 블록. 눌러서 위치 보기`);
  };

  // ----- 바닥: 만(바다), 곶과 등대, 운반로, 작업대기소 -----
  add(-100, s("rect", { x: px(SHORE_X), y: -2000, width: 4000, height: 6000, fill: "#2f4a5a" }));
  add(-100, s("line", { x1: px(SHORE_X), x2: px(SHORE_X), y1: -2000, y2: 4000, stroke: "#8fa7b4", "stroke-width": 1.5 }));
  // 매립한 안벽(3.2): 앞쪽 곶과 야드 사이를 메운 땅, 만 쪽 가장자리에 계선주
  add(-100, s("rect", { x: px(QUAY.x0) - 1, y: py(QUAY.z0), width: (QUAY.x1 - QUAY.x0) * S + 1, height: 4000, class: "cc-bg" }));
  add(-100, s("line", { x1: px(QUAY.x0), x2: px(QUAY.x1), y1: py(QUAY.z0), y2: py(QUAY.z0), stroke: "#8fa7b4", "stroke-width": 1.5 }));
  add(-100, s("line", { x1: px(QUAY.x1), x2: px(QUAY.x1), y1: py(QUAY.z0), y2: 4000, stroke: "#8fa7b4", "stroke-width": 1.5 }));
  for (let x = QUAY.x0 + 0.8; x < QUAY.x1 - 0.3; x += 1.3) add(-99, s("circle", { cx: px(x), cy: py(QUAY.z0 + 0.35), r: 2.2, fill: "#8f8a80" }));
  // 자재 납품 길: 등대 곶에서 굽어 들어와 물류창고 뒤까지, 그리고 왼쪽으로 빠지는 길(위에서 본 굵은 선)
  for (const pts of [SUPPLY_ROUTE, SUPPLY_EXIT]) {
    const d = route(pts, 0.8).pts.map((p, i) => `${i ? "L" : "M"}${px(p.x).toFixed(1)} ${py(p.z).toFixed(1)}`).join(" ");
    add(-99, s("path", { d, fill: "none", stroke: "#4a4536", "stroke-width": 0.9 * S * DEPTH, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  }
  for (const side of [-1, 1]) {
    add(-99, s("ellipse", { cx: px(MOUTH_X + 1.5), cy: py(BAY_C + side * (BAY_MOUTH + 3.4)), rx: 3.4 * S, ry: 3.2 * S * DEPTH, fill: "#33402f", stroke: "#4f6147" }));
  }
  const lx = px(MOUTH_X), ly = py(BAY_C - (BAY_MOUTH + 2.6));
  add(-98, s("g", { class: "cc-lighthouse" },
    s("rect", { x: lx - 5, y: ly - 34, width: 10, height: 34, fill: "#f3f1ea" }),
    s("rect", { x: lx - 5, y: ly - 26, width: 10, height: 6, fill: "#b8322d" }),
    s("path", { d: `M${lx - 7} ${ly - 34} L${lx} ${ly - 44} L${lx + 7} ${ly - 34} Z`, fill: "#b8322d" })));
  add(-98, tag(lx, ly + 14, "등대", "cc-tag mid"));
  add(-99, box((DEPOT.x - 1.5 + SHORE_X - 0.3) / 2, LANE_Z, SHORE_X - 0.3 - (DEPOT.x - 1.5), 1.0, 0.02, "#3a423d", "#3a423d"));
  add(-99, box(LOUNGE.x, LOUNGE.z, 3.2, 2.6, 0.02, "#2c3530", "#2c3530"));
  SPUR_X.forEach((sx, k) => {
    const back = UNIT_Z[2] - MAT2_D / 2 - 0.4, front = LANE_Z - 0.5;
    add(-99, box(sx, (front + back) / 2, 0.8, front - back, 0.02, "#3a423d", "#3a423d"));
    // PE장 양옆 샛길은 큰길 앞(2도크 구획)으로도
    const far = benchAt(2, 2, 2).z + MAT2_D / 2 + 0.4;
    if (k >= 3) add(-99, box(sx, (LANE_Z + 0.5 + far) / 2, 0.8, far - LANE_Z - 0.5, 0.02, "#3a423d", "#3a423d"));
  });
  // 구획 윤곽(점선)과 이름: 이웃 구획이 가장자리에 걸쳐 보일 때 어디까지인지. 2도크 구획은 도크가 하나면 증설 예정지
  for (const sec of SECTORS.map((sc) => sectorBounds(sc.id, docks))) {
    if (sec.id === "quay") continue;
    const empty = sec.id === "dock2" && docks < 2;
    add(-98, s("rect", { x: px(sec.x0), y: py(sec.z0), width: (sec.x1 - sec.x0) * S, height: (sec.z1 - sec.z0) * S * DEPTH,
      fill: "none", stroke: "#8f9a93", "stroke-width": 1.2, "stroke-dasharray": "3 6", opacity: empty ? 0.5 : 0.8 }));
    if (empty) add(-98, tag(px((sec.x0 + sec.x1) / 2), py((sec.z0 + sec.z1) / 2), "2도크 구획 · 증설 예정지", "cc-place"));
  }

  // ----- 자재창고 선반 -----
  frame.shelves.forEach((sh, i) => {
    const x = SHELF_X[i];
    if (x === undefined) return;
    const g = s("g", { class: "cc-shelf" }, box(x, SHELF_Z, 2.1, 0.5, 1.6, "#4d4238", "#5c4f42"));
    pickable(g, { kind: "material", material: sh.material }, `${sh.name} 선반. 눌러서 어느 배 몫인지 보기`);
    const shown = Math.min(sh.qty, 8);
    for (let k = 0; k < shown; k++) {
      const bx = px(x - 0.85 + (k % 4) * 0.45), by = py(SHELF_Z + 0.25, 1.35 - Math.floor(k / 4) * 0.6);
      g.append(s("rect", { x: bx, y: by, width: 11, height: 8, fill: PAPER }));
    }
    const empty = sh.qty <= 0;
    g.append(tag(px(x), py(SHELF_Z + 0.25) + 14, `${sh.name} ${empty ? (sh.nextArrival ? `입고 D-${sh.nextArrival - frame.day}` : "없음") : sh.qty}`,
      empty ? "cc-tag mid warn" : "cc-tag mid"));
    // 추적 중이면 그 배 몫 수량을 한 줄 더(자재 페깅)
    if (opts.track !== null) {
      const mine = sh.pegs.find((pg) => pg.ship === opts.track)?.quantity ?? 0;
      g.append(tag(px(x), py(SHELF_Z + 0.25) + 28, `${opts.track} 몫 ${mine}`, mine ? "cc-tag mid track" : "cc-tag mid"));
    }
    add(SHELF_Z, g);
  });
  // 납품 마차(3.2): 정지 화면이라 그날 끝 자리. 입고일 마차는 창고 뒤(뒷문)에, 사흘 안의 입고는 납품 길 위에.
  // 상자 색은 선반 상자 뚜껑과 같다. 창고 뒤 마차만 무엇이 몇 개인지 적고, 길 위 마차는 "입고 D-n"만.
  const roadIn = route(SUPPLY_ROUTE), roadOut = route(SUPPLY_EXIT);
  for (const dv of frame.deliveries) {
    const today = dv.day === frame.day;
    const at = today ? along(roadOut, 0) : along(roadIn, (frame.day + 1 - (dv.day - SUPPLY_DAYS)) / SUPPLY_DAYS);
    const cx = px(at.x), cy = py(at.z);
    const flip = Math.cos(at.angle) < 0 ? -1 : 1;   // 왼쪽으로 가면 좌우를 뒤집는다
    const g = s("g", { class: "cc-supply", transform: `translate(${cx} ${cy}) scale(${flip} 1)` },
      s("ellipse", { cx: -4, cy: 2, rx: 30, ry: 4, fill: "rgba(0,0,0,0.35)" }),
      s("rect", { x: -30, y: -10, width: 30, height: 10, rx: 1, fill: "#a07e58", stroke: "#4a3a2c", "stroke-width": 0.8 }),
      s("circle", { cx: -15, cy: 1, r: 4, fill: "#4a3a2c" }),
      // 말: 몸과 머리, 다리
      s("rect", { x: 6, y: -14, width: 18, height: 8, rx: 3, fill: "#8a5a3b" }),
      s("rect", { x: 21, y: -20, width: 8, height: 6, rx: 2, fill: "#8a5a3b" }),
      s("line", { x1: 9, x2: 9, y1: -6, y2: 1, stroke: "#8a5a3b", "stroke-width": 2 }),
      s("line", { x1: 21, x2: 21, y1: -6, y2: 1, stroke: "#8a5a3b", "stroke-width": 2 }),
      s("line", { x1: 0, x2: 6, y1: -8, y2: -10, stroke: "#6b4a2b", "stroke-width": 1.5 }));
    if (!today) dv.items.forEach((a, k) => {
      const i = frame.shelves.findIndex((sh) => sh.material === a.material);
      g.append(s("rect", { x: -28 + k * 9, y: -18, width: 8, height: 8, fill: ["#f7f3ea", "#c8553d", "#c0392b"][i] ?? PAPER, stroke: "#4a3a2c", "stroke-width": 0.6 }));
    });
    add(at.z + 0.5, g);
    // 이름표는 마차 위(아래쪽은 물류창고 이름과 겹친다)
    add(at.z + 0.5, tag(cx, cy - 26, today ? `입고 · ${dv.items.map((a) => `${a.name} ${a.quantity}`).join(" · ")}` : `입고 D-${dv.day - frame.day}`, "cc-tag mid"));
  }

  // 물류창고 구역: 선반 셋을 벽으로 묶는다(앞은 열림)
  add(SHELF_Z - 2, walls(SHELF_X[0] - 1.5, SHELF_X[2] + 1.5, SHELF_Z - 0.9, SHELF_Z + 1.0, 1.9, { x: SHELF_X[1], w: 1.3 }));
  add(SHELF_Z - 1, tag(px(SHELF_X[1]), py(SHELF_Z - 0.9, 1.9) - 8, "물류창고 구역", "cc-place"));

  // ----- 연구소: 둘레의 나무(보안, 큰길 쪽 출입구만) -----
  for (const t of LAB_TREES) {
    add(t.z, s("g", { class: "cc-tree" },
      s("ellipse", { cx: px(t.x), cy: py(t.z), rx: 9, ry: 3.5, fill: "rgba(0,0,0,0.35)" }),
      s("path", { d: `M${px(t.x) - 9} ${py(t.z)} L${px(t.x)} ${py(t.z, 1.7)} L${px(t.x) + 9} ${py(t.z)} Z`, fill: "#3f6b47", stroke: "#2c4a32", "stroke-width": 0.8 })));
  }
  const r = frame.research;
  add(LAB.z, box(LAB.x, LAB.z, 2.2, 2.0, 1.6, "#55636b", "#6c7a82"));
  // 이름과 상태는 건물 바로 앞, 앞줄 나무보다 위에(뒤쪽 나무 줄은 큰길·차고와 가깝다)
  add(LAB.z + 3, s("g", null,
    tag(px(LAB.x), py(LAB.z + 1) + 13, "연구소", "cc-place"),
    tag(px(LAB.x), py(LAB.z + 1) + 27, r.current ? `${r.current.name} ${r.current.done}/${r.current.total}일` : r.finished.length ? `완료 ${r.finished.length}개` : "쉬는 중", "cc-tag mid")));

  // ----- 작업대기소: 벤치 둘과 쉬는 사람 -----
  for (const row of [0, 1]) add(LOUNGE.z - 0.6 + row * 1.2 - 0.01, box(LOUNGE.x, LOUNGE.z - 0.6 + row * 1.2, 2.6, 0.3, 0.3, "#6b5a48", "#5a4a3a"));
  for (let i = 0; i < Math.min(frame.idleWorkers, 8); i++) {
    const row = Math.floor(i / 4), col = i % 4;
    const z = LOUNGE.z - 0.6 + row * 1.2;
    add(z + 0.01, person(LOUNGE.x - 1.2 + col * 0.8, z, HAT.worker, true));
  }
  add(LOUNGE.z + 2, tag(px(LOUNGE.x), py(LOUNGE.z + 1.3) + 16, "작업대기소", "cc-place"));
  add(LOUNGE.z + 2, tag(px(LOUNGE.x), py(LOUNGE.z + 1.3) + 31, `쉬는 인원 ${frame.idleWorkers}명`, "cc-tag mid"));

  // ----- 공정 -----
  scenario.stations.forEach((st, p) => {
    const view = frame.stations[p];
    const color = STATION_COLOR[st.id];
    const b0 = benchAt(p, 0, docks);
    const x = b0.x;
    view.units.forEach((unit, k) => {
      const { z, d } = benchAt(p, k, docks);
      // 작업장마다: 소조립·중조립은 벽(뒤·옆), PE장은 노란 구획선, 탑재는 드라이 도크(바다 쪽 문)
      const { x0, x1, z0, z1 } = areaBounds(p, k, docks);
      if (p < 2) add(z0 - 0.01, walls(x0, x1, z0, z1, 1.0));
      else if (p === 2) add(z0 - 0.01, s("rect", { x: px(x0), y: py(z0), width: (x1 - x0) * S, height: (z1 - z0) * S * DEPTH, fill: "none", stroke: "#e0b43a", "stroke-width": 1.5, "stroke-dasharray": "6 4" }));
      else add(z0 - 0.01, dock(x0, x1, z0, z1));
      const g = s("g", {
        class: "cc-station pick", role: "button", tabindex: 0,
        "aria-label": `${st.name} ${unit.unit}호. 눌러서 그 구획 보기`,
        onclick: () => opts.onSector(sectorOf(p, k, docks)),
        onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") opts.onSector(sectorOf(p, k, docks)); },
      }, box(x, z, MAT_W, d, 0.08, color, color));
      if (unit.stop) {
        // 중지: 통제선(빗금 테두리). 정지 화면이라 연기·깜빡임 없이.
        const info = STATE_INFO[unit.state];
        g.append(s("rect", {
          x: px(x - MAT_W / 2) - 4, y: py(z - d / 2, 0.08) - 4, width: MAT_W * S + 8, height: d * S * DEPTH + 8,
          fill: "none", stroke: info?.color ?? "#8e2e42", "stroke-width": 3, "stroke-dasharray": "8 5",
        }));
      }
      if (view.units.length > 1) g.append(tag(px(x - MAT_W / 2) - 4, py(z) + 4, `${unit.unit}호`, "cc-unit end"));
      add(z - d / 2, g);
      // 나눠 하는 배는 부분이 든 작업장마다 작게 그린다. 먼저 끝난 부분은 공용 적치장에서 짝을 기다린다(아래).
      const here = frame.lots.find((l) => l.place === "bench" && l.station === p && l.ship === unit.ship);
      if (here) {
        // 배 이름표는 정반 뒤 가장자리 바로 위(정반 안의 글과 겹치지 않게)
        add(z + 0.02, block(here, lot(x, z, here.form, here.parts && here.parts.length > 1 ? 0.75 : 1, here.type), chip(x, z - d / 2, 0, here, lateNow(here))));
      }
      if (view.crew === "robot") {
        if (here) { add(z + 0.1, robot(x - MAT_W / 2 + 0.35, z + 0.3)); add(z + 0.1, robot(x + MAT_W / 2 - 0.35, z + 0.3)); }
      } else {
        const hat = view.senior ? HAT.senior : HAT.worker;
        for (let i = 0; i < unit.workers; i++) {
          const wx = x + (i === 0 ? -1 : 1) * (MAT_W / 2 - 0.4);
          add(z + 0.4, person(wx, z + 0.4, hat));
        }
      }
      if (unit.stop) {
        add(z + d, tag(px(x), py(z - d / 2, 0.08) - 8, unit.stop === "accident" ? "사고 · 작업 중지" : "고장 · 수리 중", "cc-tag mid stop"));
      }
    });
    // 공정 이름과 오늘 상태: 1호 정반 안쪽 아래(왼쪽 이름, 오른쪽 상태), 운영 표시는 안쪽 위 오른쪽
    const first = view.units.find((u) => u.state !== "idle") ?? view.units[0];
    const info = first.state === "work" || first.state === "idle" ? null : STATE_INFO[first.state];
    const status = first.state === "work" ? "작업 중" : first.state === "idle" ? "비어 있음" : info?.name ?? first.state;
    const extra = [view.overtime && view.crew !== "robot" ? "잔업" : "", { normal: "", skilled: "숙련공", robot: "로봇" }[view.crew]].filter(Boolean).join(" · ");
    const ty = py(b0.z + MAT_D / 2) - 6;
    add(b0.z + MAT_D / 2 + 0.05, s("g", { class: "cc-mat-text" },
      tag(px(x - MAT_W / 2) + 5, ty, st.name, "cc-name"),
      tag(px(x + MAT_W / 2) - 5, ty, status, info ? "cc-tag end loss" : "cc-tag end"),
      extra ? tag(px(x + MAT_W / 2) - 5, py(b0.z - MAT_D / 2) + 14, extra, "cc-tag end") : s("g")));
    // 탑재 앞 대기 줄(탑재는 적치장 예외: 도크 앞에서 기다린다)
    if (p >= STOCK_STATIONS) {
      frame.lots.filter((l) => l.place === "queue" && l.station === p).sort((a, b) => a.slot - b.slot).slice(0, 3).forEach((l, i) => {
        const qx = x - 1 + i * 1.0;
        add(QUEUE_Z + 0.01, block(l, lot(qx, QUEUE_Z, l.form, 0.55), chip(qx, QUEUE_Z - 0.2, 0.4, l, lateNow(l))));
      });
    }
  });

  // ----- 적치장: 공정마다 칸(내업 두 공정은 큰길 건너편, PE장은 1도크 구획) -----
  for (let p = 0; p < STOCK_STATIONS; p++) {
    const at = STOCK_AT[p];
    const far = at.z0 + at.dir * STOCK_D, zTop = Math.min(at.z0, far);
    add(-97, s("rect", { x: px(at.x - STOCK_HALF), y: py(zTop), width: STOCK_HALF * 2 * S, height: STOCK_D * S * DEPTH,
      fill: "#2a332e", stroke: "#8f9a93", "stroke-width": 1.2, "stroke-dasharray": "5 4" }));
    add(-96, s("g", { class: "cc-mat-text" },
      s("rect", { x: px(at.x - STOCK_HALF) + 6, y: py(zTop + STOCK_D) - 17, width: 9, height: 9, rx: 2, fill: STATION_COLOR[scenario.stations[p].id] }),
      tag(px(at.x - STOCK_HALF) + 19, py(zTop + STOCK_D) - 8, "적치장", "cc-tag")));
  }
  const stock = stockAssign(frame);
  for (const l of frame.lots) {
    const keys = [`q:${l.ship}`, `o:${l.ship}`, ...(l.parts ?? []).map((pt) => `w:${l.ship}:${pt.unit}`)];
    for (const key of keys) {
      const spot = stock.get(key);
      if (!spot) continue;
      const at = stockSpot(spot.station, spot.index);
      const why = spot.reason === "pair" ? "짝 대기" : spot.reason === "outbound" ? "운반 대기" : null;
      add(at.z + 0.01, block(l, lot(at.x, at.z, l.form, 0.55, l.type), chip(at.x, at.z - 0.2, 0.4, l, lateNow(l)),
        why ? tag(px(at.x), py(at.z) + 13, why, "cc-tag mid pair") : s("g")));
    }
  }

  // ----- 골리앗 크레인 위험 반경(3.0 안전, 현장 3D와 같은 CRANE_R): 도크마다 점선 원, 그 도크가 탑재 중이면 진하게 -----
  // 도크마다 크레인이 하나다(D36): 2호 도크가 있으면 2호 크레인의 틀과 반경도 그린다.
  const dockUnits = frame.stations[3]?.units ?? [];
  dockUnits.forEach((dock, u) => {
    const busy = dock.state === "work" || dock.state === "rework";
    const zc = dockZ(u);
    add(-95, s("ellipse", { cx: px(STATION_X[3]), cy: py(zc), rx: CRANE_R * S, ry: CRANE_R * S * DEPTH, fill: "none",
      stroke: "#e0b43a", "stroke-width": busy ? 2.2 : 1.2, "stroke-dasharray": "7 5", opacity: busy ? 0.95 : 0.5 }));
  });
  add(-95, tag(px(STATION_X[3] - CRANE_R) + 4, py(2.6) + 4, "반경 10m 출입 금지", "cc-tag warn"));

  // ----- 골리앗 크레인(탑재 위, 틀만): 도크마다 하나 -----
  const cx = STATION_X[3];
  dockUnits.forEach((_, u) => {
    const zc = dockZ(u);
    const crane = s("g", { class: "cc-crane", opacity: 0.85 });
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) crane.append(s("line", { x1: px(cx + sx * 2), y1: py(zc + sz * 1.8), x2: px(cx + sx * 2), y2: py(zc + sz * 1.8, 3.4), stroke: "#c9a640", "stroke-width": 3 }));
      crane.append(s("line", { x1: px(cx + sx * 2), y1: py(zc - 1.8, 3.4), x2: px(cx + sx * 2), y2: py(zc + 1.8, 3.4), stroke: "#c9a640", "stroke-width": 3 }));
    }
    crane.append(s("rect", { x: px(cx - 2.2), y: py(zc, 3.5) - 4, width: 4.4 * S, height: 8, fill: "#c9a640" }));
    add(zc + 1.9, crane);
    // 도크가 구획마다 하나라 크레인 이름도 크레인마다(1도크 = 1호, 2도크 = 2호). 큰길 쪽에는 적지 않는다(이웃 구획과 겹친다).
    const name = dockUnits.length > 1 ? `골리앗 크레인 ${u + 1}호` : "골리앗 크레인";
    add(zc - 6, zc <= LANE_Z ? tag(px(cx), py(zc - 1.8, 3.5) - 10, name, "cc-place") : tag(px(cx), py(zc + 1.8) + 22, name, "cc-place"));
  });

  // ----- 트랜스포터 -----
  frame.transporters.forEach((tr, k) => {
    const carried = tr.state === "move" && tr.ship ? frame.lots.find((l) => l.ship === tr.ship && l.place === "carried") : undefined;
    const x = carried ? (STATION_X[carried.station] + (STATION_X[carried.station + 1] ?? STATION_X[carried.station] + 4)) / 2 : DEPOT.x + 0.6;
    const z = carried ? LANE_Z : LANE_Z - 0.3 + k * 1.15;
    const body = tr.state === "breakdown_stop" ? (STATE_INFO.breakdown_stop?.color ?? "#8e2e42") : "#5f6b73";
    add(z, box(x, z, 2.0, 0.8, 0.3, body, "#3f474d"));
    if (carried) {
      add(z + 0.02, block(carried, lot(x, z, carried.form, 0.7), chip(x, z - 0.3, 0.9, carried, lateNow(carried))));
    }
    add(z + 0.5, tag(px(x), py(z + 0.4) + 13, tr.state === "breakdown_stop" ? `${tr.id} 고장` : tr.id, tr.state === "breakdown_stop" ? "cc-tag mid stop" : "cc-tag mid"));
  });

  // ----- 안벽 앞 바다(인도): 현장 3D와 같은 자리, 세 척씩 두 줄 -----
  const sea = frame.lots.filter((l) => l.place === "sea").sort((a, b) => a.slot - b.slot);
  sea.slice(0, 6).forEach((l, i) => {
    const { x: bx, z: bz } = seaSpot(i);
    add(bz, block(l, lot(bx, bz, 4, 0.75, l.type),
      s("text", { x: px(bx), y: py(bz) + 12, class: l.late ? "cc-sea-name late" : "cc-sea-name" }, l.ship)));
  });
  const waiting = frame.lots.filter((l) => l.place === "hidden").map((l) => l.ship);
  add(9, tag(px((QUAY.x0 + QUAY.x1) / 2), py(QUAY.z0 + 1.8), `안벽 · 인도 ${sea.length}척${waiting.length ? ` · 착수 전 ${waiting.join(" ")}` : ""}`, "cc-tag mid"));

  // ----- 그리기: 고른 구획을 화면 가득 -----
  const sec = sectorBounds(opts.focus, docks);
  // 작은 구획(안벽, 도크)도 최소 크기로 그려 구획마다 글자 크기가 너무 달라지지 않게 한다(가운데 맞춤, 이웃이 조금 보인다).
  const pad = 0.6, MIN_W = 18, MIN_D = 12;
  const w = Math.max(sec.x1 - sec.x0 + 2 * pad, MIN_W), d = Math.max(sec.z1 - sec.z0 + 2 * pad, MIN_D);
  const vx = (sec.x0 + sec.x1) / 2, vz = (sec.z0 + sec.z1) / 2;
  const top = py(vz - d / 2, 2.8), bottom = py(vz + d / 2);
  const viewBox = `${px(vx - w / 2)} ${top} ${w * S} ${bottom - top}`;
  const svg = s("svg", {
    class: "cc-feed zoom", viewBox, preserveAspectRatio: "xMidYMid meet", role: "img",
    "aria-label": `작업 현황 ${sec.name}, ${frame.day}일`,
  });
  svg.append(s("rect", { x: -2000, y: -2000, width: 6000, height: 6000, class: "cc-bg" }));
  items.sort((a, b) => a.z - b.z).forEach((it) => svg.append(it.el));
  return svg;
}
