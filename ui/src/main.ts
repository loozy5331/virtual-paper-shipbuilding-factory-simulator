// 화면의 상태와 연결. 서버에서 시나리오를 받고, 설정을 고치고, 실행 결과를 회차로 쌓는다.
// 시연 흐름: 분기 목표와 수주 → 계획 → 자원 배치 → 60일 진행(관제실) → 레포트(등급) → 현장 재현 → 재시도.
// 오른쪽은 [관제실 | 현장 | 레포트] 탭이다. 관제실은 간트([전체 | 배별]), 현장은 3D이고 재생 커서를 함께 쓴다.

import { api, ApiError, type Config, type Finding, type Preview, type Result, type ScenarioPayload } from "./api";
import { h, mount } from "./dom";
import { renderForm, updatePreview } from "./form";
import { renderGantt, renderShipGantt } from "./gantt";
import { docHead } from "./paper";
import { EVENT_NAME, GRADE_COLOR, LOSS_STATES, STATION_COLOR, TRANSPORT_STATE } from "./labels";
import { breakdownBar, breakdownLegend, eventText, renderReport } from "./report";
import type { Yard } from "./scene/yard";

const SPEEDS = [1, 2, 4, 8];
const BASE_MS_PER_DAY = 500;   // 1배속은 하루에 0.5초, 60일이 30초다.
// 재생 중 사건 줄에 띄우는 사건. 투입, 완료, 출고, 운반은 너무 잦아서 뺀다.
const TICKER_EVENTS = new Set(["arrival", "defect", "accident", "breakdown", "delivery", "research_done"]);
// 배 탭 아래 사건 기록: 투입, 완료, 입고, 불량, 사고, 운반, 인도
const SHIP_EVENTS = new Set(["arrival", "enter", "complete", "defect", "accident", "transport_start", "delivery"]);

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
  /** 간트에서 보는 배. null이면 4척 전체. */
  ganttShip: string | null;
  day: number;
  playing: boolean;
  speed: number;
  /** 현장 카메라가 비출 공정과 안내 문구(의문점 카드에서 왔을 때). */
  focus: { station: number; text: string } | null;
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
  playbar: h("div", { class: "panel playbar" }),
  // 오른쪽 클립보드. 현장(3D)을 볼 때는 클립보드를 내려놓는다(board-down).
  board: h("div", { class: "clipboard board-right" }),
  // 종이 머리글(공정 실적표 / 생산실적 평가서). 재생 막대보다 위에 와야 해서 패널 밖에 둔다.
  sheetHead: h("div", { class: "panel sheet-head" }),
  sceneField: h("div", { class: "scene-host field" }),
};

// 3D(Three.js)는 처음 볼 때 불러온다. 간트만 쓰면 받지 않는다.
let yard: Yard | null = null;
let yardLoading: Promise<void> | null = null;
let yardRun: Run | null = null;
let buildFrame: typeof import("./scene/frame").buildFrame | null = null;
const introSeen = new Set<number>();

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
    state.focus = null;
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
  tick(true);
}

function pause(): void {
  state.playing = false;
  window.clearInterval(timer);
  tick(true);
}

function restartTimer(): void {
  window.clearInterval(timer);
  if (!state.playing) return;
  timer = window.setInterval(() => {
    const r = currentRun();
    if (!r) return pause();
    state.day = Math.min(r.result.days, state.day + 1);
    // 현장에서 재현 중이면 60일에 닿아도 레포트로 넘기지 않는다(이미 본 회차다).
    if (state.day >= r.result.days && !(state.view === "field" && r.finished)) finish();
    else if (state.day >= r.result.days) pause();
    else tick(false);
  }, BASE_MS_PER_DAY / state.speed);
}

function seek(day: number): void {
  const r = currentRun();
  if (!r) return;
  state.day = Math.max(0, Math.min(r.result.days, day));
  if (state.day >= r.result.days && state.playing) pause();
  else tick(true);
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

/** 날짜가 바뀔 때마다 간트, 3D, 오늘의 사건, 컨트롤을 갱신한다. jump면 3D 소인이 걷지 않고 바로 옮긴다. */
function tick(jump: boolean): void {
  const r = currentRun();
  if (!r) return;
  const { result } = r;
  const { scenario } = state.data;

  const chart = els.control.querySelector(".gantt-chart");
  const ship = result.ships.find((sh) => sh.id === state.ganttShip);
  if (chart) mount(chart, ship ? renderShipGantt(result, scenario, ship.id, state.day) : renderGantt(result, scenario, state.day));
  const detail = els.control.querySelector(".ship-detail");
  if (detail && ship) {
    // 그 배의 사건(오늘까지)과, 60일이 끝났으면 리드타임 분해. 합계는 끝난 뒤에만 보여 준다.
    const mine = result.events.filter((ev) => ev.day <= state.day && "ship" in ev && ev.ship === ship.id && SHIP_EVENTS.has(ev.type));
    const ended = state.day >= result.days;
    mount(detail,
      ended ? h("div", { class: "lead-row" }, h("span", { class: "lead-name" }, h("b", null, ship.id)),
        breakdownBar(ship, Math.max(1, ship.lead_time)), h("span", { class: "lead-total" }, `${ship.lead_time}일`)) : null,
      ended ? breakdownLegend() : null,
      h("ol", { class: "events ship-events" }, mine.length
        ? mine.map((ev) => h("li", null, h("span", { class: "ev-day" }, `${ev.day}일`), h("span", { class: `ev-type ${ev.type}` }, EVENT_NAME[ev.type]), h("span", null, eventText(ev, scenario))))
        : h("li", { class: "quiet" }, "아직 이 배의 사건이 없습니다.")));
  }

  const slider = els.playbar.querySelector<HTMLInputElement>("input.scrub");
  if (slider) slider.value = String(state.day);
  const dayLabel = els.playbar.querySelector(".day-now");
  if (dayLabel) dayLabel.textContent = `${state.day} / ${result.days}일`;
  const playBtn = els.playbar.querySelector(".play");
  if (playBtn) playBtn.textContent = state.playing ? "❚❚ 멈춤" : "▶ 재생";

  const ticker = els.playbar.querySelector(".ticker");
  if (ticker) {
    const today = result.events.filter((ev) => ev.day === state.day && TICKER_EVENTS.has(ev.type));
    mount(ticker,
      h("span", { class: "ticker-day" }, state.day ? `${state.day}일` : "시작 전"),
      today.length
        ? today.map((ev) => h("span", { class: `ticker-item ${ev.type}` }, eventText(ev, scenario)))
        : h("span", { class: "ticker-quiet" }, state.day ? "특별한 사건 없음" : "재생을 누르면 1일부터 진행합니다"));
  }
  syncScene(jump);
}

// ---------------------------------------------------------------------------
// 3D 장면
// ---------------------------------------------------------------------------

function sceneHost(): HTMLElement | null {
  if (state.view === "field") return els.sceneField;
  return null;
}

/** 지금 3D를 보는 탭이면 장면을 오늘 날짜로 맞추고, 아니면 그리기를 멈춘다. */
function syncScene(jump: boolean): void {
  const host = sceneHost();
  const r = currentRun();
  if (!host || !r) {
    yard?.stop();
    return;
  }
  if (!yard) {
    yardLoading ??= Promise.all([import("./scene/yard"), import("./scene/frame")]).then(([y, f]) => {
      yard = new y.Yard();
      buildFrame = f.buildFrame;
    });
    void yardLoading.then(() => syncScene(true));
    return;
  }
  yard.attach(host);
  if (yardRun !== r) {
    yard.load(r.result.ships.map((s) => s.id));
    yardRun = r;
    jump = true;
  }
  const { scenario } = state.data;
  const day = state.day;
  yard.setSource({
    frameAt: (frac) => buildFrame!(r.result, scenario, r.config, day, frac),
    playing: state.playing,
    msPerDay: BASE_MS_PER_DAY / state.speed,
    // 1배속 이하에서만 걷는 모습을 보여 준다. 빠르면 바로 옮긴다.
    snap: jump || state.speed > 1,
  });
  yard.start();
}

// ---------------------------------------------------------------------------
// 탭과 패널
// ---------------------------------------------------------------------------

function drawAll(): void {
  drawBest();
  drawTabs();
  drawPlaybar();
  drawControl();
  drawField();
  drawReport();
  drawSheetHead();
  tick(true);
}

/** 오른쪽 종이의 서식 머리글. 관제실은 공정 실적표, 레포트는 생산실적 평가서, 현장에는 종이가 없다. */
function drawSheetHead(): void {
  const r = currentRun();
  const days = state.data.scenario.days;
  els.sheetHead.hidden = state.view === "field";
  if (state.view === "report") {
    const g = r?.result.grade;
    mount(els.sheetHead, docHead({
      title: "생산실적 평가서", code: r ? `PE-${r.n}` : "PE-—",
      fields: r
        ? [["회차", `${r.n}회차`], ["설정", r.label], ["판정", r.finished && g ? `${g.grade} (${g.score.toFixed(1)}점)` : "진행 중"]]
        : [["회차", "—"]],
      stamp: r?.finished && g ? { text: g.grade, sub: `${g.score.toFixed(1)}점`, color: GRADE_COLOR[g.grade] ?? "#4b5a51" } : null,
    }));
  } else if (state.view === "control") {
    mount(els.sheetHead, docHead({
      title: "공정 실적표", code: r ? `PR-${r.n}` : "PR-—",
      fields: r ? [["회차", `${r.n}회차`], ["설정", r.label], ["기간", `1~${days}일`]] : [["회차", "—"], ["기간", `1~${days}일`]],
    }));
  }
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
      onclick: () => (view === "field" ? openField(null) : (state.view = view, drawAll())),
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
          if (!run.finished && state.view !== "control") state.view = "control";
          state.focus = null;
          drawAll();
        },
      }, h("b", null, `${run.n}회차`), ` ${run.label}`,
      run.finished ? h("span", { class: "chip-grade", style: { background: GRADE_COLOR[run.result.grade.grade] } }, run.result.grade.grade) : null))));

  els.control.hidden = state.view !== "control";
  els.field.hidden = state.view !== "field";
  els.report.hidden = state.view !== "report";
  els.playbar.hidden = state.view === "report" || !r;
  els.board.classList.toggle("board-down", state.view === "field");
}

function drawPlaybar(): void {
  const r = currentRun();
  if (!r) return;
  mount(els.playbar,
    h("div", { class: "playbar-row" },
      h("span", { class: "run-name" }, `${r.n}회차 · ${r.label}`),
      h("button", { class: "btn ghost", type: "button", title: "처음부터", onclick: () => { pause(); seek(0); } }, "⟲"),
      h("button", { class: "btn play", type: "button", onclick: () => (state.playing ? pause() : play()) }, "▶ 재생"),
      h("div", { class: "seg small" }, SPEEDS.map((sp) =>
        h("label", { class: "seg-item" },
          h("input", {
            type: "radio", name: "speed", checked: state.speed === sp,
            onchange: () => { state.speed = sp; restartTimer(); tick(true); },
          }),
          h("span", null, `${sp}×`)))),
      h("input", {
        class: "scrub", type: "range", min: 0, max: r.result.days, step: 1, value: String(state.day),
        oninput: (e: Event) => {
          // 값을 먼저 읽는다. pause()가 tick()으로 슬라이더를 지금 날짜로 되돌려 놓기 때문이다.
          const day = Number((e.target as HTMLInputElement).value);
          pause();
          seek(day);
        },
      }),
      h("span", { class: "day-now" }, ""),
      r.finished
        ? null
        : h("button", { class: "btn ghost", type: "button", title: "끝으로 건너뛰기 (End)", onclick: finish }, "끝으로 ⏭")),
    h("div", { class: "ticker" }));
}

function drawControl(): void {
  const r = currentRun();
  const { scenario } = state.data;
  if (!r) {
    mount(els.control,
      h("div", { class: "empty" },
        h("p", null, h("b", null, "아직 실행한 회차가 없습니다.")),
        h("p", null, "왼쪽에서 프리셋을 고르거나 직접 계획을 세운 뒤 실행하면, 4척이 60일 동안 블록 조립을 지나가는 모습이 여기에 나옵니다.")));
    return;
  }

  const shipTab = (id: string | null, label: string) =>
    h("button", {
      type: "button", class: `tab${state.ganttShip === id ? " active" : ""}`,
      onclick: () => { state.ganttShip = id; drawControl(); tick(true); },
    }, label);

  const sameColor = LOSS_STATES.filter((l) => l.state !== "rework");
  const legend = h("div", { class: "legend" },
    scenario.stations.map((st) => h("span", null, h("i", { style: { background: STATION_COLOR[st.id] } }), st.name)),
    h("span", null, h("i", { class: "hatch" }), "재작업(빗금)"),
    h("span", null, h("i", { class: "transport-mark" }), TRANSPORT_STATE.name),
    state.ganttShip ? h("span", null, h("i", { class: "other-mark" }), "다른 배가 쓰는 중") : null,
    h("span", { class: "sep" }),
    sameColor.map((l) => h("span", null, h("i", { class: `thin${l.hatch ? " hatch-over" : ""}`, style: { background: l.color } }), l.name)),
    h("span", { class: "sep" }),
    h("span", null, h("i", { class: "due-mark" }), "납기"),
    h("span", null, h("i", { class: "deliver-mark" }), "인도"),
    state.ganttShip ? h("span", null, h("i", { class: "arrival-mark" }), "자재 입고") : null);

  mount(els.control,
    h("div", { class: "panel-head" },
      h("h3", null, "배별 공정 실적"),
      h("div", { class: "tabs" }, shipTab(null, "전체"), r.result.ships.map((sh) => shipTab(sh.id, sh.id)))),
    h("div", { class: "gantt-chart" }),
    legend,
    state.ganttShip ? h("div", { class: "ship-detail" }) : null);
}

/** 현장으로 나간다. 회차마다 처음 한 번은 안전모를 쓰고 뛰어나가는 전환을 보여 준다(누르면 건너뜀). */
function openField(focus: State["focus"]): void {
  const r = currentRun();
  if (!r?.finished) return;
  state.view = "field";
  state.focus = focus;
  drawAll();
  yardCamera();
  if (!introSeen.has(r.n)) {
    introSeen.add(r.n);
    const overlay = h("div", { class: "field-intro", onclick: () => overlay.remove() },
      h("div", { class: "intro-run" }, h("span", { class: "intro-man" }, "⛑️🏃"), h("span", { class: "intro-door" }, "🚪")),
      h("p", null, h("b", null, "관리자가 안전모를 쓰고 현장으로 나갑니다")),
      h("p", { class: "hint" }, "누르면 건너뜁니다"));
    els.field.append(overlay);
    window.setTimeout(() => overlay.remove(), 1800);
  }
}

function yardCamera(): void {
  const apply = () => yard?.setCamera("field", state.focus?.station ?? null);
  if (yard) apply();
  else void yardLoading?.then(apply);
}

function drawField(): void {
  const r = currentRun();
  mount(els.field,
    h("div", { class: "panel-head" },
      h("h2", null, "현장 재현"),
      state.focus ? h("span", { class: "focus-note" }, state.focus.text) : h("span", { class: "hint" }, "같은 결과를 현장 눈높이로 다시 봅니다."),
      h("div", { class: "controls" },
        r ? h("select", {
          class: "select",
          onchange: (e: Event) => {
            const i = Number((e.target as HTMLSelectElement).value);
            state.focus = i < 0 ? null : { station: i, text: "" };
            yardCamera();
          },
        }, h("option", { value: -1 }, "전체 보기"),
        state.data.scenario.stations.map((st, i) => h("option", { value: i, selected: state.focus?.station === i }, `${st.name} 가까이`))) : null)),
    els.sceneField);
}

function openFinding(f: Finding, where: "field" | "gantt"): void {
  pause();
  const { scenario } = state.data;
  const station = scenario.stations.findIndex((st) => st.id === f.station);
  if (where === "field") {
    openField({ station, text: `${f.ship} · ${scenario.stations[station]?.name ?? ""} · ${f.start}~${f.end}일` });
  } else {
    state.view = "control";
    state.ganttShip = f.ship;
    drawAll();
  }
  seek(f.start);
}

function drawReport(): void {
  const r = currentRun();
  const { scenario } = state.data;
  if (!r) {
    mount(els.report,
      h("p", { class: "hint" }, "실행이 끝나면 등급, 의문점, QCD, 원가, 리드타임 분해, OEE가 여기에 나옵니다."));
    return;
  }
  const body = r.finished
    ? renderReport(r.result, scenario, state.data.max_rate, openFinding)
    : h("div", { class: "empty" },
      h("p", null, h("b", null, "60일 진행 중입니다.")),
      h("p", null, "끝까지 진행하면 레포트가 나옵니다."),
      h("button", { class: "btn ghost", type: "button", onclick: finish }, "끝으로 건너뛰기 ⏭"));
  mount(els.report, body);
}

// ---------------------------------------------------------------------------
// 시작
// ---------------------------------------------------------------------------

function onKey(e: KeyboardEvent): void {
  const target = e.target as HTMLElement;
  // 계획 간트처럼 화살표 키를 스스로 쓰는 요소에 포커스가 있으면 재생 단축키를 쓰지 않는다.
  if (target.closest("input, select, textarea, [data-own-keys]")) return;
  const r = currentRun();
  if (!r) return;
  if (e.key === " ") {
    e.preventDefault();
    if (state.playing) pause(); else play();
  } else if (e.key === "End") {
    e.preventDefault();
    if (r.finished) seek(r.result.days); else finish();
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
    ganttShip: null,
    day: 0,
    playing: false,
    speed: 2,
    focus: null,
  };

  els.board.append(els.sheetHead, els.playbar, els.control, els.field, els.report);
  mount(root,
    h("header", { class: "topbar" },
      h("div", { class: "brand" },
        h("span", { class: "logo", "aria-hidden": "true" }, "⛵"),
        h("div", null,
          h("h1", null, "종이배 조선소 관제실"),
          h("p", null, "생산관리 시뮬레이터 · 7요소 · QCD · 4M"))),
      els.best),
    h("div", { class: "layout" },
      h("div", { class: "clipboard board-left" }, els.form),
      h("main", { class: "main" }, els.tabs,
        els.board)));

  document.addEventListener("keydown", onKey);
  drawForm();
  drawAll();
  schedulePreview();
}

void start();
