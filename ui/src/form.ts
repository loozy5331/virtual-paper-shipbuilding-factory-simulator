// 왼쪽 계획 양식: 프리셋 → ① 수주와 계획(4척 요약) → ② [공통 | S1~S4] 탭 → 실행.
// 입력 중에는 양식을 다시 그리지 않는다(그러면 커서가 사라진다). 값만 config에 넣고 알린다.
// 탭 전환도 hidden만 바꾼다. 처리량, 불량률, 고정비, 연구 일정은 서버의 /api/preview 결과를 data-preview 자리에 채운다.

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
  /** 발주일 역산. shipId가 있으면 그 배만 바꾼다. */
  onSuggest(shipId: string | null): void;
  onRun(): void;
}

// 다시 그려도 보던 탭을 유지한다.
let activeTab = "common";

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

function showTab(root: HTMLElement, tab: string): void {
  activeTab = tab;
  root.querySelectorAll<HTMLElement>("[data-pane]").forEach((pane) => { pane.hidden = pane.dataset.pane !== tab; });
  root.querySelectorAll<HTMLElement>("[data-tab]").forEach((btn) => btn.classList.toggle("active", btn.dataset.tab === tab));
}

export function renderForm(root: HTMLElement, ctx: FormContext): void {
  const { scenario, config } = ctx;
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

  // ① 수주와 계획: 4척 요약 줄. 우선순위는 겹치면 맞바꾼다.
  const summary = h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("span", { class: "step" }, "1"), h("h2", null, "수주와 계획")),
    h("table", { class: "plan" },
      h("thead", null, h("tr", null,
        h("th", null, "배"), h("th", null, "선종"), h("th", { class: "r" }, "납기"), h("th", { class: "r" }, "계약금"),
        h("th", null, "우선순위"), h("th", null, "착수일"))),
      h("tbody", null, scenario.orders.map((order) => {
        const ship = config.ships[order.id];
        return h("tr", null,
          h("td", null, h("b", null, order.id)),
          h("td", null, scenario.ship_types[order.type].name),
          h("td", { class: "r" }, `${order.due_day}일`),
          h("td", { class: "r" }, num(order.price)),
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
          h("td", null, dayInput(ship.start_day, (v) => { ship.start_day = v as number; ctx.onEdit(false); }, scenario.days, false)));
      }))),
    h("div", { class: "row-end" },
      h("p", { class: "hint" }, "작업장, 사람, 운반 모두 우선순위 순으로 받습니다."),
      h("button", { class: "btn ghost", type: "button", disabled: ctx.busy, onclick: () => ctx.onSuggest(null) }, "전체 발주일 역산")),
  );

  // ② 탭
  const tabs = [{ id: "common", label: "공통" }, ...orderIds.map((id) => ({ id, label: id }))];
  const tabBar = h("div", { class: "tabs form-tabs", role: "tablist" },
    tabs.map((t) => h("button", {
      type: "button", class: "tab", "data-tab": t.id, role: "tab",
      onclick: () => showTab(root, t.id),
    }, t.label, h("span", { class: "warn", "data-warn": t.id, hidden: true }, " ⚠"))));

  const panes = h("div", { class: "panes" }, commonPane(ctx), orderIds.map((sid) => shipPane(ctx, sid)));

  const settings = h("section", { class: "panel" },
    h("div", { class: "panel-head" }, h("span", { class: "step" }, "2"), h("h2", null, "자원과 일정")),
    tabBar, panes);

  const runSection = h("section", { class: "run-bar" },
    h("div", { class: "errors", "data-preview": "errors" }),
    h("button", { class: "btn primary run", type: "button", disabled: ctx.busy, onclick: () => ctx.onRun() },
      h("span", { class: "step light" }, "3"), `${scenario.days}일 실행`),
  );

  mount(root, presetSection, summary, settings, runSection);
  showTab(root, activeTab);
}

function commonPane(ctx: FormContext): HTMLElement {
  const { scenario, config } = ctx;
  const methods = Object.entries(scenario.rules.methods);

  const pool = h("div", { class: "field-row" },
    h("span", { class: "field-label" }, "작업대기소"),
    segmented("pool",
      Array.from({ length: scenario.rules.max_pool }, (_, k) => ({ value: k + 1, label: String(k + 1) })),
      config.pool, (v) => { config.pool = v; ctx.onEdit(false); }),
    h("small", null, "명"));

  const senior = h("div", { class: "field-row" },
    h("span", { class: "field-label" }, "시니어"),
    h("select", {
      class: "select",
      onchange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value;
        config.skilled_station = v === "" ? null : v;
        ctx.onEdit(false);
      },
    },
    h("option", { value: "", selected: config.skilled_station === null }, "미배치"),
    scenario.stations.map((st) => h("option", { value: st.id, selected: config.skilled_station === st.id }, st.name))),
    h("small", null, "그 공정 불량률 −5%p, 대기소 인원과 별도"));

  const transporter = h("div", { class: "field-row" },
    h("span", { class: "field-label" }, "트랜스포터"),
    segmented("transporters",
      Array.from({ length: scenario.transporter.max_count }, (_, k) => ({ value: k + 1, label: `${k + 1}대` })),
      config.transporters.count, (v) => { config.transporters.count = v; ctx.onEdit(false); }),
    toggle("정비", config.transporters.maintenance, (on) => { config.transporters.maintenance = on; ctx.onEdit(false); }));

  const stationCards = scenario.stations.map((st) => {
    const cfg = config.stations[st.id];
    return h("div", { class: "station", style: { "--station": STATION_COLOR[st.id] } as Record<string, string> },
      h("div", { class: "station-head" },
        h("span", { class: "swatch" }),
        h("b", null, st.name),
        h("small", null, st.real.split(":")[0])),
      h("div", { class: "station-grid" },
        h("span", { class: "field-label" }, "공법"),
        segmented(`method-${st.id}`, methods.map(([id, m]) => ({ value: id, label: m.name })),
          cfg.method, (v) => { cfg.method = v; ctx.onEdit(false); }),
        h("span", { class: "field-label" }, "운영"),
        h("div", { class: "toggles" },
          toggle("잔업", cfg.overtime, (on) => { cfg.overtime = on; ctx.onEdit(false); }),
          toggle("정비", cfg.maintenance, (on) => { cfg.maintenance = on; ctx.onEdit(false); })),
      ),
      h("div", { class: "station-preview" },
        h("span", null, "최대 ", h("b", { "data-preview": `rate:${st.id}` }, "…"), "/일"),
        h("span", null, "불량률 ", h("b", { "data-preview": `defect:${st.id}` }, "…"))),
    );
  });

  return h("div", { class: "pane", "data-pane": "common" },
    pool, senior, transporter,
    researchQueue(ctx),
    h("div", { class: "stations" }, stationCards),
    h("p", { class: "hint fixed" },
      "고정비: 인건비 ", h("b", { "data-preview": "labor" }, "…"),
      " · 정비비 ", h("b", { "data-preview": "maintenance" }, "…"),
      " · 트랜스포터 ", h("b", { "data-preview": "transporter" }, "…"),
      " · 연구비 ", h("b", { "data-preview": "research" }, "…")));
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
            h("button", { type: "button", class: "icon-btn", title: "빼기", onclick: () => edit(queue.filter((r) => r !== id)) }, "✕")));
      }))
      : h("p", { class: "hint" }, "비어 있음. 연구는 운영을 함께 바꿔야 돈이 됩니다."),
    waiting.length
      ? h("div", { class: "queue-add" }, waiting.map((id) => {
        const info = scenario.research[id];
        return h("button", { type: "button", class: "chip-btn", onclick: () => edit([...queue, id]) },
          `+ ${info.name}`, h("small", null, ` ${num(info.cost)} · ${info.days}일`));
      }))
      : null);
}

function shipPane(ctx: FormContext, sid: string): HTMLElement {
  const { scenario, config } = ctx;
  const order = scenario.orders.find((o) => o.id === sid)!;
  const type = scenario.ship_types[order.type];
  const ship = config.ships[sid];

  return h("div", { class: "pane", "data-pane": sid, hidden: true },
    h("dl", { class: "ship-info" },
      h("div", null, h("dt", null, "선종"), h("dd", null, type.name)),
      h("div", null, h("dt", null, "수주"), h("dd", null, `${order.order_day}일`)),
      h("div", null, h("dt", null, "납기"), h("dd", null, `${order.due_day}일`)),
      h("div", null, h("dt", null, "계약금"), h("dd", null, num(order.price)))),
    h("div", { class: "field-row" },
      h("span", { class: "field-label" }, "작업량"),
      h("span", { class: "work-cells" }, scenario.stations.map((st) =>
        h("span", { class: "work-chip", title: st.name, style: { borderColor: STATION_COLOR[st.id] } },
          `${st.name} ${type.work[st.id]}`)))),
    h("table", { class: "plan orders-table" },
      h("thead", null, h("tr", null,
        h("th", null, "자재"), h("th", { class: "r" }, "소요량"), h("th", null, "쓰는 공정"),
        h("th", null, "발주일"), h("th", null, "리드타임"))),
      h("tbody", null, scenario.materials.map((m) => {
        const station = scenario.stations.find((st) => st.material === m.id);
        return h("tr", null,
          h("td", null, h("b", null, m.name)),
          h("td", { class: "r" }, type.bom[m.id] ?? 0),
          h("td", null, station?.name ?? "—"),
          h("td", null, dayInput(ship.order_days[m.id] ?? null, (v) => { ship.order_days[m.id] = v; ctx.onEdit(false); }, scenario.days, true)),
          h("td", null, h("small", null, `입고 +${m.lead_days}일`)));
      }))),
    h("div", { class: "row-end" },
      h("p", { class: "hint" }, "재고는 4척이 함께 씁니다. 빈칸은 발주하지 않습니다."),
      h("button", { class: "btn ghost", type: "button", disabled: ctx.busy, onclick: () => ctx.onSuggest(sid) }, "이 배만 역산")));
}

/** 서버가 준 미리보기 값을 양식의 자리에 채운다. 오류가 있으면 실행 버튼을 막고, 오류가 난 탭에 ⚠를 붙인다. */
export function updatePreview(root: HTMLElement, preview: Preview | null, errors: string[], busy: boolean): void {
  const slot = (key: string) => root.querySelector<HTMLElement>(`[data-preview="${key}"]`);
  if (preview) {
    for (const [id, st] of Object.entries(preview.stations)) {
      const rate = slot(`rate:${id}`);
      const defect = slot(`defect:${id}`);
      if (rate) rate.textContent = num(st.rate, 3);
      if (defect) {
        defect.textContent = st.defect_rate_final === st.defect_rate
          ? pct(st.defect_rate, 0)
          : `${pct(st.defect_rate, 0)} → ${pct(st.defect_rate_final, 0)}`;
      }
    }
    for (const key of ["labor", "maintenance", "transporter", "research"] as const) {
      const el = slot(key);
      if (el) el.textContent = money(preview.fixed_costs[key]);
    }
    for (const r of preview.research) {
      const el = slot(`research:${r.id}`);
      if (el) el.textContent = r.done ? `${r.start}~${r.end}일, ${r.effective_from}일부터 효과` : `${r.start}일 시작, 기간 안에 못 끝남`;
    }
  }
  // 오류 메시지는 "S2: …"처럼 배 id로 시작한다. 배가 아닌 오류는 공통 탭에 표시한다.
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
