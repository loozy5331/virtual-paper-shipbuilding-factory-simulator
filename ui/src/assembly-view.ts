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
const SLOT_H = 58;          // 4.36.1: 정반 한 칸(위에서 내려다본 바닥)
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
  // 4.37: 작업장(정반)이 2곳이면 정반 칸만큼 그림을 늘린다(대기 블록 줄과 범례가 아래로 밀려도 잘리지 않게)
  const unitRows = Math.max(1, ...bst.map((b) => result.stations.find((rs) => rs.id === b.id)!.units.length));
  const H = (opts.focus ? 220 : FULL_H) + (unitRows - 1) * (SLOT_H + 6);
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
    // 작업장(정반) 칸(4.36.1, 사용자 "작업장 위쪽에서 내려다보는 자연스러움"): 위에서 본 공장 바닥.
    // 격자 철판 정반 위에 오늘 일한 블록(위에서 본 판과 보강재), 블록 가장자리에 작업자(안전모)와 용접 불꽃,
    // 정반 옆 바닥에 용접기와 케이블. 일하지 못한 날(인력 대기·중지)은 정반에 놓인 블록만 흐리게
    let craneOver: { x: number; y: number } | null = null;
    units(st.id).forEach((u, j) => {
      const y = SHOP_Y + 22 + j * (SLOT_H + 6);
      const r = day > 0 ? u.daily[today - 1] : undefined;
      // 4.39.2(사용자 "정반을 처리 가능 블록 수에 맞춰서"): 정반 하나는 한 번에 블록 하나. 정반은 블록 한 칸 크기,
      // 그 옆 바닥에 용접기, 그 오른쪽에 오늘 앞서 마친 블록(작은 칩)
      const bw = Math.min(70, Math.max(46, shopW * 0.3)), bh = SLOT_H - 22;
      const px = x0 + 10, pw = bw + 14;
      const broken = r?.state === "breakdown_stop";
      g.append(s("rect", { x: x0 + 4, y: y - 2, width: shopW - 8, height: SLOT_H + 4, rx: 3, class: "asm-bay" }),
        platen(px, y + 2, pw, SLOT_H - 4),
        s("text", { x: px + 3, y: y + 10, class: "asm-small" }, `${u.unit}호 정반`),
        welder(px + pw + 8, y + SLOT_H / 2 - 6, broken));
      if (!r) return;
      const held = blocks.filter((b) => b.station === st.id && rec(b)?.unit === u.unit
        && ["labor_wait", "accident_stop", "breakdown_stop"].includes(rec(b)!.state));
      const worked = (r.blocks ?? []).map((id) => blocks.find((x) => x.id === id)).filter((b): b is typeof blocks[number] => !!b);
      const now = worked.length ? worked[worked.length - 1] : held[0];   // 지금 정반에 놓인 블록(하루의 끝)
      const doneToday = worked.slice(0, -1);
      const working = worked.length > 0 && (r.state === "work" || r.state === "rework");
      const bx = px + 7, by = y + 14;
      if (now) {
        g.append(s("g", worked.length ? {} : { opacity: 0.45 },
          blockTop(bx, by, bw, bh, `${now.ship} ${blockLabel(st.id, now.no)}`, STATION_COLOR[st.id], STATION_TEXT[st.id], r.state === "rework" && worked.length > 0,
            worked.length ? undefined : STATE_INFO[rec(now)!.state]?.name)));
        craneOver = { x: bx + bw / 2, y: by + 4 };   // 거더는 블록 윗부분 위(이름을 가리지 않게)
      }
      if (doneToday.length) {
        const cx = px + pw + 30;
        g.append(s("text", { x: cx, y: y + 10, class: "asm-small" }, "오늘 마침"));
        doneToday.slice(0, 3).forEach((b, n) => g.append(chip(cx, y + 14 + n * (CHIP_H + 2), `${b.ship} ${blockLabel(st.id, b.no)}`,
          "#f1eee6", "#33413a", false, "오늘 마친 블록")));
      }
      // 작업자: 지금 블록의 아래·위 가장자리에 서서 용접. 재생 중이면 대기소에서 걸어온다
      for (let n = 0; n < r.workers; n++) {
        const wx = now ? bx + bw * (n === 0 ? 0.3 : 0.75) : px + pw - 10 - n * 12;
        const wy = now ? (n === 0 ? by + bh + 5 : by - 5) : y + SLOT_H / 2;
        const torch = now && working ? { x: wx, y: n === 0 ? by + bh : by } : null;
        g.append(s("g", anim("asm-walk", 0, lead, { "--dx": `${16 - wx}px`, "--dy": `${SHOP_Y + 30 - wy}px` }),
          cable(px + pw + 13, y + SLOT_H / 2, wx, wy), workerTop(wx, wy),
          torch ? spark(torch.x, torch.y, opts.animate && day > 0, n) : null));
      }
      const info = STATE_INFO[r.state];
      if (r.state !== "work" && r.state !== "rework" && r.state !== "idle" && info) {
        g.append(s("text", { x: x0 + shopW - 10, y: y + 10, class: "asm-flag end", fill: info.color }, info.name));
      }
    });
    // 천장 크레인(4.30): 공장을 가로지르는 거더와 트롤리. 오늘 일하는 블록 위에 선다
    g.append(crane(x0 + 2, x0 + shopW - 2, SHOP_Y + 22 - 4, SHOP_Y + 22 + units(st.id).length * (SLOT_H + 6) - 4, craneOver));
    // 공장 앞: 기다리는 블록(작업장 대기·자재 대기), 앞 공장에서 닿아 짝을 기다리는 블록
    const waiting = blocks.filter((b) => {
      const r2 = rec(b);
      if (!r2) return false;
      if (b.station === st.id) return r2.state === "station_wait" || r2.state === "material_wait";
      // 짝 대기는 다음 공장 앞에 놓여 있다
      const next = bst[bst.findIndex((x) => x.id === b.station) + 1];
      return next?.id === st.id && r2.state === "pair_wait";
    });
    // 적치 한도(4.35, D83): 가공 적치장에 있는 블록은 칩으로 늘어놓지 않고 수만 적는다
    const yard = waiting.filter((b) => rec(b)!.yard);
    const front = waiting.filter((b) => !rec(b)!.yard);
    g.append(s("text", { x: x0 + 4, y: queueY + 2, class: "asm-small" },
      (front.length ? `대기 ${front.length}` : "대기 없음") + (yard.length ? ` · 가공 적치장 ${yard.length}` : "")));
    front.slice(0, QUEUE_COLS * 4).forEach((b, n) => {
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
    crane(108, 128, H - 18, H - 6, { x: 118, y: H - 12 }), s("text", { x: 134, y: H - 9, class: "asm-small" }, "천장 크레인"),
    workerTop(208, H - 12), s("text", { x: 216, y: H - 9, class: "asm-small" }, "작업자"),
    spark(254, H - 12, false, 0), s("text", { x: 261, y: H - 9, class: "asm-small" }, "용접")));
  // 오른쪽 끝: PE장 블록이 끝나면 크레인이 탑재로 든다(배 단위). 오늘 탑재 중인 배
  const erecting = result.ships.filter((sh) => day > 0 && sh.daily[today - 1]?.station === "erection" && sh.daily[today - 1]?.state === "work");
  svg.append(s("text", { x: W - 8, y: H - 24, class: "asm-small end" },
    erecting.length ? `탑재 중: ${erecting.map((sh) => sh.id).join(", ")}` : "PE장 블록이 모두 끝나면 다음 날 크레인이 탑재로 든다"));
  return svg;
}

function chip(x: number, y: number, label: string, fill: string, ink: string | undefined, hatch: boolean, title?: string): SVGElement {
  return s("g", { class: "asm-chip" },
    s("title", null, title ? `${label} · ${title}` : label),
    s("rect", { x, y, width: CHIP_W, height: CHIP_H, rx: 3, fill, class: hatch ? "rework" : "" }),
    s("text", { x: x + CHIP_W / 2, y: y + CHIP_H - 4, fill: ink ?? "#fff" }, label));
}

/** 범례용 정반(작은 격자 철판) */
function plate(x: number, y: number, w: number): SVGElement {
  return platen(x, y - 3, w, 8);
}

/** 정반: 블록을 놓고 조립하는 철판 바닥. 위에서 보면 격자 무늬 */
function platen(x: number, y: number, w: number, hgt: number): SVGElement {
  const g = s("g", { class: "asm-platen" }, s("title", null, "정반(블록을 놓고 조립하는 철판 바닥)"),
    s("rect", { x, y, width: w, height: hgt, rx: 2 }));
  for (let k = 8; k < w; k += 10) g.append(s("line", { x1: x + k, x2: x + k, y1: y + 1, y2: y + hgt - 1 }));
  for (let k = 8; k < hgt; k += 10) g.append(s("line", { x1: x + 1, x2: x + w - 1, y1: y + k, y2: y + k }));
  return g;
}

/** 블록(위에서 본 모양): 공정 색 판, 안쪽 보강재 줄, 이름. 재작업이면 흰 점선 테두리 */
function blockTop(x: number, y: number, w: number, hgt: number, label: string, fill: string, ink: string | undefined, rework: boolean, title?: string): SVGElement {
  const g = s("g", { class: "asm-blk" }, s("title", null, title ? `${label} · ${title}` : label),
    s("rect", { x, y, width: w, height: hgt, rx: 1.5, fill, class: rework ? "rework" : "" }));
  for (let k = 1; k <= 3; k++) g.append(s("line", { x1: x + 3, x2: x + w - 3, y1: y + (hgt * k) / 4, y2: y + (hgt * k) / 4, class: "rib" }));
  g.append(s("text", { x: x + w / 2, y: y + hgt - 5, fill: ink ?? "#fff" }, label));
  return g;
}

/** 용접기: 바닥에 놓인 작은 상자. 고장이면 붉게 */
function welder(x: number, y: number, broken: boolean): SVGElement {
  return s("g", { class: `asm-welder${broken ? " broken" : ""}` }, s("title", null, broken ? "용접기 · 고장" : "용접기"),
    s("rect", { x, y, width: 12, height: 12, rx: 2 }),
    s("path", { d: `M${x + 4} ${y + 3} L${x + 8} ${y + 3} L${x + 5} ${y + 6} L${x + 9} ${y + 6} L${x + 6} ${y + 9}` }));
}

/** 용접기에서 작업자까지 바닥을 지나는 케이블 */
function cable(x1: number, y1: number, x2: number, y2: number): SVGElement {
  const mx = (x1 + x2) / 2;
  return s("path", { d: `M${x1} ${y1} C ${mx} ${y1 + 10}, ${mx} ${y2}, ${x2} ${y2}`, class: "asm-cable" });
}

/** 용접 불꽃: 토치가 닿은 곳의 작은 빛. 재생 중이면 깜빡인다(작업자마다 엇갈려) */
function spark(x: number, y: number, live: boolean, n: number): SVGElement {
  return s("g", { class: `asm-spark${live ? " live" : ""}`, style: live ? `animation-delay:${n * 170}ms` : "" },
    s("circle", { cx: x, cy: y, r: 2.2 }),
    s("path", { d: `M${x - 3.5} ${y} L${x + 3.5} ${y} M${x} ${y - 3.5} L${x} ${y + 3.5}` }));
}

/** 천장 크레인: 공장 양옆 레일 사이를 오가는 거더(가로 다리)와 트롤리. 일하는 블록이 있으면 그 위에 */
function crane(x1: number, x2: number, yTop: number, yBottom: number, over: { x: number; y: number } | null): SVGElement {
  const gx = over ? over.x : x1 + (x2 - x1) * 0.62;
  const g = s("g", { class: "asm-crane" }, s("title", null, "천장 크레인(블록을 들어 옮김)"),
    s("line", { x1, x2: x1, y1: yTop, y2: yBottom, class: "rail" }),
    s("line", { x1: x2, x2, y1: yTop, y2: yBottom, class: "rail" }));
  if (over) {
    g.append(s("line", { x1: x1, x2, y1: over.y, y2: over.y, class: "girder" }),
      s("rect", { x: gx - 4, y: over.y - 3, width: 8, height: 6, rx: 1, class: "trolley" }));
  }
  return g;
}

/** 작업자(위에서 본 모양): 어깨(타원)와 안전모(원). 관제실 작업 현황과 같은 모자 색 */
function workerTop(x: number, y: number): SVGElement {
  return s("g", { class: "asm-worker" },
    s("ellipse", { cx: x, cy: y, rx: 4.6, ry: 2.8, fill: "#5b6b62" }),
    s("circle", { cx: x, cy: y, r: 2.4, fill: HAT.worker }));
}

/** 작업대기소의 작업자 기호: 둥근 몸 + 고깔모자(관제실 작업 현황과 같은 익명 기호) */
function worker(x: number, y: number): SVGElement {
  return s("g", { class: "asm-worker" },
    s("circle", { cx: x, cy: y + 4, r: 4, fill: "#5b6b62" }),
    s("path", { d: `M${x - 4} ${y} L${x} ${y - 7} L${x + 4} ${y} Z`, fill: HAT.worker }));
}
