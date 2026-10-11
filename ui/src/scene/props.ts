// 현장 3D 소품(4.9.1에 yard.ts에서 나눔): 줄(예인줄·계류줄), 예인선, 납품 배·마차, 호이스트, 로봇 팔.
// 모두 장면에 넣을 그룹을 만들어 돌려줄 뿐 상태를 모른다.

import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { mesh } from "./people";
import { shipLook } from "./ships";
import { MAT_W } from "./layout";
import { hullTris } from "./model";
import { FoldMesh, deckSheet } from "./lot";
import { label, paperMaterial } from "./util";

const CRATE_COLORS = ["#f7f3ea", "#c8553d", "#c0392b"];   // 선반 상자 뚜껑과 같은 색(종이, 물감, 깃발)
const crateTops = CRATE_COLORS.map((c) => new THREE.MeshStandardMaterial({ color: c }));
export const crateTop = (i: number) => crateTops[i] ?? crateTops[0];

/** 줄(예인줄·계류줄, 4.8.1): 가는 원기둥 두 토막이라 가운데가 조금 처진다 */
export class Rope {
  readonly root = new THREE.Group();
  private readonly parts: THREE.Mesh[];
  private static readonly UP = new THREE.Vector3(0, 1, 0);

  constructor(color: string, radius: number) {
    const geo = new THREE.CylinderGeometry(radius, radius, 1, 6);
    geo.translate(0, 0.5, 0);   // 밑동이 원점: 길이만큼 y로 늘린다
    this.parts = [0, 1].map(() => {
      const m = mesh(geo, color, { roughness: 1 });
      m.castShadow = false;
      this.root.add(m);
      return m;
    });
    this.root.visible = false;
  }

  /** a에서 b로, sag = 길이에 대한 처짐 비율 */
  set(a: THREE.Vector3, b: THREE.Vector3, sag: number): void {
    const mid = a.clone().lerp(b, 0.5);
    mid.y -= sag * a.distanceTo(b);
    this.span(this.parts[0], a, mid);
    this.span(this.parts[1], mid, b);
  }

  private span(m: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3): void {
    const d = b.clone().sub(a);
    m.position.copy(a);
    m.scale.set(1, Math.max(1e-3, d.length()), 1);
    m.quaternion.setFromUnitVectors(Rope.UP, d.normalize());
  }
}

/** 예인선 크기(배 한 척 대비)와 반 길이·갑판 높이(야드 단위) */
const TUG_K = 0.85 * 0.7;
export const TUG_HALF = 1.15 * 0.85 * TUG_K;
export const TUG_DECK = 0.4 * 1.05 * TUG_K;
const TUG_PAPER = new THREE.Color("#d9cba8");

/**
 * 조선소 예인선(4.8.1, 그림만): 진수한 배는 아직 동력이 없어 예인선 둘이 끌고 밀어 안벽에 댄다.
 * 간이공정에서 짓는 예인선(shipLook "TUG")과 같은 모양을 작게, 짓는 배와 구분되게 누런 종이로. 앞이 +x
 */
export function buildTug(): { root: THREE.Group; tag: CSS2DObject } {
  const root = new THREE.Group();
  const look = shipLook("TUG");
  const hull = new FoldMesh(hullTris(), paperMaterial(TUG_PAPER));
  hull.set(1);
  const body = new THREE.Group();
  body.add(hull.mesh, deckSheet(TUG_PAPER), ...look.parts);
  body.scale.set(...look.hull);
  const boat = new THREE.Group();
  boat.add(body);
  boat.scale.setScalar(TUG_K);
  const tag = label("예인선", "place-tag small");
  tag.position.set(0, 0.8, 0);
  tag.visible = false;
  root.add(boat, tag);
  return { root, tag };
}

export interface SupplyShip { root: THREE.Group; crates: THREE.Mesh[]; tag: CSS2DObject }

/** 해상 납품 배: 낮은 화물선(선체, 선미 조타실), 갑판에 철판(종이) 묶음 셋. 앞이 +x */
export function buildSupplyShip(): SupplyShip {
  const root = new THREE.Group();
  const hull = mesh(new THREE.BoxGeometry(3.2, 0.5, 1.1), "#3f4f5a", { roughness: 0.7 });
  hull.position.y = 0.25;
  const bow = mesh(new THREE.ConeGeometry(0.55, 0.9, 4), "#3f4f5a", { roughness: 0.7 });
  bow.rotation.set(0, Math.PI / 4, -Math.PI / 2);
  bow.scale.set(1, 1, 0.7);
  bow.position.set(2.0, 0.25, 0);
  const cabin = mesh(new THREE.BoxGeometry(0.7, 0.6, 0.8), "#e9e4d8");
  cabin.position.set(-1.2, 0.8, 0);
  root.add(hull, bow, cabin);
  const crates = [0, 1, 2].map((k) => {
    const c = mesh(new THREE.BoxGeometry(0.6, 0.18, 0.7), "#f7f3ea");
    c.position.set(-0.3 + k * 0.7, 0.6, 0);
    root.add(c);
    return c;
  });
  const tag = label("", "place-tag small");
  tag.position.set(0, 1.6, 0);
  root.add(tag);
  return { root, crates, tag };
}

/** 납품 마차: 말 한 마리와 짐수레, 자재 상자 셋. 무광 단색(장식은 절제). 앞이 +x */
export function buildSupplyCart(): { root: THREE.Group; crates: THREE.Mesh[]; tag: CSS2DObject } {
  const root = new THREE.Group();
  const horse = new THREE.Group();
  const coat = "#8a5a3b";
  const body = mesh(new THREE.BoxGeometry(0.9, 0.34, 0.3), coat);
  body.position.y = 0.58;
  const neck = mesh(new THREE.BoxGeometry(0.2, 0.42, 0.18), coat);
  neck.position.set(0.48, 0.78, 0);
  neck.rotation.z = -0.5;
  const head = mesh(new THREE.BoxGeometry(0.34, 0.16, 0.16), coat);
  head.position.set(0.66, 0.96, 0);
  const mane = mesh(new THREE.BoxGeometry(0.06, 0.4, 0.06), "#3b2a1e");
  mane.position.set(0.42, 0.84, 0);
  mane.rotation.z = -0.5;
  const tail = mesh(new THREE.BoxGeometry(0.06, 0.32, 0.06), "#3b2a1e");
  tail.position.set(-0.48, 0.5, 0);
  tail.rotation.z = 0.4;
  horse.add(body, neck, head, mane, tail);
  for (const lx of [-0.34, 0.34]) for (const lz of [-0.1, 0.1]) {
    const leg = mesh(new THREE.CylinderGeometry(0.045, 0.04, 0.42, 8), coat);
    leg.position.set(lx, 0.21, lz);
    horse.add(leg);
  }
  horse.position.x = 0.75;
  const bed = mesh(new THREE.BoxGeometry(1.1, 0.08, 0.7), "#a07e58");
  bed.position.set(-0.55, 0.36, 0);
  root.add(horse, bed);
  for (const sz of [-1, 1]) {
    const board = mesh(new THREE.BoxGeometry(1.1, 0.14, 0.04), "#8a6a4a");
    board.position.set(-0.55, 0.46, sz * 0.33);
    const wheel = mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.06, 20), "#4a3a2c");
    wheel.rotation.x = Math.PI / 2;
    wheel.position.set(-0.55, 0.26, sz * 0.4);
    const shaft = mesh(new THREE.BoxGeometry(0.9, 0.04, 0.04), "#6b4a2b");
    shaft.position.set(0.3, 0.45, sz * 0.2);
    root.add(board, wheel, shaft);
  }
  const crates = [0, 1, 2].map((k) => {
    const box = mesh(new THREE.BoxGeometry(0.28, 0.26, 0.5), "#c9a26b");
    box.position.set(-0.9 + k * 0.33, 0.53, 0);
    const top = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.02, 0.44), crateTop(k));
    top.position.y = 0.14;
    box.add(top);
    box.userData.top = top;
    root.add(box);
    return box;
  });
  const tag = label("", "place-tag small");
  tag.position.set(-0.2, 1.3, 0);
  root.add(tag);
  return { root, crates, tag };
}

/** 로봇 팔: 받침, 돌아가는 기둥, 위팔, 아래팔, 집게. 무광 회색(장식은 절제). */
/**
 * 호이스트(4.9): 정반 위 천장 크레인. 정반 앞뒤로 기둥 넷과 주행 레일 둘, 그 위를 x로 오가는 노란 거더,
 * 거더 위를 z로 오가는 트롤리와 훅. 내업 지붕(높이 1.0) 아래에 들어간다. depth = 정반 깊이
 */
export function buildHoist(depth: number): THREE.Group {
  const g = new THREE.Group();
  const H = 0.92, half = MAT_W / 2 + 0.15, zr = depth / 2 + 0.18;
  for (const z of [-zr, zr]) {
    const rail = mesh(new THREE.BoxGeometry(half * 2, 0.07, 0.07), "#5d6661");
    rail.position.set(0, H, z);
    g.add(rail);
    for (const x of [-half, half]) {
      const post = mesh(new THREE.BoxGeometry(0.06, H, 0.06), "#5d6661");
      post.position.set(x, H / 2, z);
      g.add(post);
    }
  }
  const bridge = new THREE.Group();
  const girder = mesh(new THREE.BoxGeometry(0.12, 0.09, zr * 2 + 0.1), "#e0b43a");
  girder.position.y = H + 0.08;
  const trolley = new THREE.Group();
  const carriage = mesh(new THREE.BoxGeometry(0.2, 0.08, 0.18), "#3a3f3c");
  carriage.position.y = H + 0.16;
  const cable = mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.36, 6), "#2b2b2b");
  cable.position.y = H - 0.08;
  const hook = mesh(new THREE.BoxGeometry(0.09, 0.07, 0.07), "#3a3f3c");
  hook.position.y = H - 0.28;
  trolley.add(carriage, cable, hook);
  bridge.add(girder, trolley);
  g.add(bridge);
  g.userData = { bridge, trolley, depth, working: false };
  return g;
}

export function buildRobot(): THREE.Group {
  const robot = new THREE.Group();
  const base = mesh(new THREE.CylinderGeometry(0.34, 0.4, 0.22, 32), "#7c858a");
  base.position.y = 0.11;
  const arm = new THREE.Group();                    // 기둥 위에서 좌우로 돈다
  arm.position.y = 0.22;
  const post = mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.9, 24), "#9aa3a8");
  post.position.y = 0.45;
  const fore = new THREE.Group();                   // 어깨에서 정반 쪽으로 뻗는다
  fore.position.y = 0.9;
  const upper = mesh(new THREE.BoxGeometry(1.1, 0.14, 0.14), "#b5bcc0");
  upper.position.x = 0.55;
  const hand = mesh(new THREE.BoxGeometry(0.1, 0.3, 0.2), "#5d666b");
  hand.position.set(1.1, -0.12, 0);
  fore.add(upper, hand);
  arm.add(post, fore);
  robot.add(base, arm);
  robot.userData.arm = arm;
  robot.userData.fore = fore;
  return robot;
}
