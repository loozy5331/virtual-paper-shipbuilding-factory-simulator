// 진수와 안벽(4.9.1에 yard.ts에서 나눔): 도크 물·문, 걸리버 손이 문을 잡는 자리, 예인선이 끌고 미는 배의 자리, 계류줄.
// 그림만이다(엔진 규칙 없음). yard.ts가 매 프레임 그날의 진수 목록과 이틀 안의 비율 g를 넘긴다.

import * as THREE from "three";
import type { Frame } from "./frame";
import { quayWaiting } from "./stock";
import { SEA_Y, type DockParts } from "./coast";
import { along, BAY_C, BOLLARD, bollardX, dockZ, MAT_TOP, MOUTH_X, route, ST, STATION_X } from "./layout";
import { ease } from "./model";
import type { Lot } from "./lot";
import { buildTug, Rope, TUG_DECK, TUG_HALF } from "./props";
import { phase } from "./util";


// 진수(그림만, 엔진 규칙 없음): 인도 다음 날 하루 안에 ① 작업자가 나가고 ② 도크에 물을 채우고 ③ 걸리버의 손이 문을 열고
// ④ 배가 나가고 ⑤ 문을 닫고 ⑥ 물을 뺀다. 그동안 다음 블록은 도크 앞에서 기다린다. 값은 하루 안의 비율(frac).
// 4.8.1: 갓 진수한 배는 아직 동력이 없다. 예인선 둘이 만 입구에서 들어와(come) 앞 배가 문 밖으로 끌어내고(sail),
// 앞뒤로 줄을 걸어 안벽 앞바다까지 끈 뒤(tow) 옆으로 돌아 선석에 밀어 댄다. 선석에 닿으면 계류줄을 걸고 예인선은 나간다(go).
// 4.8.2: 진수는 이틀에 걸친다. 값은 이틀 안의 비율 g = (진수 며칠째 + 하루 안의 비율) / 2. 도크 일은 첫날에 끝난다.
export const LAUNCH = { fill: [0.02, 0.1], open: [0.1, 0.16], sail: [0.16, 0.26], tow: [0.26, 0.86], close: [0.28, 0.34], drain: [0.35, 0.44] } as const;
/** 예인선이 만 입구에서 들어오고(come) 나가는(go) 때 */
export const TUG_COME = [0.01, 0.14] as const, TUG_GO = [LAUNCH.tow[1], 1] as const;
/** tow 안의 나눔: 끌기 [0, TOW_PULL), 옆으로 돌기 [TOW_PULL, TOW_PUSH), 밀어 대기 [TOW_PUSH, 1] */
export const TOW_PULL = 0.6, TOW_PUSH = 0.72;
export const DOOR_OPEN = Math.PI * 0.47;   // 문이 거의 직각으로 열린다
export const WATER_TOP = 0.32;

export interface LaunchPose {
  pos: THREE.Vector3;
  yaw: number;
  stage: "dock" | "sail" | "tow" | "turn" | "push" | "done";
  /** 그 단계 안의 진행(0~1) */
  k: number;
  /** 배가 문 밖으로 막 나온 자리와 도크 문(x) */
  out: THREE.Vector3;
  x1: number;
}

/** a에서 b로 갈 때의 뱃머리 방향(yaw, 0 = +x) */
const heading = (a: THREE.Vector3, b: THREE.Vector3) => Math.atan2(-(b.z - a.z), b.x - a.x);
/** 각도 보간(짧은 쪽으로 돈다) */
function lerpAngle(a: number, b: number, t: number): number {
  const d = Math.atan2(Math.sin(b - a), Math.cos(b - a));
  return a + d * t;
}


/**
 * 시운전 출항(4.11.2): from(선석·정박지·도크 문 밖)에서 만 입구를 지나 만 밖까지. k = 0~1.
 * 선석에 댄 배는 먼저 안벽에서 떨어진다(우현을 안벽에 댔으므로 −z로). yaw는 launchPose와 같다(0 = +x).
 */
export function departPose(from: THREE.Vector3, k: number): LaunchPose {
  const y = SEA_Y + 0.02;
  const pts = [{ x: from.x, z: from.z }];
  if (from.z > BAY_C + 2) pts.push({ x: from.x + 0.6, z: from.z - 2.2 });
  pts.push({ x: MOUTH_X - 4, z: BAY_C }, { x: MOUTH_X, z: BAY_C }, { x: MOUTH_X + 8, z: BAY_C });
  const at = along(route(pts), ease(k));
  const pos = new THREE.Vector3(at.x, y, at.z);
  return { pos, yaw: -at.angle, stage: "tow", k: 1, out: pos, x1: pos.x };
}

/** 진수 장면을 맡는다. docks는 yard.ts가 채우는 도크 배열(같은 배열을 함께 본다), lots는 배 이름 → 로트 */
export class Harbor {
  /** 진수 예인선(4.8.1): 도크마다 둘(0 = 앞에서 끄는 배, 1 = 뒤에서 잡는 배)과 예인줄 */
  private readonly tugs = [0, 1].map(() => [0, 1].map(() => buildTug()));
  private readonly towLines = [0, 1].map(() => [0, 1].map(() => new Rope("#3a3f3c", 0.03)));
  /** 계류줄(4.8.1): 선석에 댄 배마다 넷(선수줄·선미줄·앞뒤 스프링). 모자라면 늘린다 */
  private readonly moorings: Rope[][] = [];

  constructor(private readonly scene: THREE.Scene, private readonly docks: DockParts[], private readonly lots: Map<string, Lot>) {
    for (const t of this.tugs.flat()) {
      t.root.visible = false;
      scene.add(t.root);
    }
    for (const line of this.towLines.flat()) scene.add(line.root);
  }

  /** 진수 중인 도크의 물 높이와 문 각도. 진수가 없는 도크는 마른 채 닫힌다. */
  drawLaunchDocks(docking: { unit: number; g: number }[]): void {
    this.docks.forEach((dock, u) => {
      if (!dock) return;
      const launch = docking.find((l) => l.unit === u);
      const on = !!launch, frac = launch?.g ?? 0;
      const level = on ? phase(frac, LAUNCH.fill) * (1 - phase(frac, LAUNCH.drain)) : 0;
      dock.water.visible = level > 0.01;
      dock.water.scale.y = Math.max(0.01, level * WATER_TOP);
      dock.water.position.y = (level * WATER_TOP) / 2;
      const open = on ? phase(frac, [LAUNCH.open[0] + 0.025, LAUNCH.open[1]]) * (1 - phase(frac, [LAUNCH.close[0], LAUNCH.close[1] - 0.025])) : 0;
      dock.hinge.rotation.y = ease(open) * DOOR_OPEN;   // 오른쪽 끝이 바다 쪽으로 밀려 열린다(현관문)
    });
  }

  /** 걸리버의 손이 문으로 가는 정도(k)와 문 바깥 자리. 열 때와 닫을 때만 문에 붙는다. */
  gateHand(unit: number, frac: number): { at: THREE.Vector3; k: number } | null {
    const dock = this.docks[unit];
    if (!dock) return null;
    const go = phase(frac, [LAUNCH.fill[1] - 0.03, LAUNCH.open[0] + 0.02]);
    const back = phase(frac, [LAUNCH.close[1] - 0.01, LAUNCH.close[1] + 0.04]);
    const k = ease(go) * (1 - ease(back));
    const open = ease(phase(frac, [LAUNCH.open[0] + 0.025, LAUNCH.open[1]]) * (1 - phase(frac, [LAUNCH.close[0], LAUNCH.close[1] - 0.025]))) * DOOR_OPEN;
    // 문짝의 오른쪽(경첩 반대) 끝을 손바닥 자석판이 잡고 바다 쪽으로 돌려 연다. 열린 문은 배 왼쪽으로 비켜 있다.
    const len = dock.zHalf * 2 - 0.3;
    const at = new THREE.Vector3(dock.x1 + 0.25 + Math.sin(open) * len, 0.62, dock.zc - dock.zHalf + Math.cos(open) * len);
    return k > 0.001 ? { at, k } : null;
  }

  /**
   * 진수하는 배의 자리와 뱃머리 방향(yaw, 0 = +x): 도크 바닥 → 물에 떠오름 → 앞 예인선이 문 밖으로 끌어냄(sail) →
   * 앞뒤 예인선이 선석 앞바다(off)까지 끎 → 예인선이 옆으로 돌아 선석에 밀어 댐(push). 안벽에는 우현(+z)을 댄다.
   */
  launchPose(unit: number, frac: number, berth: THREE.Vector3, lot: Lot): LaunchPose {
    const dock = this.docks[unit];
    const cx = STATION_X[ST.dock], z = dockZ(unit), x1 = dock?.x1 ?? cx + 2;
    const float = phase(frac, LAUNCH.fill) * WATER_TOP;
    const inDock = new THREE.Vector3(cx, MAT_TOP + float, z);
    const out = new THREE.Vector3(x1 + lot.dims.halfLen + 0.5, SEA_Y + 0.02, z);
    const off = new THREE.Vector3(berth.x, SEA_Y + 0.02, berth.z - 2.2);
    const ts = phase(frac, LAUNCH.sail), tt = phase(frac, LAUNCH.tow);
    if (tt <= 0) return { pos: ts <= 0 ? inDock : inDock.lerp(out, ease(ts)), yaw: 0, stage: ts <= 0 ? "dock" : "sail", k: ts, out, x1 };
    if (tt < TOW_PULL) {
      // 뱃머리가 +x로 나가 +x로 들어오는 3차 베지에(양 끝 접선이 +x)
      const a = Math.max(1.5, Math.abs(off.x - out.x) * 0.45);
      const p1 = out.clone().add(new THREE.Vector3(a, 0, 0)), p2 = off.clone().sub(new THREE.Vector3(a, 0, 0));
      const u = ease(tt / TOW_PULL);
      const curve = new THREE.CubicBezierCurve3(out, p1, p2, off);
      const tan = curve.getTangent(u);
      return { pos: curve.getPoint(u), yaw: Math.atan2(-tan.z, tan.x), stage: "tow", k: u, out, x1 };
    }
    if (tt < TOW_PUSH) return { pos: off, yaw: 0, stage: "turn", k: (tt - TOW_PULL) / (TOW_PUSH - TOW_PULL), out, x1 };
    return { pos: off.lerp(berth, ease((tt - TOW_PUSH) / (1 - TOW_PUSH))), yaw: 0, stage: tt >= 1 ? "done" : "push", k: tt, out, x1 };
  }

  /**
   * 진수 예인선 둘(4.8.1): 만 입구에서 들어와 앞 배(0)는 문 밖에서 줄을 받아 끌고, 뒤 배(1)는 배가 나오면 고물에 줄을 걸어 잡는다.
   * 선석 앞바다에서 둘 다 좌현 쪽으로 돌아 뱃머리로 밀어 댄 뒤 만 입구로 나간다. 진수가 없는 도크는 숨긴다.
   */
  drawTugs(unit: number, towed: { lot: Lot; pose: LaunchPose; g: number } | null): void {
    const tugs = this.tugs[unit], lines = this.towLines[unit];
    const g = towed?.g ?? 0;
    const come = phase(g, TUG_COME), go = phase(g, TUG_GO);
    const on = !!towed && come > 0 && go < 1;
    tugs.forEach((t) => { t.root.visible = on; });
    lines.forEach((l) => { l.root.visible = false; });
    if (!towed || !on) return;
    const { lot, pose } = towed;
    const { halfLen, halfW, deck } = lot.dims;
    const fwd = (yaw: number) => new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const y = SEA_Y + 0.02;
    // 끄는 자리: 앞 배는 뱃머리 앞, 뒤 배는 고물 뒤(뱃머리를 배와 같은 쪽으로)
    const towAt = (pos: THREE.Vector3, yaw: number, i: number) =>
      pos.clone().setY(y).addScaledVector(fwd(yaw), i === 0 ? halfLen + 0.9 + TUG_HALF : -(halfLen + 0.7 + TUG_HALF));
    // 미는 자리: 좌현(-z)에 앞뒤로 하나씩, 뱃머리를 배 쪽(+z)으로
    const pushAt = (pos: THREE.Vector3, i: number) => new THREE.Vector3(pos.x + (i === 0 ? 0.45 : -0.45) * halfLen, y, pos.z - halfW - TUG_HALF * 0.95);
    const PUSH_YAW = -Math.PI / 2;
    // 문이 열리는 동안 문짝에 걸리지 않게 앞 배는 문에서 떨어져 기다린다
    const leadWait = new THREE.Vector3(pose.x1 + 2.4 + TUG_HALF, y, pose.out.z);
    const rearWait = new THREE.Vector3(pose.out.x + 0.4, y, pose.out.z - 2.2);
    const exit = (i: number) => new THREE.Vector3(MOUTH_X + 4, y, BAY_C + (i === 0 ? -0.9 : 0.9));
    tugs.forEach((tug, i) => {
      let at: THREE.Vector3, yaw: number, line = false;
      const wait = i === 0 ? leadWait : rearWait;
      if (go > 0) {
        // 선석에서 만 입구로(뱃머리를 가는 쪽으로 돌리며)
        const from = pushAt(pose.pos, i), to = exit(i);
        at = from.clone().lerp(to, ease(go));
        yaw = lerpAngle(PUSH_YAW, heading(from, to), Math.min(1, go * 4));
      } else if (pose.stage === "dock" || pose.stage === "sail" || come < 1) {
        // 만 입구에서 문 앞 기다리는 자리로. 앞 배는 배가 나오면 줄이 팽팽해지는 만큼 앞서 간다
        const from = exit(i);
        at = from.clone().lerp(wait, ease(come));
        yaw = come < 1 ? lerpAngle(heading(from, wait), 0, phase(come, [0.8, 1])) : 0;
        if (i === 0 && pose.stage === "sail") {
          const pull = towAt(pose.pos, 0, 0);
          if (pull.x > at.x) at = pull;
          line = true;
        }
      } else if (pose.stage === "tow") {
        // 뒤 배는 tow 처음에 고물 뒤로 붙는다
        const k = i === 0 ? 1 : ease(Math.min(1, pose.k / 0.2));
        at = wait.clone().lerp(towAt(pose.pos, pose.yaw, i), k);
        yaw = lerpAngle(0, pose.yaw, k);
        line = k > 0.9;
      } else {
        // 옆으로 돌아 좌현에 붙고(turn), 밀어 댄다(push·done)
        const k = pose.stage === "turn" ? ease(pose.k) : 1;
        at = towAt(pose.pos, 0, i).lerp(pushAt(pose.pos, i), k);
        yaw = lerpAngle(0, PUSH_YAW, k);
      }
      tug.root.position.copy(at);
      tug.root.rotation.set(0, yaw, 0);
      if (!line) return;
      // 예인줄: 배의 뱃머리(앞 배)·고물(뒤 배)에서 예인선의 말뚝(고물)·뱃머리로
      const ship = pose.pos.clone().addScaledVector(fwd(pose.yaw), (i === 0 ? 1 : -1) * halfLen * 0.92).setY(pose.pos.y + deck + 0.04);
      const end = at.clone().addScaledVector(fwd(yaw), (i === 0 ? -1 : 1) * TUG_HALF * 0.6).setY(y + TUG_DECK + 0.04);
      lines[i].set(ship, end, 0.03);
      lines[i].root.visible = true;
    });
    tugs[0].tag.visible = on;
  }

  /**
   * 계류줄(4.8.1): 선석에 댄 배(안벽의장 중이거나 차례를 기다리는 배)는 우현에서 안벽 계선주로 줄 넷을 건다.
   * 선수줄·선미줄은 바깥쪽으로, 스프링 둘은 배 가운데에서 서로 엇갈려 앞뒤로 밀리지 않게 잡는다. 정박지에 닻을 내린 배와 예인 중인 배는 없다.
   */
  drawMoorings(f: Frame, launching: { ship: string; g: number }[]): void {
    const waiting = quayWaiting(f);
    const moored = f.lots.filter((view) => {
      if (!this.lots.get(view.ship)?.group.visible) return false;
      const atBerth = (view.place === "bench" && view.station === ST.quay)
        || ((view.place === "queue" || view.place === "outbound") && view.station >= ST.quay && waiting.get(view.ship)?.anchored === false);
      const towing = launching.some((l) => l.ship === view.ship && l.g < LAUNCH.tow[1]);
      return atBerth && !towing;
    });
    while (this.moorings.length < moored.length) {
      const set = [0, 1, 2, 3].map(() => new Rope("#6b4f2a", 0.045));
      for (const r of set) this.scene.add(r.root);
      this.moorings.push(set);
    }
    this.moorings.forEach((set, n) => {
      const view = moored[n];
      set.forEach((r) => { r.root.visible = !!view; });
      if (!view) return;
      const lot = this.lots.get(view.ship)!;
      const p = lot.group.position, { halfLen: L, halfW, deck } = lot.dims;
      const onShip = (dx: number) => new THREE.Vector3(p.x + dx, p.y + deck + 0.02, p.z + halfW * 0.9);
      const post = (x: number) => new THREE.Vector3(bollardX(x), BOLLARD.top - 0.02, BOLLARD.z);
      // [배 위 자리, 계선주를 찾을 x]: 선수줄, 선미줄, 앞 스프링(뒤로), 뒤 스프링(앞으로)
      const lines: [number, number][] = [[0.85 * L, L + 0.8], [-0.85 * L, -L - 0.8], [0.35 * L, -0.3 * L], [-0.35 * L, 0.3 * L]];
      lines.forEach(([from, to], k) => set[k].set(onShip(from), post(p.x + to), 0.05));
    });
  }
}
