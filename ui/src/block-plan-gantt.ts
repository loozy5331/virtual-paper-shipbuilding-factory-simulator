// 블록 계획 간트(4.25, D71): 생산계획서 계획 간트에서 블록 공정(소조립·중조립·PE장) 막대를 누르면 그 아래에 펼쳐진다.
// 그 공정의 모든 블록(모든 배)을 들일 순서대로 한 줄씩. 막대는 엔진이 준 블록 계획 일정(block_plan, 고장·대기 없음)이고,
// 세로 눈금은 블록 납기다. 막대 끝이 눈금을 넘으면 계획상 위험(붉은 테두리와 "!").
// 줄을 위아래로 끌거나, 줄에 포커스를 두고 Alt+↑/↓를 누르면 순서가 바뀐다(onReorder로 그 공정의 전체 목록을 넘긴다).
// 화면은 계산하지 않는다: 순서를 바꾸면 미리보기가 새 막대를 준다.

import { blockLabel, type BlockPlan, type Scenario } from "./api";
import { s } from "./dom";
import { STATION_COLOR } from "./labels";

const W = 640;   // 조립 공정 계획서 폭에서 거의 1:1로 그려진다(글자·줄이 커지지 않게)
const LEFT = 64;
const RIGHT = 10;
const TOP = 20;
const ROW_H = 11;
const BAR_H = 7;

export interface BlockGanttContext {
  scenario: Scenario;
  plan: BlockPlan;
  station: string;
  /** 새 순서(그 공정의 모든 블록 이름) */
  onReorder(order: string[]): void;
}

let focusedBlock: string | null = null;

export function renderBlockGantt(ctx: BlockGanttContext): SVGElement {
  const { plan, station } = ctx;
  const order = plan.order[station] ?? [];
  const items = order.map((id) => ({ id, ...plan.blocks[id] }));
  // 그 공정의 기간만 확대한다(앞뒤 하루씩 여백)
  const first = Math.max(1, Math.min(...items.map((b) => b.start)) - 1);
  const last = Math.min(ctx.scenario.days, Math.max(...items.map((b) => Math.max(b.end, b.due))) + 1);
  const span = last - first + 1;
  const dayW = (W - LEFT - RIGHT) / span;
  const x = (day: number) => LEFT + (day - first) * dayW;
  const height = TOP + items.length * ROW_H + 4;
  const ships = [...new Set(items.map((b) => b.ship))];

  const svg = s("svg", { class: "gantt block-gantt", viewBox: `0 0 ${W} ${height}`, role: "list", "aria-label": "블록 일정. 줄을 위아래로 끌거나 Alt+↑/↓로 순서를 바꿉니다." });
  const axis = s("g", { class: "axis" });
  for (let d = first; d <= last; d++) {
    axis.append(s("line", { x1: x(d), x2: x(d), y1: TOP - 3, y2: height - 2, class: d % 5 === 0 ? "grid major" : "grid" }));
    if (span <= 20 || d % 5 === 0 || d === first) axis.append(s("text", { x: x(d) + dayW / 2, y: TOP - 7, class: "tick" }, d));
  }
  svg.append(axis);

  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || to === from) return;
    const next = [...order];
    const [id] = next.splice(from, 1);
    next.splice(to, 0, id);
    focusedBlock = id;
    ctx.onReorder(next);
  };

  items.forEach((b, i) => {
    const y = TOP + i * ROW_H;
    const row = s("g", {
      class: `block-row${b.risk ? " risk" : ""}`, tabindex: 0, role: "listitem", "data-block": b.id, "data-own-keys": "",
      "aria-label": `${i + 1}번째 ${b.ship} ${blockLabel(station, b.no)} ${b.start}~${b.end}일, 납기 ${b.due}일${b.risk ? ", 계획상 위험" : ""}`,
    });
    row.append(
      s("rect", { x: 0, y, width: W, height: ROW_H, class: "plan-hit" }),
      // 배마다 이름 글자 굵기를 바꿔 다른 배의 블록이 섞인 순서를 읽게 한다
      s("text", { x: 4, y: y + ROW_H - 4, class: `ship-id small${ships.indexOf(b.ship) % 2 ? " alt" : ""}` }, `${b.ship} ${blockLabel(station, b.no)}`),
      s("rect", {
        x: x(b.start) + 0.5, y: y + (ROW_H - BAR_H) / 2, width: Math.max(1, (b.end - b.start + 1) * dayW - 1), height: BAR_H, rx: 2,
        fill: STATION_COLOR[station], class: "block-bar",
      }, s("title", null, `${b.ship} ${blockLabel(station, b.no)} ${b.start}~${b.end}일 · ${b.unit}호 작업장 · 납기 ${b.due}일`)),
      s("line", { x1: x(b.due + 1), x2: x(b.due + 1), y1: y + 1, y2: y + ROW_H - 1, class: "due block-due" }),
    );
    if (b.risk) row.append(s("text", { x: Math.min(x(b.end + 1) + 2, W - RIGHT), y: y + ROW_H - 4, class: "plan-late" }, "!"));
    svg.append(row);

    // 끌기: 위아래로 움직인 만큼 줄을 옮겨 보이고, 놓으면 그 자리로
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
      shift = Math.max(-i, Math.min(order.length - 1 - i, Math.round((((e as PointerEvent).clientY - fromY) * scale) / ROW_H)));
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

  if (focusedBlock) {
    const target = svg.querySelector<SVGGElement>(`[data-block="${focusedBlock}"]`);
    queueMicrotask(() => target?.focus());
  }
  return svg;
}
