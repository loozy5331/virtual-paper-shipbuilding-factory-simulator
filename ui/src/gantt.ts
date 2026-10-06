// 간트 차트. 행은 배, 가로축은 1~60일.
// 배마다 두 줄: 위는 작업장을 차지한 구간(작업장 색, 재작업은 빗금), 아래 얇은 줄은 손실 구간.
// 재생 중에는 today까지만 그린다. 엔진이 준 segments를 자르기만 하고 새로 계산하지 않는다.

import type { Result, Scenario, Segment } from "./api";
import { s } from "./dom";
import { LOSS_STATES, STATION_COLOR, STATION_TEXT } from "./labels";

const W = 1000;
const LEFT = 116;
const RIGHT = 70;
const TOP = 44;
const ROW_H = 66;
const BAR_H = 26;
const LOSS_GAP = 4;
const LOSS_H = 10;

const LOSS_COLOR = Object.fromEntries(LOSS_STATES.map((l) => [l.state, l.color]));
const LOSS_NAME = Object.fromEntries(LOSS_STATES.map((l) => [l.state, l.name]));

export function renderGantt(result: Result, scenario: Scenario, today: number): SVGElement {
  const days = result.days;
  const dayW = (W - LEFT - RIGHT) / days;
  const x = (day: number) => LEFT + (day - 1) * dayW;      // day의 왼쪽 끝
  const height = TOP + result.ships.length * ROW_H + 6;
  const stationName = Object.fromEntries(scenario.stations.map((st) => [st.id, st.name]));

  const svg = s("svg", {
    class: "gantt", viewBox: `0 0 ${W} ${height}`, role: "img",
    "aria-label": `배 ${result.ships.length}척의 공정 진행, ${today}일째`,
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

    // 위 줄: 작업장을 차지한 구간
    for (const seg of ship.segments.filter((sg) => visible(sg) && (sg.state === "work" || sg.state === "rework"))) {
      const x0 = x(seg.start);
      const w = (clipEnd(seg) - seg.start + 1) * dayW;
      const name = stationName[seg.station];
      const label = seg.state === "rework" ? `${name} 재작업` : name;
      const bar = s("g", null,
        s("title", null, `${ship.id} · ${label} · ${seg.start}~${seg.end}일 (${seg.end - seg.start + 1}일)`),
        s("rect", { x: x0 + 0.5, y, width: w - 1, height: BAR_H, rx: 3, fill: STATION_COLOR[seg.station] }));
      if (seg.state === "rework") {
        bar.append(s("rect", { x: x0 + 0.5, y, width: w - 1, height: BAR_H, rx: 3, fill: "url(#hatch)" }));
      }
      if (seg.state === "work" && w >= 34) {
        bar.append(s("text", { x: x0 + w / 2, y: y + BAR_H / 2 + 4.5, class: "bar-label", fill: STATION_TEXT[seg.station] }, name));
      }
      g.append(bar);
    }

    // 아래 얇은 줄: 손실 구간
    const ly = y + BAR_H + LOSS_GAP;
    for (const seg of ship.segments.filter((sg) => visible(sg) && sg.state in LOSS_COLOR)) {
      const x0 = x(seg.start);
      const w = (clipEnd(seg) - seg.start + 1) * dayW;
      g.append(s("g", null,
        s("title", null, `${ship.id} · ${LOSS_NAME[seg.state]} (${stationName[seg.station]}) · ${seg.start}~${seg.end}일`),
        s("rect", { x: x0 + 0.5, y: ly, width: w - 1, height: LOSS_H, rx: 2, fill: LOSS_COLOR[seg.state] })));
    }

    // 납기: 납기일이 끝나는 자리에 점선
    const dueX = x(ship.due_day + 1);
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
