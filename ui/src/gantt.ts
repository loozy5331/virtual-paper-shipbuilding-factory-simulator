// 간트 차트. 가로축은 1~60일.
// 위쪽은 배 4척: 배마다 두 줄, 위는 작업장을 차지한 구간(작업장 색, 재작업은 빗금, 운반은 점선 틀), 아래 얇은 줄은 손실 구간.
// 아래쪽은 설비: 연구소, 트랜스포터(대별), 골리앗 크레인(탑재 작업장).
// 재생 중에는 today까지만 그린다. 엔진이 준 segments와 daily를 자르고 묶기만 하고 새로 계산하지 않는다.

import type { Result, Scenario, Segment } from "./api";
import { s } from "./dom";
import { STATE_INFO, STATION_COLOR, STATION_TEXT } from "./labels";

const W = 1000;
const LEFT = 116;
const RIGHT = 70;
const TOP = 44;
const ROW_H = 66;
const BAR_H = 26;
const LOSS_GAP = 4;
const LOSS_H = 12;
const EQ_H = 34;          // 설비 줄 높이
const EQ_BAR = 18;
const SECTION_GAP = 22;
const CRANE = "erection";
const STOP_COLOR = STATE_INFO.accident_stop.color;
const RESEARCH_COLOR = "#1d5c45";

interface Run<T> { key: T; start: number; end: number }

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

export function renderGantt(result: Result, scenario: Scenario, today: number): SVGElement {
  const days = result.days;
  const dayW = (W - LEFT - RIGHT) / days;
  const x = (day: number) => LEFT + (day - 1) * dayW;      // day의 왼쪽 끝
  const width = (start: number, end: number) => (end - start + 1) * dayW;
  const stationName = Object.fromEntries(scenario.stations.map((st) => [st.id, st.name]));
  const shipsBottom = TOP + result.ships.length * ROW_H;
  const eqRows = 1 + result.transporters.length + 1;
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
    if (d === 1 || d % 5 === 0) {
      axis.append(
        s("line", { x1: x(d), x2: x(d), y1: TOP - 6, y2: height - 4, class: d % 10 === 0 ? "grid major" : "grid" }),
        s("text", { x: x(d) + dayW / 2, y: TOP - 14, class: "tick" }, d));
    }
  }
  axis.append(s("line", { x1: x(days + 1), x2: x(days + 1), y1: TOP - 6, y2: height - 4, class: "grid major" }));
  svg.append(axis);

  /** 막대 하나. 넓으면 안에 라벨을 쓰고, 빗금이 필요하면 덧씌운다. 제목은 마우스를 올리면 나온다. */
  const bar = (x0: number, y: number, w: number, hgt: number, fill: string, title: string,
    opts: { label?: string; textColor?: string; hatch?: boolean; className?: string } = {}) => {
    const g = s("g", null,
      s("title", null, title),
      s("rect", { x: x0 + 0.5, y, width: Math.max(1, w - 1), height: hgt, rx: 3, fill, class: opts.className ?? "" }));
    if (opts.hatch) g.append(s("rect", { x: x0 + 0.5, y, width: Math.max(1, w - 1), height: hgt, rx: 3, fill: "url(#hatch)" }));
    if (opts.label && w >= opts.label.length * 7 + 10) {
      g.append(s("text", { x: x0 + w / 2, y: y + hgt / 2 + 4, class: "bar-label small", fill: opts.textColor ?? "#fff" }, opts.label));
    }
    return g;
  };

  // ----- 배 -----
  result.ships.forEach((ship, row) => {
    const y = TOP + row * ROW_H + 10;
    const g = s("g", { class: "ship-row" });
    g.append(
      s("rect", { x: 0, y: y - 8, width: W, height: ROW_H - 4, class: row % 2 ? "band odd" : "band" }),
      s("text", { x: 12, y: y + 12, class: "ship-id" }, ship.id),
      s("text", { x: 12, y: y + 30, class: "ship-sub" }, `${ship.type_name} · 납기 ${ship.due_day}일`),
      s("rect", { x: LEFT, y, width: days * dayW, height: BAR_H, class: "lane" }),
    );

    const visible = (seg: Segment) => seg.start <= today;
    const clipEnd = (seg: Segment) => Math.min(seg.end, today);

    for (const seg of ship.segments.filter(visible)) {
      const x0 = x(seg.start);
      const w = width(seg.start, clipEnd(seg));
      const name = stationName[seg.station];
      const span = `${seg.start}~${seg.end}일 (${seg.end - seg.start + 1}일)`;
      if (seg.state === "work" || seg.state === "rework") {
        // 위 줄: 작업장을 차지한 구간
        const label = seg.state === "rework" ? `${name} 재작업` : name;
        g.append(bar(x0, y, w, BAR_H, STATION_COLOR[seg.station], `${ship.id} · ${label} · ${span}`,
          { label: seg.state === "work" ? name : "재작업", textColor: STATION_TEXT[seg.station], hatch: seg.state === "rework" }));
      } else if (seg.state === "transport") {
        // 운반은 손실이 아니다. 위 줄에 점선 틀로만 그린다.
        g.append(s("g", null,
          s("title", null, `${ship.id} · ${name} → 다음 공정 운반 · ${span}`),
          s("rect", { x: x0 + 1.5, y: y + 4, width: Math.max(1, w - 3), height: BAR_H - 8, rx: 3, class: "transport" })));
      } else if (STATE_INFO[seg.state]) {
        // 아래 얇은 줄: 손실 구간. 같은 색끼리는 빗금과 라벨로 구분한다.
        const info = STATE_INFO[seg.state];
        g.append(bar(x0, y + BAR_H + LOSS_GAP, w, LOSS_H, info.color, `${ship.id} · ${info.name} (${name}) · ${span}`,
          { hatch: info.hatch }));
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
      s("text", { x: 12, y: ey + 15, class: "eq-id" }, title),
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

  // 트랜스포터: 나른 날은 실은 배 이름으로, 고장은 중지 색으로
  for (const tr of result.transporters) {
    eqRow(`트랜스포터 ${tr.id}`, ended ? `운행 ${tr.moves}일 · 고장 ${tr.breakdowns}건` : "공정 사이 운반", (g, y) => {
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
          g.append(bar(x(run.start), y, w, EQ_BAR, STOP_COLOR, `${tr.id} 고장 중지 · ${span}`, { label: "고장", hatch: true }));
        } else {
          const ships = run.key.slice(5);
          g.append(bar(x(run.start), y, w, EQ_BAR, "#6d7a72", `${tr.id} · ${ships} 운반 · ${span}`, { label: ships }));
        }
      }
    });
  }

  // 골리앗 크레인: 탑재 작업장의 하루 기록
  const crane = result.stations.find((st) => st.id === CRANE);
  if (crane) {
    eqRow("골리앗 크레인", ended ? `${crane.name} · 고장 ${crane.breakdowns}건` : crane.name, (g, y) => {
      const key = (day: number) => {
        const rec = crane.daily[day - 1];
        return rec.state === "idle" ? null : `${rec.state}:${rec.ship ?? ""}`;
      };
      for (const run of runs(crane.daily, key, today)) {
        const [state, ship] = run.key.split(":");
        const w = width(run.start, run.end);
        const span = `${run.start}~${run.end}일`;
        if (state === "work" || state === "rework") {
          g.append(bar(x(run.start), y, w, EQ_BAR, STATION_COLOR[CRANE], `${ship} ${state === "rework" ? "재작업" : "탑재"} · ${span}`,
            { label: ship, hatch: state === "rework" }));
        } else {
          const info = STATE_INFO[state];
          if (!info) continue;
          const label = state === "accident_stop" ? "사고" : state === "breakdown_stop" ? "고장" : "";
          g.append(bar(x(run.start), y, w, EQ_BAR, info.color, `${info.name}${ship ? ` (${ship})` : ""} · ${span}`,
            { label, hatch: info.hatch }));
        }
      }
    });
  }

  // 오늘 표시
  if (today >= 1) {
    const cx = x(Math.min(today, days) + 1);
    svg.append(s("g", { class: "cursor" },
      s("line", { x1: cx, x2: cx, y1: TOP - 4, y2: height - 4 }),
      s("rect", { x: cx - 18, y: 2, width: 36, height: 16, rx: 8 }),
      s("text", { x: cx, y: 14 }, `${today}일`)));
  }

  return svg;
}
