// 왼쪽 설정 양식: ① 수주 ② 계획과 일정 ③ 자원 배치 ④ 실행.
// 입력 중에는 양식을 다시 그리지 않는다(그러면 커서가 사라진다). 값만 config에 넣고 알린다.
// 처리량과 불량률 미리보기는 서버의 /api/preview 결과를 data-preview 자리에 채운다.

import type { Config, Preset, Preview, Scenario } from "./api";
import { h, mount, money, num, pct } from "./dom";
import { STATION_COLOR } from "./labels";

export interface FormContext {
  scenario: Scenario;
  presets: Preset[];
  config: Config;
  presetId: string | null;
  edited: boolean;
  busy: boolean;
  /** 값이 바뀌었다. redraw가 true면 양식 전체를 다시 그린다. */
  onEdit(redraw: boolean): void;
  onPreset(id: string): void;
  onSuggest(): void;
  onRun(): void;
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

function dayInput(value: number | null, onValue: (v: number | null) => void, max: number, allowEmpty: boolean): HTMLElement {
  return h("input", {
    class: "day-input", type: "number", min: 1, max, step: 1, inputmode: "numeric",
    value: value === null ? "" : String(value),
    placeholder: allowEmpty ? "없음" : "",
    oninput: (e: Event) => {
      const raw = (e.target as HTMLInputElement).value.trim();
      // 빈칸은 "발주 안 함"(null). 착수일 빈칸은 서버 검사가 잡아내도록 그대로 보낸다.
      onValue(raw === "" ? null : Number(raw));
    },
  });
}

export function renderForm(root: HTMLElement, ctx: FormContext): void {
  const { scenario, config } = ctx;
  const methods = Object.entries(scenario.rules.methods);
  const orderIds = scenario.orders.map((o) => o.id);
  const activePreset = ctx.presets.find((p) => p.id === ctx.presetId);

  const presetSection = h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("h2", null, "프리셋")),
    h("div", { class: "preset-row" },
      ctx.presets.map((preset) =>
        h("button", {
          class: `preset${preset.id === ctx.presetId ? " active" : ""}`,
          type: "button", title: preset.summary,
          onclick: () => ctx.onPreset(preset.id),
        }, preset.name))),
    h("p", { class: "hint" },
      activePreset
        ? [activePreset.summary, h("b", { class: "edited", hidden: !ctx.edited }, " (수정함)")]
        : "직접 정한 설정입니다."),
  );

  // ① 수주
  const ordersSection = h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("span", { class: "step" }, "1"), h("h2", null, "수주")),
    h("table", { class: "orders" },
      h("thead", null, h("tr", null,
        h("th", null, "배"), h("th", null, "선종"), h("th", { class: "r" }, "납기"),
        h("th", { class: "r" }, "계약금"), h("th", null, "작업량 (재단·풀칠·물감칠·의장)"))),
      h("tbody", null, scenario.orders.map((order) => {
        const type = scenario.ship_types[order.type];
        return h("tr", null,
          h("td", null, h("b", null, order.id)),
          h("td", null, type.name),
          h("td", { class: "r" }, `${order.due_day}일`),
          h("td", { class: "r" }, num(order.price)),
          h("td", { class: "work-cells" }, scenario.stations.map((st) =>
            h("span", { class: "work-chip", style: { borderColor: STATION_COLOR[st.id] } }, type.work[st.id]))));
      }))),
  );

  // ② 계획과 일정
  const planRows = orderIds.map((sid) => {
    const ship = config.ships[sid];
    return h("tr", null,
      h("td", null, h("b", null, sid)),
      h("td", null, h("select", {
        class: "priority",
        onchange: (e: Event) => {
          // 우선순위는 1~3을 한 번씩 쓴다. 겹치면 상대 배와 맞바꾼다.
          const next = Number((e.target as HTMLSelectElement).value);
          const other = orderIds.find((id) => id !== sid && config.ships[id].priority === next);
          if (other) config.ships[other].priority = ship.priority;
          ship.priority = next;
          ctx.onEdit(true);
        },
      }, orderIds.map((_, k) => h("option", { value: k + 1, selected: ship.priority === k + 1 }, `${k + 1}순위`)))),
      h("td", null, dayInput(ship.start_day, (v) => { ship.start_day = v as number; ctx.onEdit(false); }, scenario.days, false)),
      scenario.materials.map((m) =>
        h("td", null, dayInput(ship.order_days[m.id] ?? null, (v) => { ship.order_days[m.id] = v; ctx.onEdit(false); }, scenario.days, true))),
    );
  });

  const planSection = h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("span", { class: "step" }, "2"), h("h2", null, "계획과 일정")),
    h("table", { class: "plan" },
      h("thead", null,
        h("tr", null,
          h("th", { rowspan: 2 }, "배"), h("th", { rowspan: 2 }, "우선순위"), h("th", { rowspan: 2 }, "착수일"),
          h("th", { colspan: scenario.materials.length, class: "group" }, "자재 발주일")),
        h("tr", null, scenario.materials.map((m) =>
          h("th", { class: "sub", title: `단가 ${m.price}` }, m.name, h("small", null, `입고 +${m.lead_days}일`))))),
      h("tbody", null, planRows)),
    h("div", { class: "row-end" },
      h("p", { class: "hint" }, "입고일 = 발주일 + 리드타임. 빈칸은 발주하지 않습니다."),
      h("button", { class: "btn ghost", type: "button", disabled: ctx.busy, onclick: () => ctx.onSuggest() }, "필요일에서 역산")),
  );

  // ③ 자원 배치
  const stationCards = scenario.stations.map((st) => {
    const cfg = config.stations[st.id];
    return h("div", { class: "station", style: { "--station": STATION_COLOR[st.id] } as Record<string, string> },
      h("div", { class: "station-head" },
        h("span", { class: "swatch" }),
        h("b", null, st.name),
        h("small", null, st.real),
        h("label", { class: "skilled", title: "숙련공은 한 작업장에만 둘 수 있습니다. 불량률 −5%p" },
          h("input", {
            type: "radio", name: "skilled", checked: config.skilled_station === st.id,
            onchange: () => { config.skilled_station = st.id; ctx.onEdit(false); },
          }),
          "숙련공")),
      h("div", { class: "station-grid" },
        h("span", { class: "field-label" }, "작업자"),
        segmented(`workers-${st.id}`,
          Array.from({ length: scenario.rules.max_workers_per_station }, (_, k) => ({ value: k + 1, label: `${k + 1}명` })),
          cfg.workers, (v) => { cfg.workers = v; ctx.onEdit(false); }),
        h("span", { class: "field-label" }, "공법"),
        segmented(`method-${st.id}`, methods.map(([id, m]) => ({ value: id, label: m.name })),
          cfg.method, (v) => { cfg.method = v; ctx.onEdit(false); }),
        h("span", { class: "field-label" }, "운영"),
        h("div", { class: "toggles" },
          toggle("잔업", cfg.overtime, (on) => { cfg.overtime = on; ctx.onEdit(false); }),
          toggle("정비", cfg.maintenance, (on) => { cfg.maintenance = on; ctx.onEdit(false); })),
      ),
      h("div", { class: "station-preview" },
        h("span", null, "처리량 ", h("b", { "data-preview": `rate:${st.id}` }, "…"), " /일"),
        h("span", null, "불량률 ", h("b", { "data-preview": `defect:${st.id}` }, "…"))),
    );
  });

  const resourceSection = h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("span", { class: "step" }, "3"), h("h2", null, "자원 배치")),
    h("div", { class: "stations" }, stationCards),
    h("div", { class: "row-end" },
      h("label", { class: "skilled" },
        h("input", {
          type: "radio", name: "skilled", checked: config.skilled_station === null,
          onchange: () => { config.skilled_station = null; ctx.onEdit(false); },
        }),
        "숙련공 미배치"),
      h("p", { class: "hint fixed" },
        "고정비: 인건비 ", h("b", { "data-preview": "labor" }, "…"),
        " · 정비비 ", h("b", { "data-preview": "maintenance" }, "…"))),
  );

  const runSection = h("section", { class: "run-bar" },
    h("div", { class: "errors", "data-preview": "errors" }),
    h("button", { class: "btn primary run", type: "button", disabled: ctx.busy, onclick: () => ctx.onRun() },
      h("span", { class: "step light" }, "4"), `${scenario.days}일 실행`),
  );

  mount(root, presetSection, ordersSection, planSection, resourceSection, runSection);
}

/** 서버가 준 미리보기 값을 양식의 자리에 채운다. 오류가 있으면 실행 버튼을 막는다. */
export function updatePreview(root: HTMLElement, preview: Preview | null, errors: string[], busy: boolean): void {
  const slot = (key: string) => root.querySelector<HTMLElement>(`[data-preview="${key}"]`);
  if (preview) {
    for (const [id, st] of Object.entries(preview.stations)) {
      const rate = slot(`rate:${id}`);
      const defect = slot(`defect:${id}`);
      if (rate) rate.textContent = num(st.rate, 3);
      if (defect) defect.textContent = pct(st.defect_rate, 0);
    }
    const labor = slot("labor");
    const maintenance = slot("maintenance");
    if (labor) labor.textContent = money(preview.fixed_costs.labor);
    if (maintenance) maintenance.textContent = money(preview.fixed_costs.maintenance);
  }
  const box = slot("errors");
  if (box) mount(box, errors.length ? h("ul", null, errors.map((e) => h("li", null, e))) : null);
  const run = root.querySelector<HTMLButtonElement>("button.run");
  if (run) run.disabled = busy || errors.length > 0;
}
