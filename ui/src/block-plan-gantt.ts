// 블록 계획 간트(4.25, D71·D72): 조립 공정 계획서(PP-02)의 배 탭에 그린다. 한 척의 블록을 블록 공정(소조립·중조립·PE장)별로 묶어
// 한 줄씩. 막대는 엔진이 준 블록 계획 일정(block_plan, 고장·대기 없음)이고, 세로 눈금은 블록 납기다.
// 막대 끝이 눈금을 넘으면 계획상 위험(붉은 테두리와 "!").
// 사용자(2026-10-16): 블록 공정도 선박별로. 그래서 줄을 끌면 이 배의 블록끼리, 같은 공정 안에서만 순서가 바뀐다
// (다른 배 블록과의 앞뒤는 배 우선순위와 공정 규칙이 정한다). Alt+↑/↓도 같다. onReorder로 그 공정에서 이 배 블록의 새 순서를 넘긴다.
// 화면은 계산하지 않는다: 순서를 바꾸면 미리보기가 새 막대를 준다.

import { blockLabel, type BlockPlan, type Scenario } from "./api";
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
  /** 공정 하나에서 이 배 블록의 새 순서 */
  onReorder(station: string, order: string[]): void;
}

let focusedBlock: string | null = null;

export function renderBlockGantt(ctx: BlockGanttContext): SVGElement {
  const { plan, ship } = ctx;
  // 공정마다 이 배의 블록(그 공정의 들일 순서 그대로)
  const groups = ctx.stations.map((st) => ({
    st, ids: (plan.order[st.id] ?? []).filter((id) => plan.blocks[id]?.ship === ship),
  }));
  const all = groups.flatMap((g) => g.ids.map((id) => plan.blocks[id]));
  const first = Math.max(1, Math.min(...all.map((b) => b.start)) - 1);
  const last = Math.min(ctx.scenario.days, Math.max(...all.map((b) => Math.max(b.end, b.due))) + 1);
  const span = last - first + 1;
  const dayW = (W - LEFT - RIGHT) / span;
  const x = (day: number) => LEFT + (day - first) * dayW;
  const height = TOP + groups.reduce((n, g) => n + HEAD_H + g.ids.length * ROW_H, 0) + 4;

  const svg = s("svg", { class: "gantt block-gantt", viewBox: `0 0 ${W} ${height}`, role: "list",
    "aria-label": `${ship} 블록 일정. 줄을 위아래로 끌거나 Alt+↑/↓로 같은 공정 안의 순서를 바꿉니다.` });
  const axis = s("g", { class: "axis" });
  for (let d = first; d <= last; d++) {
    axis.append(s("line", { x1: x(d), x2: x(d), y1: TOP - 3, y2: height - 2, class: d % 5 === 0 ? "grid major" : "grid" }));
    if (span <= 30 || d % 5 === 0 || d === first) axis.append(s("text", { x: x(d) + dayW / 2, y: TOP - 7, class: "tick" }, d));
  }
  svg.append(axis);

  let y = TOP;
  for (const { st, ids } of groups) {
    svg.append(s("text", { x: 4, y: y + HEAD_H - 3, class: "block-group" }, st.name));
    svg.append(s("line", { x1: 0, x2: W, y1: y + 0.5, y2: y + 0.5, class: "block-group-line" }));
    y += HEAD_H;
    const move = (from: number, to: number) => {
      if (to < 0 || to >= ids.length || to === from) return;
      const next = [...ids];
      const [id] = next.splice(from, 1);
      next.splice(to, 0, id);
      focusedBlock = id;
      ctx.onReorder(st.id, next);
    };
    ids.forEach((id, i) => {
      const b = plan.blocks[id];
      const ry = y + i * ROW_H;
      const row = s("g", {
        class: `block-row${b.risk ? " risk" : ""}`, tabindex: 0, role: "listitem", "data-block": id, "data-own-keys": "",
        "aria-label": `${st.name} ${i + 1}번째 ${blockLabel(st.id, b.no)} ${b.start}~${b.end}일, 납기 ${b.due}일${b.risk ? ", 계획상 위험" : ""}`,
      });
      row.append(
        s("rect", { x: 0, y: ry, width: W, height: ROW_H, class: "plan-hit" }),
        s("text", { x: 14, y: ry + ROW_H - 3, class: "ship-id small" }, blockLabel(st.id, b.no)),
        s("rect", {
          x: x(b.start) + 0.5, y: ry + (ROW_H - BAR_H) / 2, width: Math.max(1, (b.end - b.start + 1) * dayW - 1), height: BAR_H, rx: 2,
          fill: STATION_COLOR[st.id], class: "block-bar",
        }, s("title", null, `${ship} ${blockLabel(st.id, b.no)} ${b.start}~${b.end}일 · ${b.unit}호 작업장 · 납기 ${b.due}일`)),
        s("line", { x1: x(b.due + 1), x2: x(b.due + 1), y1: ry + 1, y2: ry + ROW_H - 1, class: "due block-due" }),
      );
      if (b.risk) row.append(s("text", { x: Math.min(x(b.end + 1) + 2, W - RIGHT), y: ry + ROW_H - 3, class: "plan-late" }, "!"));
      svg.append(row);

      // 끌기: 위아래로 움직인 만큼(같은 공정 안에서) 줄을 옮겨 보이고, 놓으면 그 자리로
      let fromY: number | null = null;
      let shift = 0;
      row.addEventListener("pointerdown", (e) => {
        const ev = e as PointerEvent;
        fromY = ev.clientY;
        shift = 0;
        row.setPointerCapture(ev.pointerId);
        row.classList.add("dragging");
      });
      row.addEventListener("pointermove", (e) => {
        if (fromY === null) return;
        const scale = W / svg.getBoundingClientRect().width;
        shift = Math.max(-i, Math.min(ids.length - 1 - i, Math.round((((e as PointerEvent).clientY - fromY) * scale) / ROW_H)));
        row.setAttribute("transform", `translate(0 ${shift * ROW_H})`);
      });
      const drop = () => {
        if (fromY === null) return;
        fromY = null;
        row.classList.remove("dragging");
        row.removeAttribute("transform");
        if (shift) move(i, i + shift);
      };
      row.addEventListener("pointerup", drop);
      row.addEventListener("pointercancel", drop);
      row.addEventListener("keydown", (e) => {
        const ev = e as KeyboardEvent;
        if (!ev.altKey || (ev.key !== "ArrowUp" && ev.key !== "ArrowDown")) return;
        ev.preventDefault();
        move(i, i + (ev.key === "ArrowUp" ? -1 : 1));
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
