// 관제실 기호도: 현장을 추상화한 2D 그림. "오늘 어디에 무엇이 있는가"를 보여 준다(간트는 "언제").
// 3D와 같은 scene/frame.ts의 Frame을 그리기만 한다. 규칙을 다시 계산하지 않는다.
//
//   [자재창고] → [소조립] → [중조립] → [대조립] → [탑재] → [인도]
//   [작업대기소] [트랜스포터] [연구소] [착수 전]
//
// 공정 상자 안의 작업장은 목록으로 그린다. 증설한 공정은 1호·2호 두 줄이다.

import type { Scenario } from "./api";
import { s } from "./dom";
import { STATE_INFO, STATION_COLOR, WORK_STATE } from "./labels";
import type { Frame, LotView } from "./scene/frame";

const W = 880;          // 간트(1000)보다 좁게 잡아 같은 폭에서 글자가 더 크게 보이게 한다. 2호 줄이 들어갈 만큼은 넓게.
const STORE_W = 92;
const DELIVER_W = 82;
const BOX_Y = 6;
const BOX_H = 112;
const BOTTOM_Y = 130;
const BOTTOM_H = 40;
const HEIGHT = BOTTOM_Y + BOTTOM_H + 4;
const GAP = 40;          // 공정 사이 화살표 자리 (운반 중, 운반 대기)

/** 작업장 상태 → 글과 색. 색만으로 구분하지 않도록 글을 함께 쓴다. */
function stationStatus(state: string): { text: string; color: string | null } {
  if (state === "work") return { text: "작업 중", color: WORK_STATE.color };
  if (state === "idle") return { text: "비어 있음", color: null };
  const info = STATE_INFO[state];
  return info ? { text: info.name, color: info.color } : { text: state, color: null };
}

/** 배 이름표. 손실 상태면 그 색을 왼쪽 띠로 붙이고 상태 이름을 title에 둔다. late면 빨간 테두리. */
function chip(x: number, y: number, lot: LotView, late: boolean, note = ""): SVGElement {
  const info = lot.state === "work" ? WORK_STATE : STATE_INFO[lot.state];
  const g = s("g", { class: "sch-chip" },
    s("title", null, `${lot.ship}${info ? ` · ${info.name}` : ""}${note ? ` · ${note}` : ""}`),
    s("rect", { x, y, width: 34, height: 18, rx: 4, class: late ? "chip-box late" : "chip-box" }),
    s("text", { x: x + 17, y: y + 13, class: "chip-text" }, lot.ship));
  if (info && lot.state !== "work") {
    g.append(s("rect", { x, y, width: 5, height: 18, rx: 2, fill: info.color }));
  }
  return g;
}

export interface SchematicOptions {
  /** 공정 상자를 눌렀을 때. 60일 전이면 화면이 안내만 띄운다. */
  onStation: (index: number) => void;
}

export function renderSchematic(frame: Frame, scenario: Scenario, opts: SchematicOptions): SVGElement {
  const n = scenario.stations.length;
  const boxW = (W - STORE_W - DELIVER_W - GAP * (n + 1)) / n;
  const boxX = (p: number) => STORE_W + GAP + p * (boxW + GAP);
  // 지연 표시는 "오늘 기준"이다. 최종 결과(lot.late)를 쓰면 재생 중에 결과를 미리 알려 준다.
  const due = Object.fromEntries(scenario.orders.map((o) => [o.id, o.due_day]));
  const lateNow = (lot: LotView) => (lot.place === "sea" ? lot.late : frame.day > due[lot.ship]);
  const tag = (x: number, y: number, lot: LotView, note = "") => chip(x, y, lot, lateNow(lot), note);
  const lotsAt = (place: LotView["place"], p?: number) =>
    frame.lots.filter((l) => l.place === place && (p === undefined || l.station === p)).sort((a, b) => a.slot - b.slot);

  const svg = s("svg", {
    class: "schematic", viewBox: `0 0 ${W} ${HEIGHT}`, role: "img",
    "aria-label": `기호도, ${frame.day}일째: 자재창고, 공정 ${n}개, 인도`,
  });
  svg.append(s("defs", null,
    s("marker", { id: "sch-arrow", viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: "auto" },
      s("path", { d: "M0 0 L8 4 L0 8 Z", class: "sch-arrowhead" }))));

  // ----- 자재창고 -----
  const store = s("g", { class: "sch-box store" },
    s("rect", { x: 0.5, y: BOX_Y, width: STORE_W - 1, height: BOX_H, rx: 6, class: "box" }),
    s("text", { x: 10, y: BOX_Y + 18, class: "box-title" }, "자재창고"));
  frame.shelves.forEach((sh, i) => {
    const y = BOX_Y + 42 + i * 22;
    const empty = sh.qty <= 0;
    store.append(
      s("text", { x: 10, y, class: "shelf-name" }, sh.name),
      s("text", { x: STORE_W - 10, y, class: empty ? "shelf-qty empty" : "shelf-qty" },
        empty && sh.nextArrival ? `입고 D-${sh.nextArrival - frame.day}` : String(sh.qty)));
  });
  svg.append(store);

  const arrow = (x1: number, x2: number) =>
    s("line", { x1, x2, y1: BOX_Y + 30, y2: BOX_Y + 30, class: "sch-flow", "marker-end": "url(#sch-arrow)" });
  svg.append(arrow(STORE_W + 4, boxX(0) - 4));

  // ----- 공정 -----
  scenario.stations.forEach((st, p) => {
    const x = boxX(p);
    const view = frame.stations[p];
    const status = stationStatus(view.units.find((u) => u.state !== "idle")?.state ?? view.state);
    const g = s("g", {
      class: "sch-box station pick", tabindex: 0, role: "button",
      "aria-label": `${st.name}: ${status.text}. 눌러서 현장에서 보기`,
      onclick: () => opts.onStation(p),
      onkeydown: (e: KeyboardEvent) => { if (e.key === "Enter") opts.onStation(p); },
    });
    g.append(
      s("title", null, `${st.real} — 눌러서 현장에서 보기`),
      s("rect", { x, y: BOX_Y, width: boxW, height: BOX_H, rx: 6, class: "box" }),
      s("rect", { x: x + 10, y: BOX_Y + 9, width: 10, height: 10, rx: 3, fill: STATION_COLOR[st.id] }),
      s("text", { x: x + 26, y: BOX_Y + 18, class: "box-title" }, st.name));
    // 공정에 걸린 운영 표시: 잔업, 시니어(지정 공정)
    const crewName = { normal: "", skilled: "숙련공", robot: "로봇" }[view.crew];
    const tags = [view.overtime && view.crew !== "robot" ? "잔업" : "", crewName].filter(Boolean).join(" · ");
    if (tags) g.append(s("text", { x: x + boxW - 10, y: BOX_Y + 18, class: view.senior ? "box-tag senior" : "box-tag" }, tags));

    // 작업장: 상태 띠 + 상태 글, 배 이름표, 인원 점. 1개면 두 줄 높이, 2개면 한 줄씩.
    const uy = BOX_Y + 28;
    const rowH = view.units.length === 1 ? 44 : 22;
    view.units.forEach((unit, k) => {
      const ry = uy + k * (rowH + 2);
      const st2 = stationStatus(unit.state);
      const lot = frame.lots.find((l) => l.place === "bench" && l.station === p && l.ship === unit.ship);
      g.append(s("rect", { x: x + 8, y: ry, width: boxW - 16, height: rowH, rx: 4, class: "unit" }));
      if (st2.color) g.append(s("rect", { x: x + 8, y: ry + rowH - 3, width: boxW - 16, height: 3, fill: st2.color }));
      g.append(s("text", { x: x + 14, y: ry + 14, class: "unit-name" }, `${unit.unit}호`));
      const dots = (cx: number, cy: number) => {
        for (let w = 0; w < unit.workers; w++) {
          g.append(s("circle", { cx: cx + w * 12, cy, r: 4.5, class: "worker" }, s("title", null, `배정 ${unit.workers}명`)));
        }
      };
      if (rowH === 44) {
        g.append(s("text", { x: x + 40, y: ry + 14, class: unit.stop ? "unit-status stop" : "unit-status" }, st2.text));
        if (lot) g.append(tag(x + 14, ry + 19, lot));
        dots(x + 60, ry + 28);
      } else {
        // 한 줄: "1호 [S3] ●●" (작업 중이면 인원 점, 아니면 상태 글)
        const after = lot ? x + 72 : x + 36;
        if (lot) g.append(tag(x + 34, ry + 2, lot));
        if (unit.state === "work") dots(after + 4, ry + 11);
        else g.append(s("text", { x: after, y: ry + 15, class: unit.stop ? "unit-status small stop" : "unit-status small" }, st2.text));
      }
    });

    // 공정 앞 대기 줄
    const queue = lotsAt("queue", p);
    if (queue.length) {
      const qy = BOX_Y + 80;
      g.append(s("text", { x: x + 10, y: qy + 13, class: "queue-label" }, "대기"));
      queue.slice(0, 3).forEach((lot, i) => g.append(tag(x + 38 + i * 38, qy, lot)));
      if (queue.length > 3) g.append(s("text", { x: x + boxW - 8, y: qy + 13, class: "queue-label end" }, `+${queue.length - 3}`));
    }
    svg.append(g);

    // 다음 공정(또는 인도)으로 가는 화살표. 위는 운반 중, 아래는 운반 대기.
    const ax = x + boxW;
    svg.append(arrow(ax + 4, ax + GAP - 4));
    const moving = [...lotsAt("carried", p).map((lot) => ({ lot, note: "운반 중" })), ...lotsAt("outbound", p).map((lot) => ({ lot, note: "" }))];
    moving.slice(0, 4).forEach(({ lot, note }, i) => svg.append(tag(ax + 3, i === 0 ? BOX_Y + 6 : BOX_Y + 18 + i * 22, lot, note)));
  });

  // ----- 인도 -----
  const dx = W - DELIVER_W;
  const deliver = s("g", { class: "sch-box deliver" },
    s("rect", { x: dx + 0.5, y: BOX_Y, width: DELIVER_W - 1, height: BOX_H, rx: 6, class: "box" }),
    s("text", { x: dx + 10, y: BOX_Y + 18, class: "box-title" }, "인도"));
  lotsAt("sea").forEach((lot, i) => {
    const y = BOX_Y + 28 + i * 21;
    deliver.append(tag(dx + 10, y, lot, lot.late ? "납기 지연" : "납기 준수"),
      s("text", { x: dx + 50, y: y + 13, class: lot.late ? "deliver-note late" : "deliver-note" }, lot.late ? "지연" : "준수"));
  });
  svg.append(deliver);

  // ----- 아래 줄: 작업대기소, 트랜스포터, 연구소, 착수 전 -----
  const cell = (x: number, w: number, title: string, body: (g: SVGElement, x: number, y: number) => void) => {
    const g = s("g", { class: "sch-box small" },
      s("rect", { x: x + 0.5, y: BOTTOM_Y, width: w - 1, height: BOTTOM_H, rx: 6, class: "box" }),
      s("text", { x: x + 10, y: BOTTOM_Y + 25, class: "box-title" }, title));
    body(g, x + 10 + title.length * 13 + 8, BOTTOM_Y + 25);
    svg.append(g);
  };
  const cw = (W - 30) / 4;
  cell(0, cw, "작업대기소", (g, x, y) => {
    g.append(s("text", { x, y, class: "cell-text" }, `쉬는 인원 ${frame.idleWorkers}명`));
  });
  cell(cw + 10, cw, "트랜스포터", (g, x, y) => {
    g.append(s("text", { x, y, class: "cell-text" }, frame.transporters.map((tr) =>
      `${tr.id} ${tr.state === "move" ? `${tr.ship} 운반` : tr.state === "breakdown_stop" ? "고장" : "대기"}`).join(" · ")));
  });
  cell((cw + 10) * 2, cw, "연구소", (g, x, y) => {
    const r = frame.research;
    g.append(s("text", { x, y, class: "cell-text" },
      r.current ? `${r.current.name} ${r.current.done}/${r.current.total}일` : r.finished.length ? `완료 ${r.finished.length}개` : "쉬는 중"));
  });
  cell((cw + 10) * 3, cw, "착수 전", (g, x, y) => {
    const waiting = lotsAt("hidden");
    g.append(s("text", { x, y, class: "cell-text" }, waiting.length ? waiting.map((l) => l.ship).join(" · ") : "없음"));
  });

  return svg;
}
