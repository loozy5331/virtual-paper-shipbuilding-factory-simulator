// 소인국 해안 조선소(2.1): 바다에 붙은 조선소를 단순하게 옮긴 배경. 거제 옥포 조선소의 특징을 참고했다
// (바다로 열린 드라이 도크, 도크에 걸친 골리앗 크레인, 도크 옆 블록 공장, 뒷산). 회사 이름·로고는 넣지 않는다.
//
//   골리앗 크레인은 하늘에서 수직으로 내려오는 걸리버의 팔과 손(벙어리장갑 + 손바닥 자석판). 몸은 아직 그리지 않는다
//   (오른쪽에 머리를 두고 누운 걸리버가 화면 밖에서 팔만 뻗은 것처럼 보이게 하려는 것, D29).
//   작업장마다: 소조립·중조립은 벽만 있는 공장(지붕 없음, 앞은 열림), PE장은 바깥 정반(노란 구획선), 탑재는 바다 쪽 문이 달린 드라이 도크.
//   물류창고 구역은 자재 선반을 벽으로 묶는다. 인도한 배는 오른쪽 바다(안벽 앞)에 뜬다.
// 규칙은 그대로다. 그림만 바뀐다.

import * as THREE from "three";
import { mesh } from "./people";
import { BAY_C, BAY_MOUTH, BAY_Z, groundY, HILL_BASE, HILLS, MOUTH_X, QUAY, route, SHORE_X, STATION_X, SUPPLY_EXIT, SUPPLY_ROUTE, YARD_X0, YARD_Z0, YARD_Z1, type Sector } from "./layout";

export const SEA_Y = -0.32;

const CONCRETE = "#c9c5bb";
const WALL = "#d9ddd8";
const WALL_BASE = "#7d8a83";

// 만(灣): 야드 오른쪽(SHORE_X 너머)만 바다다. 산은 ㄷ자로 둘러싸고(뒤·왼쪽·앞), 오른쪽 두 끝을 안쪽으로 굽혀 곶을 만든다.
// 뒤쪽 곶 끝에 등대. 곶 사이 물길(BAY_MOUTH)은 막지 않는다. 숫자는 layout.ts.

/** 땅(포장된 야드 + 풀밭), 만의 바다, ㄷ자 산, 곶과 등대. */
export function buildLand(scene: THREE.Scene): void {
  const ground = (x0: number, x1: number, z0: number, z1: number, color: string, y = -0.5) => {
    const m = mesh(new THREE.BoxGeometry(x1 - x0, 1, z1 - z0), color, { roughness: 1 });
    m.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
    m.castShadow = false;
    scene.add(m);
  };
  // 포장된 야드(밝은 콘크리트)와 둘레 풀밭. 오른쪽 만만 비운다.
  ground(YARD_X0, SHORE_X, YARD_Z0, YARD_Z1, CONCRETE);
  ground(-90, YARD_X0, -90, 90, "#93ab7c", -0.52);
  ground(YARD_X0, SHORE_X, -90, YARD_Z0, "#93ab7c", -0.52);
  ground(YARD_X0, SHORE_X, YARD_Z1, 90, "#93ab7c", -0.52);
  ground(SHORE_X, 90, -90, BAY_C - BAY_Z, "#93ab7c", -0.52);
  ground(SHORE_X, 90, BAY_C + BAY_Z, 90, "#93ab7c", -0.52);
  // 매립한 안벽(3.2): 등대가 없는 앞쪽 곶과 야드 사이를 메운 땅. 만 쪽 가장자리가 안벽(어두운 테두리와 계선주)
  ground(QUAY.x0, QUAY.x1, QUAY.z0, QUAY.z1, CONCRETE);
  const edge = mesh(new THREE.BoxGeometry(QUAY.x1 - QUAY.x0, 0.1, 0.25), "#8f8a80", { roughness: 1 });
  edge.position.set((QUAY.x0 + QUAY.x1) / 2, 0.05, QUAY.z0 + 0.125);
  edge.castShadow = false;
  scene.add(edge);
  for (let x = QUAY.x0 + 0.8; x < QUAY.x1 - 0.3; x += 1.3) {
    const bollard = mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.22, 12), "#3a3f3c");
    bollard.position.set(x, 0.11, QUAY.z0 + 0.35);
    scene.add(bollard);
  }
  // 자재 납품 길(3.2): 등대 곶에서 굽어 들어와 물류창고 뒤까지, 그리고 왼쪽으로 빠지는 길. 땅(언덕) 높이를 따라 깐 흙길
  for (const pts of [SUPPLY_ROUTE, SUPPLY_EXIT]) {
    const r = route(pts, 0.6);
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1], b = r.pts[i];
      const ya = groundY(a.x, a.z) + 0.015, yb = groundY(b.x, b.z) + 0.015;
      const len = Math.hypot(b.x - a.x, yb - ya, b.z - a.z);
      const paved = groundY((a.x + b.x) / 2, (a.z + b.z) / 2) === 0;
      const m = mesh(new THREE.BoxGeometry(0.9, 0.02, len + 0.05), paved ? "#bdb6a8" : "#a8946f", { roughness: 1 });
      m.position.set((a.x + b.x) / 2, (ya + yb) / 2, (a.z + b.z) / 2);
      m.lookAt(b.x, yb, b.z);
      m.castShadow = false;
      scene.add(m);
    }
  }
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(300, 300),
    new THREE.MeshStandardMaterial({ color: "#3f6f8c", roughness: 0.25, metalness: 0.05 }));
  sea.rotation.x = -Math.PI / 2;
  sea.position.y = SEA_Y;
  sea.receiveShadow = true;
  scene.add(sea);

  const hill = (x: number, z: number, rx: number, h: number, rz: number, color: string) => {
    const m = mesh(new THREE.SphereGeometry(1, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), color, { roughness: 1, flatShading: true });
    m.scale.set(rx, h, rz);
    m.position.set(x, HILL_BASE, z);
    m.castShadow = false;
    scene.add(m);
  };
  const greens = ["#7f9a6b", "#87a173", "#7b9667", "#8aa476", "#90a97c"];
  // ㄷ자 산, 만의 두 팔과 곶 끝(자리는 layout.ts의 HILLS, 납품 길이 그 높이를 따라간다)
  for (const hl of HILLS) hill(hl.x, hl.z, hl.rx, hl.h, hl.rz, greens[hl.color]);
  // 등대: 뒤쪽 곶 끝(카메라에서 보이는 쪽)
  const tower = mesh(new THREE.CylinderGeometry(0.45, 0.6, 3.2, 20), "#f4f1ea");
  tower.position.set(MOUTH_X, 2.6, BAY_C - (BAY_MOUTH + 2.6));
  const band = mesh(new THREE.CylinderGeometry(0.5, 0.53, 0.5, 20), "#b8322d");
  band.position.set(MOUTH_X, 3.0, BAY_C - (BAY_MOUTH + 2.6));
  const lamp = mesh(new THREE.CylinderGeometry(0.38, 0.38, 0.5, 16), "#ffe9a8", { emissive: "#ffcf66", emissiveIntensity: 0.6 });
  lamp.position.set(MOUTH_X, 4.45, BAY_C - (BAY_MOUTH + 2.6));
  const cap = mesh(new THREE.ConeGeometry(0.55, 0.6, 16), "#b8322d");
  cap.position.set(MOUTH_X, 5.0, BAY_C - (BAY_MOUTH + 2.6));
  scene.add(tower, band, lamp, cap);
}

/** 벽만 있는 작업장(지붕 없음, 앞은 열림): 뒷벽과 양옆 벽. door = 뒷벽에 낸 문(가운데 x와 폭, 물류창고 뒷문 3.2) */
export function buildWalls(x0: number, x1: number, z0: number, z1: number, height: number, door?: { x: number; w: number }): THREE.Group {
  const g = new THREE.Group();
  const t = 0.14;
  const back = door
    ? [{ w: door.x - door.w / 2 - x0, d: t, x: (x0 + door.x - door.w / 2) / 2, z: z0 }, { w: x1 - door.x - door.w / 2, d: t, x: (door.x + door.w / 2 + x1) / 2, z: z0 }]
    : [{ w: x1 - x0, d: t, x: (x0 + x1) / 2, z: z0 }];
  const walls = [
    ...back,
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

/**
 * 공장 지붕(3.2): 전경에서 내업 구획을 덮는 얇은 판 + 철골(트러스) 몇 줄. 구획을 가까이 보면 통째로 숨긴다
 * (투명하게, 철골도 보이지 않게, D38). 벽(높이 wallH) 위에 얹는다.
 */
export function buildRoof(x0: number, x1: number, z0: number, z1: number, wallH: number): THREE.Group {
  const g = new THREE.Group();
  const w = x1 - x0, d = z1 - z0;
  const sheet = mesh(new THREE.BoxGeometry(w + 0.3, 0.08, d + 0.3), "#b9c2bd", { roughness: 0.85 });
  sheet.position.set((x0 + x1) / 2, wallH + 0.35, (z0 + z1) / 2);
  g.add(sheet);
  for (let k = 1; k < 4; k++) {
    const beam = mesh(new THREE.BoxGeometry(0.1, 0.3, d), "#7d8a83", { roughness: 0.8 });
    beam.position.set(x0 + (w * k) / 4, wallH + 0.16, (z0 + z1) / 2);
    g.add(beam);
  }
  return g;
}

/** 구획 윤곽: 바닥의 흰 점선(전경에서 구획이 어디까지인지). dashed = 아직 쓰지 않는 땅(증설 예정지) */
export function buildSectorOutline(sec: Sector, faint = false): THREE.Group {
  const g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color: "#f7f5ee", transparent: true, opacity: faint ? 0.35 : 0.75 });
  const dash = (x0: number, z0: number, x1: number, z1: number) => {
    const len = Math.hypot(x1 - x0, z1 - z0), n = Math.max(1, Math.floor(len / 0.9));
    for (let k = 0; k < n; k += 1) {
      const a = k / n, b = (k + 0.55) / n;
      const m = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.12, (x1 - x0) * (b - a)), 0.015, Math.max(0.12, (z1 - z0) * (b - a))), mat);
      m.position.set(x0 + (x1 - x0) * (a + b) / 2, 0.02, z0 + (z1 - z0) * (a + b) / 2);
      g.add(m);
    }
  };
  dash(sec.x0, sec.z0, sec.x1, sec.z0);
  dash(sec.x0, sec.z1, sec.x1, sec.z1);
  dash(sec.x0, sec.z0, sec.x0, sec.z1);
  if (sec.x1 < SHORE_X - 0.1) dash(sec.x1, sec.z0, sec.x1, sec.z1);
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
  // 바다 쪽 문(캐슨): 어두운 강철 문짝. 현관문처럼 열린다(진수, 그림만): 나가는 배의 왼쪽(−z) 끝이 세로 경첩이고,
  // 오른쪽(+z) 끝을 걸리버의 손이 잡아 바다 쪽(+x)으로 민다.
  const span = z1 - z0 - 0.3;
  const hinge = new THREE.Group();
  hinge.position.set(x1, 0, (z0 + z1) / 2 - span / 2);
  const gate = mesh(new THREE.BoxGeometry(0.4, 0.5, span), "#4e5a63", { metalness: 0.3, roughness: 0.6 });
  gate.position.set(0, 0.2, span / 2);
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

  /** left: 걸리버의 왼손(2호 도크 크레인). 엄지가 반대쪽이다. */
  constructor(left = false) {
    this.arm = mesh(new THREE.CapsuleGeometry(0.62, 1, 6, 16), "#34495e");
    const mitten = mesh(new THREE.SphereGeometry(0.9, 20, 14), "#c9b79a");
    mitten.scale.set(1.15, 1.2, 0.8);
    const thumb = mesh(new THREE.CapsuleGeometry(0.28, 0.5, 6, 10), "#c9b79a");
    thumb.position.set(left ? -0.95 : 0.95, 0.1, 0);
    thumb.rotation.z = left ? 0.5 : -0.5;
    const cuff = mesh(new THREE.CylinderGeometry(0.75, 0.75, 0.35, 18), "#e9e4d8");
    cuff.position.y = 1.05;
    const magnet = mesh(new THREE.CylinderGeometry(0.62, 0.62, 0.14, 28), "#6f7a82", { metalness: 0.6, roughness: 0.35 });
    magnet.position.y = -1.05;
    this.hand.add(mitten, thumb, cuff, magnet);
    this.hand.scale.setScalar(GiantHand.SCALE);
    this.root.add(this.arm, this.hand);
    this.place(new THREE.Vector3(STATION_X[3], 3, 0));
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
