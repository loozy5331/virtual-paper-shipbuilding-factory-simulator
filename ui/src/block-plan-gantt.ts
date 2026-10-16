// 블록 계획 간트(4.25, D71·D72): 조립 공정 계획서(PP-02)의 배 탭에 그린다. 한 척의 블록을 블록 공정(소조립·중조립·PE장)별로 묶어
// 한 줄씩. 막대는 엔진이 준 블록 계획 일정(block_plan, 고장·대기 없음)이고, 세로 눈금은 블록 납기다.
// 막대 끝이 눈금을 넘으면 계획상 위험(붉은 테두리와 "!").
// 4.26(사용자 2026-10-16): 막대를 좌우로 끌어 그 블록의 착수일(block_start)을 정한다. Alt+←/→도 같다(하루씩).
// 다른 공정에 영향을 주지 않게, 끌 수 있는 범위는 생산계획서 계획 간트의 그 배 그 공정 기간이고 막대 뒤에 옅은 띠로 보인다.
// 화면은 계산하지 않는다: 착수일을 바꾸면 미리보기가 새 막대를 준다(작업장이 차 있으면 정한 날보다 늦게 놓일 수 있다).

import { blockLabel, type BlockPlan, type Scenario, type Span } from "./api";
import { s } from "./dom";
import { STATION_COLOR } from "./labels";

const W = 640;   // 조립 공정 계획서 폭에서 거의 1:1로 그려진다(글자·줄이 커지지 않게)
const LEFT = 64;
const RIGHT = 10;
const TOP = 20;
const ROW_H = 11;
const HEAD_H = 13;   // 공정 이름 줄
const BAR_H = 7;

export interface BlockGanttContext {
  scenario: Scenario;
  plan: BlockPlan;
  ship: string;
  stations: { id: string; name: string }[];
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
  // 공정마다 이 배의 블록(그 공정의 들일 순서 그대로)
  const groups = ctx.stations.map((st) => ({
    st, win: ctx.windows[st.id], ids: (plan.order[st.id] ?? []).filter((id) => plan.blocks[id]?.ship === ship),
  }));
  const all = groups.flatMap((g) => g.ids.map((id) => plan.blocks[id]));
  const wins = groups.flatMap((g) => (g.win ? [g.win] : []));
  const first = Math.max(1, Math.min(...all.map((b) => b.start), ...wins.map((w) => w.start)) - 1);
  const last = Math.min(ctx.scenario.days, Math.max(...all.map((b) => Math.max(b.end, b.due)), ...wins.map((w) => w.end)) + 1);
  const span = last - first + 1;
  const dayW = (W - LEFT - RIGHT) / span;
  const x = (day: number) => LEFT + (day - first) * dayW;
  const height = TOP + groups.reduce((n, g) => n + HEAD_H + g.ids.length * ROW_H, 0) + 4;

  const svg = s("svg", { class: "gantt block-gantt", viewBox: `0 0 ${W} ${height}`, role: "list",
    "aria-label": `${ship} 블록 일정. 막대를 좌우로 끌거나 Alt+←/→로 블록의 착수일을 정합니다(옅은 띠 안에서).` });
  const axis = s("g", { class: "axis" });
  for (let d = first; d <= last; d++) {
    axis.append(s("line", { x1: x(d), x2: x(d), y1: TOP - 3, y2: height - 2, class: d % 5 === 0 ? "grid major" : "grid" }));
    if (span <= 30 || d % 5 === 0 || d === first) axis.append(s("text", { x: x(d) + dayW / 2, y: TOP - 7, class: "tick" }, d));
  }
  svg.append(axis);

  let y = TOP;
  for (const { st, win, ids } of groups) {
    svg.append(s("text", { x: 4, y: y + HEAD_H - 3, class: "block-group" }, st.name));
    svg.append(s("line", { x1: 0, x2: W, y1: y + 0.5, y2: y + 0.5, class: "block-group-line" }));
    y += HEAD_H;
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
      // 막대 끝까지 띠 안에 들게: 착수일은 띠 시작 ~ 띠 끝 − 막대 길이 + 1(막대가 띠보다 길면 띠 시작)
      const lo = win ? win.start : 1;
      const hi = win ? Math.max(win.start, win.end - len + 1) : ctx.scenario.days;
      const pinned = ctx.starts[id] !== undefined;
      const ry = y + i * ROW_H;
      const row = s("g", {
        class: `block-row${b.risk ? " risk" : ""}${pinned ? " pinned" : ""}`, tabindex: 0, role: "listitem", "data-block": id, "data-own-keys": "",
        "aria-label": `${st.name} ${blockLabel(st.id, b.no)} ${b.start}~${b.end}일, 납기 ${b.due}일${pinned ? `, 착수일 ${ctx.starts[id]}일` : ""}${b.risk ? ", 계획상 위험" : ""}`,
      });
      const bar = s("g", { class: "block-drag" },
        s("rect", {
          x: x(b.start) + 0.5, y: ry + (ROW_H - BAR_H) / 2, width: Math.max(1, len * dayW - 1), height: BAR_H, rx: 2,
          fill: STATION_COLOR[st.id], class: "block-bar",
        }, s("title", null, `${ship} ${blockLabel(st.id, b.no)} ${b.start}~${b.end}일 · ${b.unit}호 작업장 · 납기 ${b.due}일${pinned ? ` · 착수일 ${ctx.starts[id]}일` : ""}`)));
      row.append(
        s("rect", { x: 0, y: ry, width: W, height: ROW_H, class: "plan-hit" }),
        s("text", { x: 14, y: ry + ROW_H - 3, class: "ship-id small" }, blockLabel(st.id, b.no)),
        bar,
        s("line", { x1: x(b.due + 1), x2: x(b.due + 1), y1: ry + 1, y2: ry + ROW_H - 1, class: "due block-due" }),
      );
      if (b.risk) row.append(s("text", { x: Math.min(x(b.end + 1) + 2, W - RIGHT), y: ry + ROW_H - 3, class: "plan-late" }, "!"));
      svg.append(row);

      const moveTo = (day: number) => {
        const next = Math.max(lo, Math.min(hi, day));
        if (next === b.start && !pinned) return;
        focusedBlock = id;
        ctx.onMoveStart(id, next);
      };
      // 끌기: 좌우로 움직인 날 수만큼(띠 안에서) 막대를 옮겨 보이고, 놓으면 그날을 착수일로
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
