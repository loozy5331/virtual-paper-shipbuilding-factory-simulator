// 관제실 작업 현황 전경(2.1): 높은 곳에서 조선소를 내려다본 2D 정지 화면. 기호도를 대신한다.
// 화면에는 "CCTV"라는 말을 쓰지 않는다(감시처럼 느껴져서, 사용자 결정). 파일 이름만 옛 이름이다.
// 바로 위에서 30도쯤 기운 시점이다(바닥은 위에서, 사람·블록·선반은 앞면이 조금 보인다).
// 배치는 현장 3D(scene/yard.ts)와 같은 좌표를 쓴다. 작업모를 쓰고 나가면 같은 자리가 3D로 보인다.
// 공정을 누르면 같은 그림을 그 자리로 확대한다(그림을 따로 그리지 않는다).
//
// 사람은 단색 기호(둥근 몸 + 고깔모자, 역할 색)로만 그린다. 얼굴·체격·이름을 그릴 자리가 없어 익명이 구조로 보장된다.
// 애니메이션은 넣지 않는다: 날짜가 바뀔 때만 다시 그린다. 3D와 같은 scene/frame.ts의 Frame을 그리기만 한다.

import type { Scenario } from "./api";
import { s } from "./dom";
import { HAT, STATE_INFO, STATION_COLOR } from "./labels";
import type { Frame, LotView } from "./scene/frame";

// ----- 현장 3D와 같은 배치(yard.ts) -----
const STATION_X = [-9, -3.5, 2, 8.5];
const MAT_W = 3.2, MAT_D = 2.6, MAT2_D = 2.3, UNIT2_Z = -2.85;
const QUEUE_Z = 2.2, LANE_Z = 3.7, DEPOT_X = -12;
const CUP = { x: 13.4, z: 0.6, r: 2.3 };
const LOUNGE = { x: -11.4, z: -4.4 };
const SHELF_X = [-7.2, -4.7, -2.2], SHELF_Z = -4.8;
const LAB = { x: 4.2, z: -5 };

// ----- 투영: 위에서 30도 기운 정사영 -----
const S = 30;                        // 1 단위 = 30px
const DEPTH = Math.cos(Math.PI / 6); // 바닥 깊이는 0.87배로 줄고
const RISE = Math.sin(Math.PI / 6);  // 높이는 0.5배로 보인다
const X0 = -14, Z0 = -7.6, TOP = 34;
const VIEW_W = (17.2 - X0) * S;
const VIEW_H = TOP + (5.6 - Z0) * S * DEPTH + 8;

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

export interface CctvOptions {
  /** 확대해서 볼 공정. null이면 전경. */
  focus: number | null;
  onStation: (station: number) => void;
}

export function renderCctv(frame: Frame, scenario: Scenario, opts: CctvOptions): SVGElement {
  const due = Object.fromEntries(scenario.orders.map((o) => [o.id, o.due_day]));
  // 지연 표시는 오늘 기준(최종 결과를 미리 알려 주지 않게).
  const lateNow = (l: LotView) => (l.place === "sea" ? l.late : frame.day > due[l.ship]);
  const items: Item[] = [];
  const add = (z: number, el: SVGElement) => items.push({ z, el });

  // ----- 바닥: 운반로, 작업대기소, 물그릇 받침 -----
  const laneW = STATION_X[3] - DEPOT_X + 3;
  add(-99, box((DEPOT_X + STATION_X[3]) / 2 + 1.5, LANE_Z, laneW, 1.0, 0.02, "#3a423d", "#3a423d"));
  add(-99, box(LOUNGE.x, LOUNGE.z, 3.2, 2.6, 0.02, "#2c3530", "#2c3530"));
  add(-98, s("ellipse", { cx: px(CUP.x), cy: py(CUP.z), rx: 3.1 * S, ry: 3.1 * S * DEPTH, fill: "#2c3530", stroke: EDGE }));

  // ----- 자재창고 선반 -----
  frame.shelves.forEach((sh, i) => {
    const x = SHELF_X[i];
    if (x === undefined) return;
    const g = s("g", { class: "cc-shelf" }, box(x, SHELF_Z, 2.1, 0.5, 1.6, "#4d4238", "#5c4f42"));
    const shown = Math.min(sh.qty, 8);
    for (let k = 0; k < shown; k++) {
      const bx = px(x - 0.85 + (k % 4) * 0.45), by = py(SHELF_Z + 0.25, 1.35 - Math.floor(k / 4) * 0.6);
      g.append(s("rect", { x: bx, y: by, width: 11, height: 8, fill: PAPER }));
    }
    const empty = sh.qty <= 0;
    g.append(tag(px(x), py(SHELF_Z - 0.25, 1.6) - 6, `${sh.name} ${empty ? (sh.nextArrival ? `입고 D-${sh.nextArrival - frame.day}` : "없음") : sh.qty}`,
      empty ? "cc-tag mid warn" : "cc-tag mid"));
    add(SHELF_Z, g);
  });
  add(SHELF_Z - 1, tag(px(SHELF_X[1]), py(SHELF_Z - 0.25, 1.6) - 24, "자재창고", "cc-place"));

  // ----- 연구소 -----
  const r = frame.research;
  add(LAB.z, s("g", null,
    box(LAB.x, LAB.z, 2.2, 2.0, 1.6, "#55636b", "#6c7a82"),
    tag(px(LAB.x), py(LAB.z - 1, 1.6) - 8, "연구소", "cc-place"),
    tag(px(LAB.x), py(LAB.z + 1) + 14, r.current ? `${r.current.name} ${r.current.done}/${r.current.total}일` : r.finished.length ? `완료 ${r.finished.length}개` : "쉬는 중", "cc-tag mid")));

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
    const x = STATION_X[p];
    const view = frame.stations[p];
    const color = STATION_COLOR[st.id];
    view.units.forEach((unit, k) => {
      const z = k === 1 ? UNIT2_Z : 0;
      const d = k === 1 ? MAT2_D : MAT_D;
      const g = s("g", {
        class: "cc-station pick", role: "button", tabindex: 0,
        "aria-label": `${st.name} ${unit.unit}호. 눌러서 확대`,
        onclick: () => opts.onStation(p),
        onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") opts.onStation(p); },
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
      const here = frame.lots.find((l) => l.place === "bench" && l.station === p && l.ship === unit.ship);
      if (here) {
        add(z, lot(x, z, here.form, 1, here.type));
        // 배 이름표는 정반 뒤 가장자리 바로 위(정반 안의 글과 겹치지 않게)
        add(z + 0.02, chip(x, z - d / 2, 0, here, lateNow(here)));
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
    const ty = py(MAT_D / 2) - 6;
    add(MAT_D / 2 + 0.05, s("g", { class: "cc-mat-text" },
      tag(px(x - MAT_W / 2) + 5, ty, st.name, "cc-name"),
      tag(px(x + MAT_W / 2) - 5, ty, status, info ? "cc-tag end loss" : "cc-tag end"),
      extra ? tag(px(x + MAT_W / 2) - 5, py(-MAT_D / 2) + 14, extra, "cc-tag end") : s("g")));
    // 공정 앞 대기 줄
    frame.lots.filter((l) => l.place === "queue" && l.station === p).sort((a, b) => a.slot - b.slot).slice(0, 3).forEach((l, i) => {
      const qx = x - 1 + i * 1.0;
      add(QUEUE_Z, lot(qx, QUEUE_Z, l.form, 0.55));
      add(QUEUE_Z + 0.01, chip(qx, QUEUE_Z - 0.2, 0.4, l, lateNow(l)));
    });
    // 끝내고 운반을 기다리는 로트: 다음 공정 쪽 길가
    frame.lots.filter((l) => l.place === "outbound" && l.station === p).slice(0, 2).forEach((l, i) => {
      const ox = x + MAT_W / 2 + 0.6 + i * 0.9;
      add(QUEUE_Z, lot(ox, QUEUE_Z, l.form, 0.55));
      add(QUEUE_Z + 0.01, chip(ox, QUEUE_Z - 0.2, 0.4, l, lateNow(l)));
    });
  });

  // ----- 골리앗 크레인(탑재 위, 틀만) -----
  const cx = STATION_X[3];
  const crane = s("g", { class: "cc-crane", opacity: 0.85 });
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) crane.append(s("line", { x1: px(cx + sx * 2), y1: py(sz * 1.8), x2: px(cx + sx * 2), y2: py(sz * 1.8, 3.4), stroke: "#c9a640", "stroke-width": 3 }));
    crane.append(s("line", { x1: px(cx + sx * 2), y1: py(-1.8, 3.4), x2: px(cx + sx * 2), y2: py(1.8, 3.4), stroke: "#c9a640", "stroke-width": 3 }));
  }
  crane.append(s("rect", { x: px(cx - 2.2), y: py(0, 3.5) - 4, width: 4.4 * S, height: 8, fill: "#c9a640" }));
  add(1.9, crane);
  add(-6, tag(px(cx), py(-1.8, 3.5) - 10, "골리앗 크레인", "cc-place"));

  // ----- 트랜스포터 -----
  frame.transporters.forEach((tr, k) => {
    const carried = tr.state === "move" && tr.ship ? frame.lots.find((l) => l.ship === tr.ship && l.place === "carried") : undefined;
    const x = carried ? (STATION_X[carried.station] + (STATION_X[carried.station + 1] ?? STATION_X[carried.station] + 4)) / 2 : DEPOT_X + 0.6;
    const z = carried ? LANE_Z : LANE_Z - 0.3 + k * 1.15;
    const body = tr.state === "breakdown_stop" ? (STATE_INFO.breakdown_stop?.color ?? "#8e2e42") : "#5f6b73";
    add(z, box(x, z, 2.0, 0.8, 0.3, body, "#3f474d"));
    if (carried) {
      add(z + 0.01, lot(x, z, carried.form, 0.7));
      add(z + 0.02, chip(x, z - 0.3, 0.9, carried, lateNow(carried)));
    }
    add(z + 0.5, tag(px(x), py(z + 0.4) + 13, tr.state === "breakdown_stop" ? `${tr.id} 고장` : tr.id, tr.state === "breakdown_stop" ? "cc-tag mid stop" : "cc-tag mid"));
  });

  // ----- 물그릇(인도) -----
  add(CUP.z - CUP.r, s("ellipse", { cx: px(CUP.x), cy: py(CUP.z, 1.42), rx: CUP.r * S, ry: CUP.r * S * DEPTH, fill: "#3d5a6c", stroke: "#8fa7b4", "stroke-width": 1.2 }));
  const sea = frame.lots.filter((l) => l.place === "sea").sort((a, b) => a.slot - b.slot);
  sea.slice(0, 6).forEach((l, i) => {
    // 두 척씩 세 줄. 이름은 배 아래 작은 글(지연이면 빨강) — 이름표 상자는 배를 가린다.
    const col = i % 2, row = Math.floor(i / 2);
    const bx = CUP.x - 0.85 + col * 1.7, bz = CUP.z - 1.15 + row * 1.05;
    const lift = -1.42 * S * RISE;
    add(bz, s("g", { transform: `translate(0 ${lift})` }, lot(bx, bz, 4, 0.55, l.type),
      s("text", { x: px(bx), y: py(bz) + 11, class: l.late ? "cc-sea-name late" : "cc-sea-name" }, l.ship)));
  });
  const waiting = frame.lots.filter((l) => l.place === "hidden").map((l) => l.ship);
  add(9, tag(px(CUP.x), py(CUP.z + 3.1) + 14, `인도 ${sea.length}척${waiting.length ? ` · 착수 전 ${waiting.join(" ")}` : ""}`, "cc-tag mid"));

  // ----- 그리기 -----
  const focus = opts.focus;
  let viewBox = `0 0 ${VIEW_W} ${VIEW_H}`;
  if (focus !== null) {
    // 공정 확대: 정반 둘(2호는 뒤)과 대기 줄이 세로로 들어가게. 가로는 화면 비율대로 이웃 공정까지 보인다.
    const top = py(-4.3, 1), bottom = py(4.5);
    const w = 9 * S;
    viewBox = `${px(STATION_X[focus]) - w / 2} ${top} ${w} ${bottom - top}`;
  }
  const svg = s("svg", {
    class: focus === null ? "cc-feed" : "cc-feed zoom", viewBox, preserveAspectRatio: "xMidYMid meet", role: "img",
    "aria-label": `작업 현황 ${focus === null ? "전경" : scenario.stations[focus].name}, ${frame.day}일`,
  });
  svg.append(s("rect", { x: -2000, y: -2000, width: 6000, height: 6000, class: "cc-bg" }));
  items.sort((a, b) => a.z - b.z).forEach((it) => svg.append(it.el));
  return svg;
}
