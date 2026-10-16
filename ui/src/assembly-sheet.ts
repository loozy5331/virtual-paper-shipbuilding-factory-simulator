// 조립 공정 계획서(4.25, D71): 블록 조립 실습의 생산계획서 클립보드에 끼운 두 번째 낱장(PP-02).
// 사용자(2026-10-16): 조립 공정 상세화로 생산계획서가 복잡해져서, 조립 공정에 대한 것은 이 낱장에 모은다.
// 본 서식(생산계획서 PP-01)은 다른 반기와 같다. 낱장은 클립보드 위 인덱스 탭으로 넘기고, 이 장은 스크롤 없이 한 화면에 든다
// (블록 일정과 납기 표는 이 장 안의 작은 탭으로 나눈다).
//   ① 블록 공정 우선순위 규칙(소조립·중조립·PE장)  ② 블록 일정과 납기: 계획상 위험 한 줄 + [소조립 | 중조립 | PE장 | 공정·블록 납기] 탭
// 화면은 계산하지 않는다: 블록 일정·납기·위험은 미리보기(block_plan, dues, plan_risks)를 그린다.

import { activeStations, blockId, blockLabel, blockStations, type Config, type DispatchRule, type Preview, type Scenario } from "./api";
import { renderBlockGantt } from "./block-plan-gantt";
import { h, mount } from "./dom";
import { DISPATCH_INFO, STATION_COLOR } from "./labels";
import { docHead } from "./paper";
import { riskText } from "./plan-gantt";

export interface AssemblyContext {
  scenario: Scenario;
  config: Config;
  /** 값이 바뀌었다. redraw가 true면 이 장을 다시 그린다. */
  onEdit(redraw: boolean): void;
}

/** 이 장 안의 탭: 블록 일정(공정 하나) 또는 공정·블록 납기(배 하나) */
let view: "schedule" | "dues" = "schedule";
let station: string | null = null;
let ship: string | null = null;
let current: AssemblyContext | null = null;
let lastPreview: Preview | null = null;

/** 생산계획서 계획 간트에서 블록 공정 막대를 눌렀을 때: 그 공정의 블록 일정을 연다 */
export function focusAssemblyStation(id: string): void {
  view = "schedule";
  station = id;
}

function seg<T extends string>(name: string, options: { value: T; label: string }[], value: T, onPick: (v: T) => void): HTMLElement {
  return h("div", { class: "seg", role: "radiogroup" },
    options.map((o) => h("label", { class: "seg-item" },
      h("input", { type: "radio", name, checked: o.value === value, onchange: () => onPick(o.value) }),
      h("span", null, o.label))));
}

export function renderAssemblySheet(root: HTMLElement, ctx: AssemblyContext): void {
  current = ctx;
  const { scenario, config } = ctx;
  const bst = blockStations(scenario);
  if (!bst.length) { mount(root, null); return; }
  station = bst.some((b) => b.id === station) ? station : bst[0].id;
  ship = scenario.orders.some((o) => o.id === ship) ? ship : scenario.orders[0].id;

  // ① 우선순위 규칙: 블록 공정마다 한 줄. 규칙은 블록 순서를 정하지 않은 블록의 순서이고, 평가서 추천이 비교하는 것이다
  const rules = h("section", { class: "panel asm-rules" },
    h("div", { class: "panel-head" }, h("span", { class: "step" }, "1"), h("h2", null, "블록 공정 우선순위 규칙")),
    h("div", { class: "asm-rule-grid" }, bst.map((b) => {
      const cfg = config.stations[b.id];
      const rule = cfg.dispatch ?? "ship";
      return [
        h("span", { class: "asm-st" }, h("i", { class: "swatch", style: { background: STATION_COLOR[b.id] } }), b.name, h("small", null, ` 블록 ${b.count}`)),
        seg(`dispatch-${b.id}`, (Object.keys(DISPATCH_INFO) as DispatchRule[]).map((id) => ({ value: id, label: DISPATCH_INFO[id].name })),
          rule, (v) => { if (v === "ship") delete cfg.dispatch; else cfg.dispatch = v; ctx.onEdit(true); }),
      ];
    })),
    h("p", { class: "hint" }, DISPATCH_INFO[config.stations[station!].dispatch ?? "ship"].note,
      " · 블록 일정에서 순서를 끌어 정한 블록은 규칙보다 먼저 합니다."));

  // ② 블록 일정과 납기: 계획상 위험 한 줄(혼자 써도 공정 납기를 넘기는 공정, 작업장 겹침과는 원인이 다르다),
  //    탭 한 줄 [소조립 | 중조립 | PE장 | 공정·블록 납기]
  const tabs = h("div", { class: "tabs asm-tabs", role: "tablist" },
    bst.map((b) => h("button", {
      type: "button", class: `tab${view === "schedule" && station === b.id ? " active" : ""}`, role: "tab",
      onclick: () => { view = "schedule"; station = b.id; ctx.onEdit(true); },
    }, `${b.name} 블록 일정`)),
    h("button", {
      type: "button", class: `tab${view === "dues" ? " active" : ""}`, role: "tab",
      onclick: () => { view = "dues"; ctx.onEdit(true); },
    }, "공정·블록 납기"));
  const body = view === "schedule" ? h("div", { class: "asm-schedule", "data-asm": "gantt" }) : dueTable(ctx);
  const second = h("section", { class: "panel asm-main" },
    h("div", { class: "panel-head" }, h("span", { class: "step" }, "2"), h("h2", null, "블록 일정과 납기")),
    h("p", { class: "hint plan-risk", "data-asm": "risks" }, "…"), tabs, body);

  const head = docHead({
    title: "조립 공정 계획서", period: scenario.period, code: "PP-02", approved: false,
    fields: [["대상", `조립 세 공정(${bst.map((b) => b.name).join(" → ")})의 블록`], ["딸린 문서", "생산계획서 PP-01"]],
  });
  mount(root, head, rules, second, h("div", { class: "errors", "data-asm": "errors" }));
  if (lastPreview) updateAssemblySheet(root, lastPreview, []);
}

/** 공정·블록 납기 표: 배 하나씩(배 탭). 빈 칸은 엔진이 역산한 기본값(자리 표시), 숫자를 적은 칸만 바꾼다.
 *  입력 중에는 다시 그리지 않는다. */
function dueTable(ctx: AssemblyContext): HTMLElement {
  const { scenario, config } = ctx;
  const sid = ship!;
  const bst = blockStations(scenario);
  const tidy = () => {
    const due = config.due;
    if (!due) return;
    if (due.stations) {
      for (const [k, v] of Object.entries(due.stations)) if (!Object.keys(v).length) delete due.stations[k];
      if (!Object.keys(due.stations).length) delete due.stations;
    }
    if (due.blocks && !Object.keys(due.blocks).length) delete due.blocks;
    if (!Object.keys(due).length) delete config.due;
  };
  const setStationDue = (pid: string, v: number | null) => {
    const per = ((config.due ??= {}).stations ??= {})[sid] ??= {};
    if (v === null) delete per[pid]; else per[pid] = v;
    tidy();
  };
  const setBlockDue = (bid: string, v: number | null) => {
    const blocks = (config.due ??= {}).blocks ??= {};
    if (v === null) delete blocks[bid]; else blocks[bid] = v;
    tidy();
  };
  const dayInput = (value: number | undefined, key: string, label: string, onSet: (v: number | null) => void) =>
    h("input", {
      type: "number", class: "day-input", min: 1, max: scenario.days, value: value ?? "", "data-asm-due": key, "aria-label": label,
      oninput: (e: Event) => {
        const raw = (e.target as HTMLInputElement).value.trim();
        onSet(raw === "" ? null : Number(raw));
        ctx.onEdit(false);
      },
    });
  return h("div", { class: "asm-dues" },
    h("div", { class: "tabs asm-subtabs" }, scenario.orders.map((o) => h("button", {
      type: "button", class: `tab${ship === o.id ? " active" : ""}`,
      onclick: () => { ship = o.id; ctx.onEdit(true); },
    }, `${o.id} ${scenario.ship_types[o.type].name}`))),
    h("table", { class: "plan block-table" },
      h("thead", null, h("tr", null, h("th", null, "공정"), h("th", null, "공정 납기"), h("th", null, "블록 납기"))),
      h("tbody", null, activeStations(scenario).map((st) => {
        const b = bst.find((x) => x.id === st.id);
        return h("tr", null,
          h("th", null, h("i", { class: "swatch", style: { background: STATION_COLOR[st.id] } }), st.name),
          h("td", null,
            dayInput(config.due?.stations?.[sid]?.[st.id], `sdue:${sid}:${st.id}`, `${sid} ${st.name} 공정 납기`, (v) => setStationDue(st.id, v)),
            h("small", { class: "risk-note", "data-asm-risk": `${sid}:${st.id}`, hidden: true })),
          h("td", null, b
            ? h("div", { class: "block-chips" }, Array.from({ length: b.count }, (_, k) => {
              const bid = blockId(sid, st.id, k + 1);
              return h("span", { class: "block-chip" }, h("b", null, blockLabel(st.id, k + 1)),
                dayInput(config.due?.blocks?.[bid], `bdue:${bid}`, `${bid} 블록 납기`, (v) => setBlockDue(bid, v)));
            }))
            : h("small", { class: "hint" }, "배 한 척 단위")));
      }))),
    h("p", { class: "hint" }, "빈 칸은 인도 납기에서 역산한 기본값입니다. 공정 납기를 당기면 앞 공정의 기본 납기도 당겨집니다. 블록 납기는 \"납기 빠른 순\" 규칙이 쓰고, 지켰는지는 평가서에서 봅니다(등급 점수 밖)."));
}

/** 미리보기 값을 이 장에 채운다: 계획상 위험, 블록 일정 간트, 납기 자리 표시, 이 장에 해당하는 오류 */
export function updateAssemblySheet(root: HTMLElement, preview: Preview | null, errors: string[]): void {
  const ctx = current;
  if (!ctx || !blockStations(ctx.scenario).length) return;
  const { scenario, config } = ctx;
  if (preview) {
    lastPreview = preview;
    const planRisks = preview.plan_risks ?? [];
    const blockRisks = preview.block_plan?.risks ?? [];
    const box = root.querySelector<HTMLElement>("[data-asm='risks']");
    if (box) box.textContent = riskText(scenario, planRisks) + (blockRisks.length ? ` · 블록 납기를 넘기는 블록 ${blockRisks.length}개(블록 일정의 붉은 테두리)` : "");
    for (const el of root.querySelectorAll<HTMLInputElement>("[data-asm-due]")) {
      const key = el.dataset.asmDue!;
      const d = key.startsWith("sdue:") ? preview.dues?.stations?.[key.split(":")[1]]?.[key.split(":")[2]] : preview.dues?.blocks?.[key.slice(5)];
      if (d !== undefined) el.placeholder = key.startsWith("sdue:") ? `${d}일` : String(d);
    }
    root.querySelectorAll<HTMLElement>("[data-asm-risk]").forEach((el) => {
      const r = planRisks.find((x) => `${x.ship}:${x.station}` === el.dataset.asmRisk);
      el.hidden = !r;
      el.textContent = r ? `계획 끝 ${r.plan_end}일 (+${r.days})` : "";
      el.closest("tr")?.classList.toggle("at-risk", !!r);
    });
    const host = root.querySelector<HTMLElement>("[data-asm='gantt']");
    if (host && preview.block_plan && station) {
      const st = blockStations(scenario).find((b) => b.id === station)!;
      const custom = !!config.block_order?.[st.id];
      const n = (preview.block_plan.order[st.id] ?? []).filter((id) => preview.block_plan!.blocks[id].risk).length;
      mount(host,
        h("div", { class: "block-panel-head" },
          h("small", null, custom ? "정한 순서대로 들입니다" : `규칙(${DISPATCH_INFO[config.stations[st.id].dispatch ?? "ship"].name}) 순서입니다`,
            " · 줄을 위아래로 끌거나 Alt+↑/↓", n ? ` · 블록 납기를 넘기는 블록 ${n}개` : ""),
          custom ? h("button", {
            type: "button", class: "btn small",
            onclick: () => {
              delete config.block_order![st.id];
              if (!Object.keys(config.block_order!).length) delete config.block_order;
              ctx.onEdit(false);
            },
          }, "규칙 순서로 되돌리기") : null),
        renderBlockGantt({
          scenario, plan: preview.block_plan, station: st.id,
          onReorder: (order) => { (config.block_order ??= {})[st.id] = order; ctx.onEdit(false); },
        }),
        h("p", { class: "hint" }, "막대는 고장·대기 없이 이 순서로 했을 때의 계획, 세로 눈금은 블록 납기입니다. 위 줄일수록 먼저 들이지만, 아직 앞 공정에서 닿지 않은 블록은 기다리지 않고 다음 블록부터 합니다."));
    }
  }
  const mine = errors.filter(isAssemblyError);
  const errBox = root.querySelector<HTMLElement>("[data-asm='errors']");
  if (errBox) mount(errBox, mine.length ? h("ul", null, mine.map((e) => h("li", null, e))) : null);
}

/** 이 장에서 고칠 오류: 블록 납기("S1-SA1: …"), 공정 납기, 블록 순서, 우선순위 규칙 */
export function isAssemblyError(e: string): boolean {
  return /^S\d+-[A-Z]{2}\d+:/.test(e) || /공정 납기|블록 순서|블록 납기|우선순위 규칙|납기\(due\)/.test(e);
}

/** 인덱스 탭의 표시: 계획상 위험 수(공정 + 블록) */
export function assemblyBadge(preview: Preview | null): number {
  return (preview?.plan_risks?.length ?? 0) + (preview?.block_plan?.risks.length ?? 0);
}
