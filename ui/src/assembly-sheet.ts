// 조립 공정 계획서(4.25, D71): 블록 조립 실습의 생산계획서 클립보드에 끼운 두 번째 낱장(PP-02).
// 사용자(2026-10-16): 조립 공정 상세화로 생산계획서가 복잡해져서, 조립 공정에 대한 것은 이 낱장에 모은다.
// 본 서식(생산계획서 PP-01)은 다른 반기와 같다. 낱장은 클립보드 위 인덱스 탭으로 넘기고, 이 장은 스크롤 없이 한 화면에 든다.
//   ① 배별 블록 일정과 납기: 계획상 위험 한 줄 + 배 탭(납기 빠른 순)  ② 조립 공정(소조립·중조립·PE장): 공정 카드마다 블록 우선순위 규칙과
//   운영·작업장 수(4.28.1 사용자: 생산계획서의 조립 공정 카드를 이리로 옮김)
//   (사용자: 블록 공정도 선박별로. 배 탭 하나에 그 배의 블록 일정과 공정·블록 납기 표가 함께 있다.
//    4.26 사용자: 일정을 먼저, 규칙을 뒤로. 배 탭은 납기가 빠른 배부터, 블록 막대는 좌우로 끌어 착수일을 정한다)
// 화면은 계산하지 않는다: 블록 일정·납기·위험은 미리보기(block_plan, dues, plan_risks)를 그린다.

import { activeStations, blockId, blockShort, blockStations, type Config, type DispatchRule, planStations, type Preview, type Scenario } from "./api";
import { blockGanttLegend, renderAllBlockGantt, renderBlockGantt } from "./block-plan-gantt";
import { h, mount } from "./dom";
import { fillStationPreview, stationCard } from "./form";
import { DISPATCH_INFO, STATION_COLOR } from "./labels";
import { docHead } from "./paper";
import { riskText } from "./plan-gantt";

export interface AssemblyContext {
  scenario: Scenario;
  config: Config;
  /** 값이 바뀌었다. redraw가 true면 이 장을 다시 그린다. */
  onEdit(redraw: boolean): void;
}

/** 공통 탭(4.32) */
const ALL = "__all";

/** 이 장 안의 배 탭과, 배 탭 안에서 보이는 것(블록 일정 또는 공정·블록 납기 표: 한 번에 하나라 스크롤이 생기지 않는다) */
let ship: string | null = null;
let view: "schedule" | "dues" = "schedule";
let current: AssemblyContext | null = null;
let lastPreview: Preview | null = null;
/** 블록 일정 크게 보기(4.27.1): 관제실 모니터의 최대화처럼. 창은 body에 붙인 층에 그린다 */
let zoomed = false;
let layer: HTMLElement | null = null;

function zoomLayer(): HTMLElement {
  if (!layer) {
    layer = h("div", { class: "asm-zoom-layer" });
    document.body.append(layer);
    // 생산계획서 보드도 Esc로 닫히므로, 크게 보는 중에는 먼저 받아 이전 크기로만 돌린다
    window.addEventListener("keydown", (e) => {
      if (zoomed && e.key === "Escape") { e.stopPropagation(); e.preventDefault(); setZoom(false); }
    }, true);
  }
  return layer;
}

function setZoom(on: boolean): void {
  zoomed = on;
  if (!on && layer) mount(layer, null);
  current?.onEdit(true);
}

/** 생산계획서 계획 간트에서 블록 공정 막대를 눌렀을 때: 그 배의 탭을 연다 */
export function focusAssemblyShip(id: string): void {
  ship = id;
  view = "schedule";
}

function zoomBtn(): HTMLElement {
  return h("button", { type: "button", class: "btn small asm-zoom-btn", title: "블록 일정을 화면 가득", onclick: () => setZoom(true) }, "크게 보기");
}

function seg<T extends string | number>(name: string, options: { value: T; label: string }[], value: T, onPick: (v: T) => void): HTMLElement {
  return h("div", { class: "seg", role: "radiogroup" },
    options.map((o) => h("label", { class: "seg-item" },
      h("input", { type: "radio", name, checked: o.value === value, onchange: () => onPick(o.value) }),
      h("span", null, o.label))));
}

export function renderAssemblySheet(root: HTMLElement, ctx: AssemblyContext): void {
  current = ctx;
  const { scenario, config } = ctx;
  const bst = blockStations(scenario);
  const action = !!scenario.decision_stations;   // 4.32 조립 현장 배정: 공통 탭, 납기 표 없음, 공정 카드는 직접 대응 공정만
  if (action) view = "schedule";
  // 크게 보기는 블록 일정에서만: 다른 반기나 납기 표로 바뀌면 닫는다
  if (zoomed && (!bst.length || view !== "schedule")) { zoomed = false; if (layer) mount(layer, null); }
  if (!bst.length) { mount(root, null); return; }
  // 배 탭은 수주 목록 순서(실습은 목록이 납기 빠른 순, 4.26·4.27.2 사용자). 처음 여는 탭도 목록 첫 배
  const ships = scenario.orders;   // 실습은 수주 번호가 납기 빠른 순(S1 벌크선 → S2 → S3, 4.27.3)
  ship = ships.some((o) => o.id === ship) || (action && ship === ALL) ? ship : action ? ALL : ships[0].id;

  // ② 조립 공정(4.28.1, 사용자): 생산계획서의 조립 공정 카드(운영·작업장 수)를 이리로 옮기고, 카드 맨 위에 블록 우선순위 규칙.
  // 규칙은 작업장이 비었을 때 기다리는 블록 가운데 무엇을 먼저 들일지이고, 평가서 추천이 비교하는 것이다.
  // 고를 것이 하나뿐인 인력·공법 줄은 그리지 않는다(실습은 잠겨 있다)
  const rules = h("section", { class: "panel asm-rules" },
    h("div", { class: "panel-head" }, h("span", { class: "step" }, "2"), h("h2", null, "조립 공정")),
    h("div", { class: "stations asm-stations" }, planStations(scenario).map((b) => {
      const cfg = config.stations[b.id];
      const st = scenario.stations.find((x) => x.id === b.id)!;
      return stationCard(ctx, st, {
        compact: true, note: `블록 ${b.count}개`,
        fixed: action ? "정비함 · 잔업·철야·외주는 조치 요청에서" : undefined,
        lead: [
          // 4.31(D78): 자동 대응(규칙대로)과 직접 대응(몰리는 날 관제실에서 블록 순서를 묻는다)
          ...(scenario.options?.decisions ? [
            h("span", { class: "field-label" }, "대응"),
            h("div", { class: "asm-rule" }, seg(`mode-${b.id}`, [{ value: "auto", label: "자동 대응" }, { value: "manual", label: "직접 대응" }] as { value: "auto" | "manual"; label: string }[],
              cfg.dispatch_mode ?? "auto", (v) => { if (v === "auto") delete cfg.dispatch_mode; else cfg.dispatch_mode = v; ctx.onEdit(true); })),
          ] : []),
          // 비상 예산(4.32, 4.34 사용자 "비상 예산은 어디서 확인"): 생산계획서 공정 칸에서 직접 대응 공정 카드로 옮겼다. 직접 대응일 때만 쓴다
          ...(scenario.contingency && cfg.dispatch_mode === "manual" ? [
            h("span", { class: "field-label" }, "비상 예산"),
            h("div", { class: "asm-rule asm-budget" },
              h("input", {
                type: "number", class: "day-input", min: 0, max: scenario.contingency_max ?? 500, step: 10,
                value: config.contingency?.[b.id] ?? scenario.contingency[b.id] ?? 0, "aria-label": `${b.name} 비상 예산`,
                oninput: (e: Event) => {
                  const raw = (e.target as HTMLInputElement).value.trim();
                  (config.contingency ??= {})[b.id] = raw === "" ? 0 : Number(raw);
                  ctx.onEdit(false);
                },
              }),
              h("small", null, `조치 요청의 잔업·철야·외주에 씀(0~${scenario.contingency_max ?? 500}, 쓴 만큼만 비용)`)),
          ] : []),
          // 작업장 적치 한도(4.35, D83, 사용자 "작업장별 최대 블록 수용 갯수"): 넘치는 블록은 가공 적치장에서 기다린다
          ...(scenario.options?.queue_cap ? [
            h("span", { class: "field-label" }, "적치 한도"),
            h("div", { class: "asm-rule asm-budget" },
              seg(`qcap-${b.id}`, [{ value: 0, label: "없음" }, ...[2, 3, 4, 5, 6, 8].filter((n) => n <= scenario.options!.queue_cap!)
                .map((n) => ({ value: n, label: `${n}개` }))], cfg.queue_cap ?? 0,
              (v) => { if (v) cfg.queue_cap = v; else delete cfg.queue_cap; ctx.onEdit(false); }),
              h("small", null, "넘치는 블록은 가공 적치장에서 대기")),
          ] : []),
          h("span", { class: "field-label" }, scenario.options?.decisions ? "배치 정책" : "우선순위"),
          h("div", { class: "asm-rule" }, seg(`dispatch-${b.id}`, (Object.keys(DISPATCH_INFO) as DispatchRule[]).map((id) => ({ value: id, label: DISPATCH_INFO[id].name })),
            cfg.dispatch ?? "ship", (v) => { if (v === "ship") delete cfg.dispatch; else cfg.dispatch = v; ctx.onEdit(true); })),
        ],
      });
    })),
    scenario.options?.decisions ? h("p", { class: "hint" }, "배치 정책은 작업장이 비었을 때 기다리는 블록 가운데 무엇을 먼저 들일지 정합니다. 직접 대응으로 둔 공정은 실행 중 블록이 몰리는 날(필요 작업시간 > 가용, 새 배의 블록이 작업장 앞에 올라온 날) 관제실이 멈추고 작업 중·작업장 앞 블록을 조치 요청로 보이며 정책과 블록별 조치(잔업·철야·외주·포기(지체보상금), 그 공정 비상 예산 안에서)를 묻습니다. 조치 요청는 고를 때마다 작업시간·납기·예산이 어떻게 되는지 미리 보여 줍니다.") : null,
    action ? null : h("p", { class: "hint" }, "우선순위 규칙은 작업장이 비었을 때 기다리는 블록 가운데 무엇을 먼저 들일지 정합니다. 위 배 탭에서 정한 착수일 전에는 그 블록을 들이지 않습니다. 작업장을 2개로 늘리면 블록이 두 작업장으로 퍼집니다."));

  // ① 배별 블록 일정과 납기: 계획상 위험 한 줄(혼자 써도 공정 납기를 넘기는 공정, 작업장 겹침과는 원인이 다르다), 배 탭 한 줄
  const tabs = h("div", { class: "tabs asm-tabs", role: "tablist" },
    // 4.32(사용자): 배 탭 왼쪽에 공통 탭(모든 배의 모든 블록)
    action ? h("button", {
      type: "button", class: `tab${ship === ALL ? " active" : ""}`, role: "tab",
      onclick: () => { ship = ALL; ctx.onEdit(true); },
    }, "공통", h("small", null, " 모든 배")) : null,
    ships.map((o) => h("button", {
      type: "button", class: `tab${ship === o.id ? " active" : ""}`, role: "tab", "data-asm-ship": o.id,
      onclick: () => { ship = o.id; ctx.onEdit(true); },
    }, `${o.id} ${scenario.ship_types[o.type].name}`, h("small", null, ` 납기 ${o.due_day}일`))));
  const schedule = h("section", { class: "panel asm-main" },
    // 4.34(사용자 "크게보기 버튼이 추가되면서 UI가 깨지네"): 조립 현장 배정은 크게 보기를 제목 줄 오른쪽 끝에(배 탭 줄과 다투지 않게)
    h("div", { class: "panel-head" }, h("span", { class: "step" }, "1"), h("h2", null, action ? "블록 작업 일정" : "배별 블록 일정과 납기"),
      action ? zoomBtn() : null),
    h("p", { class: "hint plan-risk", "data-asm": "risks" }, "…"),
    tabs,
    action ? null : h("div", { class: "asm-mode" }, seg("asm-mode", [{ value: "schedule", label: "블록 일정" }, { value: "dues", label: "공정·블록 납기" }] as { value: typeof view; label: string }[],
      view, (v) => { view = v; ctx.onEdit(true); }),
      // 크게 보기는 이 줄 오른쪽 끝에 고정(4.27.2): 단추가 늘었다 줄었다 하는 블록 일정 머리줄에 두면 다음 줄로 밀렸다
      view === "schedule" ? zoomBtn() : null),
    view === "schedule" ? h("div", { class: "asm-schedule", "data-asm": "gantt" }) : dueTable(ctx));

  const head = docHead({
    title: "조립 공정 계획서", period: scenario.period, code: "PP-02", approved: false,
    fields: [["대상", action ? `조립 공정(${planStations(scenario).map((b) => b.name).join(" → ")})의 블록${bst.some((b) => b.id === "grand_assembly") ? " · PE장은 생산계획서" : ""}`
      : `조립 세 공정(${bst.map((b) => b.name).join(" → ")})의 블록`], ["딸린 문서", "생산계획서 PP-01"]],
  });
  mount(root, head, schedule, rules, h("div", { class: "errors", "data-asm": "errors" }));
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
              return h("span", { class: "block-chip" }, h("b", null, blockShort(sid, st.id, k + 1)),
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
    fillStationPreview(root, preview);
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
    if (host && preview.block_plan && ship) {
      const bp = preview.block_plan;
      const sid = ship;
      const bst = blockStations(scenario);
      const n = Object.values(bp.blocks).filter((b) => b.ship === sid && b.risk).length;
      const mineStarts = Object.keys(config.block_start ?? {}).filter((bid) => bp.blocks[bid]?.ship === sid);
      const order = scenario.orders.find((o) => o.id === sid);
      const label = order ? `${sid} ${scenario.ship_types[order.type].name}` : "공통(모든 배)";
      const bsh = preview.buffer_plan?.ships[sid];
      const bufferLine = bsh ? h("p", { class: "asm-buffer-line" },
        h("b", null, sid), ` 착수 ${bsh.start}일 → 계획 완료 ${bsh.finish}일 → `,
        h("span", { class: "asm-buffer-chip" }, `버퍼 ${bsh.buffer}일`), ` → 납기 ${bsh.due}일`,
        bsh.feasible ? "" : h("span", { class: "late" }, ` (버퍼 부족 ${bsh.finish - bsh.target}일)`)) : null;
      const body = () => sid === ALL ? [
        // 공통 탭(4.32): 모든 배의 블록을 공정·작업장 줄에(읽기만, 끌기는 배 탭에서)
        renderAllBlockGantt(scenario, bp, bst),
        h("p", { class: "hint" }, "모든 배의 블록 계획입니다(막대 이름 = 배). 착수일·착수 시각은 배 탭에서 막대를 끌어 정합니다. 계획이라 고장·입고 지연·몰리는 날의 결정은 넣지 않았습니다."),
      ] : [
        bufferLine,
        h("div", { class: "block-panel-head" },
          h("small", null, "막대를 좌우로 끌거나 Alt+←/→(1시간씩, Shift를 함께 누르면 하루씩): 그 블록의 착수일과 착수 시각(옅은 띠 안에서)", n ? ` · 블록 납기를 넘기는 블록 ${n}개` : ""),
          mineStarts.length ? h("button", {
            type: "button", class: "btn small",
            onclick: () => {
              for (const bid of mineStarts) {
                delete config.block_start![bid];
                if (config.block_start_hour) delete config.block_start_hour[bid];
              }
              if (!Object.keys(config.block_start!).length) delete config.block_start;
              if (config.block_start_hour && !Object.keys(config.block_start_hour).length) delete config.block_start_hour;
              ctx.onEdit(false);
            },
          }, `이 배 착수일 지우기(${mineStarts.length})`) : null,
          config.block_order ? h("button", {
            type: "button", class: "btn small",
            onclick: () => { delete config.block_order; ctx.onEdit(false); },
          }, "정한 순서 지우기(규칙대로)") : null,
          ),
        renderBlockGantt({
          scenario, plan: bp, ship: sid, stations: bst,
          units: Object.fromEntries(bst.map((b) => [b.id, config.stations[b.id]?.units ?? 1])),
          windows: preview.plan.ships[sid] ?? {},
          dues: preview.dues?.stations?.[sid] ?? {},
          starts: config.block_start ?? {},
          startHours: config.block_start_hour ?? {},
          onMoveStart: (bid, day, hour) => {
            (config.block_start ??= {})[bid] = day;
            if (hour) (config.block_start_hour ??= {})[bid] = hour;
            else if (config.block_start_hour) {
              delete config.block_start_hour[bid];
              if (!Object.keys(config.block_start_hour).length) delete config.block_start_hour;
            }
            ctx.onEdit(false);
          },
        }),
        blockGanttLegend(bst),
        scenario.project_buffer
          // 4.36(D84): 계획 = 변수 없이 돌린 실행, 블록 납기 = 계획에서 끝나는 날. 버퍼는 배 끝에만
          ? h("p", { class: "hint" }, "공정마다 위는 작업장 줄, 아래는 이 배의 블록 줄입니다. 막대는 계획(불량·고장·사고·입고 지연 없이 돌린 실행)이고 길이가 시간입니다(하루 칸 = 8시간). 블록 납기는 그 막대가 끝나는 날이라 블록에는 여유가 없고, 여유는 배 끝의 버퍼에만 있습니다. 생산 중 블록이 늦어지면 그만큼 이 배의 버퍼를 소모하고, 그럴 것 같은 날 관제실이 조치 요청로 묻습니다. 착수를 정한 블록은 그 시각보다 먼저 들이지 않습니다.")
          : h("p", { class: "hint" }, "공정마다 위는 작업장 줄, 아래는 이 배의 블록 줄입니다. 막대는 고장 없이 2명이 하루 8시간 했을 때의 계획으로 길이가 시간입니다(하루 칸 = 8시간, 7h는 근무 시작부터 7시간). 옅은 띠 중 진한 쪽은 생산계획서 계획 간트의 그 공정 기간, 더 옅은 쪽은 그 뒤 공정 납기까지입니다. 착수를 정한 블록은 그 시각보다 먼저 들이지 않고, 작업장이 차 있으면 정한 시각보다 뒤에 놓입니다."),
      ];
      if (zoomed && root.isConnected) {
        // 크게 보기(4.27.1, 사용자): 관제실 모니터처럼 화면 가득. 클립보드에 transform이 있어 body에 띄운다
        mount(host, h("p", { class: "hint" }, "블록 일정을 크게 보는 중입니다(Esc: 이전 크기로)."));
        mount(zoomLayer(),
          h("div", { class: "asm-zoom-backdrop", onclick: () => setZoom(false) }),
          h("div", { class: "asm-zoom", role: "dialog", "aria-modal": "true", "aria-label": `${label} 블록 일정 크게 보기` },
            h("div", { class: "win-titlebar" },
              h("span", { class: "win-title" }, `조립 공정 계획서 · ${label} 블록 일정`),
              h("div", { class: "asm-zoom-tabs" },
                // 공통 탭은 조립 현장 배정(4.32)에만 있다
                scenario.decision_stations ? h("button", {
                  type: "button", class: `tab${sid === ALL ? " active" : ""}`, onclick: () => { ship = ALL; ctx.onEdit(true); },
                }, "공통") : null,
                scenario.orders.map((o) => h("button", {
                  type: "button", class: `tab${o.id === sid ? " active" : ""}`, onclick: () => { ship = o.id; ctx.onEdit(true); },
                }, o.id))),
              h("div", { class: "win-buttons" },
                h("button", { type: "button", class: "win-btn restore-btn", title: "이전 크기로 (Esc)", "aria-label": "이전 크기로 (Esc)", onclick: () => setZoom(false) }, "이전 크기로"))),
            h("div", { class: "asm-zoom-body" }, ...body())));
      } else {
        mount(host, ...body());
      }
    }
  }
  const mine = errors.filter(isAssemblyError);
  const errBox = root.querySelector<HTMLElement>("[data-asm='errors']");
  if (errBox) mount(errBox, mine.length ? h("ul", null, mine.map((e) => h("li", null, e))) : null);
}

/** 이 장에서 고칠 오류: 블록 납기("S1-SA1: …"), 공정 납기, 블록 순서, 우선순위 규칙 */
export function isAssemblyError(e: string): boolean {
  return /^S\d+-[A-Z]{2}\d+:/.test(e) || /공정 납기|블록 순서|블록 납기|블록 착수|우선순위 규칙|납기\(due\)/.test(e);
}

/** 인덱스 탭의 표시: 계획상 위험 수(공정 + 블록) */
export function assemblyBadge(preview: Preview | null): number {
  return (preview?.plan_risks?.length ?? 0) + (preview?.block_plan?.risks.length ?? 0);
}
