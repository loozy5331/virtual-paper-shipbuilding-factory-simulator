// 화면의 상태와 연결. 서버에서 시나리오를 받고, 설정을 고치고, 실행 결과를 회차로 쌓는다.
// 시연 흐름: 수주 → 계획 → 자원 배치 → 60일 진행(간트) → 레포트 → 재실행 → 비교.

import { api, ApiError, type Config, type Preview, type ScenarioPayload } from "./api";
import { renderCompare, type Run } from "./compare";
import { h, mount } from "./dom";
import { renderForm, updatePreview } from "./form";
import { renderGantt } from "./gantt";
import { LOSS_STATES, STATION_COLOR } from "./labels";
import { eventText, renderReport } from "./report";

const SPEEDS = [1, 2, 4, 8];
const BASE_MS_PER_DAY = 500;   // 1배속은 하루에 0.5초, 60일이 30초다.

interface State {
  data: ScenarioPayload;
  config: Config;
  presetId: string | null;
  edited: boolean;
  preview: Preview | null;
  errors: string[];
  busy: boolean;
  runs: Run[];
  current: number | null;        // 보고 있는 회차의 인덱스
  tab: "report" | "compare";
  compare: { a: number; b: number };
  day: number;
  playing: boolean;
  speed: number;
}

let state: State;
let timer: number | undefined;
let previewSeq = 0;
let previewTimer: number | undefined;

const els = {
  form: h("aside", { class: "form" }),
  gantt: h("section", { class: "panel gantt-panel" }),
  report: h("section", { class: "panel report-panel" }),
};

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------

function drawForm(): void {
  renderForm(els.form, {
    scenario: state.data.scenario,
    presets: state.data.presets,
    config: state.config,
    presetId: state.presetId,
    edited: state.edited,
    busy: state.busy,
    onEdit: (redraw) => {
      state.edited = true;
      if (redraw) drawForm();
      // 입력 중에 양식을 다시 그리면 커서가 빠지므로 "(수정함)" 표시만 드러낸다.
      else els.form.querySelector(".edited")?.removeAttribute("hidden");
      schedulePreview();
    },
    onPreset: loadPreset,
    onSuggest: suggestOrders,
    onRun: run,
  });
  updatePreview(els.form, state.preview, state.errors, state.busy);
}

function loadPreset(id: string): void {
  const preset = state.data.presets.find((p) => p.id === id);
  if (!preset) return;
  state.config = structuredClone(preset.config);
  state.presetId = id;
  state.edited = false;
  drawForm();
  schedulePreview();
}

function schedulePreview(): void {
  window.clearTimeout(previewTimer);
  previewTimer = window.setTimeout(refreshPreview, 120);
}

async function refreshPreview(): Promise<void> {
  const seq = ++previewSeq;
  try {
    const preview = await api.preview(state.config);
    if (seq !== previewSeq) return;   // 더 최근 요청이 있으면 버린다.
    state.preview = preview;
    state.errors = [];
  } catch (error) {
    if (seq !== previewSeq) return;
    state.errors = error instanceof ApiError ? error.messages : [String(error)];
  }
  updatePreview(els.form, state.preview, state.errors, state.busy);
}

async function suggestOrders(): Promise<void> {
  try {
    const { order_days } = await api.suggestOrders(state.config);
    for (const [sid, days] of Object.entries(order_days)) {
      Object.assign(state.config.ships[sid].order_days, days);
    }
    state.edited = true;
    drawForm();
    schedulePreview();
  } catch (error) {
    state.errors = error instanceof ApiError ? error.messages : [String(error)];
    updatePreview(els.form, state.preview, state.errors, state.busy);
  }
}

function runLabel(): string {
  const preset = state.data.presets.find((p) => p.id === state.presetId);
  if (!preset) return "직접 설정";
  return state.edited ? `${preset.name} 수정` : preset.name;
}

async function run(): Promise<void> {
  state.busy = true;
  updatePreview(els.form, state.preview, state.errors, state.busy);
  try {
    const config = structuredClone(state.config);
    const result = await api.simulate(config);
    state.runs.push({ n: state.runs.length + 1, label: runLabel(), config, result });
    state.current = state.runs.length - 1;
    state.tab = "report";
    if (state.runs.length >= 2) {
      state.compare = { a: state.runs.length - 2, b: state.runs.length - 1 };
    }
    state.day = 0;
    drawGantt();
    drawReport();
    play();
  } catch (error) {
    state.errors = error instanceof ApiError ? error.messages : [String(error)];
  } finally {
    state.busy = false;
    updatePreview(els.form, state.preview, state.errors, state.busy);
  }
}

// ---------------------------------------------------------------------------
// 재생
// ---------------------------------------------------------------------------

function currentRun(): Run | null {
  return state.current === null ? null : state.runs[state.current] ?? null;
}

function play(): void {
  const r = currentRun();
  if (!r) return;
  if (state.day >= r.result.days) state.day = 0;
  state.playing = true;
  restartTimer();
  tick();
}

function pause(): void {
  state.playing = false;
  window.clearInterval(timer);
  tick();
}

function restartTimer(): void {
  window.clearInterval(timer);
  if (!state.playing) return;
  timer = window.setInterval(() => {
    const r = currentRun();
    if (!r) return pause();
    state.day = Math.min(r.result.days, state.day + 1);
    if (state.day >= r.result.days) pause();
    else tick();
  }, BASE_MS_PER_DAY / state.speed);
}

function seek(day: number): void {
  const r = currentRun();
  if (!r) return;
  state.day = Math.max(0, Math.min(r.result.days, day));
  if (state.day >= r.result.days) pause();
  else tick();
}

/** 날짜가 바뀔 때마다 간트와 오늘의 사건, 컨트롤을 갱신한다. 끝에 닿으면 레포트를 연다. */
function tick(): void {
  const r = currentRun();
  if (!r) return;
  const { result } = r;
  const { scenario } = state.data;

  const chart = els.gantt.querySelector(".gantt-chart");
  if (chart) mount(chart, renderGantt(result, scenario, state.day));

  const slider = els.gantt.querySelector<HTMLInputElement>("input.scrub");
  if (slider) slider.value = String(state.day);
  const dayLabel = els.gantt.querySelector(".day-now");
  if (dayLabel) dayLabel.textContent = `${state.day} / ${result.days}일`;
  const playBtn = els.gantt.querySelector(".play");
  if (playBtn) playBtn.textContent = state.playing ? "❚❚ 멈춤" : "▶ 재생";

  const ticker = els.gantt.querySelector(".ticker");
  if (ticker) {
    const today = result.events.filter((ev) => ev.day === state.day && ev.type !== "enter" && ev.type !== "complete");
    mount(ticker,
      h("span", { class: "ticker-day" }, state.day ? `${state.day}일` : "시작 전"),
      today.length
        ? today.map((ev) => h("span", { class: `ticker-item ${ev.type}` }, eventText(ev, scenario)))
        : h("span", { class: "ticker-quiet" }, state.day ? "특별한 사건 없음" : "재생을 누르면 1일부터 진행합니다"));
  }

  const ended = state.day >= result.days;
  const reportWasOpen = els.report.dataset.open === "true";
  if (ended !== reportWasOpen) drawReport();
}

// ---------------------------------------------------------------------------
// 간트 패널
// ---------------------------------------------------------------------------

function drawGantt(): void {
  const r = currentRun();
  const { scenario } = state.data;
  if (!r) {
    mount(els.gantt,
      h("div", { class: "panel-head" }, h("h2", null, "공정 진행")),
      h("div", { class: "empty" },
        h("p", null, h("b", null, "아직 실행한 회차가 없습니다.")),
        h("p", null, "왼쪽에서 프리셋을 고르거나 직접 정한 뒤 실행하면, 배 3척이 60일 동안 공정을 지나가는 모습이 여기에 나옵니다.")));
    return;
  }

  const legend = h("div", { class: "legend" },
    scenario.stations.map((st) => h("span", null, h("i", { style: { background: STATION_COLOR[st.id] } }), st.name)),
    h("span", { class: "sep" }),
    h("span", null, h("i", { class: "hatch" }), "재작업(빗금)"),
    LOSS_STATES.map((l) => h("span", null, h("i", { class: "thin", style: { background: l.color } }), l.name)),
    h("span", { class: "sep" }),
    h("span", null, h("i", { class: "due-mark" }), "납기"),
    h("span", null, h("i", { class: "deliver-mark" }), "인도"));

  mount(els.gantt,
    h("div", { class: "panel-head" },
      h("h2", null, "공정 진행"),
      h("span", { class: "run-name" }, `${r.n}회차 · ${r.label}`),
      h("div", { class: "controls" },
        h("button", { class: "btn ghost", type: "button", title: "처음부터", onclick: () => { pause(); seek(0); } }, "⟲"),
        h("button", { class: "btn play", type: "button", onclick: () => (state.playing ? pause() : play()) }, "▶ 재생"),
        h("div", { class: "seg small" }, SPEEDS.map((sp) =>
          h("label", { class: "seg-item" },
            h("input", {
              type: "radio", name: "speed", checked: state.speed === sp,
              onchange: () => { state.speed = sp; restartTimer(); },
            }),
            h("span", null, `${sp}×`)))),
        h("button", { class: "btn ghost", type: "button", title: "끝으로 건너뛰기 (End)", onclick: () => seek(r.result.days) }, "끝으로 ⏭"))),
    h("div", { class: "scrub-row" },
      h("input", {
        class: "scrub", type: "range", min: 0, max: r.result.days, step: 1, value: String(state.day),
        oninput: (e: Event) => { pause(); seek(Number((e.target as HTMLInputElement).value)); },
      }),
      h("span", { class: "day-now" }, "")),
    h("div", { class: "gantt-chart" }),
    legend,
    h("div", { class: "ticker" }));
  tick();
}

// ---------------------------------------------------------------------------
// 레포트 패널
// ---------------------------------------------------------------------------

function drawReport(): void {
  const r = currentRun();
  const { scenario } = state.data;
  if (!r) {
    els.report.dataset.open = "false";
    mount(els.report, h("div", { class: "panel-head" }, h("h2", null, "레포트")),
      h("p", { class: "hint" }, "실행이 끝나면 QCD, 원가, 리드타임 분해, OEE가 여기에 나옵니다."));
    return;
  }

  const ended = state.day >= r.result.days;
  els.report.dataset.open = String(ended);

  const tabs = h("div", { class: "tabs" },
    h("button", {
      type: "button", class: `tab${state.tab === "report" ? " active" : ""}`,
      onclick: () => { state.tab = "report"; drawReport(); },
    }, "레포트"),
    h("button", {
      type: "button", class: `tab${state.tab === "compare" ? " active" : ""}`,
      disabled: state.runs.length < 2, title: state.runs.length < 2 ? "두 번 이상 실행하면 비교할 수 있습니다" : "",
      onclick: () => { state.tab = "compare"; drawReport(); },
    }, "비교"));

  const runChips = h("div", { class: "runs" }, state.runs.map((run, i) =>
    h("button", {
      type: "button", class: `run-chip${i === state.current ? " active" : ""}`,
      title: `이익 ${run.result.profit}`,
      onclick: () => {
        pause();
        state.current = i;
        state.day = run.result.days;
        drawGantt();
        drawReport();
      },
    }, h("b", null, `${run.n}회차`), ` ${run.label}`)));

  let body: HTMLElement;
  if (state.tab === "compare" && state.runs.length >= 2) {
    body = renderCompare(state.runs, state.compare.a, state.compare.b, scenario, (side, index) => {
      state.compare[side] = index;
      drawReport();
    });
  } else if (!ended) {
    body = h("div", { class: "empty" },
      h("p", null, h("b", null, "60일 진행 중입니다.")),
      h("p", null, "끝까지 진행하면 레포트가 나옵니다."),
      h("button", { class: "btn ghost", type: "button", onclick: () => seek(r.result.days) }, "끝으로 건너뛰기 ⏭"));
  } else {
    body = renderReport(r.result, scenario, state.data.max_rate);
  }

  mount(els.report,
    h("div", { class: "panel-head" }, h("h2", null, "레포트"), tabs, runChips),
    body);
}

// ---------------------------------------------------------------------------
// 시작
// ---------------------------------------------------------------------------

function onKey(e: KeyboardEvent): void {
  const target = e.target as HTMLElement;
  if (target.closest("input, select, textarea")) return;
  const r = currentRun();
  if (!r) return;
  if (e.key === " ") {
    e.preventDefault();
    if (state.playing) pause(); else play();
  } else if (e.key === "End") {
    e.preventDefault();
    seek(r.result.days);
  } else if (e.key === "ArrowRight") {
    pause(); seek(state.day + 1);
  } else if (e.key === "ArrowLeft") {
    pause(); seek(state.day - 1);
  }
}

async function start(): Promise<void> {
  const root = document.getElementById("app")!;
  let data: ScenarioPayload;
  try {
    data = await api.scenario();
  } catch (error) {
    mount(root, h("div", { class: "fatal" },
      h("h1", null, "시나리오를 불러오지 못했습니다"),
      h("p", null, error instanceof ApiError ? error.messages.join(" ") : String(error))));
    return;
  }

  const first = data.presets.find((p) => p.id === "managed") ?? data.presets[0];
  state = {
    data,
    config: structuredClone(first.config),
    presetId: first.id,
    edited: false,
    preview: null,
    errors: [],
    busy: false,
    runs: [],
    current: null,
    tab: "report",
    compare: { a: 0, b: 1 },
    day: 0,
    playing: false,
    speed: 2,
  };

  mount(root,
    h("header", { class: "topbar" },
      h("div", { class: "brand" },
        h("span", { class: "logo", "aria-hidden": "true" }, "⛵"),
        h("div", null,
          h("h1", null, "종이배 조선소"),
          h("p", null, "생산관리 시뮬레이터 · 7요소 · QCD · 4M"))),
      h("p", { class: "topbar-note" }, "같은 수주, 같은 난수. 설정만 바꿔서 결과를 비교합니다.")),
    h("div", { class: "layout" }, els.form, h("main", { class: "main" }, els.gantt, els.report)));

  document.addEventListener("keydown", onKey);
  drawForm();
  drawGantt();
  drawReport();
  schedulePreview();
}

void start();
