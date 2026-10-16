// 블록 계획 간트(4.25, D71·D72): 조립 공정 계획서(PP-02)의 배 탭에 그린다. 막대는 엔진이 준 블록 계획 일정(block_plan,
// 고장·대기 없음)이고, 세로 눈금은 블록 납기다. 막대 끝이 눈금을 넘으면 계획상 위험(붉은 테두리와 "!").
// 4.26(사용자 2026-10-16): 관제실 간트의 공정 탭처럼 블록 공정마다
//   위: 작업장마다 한 줄. 이 배의 블록은 공정 색(블록 이름), 다른 배의 블록은 회색이라 "다른 배 블록을 하느라 늦는다"가 보인다.
//   아래: 이 배의 블록마다 한 줄(블록 번호 순, 착수일을 바꿔도 줄은 그대로). 들어갈 수 있는데 작업장이 차서 기다린 날은 얇은 띠.
// 막대를 좌우로 끌어 그 블록의 착수일(block_start)을 정한다. Alt+←/→도 같다(하루씩). 끌 수 있는 범위는 생산계획서 계획 간트의
// 그 배 그 공정 기간(옅은 띠)이고, 막대가 띠 밖에 있으면 지금 자리까지 넓힌다(끌 때 막대가 반대쪽으로 튀지 않게).
// 화면은 계산하지 않는다: 착수일을 바꾸면 미리보기가 새 막대를 준다(작업장이 차 있으면 정한 날보다 늦게 놓일 수 있다).

import { blockLabel, type BlockPlan, type Scenario, type Span } from "./api";
import { s } from "./dom";
import { STATE_INFO, STATION_COLOR, STATION_TEXT } from "./labels";

const W = 640;   // 조립 공정 계획서 폭에서 거의 1:1로 그려진다(글자·줄이 커지지 않게)
const LEFT = 64;
const RIGHT = 10;
const TOP = 20;
const ROW_H = 11;    // 블록 줄
const UNIT_H = 12;   // 작업장 줄
const HEAD_H = 13;   // 공정 이름 줄
const GAP = 3;       // 작업장 줄과 블록 줄 사이
const BAR_H = 7;
const OTHER = "#d3dbd6";   // 관제실 간트의 다른 배와 같은 회색
const WAIT = STATE_INFO.station_wait;

export interface BlockGanttContext {
  scenario: Scenario;
  plan: BlockPlan;
  ship: string;
  stations: { id: string; name: string }[];
  /** 공정마다 작업장 수 */
  units: Record<string, number>;
  /** 공정마다 끌 수 있는 범위: 생산계획서 계획 간트의 이 배 공정 기간 */
  windows: Record<string, Span | undefined>;
  /** 착수일을 정한 블록(블록 이름 → 날) */
  starts: Record<string, number>;
  /** 블록 하나의 착수일을 정했다 */
  onMoveStart(block: string, day: number): void;
}

let focusedBlock: string | null = null;

export function renderBlockGantt(ctx: BlockGanttContext): SVGElement {
  const { plan, ship } = ctx;
  const items = Object.entries(plan.blocks);
  // 공정마다 이 배의 블록(블록 번호 순)과 그 공정의 모든 블록(작업장 줄)
  const groups = ctx.stations.map((st) => ({
    st, win: ctx.windows[st.id], n: Math.max(1, ctx.units[st.id] ?? 1),
    all: items.map(([, b]) => b).filter((b) => b.station === st.id),
    ids: items.filter(([, b]) => b.station === st.id && b.ship === ship).sort(([, a], [, b]) => a.no - b.no).map(([id]) => id),
  }));
  const mine = groups.flatMap((g) => g.ids.map((id) => plan.blocks[id]));
  const wins = groups.flatMap((g) => (g.win ? [g.win] : []));
  const first = Math.max(1, Math.min(...mine.map((b) => Math.min(b.ready, b.start)), ...wins.map((w) => w.start)) - 1);
  const last = Math.min(ctx.scenario.days, Math.max(...mine.map((b) => Math.max(b.end, b.due)), ...wins.map((w) => w.end)) + 1);
  const span = last - first + 1;
  const dayW = (W - LEFT - RIGHT) / span;
  const x = (day: number) => LEFT + (day - first) * dayW;
  const height = TOP + groups.reduce((h, g) => h + HEAD_H + g.n * UNIT_H + GAP + g.ids.length * ROW_H, 0) + 4;

  const svg = s("svg", { class: "gantt block-gantt", viewBox: `0 0 ${W} ${height}`, role: "list",
    "aria-label": `${ship} 블록 일정. 막대를 좌우로 끌거나 Alt+←/→로 블록의 착수일을 정합니다(옅은 띠 안에서).` });
  const axis = s("g", { class: "axis" });
  for (let d = first; d <= last; d++) {
    axis.append(s("line", { x1: x(d), x2: x(d), y1: TOP - 3, y2: height - 2, class: d % 5 === 0 ? "grid major" : "grid" }));
    if (span <= 30 || d % 5 === 0 || d === first) axis.append(s("text", { x: x(d) + dayW / 2, y: TOP - 7, class: "tick" }, d));
  }
  svg.append(axis);

  let y = TOP;
  for (const { st, win, n, all, ids } of groups) {
    svg.append(s("text", { x: 4, y: y + HEAD_H - 3, class: "block-group" }, st.name));
    svg.append(s("line", { x1: 0, x2: W, y1: y + 0.5, y2: y + 0.5, class: "block-group-line" }));
    y += HEAD_H;

    // 작업장 줄: 날마다 그 작업장에 있는 블록을 묶어 그린다(관제실 공정 탭처럼). 작은 블록은 하루에 여럿이 지나가서
    // 블록마다 막대를 그리면 겹친다. 이 배 블록이 있는 날은 공정 색(블록 이름), 다른 배 블록만 있는 날은 회색(배 이름)
    for (let u = 1; u <= n; u++) {
      const uy = y + (u - 1) * UNIT_H;
      const g = s("g", { class: "unit-row" });
      g.append(s("text", { x: 14, y: uy + UNIT_H - 3, class: "lane-id" }, `${u}호 작업장`),
        s("rect", { x: LEFT, y: uy + 1.5, width: span * dayW, height: UNIT_H - 3, class: "lane" }));
      const here = all.filter((b) => b.unit === u);
      const keyOf = (d: number) => {
        const on = here.filter((b) => b.start <= d && d <= b.end);
        const own = on.filter((b) => b.ship === ship).map((b) => blockLabel(st.id, b.no));
        const others = [...new Set(on.filter((b) => b.ship !== ship).map((b) => b.ship))];
        return own.length ? `me|${own.join("·")}|${others.join("+")}` : others.length ? `other||${others.join("+")}` : null;
      };
      let d = first;
      while (d <= last) {
        const key = keyOf(d);
        let e = d;
        while (e + 1 <= last && keyOf(e + 1) === key) e++;
        if (key) {
          const [kind, own, others] = key.split("|");
          const bx = x(d) + 0.5;
          const bw = Math.max(1, (e - d + 1) * dayW - 1);
          const label = kind === "me" ? own : others;
          const when = d === e ? `${d}일` : `${d}~${e}일`;
          g.append(s("rect", { x: bx, y: uy + 2.5, width: bw, height: UNIT_H - 5, rx: 1.5, fill: kind === "me" ? STATION_COLOR[st.id] : OTHER },
            s("title", null, `${u}호 작업장 · ${when} · ${kind === "me" ? `${ship} ${own}${others ? `, 다른 배 ${others}` : ""}` : `다른 배 ${others}의 블록`}`)));
          if (bw >= label.length * 5 + 2) {
            g.append(s("text", { x: bx + bw / 2, y: uy + UNIT_H - 3.5, class: "unit-label", fill: kind === "me" ? STATION_TEXT[st.id] ?? "#fff" : "#4b5a51" }, label));
          }
        }
        d = e + 1;
      }
      svg.append(g);
    }
    y += n * UNIT_H + GAP;

    // 끌 수 있는 범위: 이 공정 블록 줄 뒤에 옅은 공정 색 띠
    if (win) {
      svg.append(s("rect", {
        x: x(win.start), y, width: (win.end - win.start + 1) * dayW, height: ids.length * ROW_H, rx: 2,
        fill: STATION_COLOR[st.id], class: "block-window",
      }, s("title", null, `${st.name} 블록을 옮길 수 있는 범위: 생산계획서 계획 간트의 ${ship} ${st.name} ${win.start}~${win.end}일`)));
    }
    ids.forEach((id, i) => {
      const b = plan.blocks[id];
      const len = b.end - b.start + 1;
      // 막대 끝까지 띠 안에 들게: 착수일은 띠 시작 ~ 띠 끝 − 막대 길이 + 1. 막대가 띠 밖이면 지금 자리까지 넓힌다
      const lo = Math.min(win ? win.start : 1, b.start);
      const hi = Math.max(win ? win.end - len + 1 : ctx.scenario.days, b.start);
      const pinned = ctx.starts[id] !== undefined;
      const waited = b.start - b.ready;
      const ry = y + i * ROW_H;
      const row = s("g", {
        class: `block-row${b.risk ? " risk" : ""}${pinned ? " pinned" : ""}`, tabindex: 0, role: "listitem", "data-block": id, "data-own-keys": "",
        "aria-label": `${st.name} ${blockLabel(st.id, b.no)} ${b.start}~${b.end}일, ${b.unit}호 작업장, 납기 ${b.due}일`
          + `${waited > 0 ? `, 작업장 대기 ${waited}일` : ""}${pinned ? `, 착수일 ${ctx.starts[id]}일` : ""}${b.risk ? ", 계획상 위험" : ""}`,
      });
      const bar = s("g", { class: "block-drag" },
        s("rect", {
          x: x(b.start) + 0.5, y: ry + (ROW_H - BAR_H) / 2, width: Math.max(1, len * dayW - 1), height: BAR_H, rx: 2,
          fill: STATION_COLOR[st.id], class: "block-bar",
        }, s("title", null, `${ship} ${blockLabel(st.id, b.no)} ${b.start}~${b.end}일 · ${b.unit}호 작업장 · 납기 ${b.due}일${pinned ? ` · 착수일 ${ctx.starts[id]}일` : ""}`)));
      row.append(
        s("rect", { x: 0, y: ry, width: W, height: ROW_H, class: "plan-hit" }),
        s("text", { x: 14, y: ry + ROW_H - 3, class: "ship-id small" }, blockLabel(st.id, b.no)),
      );
      // 들어갈 수 있었는데 작업장이 차서 기다린 날(다른 블록을 하는 중): 막대 앞 얇은 띠
      if (waited > 0) {
        row.append(s("rect", { x: x(b.ready) + 0.5, y: ry + ROW_H / 2 - 1.5, width: Math.max(1, waited * dayW - 1), height: 3, fill: WAIT.color },
          s("title", null, `${ship} ${blockLabel(st.id, b.no)} ${WAIT.name} ${b.ready}~${b.start - 1}일: 작업장에서 다른 블록을 하는 중`)));
      }
      row.append(bar, s("line", { x1: x(b.due + 1), x2: x(b.due + 1), y1: ry + 1, y2: ry + ROW_H - 1, class: "due block-due" }));
      if (b.risk) row.append(s("text", { x: Math.min(x(b.end + 1) + 2, W - RIGHT), y: ry + ROW_H - 3, class: "plan-late" }, "!"));
      svg.append(row);

      const moveTo = (day: number) => {
        const next = Math.max(lo, Math.min(hi, day));
        if (next === b.start && !pinned) return;
        focusedBlock = id;
        ctx.onMoveStart(id, next);
      };
      // 끌기: 좌우로만, 움직인 날 수만큼(범위 안에서) 막대를 옮겨 보이고, 놓으면 그날을 착수일로
      let fromX: number | null = null;
      let shift = 0;
      bar.addEventListener("pointerdown", (e) => {
        const ev = e as PointerEvent;
        fromX = ev.clientX;
        shift = 0;
        bar.setPointerCapture(ev.pointerId);
        row.classList.add("dragging");
      });
      bar.addEventListener("pointermove", (e) => {
        if (fromX === null) return;
        const scale = W / svg.getBoundingClientRect().width;
        const days = Math.round((((e as PointerEvent).clientX - fromX) * scale) / dayW);
        shift = Math.max(lo, Math.min(hi, b.start + days)) - b.start;
        bar.setAttribute("transform", `translate(${shift * dayW} 0)`);
      });
      const drop = () => {
        if (fromX === null) return;
        fromX = null;
        row.classList.remove("dragging");
        bar.removeAttribute("transform");
        if (shift) moveTo(b.start + shift);
      };
      bar.addEventListener("pointerup", drop);
      bar.addEventListener("pointercancel", drop);
      row.addEventListener("keydown", (e) => {
        const ev = e as KeyboardEvent;
        if (!ev.altKey || (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight")) return;
        ev.preventDefault();
        moveTo(b.start + (ev.key === "ArrowLeft" ? -1 : 1));
      });
    });
    y += ids.length * ROW_H;
  }

  if (focusedBlock) {
    const target = svg.querySelector<SVGGElement>(`[data-block="${focusedBlock}"]`);
    queueMicrotask(() => target?.focus());
  }
  return svg;
}
