// 관제실 오른쪽 모니터 [조립 공정] 탭(4.25, D71): 블록 조립 실습에서 내업 조립 공장 세 칸(소조립 → 중조립 → PE장)의 안.
// 공장마다 작업장(정반) 칸에 오늘 일하는 블록과 작업자, 공장 앞에 기다리는 블록, 공장 사이 길에 운반 중인 블록,
// 왼쪽에 작업대기소. 공정마다 다른 디자인은 하지 않는다(사용자: 필수 아님). 엔진 결과(블록·작업장·트랜스포터의 하루 기록)를 옮겨 그리기만 한다.
// 이 탭만 하루 안에서 움직인다(D71 예외): 재생 중이면 하루의 앞 30%(LEAD_IN) 동안 작업자가 대기소에서 정반으로 걷고,
// 그 뒤 운반 블록이 트랜스포터에 실려 다음 공장으로 간다(CSS 애니메이션, 길이는 하루의 재생 시간). 멈춰 있으면 끝난 모습.

import { blockLabel, blockStations, type Result, type Scenario } from "./api";
import { s } from "./dom";
import { HAT, STATE_INFO, STATION_COLOR, STATION_TEXT } from "./labels";
import { LEAD_IN } from "./scene/frame";

const FULL_W = 640;
const FULL_H = 300;
const POOL_W = 70;          // 왼쪽 작업대기소
const SHOP_Y = 46;          // 공장 위쪽
const SLOT_H = 40;
const CHIP_W = 52;
const CHIP_H = 14;
const QUEUE_COLS = 3;

export interface AssemblyViewOptions {
  /** 재생 중이면 하루 안의 움직임을 보인다 */
  animate: boolean;
  msPerDay: number;
  /** 4.32: 작업장 단계(브레드크럼 "소조립 작업장1"): 그 공정 공장 하나만 화면 가득 */
  focus?: string;
}

export function renderAssemblyView(result: Result, scenario: Scenario, day: number, opts: AssemblyViewOptions): SVGElement {
  const bst = blockStations(scenario).filter((b) => !opts.focus || b.id === opts.focus);
  // 작업장 단계는 같은 그림을 좁은 화면 틀로 그려 확대해 보인다(카메라가 다가간 것처럼)
  const W = opts.focus ? 400 : FULL_W;
  const H = opts.focus ? 220 : FULL_H;
  const blocks = result.blocks ?? [];
  const today = Math.max(1, day);
  const rec = (b: typeof blocks[number]) => b.daily[today - 1];
  const shopW = (W - POOL_W - 20 - (bst.length - 1) * 34) / bst.length;
  const shopX = (k: number) => POOL_W + 14 + k * (shopW + 34);
  const units = (sid: string) => result.stations.find((rs) => rs.id === sid)!.units;
  const maxUnits = Math.max(...bst.map((b) => units(b.id).length));
  const queueY = SHOP_Y + 20 + maxUnits * (SLOT_H + 6) + 18;
  const lead = Math.round(opts.msPerDay * LEAD_IN);
  const move = Math.round(opts.msPerDay * (1 - LEAD_IN));
  const anim = (name: string, delay: number, dur: number, vars: Record<string, string>) =>
    opts.animate && day > 0 ? { class: name, style: `animation-delay:${delay}ms;animation-duration:${dur}ms;${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(";")}` } : {};

  const svg = s("svg", { class: "asm-view", viewBox: `0 0 ${W} ${H}`, role: "img",
    "aria-label": `조립 공정 ${day}일: 소조립·중조립·PE장의 작업장 블록, 대기 블록, 운반 블록` });
  // 작업대기소(왼쪽): 오늘 조립 직종 인원 중 쉬는 사람
  const wf = result.workforce.daily[today - 1];
  const idle = day > 0 ? (wf?.trades?.assembly?.idle ?? 0) : (result.workforce.pools?.assembly ?? 0);
  svg.append(s("rect", { x: 6, y: SHOP_Y, width: POOL_W - 6, height: 70, rx: 6, class: "asm-pool" }),
    s("text", { x: 6 + (POOL_W - 6) / 2, y: SHOP_Y + 14, class: "asm-cap" }, "작업대기소"),
    s("text", { x: 6 + (POOL_W - 6) / 2, y: SHOP_Y + 56, class: "asm-small mid" }, "쉬는 조립"),
    s("text", { x: 6 + (POOL_W - 6) / 2, y: SHOP_Y + 66, class: "asm-small mid" }, `${idle}명`));
  for (let k = 0; k < Math.min(idle, 8); k++) svg.append(worker(16 + (k % 4) * 13, SHOP_Y + 26 + Math.floor(k / 4) * 14));

  bst.forEach((st, k) => {
    const x0 = shopX(k);
    const g = s("g", { class: "asm-shop" });
    g.append(s("rect", { x: x0, y: SHOP_Y, width: shopW, height: queueY - SHOP_Y - 8, rx: 6, class: "asm-shop-box" }),
      s("rect", { x: x0, y: SHOP_Y, width: shopW, height: 16, rx: 6, fill: STATION_COLOR[st.id] }),
      s("text", { x: x0 + 8, y: SHOP_Y + 12, class: "asm-shop-name", fill: STATION_TEXT[st.id] ?? "#fff" }, `${st.name} · 블록 ${st.count}`));
    // 작업장(정반) 칸: 오늘 일한 블록과 작업자
    units(st.id).forEach((u, j) => {
      const y = SHOP_Y + 22 + j * (SLOT_H + 6);
      const r = day > 0 ? u.daily[today - 1] : undefined;
      g.append(s("rect", { x: x0 + 6, y, width: shopW - 12, height: SLOT_H, rx: 4, class: "asm-slot" }),
        // 설비(4.30): 정반(블록을 놓는 철판 바닥)과 용접기. 고장 중이면 붉게
        plate(x0 + 9, y + SLOT_H - 7, shopW - 50),
        welder(x0 + 48, y + 3, r?.state === "breakdown_stop"),
        s("text", { x: x0 + 10, y: y + 11, class: "asm-small" }, `${u.unit}호 정반`));
      if (!r) return;
      // 일한 블록(이어 하기로 여럿). 일하지 못한 날(인력 대기·중지)은 정반에 들어가 있는 블록을 흐리게
      const held = blocks.filter((b) => b.station === st.id && rec(b)?.unit === u.unit
        && ["labor_wait", "accident_stop", "breakdown_stop"].includes(rec(b)!.state));
      held.slice(0, 1).forEach((b) => g.append(s("g", { opacity: 0.45 },
        chip(x0 + 10, y + 16, `${b.ship} ${blockLabel(st.id, b.no)}`, STATION_COLOR[st.id], STATION_TEXT[st.id], false, STATE_INFO[rec(b)!.state]?.name))));
      const ids = r.blocks ?? [];
      ids.slice(0, 3).forEach((id, n) => {
        const b = blocks.find((x) => x.id === id);
        if (!b) return;
        g.append(chip(x0 + 10 + n * (CHIP_W + 4), y + 16, `${b.ship} ${blockLabel(st.id, b.no)}`, STATION_COLOR[st.id], STATION_TEXT[st.id], r.state === "rework"));
      });
      // 작업자: 대기소에서 정반으로 걸어온다(재생 중, 하루의 앞 30%)
      for (let n = 0; n < r.workers; n++) {
        const wx = x0 + shopW - 22 - n * 12;
        const wy = y + 30;
        g.append(s("g", anim("asm-walk", 0, lead, { "--dx": `${16 - wx}px`, "--dy": `${SHOP_Y + 30 - wy}px` }), worker(wx, wy)));
      }
      const info = STATE_INFO[r.state];
      if (r.state !== "work" && r.state !== "rework" && r.state !== "idle" && info) {
        g.append(s("text", { x: x0 + shopW - 10, y: y + 11, class: "asm-flag", fill: info.color }, info.name));
      }
    });
    // 천장 크레인(4.30): 공장을 가로지르는 레일과 트롤리. 오늘 일한 첫 정반 위에 갈고리를 내린다
    const workingAt = units(st.id).findIndex((u) => day > 0 && ["work", "rework"].includes(u.daily[today - 1]?.state));
    g.append(crane(x0 + 4, x0 + shopW - 4, SHOP_Y + 19, workingAt < 0 ? null : SHOP_Y + 22 + workingAt * (SLOT_H + 6) + 14, x0 + shopW * 0.62));
    // 공장 앞: 기다리는 블록(작업장 대기·자재 대기), 앞 공장에서 닿아 짝을 기다리는 블록
    const waiting = blocks.filter((b) => {
      const r2 = rec(b);
      if (!r2) return false;
      if (b.station === st.id) return r2.state === "station_wait" || r2.state === "material_wait";
      // 짝 대기는 다음 공장 앞에 놓여 있다
      const next = bst[bst.findIndex((x) => x.id === b.station) + 1];
      return next?.id === st.id && r2.state === "pair_wait";
    });
    g.append(s("text", { x: x0 + 4, y: queueY + 2, class: "asm-small" }, waiting.length ? `대기 ${waiting.length}` : "대기 없음"));
    waiting.slice(0, QUEUE_COLS * 4).forEach((b, n) => {
      const cx = x0 + 4 + (n % QUEUE_COLS) * (CHIP_W + 2);
      const cy = queueY + 8 + Math.floor(n / QUEUE_COLS) * (CHIP_H + 3);
      const pair = rec(b)!.state === "pair_wait";
      g.append(chip(cx, cy, `${b.ship} ${blockLabel(b.station, b.no)}`, pair ? "#e6e1d4" : "#f1eee6", "#33413a", false, pair ? "짝 대기" : STATE_INFO[rec(b)!.state]?.name));
    });
    svg.append(g);

    // 공장 사이 길: 오늘 운반한 블록은 이 공장에서 다음 공장으로 움직인다, 운반 대기는 길 입구에
    if (k < bst.length - 1) {
      const lx = x0 + shopW;
      const ly = SHOP_Y + 40;
      svg.append(s("line", { x1: lx + 2, x2: lx + 32, y1: ly, y2: ly, class: "asm-lane" }),
        s("path", { d: `M${lx + 28} ${ly - 4} L${lx + 33} ${ly} L${lx + 28} ${ly + 4}`, class: "asm-lane" }));
      const moving = blocks.filter((b) => b.station === st.id && rec(b)?.state === "transport");
      const waitTr = blocks.filter((b) => b.station === st.id && rec(b)?.state === "transport_wait");
      moving.slice(0, 4).forEach((b, n) => {
        const fromX = lx - CHIP_W - 4;
        const toX = shopX(k + 1) + 6;
        const cy = ly + 8 + n * (CHIP_H + 2);
        // 끝난 모습(도착)에 그리고, 재생 중이면 출발 자리에서 다가온다
        svg.append(s("g", anim("asm-carry", lead, move, { "--dx": `${fromX - toX}px` }),
          chip(toX, cy, `${b.ship} ${blockLabel(b.station, b.no)}`, STATION_COLOR[st.id], STATION_TEXT[st.id], false, "운반")));
      });
      if (waitTr.length) {
        svg.append(s("text", { x: lx + 17, y: SHOP_Y - 6, class: "asm-flag mid", fill: STATE_INFO.transport_wait.color }, `운반 대기 ${waitTr.length}`));
      }
    }
  });

  // 설비 범례
  svg.append(s("g", { class: "asm-legend" },
    plate(8, H - 14, 16), s("text", { x: 28, y: H - 9, class: "asm-small" }, "정반"),
    welder(58, H - 18, false), s("text", { x: 72, y: H - 9, class: "asm-small" }, "용접기"),
    crane(110, 130, H - 16, H - 8, 120), s("text", { x: 134, y: H - 9, class: "asm-small" }, "천장 크레인")));
  // 오른쪽 끝: PE장 블록이 끝나면 크레인이 탑재로 든다(배 단위). 오늘 탑재 중인 배
  const erecting = result.ships.filter((sh) => day > 0 && sh.daily[today - 1]?.station === "erection" && sh.daily[today - 1]?.state === "work");
  svg.append(s("text", { x: W - 8, y: H - 10, class: "asm-small end" },
    erecting.length ? `탑재 중: ${erecting.map((sh) => sh.id).join(", ")}` : "PE장 블록이 모두 끝나면 다음 날 크레인이 탑재로 든다"));
  return svg;
}

function chip(x: number, y: number, label: string, fill: string, ink: string | undefined, hatch: boolean, title?: string): SVGElement {
  return s("g", { class: "asm-chip" },
    s("title", null, title ? `${label} · ${title}` : label),
    s("rect", { x, y, width: CHIP_W, height: CHIP_H, rx: 3, fill, class: hatch ? "rework" : "" }),
    s("text", { x: x + CHIP_W / 2, y: y + CHIP_H - 4, fill: ink ?? "#fff" }, label));
}

/** 정반: 블록을 놓고 조립하는 철판 바닥(줄무늬) */
function plate(x: number, y: number, w: number): SVGElement {
  const g = s("g", { class: "asm-plate" }, s("title", null, "정반"), s("rect", { x, y, width: w, height: 4, rx: 1 }));
  for (let k = 6; k < w; k += 8) g.append(s("line", { x1: x + k, x2: x + k, y1: y, y2: y + 4 }));
  return g;
}

/** 용접기: 작은 상자와 케이블. 고장이면 붉게 */
function welder(x: number, y: number, broken: boolean): SVGElement {
  return s("g", { class: `asm-welder${broken ? " broken" : ""}` }, s("title", null, broken ? "용접기 · 고장" : "용접기"),
    s("rect", { x, y, width: 10, height: 7, rx: 1.5 }),
    s("path", { d: `M${x + 3} ${y + 2} L${x + 6} ${y + 2} L${x + 4} ${y + 4} L${x + 7} ${y + 4}` }),
    s("path", { d: `M${x + 10} ${y + 5} q 5 2 3 8`, class: "cable" }));
}

/** 천장 크레인: 레일, 트롤리, 갈고리(hookY가 있으면 그 높이까지 줄을 내린다) */
function crane(x1: number, x2: number, y: number, hookY: number | null, tx: number): SVGElement {
  const g = s("g", { class: "asm-crane" }, s("title", null, "천장 크레인(블록을 들어 옮김)"),
    s("line", { x1, x2, y1: y, y2: y, class: "rail" }),
    s("rect", { x: tx - 5, y: y - 3, width: 10, height: 5, rx: 1 }));
  if (hookY !== null) g.append(s("line", { x1: tx, x2: tx, y1: y + 2, y2: hookY, class: "rope" }), s("path", { d: `M${tx - 2} ${hookY} q 2 4 4 0`, class: "rope" }));
  return g;
}

/** 작업자 기호: 둥근 몸 + 고깔모자(관제실 작업 현황과 같은 익명 기호) */
function worker(x: number, y: number): SVGElement {
  return s("g", { class: "asm-worker" },
    s("circle", { cx: x, cy: y + 4, r: 4, fill: "#5b6b62" }),
    s("path", { d: `M${x - 4} ${y} L${x} ${y - 7} L${x + 4} ${y} Z`, fill: HAT.worker }));
}
