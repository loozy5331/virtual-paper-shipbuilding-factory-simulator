// 조립 작업 목록(4.30, D77): 블록 실습의 생산계획서 클립보드에 끼운 세 번째 낱장(PP-03).
// 사용자(2026-10-17): 수업 슬라이드 "해야 할 작업은 많은데 사용할 수 있는 시간이 부족하다!"의 표를 그대로.
// 어느 날 조립장에 놓인 블록마다 남은 기간, 필요 작업시간, 자재 준비, 후행 공정(짝 블록)을 보고 무엇부터 할지 정한다.
//   머리: 그날 배정 대기 블록 수 · 당일 가용 작업시간(조립 인원 × 8시간) · 필요 작업시간 합
//   표: 남은 기간 순. "먼저" 단추는 그 블록을 그 공정의 블록 순서(block_order)에서 그날 함께 기다리는 블록들 앞에 둔다
// 화면은 계산하지 않는다: 목록과 합계는 미리보기 worklist(계획 일정 기준), 지금 순서는 block_plan.order를 그린다.
// 계획이라 입고 지연·고장·재작업은 없다. 실제는 관제실 "전체" 화면에서 본다.

import { blockLabel, blockStations, type Config, type Preview, type Scenario, type WorklistRow } from "./api";
import { h, mount } from "./dom";
import { STATION_COLOR, STATION_TEXT } from "./labels";
import { docHead } from "./paper";

export interface WorklistContext {
  scenario: Scenario;
  config: Config;
  /** 값이 바뀌었다(블록 순서). 표는 미리보기가 오면 다시 그린다 */
  onEdit(redraw: boolean): void;
  /** 읽기 전용(관제실에서 펼친 계획서): "먼저" 단추를 그리지 않는다 */
  readonly?: boolean;
}

/** 보고 있는 날. 시나리오가 바뀌면(또는 처음) 미리보기의 focus(처음 모자라는 날)로 */
let day: number | null = null;
let dayScenario = "";
/** 낱장마다 그린 양식(생산계획서 화면의 것과 관제실에서 펼친 읽기 전용 계획서가 따로 있다) */
const contexts = new WeakMap<HTMLElement, WorklistContext>();
const previews = new WeakMap<HTMLElement, Preview>();

export function renderWorklistSheet(root: HTMLElement, ctx: WorklistContext): void {
  contexts.set(root, ctx);
  if (!blockStations(ctx.scenario).length) { mount(root, null); return; }
  if (dayScenario !== ctx.scenario.id) { day = null; dayScenario = ctx.scenario.id; }
  const head = docHead({
    title: "조립 작업 목록", period: ctx.scenario.period, code: "PP-03", approved: false,
    fields: [["장소", "블록 조립장 작업 배정 구역"], ["딸린 문서", "생산계획서 PP-01 · 조립 공정 계획서 PP-02"]],
  });
  mount(root, head,
    h("section", { class: "panel wl-main" },
      h("div", { class: "panel-head" }, h("span", { class: "step" }, "1"), h("h2", null, "오늘의 작업 목록"),
        h("div", { class: "wl-day", "data-wl": "day" })),
      h("div", { class: "wl-summary", "data-wl": "summary" }),
      h("div", { "data-wl": "table" }, h("p", { class: "hint" }, "계획을 계산하는 중…")),
      h("p", { class: "hint" },
        "남은 기간은 블록 납기까지 남은 날(0일 = 오늘이 납기), 필요 작업시간은 그 블록에 남은 공수(MH, 사람 × 시간)입니다. ",
        "자재는 계획 입고일로 본 준비 상태이고, 후행 공정은 이 블록과 함께 다음 공정 블록을 이루는 짝 블록입니다. ",
        "생산계획서의 계획 일정(고장·입고 지연·재작업 없음)으로 그린 목록이라, 실제로 무슨 일이 생기는지는 관제실 \"전체\" 화면에서 봅니다.")),
    h("aside", { class: "wl-message" },
      h("b", null, "생각해 볼 것"),
      h("p", null, "어떤 작업부터 진행해야 할까요? 납기와 작업시간 중 무엇을 먼저 고려해야 할까요?"),
      h("p", null, "납기, 작업시간, 자재 준비, 후속 공정 영향을 함께 봅니다.")));
  const last = previews.get(root);
  if (last) updateWorklistSheet(root, last);
}

/** 미리보기로 날 고르기·합계·표를 채운다 */
export function updateWorklistSheet(root: HTMLElement, preview: Preview | null): void {
  const ctx = contexts.get(root);
  if (!ctx || !preview?.worklist || !root.querySelector("[data-wl='table']")) return;
  previews.set(root, preview);
  const wl = preview.worklist;
  const { scenario, config } = ctx;
  const days = Object.keys(wl.days).map(Number).sort((a, b) => a - b);
  if (day === null || !wl.days[String(day)]) day = wl.focus;
  const today = wl.days[String(day)];
  const go = (d: number) => { day = d; updateWorklistSheet(root, preview); };
  const at = days.indexOf(day);

  mount(root.querySelector<HTMLElement>("[data-wl='day']")!,
    h("button", { type: "button", class: "btn small", disabled: at <= 0, "aria-label": "앞날", onclick: () => go(days[at - 1]) }, "◀"),
    h("b", { class: "wl-day-now" }, `${day}일`),
    h("button", { type: "button", class: "btn small", disabled: at >= days.length - 1, "aria-label": "다음 날", onclick: () => go(days[at + 1]) }, "▶"),
    h("button", { type: "button", class: "btn small", disabled: day === wl.focus, title: "두 공정 이상이 함께 있고 필요 작업시간이 가용보다 처음 많은 날",
      onclick: () => go(wl.focus) }, "부족한 첫날"));

  const short = today.need_mh - wl.capacity_mh;
  mount(root.querySelector<HTMLElement>("[data-wl='summary']")!,
    stat(`${today.rows.length}건`, "배정 대기 블록"),
    stat(`${fmt(wl.capacity_mh)}H`, `당일 가용 작업시간 (${wl.workers}명 × ${wl.day_hours}시간)`),
    stat(`${fmt(today.need_mh)}H`, short > 0 ? `필요 작업시간 · ${fmt(short)}H 부족` : "필요 작업시간", short > 0));

  // 지금 계획의 블록 순서(공정마다): 정한 목록 + 나머지는 시작 순
  const order = preview.block_plan?.order ?? {};
  const rank = (r: WorklistRow) => {
    const mine = today.rows.filter((x) => x.station === r.station).map((x) => x.id);
    return (order[r.station] ?? []).filter((id) => mine.includes(id)).indexOf(r.id) + 1;
  };
  const stationName = Object.fromEntries(scenario.stations.map((s) => [s.id, s.name]));
  const materialName = Object.fromEntries(scenario.materials.map((m) => [m.id, m.name]));
  const nextName = (r: WorklistRow) => {
    if (r.next === "erection") return stationName.erection;
    const st = Object.entries(CODE).find(([, code]) => r.next.includes(code))?.[0];
    return `${st ? stationName[st] : ""} ${r.next}`;
  };

  const moveFirst = (r: WorklistRow) => {
    // 그날 함께 기다리는 블록 가운데 맨 앞 자리로(r은 그보다 뒤에 있으니 빼도 그 자리는 그대로다)
    const base = order[r.station] ?? [];
    const mine = today.rows.filter((x) => x.station === r.station).map((x) => x.id);
    const rest = base.filter((id) => id !== r.id);
    rest.splice(base.findIndex((id) => mine.includes(id)), 0, r.id);
    (config.block_order ??= {})[r.station] = rest;
    ctx.onEdit(false);
  };

  mount(root.querySelector<HTMLElement>("[data-wl='table']")!,
    h("table", { class: "plan wl-table" },
      h("thead", null, h("tr", null,
        h("th", null, "작업"), h("th", null, "공정"), h("th", null, "남은 기간"), h("th", null, "필요 작업시간"),
        h("th", null, "자재 준비"), h("th", null, "후행 공정"), h("th", { title: "같은 공정에서 기다리는 블록 가운데 몇 번째로 들이는지(지금 계획)" }, "순서"))),
      h("tbody", null, today.rows.map((r) => {
        const urgent = r.left_days <= 1;
        const n = rank(r);
        return h("tr", { class: urgent ? "urgent" : "" },
          h("th", null, r.id, h("small", null, ` ${blockLabel(r.station, r.no)}`)),
          h("td", null, h("span", { class: "wl-station", style: { background: STATION_COLOR[r.station], color: STATION_TEXT[r.station] } }, stationName[r.station])),
          h("td", { class: urgent ? "wl-hot" : "" }, r.left_days < 0 ? `${-r.left_days}일 지남` : `${r.left_days}일`),
          h("td", null, `${fmt(r.left_mh)}시간`, r.left_mh < r.std_mh ? h("small", null, ` / ${fmt(r.std_mh)}`) : null),
          h("td", { class: r.kit_ready ? "" : "wl-hot" }, r.kit_ready ? "완료" : "미완료",
            r.material && r.kit_day ? h("small", null, ` ${materialName[r.material]} ${r.kit_day}일 입고${r.kit_ready ? "" : " 예정"}`) : null),
          h("td", { class: r.mates_done ? "wl-unblock" : "" },
            r.mates_done ? `이것만 끝나면 ${nextName(r)} 시작` : `${nextName(r)} · 짝 ${r.mates.join(", ")} 남음`),
          h("td", { class: "wl-order" }, n ? `${n}번째` : "",
            !ctx.readonly && n > 1 ? h("button", { type: "button", class: "btn small", title: "이 공정에서 그날 기다리는 블록들보다 먼저 들입니다(블록 순서)", onclick: () => moveFirst(r) }, "먼저") : null));
      }))),
    config.block_order && !ctx.readonly
      ? h("p", { class: "wl-reset" }, h("button", { type: "button", class: "btn small", onclick: () => { delete config.block_order; ctx.onEdit(false); } }, "정한 순서 지우기(규칙대로)"))
      : null);
}

function stat(value: string, label: string, warn = false): HTMLElement {
  return h("div", { class: `wl-stat${warn ? " warn" : ""}` }, h("b", null, value), h("small", null, label));
}

function fmt(v: number): string {
  return String(Math.round(v * 10) / 10);
}

/** 다음 공정 블록 id("S1-BA2")에서 공정을 읽는다 */
const CODE: Record<string, string> = { sub_assembly: "-SA", block_assembly: "-BA", grand_assembly: "-GA" };
