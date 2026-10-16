// 첫 화면: 책상 위에 분기마다 클립보드가 하나씩 놓여 있다(클립보드 1개 = 시나리오 1개).
// 맨 위 종이는 그 분기의 "생산계획" 표지다. 왼쪽부터 옛 분기 → 나중 분기 순이고, 나중일수록 어렵다.
// 신입이 쉬운 분기부터 하나씩 맡으며 경험을 쌓는 흐름이다. 누르면 그 클립보드를 집어 들고 생산계획서가 열린다(main.ts).
// 4.22.1(사용자): 클립보드는 가로 한 줄. 가운데 한 장을 "‹ ›" 버튼·드래그·←/→로 넘긴다. 처음은 입문(맨 왼쪽).
// 가운데가 아닌 클립보드를 누르면 먼저 가운데로 옮기고, 가운데 것을 누르면 연다.
// 4.25(D71): 사다리 밖 실습(track "drill", 블록 조립)은 맨 끝에 놓고 난이도 점 대신 "실습" 표를 단다.

import type { ClassBest, ScenarioSummary } from "./api";
import { h, mount, num } from "./dom";
import { GRADE_COLOR, GRADE_EDGE, GRADE_TEXT } from "./labels";

export interface DeskContext {
  scenarios: ScenarioSummary[];
  /** 이번 세션에서 분기마다 받은 최고 등급. 없으면 아직 맡지 않은 분기. */
  best: Record<string, { grade: string; score: number } | undefined>;
  /** 반 코드를 적었으면 그 반의 시나리오별 최고(서버 저장). */
  classCode: string;
  classBest: Record<string, ClassBest>;
  onPick(id: string, board: HTMLElement): void;
}

const LEVEL_NAME = ["", "입문", "초급", "중급", "고급", "심화", "최상"];
const CARD_W = 280;   // styles.css .desk-board 너비
const GAP = 36;       // styles.css .desk-boards gap
const DRAG_PX = 6;    // 이만큼 움직이면 클릭이 아니라 드래그

/** 가운데 클립보드. 처음은 입문(0), 반기를 골랐다 돌아오면 마지막에 고른 반기(이 페이지를 연 동안 기억) */
let deskIndex = 0;

export function renderDesk(root: HTMLElement, ctx: DeskContext): void {
  const maxLevel = Math.max(...ctx.scenarios.filter((sc) => sc.track !== "drill").map((sc) => sc.level));
  const n = ctx.scenarios.length;
  deskIndex = Math.min(deskIndex, n - 1);
  const boards: HTMLElement[] = [];
  const track = h("div", { class: "desk-boards" });
  const viewport = h("div", { class: "desk-viewport" }, track);
  const prev = h("button", { type: "button", class: "desk-nav", "aria-label": "이전 반기", onclick: () => go(deskIndex - 1) }, "‹") as HTMLButtonElement;
  const next = h("button", { type: "button", class: "desk-nav", "aria-label": "다음 반기", onclick: () => go(deskIndex + 1) }, "›") as HTMLButtonElement;
  const dots = h("div", { class: "desk-dots", role: "tablist", "aria-label": "반기" },
    ctx.scenarios.map((sc, i) => h("button", {
      type: "button", role: "tab", class: "desk-dot", "aria-label": `${sc.period} ${sc.name}`, title: `${sc.period} · ${sc.name}`,
      onclick: () => go(i),
    })));

  /** 트랙을 옮겨 가운데 클립보드를 보이는 폭의 한가운데에. dx는 드래그 중인 거리 */
  function place(dx = 0, animate = true): void {
    const center = viewport.clientWidth / 2 - (deskIndex * (CARD_W + GAP) + CARD_W / 2);
    track.style.transition = animate ? "" : "none";
    track.style.transform = `translateX(${center + dx}px)`;
  }
  function go(i: number): void {
    deskIndex = Math.max(0, Math.min(n - 1, i));
    boards.forEach((b, k) => {
      b.classList.toggle("current", k === deskIndex);
      b.tabIndex = k === deskIndex ? 0 : -1;
    });
    dots.querySelectorAll(".desk-dot").forEach((d, k) => d.setAttribute("aria-selected", String(k === deskIndex)));
    prev.disabled = deskIndex === 0;
    next.disabled = deskIndex === n - 1;
    place();
  }

  // 드래그(마우스·터치): 움직인 만큼 트랙이 따라오고, 놓으면 가까운 클립보드로. 드래그였으면 그 클릭은 버린다.
  let startX: number | null = null;
  let dragX = 0;
  let dragged = false;
  viewport.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    startX = e.clientX;
    dragX = 0;
    dragged = false;
  });
  viewport.addEventListener("pointermove", (e) => {
    if (startX === null) return;
    dragX = e.clientX - startX;
    if (!dragged && Math.abs(dragX) > DRAG_PX) {
      dragged = true;
      viewport.setPointerCapture(e.pointerId);
      viewport.classList.add("dragging");
    }
    if (dragged) place(dragX, false);
  });
  const release = (): void => {
    if (startX === null) return;
    startX = null;
    viewport.classList.remove("dragging");
    if (dragged) go(deskIndex - Math.round(dragX / (CARD_W + GAP)));
  };
  viewport.addEventListener("pointerup", release);
  viewport.addEventListener("pointercancel", release);
  viewport.addEventListener("click", (e) => {
    if (!dragged) return;
    e.stopPropagation();   // 캡처 단계에서 클립보드보다 먼저 막는다
    e.preventDefault();
    dragged = false;
  }, true);
  viewport.addEventListener("keydown", (e) => {
    const step = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : 0;
    if (!step) return;
    e.preventDefault();
    go(deskIndex + step);
    boards[deskIndex]?.focus({ preventScroll: true });
  });

  track.append(...ctx.scenarios.map((sc, i) => {
    const best = ctx.best[sc.id];
    const mix = Object.entries(sc.ship_mix).map(([name, k]) => `${name} ${k}`).join(" · ");
    const drill = sc.track === "drill";
    const board: HTMLElement = h("button", {
      class: `clipboard desk-board${drill ? " drill" : ""}`, type: "button",
      "aria-label": drill ? `실습, ${sc.name}` : `${sc.period} 생산계획, ${sc.name}, 난이도 ${sc.level}`,
      onclick: () => (i === deskIndex ? ctx.onPick(sc.id, board) : go(i)),
    },
    h("div", { class: "desk-sheet" },
      h("small", { class: "desk-org" }, "종이배 조선소"),
      h("h3", null, h("span", null, sc.period), "생산계획"),
      h("dl", { class: "desk-fields" },
        h("div", null, h("dt", null, "수주"), h("dd", null, `${sc.ships}척`, h("small", null, ` (${mix})`))),
        h("div", null, h("dt", null, "목표"), h("dd", null, `매출 ${num(sc.kpi.revenue)} · 이익 ${num(sc.kpi.profit)}`)),
        h("div", null, h("dt", null, "기간"), h("dd", null, `작업일 ${sc.days}일`))),
      h("div", { class: "desk-foot" },
        drill
          ? h("span", { class: "desk-drill", title: "난이도 사다리 밖의 실습입니다. 한 가지 개념을 따로 연습합니다." }, "실습")
          : h("span", { class: "desk-level", title: `난이도 ${sc.level} / ${maxLevel}` },
            Array.from({ length: maxLevel }, (_, k) => h("i", { class: k < sc.level ? "on" : "" })),
            h("small", null, LEVEL_NAME[sc.level] ?? `${sc.level}단계`)),
        best
          ? h("span", {
            class: "desk-stamp",
            style: { color: GRADE_TEXT[best.grade] ?? GRADE_EDGE[best.grade] ?? GRADE_COLOR[best.grade], borderColor: GRADE_EDGE[best.grade] ?? GRADE_COLOR[best.grade], background: GRADE_EDGE[best.grade] ? GRADE_COLOR[best.grade] : "transparent" },
            title: `이번 세션 최고 ${best.score.toFixed(1)}점`,
          }, best.grade)
          : null),
      ctx.classCode
        ? h("p", { class: "desk-class" }, `우리 반(${ctx.classCode}) 최고 `,
          ctx.classBest[sc.id]
            ? [h("b", null, `${ctx.classBest[sc.id].grade} ${ctx.classBest[sc.id].score.toFixed(1)}`), ` · ${ctx.classBest[sc.id].nickname}`]
            : "아직 없음")
        : null,
      // 메모: 시나리오 이름은 종이에 붙인 쪽지처럼 둔다.
      h("p", { class: "desk-memo" }, h("b", null, sc.name), " ", sc.summary)));
    boards.push(board);
    return board;
  }));

  mount(root,
    h("div", { class: "desk-intro" },
      h("small", { class: "desk-brand" }, "종이배 조선소 · 생산관리 시뮬레이터"),
      h("h2", null, "어느 반기의 생산계획을 맡을까요?"),
      h("p", null, "입문 반기부터 차례로 맡으면 좋습니다. 오른쪽으로 넘길수록 수주가 많고 판단할 것이 늘어납니다.",
        ctx.scenarios.some((sc) => sc.track === "drill") ? " 맨 끝은 한 가지 개념만 따로 연습하는 실습입니다." : "")),
    h("div", { class: "desk-carousel" }, prev, viewport, next),
    dots);
  go(deskIndex);
  // 트랙 위치는 보이는 폭에 따라 다르다: 붙인 뒤와 창 크기가 바뀔 때 다시 잰다
  requestAnimationFrame(() => place(0, false));
  new ResizeObserver(() => place(0, false)).observe(viewport);
}
