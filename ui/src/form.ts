// 왼쪽 계획 양식(생산계획서): ① 수주와 계획(배 요약 + 계획 간트) → ② [공통 | 배별] 탭 → 실행.
// 분기 고르기와 예시 계획은 서식 밖, 클립보드 위 책상에 있다(renderPlanBar).
// 입력 중에는 양식을 다시 그리지 않는다(그러면 커서가 사라진다). 값만 config에 넣고 알린다.
// 탭 전환도 hidden만 바꾼다. 처리량, 불량률, 고정비, 연구 일정, 발주일, 계획 막대는
// 서버의 /api/preview 결과를 data-preview 자리에 채운다.

import { activeStations, planStations, blockStations, completeConfig, staffTrades, type Config, type Crew, type Ordering, type Preset, type AbcRow, type Preview, type Scenario, type ScenarioOptions, type ScenarioSummary } from "./api";
import { h, mount, money, num, pct, s } from "./dom";
import { STATION_COLOR } from "./labels";
import { docHead } from "./paper";
import { conflictText, renderBufferGantt, renderPlanGantt } from "./plan-gantt";
import { renderShipSpec } from "./spec";

export interface FormContext {
  scenario: Scenario;
  scenarios: ScenarioSummary[];
  presets: Preset[];
  config: Config;
  presetId: string | null;
  edited: boolean;
  busy: boolean;
  /** 값이 바뀌었다. redraw가 true면 양식 전체를 다시 그린다. */
  onEdit(redraw: boolean): void;
  onPreset(id: string): void;
  /** 책상(첫 화면)으로 돌아가 다른 분기를 고른다. */
  onDesk(): void;
  onRun(): void;
  /** 4.25: 계획 간트에서 블록 공정 막대를 눌렀다 → 조립 공정 계획서(PP-02)의 그 공정 블록 일정으로 */
  onOpenAssembly?(station: string, ship: string): void;
}

// 다시 그려도 보던 탭을 유지한다.
let activeTab = "common";
// 미리보기가 도착하면 계획 간트를 다시 그려야 해서 마지막 양식의 상태를 들고 있는다.
let current: FormContext | null = null;

// 선박 사양서(4.17): 펼친 배와 그 배를 누른 양식. 양식은 생산계획서 화면 하나와 관제실의 펼친 계획서(읽기 전용,
// 그 회차의 설정)가 있으므로 양식 자리(root)마다 설정과 미리보기를 따로 들고 있는다. 미리보기가 새로 오면 펼친 사양서도 다시 그린다.
let spec: { ship: string; root: HTMLElement; ctx: FormContext } | null = null;
const previews = new WeakMap<HTMLElement, Preview>();
let specHost: HTMLElement | null = null;

function closeSpec(): void {
  spec = null;
  specHost?.remove();
  specHost = null;
  document.removeEventListener("keydown", onSpecKey);
}

function onSpecKey(e: KeyboardEvent): void {
  if (e.key === "Escape") closeSpec();
}

/** 사양서를 펼치거나(next) 펼친 것을 새 값으로 다시 그린다(next 없음) */
function showSpec(next?: typeof spec): void {
  if (next) spec = next;
  if (!spec) return;
  const { scenario, config } = spec.ctx;
  if (!scenario.orders.some((o) => o.id === spec!.ship)) return closeSpec();
  if (!specHost) {
    specHost = h("div", { class: "spec-backdrop", onclick: (e: Event) => { if (e.target === specHost) closeSpec(); } });
    document.body.append(specHost);
    document.addEventListener("keydown", onSpecKey);
  }
  mount(specHost, renderShipSpec(scenario, config, previews.get(spec.root) ?? null, spec.ship, closeSpec));
}

// 아코디언(접기, 4.14): 칸마다 열림 상태를 기억해 양식을 다시 그려도 그대로 둔다. 계획 간트는 접지 않는다.
const FOLD_DEFAULT: Record<string, boolean> = { orders: false, people: true, shared: false, material: false, stations: false, research: false };
const folds = new Map<string, boolean>();
const isOpen = (key: string) => folds.get(key) ?? FOLD_DEFAULT[key] ?? true;

/** 접는 칸: 제목 줄(번호, 제목, 설명)과 접었을 때도 보이는 요약(data-fold-sum, 미리보기 때마다 새로 쓴다) */
function fold(key: string, head: (HTMLElement | string | null)[], cls: string, ...children: (HTMLElement | null)[]): HTMLElement {
  const box = h("details", { class: `fold ${cls}`, open: isOpen(key), "data-fold": key },
    h("summary", null, ...head, h("span", { class: "fold-sum", "data-fold-sum": key })),
    ...children);
  box.addEventListener("toggle", () => { folds.set(key, (box as HTMLDetailsElement).open); });
  return box;
}

/** 접은 칸 제목 줄에 보일 지금 고른 값. 화면 문구일 뿐 규칙 계산은 하지 않는다. */
function foldSummaries(ctx: FormContext): Record<string, string> {
  const { scenario, config } = ctx;
  const opts = openOptions(scenario);
  const staff = staffTrades(scenario);
  const pools = config.pools ?? {};
  const asm = new Set(planStations(scenario).map((b) => b.id));   // 조립 공정은 PP-02에 있어 요약에서 뺀다(4.28.1, 4.32: PE장은 여기)
  const act = activeStations(scenario).filter((s) => !asm.has(s.id));
  const st = (id: string) => config.stations[id];
  const names = (f: (id: string) => boolean) => act.filter((s) => f(s.id)).map((s) => s.name);
  const listOr = (xs: string[], none = "없음") => (xs.length ? xs.join("·") : none);
  const byPriority = Object.entries(config.ships).sort((a, b) => a[1].priority - b[1].priority).map(([sid]) => sid);
  const ordering = config.ordering ?? "jit";
  const safety = Object.entries(config.safety_stock ?? {}).map(([m, n]) => `${scenario.materials.find((x) => x.id === m)?.name ?? m} ${n}척분`);
  const cheap = Object.entries(config.materials ?? {}).filter(([, g]) => g === "cheap").map(([m]) => scenario.materials.find((x) => x.id === m)?.name ?? m);
  const tr = config.transporters as { count?: number; maintenance: boolean };
  return {
    orders: `${byPriority.length}척 · 우선순위 ${byPriority.join(" → ")}`,
    people: `${staff.map(([t, info]) => `${info.name} ${pools[t] ?? 0}`).join(" · ")} (${Object.values(pools).reduce((a, b) => a + b, 0)}명)`,
    shared: `트랜스포터 ${tr.count ?? 1}대${tr.maintenance ? "(정비)" : ""} · 지게차 ${config.forklifts?.count ?? 1}대${config.forklifts?.maintenance ? "(정비)" : ""}`,
    material: [scenario.ordering[ordering].name, ordering === "jit" && opts.jit_buffer ? `여유 ${config.jit_buffer ?? 0}일` : null,
      opts.safety_stock ? `안전 재고 ${listOr(safety)}` : null, cheap.length ? `저가 ${cheap.join("·")}` : null].filter(Boolean).join(" · "),
    stations: [`증설 ${listOr(names((id) => (st(id).units ?? 1) > 1))}`, `숙련공 ${listOr(names((id) => st(id).crew === "skilled"))}`,
      opts.crews.includes("robot") ? `로봇 ${listOr(names((id) => st(id).crew === "robot"))}` : null,
      `잔업 ${listOr(names((id) => !!st(id).overtime))}`,
      opts.plan_buffer ? `여유 ${act.reduce((n, s) => n + (st(s.id).buffer ?? 0), 0)}일` : null,
      // 4.32: 공정별 비상 예산(조치 요청용)
      scenario.decision_stations && scenario.contingency
        ? `비상 예산 ${listOr(planStations(scenario).filter((b) => st(b.id).dispatch_mode === "manual")
          .map((b) => `${b.name} ${config.contingency?.[b.id] ?? scenario.contingency![b.id] ?? 0}`))}` : null,
      // 4.35: 작업장 적치 한도
      opts.queue_cap ? `적치 한도 ${listOr(planStations(scenario).filter((b) => st(b.id).queue_cap).map((b) => `${b.name} ${st(b.id).queue_cap}개`))}` : null,
    ].filter(Boolean).join(" · "),
    research: config.research.length ? config.research.map((r) => scenario.research[r]?.name ?? r).join(" → ") : "없음",
  };
}

function refreshFoldSummaries(root: HTMLElement): void {
  if (!current) return;
  const sums = foldSummaries(current);
  root.querySelectorAll<HTMLElement>("[data-fold-sum]").forEach((el) => { el.textContent = sums[el.dataset.foldSum!] ?? ""; });
}

function segmented<T extends string | number>(
  name: string, options: { value: T; label: string }[], current: T, onPick: (value: T) => void,
): HTMLElement {
  return h("div", { class: "seg", role: "radiogroup" },
    options.map((option) =>
      h("label", { class: "seg-item" },
        h("input", {
          type: "radio", name, checked: option.value === current,
          onchange: () => onPick(option.value),
        }),
        h("span", null, option.label),
      )));
}

function toggle(label: string, checked: boolean, onToggle: (on: boolean) => void): HTMLElement {
  return h("label", { class: "toggle" },
    h("input", { type: "checkbox", checked, onchange: (e: Event) => onToggle((e.target as HTMLInputElement).checked) }),
    h("span", { class: "toggle-track" }),
    h("span", null, label));
}

function showTab(root: HTMLElement, tab: string): void {
  activeTab = tab;
  root.querySelectorAll<HTMLElement>("[data-pane]").forEach((pane) => { pane.hidden = pane.dataset.pane !== tab; });
  root.querySelectorAll<HTMLElement>("[data-tab]").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tab));
}

/**
 * 생산계획서 위 왼쪽: "← 분기 고르기"와 지금 분기. 안과 분기의 설명은 오른쪽 포스트잇(renderPlanNotes).
 */
export function renderPlanBar(root: HTMLElement, ctx: FormContext): void {
  const { scenario } = ctx;
  mount(root,
    h("button", { class: "bar-back", type: "button", title: "책상으로 돌아가 다른 반기의 클립보드를 고릅니다", onclick: ctx.onDesk },
      "← 반기 고르기"),
    h("span", { class: "bar-quarter" }, scenario.period, h("small", null, ` ${scenario.name}`)));
}

/**
 * 생산계획서 오른쪽에 붙인 포스트잇: 고른 안의 설명, 분기 메모. 서식 안이 아니라 종이 옆에 붙인 메모다.
 * (목표와 이번 세션 최고 포스트잇은 회차를 아는 main.ts가 붙인다.)
 */
export function renderPlanNotes(root: HTMLElement, ctx: FormContext): void {
  const { scenario } = ctx;
  const activePreset = ctx.presets.find((p) => p.id === ctx.presetId);
  mount(root,
    h("div", { class: "postit" },
      activePreset
        ? [h("b", null, planLabel(ctx.presets, activePreset.id)), h("em", { class: "edited", hidden: !ctx.edited }, "수정함"),
          h("p", null, activePreset.summary)]
        : [h("b", null, "직접 정한 계획"), h("p", null, "예시 안을 바탕으로 하지 않은 계획입니다.")]),
    h("div", { class: "postit blue" },
      h("b", null, `${scenario.period} · ${scenario.name}`),
      h("p", null, scenario.summary),
      // 분기별 옵션(D33): 새로 열린 것이 곧 이 분기에서 배울 것
      scenario.unlocks
        ? h("p", { class: "postit-unlock" }, h("b", null, (scenario.level ?? 1) > 1 ? "새로 쓸 수 있는 것 " : "이 반기 "), scenario.unlocks)
        : null));
}

/** 예시 계획의 이름: 프리셋 순서대로 A안, B안, C안. 회사 서류에서 대안을 비교할 때 쓰는 말이다. */
export function planLabel(presets: Preset[], id: string): string {
  const i = presets.findIndex((p) => p.id === id);
  return i < 0 ? "" : `${String.fromCharCode(65 + i)}안 ${presets[i].name}`;
}

/**
 * 생산계획서 왼쪽 가장자리의 인덱스 탭: A안 · B안 · C안. 서류철의 칸막이 탭처럼 판 밖으로 나와 있다.
 * 고른 안을 고친 뒤 다른 안을 누르면 고친 내용이 사라지므로 먼저 묻는다.
 */
export function renderPlanTabs(root: HTMLElement, ctx: FormContext): void {
  mount(root, ctx.presets.map((preset, i) => {
    const active = preset.id === ctx.presetId;
    return h("button", {
      class: `plan-tab${active ? " active" : ""}`, type: "button", title: preset.summary, disabled: ctx.busy,
      "aria-pressed": active ? "true" : "false",
      onclick: () => {
        if (active && !ctx.edited) return;
        const message = active ? `${preset.name} 안을 처음 상태로 되돌릴까요? 고친 내용이 사라집니다.`
          : ctx.edited ? "고친 내용이 사라집니다. 다른 안을 불러올까요?" : "";
        if (message && !window.confirm(message)) return;
        ctx.onPreset(preset.id);
      },
    },
    h("b", null, `${String.fromCharCode(65 + i)}안`),
    h("small", null, preset.name),
    active ? h("em", { class: "tab-edited", hidden: !ctx.edited }, "수정") : null);
  }));
}

export function renderForm(root: HTMLElement, ctx: FormContext): void {
  current = ctx;
  const { scenario, config } = ctx;
  completeConfig(config, scenario);   // 3.x 프리셋·회차에 없는 공정과 직종 인원을 기본값으로(4.0)
  const orderIds = scenario.orders.map((o) => o.id);
  const openSpec = (sid: string) => () => showSpec({ ship: sid, root, ctx });
  const pb = scenario.project_buffer;   // 4.36(D84): 프로젝트 버퍼 시나리오

  // ① 수주와 계획: 4척 요약 줄과 계획 간트. 우선순위는 겹치면 맞바꾸고, 착수 예정일은 간트에서 끌어 정한다.
  const summary = h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("span", { class: "step" }, "1"), h("h2", null, "수주와 계획")),
    // 4.36(사용자): 수주 목록은 접지 않고 늘 펼쳐 둔다
    h("div", { class: "orders-block" }, h("b", { class: "fold-title" }, "수주 목록과 우선순위"),
    h("table", { class: "plan" },
      h("thead", null, h("tr", null,
        h("th", null, "배"), h("th", null, "선종"), h("th", { class: "r" }, "납기"), h("th", { class: "r" }, "계약금"),
        h("th", null, "우선순위"), pb ? h("th", null, "버퍼") : null, h("th", null, pb ? "착수(계획)" : "착수 예정일"))),
      h("tbody", null, scenario.orders.map((order) => {
        const ship = config.ships[order.id];
        return h("tr", null,
          // 배 이름을 누르면 선박 사양서(4.17)
          h("td", null, h("button", { type: "button", class: "spec-link", title: `${order.id} 선박 사양서`, onclick: openSpec(order.id) }, order.id)),
          h("td", null, h("button", { type: "button", class: "spec-link plain", title: `${order.id} 선박 사양서`, onclick: openSpec(order.id) }, scenario.ship_types[order.type].name)),
          // 공정 여유(4.15)를 넣으면 미리보기의 납기·선가로 바뀐다
          h("td", { class: "r" }, h("span", { "data-preview": `due:${order.id}` }, `${order.due_day}일`)),
          h("td", { class: "r" }, h("span", { "data-preview": `price:${order.id}` }, num(order.price))),
          h("td", null, h("select", {
            class: "priority",
            onchange: (e: Event) => {
              const next = Number((e.target as HTMLSelectElement).value);
              const other = orderIds.find((id) => id !== order.id && config.ships[id].priority === next);
              if (other) config.ships[other].priority = ship.priority;
              ship.priority = next;
              ctx.onEdit(true);
            },
          }, orderIds.map((_, k) => h("option", { value: k + 1, selected: ship.priority === k + 1 }, `${k + 1}순위`)))),
          // 프로젝트 버퍼(4.36, D84): 버퍼를 고르면 엔진이 착수일을 거꾸로 잡는다(미리보기가 채운다)
          pb ? h("td", null, h("select", {
            class: "priority", "aria-label": `${order.id} 버퍼`,
            onchange: (e: Event) => { ship.buffer = Number((e.target as HTMLSelectElement).value); ctx.onEdit(false); },
          }, Array.from({ length: pb.max_days + 1 }, (_, k) => h("option", { value: k, selected: (ship.buffer ?? pb.default_days) === k }, `${k}일`)))) : null,
          h("td", null, h("b", { "data-preview": `start:${order.id}` }, pb ? "…" : `${ship.start_day}일`)));
      }))),
    h("p", { class: "hint" }, "작업장, 사람, 운반 모두 우선순위 순으로 받습니다. 배를 누르면 선박 사양서(외형, BOM, 인력, 공법, 인도 기준)가 펼쳐집니다.")),
    // 계획 간트는 늘 보인다(접지 않는다). 프로젝트 버퍼(4.36)는 배별 막대 하나
    ...(pb ? [
      h("div", { class: "plan-head" }, h("b", null, "계획 간트"),
        h("small", null, "배마다 착수 ~ 계획 완료, 그 뒤 버퍼와 납기. 버퍼는 위 수주 목록에서 고릅니다.")),
      h("div", { class: "plan-host", "data-plan": "" }),
      h("div", { class: "legend plan-legend" },
        h("span", null, h("i", { class: "buffer-work-mark" }), "계획 작업"),
        h("span", null, h("i", { class: "buffer-zone-mark" }), "버퍼"),
        h("span", null, h("i", { class: "buffer-extra-mark" }), "덤 여유"),
        h("span", null, h("i", { class: "buffer-short-mark" }), "버퍼 부족"),
        h("span", null, h("i", { class: "due-mark" }), "납기")),
      h("p", { class: "buffer-cost-line", "data-preview": "buffer-cost" }, "…"),
      h("p", { class: "hint" }, "계획 작업은 불량·고장·사고·입고 지연 없이 돌린 결과라, 계획대로면 모든 블록이 제때 끝나고 납기를 지킵니다. ",
        "버퍼를 늘리면 착수가 당겨져 변수에 강해지지만, 일찍 끝난 배는 납기일까지 안벽에서 기다리며 보관비(하루 선가의 ",
        `${Math.round(pb.storage_rate_per_day * 1000) / 10}%)를 내고 자재도 일찍 들어와 재고비가 늡니다. 생산 중 블록이 계획보다 늦어 버퍼를 소모할 것 같으면 관제실이 조치 요청로 묻습니다.`),
    ] : [
    h("div", { class: "plan-head" },
      h("b", null, "계획 간트"),
      h("small", null, "배 줄을 좌우로 끌거나, 줄을 누르고 ←/→로 착수 예정일을 옮깁니다.")),
    h("div", { class: "plan-host", "data-plan": "" }),
    h("div", { class: "legend plan-legend" },
      activeStations(scenario).map((st) => h("span", null, h("i", { style: { background: STATION_COLOR[st.id] } }), st.name)),
      h("span", null, h("i", { class: "plan-overlap" }), "작업장 겹침"),
      openOptions(scenario).plan_buffer ? h("span", null, h("i", { class: "plan-buffer-mark" }), "공정 여유") : null,
      h("span", null, h("i", { class: "due-mark" }), "납기")),
    h("p", { class: "hint", "data-preview": "conflicts" }),
    h("p", { class: "hint" }, "막대는 배 한 척이 작업장을 혼자 쓸 때의 일정입니다. 겹치는 날은 뒤 순위 배가 기다립니다.",
      scenario.block_mode ? ` ${blockStations(scenario).map((b) => b.name).join("·")} 막대를 누르면 조립 공정 계획서(위 탭)의 그 배 블록 일정으로 갑니다.` : ""),
    ]),
  );

  // ② 탭
  const tabs = [{ id: "common", label: "공통" }, ...orderIds.map((id) => ({ id, label: id }))];
  const tabBar = h("div", { class: "tabs form-tabs", role: "tablist" },
    tabs.map((t) => h("button", {
      type: "button", class: "tab", "data-tab": t.id, role: "tab",
      onclick: () => showTab(root, t.id),
    }, t.label, h("span", { class: "warn", "data-warn": t.id, hidden: true }, " ⚠"))));

  const panes = h("div", { class: "panes" }, commonPane(ctx), orderIds.map((sid) => shipPane(ctx, sid, openSpec(sid))));

  const settings = h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("span", { class: "step" }, "2"), h("h2", null, "자원과 일정")),
    tabBar, panes);

  // 승인 버튼은 서식 밖, 화면 오른쪽 아래(main.ts). 서식 끝에는 고칠 곳(오류)만 남긴다.
  const runSection = h("section", { class: "run-bar" },
    h("div", { class: "errors", "data-preview": "errors" }));

  const head = docHead({
    title: "생산계획서", period: scenario.period, code: "PP-01", approved: false,
    fields: [
      ["계획 기간", `${scenario.period} (작업일 ${scenario.days}일)`],
      ["수주", `${orderIds.length}척 (${orderIds[0]}~${orderIds[orderIds.length - 1]})`],
    ],
  });

  mount(root, head, summary, settings, runSection);
  if (spec?.root === root) showSpec({ ...spec, ctx });   // 분기를 바꾸면 그 배가 없을 때 닫는다
  refreshFoldSummaries(root);
  showTab(root, activeTab);
}

/** 분기가 열어 둔 옵션(D33). 시나리오에 없으면 모두 연다. */
export function openOptions(scenario: FormContext["scenario"]): ScenarioOptions {
  return scenario.options ?? {
    crews: Object.keys(scenario.rules.crews) as Crew[], methods: Object.keys(scenario.rules.methods),
    material_grades: Object.keys(scenario.material_grades), max_units: scenario.expansion.max_units, split: true, hoist: true, jit_buffer: true, safety_stock: true, plan_buffer: true,
  };
}

/** 공정 카드 머리글의 자리와 기본 설비. 자리 이름이 설비와 같으면(탑재 = 골리앗 크레인) 한 번만 */
function stationPlace(st: FormContext["scenario"]["stations"][number]): string {
  const place = st.real.split(":")[0];
  const eq = st.equipment === false ? "설비 없음(바다)" : st.equipment ?? "";
  return !eq || place === eq ? place : `${place} · ${eq}`;
}

function commonPane(ctx: FormContext): HTMLElement {
  const { scenario, config } = ctx;
  const opts = openOptions(scenario);

  // 작업대기소는 하나, 사람마다 직종이 있다(4.0, D42). 사람은 자기 직종 공정에만 간다. 시운전도 직종이다(4.22, D69).
  // 시운전 인원을 고정한 분기(간이공정)는 고르지 않고 값만 적는다.
  const pools = config.pools!;
  const pool = h("div", { class: "pools" },
    staffTrades(scenario).map(([t, info]) => {
      const fixed = t === "trial" && opts.trial_pools?.length === 1;
      return h("div", { class: "field-row" },
        h("span", { class: "field-label" }, `${info.name} 인원`),
        fixed
          ? h("b", null, String(pools[t]))
          : segmented(`pool-${t}`,
            Array.from({ length: info.max ?? 6 }, (_, k) => ({ value: k + 1, label: String(k + 1) })),
            pools[t], (v) => { pools[t] = v; config.pool = Object.values(pools).reduce((a, b) => a + b, 0); ctx.onEdit(false); }),
        h("small", null, `명${fixed ? "(고정)" : ""} · ${activeStations(scenario).filter((st) => st.trade === t).map((st) => st.name).join("·")}`));
    }));

  // 블록 트랜스포터(4.8): 수주 증가부터 1~2대를 고른다. 두 대면 서로 다른 배를 같은 날 나른다(대마다 운행비·정비비).
  const trc = opts.transporter_counts ?? [1];
  const tr = config.transporters as { count: number; maintenance: boolean };
  const transporter = h("div", { class: "field-row" },
    h("span", { class: "field-label" }, "트랜스포터"),
    trc.length > 1
      ? segmented("transporters", trc.map((n) => ({ value: n, label: String(n) })), tr.count, (v) => { tr.count = v; ctx.onEdit(false); })
      : h("b", null, String(tr.count)),
    h("small", null, `대${trc.length > 1 ? "" : "(고정)"} · 블록(소조립 이후 공정 사이)${trc.length > 1 ? " · 두 대면 두 배를 함께 나른다" : ""}`),
    toggle("정비", tr.maintenance, (on) => { tr.maintenance = on; ctx.onEdit(false); }));
  // 공용 지게차(4.3, D46): 작업자처럼 차고에 몇 대를 둘지 고른다. 자재 키트와 가공 → 소조립 부재 팔레트를 나른다.
  const fk = config.forklifts!;
  const counts = opts.forklift_counts ?? Array.from({ length: scenario.forklift.max_count }, (_, k) => k + 1);
  const forklift = h("div", { class: "field-row" },
    h("span", { class: "field-label" }, "지게차"),
    counts.length > 1
      ? segmented("forklifts", counts.map((n) => ({ value: n, label: String(n) })), fk.count, (v) => { fk.count = v; ctx.onEdit(false); })
      : h("b", null, String(fk.count)),
    h("small", null, `대${counts.length > 1 ? "" : "(고정)"} · 자재 키트, 가공 → 소조립 팔레트 · 한 대에 하루 ${scenario.forklift.jobs_per_day}건`),
    toggle("정비", fk.maintenance, (on) => { fk.maintenance = on; ctx.onEdit(false); }));

  // 블록 실습(4.28.1, 사용자): 조립 공정(소조립·중조립·PE장) 카드는 조립 공정 계획서(PP-02)로 옮겼다.
  // 조립 현장 배정(4.32, 사용자): 직접 대응 공정(소조립·중조립)만 PP-02, PE장은 여기
  const asm = new Set(planStations(scenario).map((b) => b.id));
  const stationCards = activeStations(scenario).filter((st) => !asm.has(st.id)).map((st) => stationCard(ctx, st));

  const orderings = Object.entries(scenario.ordering) as [Ordering, { name: string; summary: string }][];
  const ordering = h("div", { class: "field-row" },
    h("span", { class: "field-label" }, "자재 발주"),
    segmented("ordering", orderings.map(([id, o]) => ({ value: id, label: o.name })),
      config.ordering ?? "jit", (v) => { config.ordering = v; ctx.onEdit(true); }));
  // 역산 발주 여유일(4.13, D59): 수주 증가부터. 입고 지연을 여유일로 메우고, 그만큼 재고비를 낸다.
  const jit = scenario.ordering.jit;
  const buffer = opts.jit_buffer && (config.ordering ?? "jit") === "jit"
    ? h("div", { class: "field-row" },
      h("span", { class: "field-label" }, "역산 여유"),
      segmented("jit-buffer", Array.from({ length: (jit.buffer_max ?? 0) + 1 }, (_, k) => ({ value: k, label: `${k}일` })),
        config.jit_buffer ?? jit.buffer_days ?? 0, (v) => { if (v) config.jit_buffer = v; else delete config.jit_buffer; ctx.onEdit(false); }),
      h("small", null, "필요일보다 며칠 더 일찍 들어오게 발주한다"))
    : null;
  const orderingHint = h("p", { class: "hint field-hint" },
    scenario.ordering[config.ordering ?? "jit"].summary,
    scenario.supply_delays
      ? " 이 분기에는 입고 지연이 있습니다: 발주 몇 건은 늦게 들어오고, 확률과 일수는 자재마다 다릅니다(아래 ABC 분석). 어느 발주인지는 미리 알 수 없습니다."
      : "",
    ` 배별 발주일은 ${scenario.orders[0].id}~${scenario.orders[scenario.orders.length - 1].id} 탭에 있습니다.`);

  // 서식 칸을 4M 순서로 나눈다: 사람 → 공용 설비 → 자재 → 공정(공정마다 인력·공법·설비) → 연구
  const keys = ["people", "shared", "material", "stations", "research"];
  const sec = (no: number, title: string, note: string | null, ...children: (HTMLElement | null)[]) =>
    fold(keys[no - 1], [h("span", { class: "sec-no" }, String(no)), h("b", { class: "fold-title" }, title), note ? h("small", { class: "fold-note" }, note) : null],
      "form-sec", h("div", { class: "fold-body" }, ...children));
  return h("div", { class: "pane", "data-pane": "common" },
    sec(1, "사람", "직종별 대기소 인원 · 사람은 자기 직종 공정에만 간다", pool),
    sec(2, "공용 설비", "공정 사이를 나르는 운반 설비 · 공정의 설비는 4번 공정 카드에", transporter, forklift),
    sec(3, "자재", ["발주 방식", opts.material_grades.includes("cheap") ? "등급" : null, opts.safety_stock ? "안전 재고" : null].filter(Boolean).join(" · "), ordering, buffer, orderingHint,
      opts.material_grades.includes("cheap") || opts.safety_stock
        ? materialTable(ctx, opts.material_grades.includes("cheap"), !!opts.safety_stock) : null),
    sec(4, "공정", `공정마다 인력 · 공법 · 설비 운영 · 작업장 수${opts.plan_buffer ? " · 여유" : ""}`, h("div", { class: "stations" }, stationCards),
      asm.size ? h("p", { class: "hint field-hint" }, `조립 공정(${planStations(scenario).map((b) => b.name).join("·")})은 조립 공정 계획서(PP-02, 위 탭)에서 블록 배치 정책${scenario.contingency ? "·대응·비상 예산" : ""}과 함께 정합니다.`) : null),
    sec(5, "연구", null, researchQueue(ctx)),
    h("p", { class: "hint fixed" },
      "고정비: 인건비 ", h("b", { "data-preview": "labor" }, "…"),
      " · 정비비 ", h("b", { "data-preview": "maintenance" }, "…"),
      " · 운반 설비 ", h("b", { "data-preview": "transporter" }, "…"),
      " · 설비 투자비 ", h("b", { "data-preview": "investment" }, "…"),
      " · 연구비 ", h("b", { "data-preview": "research" }, "…")));
}

/** 공정 카드 하나(인력·공법·운영·작업장 수·여유, 미리보기의 최대 처리량·불량률 자리). 생산계획서 ②-4와 조립 공정 계획서가 같이 쓴다.
 *  lead: 카드 칸 맨 앞에 넣을 [이름, 칸] 쌍(조립 공정 계획서의 우선순위 규칙). compact: 고를 것이 하나뿐인 인력·공법 줄은 그리지 않는다 */
export function stationCard(ctx: StationCardContext, st: Scenario["stations"][number],
  extra: { lead?: (HTMLElement | null)[]; compact?: boolean; note?: string; fixed?: string } = {}): HTMLElement {
  const { scenario, config } = ctx;
  const opts = openOptions(scenario);
  // 쉬운 분기에서는 가린 옵션을 아예 그리지 않는다(D33).
  const methods = Object.entries(scenario.rules.methods).filter(([id]) => opts.methods.includes(id));
  // 공정마다 작업장 수 상한: 분기 상한과 공정 상한(탑재 도크는 크레인이 있어야 해 2곳) 중 작은 것
  const unitCap = (pid: string) => Math.min(opts.max_units, scenario.expansion.max_units_by_station?.[pid] ?? opts.max_units);
  const crews = (Object.entries(scenario.rules.crews) as [Crew, { name: string; summary: string; install_cost?: number }][])
    .filter(([id]) => opts.crews.includes(id));
  const hoist = scenario.rules.hoist;
  const cfg = config.stations[st.id];
  // 1.x 설정의 시니어는 그 공정의 숙련공으로 옮겨 적는다(엔진도 같이 읽는다).
  if (config.skilled_station) {
    config.stations[config.skilled_station].crew ??= "skilled";
    config.skilled_station = null;
  }
  const trial = st.trade === "trial";   // 시운전팀(4.22): 인력·잔업을 고르지 않고 인원은 대기소에서 정한다
  const crew = cfg.crew ?? "normal";
  const robot = crew === "robot";
  const showCrew = !extra.compact || trial || crews.length > 1;
  const showMethod = !extra.compact || methods.length > 1;
  return h("div", { class: "station", style: { "--station": STATION_COLOR[st.id] } as Record<string, string> },
    // 머리글: 공정 · 자리 · 기본 설비(4.12.1, 4M의 설비, 고장은 이 설비가 난다)
    h("div", { class: "station-head" },
      h("span", { class: "swatch" }),
      h("b", null, st.name),
      h("small", null, extra.note ?? stationPlace(st))),
    h("div", { class: "station-grid" },
      ...(extra.lead ?? []),
      showCrew ? h("span", { class: "field-label" }, "인력") : null,
      !showCrew ? null : trial
        ? h("span", { class: "hint", title: scenario.rules.crews.trial?.summary }, "시운전팀 · 인원은 작업대기소에서 정한다")
        : segmented(`crew-${st.id}`, crews.map(([id, c]) => ({
          value: id, label: c.install_cost ? `${c.name} (+${num(c.install_cost * (cfg.units ?? 1))})` : c.name,
        })), crew, (v) => { if (v === "normal") delete cfg.crew; else cfg.crew = v; ctx.onEdit(true); }),
      showMethod ? h("span", { class: "field-label" }, "공법") : null,
      !showMethod ? null : segmented(`method-${st.id}`, methods.map(([id, m]) => ({ value: id, label: m.name })),
        cfg.method, (v) => { cfg.method = v; ctx.onEdit(false); }),
      // 4.32(사용자): 조립 현장 배정의 조립 공정은 운영(잔업·정비)과 작업장 수를 고르지 않는다(고정 문구 한 줄)
      extra.fixed ? h("span", { class: "field-label" }, "운영") : null,
      extra.fixed ? h("span", { class: "hint" }, extra.fixed) : null,
      extra.fixed ? null : h("span", { class: "field-label" }, "운영"),
      extra.fixed ? null : h("div", { class: "toggles" },
        trial ? null
          : robot
            ? h("span", { class: "hint", title: scenario.rules.crews.robot.summary }, "로봇은 잔업 없음")
            : toggle("잔업", cfg.overtime, (on) => { cfg.overtime = on; ctx.onEdit(false); }),
        // 설비가 없는 공정(시운전, 4.12)은 정비를 고르지 않는다
        st.equipment === false
          ? h("span", { class: "hint" }, "정비 없음")
          : toggle("정비", cfg.maintenance, (on) => { cfg.maintenance = on; ctx.onEdit(false); }),
        // 나눠 하기(3.0): 탑재·안벽의장·시운전은 배 한 척이 통째로 들어가서 나누지 않는다(공정의 split).
        st.split === false || !opts.split
          ? null
          : toggle("나눠 하기", cfg.split ?? false, (on) => { if (on) cfg.split = true; else delete cfg.split; ctx.onEdit(false); }),
        // 호이스트(4.9): 소조립·중조립 정반 위 천장 크레인. 수주 증가부터(작업장마다 도입비)
        !st.hoist || !opts.hoist
          ? null
          : h("span", { title: hoist.summary },
            toggle(`호이스트 (+${num(hoist.install_cost * (cfg.units ?? 1))})`, cfg.hoist ?? false,
              (on) => { if (on) cfg.hoist = true; else delete cfg.hoist; ctx.onEdit(false); }))),
      // 4.37(D85, 사용자 "가"): 운영을 고정한 카드(조립 현장 배정)도 작업장 수는 고른다(정반을 늘릴까, 사람을 늘릴까)
      unitCap(st.id) > 1 ? h("span", { class: "field-label" }, "작업장") : null,
      unitCap(st.id) <= 1 ? null : segmented(`units-${st.id}`,
        Array.from({ length: unitCap(st.id) }, (_, k) => ({
          value: k + 1, label: k === 0 ? "1개" : `${k + 1}개 (+${num(scenario.expansion.cost[st.id] * k)})`,
        })),
        cfg.units ?? 1, (v) => { if (v > 1) cfg.units = v; else delete cfg.units; ctx.onEdit(false); }),
      // 공정 여유(4.15, D62): 기본 반기부터. 여유 하루마다 모든 배의 납기 +1일, 선가 −1%
      opts.plan_buffer ? h("span", { class: "field-label", title: "선주에게 약속하는 납기에 이 공정의 여유를 넣는다. 배는 기다리지 않는다." }, "여유") : null,
      !opts.plan_buffer ? null : segmented(`buffer-${st.id}`,
        Array.from({ length: scenario.plan_buffer.max_days + 1 }, (_, k) => ({ value: k, label: k ? `${k}일 (−${num(k * scenario.plan_buffer.price_cut_per_day * 100, 0)}%)` : "없음" })),
        cfg.buffer ?? 0, (v) => { if (v) cfg.buffer = v; else delete cfg.buffer; ctx.onEdit(false); }),
    ),
    h("div", { class: "station-preview" },
      h("span", null, "최대 ", h("b", { "data-preview": `rate:${st.id}` }, "…"), "/일"),
      h("span", null, "불량률 ", h("b", { "data-preview": `defect:${st.id}` }, "…"))),
  );
}

/** 미리보기의 공정별 최대 처리량·불량률을 카드 자리에 채운다(생산계획서·조립 공정 계획서) */
export function fillStationPreview(root: ParentNode, preview: Preview): void {
  for (const [id, st] of Object.entries(preview.stations)) {
    const rate = root.querySelector<HTMLElement>(`[data-preview="rate:${id}"]`);
    const defect = root.querySelector<HTMLElement>(`[data-preview="defect:${id}"]`);
    if (rate) rate.textContent = num(st.rate, 3);
    if (defect) {
      defect.textContent = st.defect_rate_final === st.defect_rate
        ? pct(st.defect_rate, 0)
        : `${pct(st.defect_rate, 0)} → ${pct(st.defect_rate_final, 0)}`;
    }
  }
}

/** 공정 카드가 쓰는 것: 시나리오, 설정, 값이 바뀌었을 때(redraw면 그 서식을 다시 그림) */
export interface StationCardContext {
  scenario: Scenario;
  config: Config;
  onEdit(redraw: boolean): void;
}

/** 자재별 선택(4M의 Material)을 한 표에: 자재마다 한 줄에 등급과 안전 재고(4.14).
 *  등급: 저가는 단가가 반이고 그 자재를 쓰는 공정의 불량이 늘어난다.
 *  안전 재고: 1일에 발주해 리드타임 뒤 들어오는 공용 재고, 재고비만. 수량은 미리보기(엔진)가 채운다. */
function materialTable(ctx: FormContext, grades: boolean, safety: boolean): HTMLElement {
  const { scenario, config } = ctx;
  const cheap = scenario.material_grades.cheap;
  const used = Object.fromEntries(activeStations(scenario).filter((st) => st.material).map((st) => [st.material!, st.name]));
  // 이 분기에 쓰는 자재만(보냉재는 LNG선이 있을 때만)
  const mats = scenario.materials.filter((m) => scenario.orders.some((o) => (scenario.ship_types[o.type]?.bom[m.id] ?? 0) > 0));
  const notes = [
    grades ? `저가 = 단가 ${Math.round(cheap.price_factor * 100)}%, 쓰는 공정 불량률 +${Math.round(cheap.defect_add * 100)}%p` : null,
    safety ? "안전 재고 = 1일에 발주해 리드타임 뒤 들어오는 공용 재고, 늦게 온 몫을 메운다 · 재고비만(1척분 = 그 자재를 가장 많이 쓰는 배 한 척 몫)" : null,
  ].filter(Boolean).join(" · ");
  return h("div", { class: "materials" },
    h("table", { class: "mat-table" },
      h("thead", null, h("tr", null, h("th", null, "자재"), grades ? h("th", null, "등급") : null, safety ? h("th", { colspan: 2 }, "안전 재고") : null)),
      h("tbody", null, mats.map((m) => h("tr", null,
        h("td", null, h("b", null, m.name), h("small", null, ` ${used[m.id] ?? ""}`)),
        grades ? h("td", null, segmented(`grade-${m.id}`, [
          { value: "standard" as const, label: `표준 ${num(m.price)}` },
          { value: "cheap" as const, label: `${m.cheap_name} ${num(m.price * cheap.price_factor)}` },
        ], config.materials?.[m.id] ?? "standard", (v) => {
          const next = { ...(config.materials ?? {}) };
          if (v === "standard") delete next[m.id]; else next[m.id] = v;
          if (Object.keys(next).length) config.materials = next; else delete config.materials;
          ctx.onEdit(false);
        })) : null,
        safety ? h("td", null, segmented(`safety-${m.id}`, scenario.safety_stock.levels.map((n) => ({ value: n, label: n ? `${n}척분` : "없음" })),
          config.safety_stock?.[m.id] ?? 0, (v) => {
            const next = { ...(config.safety_stock ?? {}) };
            if (v) next[m.id] = v; else delete next[m.id];
            if (Object.keys(next).length) config.safety_stock = next; else delete config.safety_stock;
            ctx.onEdit(false);
          })) : null,
        safety ? h("td", { class: "qty" }, h("small", { "data-preview": `safety:${m.id}` }, "")) : null)))),
    h("p", { class: "hint field-hint" }, notes),
    // ABC 분석(엔진이 미리보기로 채운다): 금액이 큰 A는 엄격하게, 금액이 작고 가끔 쓰는 자재는 넉넉하게
    safety ? h("div", { "data-preview": "abc", "data-cut-a": String(scenario.safety_stock.abc.A), "data-cut-b": String(scenario.safety_stock.abc.B) }) : null);
}

/** ABC 분석(4.14): 파레토 차트(막대 = 금액 비율, 선 = 누적 비율, 점선 = A·B 경계) + 표로 보기.
 *  값은 모두 엔진(미리보기 abc)이 준다. 화면은 좌표만 정한다. */
function abcChart(rows: AbcRow[], cut: { A: number; B: number }): HTMLElement {
  const W = 640, H = 262, L = 40, R = 64, T = 16, B = 62;
  const n = Math.max(1, rows.length), sw = (W - L - R) / n, bw = Math.min(56, sw * 0.42);
  const cx = (k: number) => L + sw * (k + 0.5);
  const py = (v: number) => T + (1 - v) * (H - T - B);
  const base = py(0);
  const svg = s("svg", { class: "abc-chart", viewBox: `0 0 ${W} ${H}`, role: "img",
    "aria-label": `자재 ABC 분석: ${rows.map((r) => `${r.name} ${pct(r.share, 0)}(${r.class})`).join(", ")}` });
  // 격자 0·50·100%와 A·B 경계(점선)
  for (const v of [0, 0.5, 1]) {
    svg.append(s("line", { x1: L, x2: W - R, y1: py(v), y2: py(v), class: v ? "grid" : "axis-line" }),
      s("text", { x: L - 6, y: py(v) + 4, class: "tick end" }, pct(v, 0)));
  }
  for (const [name, v] of [["A", cut.A], ["B", cut.B]] as const) {
    svg.append(s("line", { x1: L, x2: W - R, y1: py(v), y2: py(v), class: "cut" }),
      s("text", { x: W - R + 6, y: py(v) + 4, class: "cut-label" }, `${name} 경계 ${pct(v, 0)}`));
  }
  rows.forEach((r, k) => {
    const x = cx(k) - bw / 2, top = py(r.share), hgt = base - top, rad = Math.min(4, hgt);
    // 막대: 위쪽만 4px 둥글게, 바닥은 축에 붙인다
    svg.append(s("path", { class: "abc-bar", d: `M${x} ${base} V${top + rad} Q${x} ${top} ${x + rad} ${top} H${x + bw - rad} Q${x + bw} ${top} ${x + bw} ${top + rad} V${base} Z` }));
    // 금액 비율: 막대가 높으면 안쪽, 낮으면 위
    const inside = hgt >= 22;
    svg.append(s("text", { x: cx(k), y: inside ? top + 15 : top - 5, class: inside ? "bar-label in" : "bar-label" }, pct(r.share, 0)));
    // 아래 이름표 세 줄: 자재·등급, 사용 빈도, 리드타임·지연
    svg.append(
      s("text", { x: cx(k), y: base + 16, class: "name" }, `${r.name} · ${r.class}`),
      s("text", { x: cx(k), y: base + 31, class: "sub" }, r.ships === r.of ? `매 척 ${r.ships}/${r.of}` : `가끔 ${r.ships}/${r.of}척`),
      s("text", { x: cx(k), y: base + 45, class: "sub" }, `리드 ${r.lead_days}일${r.delay ? ` · 지연 ${pct(r.delay.probability, 0)}·${r.delay.days}일` : ""}`));
  });
  // 누적 비율 선과 점(점에는 바탕색 테두리), 점 왼쪽 위에 누적 값(선이 오른쪽 위로 오르니 왼쪽 위가 빈다)
  const pts = rows.map((r, k) => `${k ? "L" : "M"}${cx(k).toFixed(1)} ${py(r.cumulative).toFixed(1)}`).join(" ");
  svg.append(s("path", { d: pts, class: "cum-line" }));
  rows.forEach((r, k) => svg.append(
    s("circle", { cx: cx(k), cy: py(r.cumulative), r: 4.5, class: "cum-dot" }),
    s("text", { x: cx(k) - 8, y: py(r.cumulative) - 7, class: "cum-label" }, `누적 ${pct(r.cumulative, 0)}`)));
  // 마우스를 올릴 자리: 자재 칸 전체
  rows.forEach((r, k) => svg.append(s("rect", { x: cx(k) - sw / 2, y: T, width: sw, height: H - T - 8, class: "hit" },
    s("title", null, `${r.name}: 반기 ${num(r.quantity)}개, 금액 ${num(r.value)} (${pct(r.share, 1)}), 누적 ${pct(r.cumulative, 1)}, ${r.class}등급`))));
  const legend = h("div", { class: "abc-legend" },
    h("span", null, h("i", { class: "sw bar" }), "금액 비율(막대)"),
    h("span", null, h("i", { class: "sw cum" }), "누적 비율(선)"),
    h("span", null, h("i", { class: "sw cut" }), "A·B 경계"));
  const table = h("details", { class: "abc-table-wrap" }, h("summary", null, "표로 보기"),
    h("table", { class: "abc-table" },
      h("thead", null, h("tr", null, ["자재", "반기 사용", "금액", "비율", "누적", "ABC", "쓰는 배", "리드타임", "입고 지연"].map((t) => h("th", null, t)))),
      h("tbody", null, rows.map((r) => h("tr", null,
        h("td", null, r.name), h("td", null, `${num(r.quantity)}개`), h("td", null, num(r.value)),
        h("td", null, pct(r.share, 1)), h("td", null, pct(r.cumulative, 1)), h("td", null, h("b", null, r.class)),
        h("td", null, `${r.ships}/${r.of}척`), h("td", null, `${r.lead_days}일`),
        h("td", null, r.delay ? `${pct(r.delay.probability, 0)} · ${r.delay.days}일` : "—"))))));
  return h("figure", { class: "abc" },
    h("figcaption", null, "자재 ABC 분석 · 반기 사용 금액 순"), legend, svg,
    h("p", { class: "hint" }, `금액 누적 ${pct(cut.A, 0)}까지 A, ${pct(cut.B, 0)}까지 B, 나머지 C. 금액이 큰 A는 엄격하게(쌓으면 재고비가 크다), 매 척 쓰는 자재는 다음 배 몫이 곧 들어와 메워 주니 적게, 가끔 쓰고 늦으면 오래 걸리는 자재는 넉넉하게.`),
    table);
}

/** 연구 대기열: 넣은 순서대로 1일부터 하나씩 진행한다. 순서를 바꾸면 양식을 다시 그린다(입력란이 없어 커서 걱정이 없다). */
function researchQueue(ctx: FormContext): HTMLElement {
  const { scenario, config } = ctx;
  const queue = config.research;
  const edit = (next: string[]) => { config.research = next; ctx.onEdit(true); };
  const move = (i: number, d: number) => {
    const next = [...queue];
    [next[i], next[i + d]] = [next[i + d], next[i]];
    edit(next);
  };
  const waiting = Object.keys(scenario.research).filter((id) => !queue.includes(id));

  return h("div", { class: "research" },
    h("div", { class: "field-row" }, h("span", { class: "field-label" }, "연구 대기열"),
      h("small", null, "1일부터 차례로, 끝난 다음 날부터 효과")),
    queue.length
      ? h("ol", { class: "queue" }, queue.map((id, i) => {
        const info = scenario.research[id];
        return h("li", null,
          h("b", null, info.name),
          h("small", null, `${num(info.cost)} · ${info.days}일 · `, h("span", { "data-preview": `research:${id}` }, "…")),
          h("span", { class: "queue-btns" },
            h("button", { type: "button", class: "icon-btn", title: "앞으로", disabled: i === 0, onclick: () => move(i, -1) }, "▲"),
            h("button", { type: "button", class: "icon-btn", title: "뒤로", disabled: i === queue.length - 1, onclick: () => move(i, 1) }, "▼"),
            h("button", { type: "button", class: "icon-btn", title: "빼기", onclick: () => edit(queue.filter((r) => r !== id)) }, "✕")),
          h("p", { class: "research-effect" }, "효과: ", info.effect));
      }))
      : h("p", { class: "hint" }, "비어 있음. 연구는 운영을 함께 바꿔야 돈이 됩니다."),
    waiting.length
      ? h("div", { class: "queue-add" }, waiting.map((id) => {
        const info = scenario.research[id];
        return h("div", { class: "queue-option" },
          h("button", { type: "button", class: "chip-btn", onclick: () => edit([...queue, id]) },
            `+ ${info.name}`, h("small", null, ` ${num(info.cost)} · ${info.days}일`)),
          h("p", { class: "research-effect" }, info.effect));
      }))
      : null);
}

function shipPane(ctx: FormContext, sid: string, onSpec: () => void): HTMLElement {
  const { scenario } = ctx;
  const order = scenario.orders.find((o) => o.id === sid)!;
  const type = scenario.ship_types[order.type];

  return h("div", { class: "pane", "data-pane": sid, hidden: true },
    h("dl", { class: "ship-info" },
      h("div", null, h("dt", null, "선종"), h("dd", null,
        h("button", { type: "button", class: "spec-link", title: `${sid} 선박 사양서`, onclick: onSpec }, `${type.name} · 사양서`))),
      h("div", null, h("dt", null, "수주"), h("dd", null, `${order.order_day}일`)),
      h("div", null, h("dt", null, "납기"), h("dd", null, h("span", { "data-preview": `due:${order.id}` }, `${order.due_day}일`))),
      h("div", null, h("dt", null, "계약금"), h("dd", null, h("span", { "data-preview": `price:${order.id}` }, num(order.price))))),
    h("div", { class: "field-row" },
      h("span", { class: "field-label" }, "작업량"),
      h("span", { class: "work-cells" }, activeStations(scenario).map((st) =>
        h("span", { class: "work-chip", title: st.name, style: { borderColor: STATION_COLOR[st.id] } },
          `${st.name} ${type.work[st.id]}`)))),
    h("table", { class: "plan orders-table" },
      h("thead", null, h("tr", null,
        h("th", null, "자재"), h("th", { class: "r" }, "소요량"), h("th", null, "쓰는 공정"),
        h("th", null, "발주일"), h("th", null, "입고일"))),
      // 이 배가 쓰는 자재만(보냉재는 LNG선만, 4.14)
      h("tbody", null, scenario.materials.filter((m) => (type.bom[m.id] ?? 0) > 0).map((m) => {
        const station = activeStations(scenario).find((st) => st.material === m.id);
        return h("tr", null,
          h("td", null, h("b", null, m.name)),
          h("td", { class: "r" }, type.bom[m.id] ?? 0),
          h("td", null, station?.name ?? "—"),
          h("td", { "data-preview": `order:${sid}:${m.id}` }, "…"),
          h("td", null, h("span", { "data-preview": `arrival:${sid}:${m.id}` }, "…"), h("small", null, ` (+${m.lead_days}일)`)));
      }))),
    h("p", { class: "hint" }, "발주일은 공통 탭의 발주 방식으로 정해집니다. 재고는 4척이 함께 씁니다."));
}

/** 서버가 준 미리보기 값을 양식의 자리에 채운다. 오류가 있으면 실행 버튼을 막고, 오류가 난 탭에 ⚠를 붙인다. */
export function updatePreview(root: HTMLElement, preview: Preview | null, errors: string[], busy: boolean): void {
  const slot = (key: string) => root.querySelector<HTMLElement>(`[data-preview="${key}"]`);
  refreshFoldSummaries(root);
  if (preview) {
    previews.set(root, preview);
    if (spec?.root === root) showSpec();
    fillStationPreview(root, preview);
    for (const key of ["labor", "maintenance", "transporter", "investment", "research"] as const) {
      const el = slot(key);
      if (el) el.textContent = money(preview.fixed_costs[key]);
    }
    for (const r of preview.research) {
      const el = slot(`research:${r.id}`);
      if (el) el.textContent = r.done ? `${r.start}~${r.end}일, ${r.effective_from}일부터 효과` : `${r.start}일 시작, 기간 안에 못 끝남`;
    }
    for (const [sid, mats] of Object.entries(preview.materials)) {
      for (const [mid, m] of Object.entries(mats)) {
        const order = slot(`order:${sid}:${mid}`);
        const arrival = slot(`arrival:${sid}:${mid}`);
        if (order) order.textContent = m.order_day === null ? "안 함" : `${m.order_day}일`;
        if (arrival) arrival.textContent = m.arrival_day === null ? "—" : `${m.arrival_day}일`;
      }
    }
    const abc = slot("abc");
    if (abc && preview.abc && abc.dataset.cutA) {
      // 미리보기가 올 때마다 다시 그린다. 펼쳐 둔 "표로 보기"는 펼친 채로 둔다
      const open = abc.querySelector("details")?.open ?? false;
      abc.replaceChildren(abcChart(preview.abc, { A: Number(abc.dataset.cutA), B: Number(abc.dataset.cutB) }));
      abc.querySelector("details")!.open = open;
    }
    for (const el of root.querySelectorAll<HTMLElement>("[data-preview^='safety:']")) {
      const qty = preview.safety_stock?.[el.dataset.preview!.slice("safety:".length)];
      el.textContent = qty ? `${qty}개` : "";
    }
    // 납기·계약금은 수주 목록과 배 탭 두 곳에 있다
    for (const [sid, c] of Object.entries(preview.contract ?? {})) {
      root.querySelectorAll<HTMLElement>(`[data-preview="due:${sid}"]`).forEach((el) => {
        el.textContent = c.buffer_days ? `${c.due_day}일 (+${c.buffer_days})` : `${c.due_day}일`;
      });
      root.querySelectorAll<HTMLElement>(`[data-preview="price:${sid}"]`).forEach((el) => { el.textContent = num(c.price); });
    }
    drawPlan(root, preview);
  }
  // 오류 메시지는 "S2: …"처럼 배 id로 시작한다. 배가 아닌 오류는 공통 탭에 표시한다(블록 납기 "S2-SA1: …"는 조립 공정 계획서 탭에 ⚠).
  root.querySelectorAll<HTMLElement>("[data-warn]").forEach((mark) => {
    const tab = mark.dataset.warn!;
    mark.hidden = !errors.some((e) => {
      const ship = /^S\d+:/.test(e) ? e.split(":")[0] : null;
      return tab === "common" ? ship === null : ship === tab;
    });
  });
  const box = slot("errors");
  if (box) mount(box, errors.length ? h("ul", null, errors.map((e) => h("li", null, e))) : null);
  const run = root.querySelector<HTMLButtonElement>("button.run");
  if (run) run.disabled = busy || errors.length > 0;
}

/** 계획 간트와 겹침 문구를 미리보기 값으로 다시 그린다. */
function drawPlan(root: HTMLElement, preview: Preview): void {
  const host = root.querySelector<HTMLElement>("[data-plan]");
  if (!host || !current) return;
  const ctx = current;
  const { scenario, config } = ctx;
  if (preview.buffer_plan) {
    // 프로젝트 버퍼(4.36): 배별 막대, 착수일(엔진이 버퍼에서 잡은 날), 버퍼 비용 한 줄
    const bp = preview.buffer_plan;
    mount(host, renderBufferGantt(scenario, bp));
    for (const [sid, sh] of Object.entries(bp.ships)) {
      const label = root.querySelector<HTMLElement>(`[data-preview="start:${sid}"]`);
      if (label) label.textContent = `${sh.start}일`;
    }
    const cost = root.querySelector<HTMLElement>(`[data-preview="buffer-cost"]`);
    const short = Object.entries(bp.ships).filter(([, sh]) => !sh.feasible);
    if (cost) mount(cost, h("b", null, "버퍼 비용(계획대로면) "),
      `보관비 ${num(bp.storage, 0)} + 재고·재공비 ${bp.extra_inventory >= 0 ? "+" : ""}${num(bp.extra_inventory, 0)}(버퍼 0일보다) = `,
      h("b", null, num(bp.storage + bp.extra_inventory, 0)),
      short.length ? h("span", { class: "late" }, ` · 버퍼 부족 ${short.map(([sid, sh]) => `${sid} ${sh.finish - sh.target}일`).join(", ")}(착수를 더 당길 수 없음)`) : null);
    return;
  }
  const startDays = Object.fromEntries(Object.entries(config.ships).map(([sid, ship]) => [sid, ship.start_day]));
  const pickable = blockStations(scenario).map((b) => b.id);
  mount(host, renderPlanGantt({
    scenario, plan: preview.plan, startDays, contract: preview.contract,
    pickable,
    onPickStation: (station, ship) => ctx.onOpenAssembly?.(station, ship),
    onMove: (sid, day) => {
      // 4.26 사용자: 배를 옮기면 조립 공정 계획서에서 정한 그 배의 블록 착수일도 같은 날 수만큼 따라 옮긴다
      // (정하지 않은 블록은 미리보기가 새 공정 기간에서 다시 놓는다)
      const delta = day - config.ships[sid].start_day;
      for (const bid of Object.keys(config.block_start ?? {})) {
        if (bid.startsWith(`${sid}-`)) config.block_start![bid] = Math.min(scenario.days, Math.max(1, config.block_start![bid] + delta));
      }
      config.ships[sid].start_day = day;
      const label = root.querySelector<HTMLElement>(`[data-preview="start:${sid}"]`);
      if (label) label.textContent = `${day}일`;
      ctx.onEdit(false);
    },
  }));
  const text = root.querySelector<HTMLElement>(`[data-preview="conflicts"]`);
  if (text) text.textContent = conflictText(scenario, preview.plan);
}
