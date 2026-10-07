// 화면의 상태와 연결. 서버에서 시나리오를 받고, 설정을 고치고, 실행 결과를 회차로 쌓는다.
// 시연 흐름: 분기 목표와 수주 → 계획 → 자원 배치 → 60일 진행(관제실) → 레포트(등급) → 현장 재현 → 재시도.
// 오른쪽은 [관제실 | 현장 | 레포트] 탭이고, 관제실 안은 [대시보드 3D | 간트]가 재생 커서를 함께 쓴다.

import { api, ApiError, type Config, type Finding, type Preview, type Result, type ScenarioPayload } from "./api";
import { h, mount } from "./dom";
import { renderForm, updatePreview } from "./form";
import { renderGantt } from "./gantt";
import { GRADE_COLOR, LOSS_STATES, STATION_COLOR, TRANSPORT_STATE } from "./labels";
import { eventText, renderReport } from "./report";

const SPEEDS = [1, 2, 4, 8];
const BASE_MS_PER_DAY = 500;   // 1배속은 하루에 0.5초, 60일이 30초다.
// 재생 중 사건 줄에 띄우는 사건. 투입, 완료, 출고, 운반은 너무 잦아서 뺀다.
const TICKER_EVENTS = new Set(["arrival", "defect", "accident", "breakdown", "delivery", "research_done"]);

interface Run {
  n: number;
  label: string;
  config: Config;
  result: Result;
  finished: boolean;           // 60일 끝까지 본 적이 있다 → 레포트와 현장이 열린다.
}

type View = "control" | "field" | "report";

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
  view: View;
  controlView: "scene" | "gantt";
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
  best: h("div", { class: "best" }),
  tabs: h("div", { class: "view-tabs" }),
  control: h("section", { class: "panel control-panel" }),
  field: h("section", { class: "panel field-panel" }),
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

async function suggestOrders(shipId: string | null): Promise<void> {
  try {
    const { order_days } = await api.suggestOrders(state.config);
    for (const [sid, days] of Object.entries(order_days)) {
      if (shipId === null || sid === shipId) Object.assign(state.config.ships[sid].order_days, days);
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
    state.runs.push({ n: state.runs.length + 1, label: runLabel(), config, result, finished: false });
    state.current = state.runs.length - 1;
    state.view = "control";
    state.day = 0;
    drawAll();
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
    if (state.day >= r.result.days) finish();
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

/** 60일에 닿았다: 재생을 멈추고 레포트를 연다. 현장 탭도 이때 열린다. */
function finish(): void {
  const r = currentRun();
  if (!r) return;
  state.day = r.result.days;
  state.playing = false;
  window.clearInterval(timer);
  r.finished = true;
  state.view = "report";
  drawAll();
}

/** 날짜가 바뀔 때마다 간트와 오늘의 사건, 컨트롤을 갱신한다. */
function tick(): void {
  const r = currentRun();
  if (!r) return;
  const { result } = r;
  const { scenario } = state.data;

  const chart = els.control.querySelector(".gantt-chart");
  if (chart) mount(chart, renderGantt(result, scenario, state.day));

  const slider = els.control.querySelector<HTMLInputElement>("input.scrub");
  if (slider) slider.value = String(state.day);
  const dayLabel = els.control.querySelector(".day-now");
  if (dayLabel) dayLabel.textContent = `${state.day} / ${result.days}일`;
  const playBtn = els.control.querySelector(".play");
  if (playBtn) playBtn.textContent = state.playing ? "❚❚ 멈춤" : "▶ 재생";

  const ticker = els.control.querySelector(".ticker");
  if (ticker) {
    const today = result.events.filter((ev) => ev.day === state.day && TICKER_EVENTS.has(ev.type));
    mount(ticker,
      h("span", { class: "ticker-day" }, state.day ? `${state.day}일` : "시작 전"),
      today.length
        ? today.map((ev) => h("span", { class: `ticker-item ${ev.type}` }, eventText(ev, scenario)))
        : h("span", { class: "ticker-quiet" }, state.day ? "특별한 사건 없음" : "재생을 누르면 1일부터 진행합니다"));
  }
}

// ---------------------------------------------------------------------------
// 탭과 패널
// ---------------------------------------------------------------------------

function drawAll(): void {
  drawBest();
  drawTabs();
  drawControl();
  drawField();
  drawReport();
}

/** 이번 세션 최고 등급. 화면 상태로만 보관한다. */
function drawBest(): void {
  const done = state.runs.filter((r) => r.finished);
  if (!done.length) {
    mount(els.best, h("span", { class: "best-empty" }, "분기 목표: 매출 11,200 · 이익 4,200 · 납기 100% · 직행률 90%"));
    return;
  }
  const best = done.reduce((a, b) => (b.result.grade.score > a.result.grade.score ? b : a));
  const g = best.result.grade;
  mount(els.best,
    h("span", null, "이번 세션 최고"),
    h("b", { class: "best-grade", style: { background: GRADE_COLOR[g.grade] } }, g.grade),
    h("span", null, `${g.score.toFixed(1)}점 · ${best.n}회차 ${best.label}`));
}

function drawTabs(): void {
  const r = currentRun();
  const locked = !r?.finished;
  const tab = (view: View, label: string, disabled = false, title = "") =>
    h("button", {
      type: "button", class: `tab${state.view === view ? " active" : ""}`, disabled, title,
      onclick: () => { state.view = view; drawAll(); },
    }, label);

  mount(els.tabs,
    h("div", { class: "tabs" },
      tab("control", "관제실"),
      tab("field", locked ? "현장 🔒" : "현장", locked, locked ? "60일을 끝까지 진행하면 열립니다" : ""),
      tab("report", "레포트", !r)),
    h("div", { class: "runs" }, state.runs.map((run, i) =>
      h("button", {
        type: "button", class: `run-chip${i === state.current ? " active" : ""}`,
        title: `이익 ${run.result.profit}`,
        onclick: () => {
          pause();
          state.current = i;
          state.day = run.finished ? run.result.days : 0;
          drawAll();
        },
      }, h("b", null, `${run.n}회차`), ` ${run.label}`,
      run.finished ? h("span", { class: "chip-grade", style: { background: GRADE_COLOR[run.result.grade.grade] } }, run.result.grade.grade) : null))));

  els.control.hidden = state.view !== "control";
  els.field.hidden = state.view !== "field";
  els.report.hidden = state.view !== "report";
}

function drawControl(): void {
  const r = currentRun();
  const { scenario } = state.data;
  if (!r) {
    mount(els.control,
      h("div", { class: "panel-head" }, h("h2", null, "관제실")),
      h("div", { class: "empty" },
        h("p", null, h("b", null, "아직 실행한 회차가 없습니다.")),
        h("p", null, "왼쪽에서 프리셋을 고르거나 직접 계획을 세운 뒤 실행하면, 4척이 60일 동안 블록 조립을 지나가는 모습이 여기에 나옵니다.")));
    return;
  }

  const sub = (view: "scene" | "gantt", label: string) =>
    h("button", {
      type: "button", class: `tab${state.controlView === view ? " active" : ""}`,
      onclick: () => { state.controlView = view; drawControl(); },
    }, label);

  const sameColor = LOSS_STATES.filter((l) => l.state !== "rework");
  const legend = h("div", { class: "legend" },
    scenario.stations.map((st) => h("span", null, h("i", { style: { background: STATION_COLOR[st.id] } }), st.name)),
    h("span", null, h("i", { class: "hatch" }), "재작업(빗금)"),
    h("span", null, h("i", { class: "transport-mark" }), TRANSPORT_STATE.name),
    h("span", { class: "sep" }),
    sameColor.map((l) => h("span", null, h("i", { class: `thin${l.hatch ? " hatch-over" : ""}`, style: { background: l.color } }), l.name)),
    h("span", { class: "sep" }),
    h("span", null, h("i", { class: "due-mark" }), "납기"),
    h("span", null, h("i", { class: "deliver-mark" }), "인도"));

  const body = state.controlView === "gantt"
    ? [h("div", { class: "gantt-chart" }), legend]
    : [h("div", { class: "empty scene-placeholder" },
      h("p", null, h("b", null, "대시보드 3D는 다음 단계에서 붙습니다.")),
      h("p", null, "같은 재생 커서로 조선소 전경이 움직입니다. 지금은 간트를 보세요."))];

  mount(els.control,
    h("div", { class: "panel-head" },
      h("h2", null, "관제실"),
      h("div", { class: "tabs" }, sub("scene", "대시보드 3D"), sub("gantt", "간트")),
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
        h("button", { class: "btn ghost", type: "button", title: "끝으로 건너뛰기 (End)", onclick: finish }, "끝으로 ⏭"))),
    h("div", { class: "scrub-row" },
      h("span", { class: "run-name" }, `${r.n}회차 · ${r.label}`),
      h("input", {
        class: "scrub", type: "range", min: 0, max: r.result.days, step: 1, value: String(state.day),
        oninput: (e: Event) => {
          // 값을 먼저 읽는다. pause()가 tick()으로 슬라이더를 지금 날짜로 되돌려 놓기 때문이다.
          const day = Number((e.target as HTMLInputElement).value);
          pause();
          seek(day);
        },
      }),
      h("span", { class: "day-now" }, "")),
    body,
    h("div", { class: "ticker" }));
  tick();
}

function drawField(): void {
  mount(els.field,
    h("div", { class: "panel-head" }, h("h2", null, "현장 재현")),
    h("div", { class: "empty" },
      h("p", null, h("b", null, "현장 재현(3D)은 다음 단계에서 붙습니다.")),
      h("p", null, "레포트의 의문점 카드에서 고른 날짜로 가서, 같은 결과를 현장 눈높이로 다시 봅니다.")));
}

function openFinding(f: Finding): void {
  pause();
  state.view = "control";
  state.controlView = "gantt";
  drawAll();
  seek(f.start);
}

function drawReport(): void {
  const r = currentRun();
  const { scenario } = state.data;
  if (!r) {
    mount(els.report, h("div", { class: "panel-head" }, h("h2", null, "레포트")),
      h("p", { class: "hint" }, "실행이 끝나면 등급, 의문점, QCD, 원가, 리드타임 분해, OEE가 여기에 나옵니다."));
    return;
  }
  const body = r.finished
    ? renderReport(r.result, scenario, state.data.max_rate, openFinding)
    : h("div", { class: "empty" },
      h("p", null, h("b", null, "60일 진행 중입니다.")),
      h("p", null, "끝까지 진행하면 레포트가 나옵니다."),
      h("button", { class: "btn ghost", type: "button", onclick: finish }, "끝으로 건너뛰기 ⏭"));
  mount(els.report,
    h("div", { class: "panel-head" }, h("h2", null, "레포트"), h("span", { class: "run-name" }, `${r.n}회차 · ${r.label}`)),
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
    finish();
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
    view: "control",
    controlView: "gantt",
    day: 0,
    playing: false,
    speed: 2,
  };

  mount(root,
    h("header", { class: "topbar" },
      h("div", { class: "brand" },
        h("span", { class: "logo", "aria-hidden": "true" }, "⛵"),
        h("div", null,
          h("h1", null, "종이배 조선소 관제실"),
          h("p", null, "생산관리 시뮬레이터 · 7요소 · QCD · 4M"))),
      els.best),
    h("div", { class: "layout" }, els.form,
      h("main", { class: "main" }, els.tabs, els.control, els.field, els.report)));

  document.addEventListener("keydown", onKey);
  drawForm();
  drawAll();
  schedulePreview();
}

void start();
