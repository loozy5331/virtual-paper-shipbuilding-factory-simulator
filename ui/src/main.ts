// 화면의 상태와 연결. 서버에서 시나리오를 받고, 설정을 고치고, 실행 결과를 회차로 쌓는다.
// 화면은 셋이다(2.0):
//   desk  첫 화면. 책상 위 분기별 클립보드에서 분기를 고른다.
//   plan  생산계획서 클립보드가 가운데. 왼쪽 인덱스 탭 A안·B안·C안, 맨 아래 펜으로 결재란 "승인" 칸에 서명하고 실행.
//   room  관제실(생산관리자 1인칭). 정면 벽 모니터 두 대: 왼쪽 = 재생 막대 + 간트, 오른쪽 = 작업 현황 전경(2D, 공정 확대) + 사건 기록.
//         책상 위에 생산계획서 클립보드(누르면 계획 고치기)와 작업모. 60일이 끝나면 생산실적 평가서 클립보드를 받는다.
//   field 현장. 작업모를 쓰고 직접 나간 생산관리자의 눈(3D 화면 전체). 전경·공정 가까이, 재생 막대, "관제실로".
// 공정을 들여다보는 길: 전경의 정반, 간트 막대, 평가서의 "작업 현황에서 보기" → 오른쪽 모니터의 공정 확대(재생 중에도 오늘을 본다).
// 사람의 얼굴과 이름은 작업모를 쓰고 현장(3D)에 직접 나가야 보인다(D24). 화면에는 "CCTV"라는 말을 쓰지 않는다(감시처럼 느껴져서).

import { api, ApiError, type ClassBest, type Config, type Finding, type Preview, type Result, type ScenarioPayload } from "./api";
import { h, mount, num, pct } from "./dom";
import { renderDesk } from "./desk";
import { planLabel, renderForm, renderPlanBar, renderPlanNotes, renderPlanTabs, updatePreview, type FormContext } from "./form";
import { renderGantt, renderShipGantt, type GanttPick } from "./gantt";
import { docHead, REVIEWER } from "./paper";
import { EVENT_NAME, GRADE_COLOR, GRADE_EDGE, GRADE_TEXT, LOSS_STATES, PAIR_WAIT_STATE, STATION_COLOR, TRANSPORT_STATE } from "./labels";
import { breakdownBar, breakdownLegend, eventText, renderReport } from "./report";
import { renderCctv } from "./cctv";
import { renderTrackCard, type TrackPick } from "./track";
import { buildFrame, type Frame } from "./scene/frame";
import type { Yard } from "./scene/yard";
import { sector, sectorOf, SECTORS, ST, type SectorId } from "./scene/layout";

const SPEEDS = [1, 4];   // 관제실 배속. 기본 4배속(사용자 결정). 현장은 따로 1배속 고정(FIELD_MS_PER_DAY).
const BASE_MS_PER_DAY = 500;   // 1배속은 하루에 0.5초, 60일이 30초다.
// 현장(3D)은 1배속 고정이고 하루가 더 길다(2초): 소인이 걸어서 작업장에 닿고 일하는 모습이 보이게(2.1.4, D28).
// 나가면 시간이 멈춰 있고, 재생을 누르면 이 속도로 흐른다.
const FIELD_MS_PER_DAY = 2000;   // 3초는 처음 자재를 기다리는 날들이 지루했다(2.1.5)

/** 지금 화면의 하루 길이(ms). */
function msPerDay(): number {
  return state.screen === "field" ? FIELD_MS_PER_DAY : BASE_MS_PER_DAY / state.speed;
}
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
  /** 생산계획서에 서명한 사람(닉네임, 반 코드). 60일을 끝내면 이 이름으로 서버에 저장한다. */
  signer: Signer | null;
  /** 현장 안전 경고 횟수(3.0, 등급과 무관). 현장에 나간 적이 없으면 없음 */
  safetyWarnings?: number;
  /** 그 회차 계획의 미리보기(책상의 생산계획서를 펼쳐 볼 때 계획 간트·숫자를 채운다). 처음 펼칠 때 받아 둔다. */
  preview?: Preview;
}

interface Signer {
  nickname: string;
  classCode: string;
}

type Screen = "desk" | "plan" | "room" | "field";
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
  /** 오른쪽 모니터 위쪽 작업 현황에서 보는 구획(3.2, D38: 전경은 없다). (이름은 옛 CCTV에서 왔다) */
  cctv: SectorId;
  /** 크게 보고 있는 모니터 */
  zoomed: "left" | "right" | null;
  /** 현장에서 가까이 보는 구획. null이면 전경. */
  fieldFocus: SectorId | null;
  /** 자재·블록 추적(3.1): 진하게 볼 배(나머지는 흐리게). null이면 끔 */
  track: string | null;
  /** 떠 있는 추적 상자(누른 블록이나 선반). 떠 있는 동안 재생은 멈춰 있다 */
  pick: TrackPick | null;
  /** 현장에서 관리자가 선 자리: 안전한 자리, 또는 버튼으로 순간이동한 설비 옆(3.0) */
  managerSpot: "safe" | "crane" | "cart";
  /** 마지막으로 서명한 사람(이 브라우저가 기억한다). */
  signer: Signer | null;
  /** 반 코드를 적었으면 그 반의 시나리오별 최고(서버). */
  classBest: Record<string, ClassBest>;
}

let state: State;
let timer: number | undefined;
let previewSeq = 0;
let previewTimer: number | undefined;

const els = {
  desk: h("section", { class: "desk", "aria-label": "분기 고르기" }),
  plan: h("section", { class: "plan-screen", "aria-label": "생산계획서" }),
  room: h("section", { class: "room", "aria-label": "관제실" }),
  field: h("section", { class: "field-screen", "aria-label": "현장" }),
  fieldHead: h("div", { class: "field-head" }),
  fieldOsd: h("div", { class: "osd field-osd", "data-group": "speed-field" }),
  sceneField: h("div", { class: "scene-host field-host" }),
  form: h("aside", { class: "form" }),
  planBar: h("div", { class: "bar-row" }),
  planTabs: h("nav", { class: "plan-tabs", "aria-label": "계획안" }),
  // 생산계획서 오른쪽 포스트잇: 안·분기 설명(form.ts), 목표와 이번 세션 최고(goalNote)
  planNotes: h("div", { class: "plan-notes-main" }),
  goalNote: h("div", { class: "postit green" }),
  // 펜: 생산계획서 밖, 화면 오른쪽 아래. 누르면 결재란 "승인" 칸에 Loozy가 서명하고 실행한다.
  pen: h("button", { class: "desk-pen", type: "button" }),
  // 관제실
  plate: h("div", { class: "plate" }),
  plateRight: h("div", { class: "plate right" }),
  monitorLeft: h("div", { class: "monitor left" }),
  monitorRight: h("div", { class: "monitor right" }),
  osd: h("div", { class: "osd", "data-group": "speed" }),
  // 오른쪽 모니터를 크게 볼 때만 보이는 같은 재생 막대
  osdRight: h("div", { class: "osd osd-right", "data-group": "speed-right" }),
  ganttScreen: h("div", { class: "gantt-screen" }),
  rightTop: h("div", { class: "right-top" }),
  /** 자재·블록 추적 상자 자리: 작업 현황 위(관제실) */
  trackRoom: h("div", { class: "track-host" }),
  /** 자재·블록 추적 상자 자리: 현장 3D 위 */
  trackField: h("div", { class: "track-host" }),
  /** 인도 완료 로그: 작업 현황(관제실)과 현장 3D의 오른쪽 위. 인도한 배는 조선소를 떠나 그림에 없다 */
  deliveredRoom: h("ol", { class: "delivered-log", "aria-label": "인도 완료" }),
  deliveredField: h("ol", { class: "delivered-log", "aria-label": "인도 완료" }),
  log: h("ol", { class: "log", "aria-label": "사건 기록" }),
  deskClip: h("button", { class: "desk-clip", type: "button", title: "생산계획서로 돌아가 계획을 고칩니다" }),
  hat: h("button", { class: "desk-hat", type: "button", title: "작업모를 쓰고 현장으로 나갑니다" }),
  hands: h("div", { class: "hands", "aria-hidden": "true" }),
  reportBoard: h("div", { class: "report-board clipboard" }),
  /** 책상의 생산계획서를 펼친 클립보드(실행한 회차의 계획, 읽기 전용). */
  planBoard: h("div", { class: "report-board plan-board clipboard", hidden: true }),
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
        els.planNotes.querySelector(".edited")?.removeAttribute("hidden");
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
  renderPlanNotes(els.planNotes, ctx);
  renderPlanTabs(els.planTabs, ctx);
  updateForm();
}

/** 양식의 미리보기 숫자와 오류, 승인 버튼 상태를 갱신한다. */
function updateForm(): void {
  updatePreview(els.form, state.preview, state.errors, state.busy);
  const blocked = state.busy || state.errors.length > 0;
  els.pen.classList.toggle("blocked", blocked);
  els.pen.setAttribute("aria-disabled", String(blocked));
  els.pen.title = state.errors.length ? "생산계획서에서 고칠 곳이 있어 서명할 수 없습니다" : `결재란 "승인" 칸에 서명하고 ${state.data.scenario.days}일을 실행합니다`;
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
  updateForm();
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
  els.field.hidden = screen !== "field";
  if (screen !== "room" && screen !== "field") {
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
  clearSignature();   // 계획을 고치러 오면 아직 서명하지 않은 새 계획이다.
  const flying = reduceMotion() ? null : makeGhost(source);
  // 지금 화면을 먼저 치워야 생산계획서가 화면 맨 위 제자리에서 재진다.
  els.desk.hidden = true;
  els.room.hidden = true;
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
    classCode: state.signer?.classCode ?? "",
    classBest: state.classBest,
    onPick: (id, board) => void enterScenario(id, board),
  });
}

// ---------------------------------------------------------------------------
// 수업용 저장: 서명한 이름으로 60일을 끝낸 회차를 저장하고, 반 최고를 받아 온다
// ---------------------------------------------------------------------------

const SIGNER_KEY = "paper-shipyard.signer";

/** 이 브라우저가 기억하는 마지막 서명자. 저장소를 못 쓰는 환경이면 없음. */
function loadSigner(): Signer | null {
  try {
    const raw = window.localStorage.getItem(SIGNER_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return v && typeof v.nickname === "string" ? { nickname: v.nickname, classCode: String(v.classCode ?? "") } : null;
  } catch {
    return null;
  }
}

function rememberSigner(signer: Signer): void {
  state.signer = signer;
  try {
    window.localStorage.setItem(SIGNER_KEY, JSON.stringify(signer));
  } catch {
    // 개인 정보 보호 모드 등: 이번 세션 동안만 기억한다.
  }
}

async function refreshClassBest(): Promise<void> {
  const code = state.signer?.classCode ?? "";
  if (!code) {
    state.classBest = {};
    return;
  }
  try {
    state.classBest = (await api.leaderboard(code)).best;
  } catch {
    // 서버에 저장소가 없거나 연결이 끊겨도 혼자 하는 연습은 그대로 된다.
  }
  if (state.screen === "desk") drawDesk();
  drawTopbar();
}

/** 60일을 끝낸 회차를 서명한 이름으로 저장한다. 등급은 서버가 설정으로 다시 계산한다. */
async function saveRun(r: Run): Promise<void> {
  if (!r.signer) return;
  try {
    await api.saveRun(r.signer.nickname, r.signer.classCode, r.config);
    notify(r.signer.classCode ? `${r.signer.nickname} · ${r.signer.classCode} 이름으로 저장했습니다` : `${r.signer.nickname} 이름으로 저장했습니다`);
    await refreshClassBest();
    if (state.screen === "room") drawPlates();
  } catch (error) {
    notify(`저장하지 못했습니다: ${error instanceof ApiError ? error.messages.join(" ") : String(error)}`);
  }
}

/** 서명 카드: 닉네임(최대 10자)과 반 코드(선택)를 받는다. 취소하면 null. */
function askSigner(): Promise<Signer | null> {
  return new Promise((resolve) => {
    const nickname = h("input", { type: "text", maxlength: 10, required: true, autocomplete: "nickname", value: state.signer?.nickname ?? "", "aria-label": "닉네임" });
    const classCode = h("input", { type: "text", maxlength: 20, autocomplete: "off", value: state.signer?.classCode ?? "", placeholder: "예: 3반", "aria-label": "반 코드" });
    const error = h("p", { class: "sign-error", role: "alert" });
    const dialog = h("dialog", { class: "sign-card" },
      h("form", {
        method: "dialog",
        onsubmit: (e: Event) => {
          e.preventDefault();
          const name = nickname.value.trim();
          const code = classCode.value.trim();
          if (!name) return void (error.textContent = "닉네임을 적어 주세요");
          if (!/^[0-9A-Za-z가-힣_-]*$/.test(code)) return void (error.textContent = "반 코드는 한글·영문·숫자·-·_ 만 씁니다");
          dialog.close();
          resolve({ nickname: name, classCode: code });
        },
      },
      h("h3", null, "결재란에 서명합니다"),
      h("label", null, h("span", null, "닉네임 ", h("small", null, "최대 10자")), nickname),
      h("label", null, h("span", null, "반 코드 ", h("small", null, "선택 · 적으면 같은 반 최고 등급을 함께 봅니다")), classCode),
      error,
      h("div", { class: "sign-card-buttons" },
        h("button", { type: "button", class: "btn ghost", onclick: () => { dialog.close(); resolve(null); } }, "취소"),
        h("button", { type: "submit", class: "btn primary" }, "서명"))));
    dialog.addEventListener("cancel", () => resolve(null));   // Esc
    dialog.addEventListener("close", () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
    nickname.select();
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
  // 앞 분기의 설정으로 보낸 미리보기가 늦게 오면 버린다(배 수가 달라 계획 간트가 깨진다).
  previewSeq++;
  Object.assign(state, {
    data, config: structuredClone(first.config), presetId: first.id, edited: false, preview: null, errors: [],
    current: last ?? null, ganttShip: null, cctv: "shop", board: "none",
    day: last !== undefined && state.runs[last].finished ? data.scenario.days : 0,
  });
  drawForm();
  schedulePreview();
}

/** 평가서나 펼친 생산계획서의 "계획 고치기": 생산계획서 화면으로 계획을 고치러 간다. */
async function backToPlan(): Promise<void> {
  pause();
  const source = planUp ? els.planBoard : state.board === "up" ? els.reportBoard : els.deskClip;
  closePlanBoard();
  await openPlan(source);
  drawTopbar();
}

// ---------------------------------------------------------------------------
// 책상의 생산계획서 펼쳐 보기(2.0.1): 실행한 계획을 평가서처럼 관제실 위에 띄운다.
// 화면을 옮기지 않으므로 평가서와 재생 위치가 그대로 남는다. 고치려면 "계획 고치기".
// ---------------------------------------------------------------------------

let planUp = false;

async function openPlanBoard(): Promise<void> {
  const r = currentRun();
  if (!r) return void backToPlan();
  pause();
  if (state.board === "up") {
    state.board = "down";
    drawReportBoard();
  }
  planUp = true;
  els.room.classList.add("plan-up");
  els.planBoard.hidden = false;
  const sheet = h("aside", { class: "form plan-readonly" });
  mount(els.planBoard,
    h("div", { class: "report-sheet" },
      h("div", { class: "report-actions" },
        h("span", { class: "hint" }, `${r.n}회차에 실행한 계획 · 바깥 어두운 곳을 누르면 내려 둡니다`),
        h("button", { class: "btn primary small", type: "button", onclick: () => void backToPlan() }, "계획 고치기")),
      sheet));
  try {
    r.preview ??= await api.preview(r.config);
  } catch {
    // 미리보기가 없어도 계획 내용은 보인다(계획 간트만 빈다).
  }
  if (!planUp) return;
  // 같은 양식 그리기를 그 회차의 설정으로 한 번 더 쓴다. 양식 모듈은 마지막으로 그린 양식을 기억하므로
  // 다 그린 뒤 생산계획서 화면의 양식을 다시 그려 되돌린다.
  renderForm(sheet, {
    scenario: state.data.scenario, scenarios: state.data.scenarios, presets: state.data.presets,
    config: structuredClone(r.config), presetId: null, edited: false, busy: true,
    onEdit: () => {}, onPreset: () => {}, onDesk: () => {}, onRun: () => {},
  });
  // 라디오는 name이 같으면 문서 전체에서 한 묶음이다. 아래에서 생산계획서 화면의 양식을 다시 그리면
  // 같은 name의 라디오가 이 펼친 계획서의 선택(대기소 인원, 공법 등)을 빼앗는다. 그리기 전에 name을 뗀다.
  sheet.querySelectorAll<HTMLInputElement>("input[name]").forEach((el) => el.removeAttribute("name"));
  updatePreview(sheet, r.preview ?? null, [], true);
  // 읽기 전용: [공통 | 배별] 탭만 누를 수 있고, 입력·버튼·계획 간트 끌기는 막는다.
  sheet.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>("input, select, textarea, button:not([role=tab])")
    .forEach((el) => { el.disabled = true; });
  sheet.querySelector<HTMLElement>('[data-sign="승인"]')?.append(
    h("span", { class: "sign-name" }, r.signer?.nickname ?? REVIEWER));
  drawForm();
}

function closePlanBoard(): void {
  planUp = false;
  els.room.classList.remove("plan-up");
  els.planBoard.hidden = true;
  els.planBoard.replaceChildren();
}

// ---------------------------------------------------------------------------
// 서명: 펜으로 결재란 "승인" 칸에 승인자(Loozy)의 이름을 써 넣는다
// ---------------------------------------------------------------------------

// 펜 그림(PEN_SVG, 160×160을 120px로 그림)에서 펜 끝의 자리. 서명할 때 이 점을 칸에 댄다.
const PEN_TIP = { x: 15, y: 95 };
let signing = false;
const wait = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function clearSignature(): void {
  els.form.querySelectorAll(".signature").forEach((el) => el.remove());
}

/** 펜을 결재란 "승인" 칸으로 옮겨 "Loozy"를 왼쪽부터 써 넣고, 다 쓰면 실행한다. */
async function signAndRun(): Promise<void> {
  if (signing || state.busy) return;
  if (state.errors.length) {
    notify("생산계획서에서 고칠 곳이 있어 서명할 수 없습니다");
    els.form.querySelector(".errors")?.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  const box = els.form.querySelector<HTMLElement>('[data-sign="승인"]');
  if (!box) return void run();
  signing = true;
  const signer = await askSigner();
  if (!signer) {
    signing = false;
    return;
  }
  rememberSigner(signer);
  clearSignature();
  const reduce = reduceMotion();
  els.form.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
  if (!reduce) await wait(320);

  // 서명: 승인자 이름을 필기체로. 쓰는 모습은 왼쪽부터 드러내는 clip-path로 낸다.
  const sig = h("span", { class: "sign-name signature", "aria-label": `${signer.nickname} 서명` }, signer.nickname);
  box.append(sig);

  if (!reduce) {
    // 펜 끝(왼쪽 아래)이 칸의 왼쪽에 닿게 옮긴 뒤, 쓰는 동안 칸을 가로질러 움직인다.
    const art = els.pen.querySelector("svg")!.getBoundingClientRect();
    const target = sig.getBoundingClientRect();
    const dx = target.left - 2 - (art.left + PEN_TIP.x);
    const dy = target.bottom - 4 - (art.top + PEN_TIP.y);
    els.pen.classList.add("writing");
    sig.style.clipPath = "inset(0 100% 0 0)";
    await els.pen.animate([{ transform: "translate(0, 0)" }, { transform: `translate(${dx}px, ${dy}px)` }],
      { duration: 480, easing: "cubic-bezier(.2,.7,.2,1)", fill: "forwards" }).finished;
    const write = sig.animate([{ clipPath: "inset(0 100% 0 0)" }, { clipPath: "inset(0 0 0 0)" }], { duration: 800, easing: "linear", fill: "forwards" });
    els.pen.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: `translate(${dx + target.width}px, ${dy - 3}px)` }],
      { duration: 800, easing: "linear", fill: "forwards" });
    await write.finished;
    sig.style.clipPath = "";
    await wait(250);
    els.pen.getAnimations().forEach((a) => a.cancel());
    els.pen.classList.remove("writing");
  }
  signing = false;
  await run(signer);
}

// ---------------------------------------------------------------------------
// 실행: 서명하면 클립보드를 책상에 내려놓고 관제실로
// ---------------------------------------------------------------------------

async function run(signer: Signer | null = null): Promise<void> {
  state.busy = true;
  updateForm();
  let result: Result;
  const config = structuredClone(state.config);
  try {
    result = await api.simulate(config);
  } catch (error) {
    state.errors = error instanceof ApiError ? error.messages : [String(error)];
    return;
  } finally {
    state.busy = false;
    updateForm();
  }
  state.runs.push({ n: state.runs.length + 1, scenario: state.data.scenario.id, label: runLabel(), config, result, finished: false, signer });
  state.current = state.runs.length - 1;
  Object.assign(state, { day: 0, ganttShip: null, cctv: "shop", board: "none", playing: false });

  const source = els.plan.querySelector<HTMLElement>(".board-left");
  // 생산계획서 클립보드를 띄워 두고(복제), 관제실을 보이지 않게 그려 책상 위 자리를 잰다.
  const flying = reduceMotion() || !source ? null : makeGhost(source);
  state.screen = "room";        // drawRoom()과 tick()이 그리도록 먼저 바꾼다.
  els.plan.hidden = true;       // 생산계획서를 치워야 관제실이 화면 맨 위 제자리에서 재진다.
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
  // 추적 상자는 떠 있는 동안 재생을 멈춰 둔다(읽기 쉽게, 사용자 결정). 재생하면 닫는다.
  if (state.pick) { state.pick = null; drawTrackCard(); }
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
  }, msPerDay());
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
  void saveRun(r);
  state.board = "up";
  unzoom();   // 크게 보던 모니터가 평가서를 가리지 않게 줄인다(3.0.2). 재생 막대는 왼쪽 모니터에 남는다.
  if (state.screen !== "room") setScreen("room");   // 현장에서 끝으로 건너뛰면 관제실로 돌아와 받는다.
  drawRoom();
}

/** 날짜가 바뀔 때마다 모니터(간트, 작업 현황, 사건 기록)와 재생 막대를 갱신한다. jump면 3D 소인이 걷지 않고 바로 옮긴다. */
function tick(jump: boolean): void {
  const r = currentRun();
  if (!state || !r || (state.screen !== "room" && state.screen !== "field")) {
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

  // 재생 막대(왼쪽 모니터 위, 현장 아래)
  for (const osd of allOsds()) {
    const slider = osd.querySelector<HTMLInputElement>("input.scrub");
    if (slider) slider.value = String(state.day);
    const dayLabel = osd.querySelector(".day-now");
    if (dayLabel) dayLabel.textContent = `${state.day} / ${result.days}일`;
    const playBtn = osd.querySelector(".play");
    if (playBtn) playBtn.textContent = state.playing ? "❚❚ 멈춤" : "▶ 재생";
  }

  // 오른쪽 모니터 위: 작업 현황(위에서 비스듬히 내려다본 2D 정지 화면). 전경 또는 고른 공정 확대.
  const feed = els.rightTop.querySelector(".cc-host");
  if (feed) {
    mount(feed, renderCctv(buildFrame(result, scenario, r.config, state.day, 1), scenario, {
      focus: state.cctv, onSector: openSector, track: state.track, onPick: openTrack,
    }));
  }
  const cam = els.rightTop.querySelector(".cam-label");
  if (cam) cam.textContent = camLabel();

  // 오른쪽 모니터 아래: 사건 기록(오늘까지, 최근이 위). 스크롤해서 보던 자리는 지킨다.
  const keep = els.log.scrollTop;
  const events = result.events.filter((ev) => ev.day <= state.day && LOG_EVENTS.has(ev.type)).reverse();
  mount(els.log, events.length
    ? events.map((ev) => h("li", { class: ev.day === state.day ? "today" : "" },
      h("b", null, `${ev.day}일`), h("em", { class: ev.type }, EVENT_NAME[ev.type]), h("span", null, eventText(ev, scenario))))
    : h("li", { class: "quiet" }, state.day ? "아직 기록할 사건이 없습니다." : "재생하면 1일부터 사건이 여기에 쌓입니다."));
  els.log.scrollTop = keep;

  drawTrackCard();
  drawDelivered(buildFrame(result, scenario, r.config, state.day, 1));
  syncScene(jump);
}

// ---------------------------------------------------------------------------
// 자재·블록 추적 (3.1): 블록이나 선반을 누르면 상자, "이 배 전부 보기"면 그 배만 진하게
// ---------------------------------------------------------------------------

/** 블록이나 선반을 눌렀다: 재생을 멈추고 상자를 띄운다. */
function openTrack(pick: TrackPick): void {
  if (state.playing) pause();
  state.pick = pick;
  drawTrackCard();
}

function closeTrack(): void {
  state.pick = null;
  drawTrackCard();
}

function setTrack(ship: string | null): void {
  state.track = ship;
  yard?.setTrack(ship);
  drawRightTop();
  if (state.screen === "field") drawField();
  tick(true);
}

/** 추적할 배 고르기(작업 현황 전경 오른쪽 아래, 현장 머리줄) */
function trackSelect(): HTMLElement {
  return h("label", { class: "cam-track" }, "추적",
    h("select", { onchange: (e: Event) => setTrack((e.target as HTMLSelectElement).value || null) },
      h("option", { value: "" }, "없음"),
      (currentRun()?.result.ships ?? []).map((sh) => h("option", { value: sh.id, selected: state.track === sh.id }, sh.id))));
}

/** 인도 완료 로그: 오늘까지 인도한 배를 최근 것부터. 추적 상자가 떠 있으면 그 자리를 비켜 감춘다 */
function drawDelivered(frame: Frame): void {
  const { scenario } = state.data;
  const rows = frame.delivered.map((d) => h("li", { class: d.late ? "late" : "" },
    h("b", null, d.ship),
    h("span", null, scenario.ship_types[d.type]?.name ?? d.type),
    h("span", null, `${d.day}일 인도`),
    h("em", null, d.late ? `${d.late}일 지연` : "납기 준수")));
  for (const host of [els.deliveredRoom, els.deliveredField]) {
    host.hidden = !!state.pick || rows.length === 0;
    mount(host, rows.length ? [h("li", { class: "head" }, `인도 완료 ${rows.length}척`), ...rows.map((r) => r.cloneNode(true) as HTMLElement)] : []);
  }
}

function drawTrackCard(): void {
  // 추적 상자는 인도 완료 로그 자리(오른쪽 위)에 겹쳐 뜨므로, 떠 있는 동안 로그를 감춘다
  for (const log of [els.deliveredRoom, els.deliveredField]) log.hidden = !!state.pick || log.childElementCount === 0;
  const r = currentRun();
  const field = state.screen === "field";
  const host = field ? els.trackField : els.trackRoom;
  mount(field ? els.trackRoom : els.trackField);
  if (!r || !state.pick) return mount(host);
  const frame = buildFrame(r.result, state.data.scenario, r.config, state.day, 1);
  mount(host, renderTrackCard(state.pick, r.result, state.data.scenario, frame, {
    track: setTrack,
    pick: openTrack,
    close: closeTrack,
    gantt: field ? undefined : (ship) => { state.ganttShip = ship; drawGanttScreen(); tick(true); },
  }, state.track));
}

// ---------------------------------------------------------------------------
// 작업 현황 전경 (오른쪽 모니터 위쪽, 2D)
// ---------------------------------------------------------------------------

function camLabel(): string {
  return `작업 현황 · ${sector(state.cctv).name} · ${state.day}일`;
}

/** 오른쪽 모니터 작업 현황을 그 구획으로. 재생 중에도 오늘을 본다(결과를 미리 알려 주지 않는다). */
function openSector(id: SectorId, day?: number): void {
  if (!currentRun()) return;
  state.cctv = id;
  drawRightTop();
  if (day !== undefined) seek(day);
  else tick(true);
}

/** 그 공정이 있는 구획으로(간트 막대, 평가서 의문점). PE장·탑재는 그날 그 배가 있던 작업장의 구획. */
function openCctv(station: number, day: number, ship: string | null): void {
  const r = currentRun();
  if (!r) return;
  const frame = buildFrame(r.result, state.data.scenario, r.config, day, 1);
  const docks = frame.stations[ST.dock]?.units.length ?? 1;
  const lot = ship ? frame.lots.find((l) => l.ship === ship && l.place === "bench" && l.station === station) : undefined;
  openSector(sectorOf(station, lot?.unit ?? 0, docks), day);
}

/** 현장 카메라: 전경 또는 고른 공정. */
function aimCamera(): void {
  const apply = () => {
    yard?.setCamera("field", state.fieldFocus);
    // 공정을 바꿔 보면 관리자는 그 공정 앞 안전한 자리로 간다
    state.managerSpot = "safe";
    yard?.setManagerSpot("safe", state.fieldFocus);
    // 이름표는 현장에서 공정을 가까이 볼 때만.
    yard?.showNameTags(state.screen === "field" && state.fieldFocus !== null);
  };
  if (yard) apply();
  else void yardLoading?.then(apply);
}


/** 3D를 그릴 자리: 현장이면 화면 전체. 관제실은 2D라 3D가 없다. */
function sceneHost(): HTMLElement | null {
  return state.screen === "field" ? els.sceneField : null;
}

/** 3D를 보는 중이면 장면을 오늘 날짜로 맞추고, 아니면 그리기를 멈춘다. */
function syncScene(jump: boolean): void {
  const r = currentRun();
  const host = sceneHost();
  if (!host || !r) {
    yard?.stop();
    return;
  }
  if (!yard) {
    yardLoading ??= import("./scene/yard").then((y) => {
      yard = new y.Yard();
      yard.setPickHandler(openTrack);
    });
    void yardLoading.then(() => {
      aimCamera();
      syncScene(true);
    });
    return;
  }
  yard.attach(host);
  yard.setManagerName(r.signer?.nickname ?? "생산관리자");
  yard.setTrack(state.track);
  if (yardRun !== r) {
    yard.load(r.result.ships.map((s) => ({ id: s.id, type: s.type })));
    yardRun = r;
    jump = true;
  }
  const { scenario } = state.data;
  const day = state.day;
  yard.setSource({
    frameAt: (frac) => buildFrame(r.result, scenario, r.config, day, frac),
    playing: state.playing,
    msPerDay: msPerDay(),
    // 1배속 이하에서만 걷는 모습을 보여 준다. 빠르면 바로 옮긴다.
    snap: jump || (state.screen !== "field" && state.speed > 1),
  });
  yard.start();
}

function pickBar(pick: GanttPick): void {
  const station = state.data.scenario.stations.findIndex((st) => st.id === pick.station);
  pause();
  openCctv(station, pick.start, pick.ship);
}

/** 평가서의 의문점 카드: 간트는 왼쪽 모니터를 그 배·날짜로, 작업 현황은 오른쪽 모니터를 그 공정 확대로. 보드는 내려 둔다. */
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
  openCctv(station, f.start, f.ship);
}

// ---------------------------------------------------------------------------
// 관제실 그리기
// ---------------------------------------------------------------------------

function drawRoom(): void {
  drawPlates();
  drawOsd(els.osd);
  drawOsd(els.osdRight);
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
          Object.assign(state, { day: run.finished ? run.result.days : 0, ganttShip: null, cctv: "shop", board: run.finished ? "down" : "none" });
          drawRoom();
        },
      }, `${run.n}`, run.finished ? gradeChip(run.result.grade.grade, "chip-grade") : null))) : null);
}

/** 재생 막대가 있는 자리: 왼쪽 모니터 위, 오른쪽 모니터 위(크게 볼 때만), 현장 아래. */
function allOsds(): HTMLElement[] {
  return [els.osd, els.osdRight, els.fieldOsd];
}

/** 왼쪽 모니터 맨 위의 재생 막대(화면 속 조작부). 오른쪽 모니터(크게 볼 때)와 현장에도 같은 막대를 둔다. */
function drawOsd(target: HTMLElement = els.osd): void {
  const r = currentRun();
  if (!r) return mount(target);
  const group = target.dataset.group ?? "speed";
  mount(target,
    h("button", { class: "osd-btn", type: "button", title: "처음부터", onclick: () => { pause(); seek(0); } }, "⟲"),
    h("button", { class: "osd-btn play", type: "button", onclick: () => (state.playing ? pause() : play()) }, "▶ 재생"),
    // 현장은 1배속 고정(하루 2초): 배속 대신 안내만
    target === els.fieldOsd
      ? h("span", { class: "osd-fixed", title: "현장은 소인이 걸어서 일하는 모습을 보도록 1배속으로만 흐릅니다" }, `1× · 하루 ${FIELD_MS_PER_DAY / 1000}초`)
      : h("div", { class: "osd-speed", role: "radiogroup", "aria-label": "배속" }, SPEEDS.map((sp) =>
        h("label", null,
          h("input", { type: "radio", name: group, checked: state.speed === sp, onchange: () => { state.speed = sp; restartTimer(); allOsds().forEach((o) => drawOsd(o)); tick(true); } }),
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
    // 바로 결과로: 60일 전이면 끝으로 건너뛰어 평가서를 받는다. 받은 뒤에는 평가서가 책상 아래 띠로 남아 있으므로 버튼을 두지 않는다(2.1.1).
    r.finished
      ? null
      : h("button", { class: "osd-btn end", type: "button", title: "60일 끝으로 건너뛰고 평가서를 받습니다 (End)", onclick: finish }, "끝으로 ⏭"));
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
      // 나눠 하기(3.0)를 쓰는 분기에서만: 막대가 작업장 줄로 갈라지고 먼저 끝난 줄은 짝 대기
      scenario.options?.split ? h("span", null, h("i", { class: "thin hatch-over", style: { background: PAIR_WAIT_STATE.color } }), "짝 대기(나눠 하기)") : null,
      h("span", { class: "sep" }),
      h("span", null, h("i", { class: "due-mark" }), "납기"),
      h("span", null, h("i", { class: "deliver-mark" }), "인도")),
    h("div", { class: "ship-detail zoom-only" }));
}

/** 오른쪽 모니터 위쪽: 작업 현황, 구획 하나(위 단추로 바꾼다). 그림은 tick이 채운다. */
function drawRightTop(): void {
  const label = els.monitorRight.querySelector(".win-title");
  mount(els.rightTop,
    h("div", { class: "cc-host" }),
    h("span", { class: "cam-label" }, camLabel()),
    h("span", { class: "cam-anon", title: "관제실 화면은 사람을 기호로만 보여 줍니다. 얼굴과 이름은 현장에 직접 나가야 보입니다." },
      "익명 표시 · 개인을 구분하지 않습니다"),
    els.trackRoom,
    els.deliveredRoom,
    // 추적할 배 고르기(3.1): 고른 배의 블록만 진하게, 선반에는 그 배 몫
    trackSelect(),
    h("div", { class: "cam-switch", role: "group", "aria-label": "볼 구획" },
      SECTORS.map((sec) =>
        h("button", { type: "button", class: sec.id === state.cctv ? "active" : "", onclick: () => openSector(sec.id) }, sec.name))));
  if (label) label.textContent = `작업 현황 · ${sector(state.cctv).name}`;
}

/** 책상 위: 생산계획서 클립보드(누르면 계획 고치기). 평가서를 보고 있으면 손은 보이지 않는다(CSS). */
function drawDeskItems(): void {
  const r = currentRun();
  mount(els.deskClip,
    h("span", { class: "clip-sheet" }, h("b", null, "생산계획서"), h("small", null, r?.label ?? ""), h("i"), h("i"), h("i")),
    h("span", { class: "desk-label" }, r ? "누르면 실행한 계획 보기" : "누르면 계획 고치기"));
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
        h("span", { class: "hint" }, state.board === "up" ? "바깥 어두운 곳을 누르면 내려 둡니다" : "생산실적 평가서 · 누르면 다시 올림"),
        h("button", { class: "btn primary small", type: "button", onclick: () => void backToPlan() }, "계획 고치기")),
      docHead({
        title: "생산실적 평가서", code: `PE-${r.n}`, approver: r.signer?.nickname,
        fields: [["회차", `${r.n}회차`], ["설정", r.label], ["판정", `${g.grade} (${g.score.toFixed(1)}점)`]],
        stamp: {
          text: g.grade, sub: `${g.score.toFixed(1)}점`, strong: g.grade === "S" || g.grade === "F",
          // 밝은 금(S)은 종이 위에서 윤곽이 약해 진한 금 테두리 + 금 바탕 + 먹색 글자로 찍는다.
          color: GRADE_EDGE[g.grade] ?? GRADE_COLOR[g.grade] ?? "#4b5a51",
          fill: GRADE_EDGE[g.grade] ? GRADE_COLOR[g.grade] : undefined,
          ink: GRADE_TEXT[g.grade],
        },
      }),
      r.safetyWarnings !== undefined
        ? h("p", { class: "safety-line" }, `현장 안전 경고 ${r.safetyWarnings}회`,
          h("small", null, r.safetyWarnings ? " · 현장에서 위험 설비 반경에 들어간 횟수입니다(등급과 무관)" : " · 현장에서 위험 반경에 들어가지 않았습니다"))
        : null,
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

/** 모니터: Windows 창처럼 제목 표시줄(제목, 최대화/이전 크기로, 닫기)과 화면. */
function monitor(el: HTMLElement, which: "left" | "right", label: string, ...screen: Node[]): void {
  const toggle = () => (state.zoomed === which ? unzoom() : zoom(which));
  mount(el,
    h("div", { class: "bezel" },
      h("div", { class: "win-titlebar", ondblclick: toggle },
        h("span", { class: "win-title" }, label),
        h("div", { class: "win-buttons" },
          // 최대화 / 이전 크기로. 닫기(✕)는 이전 크기로와 같은 일이라 두지 않는다(2.1.1).
          winButton("max", "최대화", toggle, WIN_MAX_SVG),
          winButton("restore", "이전 크기로 (Esc)", unzoom, WIN_RESTORE_SVG))),
      h("div", { class: "screen" }, ...screen)));
}

// ---------------------------------------------------------------------------
// 현장: 작업모를 쓰고 직접 나간다
// ---------------------------------------------------------------------------

const introSeen = new Set<number>();

/** 작업모를 누르면 생산관리자가 작업모(고깔)를 쓰고 현장으로 나간다. 회차마다 처음 한 번은 뛰어나가는 전환(누르면 건너뜀). */
function goField(): void {
  const r = currentRun();
  if (!r) return;
  state.fieldFocus = state.cctv;   // 작업 현황에서 보던 구획으로 나간다.
  pause();   // 현장에 나가면 시간이 멈춰 있다. 재생하면 1배속(하루 2초)으로 흐른다.
  r.safetyWarnings ??= 0;
  setScreen("field");
  drawField();
  aimCamera();
  tick(true);
  if (!introSeen.has(r.n) && !reduceMotion()) {
    introSeen.add(r.n);
    const overlay = h("div", { class: "field-intro", onclick: () => overlay.remove() },
      h("div", { class: "intro-run" }, h("span", { class: "intro-man" }, introHat(), "🏃"), h("span", { class: "intro-door" }, "🚪")),
      h("p", null, h("b", null, "관리자가 작업모를 쓰고 현장으로 나갑니다")),
      h("p", null, "관제실 화면에는 누구인지 보이지 않습니다. 직접 와야 사람이 보입니다."),
      h("p", { class: "hint" }, "누르면 건너뜁니다"));
    els.field.append(overlay);
    window.setTimeout(() => overlay.remove(), 1800);
  }
}

function backToRoom(): void {
  pause();   // 하루 길이가 달라지므로 멈춘 채로 돌아온다(관제실 배속으로 다시 재생).
  setScreen("room");
  drawRoom();
}

function drawField(): void {
  const r = currentRun();
  mount(els.fieldHead,
    h("button", { class: "field-back", type: "button", onclick: backToRoom }, "← 관제실로"),
    h("b", null, "현장"),
    h("span", { class: "hint" }, r ? `${r.n}회차 ${r.label} · 생산관리자의 눈으로 봅니다` : ""),
    h("div", { class: "field-cams", role: "group", "aria-label": "볼 곳" },
      h("button", { type: "button", class: state.fieldFocus === null ? "active" : "", onclick: () => { state.fieldFocus = null; drawField(); aimCamera(); } }, "전경"),
      SECTORS.map((sec) =>
        h("button", { type: "button", class: state.fieldFocus === sec.id ? "active" : "", onclick: () => { state.fieldFocus = sec.id; drawField(); aimCamera(); } }, sec.name))),
    // 관리자 순간이동(3.0 안전): 설비 옆으로 가면 위험 반경 경고. 1인칭 이동은 나중에(D35)
    h("div", { class: "field-cams", role: "group", "aria-label": "관리자 이동" },
      h("button", { type: "button", onclick: () => moveManager("crane") }, "골리앗 주변으로"),
      h("button", { type: "button", onclick: () => moveManager("cart") }, "트랜스포터 주변으로")),
    // 자재·블록 추적(3.1): 블록이나 선반을 누르면 상자, 고른 배는 노란 고리
    h("span", { class: "hint" }, "블록·선반을 누르면 추적"),
    trackSelect());
  drawOsd(els.fieldOsd);
}

function moveManager(spot: "safe" | "crane" | "cart"): void {
  state.managerSpot = spot;
  const hazard = yard?.setManagerSpot(spot, state.fieldFocus) ?? null;
  if (hazard) warnHazard(hazard);
}

/** 위험 설비 옆으로 갔다: 재생을 멈추고 알린다. 횟수는 그 회차 평가서에 한 줄(등급과 무관). */
function warnHazard(hazard: { id: string; label: string }): void {
  const r = currentRun();
  if (!r || state.screen !== "field") return;
  const wasPlaying = state.playing;
  pause();
  r.safetyWarnings = (r.safetyWarnings ?? 0) + 1;
  const overlay = h("div", { class: "safety-alert", role: "alertdialog", "aria-label": "현장 안전 경고" },
    h("div", { class: "safety-card" },
      h("b", null, "⚠ 위험 반경입니다"),
      h("p", null, `${hazard.label}에 들어왔습니다.`),
      h("p", { class: "hint" }, "움직이는 설비 반경 10m 안에는 들어가지 않습니다."),
      h("div", { class: "safety-actions" },
        h("button", { class: "btn primary", type: "button", onclick: () => {
          overlay.remove();
          moveManager("safe");
          if (wasPlaying) play();
        } }, "안전한 자리로 돌아가기"))));
  els.field.append(overlay);
  overlay.querySelector<HTMLButtonElement>("button")?.focus();
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

/** 생산계획서 오른쪽 포스트잇: 이 분기의 목표와 이번 세션 최고. */
function drawTopbar(): void {
  const sc = state.data.scenario;
  const best = sessionBest(sc.id);
  const k = sc.kpi;
  mount(els.goalNote,
    h("b", null, "목표"),
    h("ul", null,
      h("li", null, `매출 ${num(k.revenue)}`), h("li", null, `이익 ${num(k.profit)}`),
      h("li", null, `납기 준수 ${pct(k.on_time_rate, 0)}`), h("li", null, `직행률 ${pct(k.first_pass_yield, 0)}`)),
    best
      ? h("p", { class: "postit-best" }, "이번 세션 최고 ", gradeChip(best.result.grade.grade, "best-grade"),
        ` ${best.result.grade.score.toFixed(1)}점 · ${best.n}회차 ${best.label}`)
      : h("p", null, "S 105 · A 85 · B 70 · C 50"),
    state.signer?.classCode
      ? h("p", { class: "postit-best" }, `우리 반(${state.signer.classCode}) 최고 `,
        state.classBest[sc.id]
          ? [gradeChip(state.classBest[sc.id].grade, "best-grade"), ` ${state.classBest[sc.id].score.toFixed(1)}점 · ${state.classBest[sc.id].nickname}`]
          : "아직 없음")
      : null);
}

function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape" && planUp) {
    closePlanBoard();
    return;
  }
  if (e.key === "Escape" && state.pick) {
    closeTrack();
    return;
  }
  if (e.key === "Escape" && state.zoomed) {
    unzoom();
    return;
  }
  if (e.key === "Escape" && state.screen === "field") {
    backToRoom();
    return;
  }
  const target = e.target as HTMLElement;
  // 계획 간트처럼 화살표 키를 스스로 쓰는 요소에 포커스가 있으면 재생 단축키를 쓰지 않는다.
  if (target.closest("input, select, textarea, [data-own-keys]")) return;
  const r = currentRun();
  if (!r || (state.screen !== "room" && state.screen !== "field")) return;
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
// 만년필: 먹색 몸통, 무광 금색 펜촉. 펜 끝은 왼쪽 아래(서명할 때 칸에 닿는 쪽).
const PEN_SVG = `<svg viewBox="0 0 160 160" aria-hidden="true"><g transform="rotate(-38 80 80)"><rect x="22" y="72" width="96" height="16" rx="8" fill="#26302b"/><rect x="104" y="72" width="30" height="16" rx="7" fill="#33413a"/><rect x="96" y="70" width="4" height="20" fill="#b8a271"/><path d="M22 72 L 4 80 L 22 88 Z" fill="#b8a271"/><path d="M8 80 L 18 80" stroke="#26302b" stroke-width="1.2"/></g></svg>`;
// 작업모: 관리자 색 #d9480f
function introHat(): HTMLElement {
  const el = h("span", { class: "intro-hat" });
  el.innerHTML = HAT_SVG;
  return el;
}

// 생산관리자의 작업모: 소인국의 주황 고깔모자(끝이 휘고 아래에 어두운 테두리).
// 창 단추 그림: 글자(□ ❐)는 글꼴마다 가늘고 작아서 잘 안 보인다. 굵은 선 그림으로 그린다.
const WIN_MAX_SVG = `<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
const WIN_RESTORE_SVG = `<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1" y="3.5" width="7.5" height="7.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3.5 3.5 V1 H11 V8.5 H8.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;

function winButton(kind: string, title: string, onclick: () => void, svg: string): HTMLElement {
  const btn = h("button", { class: `win-btn ${kind}`, type: "button", title, "aria-label": title.replace(/ \(.*\)$/, ""), onclick });
  btn.innerHTML = svg;
  return btn;
}

const HAT_SVG = `<svg viewBox="0 0 120 90" aria-hidden="true"><path d="M26 76 C 36 52, 50 26, 70 12 C 78 6, 90 8, 94 16 C 86 15, 80 20, 78 30 C 82 50, 90 64, 94 76 Z" fill="#d9480f"/><path d="M78 30 C 82 50, 90 64, 94 76 L 74 76 C 74 58, 74 42, 78 30 Z" fill="#b23a0b" opacity="0.55"/><ellipse cx="60" cy="77" rx="40" ry="6" fill="#2b2b2b"/></svg>`;

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
    speed: 4,
    board: "none",
    cctv: "shop",
    zoomed: null,
    fieldFocus: null,
    track: null,
    pick: null,
    managerSpot: "safe",
    signer: loadSigner(),
    classBest: {},
  };

  els.pen.innerHTML = PEN_SVG;
  els.pen.append(h("span", { class: "pen-label" }, "펜 · 결재란에 서명하고 실행"));
  els.pen.addEventListener("click", () => void signAndRun());
  // 결재란 "승인" 칸을 직접 눌러도 서명한다.
  els.form.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).closest('[data-sign="승인"]')) void signAndRun();
  });
  mount(els.plan,
    els.pen,
    h("div", { class: "plan-bar" }, els.planBar),
    h("div", { class: "plan-body" },
      els.planTabs,
      h("div", { class: "clipboard board-left" }, els.form),
      h("aside", { class: "plan-notes", "aria-label": "메모" }, els.planNotes, els.goalNote)));

  monitor(els.monitorLeft, "left", "공정 간트", els.ganttScreen, els.osd);
  monitor(els.monitorRight, "right", "작업 현황 전경", els.rightTop, els.log, els.osdRight);
  els.hands.innerHTML = HANDS_SVG;
  els.hat.innerHTML = `${HAT_SVG}<span class="desk-label">작업모 · 현장으로</span>`;
  els.hat.addEventListener("click", goField);
  els.deskClip.addEventListener("click", () => void openPlanBoard());
  // 어두운 막(평가서를 올렸을 때, 모니터를 크게 볼 때)은 관제실 자체의 ::before/::after라 눌린 대상이 관제실이 된다.
  // 막을 누르면 크게 보던 모니터는 줄이고, 올라온 평가서는 내려 둔다.
  els.room.addEventListener("click", (e) => {
    if (e.target !== els.room) return;
    if (planUp) closePlanBoard();
    else if (state.zoomed) unzoom();
    else if (state.board === "up") {
      state.board = "down";
      drawReportBoard();
    }
  });
  els.reportBoard.addEventListener("click", (e) => {
    // 내려 둔 평가서는 아무 데나 누르면 다시 올라온다.
    if (state.board === "down" && !(e.target as HTMLElement).closest("button")) {
      state.board = "up";
      drawReportBoard();
    }
  });
  mount(els.room,
    els.plate, els.plateRight,
    // 듀얼 모니터암(가운데 기둥 하나): 기둥은 모니터 뒤로 지나가 두 모니터 사이와 아래로만 보이고, 책상에 클램프로 물린다
    h("div", { class: "monitor-arm", "aria-hidden": "true" }),
    h("div", { class: "monitors" }, els.monitorLeft, els.monitorRight),
    h("div", { class: "room-desk" }, h("div", { class: "desk-top" }), h("div", { class: "arm-clamp", "aria-hidden": "true" }), els.deskClip, els.hands, els.hat),
    els.reportBoard, els.planBoard);

  els.sceneField.append(els.trackField, els.deliveredField);
  mount(els.field, els.fieldHead, els.sceneField, els.fieldOsd);
  mount(root, els.desk, els.plan, els.room, els.field);

  document.addEventListener("keydown", onKey);
  drawForm();
  schedulePreview();
  showDesk();
  void refreshClassBest();
}

void start();
