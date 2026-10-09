// 소인국 해안 조선소(2.1): 바다에 붙은 조선소를 단순하게 옮긴 배경. 거제 옥포 조선소의 특징을 참고했다
// (바다로 열린 드라이 도크, 도크에 걸친 골리앗 크레인, 도크 옆 블록 공장, 뒷산). 회사 이름·로고는 넣지 않는다.
//
//   골리앗 크레인은 하늘에서 수직으로 내려오는 걸리버의 팔과 손(벙어리장갑 + 손바닥 자석판). 몸은 아직 그리지 않는다
//   (오른쪽에 머리를 두고 누운 걸리버가 화면 밖에서 팔만 뻗은 것처럼 보이게 하려는 것, D29).
//   작업장마다: 소조립·중조립은 벽만 있는 공장(지붕 없음, 앞은 열림), 대조립은 바깥 정반(노란 구획선), 탑재는 바다 쪽 문이 달린 드라이 도크.
//   물류창고 구역은 자재 선반을 벽으로 묶는다. 인도한 배는 오른쪽 바다(안벽 앞)에 뜬다.
// 규칙은 그대로다. 그림만 바뀐다.

import * as THREE from "three";
import { mesh } from "./people";

export const SEA_Y = -0.32;
export const SHORE_X = 11.2;      // 오른쪽 안벽(이 너머가 바다)

const CONCRETE = "#c9c5bb";
const WALL = "#d9ddd8";
const WALL_BASE = "#7d8a83";

// 만(灣): 야드 오른쪽(SHORE_X 너머)만 바다다. 산은 ㄷ자로 둘러싸고(뒤·왼쪽·앞), 오른쪽 두 끝을 안쪽으로 굽혀 곶을 만든다.
// 뒤쪽 곶 끝에 등대. 곶 사이 물길(BAY_MOUTH)은 막지 않는다.
const BAY_Z = 10;            // 만의 폭(±)
const MOUTH_X = 23.5;        // 곶 끝의 x(전경에서 등대가 보이게)
const BAY_MOUTH = 3.5;       // 곶 사이 물길 반폭

export const YARD_X0 = -21;       // 야드 왼쪽 끝

/** 땅(포장된 야드 + 풀밭), 만의 바다, ㄷ자 산, 곶과 등대. */
export function buildLand(scene: THREE.Scene): void {
  const ground = (x0: number, x1: number, z0: number, z1: number, color: string, y = -0.5) => {
    const m = mesh(new THREE.BoxGeometry(x1 - x0, 1, z1 - z0), color, { roughness: 1 });
    m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
    m.castShadow = false;
    scene.add(m);
  };
  // 포장된 야드(밝은 콘크리트)와 둘레 풀밭. 오른쪽 만만 비운다.
  ground(YARD_X0, SHORE_X, -14, 9, CONCRETE);
  ground(-80, YARD_X0, -80, 80, "#93ab7c", -0.52);
  ground(YARD_X0, SHORE_X, -80, -14, "#93ab7c", -0.52);
  ground(YARD_X0, SHORE_X, 9, 80, "#93ab7c", -0.52);
  ground(SHORE_X, 80, -80, -BAY_Z, "#93ab7c", -0.52);
  ground(SHORE_X, 80, BAY_Z, 80, "#93ab7c", -0.52);
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(300, 300),
    new THREE.MeshStandardMaterial({ color: "#3f6f8c", roughness: 0.25, metalness: 0.05 }));
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = SEA_Y;
  sea.receiveShadow = true;
  scene.add(sea);

  const hill = (x: number, z: number, rx: number, h: number, rz: number, color: string) => {
    const m = mesh(new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), color, { roughness: 1, flatShading: true });
    m.scale.set(rx, h, rz);
    m.position.set(x, -0.5, z);
    m.castShadow = false;
    scene.add(m);
  };
  const greens = ["#7f9a6b", "#87a173", "#7b9667", "#8aa476", "#90a97c"];
  // ㄷ자: 뒤(멀리, 크게), 왼쪽, 앞(카메라 뒤라 거의 안 보임)
  for (let k = 0; k < 7; k++) hill(-34 + k * 12, -34 - (k % 2) * 3, 11, 8 + (k % 3) * 2, 7, greens[k % greens.length]);
  for (let k = 0; k < 5; k++) hill(-34 - (k % 2) * 2, -20 + k * 12, 7, 6 + (k % 2) * 2, 9, greens[(k + 2) % greens.length]);
  for (let k = 0; k < 6; k++) hill(-28 + k * 13, 34 + (k % 2) * 2, 10, 6, 6, greens[(k + 1) % greens.length]);
  // 오른쪽 두 팔: 만을 따라 뻗다가 끝에서 안쪽으로 굽는다(곶). 물길은 남긴다.
  for (const side of [-1, 1]) {
    hill(17, side * (BAY_Z + 6), 8, 5, 5, greens[2]);
    hill(MOUTH_X + 1, side * (BAY_Z + 2), 5, 3.6, 5, greens[3]);
    hill(MOUTH_X, side * (BAY_MOUTH + 3.2), 2.6, 2.2, 3.2, greens[4]);   // 곶 끝
  }
  // 등대: 뒤쪽 곶 끝(카메라에서 보이는 쪽)
  const tower = mesh(new THREE.CylinderGeometry(0.45, 0.6, 3.2, 20), "#f4f1ea");
  tower.position.set(MOUTH_X, 2.6, -(BAY_MOUTH + 2.6));
  const band = mesh(new THREE.CylinderGeometry(0.5, 0.53, 0.5, 20), "#b8322d");
  band.position.set(MOUTH_X, 3.0, -(BAY_MOUTH + 2.6));
  const lamp = mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.5, 16), "#ffe9a8", { emissive: "#ffcf66", emissiveIntensity: 0.6 });
  lamp.position.set(MOUTH_X, 4.45, -(BAY_MOUTH + 2.6));
  const cap = mesh(new THREE.ConeGeometry(0.55, 0.6, 16), "#b8322d");
  cap.position.set(MOUTH_X, 5.0, -(BAY_MOUTH + 2.6));
  scene.add(tower, band, lamp, cap);
}

/** 벽만 있는 작업장(지붕 없음, 앞은 열림): 뒷벽과 양옆 벽. */
export function buildWalls(x0: number, x1: number, z0: number, z1: number, height: number): THREE.Group {
  const g = new THREE.Group();
  const t = 0.14;
  const walls = [
    { w: x1 - x0, d: t, x: (x0 + x1) / 2, z: z0 },
    { w: t, d: z1 - z0, x: x0, z: (z0 + z1) / 2 },
    { w: t, d: z1 - z0, x: x1, z: (z0 + z1) / 2 },
  ];
  for (const w of walls) {
    const panel = mesh(new THREE.BoxGeometry(w.w, height, w.d), WALL, { roughness: 0.9 });
    panel.position.set(w.x, height / 2, w.z);
    const base = mesh(new THREE.BoxGeometry(w.w + 0.01, 0.22, w.d + 0.01), WALL_BASE, { roughness: 0.9 });
    base.position.set(w.x, 0.11, w.z);
    g.add(panel, base);
  }
  return g;
}

/** 바깥 정반: 바닥의 노란 구획선. */
export function buildYardLines(x0: number, x1: number, z0: number, z1: number, color = "#e0b43a"): THREE.Group {
  const g = new THREE.Group();
  const line = (w: number, d: number, x: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.012, d), new THREE.MeshStandardMaterial({ color, roughness: 0.8 }));
    m.position.set(x, 0.006, z);
    m.receiveShadow = true;
    g.add(m);
  };
  line(x1 - x0, 0.08, (x0 + x1) / 2, z0);
  line(x1 - x0, 0.08, (x0 + x1) / 2, z1);
  line(0.08, z1 - z0, x0, (z0 + z1) / 2);
  line(0.08, z1 - z0, x1, (z0 + z1) / 2);
  return g;
}

/** 드라이 도크: 콘크리트 테두리와 바다 쪽 문(캐슨). */
/** 진수 장면에 쓰는 도크 부품 */
export interface DockParts { hinge: THREE.Group; water: THREE.Mesh; x0: number; x1: number; zc: number; zHalf: number }

export function buildDock(x0: number, x1: number, z0: number, z1: number): THREE.Group {
  const g = new THREE.Group();
  const rim = (w: number, d: number, x: number, z: number, color = CONCRETE) => {
    const m = mesh(new THREE.BoxGeometry(w, 0.32, d), color, { roughness: 1 });
    m.position.set(x, 0.16, z);
    g.add(m);
  };
  rim(x1 - x0, 0.3, (x0 + x1) / 2, z0);
  rim(x1 - x0, 0.3, (x0 + x1) / 2, z1);
  rim(0.3, z1 - z0, x0, (z0 + z1) / 2);
  // 바다 쪽 문(캐슨): 어두운 강철 문짝. 위쪽 모서리를 축으로 아래쪽이 바다 쪽으로 열린다(진수, 그림만).
  const hinge = new THREE.Group();
  hinge.position.set(x1, 0.45, (z0 + z1) / 2);
  const gate = mesh(new THREE.BoxGeometry(0.4, 0.5, z1 - z0 - 0.3), "#4e5a63", { metalness: 0.3, roughness: 0.6 });
  gate.position.set(0, -0.25, 0);
  hinge.add(gate);
  g.add(hinge);
  // 도크 안 물: 진수 때만 차오른다
  const water = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0 - 0.3, 1, z1 - z0 - 0.3),
    new THREE.MeshStandardMaterial({ color: "#4f86a8", roughness: 0.2, transparent: true, opacity: 0.7 }));
  water.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
  water.visible = false;
  g.add(water);
  g.userData.dock = { hinge, water, x0, x1, zc: (z0 + z1) / 2, zHalf: (z1 - z0 - 0.3) / 2 };
  return g;
}

/**
 * 골리앗 크레인 = 걸리버의 손: 하늘에서 수직으로 내려오는 팔과 벙어리장갑, 손바닥 아래 둥근 자석판(블록이 붙어 들린다).
 * 탑재를 가까이 보면 손이 화면 위쪽 변에서 곧게 내려온다. 손은 크레인 훅 자리를 따라간다.
 */
export class GiantHand {
  readonly root = new THREE.Group();
  readonly hand = new THREE.Group();
  private readonly arm: THREE.Mesh;
  private static readonly TOP = 40;   // 팔이 끝나는 높이(화면 밖)
  private static readonly SCALE = 0.72;

  constructor() {
    this.arm = mesh(new THREE.CapsuleGeometry(0.62, 1, 6, 16), "#34495e");
    const mitten = mesh(new THREE.SphereGeometry(0.9, 20, 14), "#c9b79a");
    mitten.scale.set(1.15, 1.2, 0.8);
    const thumb = mesh(new THREE.CapsuleGeometry(0.28, 0.5, 6, 10), "#c9b79a");
    thumb.position.set(0.95, 0.1, 0);
    thumb.rotation.z = -0.5;
    const cuff = mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.35, 18), "#e9e4d8");
    cuff.position.y = 1.05;
    const magnet = mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.14, 28), "#6f7a82", { metalness: 0.6, roughness: 0.35 });
    magnet.position.y = -1.05;
    this.hand.add(mitten, thumb, cuff, magnet);
    this.hand.scale.setScalar(GiantHand.SCALE);
    this.root.add(this.arm, this.hand);
    this.place(new THREE.Vector3(8.5, 3, 0));
  }

  /** 손(자석판 바닥)을 이 자리로. 팔은 손목에서 하늘까지 수직. */
  place(magnetBottom: THREE.Vector3): void {
    const k = GiantHand.SCALE;
    this.hand.position.set(magnetBottom.x, magnetBottom.y + 1.12 * k, magnetBottom.z);
    const wrist = this.hand.position.clone().setY(this.hand.position.y + 1.2 * k);
    const top = wrist.clone().setY(GiantHand.TOP);
    const len = top.y - wrist.y;
    this.arm.position.set(wrist.x, wrist.y + len / 2, wrist.z);
    this.arm.scale.set(1, len / (1 + 2 * 0.62), 1);
  }
}
