// 계획 간트: 실행 전에 착수 예정일을 정하는 막대. 배마다 한 줄, 공정 막대 4개를 이어 붙인다.
// 막대 길이와 겹침은 서버 /api/preview의 plan을 그대로 그린다(화면은 계산하지 않는다).
// 배 줄을 좌우로 끌거나, 줄에 포커스를 두고 ←/→를 누르면 착수 예정일이 하루씩 바뀐다.
// 막대 앞 위에 착수 예정일을 숫자로 적는다. 끄는 동안에도 그 숫자가 따라 바뀐다.
// 끄는 동안에는 줄만 옮겨 보이고, 놓을 때 onMove로 알린다. 새 막대는 다음 미리보기에서 다시 그린다.

import type { Plan, Scenario } from "./api";
import { s } from "./dom";
import { STATE_INFO, STATION_COLOR } from "./labels";

const W = 440;
const LEFT = 30;
const RIGHT = 8;
const TOP = 22;
const ROW_H = 34;
const BAR_H = 16;
const WAIT_COLOR = STATE_INFO.station_wait.color;

export interface PlanGanttContext {
  scenario: Scenario;
  plan: Plan;
  startDays: Record<string, number>;
  /** 착수 예정일을 바꿨다. 범위(1~마지막 날)는 여기서 맞춰서 넘긴다. */
  onMove(shipId: string, startDay: number): void;
}

// 다시 그린 뒤에도 키보드로 옮기던 줄에 포커스를 돌려준다.
let focusedShip: string | null = null;

export function renderPlanGantt(ctx: PlanGanttContext): SVGElement {
  const { scenario, plan } = ctx;
  const days = scenario.days;
  const dayW = (W - LEFT - RIGHT) / days;
  const x = (day: number) => LEFT + (day - 1) * dayW;
  const height = TOP + scenario.orders.length * ROW_H + 4;
  const stationName = Object.fromEntries(scenario.stations.map((st) => [st.id, st.name]));
  const clamp = (day: number) => Math.min(days, Math.max(1, day));

  const svg = s("svg", {
    class: "gantt plan-gantt", viewBox: `0 0 ${W} ${height}`, role: "group",
    "aria-label": "계획 간트. 배 줄을 끌거나 ←/→로 착수 예정일을 바꿉니다.",
  });
  svg.append(s("defs", null,
    s("pattern", { id: "plan-hatch", width: 5, height: 5, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" },
      s("rect", { width: 2, height: 5, fill: WAIT_COLOR }))));

  const axis = s("g", { class: "axis" });
  for (let d = 1; d <= days; d++) {
    if (d === 1 || d % 10 === 0) {
      axis.append(
        s("line", { x1: x(d), x2: x(d), y1: TOP - 4, y2: height - 2, class: d % 10 === 0 ? "grid major" : "grid" }),
        s("text", { x: x(d) + dayW / 2, y: TOP - 9, class: "tick" }, d));
    }
  }
  svg.append(axis);

  scenario.orders.forEach((order, i) => {
    const sid = order.id;
    const spans = plan.ships[sid];
    const start = ctx.startDays[sid];
    const y = TOP + i * ROW_H;
    const barY = y + ROW_H - BAR_H - 4;

    svg.append(s("text", { x: 4, y: barY + BAR_H - 3, class: "ship-id small" }, sid));

    const row = s("g", {
      class: "plan-row", tabindex: 0, role: "slider", "data-own-keys": "", "data-ship": sid,
      "aria-label": `${sid} 착수 예정일`, "aria-valuemin": 1, "aria-valuemax": days, "aria-valuenow": start,
    });
    // 줄 전체를 잡을 수 있게 투명한 바탕을 깐다.
    row.append(s("rect", { x: LEFT, y, width: W - LEFT - RIGHT, height: ROW_H, class: "plan-hit" }));
    for (const st of scenario.stations) {
      const sp = spans[st.id];
      if (!sp || sp.start > days) continue;
      const end = Math.min(sp.end, days);
      row.append(s("rect", {
        x: x(sp.start) + 0.5, y: barY, width: Math.max(1, (end - sp.start + 1) * dayW - 1), height: BAR_H, rx: 2,
        fill: STATION_COLOR[st.id],
      }, s("title", null, `${sid} ${stationName[st.id]} ${sp.start}~${sp.end}일`)));
    }
    const last = spans[scenario.stations[scenario.stations.length - 1].id];
    if (last && last.end > order.due_day) {
      row.append(s("text", { x: Math.min(x(last.end + 1) + 3, W - RIGHT), y: barY + BAR_H - 3, class: "plan-late" }, "!"));
    }
    // 착수 예정일. 줄과 함께 움직이고, 끄는 동안 숫자가 바뀐다.
    const label = s("text", { x: x(start), y: barY - 3, class: "plan-start" }, `${start}일`);
    row.append(label);
    svg.append(row);

    // ----- 끌기 -----
    let from: number | null = null;
    let shift = 0;
    const move = (px: number) => {
      const scale = W / svg.getBoundingClientRect().width;
      shift = clamp(start + Math.round(((px - from!) * scale) / dayW)) - start;
      row.setAttribute("transform", `translate(${shift * dayW} 0)`);
      label.textContent = `${start + shift}일`;
    };
    row.addEventListener("pointerdown", (e) => {
      const ev = e as PointerEvent;
      from = ev.clientX;
      shift = 0;
      row.setPointerCapture(ev.pointerId);
      row.classList.add("dragging");
    });
    row.addEventListener("pointermove", (e) => { if (from !== null) move((e as PointerEvent).clientX); });
    const drop = () => {
      if (from === null) return;
      from = null;
      row.classList.remove("dragging");
      if (shift !== 0) ctx.onMove(sid, start + shift);
    };
    row.addEventListener("pointerup", drop);
    row.addEventListener("pointercancel", drop);

    // ----- 키보드 -----
    row.addEventListener("keydown", (e) => {
      const key = (e as KeyboardEvent).key;
      const step = key === "ArrowLeft" ? -1 : key === "ArrowRight" ? 1 : 0;
      if (!step) return;
      e.preventDefault();
      const next = clamp(start + step);
      if (next === start) return;
      focusedShip = sid;
      ctx.onMove(sid, next);
    });
    row.addEventListener("blur", () => { if (focusedShip === sid) focusedShip = null; });
  });

  // 같은 작업장을 두 배가 겹쳐 쓰는 날: 두 배 줄 모두에 빗금. 뒤 순위 배는 실제로는 작업장 대기를 한다.
  for (const c of plan.conflicts) {
    for (const sid of c.ships) {
      const i = scenario.orders.findIndex((o) => o.id === sid);
      const y = TOP + i * ROW_H + ROW_H - BAR_H - 4;   // 막대 자리(barY)와 같다
      svg.append(s("rect", {
        x: x(c.start) + 0.5, y: y - 2, width: (c.end - c.start + 1) * dayW - 1, height: BAR_H + 4,
        class: "plan-conflict", fill: "url(#plan-hatch)",
      }, s("title", null, `${stationName[c.station]} 겹침 ${c.ships.join("·")} ${c.start}~${c.end}일`)));
    }
  }

  // 납기는 끌어도 움직이지 않고, 줄 강조에 가리지 않게 맨 위에 그린다.
  scenario.orders.forEach((order, i) => {
    const y = TOP + i * ROW_H;
    svg.append(
      s("line", { x1: x(order.due_day + 1), x2: x(order.due_day + 1), y1: y + 2, y2: y + ROW_H - 2, class: "due plan-due" },
        s("title", null, `${order.id} 납기 ${order.due_day}일`)));
  });

  if (focusedShip) {
    const target = svg.querySelector<SVGGElement>(`[data-ship="${focusedShip}"]`);
    queueMicrotask(() => target?.focus());
  }
  return svg;
}

/** 겹침 목록을 글로 적는다. 빗금(색)만으로 알리지 않으려고 쓴다. */
export function conflictText(scenario: Scenario, plan: Plan): string {
  if (!plan.conflicts.length) return "겹치는 작업장이 없습니다.";
  const name = Object.fromEntries(scenario.stations.map((st) => [st.id, st.name]));
  // 많으면(전부 1일 착수 같은 경우) 공정별 개수만 적는다.
  if (plan.conflicts.length > 5) {
    const count = scenario.stations
      .map((st) => [name[st.id], plan.conflicts.filter((c) => c.station === st.id).length] as const)
      .filter(([, n]) => n > 0);
    return `겹침 ${plan.conflicts.length}곳: ${count.map(([st, n]) => `${st} ${n}`).join(", ")}`;
  }
  const items = plan.conflicts.map((c) =>
    `${name[c.station]} ${c.ships.join("·")} ${c.start === c.end ? `${c.start}일` : `${c.start}~${c.end}일`}`);
  return `겹침 ${items.length}곳: ${items.join(", ")}`;
}
