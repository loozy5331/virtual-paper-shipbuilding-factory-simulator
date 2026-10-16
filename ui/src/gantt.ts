// 간트 차트. 가로축은 1일부터 시나리오의 작업일(4.0 반기는 120일)까지.
// 위쪽은 배 4척: 배마다 두 줄, 위는 작업장을 차지한 구간(작업장 색, 재작업은 빗금, 운반은 점선 틀), 아래 얇은 줄은 손실 구간.
// 나눠 한 공정은 막대 하나에 "×2"와 짝 대기 꼬리(옅은 칸 + 테두리)만. 작업장별 모습은 배 탭의 작업장 줄에서 본다.
// 아래쪽은 설비: 연구소, 트랜스포터(대별), 골리앗 크레인(탑재 작업장).
// 배 탭(renderShipGantt)은 한 척을 공정별 줄로 펼치고, 같은 공정을 쓰던 다른 배를 옅게 함께 그린다.
// 막대를 누르면 onPick으로 그 배·공정·기간을 넘긴다(현장 들어가는 길, D7).
// 재생 중에는 today까지만 그린다. 엔진이 준 segments와 daily를 자르고 묶기만 하고 새로 계산하지 않는다.

import { activeStations, blockLabel, type ForkliftJob, type Plan, type Result, type Scenario, type Segment } from "./api";
import { s } from "./dom";
import { PAIR_WAIT_EDGE, PAIR_WAIT_STATE, STATE_INFO, STATION_COLOR, STATION_TEXT } from "./labels";

// 크기는 모니터의 실제 픽셀(4.15.6). 고정 폭(1000)을 모니터에 줄여 넣으면 11px 글자가 7px로 보였다.
// 그래서 1단위 = 1px로 그리고, 글자 크기는 CSS 값 그대로 읽힌다. 폭을 모르면(처음 그릴 때) 1000.
// 전체 탭의 배 줄은 배가 모두 모니터에 들어오게 줄 높이를 줄인다(MIN_ROW까지, 글자는 그대로). 설비 줄은 그 아래로 스크롤.
const MIN_W = 560;
const MIN_ROW = 44;
let W = 1000;
const LEFT = 148;
const RIGHT = 70;
const TOP = 44;
let ROW_H = 56;
let BAR_H = 24;
const LOSS_GAP = 4;
let LOSS_H = 10;
const PLAN_H = 4;         // 계획 줄(4.16): 실적 막대 바로 위 가는 줄
const PLAN_GAP = 2;
const EQ_H = 32;          // 설비 줄 높이
const EQ_BAR = 18;
const SECTION_GAP = 22;
const CRANE = "erection";
const STOP_COLOR = STATE_INFO.accident_stop.color;
const RESEARCH_COLOR = "#1d5c45";

interface Run<T> { key: T; start: number; end: number }

/** 막대를 눌렀을 때 넘기는 것: 현장에서 그 공정을 그 날짜부터 본다. */
export interface GanttPick { ship: string | null; station: string; start: number; end: number }
export type OnPick = (pick: GanttPick) => void;

/** 하루 기록에서 같은 값이 이어지는 구간을 묶는다. key가 null인 날은 건너뛴다. */
function runs<T>(daily: unknown[], keyOf: (day: number) => T | null, today: number): Run<T>[] {
  const out: Run<T>[] = [];
  for (let day = 1; day <= Math.min(today, daily.length); day++) {
    const key = keyOf(day);
    if (key === null) continue;
    const last = out[out.length - 1];
    if (last && last.key === key && last.end === day - 1) last.end = day;
    else out.push({ key, start: day, end: day });
  }
  return out;
}

/** 막대 하나. 넓으면 안에 라벨을 쓰고, 빗금이 필요하면 덧씌운다. 제목은 마우스를 올리면 나온다. */
function barEl(x0: number, y: number, w: number, hgt: number, fill: string, title: string,
  opts: { label?: string; textColor?: string; hatch?: boolean; className?: string; onPick?: () => void } = {}): SVGElement {
  const g = s("g", opts.onPick ? { class: "pick", onclick: opts.onPick } : null,
    s("title", null, title),
    s("rect", { x: x0 + 0.5, y, width: Math.max(1, w - 1), height: hgt, rx: 3, fill, class: opts.className ?? "" }));
  if (opts.hatch) g.append(s("rect", { x: x0 + 0.5, y, width: Math.max(1, w - 1), height: hgt, rx: 3, fill: "url(#hatch)" }));
  if (opts.label && w >= opts.label.length * 7 + 10) {
    g.append(s("text", { x: x0 + w / 2, y: y + hgt / 2 + 4, class: "bar-label small", fill: opts.textColor ?? "#fff" }, opts.label));
  }
  return g;
}

type Ship = Result["ships"][number];

/**
 * 계획 줄(4.16): 실행 전 생산계획서의 계획 간트(미리보기 plan, 배가 작업장을 혼자 쓴다고 본 일정)를 실적 막대 바로 위에 가는 줄로.
 * 계획은 학생이 세운 것이라 재생 전부터 끝까지 다 그린다(결과를 미리 알려 주지 않는다). 실적 막대가 계획 줄보다 오른쪽으로 밀리면 그만큼 늦은 것.
 */
function planLine(sid: string, st: { id: string; name: string }, sp: { start: number; end: number }, days: number, y: number,
  x: (day: number) => number, width: (a: number, b: number) => number): SVGElement | null {
  if (sp.start > days) return null;
  return s("rect", { x: x(sp.start) + 0.5, y: y - PLAN_GAP - PLAN_H, width: Math.max(1, width(sp.start, Math.min(sp.end, days)) - 1), height: PLAN_H,
    rx: 1, fill: STATION_COLOR[st.id], class: "plan-line" },
  s("title", null, `${sid} · ${st.name} 계획 ${sp.start}~${sp.end}일`));
}

/**
 * 배 탭에 다른 배·빈 작업장·운반 설비의 고장을 그릴지(4.12.12). 이 배를 직접 멈춘 고장만 그린다:
 * 그날 이 배가 그 공정을 기다렸거나(작업장 대기, 하루 기록의 공정이 기다린 공정), 운반을 기다렸거나(트랜스포터), 자재를 기다렸을 때(지게차).
 * 이 배가 작업 중에 겪은 고장은 따로 늘 진하게 그린다.
 */
function waitedOn(ship: Ship, day: number, state: "station_wait" | "transport_wait" | "material_wait", station?: string): boolean {
  const rec = ship.daily[day - 1];
  return !!rec && rec.state === state && (station === undefined || rec.station === station);
}

/** 이 운반 구간을 트랜스포터가 날랐는가(그러면 배 탭은 공정 줄 대신 운반 설비 줄에 그린다, 4.12.10) */
function byEquipment(seg: Segment, carried: Set<number>): boolean {
  for (let d = seg.start; d <= seg.end; d++) if (!carried.has(d)) return false;
  return true;
}

/** 나눠 한 구간의 부분 수(가장 많이 나눈 날) */
function splitCount(ship: Ship, seg: Segment): number {
  let k = 1;
  for (let d = seg.start; d <= seg.end; d++) k = Math.max(k, ship.daily[d - 1]?.parts?.length ?? 1);
  return k;
}

/** 짝 대기 칸: 옅은 종이색 + 대기 회색 테두리(모든 공정 같은 색, 범례와 같다) */
function pairBox(x0: number, y: number, w: number, hgt: number, title: string): SVGElement {
  const el = barEl(x0, y, w, hgt, PAIR_WAIT_STATE.color, title);
  el.querySelector("rect")!.setAttribute("stroke", PAIR_WAIT_EDGE);
  return el;
}

/**
 * 나눠 하기 요약(전체 탭, 4.12.5). 막대는 공정 하나로 두고 작업장별로 가르지 않는다(블록이 더 잘게 나뉘어도 줄이 늘지 않게).
 * 먼저 끝난 부분이 짝을 기다린 날은 막대 끝에 짝 대기 칸(꼬리), 부분 하나만 겪은 손실(한 작업장 고장 등)은 아래 손실 줄에 얇게.
 * 작업장마다의 모습은 배별 탭의 작업장 줄에서 본다.
 */
function drawSplitSummary(g: SVGElement, ship: Ship, seg: Segment, name: string, y: number,
  x: (day: number) => number, width: (a: number, b: number) => number, today: number): void {
  const end = Math.min(seg.end, today);
  const inSeg = (d: number) => d >= seg.start && d <= end;
  const parts = (d: number) => ship.daily[d - 1].parts ?? [];
  for (const run of runs(ship.daily, (d) => inSeg(d) && parts(d).some((pt) => pt.state === "pair_wait") ? "pair" : null, today)) {
    g.append(pairBox(x(run.start), y, width(run.start, run.end), BAR_H,
      `${ship.id} · ${name} 짝 대기 · ${run.start}~${run.end}일 (먼저 끝난 부분이 적치장에서 나머지를 기다림)`));
  }
  const partLoss = (d: number) => {
    const pt = parts(d).find((p) => p.state !== "work" && p.state !== "rework" && p.state !== "pair_wait" && STATE_INFO[p.state]);
    return pt ? `${pt.state}:${pt.unit}` : null;
  };
  for (const run of runs(ship.daily, (d) => inSeg(d) ? partLoss(d) : null, today)) {
    const [state, unit] = run.key.split(":");
    const info = STATE_INFO[state];
    g.append(barEl(x(run.start), y + BAR_H + LOSS_GAP + 3, width(run.start, run.end), LOSS_H - 6, info.color,
      `${ship.id} · ${name} ${unit}호 작업장만 ${info.name} · ${run.start}~${run.end}일 (나머지 부분은 작업)`, { hatch: info.hatch }));
  }
}

/** 이 구간에 나눠 한 날이 있는가 */
function isSplit(ship: Result["ships"][number], seg: Segment): boolean {
  for (let d = seg.start; d <= seg.end; d++) if (ship.daily[d - 1]?.parts) return true;
  return false;
}

/** 그릴 크기(px). 폭은 0이면 그대로 둔다. ships가 있으면 배 줄을 높이 안에 맞춘다(전체 탭), 없으면 기본 줄(배 탭). */
function useSize(size?: { width: number; height: number }, ships = 0): void {
  if (size?.width) W = Math.max(MIN_W, Math.floor(size.width));
  const fit = ships && size?.height ? Math.floor((size.height - TOP - 8) / ships) : 56;
  ROW_H = Math.max(MIN_ROW, Math.min(56, fit));
  BAR_H = ROW_H >= 52 ? 24 : 18;
  LOSS_H = ROW_H >= 52 ? 10 : 7;
}

export function renderGantt(result: Result, scenario: Scenario, today: number, onPick?: OnPick, size?: { width: number; height: number }, plan?: Plan): SVGElement {
  useSize(size, result.ships.length);
  const days = result.days;
  const dayW = (W - LEFT - RIGHT) / days;
  const x = (day: number) => LEFT + (day - 1) * dayW;      // day의 왼쪽 끝
  const width = (start: number, end: number) => (end - start + 1) * dayW;
  const stationName = Object.fromEntries(scenario.stations.map((st) => [st.id, st.name]));
  const shipsBottom = TOP + result.ships.length * ROW_H;
  const craneUnits = result.stations.find((st) => st.id === CRANE)?.units.length ?? 1;
  const eqRows = 1 + result.transporters.length + (result.forklifts?.length ?? 0) + craneUnits;
  const height = shipsBottom + SECTION_GAP + eqRows * EQ_H + 8;
  const ended = today >= days;   // 합계는 끝난 뒤에만 보여 준다(재생 중에 결과를 미리 알려 주지 않게).

  const svg = s("svg", {
    class: "gantt", viewBox: `0 0 ${W} ${height}`, role: "img",
    "aria-label": `배 ${result.ships.length}척과 설비의 진행, ${today}일째`,
  });

  svg.append(s("defs", null,
    s("pattern", { id: "hatch", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
      s("rect", { width: 2.4, height: 6, fill: "#ffffff", opacity: 0.6 }))));

  // 날짜 축과 눈금
  const axis = s("g", { class: "axis" });
  for (let d = 1; d <= days; d++) {
    if (d === 1 || d % (days > 60 ? 10 : 5) === 0) {
      axis.append(
        s("line", { x1: x(d), x2: x(d), y1: TOP - 6, y2: height - 4, class: d % 10 === 0 ? "grid major" : "grid" }),
        s("text", { x: x(d) + dayW / 2, y: TOP - 14, class: "tick" }, d));
    }
  }
  axis.append(s("line", { x1: x(days + 1), x2: x(days + 1), y1: TOP - 6, y2: height - 4, class: "grid major" }));
  svg.append(axis);

  const bar = barEl;

  // ----- 배 -----
  result.ships.forEach((ship, row) => {
    const y = TOP + row * ROW_H + 10;
    const g = s("g", { class: "ship-row" });
    g.append(
      s("rect", { x: 0, y: y - 8, width: W, height: ROW_H - 4, class: row % 2 ? "band odd" : "band" }),
      s("text", { x: 12, y: y + 11, class: "ship-id" }, ship.id),
      s("text", { x: 12, y: y + 27, class: "ship-sub" }, `${ship.type_name} · 납기 ${ship.due_day}일`),
      s("rect", { x: LEFT, y, width: days * dayW, height: BAR_H, class: "lane" }),
    );
    const planned = plan?.ships[ship.id];
    if (planned) {
      for (const st of activeStations(scenario)) {
        const line = planned[st.id] && planLine(ship.id, st, planned[st.id], days, y, x, width);
        if (line) g.append(line);
      }
    }

    const visible = (seg: Segment) => seg.start <= today;
    const clipEnd = (seg: Segment) => Math.min(seg.end, today);

    for (const seg of ship.segments.filter(visible)) {
      const x0 = x(seg.start);
      const w = width(seg.start, clipEnd(seg));
      const name = stationName[seg.station];
      const span = `${seg.start}~${seg.end}일 (${seg.end - seg.start + 1}일)`;
      const pick = onPick && (() => onPick({ ship: ship.id, station: seg.station, start: seg.start, end: seg.end }));
      if (seg.state === "work" || seg.state === "rework") {
        // 위 줄: 작업장을 차지한 구간. 공정 이름은 쓰지 않는다(아래 범례의 색으로 읽는다, 4.12.9 사용자).
        // 재작업은 "재작업", 나눠 한 구간은 "×2"처럼 부분 수를 쓰고 짝 대기 꼬리를 덧그린다.
        const label = seg.state === "rework" ? `${name} 재작업` : name;
        const k = isSplit(ship, seg) ? splitCount(ship, seg) : 1;
        const text = [seg.state === "rework" ? "재작업" : "", k > 1 ? `×${k}` : ""].filter(Boolean).join(" ");
        g.append(bar(x0, y, w, BAR_H, STATION_COLOR[seg.station], `${ship.id} · ${label}${k > 1 ? ` (작업장 ${k}곳에 나눠 하기)` : ""} · ${span}`,
          { label: k > 1 || !text ? undefined : text, textColor: STATION_TEXT[seg.station], hatch: seg.state === "rework", onPick: pick }));
        if (k > 1) {
          drawSplitSummary(g, ship, seg, name, y, x, width, today);
          // 글자는 꼬리(짝 대기)에 가리지 않게 앞쪽 작업 부분 가운데에
          let solid = seg.start;
          while (solid < clipEnd(seg) && !ship.daily[solid]?.parts?.some((pt) => pt.state === "pair_wait")) solid++;
          const sw = width(seg.start, solid);
          const t = sw >= text.length * 7 + 10 ? text : `×${k}`;
          if (sw >= t.length * 7 + 6) {
            g.append(s("text", { x: x0 + sw / 2, y: y + BAR_H / 2 + 4, class: "bar-label small", fill: STATION_TEXT[seg.station] ?? "#fff", "pointer-events": "none" }, t));
          }
        }
      } else if (seg.state === "transport") {
        // 운반은 손실이 아니다. 위 줄에 점선 틀로만 그린다.
        g.append(s("g", null,
          s("title", null, `${ship.id} · ${name} → 다음 공정 운반 · ${span}`),
          s("rect", { x: x0 + 1.5, y: y + 4, width: Math.max(1, w - 3), height: BAR_H - 8, rx: 3, class: "transport" })));
      } else if (STATE_INFO[seg.state]) {
        // 아래 얇은 줄: 손실 구간. 같은 색끼리는 빗금과 라벨로 구분한다.
        const info = STATE_INFO[seg.state];
        g.append(bar(x0, y + BAR_H + LOSS_GAP, w, LOSS_H, info.color, `${ship.id} · ${info.name} (${name}) · ${span}`,
          { hatch: info.hatch, onPick: pick }));
      }
    }

    // 납기: 납기일이 끝나는 자리에 점선
    const dueX = x(ship.due_day + 1);
    const ly = y + BAR_H + LOSS_GAP;
    g.append(
      s("line", { x1: dueX, x2: dueX, y1: y - 5, y2: ly + LOSS_H + 4, class: "due" }),
      s("text", { x: dueX, y: y - 7, class: "due-label" }, "납기"),
    );

    // 인도: 인도한 날 끝에 마름모. 늦었으면 지연일을 붙인다.
    const midY = y + BAR_H / 2;
    if (ship.delivered_day !== null && ship.delivered_day <= today) {
      const dx = x(ship.delivered_day + 1);
      const late = ship.late_days > 0;
      g.append(
        s("path", { d: `M${dx} ${midY - 8} L${dx + 8} ${midY} L${dx} ${midY + 8} L${dx - 8} ${midY} Z`, class: late ? "deliver late" : "deliver" },
          s("title", null, `${ship.id} 인도 ${ship.delivered_day}일${late ? `, ${ship.late_days}일 지연` : ", 납기 준수"}`)),
        s("text", { x: x(days + 1) + 8, y: midY + 4, class: late ? "outcome late" : "outcome ok" },
          late ? `${ship.late_days}일 지연` : "납기 준수"),
      );
    } else if (today >= days) {
      g.append(s("text", { x: x(days + 1) + 8, y: midY + 4, class: "outcome late" }, "미인도"));
    }

    svg.append(g);
  });

  // ----- 설비 -----
  let ey = shipsBottom + SECTION_GAP;
  svg.append(s("text", { x: 12, y: ey - 6, class: "section-label" }, "설비"));
  const eqRow = (title: string, sub: string, draw: (g: SVGElement, y: number) => void) => {
    const g = s("g", { class: "eq-row" });
    g.append(
      s("rect", { x: 0, y: ey, width: W, height: EQ_H - 2, class: "band eq" }),
      s("text", { x: 12, y: ey + 14, class: "eq-id" }, title),
      s("text", { x: 12, y: ey + 27, class: "ship-sub" }, sub),
      s("rect", { x: LEFT, y: ey + (EQ_H - EQ_BAR) / 2 - 1, width: days * dayW, height: EQ_BAR, class: "lane" }));
    draw(g, ey + (EQ_H - EQ_BAR) / 2 - 1);
    svg.append(g);
    ey += EQ_H;
  };

  // 연구소: 진행 중인 연구 하나씩
  eqRow("연구소", result.research.length ? `대기열 ${result.research.length}개` : "대기열 비어 있음", (g, y) => {
    for (const r of result.research) {
      if (r.start > Math.min(today, days)) continue;
      const end = Math.min(r.end, today, days);
      g.append(bar(x(r.start), y, width(r.start, end), EQ_BAR, RESEARCH_COLOR,
        `${r.name} · ${r.start}~${r.end}일, ${r.effective_from}일부터 효과`, { label: r.name }));
    }
  });

  // 트랜스포터: 나른 날은 실은 배 이름으로, 고장은 중지 색으로. 블록 한 대(4.3, D46)
  for (const tr of result.transporters) {
    eqRow("트랜스포터 · 블록", ended ? `운행 ${tr.moves}일 · 고장 ${tr.breakdowns}건` : "공정 사이 블록", (g, y) => {
      const key = (day: number) => {
        const rec = tr.daily[day - 1];
        if (rec.state === "move") return `move:${rec.ships.join("+")}`;
        if (rec.state === "breakdown_stop") return "stop";
        return null;
      };
      for (const run of runs(tr.daily, key, today)) {
        const w = width(run.start, run.end);
        const span = `${run.start}~${run.end}일`;
        if (run.key === "stop") {
          g.append(bar(x(run.start), y, w, EQ_BAR, STOP_COLOR, `트랜스포터 고장 중지 · ${span}`, { label: "고장", hatch: true }));
        } else {
          const ships = run.key.slice(5);
          g.append(bar(x(run.start), y, w, EQ_BAR, "#6d7a72", `트랜스포터 · ${ships} 블록 운반 · ${span}`, { label: ships }));
        }
      }
    });
  }

  // 공용 지게차(4.3, D46): 한 대에 한 줄. 나른 날은 그날 일감(배 이름, 팔레트는 "판", 키트는 자재 이름)으로.
  const materialName = Object.fromEntries(scenario.materials.map((m) => [m.id, m.name]));
  for (const fk of result.forklifts ?? []) {
    eqRow(`지게차 ${fk.id}`, ended ? `운행 ${fk.moves}일 · 고장 ${fk.breakdowns}건` : "자재 키트 · 부재 팔레트", (g, y) => {
      const jobText = (j: ForkliftJob) => `${j.ship} ${j.kind === "pallet" ? "부재" : materialName[j.material ?? ""] ?? "자재"}`;
      const key = (day: number) => {
        const rec = fk.daily[day - 1];
        if (rec.state === "move") return `move:${rec.jobs.map(jobText).join("+")}`;
        if (rec.state === "breakdown_stop") return "stop";
        return null;
      };
      for (const run of runs(fk.daily, key, today)) {
        const w = width(run.start, run.end);
        const span = `${run.start}~${run.end}일`;
        if (run.key === "stop") {
          g.append(bar(x(run.start), y, w, EQ_BAR, STOP_COLOR, `${fk.id} 고장 중지 · ${span}`, { label: "고장", hatch: true }));
        } else {
          const jobs = run.key.slice(5);
          g.append(bar(x(run.start), y, w, EQ_BAR, "#6d7a72", `${fk.id} · ${jobs.split("+").join(", ")} 운반 · ${span}`,
            { label: jobs.split("+").map((t) => t.split(" ")[0]).join("+") }));
        }
      }
    });
  }

  // 골리앗 크레인: 탑재 작업장의 하루 기록. 증설하면 1호·2호 두 줄.
  const crane = result.stations.find((st) => st.id === CRANE);
  for (const unit of crane?.units ?? []) {
    const title = crane!.units.length > 1 ? `골리앗 크레인 ${unit.unit}호` : "골리앗 크레인";
    eqRow(title, ended ? `${crane!.name} · 고장 ${unit.breakdowns}건` : crane!.name, (g, y) => {
      const key = (day: number) => {
        const rec = unit.daily[day - 1];
        return rec.state === "idle" ? null : `${rec.state}:${rec.ship ?? ""}`;
      };
      for (const run of runs(unit.daily, key, today)) {
        const [state, ship] = run.key.split(":");
        const w = width(run.start, run.end);
        const span = `${run.start}~${run.end}일`;
        if (state === "work" || state === "rework") {
          g.append(bar(x(run.start), y, w, EQ_BAR, STATION_COLOR[CRANE], `${ship} ${state === "rework" ? "재작업" : "탑재"} · ${span}`,
            { label: ship, hatch: state === "rework", onPick: onPick && (() => onPick({ ship, station: CRANE, start: run.start, end: run.end })) }));
        } else {
          const info = STATE_INFO[state];
          if (!info) continue;
          const label = state === "accident_stop" ? "사고" : state === "breakdown_stop" ? "고장" : "";
          g.append(bar(x(run.start), y, w, EQ_BAR, info.color, `${info.name}${ship ? ` (${ship})` : ""} · ${span}`,
            { label, hatch: info.hatch, onPick: onPick && (() => onPick({ ship: ship || null, station: CRANE, start: run.start, end: run.end })) }));
        }
      }
    });
  }

  // 오늘 표시
  if (today >= 1) {
    const cx = x(Math.min(today, days) + 1);
    svg.append(s("g", { class: "cursor" },
      s("line", { x1: cx, x2: cx, y1: TOP - 4, y2: height - 4 }),
      s("rect", { x: cx - 21, y: 1, width: 42, height: 18, rx: 9 }),
      s("text", { x: cx, y: 14.5 }, `${today}일`)));
  }

  return svg;
}

// ---------------------------------------------------------------------------
// 배 한 척: 줄 = 공정. 위 막대는 그 배(작업장 색)와 같은 공정을 쓰던 다른 배(옅은 회색),
// 아래 얇은 줄은 그 배의 손실. 그 아래 줄은 그 배 몫 자재가 들어온 날, 맨 아래는 운반 설비(트랜스포터·지게차).
// ---------------------------------------------------------------------------

const S_ROW_H = 58;
const SUB_H = 18;          // 작업장 하위 줄 높이(나눠 한 공정)
const SUB_BAR = 15;
const OTHER = "#d3dbd6";

/**
 * 배 탭의 작업장 한 줄(4.12.13): 위 막대는 그 작업장을 누가 썼나만. 이 배는 공정 색(재작업은 빗금), 다른 배는 옅은 회색에 배 이름.
 * 사고·고장 난 날도 막대를 끊지 않고 막대 아래에 얇은 띠: 이 배가 쓰던 중이면 늘, 다른 배·빈 작업장이면 이 배가 그 공정을 기다리던 날만.
 * 이 배가 겪은 손실(고장 포함)은 공정 종류와 상관없이 아래 손실 줄에 있다.
 */
function drawOccupancy(g: SVGElement, ship: Ship, st: Scenario["stations"][number], daily: { state: string; ship: string | null }[],
  where: string, y: number, hgt: number, x: (day: number) => number, width: (a: number, b: number) => number, today: number,
  segAt: (day: number) => Segment | undefined, onPick?: OnPick): void {
  const key = (day: number) => {
    const rec = daily[day - 1];
    if (rec.ship === ship.id) return `me:${rec.state === "rework" ? "rework" : "work"}`;
    return rec.ship ? `other:${rec.ship}` : null;
  };
  for (const run of runs(daily, key, today)) {
    const [kind, a] = run.key.split(":");
    const x0 = x(run.start);
    const w = width(run.start, run.end);
    const span = `${run.start}~${run.end}일`;
    if (kind === "other") {
      g.append(barEl(x0, y, w, hgt, OTHER, `${where}을 ${a}가 쓰는 중 · ${span}`, { label: a, textColor: "#4b5a51" }));
    } else {
      const seg = segAt(run.start);
      const pick = onPick && seg && (() => onPick({ ship: ship.id, station: st.id, start: seg.start, end: seg.end }));
      g.append(barEl(x0, y, w, hgt, STATION_COLOR[st.id], `${ship.id} · ${where}${a === "rework" ? " 재작업" : ""} · ${span}`,
        { label: a === "rework" ? "재작업" : ship.id, textColor: STATION_TEXT[st.id], hatch: a === "rework", onPick: pick }));
    }
  }
  const stripH = hgt > SUB_BAR ? 8 : 5;
  const stop = (day: number) => {
    const rec = daily[day - 1];
    if (rec.state !== "accident_stop" && rec.state !== "breakdown_stop") return null;
    if (rec.ship !== ship.id && !waitedOn(ship, day, "station_wait", st.id)) return null;
    return `${rec.state}:${rec.ship ?? ""}`;
  };
  for (const run of runs(daily, stop, today)) {
    const [state, who] = run.key.split(":");
    const info = STATE_INFO[state];
    g.append(barEl(x(run.start), y + hgt - stripH, width(run.start, run.end), stripH, info.color,
      `${where} ${info.name}${who ? ` (${who === ship.id ? "이 배" : who} 작업 중)` : ""} · ${run.start}~${run.end}일`, { hatch: info.hatch }));
  }
}

/**
 * 작업장이 2곳 이상인 공정의 작업장 하위 줄(배 탭, 4.12.5 나눠 한 공정 → 4.12.11 증설한 공정 모두). 줄마다 엔진의 작업장 기록 그대로: 이 배는 공정 색, 다른 배는 옅은 회색,
 * 줄마다 그리는 규칙은 drawOccupancy(4.12.13). 먼저 끝난 부분은 작업장을 비우고 적치장에서 기다리므로(그 작업장은 다른 배가 쓸 수 있다)
 * 짝 대기는 작업장 줄이 아니라 아래 얇은 줄에 이 배의 손실과 함께 그린다.
 */
function drawUnitRows(g: SVGElement, ship: Ship, st: Scenario["stations"][number], units: { unit: number; daily: { state: string; ship: string | null }[] }[],
  hgt: number, row: number, y: number, x: (day: number) => number, width: (a: number, b: number) => number,
  laneW: number, today: number, carried: Set<number>, onPick?: OnPick): void {
  g.append(
    s("rect", { x: 0, y: y - 8, width: W, height: hgt - 4, class: row % 2 ? "band odd" : "band" }),
    s("rect", { x: 12, y: y + 4, width: 10, height: 10, rx: 3, fill: STATION_COLOR[st.id] }),
    s("text", { x: 28, y: y + 14, class: "eq-id" }, st.name),
    s("text", { x: 12, y: y + 32, class: "ship-sub" },
      ship.daily.some((rec) => rec.station === st.id && rec.parts) ? "나눠 하기" : `작업장 ${units.length}곳`));
  const segAt = (day: number) => ship.segments.find((sg) => sg.station === st.id && sg.start <= day && day <= sg.end);
  units.forEach((u, j) => {
    const uy = y + j * SUB_H;
    g.append(
      s("text", { x: LEFT - 6, y: uy + SUB_BAR - 3, class: "unit-id" }, `${u.unit}호`),
      s("rect", { x: LEFT, y: uy, width: laneW, height: SUB_BAR, class: "lane" }));
    drawOccupancy(g, ship, st, u.daily, `${st.name} ${u.unit}호`, uy, SUB_BAR, x, width, today, segAt, onPick);
  });
  // 아래 얇은 줄: 이 배의 손실(운반 대기 등)과 짝 대기. 운반은 위 첫 줄에 점선 틀.
  const ly = y + units.length * SUB_H + LOSS_GAP;
  for (const seg of ship.segments.filter((sg) => sg.station === st.id && sg.start <= today)) {
    const x0 = x(seg.start);
    const w = width(seg.start, Math.min(seg.end, today));
    const span = `${seg.start}~${seg.end}일 (${seg.end - seg.start + 1}일)`;
    if (seg.state === "transport") {
      if (byEquipment(seg, carried)) continue;   // 트랜스포터가 나른 날은 아래 운반 설비 줄에
      g.append(s("g", null,
        s("title", null, `${ship.id} · ${st.name} → 다음 공정 운반 · ${span}`),
        s("rect", { x: x0 + 1.5, y: y + 2, width: Math.max(1, w - 3), height: SUB_BAR - 4, rx: 3, class: "transport" })));
    } else if (seg.state !== "work" && seg.state !== "rework" && STATE_INFO[seg.state]) {
      const info = STATE_INFO[seg.state];
      g.append(barEl(x0, ly, w, LOSS_H, info.color, `${ship.id} · ${info.name} (${st.name}) · ${span}`, { hatch: info.hatch }));
    }
  }
  // 나눠 하기에서 한 작업장만 겪은 손실(배는 작업 중): 전체 탭처럼 얇게
  const partLoss = (day: number) => {
    const rec = ship.daily[day - 1];
    if (rec.station !== st.id || rec.state !== "work") return null;
    const pt = rec.parts?.find((p) => p.state !== "work" && p.state !== "rework" && p.state !== "pair_wait" && STATE_INFO[p.state]);
    return pt ? `${pt.state}:${pt.unit}` : null;
  };
  for (const run of runs(ship.daily, partLoss, today)) {
    const [state, unit] = run.key.split(":");
    const info = STATE_INFO[state];
    g.append(barEl(x(run.start), ly + 3, width(run.start, run.end), LOSS_H - 6, info.color,
      `${ship.id} · ${st.name} ${unit}호 작업장만 ${info.name} · ${run.start}~${run.end}일 (나머지 부분은 작업)`, { hatch: info.hatch }));
  }
  const pairKey = (day: number) => {
    const rec = ship.daily[day - 1];
    const pt = rec.station === st.id ? rec.parts?.find((p) => p.state === "pair_wait") : undefined;
    return pt ? `${pt.unit}` : null;
  };
  for (const run of runs(ship.daily, pairKey, today)) {
    g.append(pairBox(x(run.start), ly, width(run.start, run.end), LOSS_H,
      `${ship.id} · ${st.name} ${run.key}호 몫 짝 대기 · ${run.start}~${run.end}일 (먼저 끝나 적치장에서 나머지를 기다림)`));
  }
}

/**
 * 배 탭의 운반 설비(4.12.10): 트랜스포터(공정 사이 블록)와 지게차(자재 키트·부재 팔레트) 한 대에 한 줄.
 * 이 배를 나른 날은 진한 막대(어디서 어디로는 마우스를 올리면), 다른 배는 옅은 회색, 이 배를 기다리게 한 고장은 아래 얇은 띠.
 */
function drawShipEquipment(svg: SVGElement, result: Result, scenario: Scenario, ship: Ship, top: number,
  x: (day: number) => number, width: (a: number, b: number) => number, laneW: number, today: number): void {
  svg.append(s("text", { x: 12, y: top - 6, class: "section-label" }, "운반 설비"));
  const stationName = Object.fromEntries(scenario.stations.map((st) => [st.id, st.name]));
  const materialName = Object.fromEntries(scenario.materials.map((m) => [m.id, m.name]));
  // 트랜스포터가 나른 날의 출발 공정: 그날까지 시작한 이 배의 마지막 운반 구간. 운행은 싣는 날과 내려놓는 날 이틀이고,
  // 내려놓는 날 배는 벌써 다음 공정에서 일한다(엔진 기록).
  const fromOf = (day: number) => ship.segments.filter((sg) => sg.state === "transport" && sg.start <= day).at(-1)?.station;
  let ey = top;
  const row = (title: string, sub: string, daily: { state: string }[],
    mine: (day: number) => string | null, others: (day: number) => string | null, what: string, waits: "transport_wait" | "material_wait") => {
    const g = s("g", { class: "eq-row" });
    const y = ey + (EQ_H - EQ_BAR) / 2 - 1;
    g.append(
      s("rect", { x: 0, y: ey, width: W, height: EQ_H - 2, class: "band eq" }),
      s("text", { x: 12, y: ey + 14, class: "eq-id" }, title),
      s("text", { x: 12, y: ey + 27, class: "ship-sub" }, sub),
      s("rect", { x: LEFT, y, width: laneW, height: EQ_BAR, class: "lane" }));
    for (const run of runs(daily, (d) => mine(d) ? `me:${mine(d)}` : others(d) ? `other:${others(d)}` : null, today)) {
      const [kind, text] = [run.key.slice(0, run.key.indexOf(":")), run.key.slice(run.key.indexOf(":") + 1)];
      const span = `${run.start}~${run.end}일`;
      if (kind === "me") g.append(barEl(x(run.start), y, width(run.start, run.end), EQ_BAR, "#33413a", `${title} · ${ship.id} ${text} · ${span}`, { label: ship.id }));
      else g.append(barEl(x(run.start), y, width(run.start, run.end), EQ_BAR, OTHER, `${title} · ${text} ${what} · ${span}`, { label: text.split("+").map((t) => t.split(" ")[0]).join("+"), textColor: "#4b5a51" }));
    }
    // 고장은 이 배가 그 설비를 기다리던 날만(트랜스포터는 운반 대기, 지게차는 자재 대기, 4.12.12)
    for (const run of runs(daily, (d) => daily[d - 1].state === "breakdown_stop" && waitedOn(ship, d, waits) ? "stop" : null, today)) {
      g.append(barEl(x(run.start), y + EQ_BAR - 5, width(run.start, run.end), 5, STOP_COLOR, `${title} 고장 중지 · ${run.start}~${run.end}일`, { hatch: true }));
    }
    svg.append(g);
    ey += EQ_H;
  };
  result.transporters.forEach((tr, i) => {
    row(result.transporters.length > 1 ? `트랜스포터 ${i + 1}호` : "트랜스포터", "공정 사이 블록", tr.daily,
      (d) => tr.daily[d - 1].ships.includes(ship.id) ? `블록 운반 (${stationName[fromOf(d) ?? ""] ?? "공정"} → 다음 공정)` : null,
      (d) => tr.daily[d - 1].state === "move" ? tr.daily[d - 1].ships.join("+") : null, "블록 운반", "transport_wait");
  });
  const jobText = (j: ForkliftJob) => j.kind === "pallet"
    ? `부재 팔레트 (${stationName[j.from ?? ""] ?? "가공"} → ${stationName[j.station]})`
    : `${materialName[j.material ?? ""] ?? "자재"} 키트 → ${stationName[j.station]}`;
  for (const fk of result.forklifts ?? []) {
    row(`지게차 ${fk.id}`, "자재 키트 · 부재 팔레트", fk.daily,
      (d) => { const jobs = fk.daily[d - 1].jobs.filter((j) => j.ship === ship.id); return jobs.length ? jobs.map(jobText).join(", ") : null; },
      (d) => { const jobs = fk.daily[d - 1].jobs.filter((j) => j.ship !== ship.id); return jobs.length ? [...new Set(jobs.map((j) => j.ship))].join("+") : null; }, "운반", "material_wait");
  }
}

export function renderShipGantt(result: Result, scenario: Scenario, shipId: string, today: number, onPick?: OnPick, size?: { width: number; height: number }, plan?: Plan): SVGElement {
  useSize(size);
  const days = result.days;
  const ship = result.ships.find((sh) => sh.id === shipId)!;
  const dayW = (W - LEFT - RIGHT) / days;
  const x = (day: number) => LEFT + (day - 1) * dayW;
  const width = (start: number, end: number) => (end - start + 1) * dayW;
  const stations = activeStations(scenario);
  // 작업장이 2곳 이상인 공정은 나눠 했든 안 했든 작업장마다 하위 줄로 펼친다(4.12.5, 4.12.11). 다른 배가 겹쳐 보이지 않고,
  // 줄 수는 작업장 수라 블록이 더 나뉘어도 늘지 않는다.
  const unitsOf = (sid: string) => result.stations.find((rs) => rs.id === sid)!.units;
  const expanded = (sid: string) => unitsOf(sid).length > 1;
  const rowH = (sid: string) => expanded(sid) ? Math.max(S_ROW_H, unitsOf(sid).length * SUB_H + LOSS_GAP + LOSS_H + 16) : S_ROW_H;
  const rowY: number[] = [];
  let acc = TOP;
  for (const st of stations) { rowY.push(acc); acc += rowH(st.id); }
  const matRowY = acc + 6;
  // 운반 설비(4.12.10): 트랜스포터·지게차 한 대에 한 줄. 이 배를 나른 날은 진하게, 다른 배는 옅게.
  const eqTop = matRowY + 40 + SECTION_GAP;
  const eqCount = result.transporters.length + (result.forklifts?.length ?? 0);
  const height = eqCount ? eqTop + eqCount * EQ_H + 8 : matRowY + 40;
  // 트랜스포터가 이 배를 나른 날: 공정 줄의 운반 점선 틀 대신 운반 설비 줄에 그린다
  const carried = new Set<number>();
  for (const tr of result.transporters) tr.daily.forEach((rec, i) => { if (rec.ships.includes(ship.id)) carried.add(i + 1); });
  const clip = (end: number) => Math.min(end, today);

  const svg = s("svg", {
    class: "gantt", viewBox: `0 0 ${W} ${height}`, role: "img",
    "aria-label": `${ship.id}의 공정별 진행, ${today}일째`,
  });
  svg.append(s("defs", null,
    s("pattern", { id: "hatch", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
      s("rect", { width: 2.4, height: 6, fill: "#ffffff", opacity: 0.6 }))));

  const axis = s("g", { class: "axis" });
  for (let d = 1; d <= days; d++) {
    if (d === 1 || d % (days > 60 ? 10 : 5) === 0) {
      axis.append(
        s("line", { x1: x(d), x2: x(d), y1: TOP - 6, y2: height - 4, class: d % 10 === 0 ? "grid major" : "grid" }),
        s("text", { x: x(d) + dayW / 2, y: TOP - 14, class: "tick" }, d));
    }
  }
  axis.append(s("line", { x1: x(days + 1), x2: x(days + 1), y1: TOP - 6, y2: height - 4, class: "grid major" }));
  svg.append(axis);

  stations.forEach((st, row) => {
    const y = rowY[row] + 8;
    const g = s("g", { class: "ship-row" });
    const sp = plan?.ships[ship.id]?.[st.id];
    const line = sp ? planLine(ship.id, st, sp, days, y, x, width) : null;
    if (expanded(st.id)) {
      drawUnitRows(g, ship, st, unitsOf(st.id), rowH(st.id), row, y, x, width, days * dayW, today, carried, onPick);
      if (line) g.append(line);
      svg.append(g);
      return;
    }
    g.append(
      s("rect", { x: 0, y: y - 8, width: W, height: S_ROW_H - 4, class: row % 2 ? "band odd" : "band" }),
      s("rect", { x: 12, y: y + 4, width: 10, height: 10, rx: 3, fill: STATION_COLOR[st.id] }),
      s("text", { x: 28, y: y + 14, class: "eq-id" }, st.name),
      s("text", { x: 12, y: y + 32, class: "ship-sub" }, st.real.split(":")[0]),
      s("rect", { x: LEFT, y, width: days * dayW, height: BAR_H, class: "lane" }));

    // 위 막대: 이 작업장을 누가 썼나(이 배는 공정 색, 다른 배는 옅은 회색). 중지는 막대 아래 얇은 띠(4.12.13).
    const units = result.stations.find((rs) => rs.id === st.id)!.units;
    const segAt = (day: number) => ship.segments.find((sg) => sg.station === st.id && sg.start <= day && day <= sg.end);
    drawOccupancy(g, ship, st, units[0].daily, st.name, y, BAR_H, x, width, today, segAt, onPick);
    if (line) g.append(line);

    // 이 배의 운반과 손실(아래 얇은 줄). 이 배가 겪은 사고·고장도 여기(4.12.13)
    for (const seg of ship.segments.filter((sg) => sg.station === st.id && sg.start <= today)) {
      const x0 = x(seg.start);
      const w = width(seg.start, clip(seg.end));
      const span = `${seg.start}~${seg.end}일 (${seg.end - seg.start + 1}일)`;
      const pick = onPick && (() => onPick({ ship: ship.id, station: st.id, start: seg.start, end: seg.end }));
      if (seg.state === "work" || seg.state === "rework") {
        continue;   // 위 막대는 drawOccupancy가 작업장 기록으로 그렸다
      } else if (seg.state === "transport") {
        if (byEquipment(seg, carried)) continue;   // 트랜스포터가 나른 날은 아래 운반 설비 줄에
        g.append(s("g", null,
          s("title", null, `${ship.id} · ${st.name} → 다음 공정 운반 · ${span}`),
          s("rect", { x: x0 + 1.5, y: y + 4, width: Math.max(1, w - 3), height: BAR_H - 8, rx: 3, class: "transport" })));
      } else if (STATE_INFO[seg.state]) {
        const info = STATE_INFO[seg.state];
        g.append(barEl(x0, y + BAR_H + LOSS_GAP, w, LOSS_H, info.color, `${ship.id} · ${info.name} (${st.name}) · ${span}`,
          { hatch: info.hatch, onPick: pick }));
      }
    }
    svg.append(g);
  });

  // 납기와 인도
  const dueX = x(ship.due_day + 1);
  svg.append(
    s("line", { x1: dueX, x2: dueX, y1: TOP - 4, y2: matRowY - 4, class: "due" }),
    s("text", { x: dueX, y: TOP - 2, class: "due-label" }, `납기 ${ship.due_day}일`));
  if (ship.delivered_day !== null && ship.delivered_day <= today) {
    const dx = x(ship.delivered_day + 1);
    const midY = rowY[stations.length - 1] + 8 + BAR_H / 2;
    const late = ship.late_days > 0;
    svg.append(
      s("path", { d: `M${dx} ${midY - 8} L${dx + 8} ${midY} L${dx} ${midY + 8} L${dx - 8} ${midY} Z`, class: late ? "deliver late" : "deliver" },
        s("title", null, `${ship.id} 인도 ${ship.delivered_day}일${late ? `, ${ship.late_days}일 지연` : ", 납기 준수"}`)),
      s("text", { x: x(days + 1) + 8, y: midY + 4, class: late ? "outcome late" : "outcome ok" }, late ? `${ship.late_days}일 지연` : "납기 준수"));
  }

  // 이 배 몫 자재 입고
  const mat = s("g", { class: "ship-row" });
  mat.append(
    s("rect", { x: 0, y: matRowY - 2, width: W, height: 34, class: "band eq" }),
    s("text", { x: 12, y: matRowY + 18, class: "eq-id" }, "자재 입고"));
  const name = Object.fromEntries(scenario.materials.map((m) => [m.id, m.name]));
  for (const ev of result.events) {
    if (ev.type !== "arrival" || ev.ship !== ship.id || ev.day > today) continue;
    const cx = x(ev.day) + dayW / 2;
    mat.append(s("g", null,
      s("title", null, `${ev.day}일 ${name[ev.material]} ${ev.quantity}개 입고 (${ship.id}용)`),
      s("path", { d: `M${cx - 6} ${matRowY + 4} L${cx + 6} ${matRowY + 4} L${cx} ${matRowY + 13} Z`, class: "arrival" }),
      s("text", { x: cx, y: matRowY + 27, class: "arrival-label" }, name[ev.material])));
  }
  svg.append(mat);
  if (eqCount) drawShipEquipment(svg, result, scenario, ship, eqTop, x, width, days * dayW, today);

  if (today >= 1) {
    const cx = x(Math.min(today, days) + 1);
    svg.append(s("g", { class: "cursor" },
      s("line", { x1: cx, x2: cx, y1: TOP - 4, y2: height - 4 }),
      s("rect", { x: cx - 21, y: 1, width: 42, height: 18, rx: 9 }),
      s("text", { x: cx, y: 14.5 }, `${today}일`)));
  }
  return svg;
}

// ---------------------------------------------------------------------------
// 공정 탭(4.25, D71): 전체 > 선박 > 공정. 한 척 × 한 블록 공정(소조립·중조립·PE장)을 펼친다.
// 위: 작업장마다 한 줄. 이 배의 블록이 그 작업장에서 일한 날을 블록 이름 막대로, 다른 배가 쓴 날은 옅은 회색.
// 아래: 이 배의 블록마다 한 줄. 일한 날은 진한 막대(재작업 빗금), 기다린 날은 얇은 색 띠(작업장·자재·운반 대기, 운반, 짝 대기),
//       블록 납기는 눈금, 공정 납기는 세로선. 엔진이 준 blocks[].daily와 작업장 daily를 자르고 묶기만 한다(today까지).
// ---------------------------------------------------------------------------

const B_ROW = 15;      // 블록 줄
const U_ROW = 26;      // 작업장 줄
const B_BAR = 9;
const WAIT_STATES = ["station_wait", "material_wait", "labor_wait", "transport_wait", "transport", "pair_wait", "accident_stop", "breakdown_stop"];

export function renderStationGantt(result: Result, scenario: Scenario, shipId: string, stationId: string, today: number,
  size?: { width: number; height: number }): SVGElement {
  useSize(size);
  const days = result.days;
  const ship = result.ships.find((sh) => sh.id === shipId)!;
  const st = scenario.stations.find((x) => x.id === stationId)!;
  const units = result.stations.find((rs) => rs.id === stationId)!.units;
  const blocks = (result.blocks ?? []).filter((b) => b.ship === shipId && b.station === stationId);
  const color = STATION_COLOR[stationId];
  // 이 공정 기간만 확대한다(블록이 처음 보인 날 앞뒤로 여유)
  const alive = (b: typeof blocks[number]) => b.daily.map((r, i) => (r.state !== "not_started" && r.state !== "done" ? i + 1 : 0)).filter(Boolean);
  const daysSeen = blocks.flatMap(alive);
  const due = ship.station_dues?.[stationId]?.due;
  const first = Math.max(1, (daysSeen.length ? Math.min(...daysSeen) : 1) - 2);
  const last = Math.min(days, Math.max(daysSeen.length ? Math.max(...daysSeen) : days, ...blocks.map((b) => b.due), due ?? 0) + 2);
  const span = last - first + 1;
  const dayW = (W - LEFT - RIGHT) / span;
  const x = (day: number) => LEFT + (day - first) * dayW;
  const width = (a: number, b: number) => (b - a + 1) * dayW;
  const clip = (d: number) => Math.min(d, today);
  const uTop = TOP;
  const bTop = uTop + units.length * U_ROW + SECTION_GAP;
  const height = bTop + blocks.length * B_ROW + 12;

  const svg = s("svg", { class: "gantt station-gantt", viewBox: `0 0 ${W} ${height}`, role: "img",
    "aria-label": `${shipId} ${st.name}: 작업장별 블록과 블록별 진행, ${today}일째` });
  svg.append(s("defs", null,
    s("pattern", { id: "hatch", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
      s("rect", { width: 2.4, height: 6, fill: "#ffffff", opacity: 0.6 }))));
  const axis = s("g", { class: "axis" });
  for (let d = first; d <= last; d++) {
    if (span <= 40 || d % 5 === 0) {
      axis.append(s("line", { x1: x(d), x2: x(d), y1: TOP - 6, y2: height - 4, class: d % 5 === 0 ? "grid major" : "grid" }),
        s("text", { x: x(d) + dayW / 2, y: TOP - 14, class: "tick" }, d));
    }
  }
  svg.append(axis);

  // 작업장 줄
  units.forEach((u, k) => {
    const y = uTop + k * U_ROW;
    const g = s("g", { class: "ship-row" });
    g.append(s("rect", { x: 0, y, width: W, height: U_ROW - 2, class: k % 2 ? "band odd" : "band" }),
      s("text", { x: 12, y: y + 16, class: "eq-id" }, `${u.unit}호 작업장`),
      s("rect", { x: LEFT, y: y + 4, width: span * dayW, height: U_ROW - 10, class: "lane" }));
    for (let d = first; d <= Math.min(last, today); d++) {
      const rec = u.daily[d - 1];
      if (!rec || !rec.ship) continue;
      const working = rec.state === "work" || rec.state === "rework";
      if (rec.ship !== shipId) {
        if (working) g.append(barEl(x(d), y + 6, dayW, U_ROW - 14, "#d8dcd6", `${d}일 ${rec.ship}가 사용`));
        continue;
      }
      const ids = (rec.blocks ?? []).filter((id) => blocks.some((b) => b.id === id));
      if (!working) {
        const info = STATE_INFO[rec.state];
        if (info) g.append(barEl(x(d), y + U_ROW - 8, dayW, 3, info.color, `${d}일 ${info.name}`));
        continue;
      }
      const label = ids.map((id) => { const b = blocks.find((x) => x.id === id)!; return blockLabel(stationId, b.no); }).join("·");
      g.append(barEl(x(d), y + 6, dayW, U_ROW - 14, color, `${d}일 ${shipId} ${label}${rec.state === "rework" ? " (재작업)" : ""}`,
        { label: dayW > 18 ? label : undefined, textColor: STATION_TEXT[stationId], hatch: rec.state === "rework" }));
    }
    svg.append(g);
  });

  // 블록 줄
  svg.append(s("text", { x: 12, y: bTop - 6, class: "ship-sub" }, `${shipId}의 ${st.name} 블록 ${blocks.length}개`));
  blocks.forEach((b, k) => {
    const y = bTop + k * B_ROW;
    const g = s("g", { class: "ship-row" });
    g.append(s("text", { x: 24, y: y + B_ROW - 4, class: "ship-sub" }, `${blockLabel(stationId, b.no)}${b.unit ? ` · ${b.unit}호` : ""}`));
    const segs = runs(b.daily, (day) => {
      const r = b.daily[day - 1];
      return day < first || day > last || !r || r.state === "not_started" || r.state === "done" ? null : r.state;
    }, today);
    for (const seg of segs) {
      const x0 = x(seg.start);
      const w = width(seg.start, clip(seg.end));
      const spanText = `${seg.start}~${seg.end}일`;
      if (seg.key === "work" || seg.key === "rework") {
        g.append(barEl(x0, y + (B_ROW - B_BAR) / 2, w, B_BAR, color, `${b.id} ${seg.key === "rework" ? "재작업" : "작업"} ${spanText}`,
          { hatch: seg.key === "rework" }));
      } else if (WAIT_STATES.includes(seg.key)) {
        const info = seg.key === "pair_wait" ? PAIR_WAIT_STATE : STATE_INFO[seg.key];
        if (info) g.append(barEl(x0, y + B_ROW / 2 - 1.5, w, 3, info.color, `${b.id} ${info.name} ${spanText}`));
      }
    }
    if (b.due >= first && b.due <= last) {
      g.append(s("line", { x1: x(b.due + 1), x2: x(b.due + 1), y1: y + 1, y2: y + B_ROW - 1, class: "due block-due" },
        s("title", null, `${b.id} 블록 납기 ${b.due}일`)));
    }
    if (b.done_day !== null && b.done_day <= today && b.done_day > b.due) {
      g.append(s("text", { x: Math.min(x(b.done_day + 1) + 3, W - RIGHT), y: y + B_ROW - 4, class: "plan-late" }, `+${b.done_day - b.due}`));
    }
    svg.append(g);
  });

  if (due !== undefined && due >= first && due <= last) {
    svg.append(s("line", { x1: x(due + 1), x2: x(due + 1), y1: TOP - 4, y2: height - 4, class: "due" }),
      s("text", { x: x(due + 1), y: TOP - 2, class: "due-label" }, `공정 납기 ${due}일`));
  }
  if (today >= first && today <= last) {
    const cx = x(today + 1);
    svg.append(s("g", { class: "cursor" },
      s("line", { x1: cx, x2: cx, y1: TOP - 4, y2: height - 4 }),
      s("rect", { x: cx - 21, y: 1, width: 42, height: 18, rx: 9 }),
      s("text", { x: cx, y: 14.5 }, `${today}일`)));
  }
  return svg;
}
