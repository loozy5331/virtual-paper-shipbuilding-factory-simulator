// 화면의 상태와 연결. 서버에서 시나리오를 받고, 설정을 고치고, 실행 결과를 회차로 쌓는다.
// 화면은 셋이다(2.0):
//   desk  첫 화면. 책상 위 분기별 클립보드에서 분기를 고른다.
//   plan  생산계획서 클립보드가 가운데. 왼쪽 인덱스 탭 A안·B안·C안, 맨 아래 "승인하고 60일 실행".
//   room  관제실(생산관리자 1인칭). 정면 벽 모니터 두 대: 왼쪽 = 재생 막대 + 간트, 오른쪽 = 기호도(또는 CCTV) + 사건 기록.
//         책상 위에 생산계획서 클립보드(누르면 계획 고치기)와 작업모. 60일이 끝나면 생산실적 평가서 클립보드를 받는다.
// 현장을 보는 길: 기호도 작업장, 간트 막대, 평가서의 "현장에서 보기" → 오른쪽 모니터의 CCTV(재생 중에도 오늘을 본다).

import { api, ApiError, type Config, type Finding, type Preview, type Result, type ScenarioPayload } from "./api";
import { h, mount, num, pct } from "./dom";
import { renderDesk } from "./desk";
import { planLabel, renderForm, renderPlanBar, renderPlanTabs, updatePreview, type FormContext } from "./form";
import { renderGantt, renderShipGantt, type GanttPick } from "./gantt";
import { docHead } from "./paper";
import { EVENT_NAME, GRADE_COLOR, GRADE_EDGE, GRADE_TEXT, LOSS_STATES, STATION_COLOR, TRANSPORT_STATE } from "./labels";
import { breakdownBar, breakdownLegend, eventText, renderReport } from "./report";
import { renderSchematic } from "./schematic";
import { buildFrame } from "./scene/frame";
import type { Yard } from "./scene/yard";

const SPEEDS = [1, 2, 8];
const BASE_MS_PER_DAY = 500;   // 1배속은 하루에 0.5초, 60일이 30초다.
// 사건 기록에 남기는 사건. 투입, 완료, 출고, 운반은 너무 잦아서 뺀다.
const LOG_EVENTS = new Set(["arrival", "defect", "accident", "breakdown", "delivery", "research_done"]);
// 배 탭(크게 보기)의 그 배 사건: 투입, 완료, 입고, 불량, 사고, 운반, 인도
const SHIP_EVENTS = new Set(["arrival", "enter", "complete", "defect", "accident", "transport_start", "delivery"]);

interface Run {
  n: number;
  /** 회차를 돌린 시나리오. 화면은 지금 시나리오의 회차만 보여 준다. */
  scenario: string;
  label: string;
  config: Config;
  result: Result;
  finished: boolean;           // 60일 끝까지 본 적이 있다 → 평가서가 나온다.
}

type Screen = "desk" | "plan" | "room";
/** 평가서 클립보드: 없음, 앞으로 올라옴, 아래로 내려 둠(모니터를 보려고). */
type BoardState = "none" | "up" | "down";

interface State {
  screen: Screen;
  data: ScenarioPayload;
  config: Config;
  presetId: string | null;
  edited: boolean;
  preview: Preview | null;
  errors: string[];
  busy: boolean;
  runs: Run[];
  current: number | null;        // 보고 있는 회차의 인덱스
  /** 간트에서 보는 배. null이면 전체. */
  ganttShip: string | null;
  day: number;
  playing: boolean;
  speed: number;
  board: BoardState;
  /** 오른쪽 모니터 위쪽이 CCTV면 비추는 공정 번호. null이면 기호도. */
  cctv: number | null;
  /** 크게 보고 있는 모니터 */
  zoomed: "left" | "right" | null;
}

let state: State;
let timer: number | undefined;
let previewSeq = 0;
let previewTimer: number | undefined;

const els = {
  topbar: h("header", { class: "topbar" }),
  desk: h("section", { class: "desk", "aria-label": "분기 고르기" }),
  plan: h("section", { class: "plan-screen", "aria-label": "생산계획서" }),
  room: h("section", { class: "room", "aria-label": "관제실" }),
  form: h("aside", { class: "form" }),
  planBar: h("div", { class: "plan-bar" }),
  planTabs: h("nav", { class: "plan-tabs", "aria-label": "계획안" }),
  best: h("div", { class: "best" }),
  // 관제실
  plate: h("div", { class: "plate" }),
  plateRight: h("div", { class: "plate right" }),
  monitorLeft: h("div", { class: "monitor left" }),
  monitorRight: h("div", { class: "monitor right" }),
  osd: h("div", { class: "osd" }),
  ganttScreen: h("div", { class: "gantt-screen" }),
  rightTop: h("div", { class: "right-top" }),
  cctvHost: h("div", { class: "scene-host cctv-host" }),
  log: h("ol", { class: "log", "aria-label": "사건 기록" }),
  deskClip: h("button", { class: "desk-clip", type: "button", title: "생산계획서로 돌아가 계획을 고칩니다" }),
  hat: h("button", { class: "desk-hat", type: "button", title: "작업모를 쓰고 현장으로 나갑니다" }),
  hands: h("div", { class: "hands", "aria-hidden": "true" }),
  reportBoard: h("div", { class: "report-board clipboard" }),
};

// 3D(Three.js)는 처음 볼 때 불러온다. 간트만 쓰면 받지 않는다.
let yard: Yard | null = null;
let yardLoading: Promise<void> | null = null;
let yardRun: Run | null = null;

// ---------------------------------------------------------------------------
// 설정
// ---------------------------------------------------------------------------

function drawForm(): void {
  const ctx: FormContext = {
    scenario: state.data.scenario,
    scenarios: state.data.scenarios,
    presets: state.data.presets,
    config: state.config,
    presetId: state.presetId,
    get edited() { return state.edited; },   // 탭이 누를 때의 값을 읽도록 그때그때
    busy: state.busy,
    onEdit: (redraw) => {
      state.edited = true;
      if (redraw) drawForm();
      // 입력 중에 양식을 다시 그리면 커서가 빠지므로 "(수정함)" 표시만 드러낸다.
      else {
        els.planBar.querySelector(".edited")?.removeAttribute("hidden");
        els.planTabs.querySelector(".tab-edited")?.removeAttribute("hidden");
      }
      schedulePreview();
    },
    onPreset: loadPreset,
    onDesk: showDesk,
    onRun: run,
  };
  renderForm(els.form, ctx);
  renderPlanBar(els.planBar, ctx);
  renderPlanTabs(els.planTabs, ctx);
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
  const label = planLabel(state.data.presets, preset.id);
  return state.edited ? `${label} 수정` : label;
}

// ---------------------------------------------------------------------------
// 화면 전환
// ---------------------------------------------------------------------------

const reduceMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function setScreen(screen: Screen): void {
  state.screen = screen;
  els.desk.hidden = screen !== "desk";
  els.plan.hidden = screen !== "plan";
  els.room.hidden = screen !== "room";
  // 관제실은 벽이 화면 전체다. 상단 바는 책상과 생산계획서에서만.
  els.topbar.hidden = screen === "room";
  if (screen !== "room") {
    yard?.stop();
    unzoom();
  }
}

/** 날아갈 복제를 지금 자리에 띄운다. 원래 화면을 숨기기 전에 불러야 자리와 모양이 맞는다. */
function makeGhost(source: HTMLElement): { ghost: HTMLElement; from: DOMRect } {
  const from = source.getBoundingClientRect();
  const ghost = source.cloneNode(true) as HTMLElement;
  // 복제한 라디오가 원본과 같은 name을 쓰면 문서에 붙이는 순간 원본의 선택을 빼앗는다. 이름과 id를 뗀다.
  ghost.querySelectorAll("[name], [id]").forEach((el) => { el.removeAttribute("name"); el.removeAttribute("id"); });
  ghost.setAttribute("aria-hidden", "true");
  ghost.classList.add("fly-ghost");
  Object.assign(ghost.style, { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px` });
  document.body.append(ghost);
  return { ghost, from };
}

/** source 요소의 복제를 to 자리로 옮기며 크기를 맞춘다. 끝나면 지운다. */
async function flyGhost(source: HTMLElement | { ghost: HTMLElement; from: DOMRect }, to: DOMRect): Promise<void> {
  const { ghost, from } = source instanceof HTMLElement ? makeGhost(source) : source;
  await ghost.animate([
    { transform: "translate(0, 0) scale(1, 1)" },
    { transform: `translate(${to.left - from.left}px, ${to.top - from.top}px) scale(${to.width / from.width}, ${to.height / from.height})` },
  ], { duration: 520, easing: "cubic-bezier(.2,.7,.2,1)", fill: "forwards" }).finished;
  await ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 200, fill: "forwards" }).finished;
  ghost.remove();
}

/** 화면을 보이지 않게 그려 두고 target 자리를 잰다(애니메이션의 목적지). */
function measureHidden(screen: HTMLElement, target: () => Element | null): DOMRect | null {
  screen.style.visibility = "hidden";
  screen.hidden = false;
  return target()?.getBoundingClientRect() ?? null;
}

function reveal(screen: HTMLElement): void {
  screen.style.visibility = "";
  screen.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: "ease-out" });
}

/** 클립보드를 생산계획서 자리로 옮기며 생산계획서 화면을 연다. */
async function openPlan(source: HTMLElement): Promise<void> {
  window.scrollTo(0, 0);
  const flying = reduceMotion() ? null : makeGhost(source);
  // 지금 화면을 먼저 치워야 생산계획서가 화면 맨 위 제자리에서 재진다.
  els.desk.hidden = true;
  els.room.hidden = true;
  els.topbar.hidden = false;
  const to = flying ? measureHidden(els.plan, () => els.plan.querySelector(".board-left")) : null;
  setScreen("plan");
  if (flying && to) {
    await flyGhost(flying, new DOMRect(to.left, to.top, to.width, Math.min(to.height, window.innerHeight - to.top)));
    reveal(els.plan);
  } else {
    flying?.ghost.remove();
    els.plan.style.visibility = "";
  }
}

// ---------------------------------------------------------------------------
// 첫 화면: 책상 위 클립보드
// ---------------------------------------------------------------------------

function sessionBest(scenarioId: string): Run | undefined {
  const done = state.runs.filter((r) => r.finished && r.scenario === scenarioId);
  if (!done.length) return undefined;
  return done.reduce((a, b) => (b.result.grade.score > a.result.grade.score ? b : a));
}

function drawDesk(): void {
  const scenarios = state.data.scenarios;
  renderDesk(els.desk, {
    scenarios,
    best: Object.fromEntries(scenarios.map((sc) => {
      const b = sessionBest(sc.id);
      return [sc.id, b ? { grade: b.result.grade.grade, score: b.result.grade.score } : undefined];
    })),
    onPick: (id, board) => void enterScenario(id, board),
  });
}

function showDesk(): void {
  pause();
  drawDesk();
  setScreen("desk");
  drawTopbar();
  window.scrollTo(0, 0);
}

/** 클립보드를 집어 든다: 누른 클립보드가 가운데 생산계획서 자리로 옮겨 가며 커진다. */
async function enterScenario(id: string, board: HTMLElement): Promise<void> {
  els.desk.querySelectorAll<HTMLElement>(".desk-board").forEach((b) => b.classList.toggle("picked", b === board));
  els.desk.classList.add("leaving");
  await switchScenario(id);
  await openPlan(board);
  drawTopbar();
  els.desk.classList.remove("leaving");
}

/** 시나리오를 바꾼다. 관리 프리셋으로 시작하고, 그 시나리오에서 돌린 회차가 있으면 마지막 회차를 연다. */
async function switchScenario(id: string): Promise<void> {
  pause();
  // 같은 분기의 클립보드를 다시 집으면 쓰던 계획을 그대로 둔다.
  if (id === state.data.scenario.id && els.form.childElementCount) return;
  let data: ScenarioPayload;
  try {
    data = await api.scenario(id);
  } catch (error) {
    notify(error instanceof ApiError ? error.messages.join(" ") : String(error));
    return;
  }
  const first = data.presets.find((p) => p.id === "managed") ?? data.presets[0];
  const last = state.runs.map((r, i) => (r.scenario === id ? i : -1)).filter((i) => i >= 0).pop();
  Object.assign(state, {
    data, config: structuredClone(first.config), presetId: first.id, edited: false, preview: null, errors: [],
    current: last ?? null, ganttShip: null, cctv: null, board: "none",
    day: last !== undefined && state.runs[last].finished ? data.scenario.days : 0,
  });
  drawForm();
  schedulePreview();
}

/** 관제실 책상의 생산계획서(또는 평가서의 "계획 고치기"): 계획을 고치러 간다. */
async function backToPlan(): Promise<void> {
  pause();
  const source = state.board === "up" ? els.reportBoard : els.deskClip;
  await openPlan(source);
  drawTopbar();
}

// ---------------------------------------------------------------------------
// 실행: 승인하면 클립보드를 책상에 내려놓고 관제실로
// ---------------------------------------------------------------------------

async function run(): Promise<void> {
  state.busy = true;
  updatePreview(els.form, state.preview, state.errors, state.busy);
  let result: Result;
  const config = structuredClone(state.config);
  try {
    result = await api.simulate(config);
  } catch (error) {
    state.errors = error instanceof ApiError ? error.messages : [String(error)];
    return;
  } finally {
    state.busy = false;
    updatePreview(els.form, state.preview, state.errors, state.busy);
  }
  state.runs.push({ n: state.runs.length + 1, scenario: state.data.scenario.id, label: runLabel(), config, result, finished: false });
  state.current = state.runs.length - 1;
  Object.assign(state, { day: 0, ganttShip: null, cctv: null, board: "none", playing: false });

  const source = els.plan.querySelector<HTMLElement>(".board-left");
  // 생산계획서 클립보드를 띄워 두고(복제), 관제실을 보이지 않게 그려 책상 위 자리를 잰다.
  const flying = reduceMotion() || !source ? null : makeGhost(source);
  state.screen = "room";        // drawRoom()과 tick()이 그리도록 먼저 바꾼다.
  els.plan.hidden = true;       // 생산계획서와 상단 바를 치워야 관제실이 화면 맨 위 제자리에서 재진다.
  els.topbar.hidden = true;
  drawRoom();
  const to = flying ? measureHidden(els.room, () => els.deskClip) : null;
  setScreen("room");
  if (flying && to) {
    await flyGhost(flying, to);
    reveal(els.room);
  } else {
    flying?.ghost.remove();
    els.room.style.visibility = "";
  }
  play();
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
    // 이미 평가서를 받은 회차는 60일에 닿아도 다시 받지 않는다.
    if (state.day >= r.result.days && !r.finished) finish();
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

/** 60일에 닿았다: 재생을 멈추고 생산실적 평가서 클립보드를 받는다. */
function finish(): void {
  const r = currentRun();
  if (!r) return;
  state.day = r.result.days;
  state.playing = false;
  window.clearInterval(timer);
  r.finished = true;
  state.board = "up";
  drawRoom();
}

/** 날짜가 바뀔 때마다 모니터(간트, 기호도·CCTV, 사건 기록)와 재생 막대를 갱신한다. jump면 3D 소인이 걷지 않고 바로 옮긴다. */
function tick(jump: boolean): void {
  const r = currentRun();
  if (!state || !r || state.screen !== "room") {
    yard?.stop();
    return;
  }
  const { result } = r;
  const { scenario } = state.data;

  // 왼쪽 모니터: 간트
  const chart = els.ganttScreen.querySelector(".gantt-chart");
  const ship = result.ships.find((sh) => sh.id === state.ganttShip);
  if (chart) mount(chart, ship ? renderShipGantt(result, scenario, ship.id, state.day, pickBar) : renderGantt(result, scenario, state.day, pickBar));
  const detail = els.ganttScreen.querySelector(".ship-detail");
  if (detail) {
    // 그 배의 사건(오늘까지)과, 60일이 끝났으면 리드타임 분해. 크게 볼 때만 보인다.
    const mine = ship ? result.events.filter((ev) => ev.day <= state.day && "ship" in ev && ev.ship === ship.id && SHIP_EVENTS.has(ev.type)) : [];
    const ended = state.day >= result.days;
    mount(detail, ship ? [
      ended ? h("div", { class: "lead-row" }, h("span", { class: "lead-name" }, h("b", null, ship.id)),
        breakdownBar(ship, Math.max(1, ship.lead_time)), h("span", { class: "lead-total" }, `${ship.lead_time}일`)) : null,
      ended ? breakdownLegend() : null,
      h("ol", { class: "events ship-events" }, mine.length
        ? mine.map((ev) => h("li", null, h("span", { class: "ev-day" }, `${ev.day}일`), h("span", { class: `ev-type ${ev.type}` }, EVENT_NAME[ev.type]), h("span", null, eventText(ev, scenario))))
        : h("li", { class: "quiet" }, "아직 이 배의 사건이 없습니다.")),
    ] : null);
  }

  // 재생 막대(왼쪽 모니터 위)
  const slider = els.osd.querySelector<HTMLInputElement>("input.scrub");
  if (slider) slider.value = String(state.day);
  const dayLabel = els.osd.querySelector(".day-now");
  if (dayLabel) dayLabel.textContent = `${state.day} / ${result.days}일`;
  const playBtn = els.osd.querySelector(".play");
  if (playBtn) playBtn.textContent = state.playing ? "❚❚ 멈춤" : "▶ 재생";

  // 오른쪽 모니터 위: 기호도 또는 CCTV
  if (state.cctv === null) {
    const host = els.rightTop.querySelector(".schematic-host");
    if (host) {
      mount(host, renderSchematic(buildFrame(result, scenario, r.config, state.day, 1), scenario, {
        onStation: (p) => openCctv(p),
      }));
    }
  } else {
    const cam = els.rightTop.querySelector(".cam-label");
    if (cam) cam.textContent = camLabel(state.cctv);
  }

  // 오른쪽 모니터 아래: 사건 기록(오늘까지, 최근이 위). 스크롤해서 보던 자리는 지킨다.
  const keep = els.log.scrollTop;
  const events = result.events.filter((ev) => ev.day <= state.day && LOG_EVENTS.has(ev.type)).reverse();
  mount(els.log, events.length
    ? events.map((ev) => h("li", { class: ev.day === state.day ? "today" : "" },
      h("b", null, `${ev.day}일`), h("em", { class: ev.type }, EVENT_NAME[ev.type]), h("span", null, eventText(ev, scenario))))
    : h("li", { class: "quiet" }, state.day ? "아직 기록할 사건이 없습니다." : "재생하면 1일부터 사건이 여기에 쌓입니다."));
  els.log.scrollTop = keep;

  syncScene(jump);
}

// ---------------------------------------------------------------------------
// CCTV (오른쪽 모니터 위쪽의 3D)
// ---------------------------------------------------------------------------

function camLabel(station: number): string {
  return `CAM ${station + 1} · ${state.data.scenario.stations[station].name} · ${state.day}일`;
}

/** 오른쪽 모니터를 그 공정의 CCTV로 바꾼다. 재생 중에도 오늘을 본다(결과를 미리 알려 주지 않는다). */
function openCctv(station: number, day?: number): void {
  if (!currentRun()) return;
  state.cctv = station;
  drawRightTop();
  if (day !== undefined) seek(day);
  else tick(true);
  const apply = () => yard?.setCamera("field", station);
  if (yard) apply();
  else void yardLoading?.then(apply);
}

function closeCctv(): void {
  state.cctv = null;
  yard?.stop();
  drawRightTop();
  tick(true);
}

/** 지금 CCTV를 보고 있으면 장면을 오늘 날짜로 맞추고, 아니면 그리기를 멈춘다. */
function syncScene(jump: boolean): void {
  const r = currentRun();
  if (state.cctv === null || state.screen !== "room" || !r) {
    yard?.stop();
    return;
  }
  if (!yard) {
    yardLoading ??= import("./scene/yard").then((y) => {
      yard = new y.Yard();
    });
    void yardLoading.then(() => {
      yard!.setCamera("field", state.cctv);
      syncScene(true);
    });
    return;
  }
  yard.attach(els.cctvHost);
  if (yardRun !== r) {
    yard.load(r.result.ships.map((s) => s.id));
    yardRun = r;
    jump = true;
  }
  const { scenario } = state.data;
  const day = state.day;
  yard.setSource({
    frameAt: (frac) => buildFrame(r.result, scenario, r.config, day, frac),
    playing: state.playing,
    msPerDay: BASE_MS_PER_DAY / state.speed,
    // 1배속 이하에서만 걷는 모습을 보여 준다. 빠르면 바로 옮긴다.
    snap: jump || state.speed > 1,
  });
  yard.start();
}

function pickBar(pick: GanttPick): void {
  const station = state.data.scenario.stations.findIndex((st) => st.id === pick.station);
  pause();
  openCctv(station, pick.start);
}

/** 평가서의 의문점 카드: 간트는 왼쪽 모니터를 그 배·날짜로, 현장은 오른쪽 모니터를 그 공정의 CCTV로. 보드는 내려 둔다. */
function openFinding(f: Finding, where: "field" | "gantt"): void {
  pause();
  state.board = "down";
  drawReportBoard();
  if (where === "gantt") {
    state.ganttShip = f.ship;
    drawGanttScreen();
    seek(f.start);
    return;
  }
  const station = state.data.scenario.stations.findIndex((st) => st.id === f.station);
  openCctv(station, f.start);
}

// ---------------------------------------------------------------------------
// 관제실 그리기
// ---------------------------------------------------------------------------

function drawRoom(): void {
  drawPlates();
  drawOsd();
  drawGanttScreen();
  drawRightTop();
  drawDeskItems();
  drawReportBoard();
  tick(true);
}

const gradeChip = (grade: string, cls: string) =>
  h("b", { class: `${cls} grade-${grade}`, style: { background: GRADE_COLOR[grade], color: GRADE_TEXT[grade] } }, grade);

/** 벽의 명판: 왼쪽은 관제실·분기·회차, 오른쪽은 목표와 이번 세션 최고, 회차 목록. */
function drawPlates(): void {
  const r = currentRun();
  const sc = state.data.scenario;
  mount(els.plate,
    h("b", null, "종이배 조선소 관제실"),
    h("span", null, `${sc.period} · ${sc.name}${r ? ` · ${r.n}회차 ${r.label}` : ""}`));
  const k = sc.kpi;
  const best = sessionBest(sc.id);
  const runs = state.runs.map((run, i) => ({ run, i })).filter(({ run }) => run.scenario === sc.id);
  mount(els.plateRight,
    h("span", null, `목표 매출 ${num(k.revenue)} · 이익 ${num(k.profit)} · 납기 ${pct(k.on_time_rate, 0)} · 직행률 ${pct(k.first_pass_yield, 0)}`),
    best ? h("span", { class: "plate-best" }, "최고 ", gradeChip(best.result.grade.grade, "best-grade"), ` ${best.result.grade.score.toFixed(1)}점`) : null,
    runs.length > 1 ? h("span", { class: "plate-runs" }, "회차", runs.map(({ run, i }) =>
      h("button", {
        type: "button", class: `run-chip${i === state.current ? " active" : ""}`, title: `${run.n}회차 ${run.label}`,
        onclick: () => {
          pause();
          state.current = i;
          Object.assign(state, { day: run.finished ? run.result.days : 0, ganttShip: null, cctv: null, board: run.finished ? "down" : "none" });
          drawRoom();
        },
      }, `${run.n}`, run.finished ? gradeChip(run.result.grade.grade, "chip-grade") : null))) : null);
}

/** 왼쪽 모니터 맨 위의 재생 막대(화면 속 조작부). */
function drawOsd(): void {
  const r = currentRun();
  if (!r) return mount(els.osd);
  mount(els.osd,
    h("button", { class: "osd-btn", type: "button", title: "처음부터", onclick: () => { pause(); seek(0); } }, "⟲"),
    h("button", { class: "osd-btn play", type: "button", onclick: () => (state.playing ? pause() : play()) }, "▶ 재생"),
    h("div", { class: "osd-speed", role: "radiogroup", "aria-label": "배속" }, SPEEDS.map((sp) =>
      h("label", null,
        h("input", { type: "radio", name: "speed", checked: state.speed === sp, onchange: () => { state.speed = sp; restartTimer(); tick(true); } }),
        h("span", null, `${sp}×`)))),
    h("input", {
      class: "scrub", type: "range", min: 0, max: r.result.days, step: 1, value: String(state.day), "aria-label": "날짜",
      oninput: (e: Event) => {
        // 값을 먼저 읽는다. pause()가 tick()으로 슬라이더를 지금 날짜로 되돌려 놓기 때문이다.
        const day = Number((e.target as HTMLInputElement).value);
        pause();
        seek(day);
      },
    }),
    h("b", { class: "day-now" }, ""),
    r.finished ? null : h("button", { class: "osd-btn", type: "button", title: "끝으로 (End)", onclick: finish }, "⏭"));
}

/** 왼쪽 모니터: 배 탭과 간트. 범례와 배 상세는 크게 볼 때만 보인다. */
function drawGanttScreen(): void {
  const r = currentRun();
  if (!r) return mount(els.ganttScreen);
  const { scenario } = state.data;
  const shipTab = (id: string | null, label: string) =>
    h("button", {
      type: "button", class: `screen-tab${state.ganttShip === id ? " active" : ""}`,
      onclick: () => { state.ganttShip = id; drawGanttScreen(); tick(true); },
    }, label);
  const sameColor = LOSS_STATES.filter((l) => l.state !== "rework");
  mount(els.ganttScreen,
    h("div", { class: "screen-tabs" }, shipTab(null, "전체"), r.result.ships.map((sh) => shipTab(sh.id, sh.id))),
    h("div", { class: "gantt-chart" }),
    h("div", { class: "legend zoom-only" },
      scenario.stations.map((st) => h("span", null, h("i", { style: { background: STATION_COLOR[st.id] } }), st.name)),
      h("span", null, h("i", { class: "hatch" }), "재작업(빗금)"),
      h("span", null, h("i", { class: "transport-mark" }), TRANSPORT_STATE.name),
      h("span", { class: "sep" }),
      sameColor.map((l) => h("span", null, h("i", { class: `thin${l.hatch ? " hatch-over" : ""}`, style: { background: l.color } }), l.name)),
      h("span", { class: "sep" }),
      h("span", null, h("i", { class: "due-mark" }), "납기"),
      h("span", null, h("i", { class: "deliver-mark" }), "인도")),
    h("div", { class: "ship-detail zoom-only" }));
}

/** 오른쪽 모니터 위쪽: 기호도(작업장을 누르면 CCTV) 또는 CCTV. */
function drawRightTop(): void {
  const label = els.monitorRight.querySelector(".monitor-label");
  if (state.cctv === null) {
    mount(els.rightTop, h("div", { class: "schematic-host" }));
    if (label) label.textContent = "기호도 · 작업장을 누르면 CCTV";
    return;
  }
  mount(els.rightTop,
    els.cctvHost,
    h("span", { class: "cam-label" }, camLabel(state.cctv)),
    h("button", { class: "cam-back", type: "button", onclick: closeCctv }, "← 기호도"),
    h("div", { class: "cam-switch", role: "group", "aria-label": "다른 CCTV" }, state.data.scenario.stations.map((st, i) =>
      h("button", { type: "button", class: i === state.cctv ? "active" : "", onclick: () => openCctv(i) }, `${i + 1} ${st.name}`))));
  if (label) label.textContent = `CCTV · ${state.data.scenario.stations[state.cctv].name}`;
}

/** 책상 위: 생산계획서 클립보드(누르면 계획 고치기). 평가서를 보고 있으면 손은 보이지 않는다(CSS). */
function drawDeskItems(): void {
  const r = currentRun();
  mount(els.deskClip,
    h("span", { class: "clip-sheet" }, h("b", null, "생산계획서"), h("small", null, r?.label ?? ""), h("i"), h("i"), h("i")),
    h("span", { class: "desk-label" }, "누르면 계획 고치기"));
}

/** 생산실적 평가서 클립보드: 60일이 끝나면 받는다. 내려 두면 아래 띠만 보이고, 누르면 다시 올라온다. */
function drawReportBoard(): void {
  const r = currentRun();
  const shown = state.board !== "none" && !!r?.finished;
  els.room.classList.toggle("board-up", shown && state.board === "up");
  els.room.classList.toggle("board-down", shown && state.board === "down");
  els.reportBoard.hidden = !shown;
  if (!shown || !r) return;
  const g = r.result.grade;
  mount(els.reportBoard,
    h("div", { class: "report-sheet" },
      h("div", { class: "report-actions" },
        state.board === "up"
          ? h("button", { class: "btn ghost small", type: "button", onclick: () => { state.board = "down"; drawReportBoard(); } }, "내려 두기 ▾")
          : h("span", { class: "hint" }, "생산실적 평가서 · 누르면 다시 올림"),
        h("button", { class: "btn primary small", type: "button", onclick: () => void backToPlan() }, "계획 고치기")),
      docHead({
        title: "생산실적 평가서", code: `PE-${r.n}`,
        fields: [["회차", `${r.n}회차`], ["설정", r.label], ["판정", `${g.grade} (${g.score.toFixed(1)}점)`]],
        stamp: {
          text: g.grade, sub: `${g.score.toFixed(1)}점`, strong: g.grade === "S" || g.grade === "F",
          // 밝은 금(S)은 종이 위에서 윤곽이 약해 진한 금 테두리 + 금 바탕 + 먹색 글자로 찍는다.
          color: GRADE_EDGE[g.grade] ?? GRADE_COLOR[g.grade] ?? "#4b5a51",
          fill: GRADE_EDGE[g.grade] ? GRADE_COLOR[g.grade] : undefined,
          ink: GRADE_TEXT[g.grade],
        },
      }),
      renderReport(r.result, state.data.scenario, state.data.max_rate, openFinding)));
}

// ---------------------------------------------------------------------------
// 모니터 크게 보기
// ---------------------------------------------------------------------------

function zoom(which: "left" | "right"): void {
  state.zoomed = which;
  els.monitorLeft.classList.toggle("zoomed", which === "left");
  els.monitorRight.classList.toggle("zoomed", which === "right");
  els.room.classList.add("zooming");
  tick(true);
}

function unzoom(): void {
  if (!state?.zoomed) return;
  state.zoomed = null;
  els.monitorLeft.classList.remove("zoomed");
  els.monitorRight.classList.remove("zoomed");
  els.room.classList.remove("zooming");
}

function monitor(el: HTMLElement, which: "left" | "right", label: string, ...screen: Node[]): void {
  mount(el,
    h("div", { class: "bezel" },
      h("div", { class: "screen" }, ...screen),
      h("button", { class: "zoom-btn", type: "button", title: "크게 보기 (Esc로 닫기)", onclick: () => (state.zoomed === which ? unzoom() : zoom(which)) },
        h("span", { class: "zoom-in" }, "크게"), h("span", { class: "zoom-out" }, "✕ 닫기"))),
    h("div", { class: "monitor-label" }, label));
}

// ---------------------------------------------------------------------------
// 공통
// ---------------------------------------------------------------------------

/** 잠깐 떴다 사라지는 안내. */
function notify(text: string): void {
  document.querySelector(".toast")?.remove();
  const toast = h("div", { class: "toast", role: "status" }, text);
  document.body.append(toast);
  window.setTimeout(() => toast.remove(), 2400);
}

/** 상단 바(책상, 생산계획서): 생산계획서에서는 지금 분기의 이번 세션 최고, 없으면 목표. */
function drawTopbar(): void {
  const sc = state.data.scenario;
  const best = sessionBest(sc.id);
  const k = sc.kpi;
  if (state.screen === "desk") return mount(els.best);
  mount(els.best, best
    ? [h("span", null, "이번 세션 최고"), gradeChip(best.result.grade.grade, "best-grade"),
      h("span", null, `${best.result.grade.score.toFixed(1)}점 · ${best.n}회차 ${best.label}`)]
    : h("span", { class: "best-empty" },
      `${sc.name} 목표: 매출 ${num(k.revenue)} · 이익 ${num(k.profit)} · 납기 ${pct(k.on_time_rate, 0)} · 직행률 ${pct(k.first_pass_yield, 0)}`));
}

function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape" && state.zoomed) {
    unzoom();
    return;
  }
  const target = e.target as HTMLElement;
  // 계획 간트처럼 화살표 키를 스스로 쓰는 요소에 포커스가 있으면 재생 단축키를 쓰지 않는다.
  if (target.closest("input, select, textarea, [data-own-keys]")) return;
  const r = currentRun();
  if (!r || state.screen !== "room") return;
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

// 생산관리자의 두 손(1인칭): 소매와 손등만. 평가서를 보고 있으면 숨긴다(CSS).
const HANDS_SVG = `<svg viewBox="0 0 720 130"><path d="M0 130 L 70 70 Q 90 56 110 66 L 150 92 L 92 130 Z" fill="#33413a"/><ellipse cx="138" cy="74" rx="34" ry="20" transform="rotate(-18 138 74)" fill="#e2c4a6"/><path d="M720 130 L 650 70 Q 630 56 610 66 L 570 92 L 628 130 Z" fill="#33413a"/><ellipse cx="582" cy="74" rx="34" ry="20" transform="rotate(18 582 74)" fill="#e2c4a6"/></svg>`;
// 작업모: 관리자 색 #d9480f
const HAT_SVG = `<svg viewBox="0 0 120 70" aria-hidden="true"><ellipse cx="60" cy="58" rx="50" ry="8" fill="#b23a0b"/><path d="M22 56 C 22 24, 98 24, 98 56 Z" fill="#d9480f"/><rect x="56" y="22" width="8" height="34" rx="3" fill="#e8662f"/></svg>`;

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
    screen: "desk",
    data,
    config: structuredClone(first.config),
    presetId: first.id,
    edited: false,
    preview: null,
    errors: [],
    busy: false,
    runs: [],
    current: null,
    ganttShip: null,
    day: 0,
    playing: false,
    speed: 2,
    board: "none",
    cctv: null,
    zoomed: null,
  };

  mount(els.topbar,
    h("div", { class: "brand" },
      h("span", { class: "logo", "aria-hidden": "true" }, "⛵"),
      h("div", null,
        h("h1", null, "종이배 조선소 관제실"),
        h("p", null, "생산관리 시뮬레이터 · 7요소 · QCD · 4M"))),
    els.best);

  mount(els.plan,
    els.planBar,
    h("div", { class: "board-row" }, els.planTabs, h("div", { class: "clipboard board-left" }, els.form)));

  monitor(els.monitorLeft, "left", "공정 간트", els.osd, els.ganttScreen);
  monitor(els.monitorRight, "right", "기호도", els.rightTop, els.log);
  els.hands.innerHTML = HANDS_SVG;
  els.hat.innerHTML = `${HAT_SVG}<span class="desk-label">작업모 · 현장으로</span>`;
  els.hat.addEventListener("click", () => notify("현장으로 직접 나가는 길은 다음 단계에서 붙입니다. 지금은 기호도의 CCTV로 보세요."));
  els.deskClip.addEventListener("click", () => void backToPlan());
  els.reportBoard.addEventListener("click", (e) => {
    // 내려 둔 평가서는 아무 데나 누르면 다시 올라온다.
    if (state.board === "down" && !(e.target as HTMLElement).closest("button")) {
      state.board = "up";
      drawReportBoard();
    }
  });
  mount(els.room,
    els.plate, els.plateRight,
    h("div", { class: "monitors" }, els.monitorLeft, els.monitorRight),
    h("div", { class: "room-desk" }, h("div", { class: "desk-top" }), els.deskClip, els.hands, els.hat),
    els.reportBoard);

  mount(root, els.topbar, els.desk, els.plan, els.room);

  document.addEventListener("keydown", onKey);
  drawForm();
  schedulePreview();
  showDesk();
}

void start();
