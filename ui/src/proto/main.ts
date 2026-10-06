// 시안: 걸리버의 책상 위 조선소.
// 소인들이 걸리버가 접은 견본 크기의 종이배를 재단 → 풀칠 → 물감칠 → 의장 순서로 만든다.
// 아직 엔진 데이터와 연결하지 않았다. 한 척이 도는 장면을 정해진 시간표로 반복한다.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import {
  BENCH_X, buildSchedule, clamp01, ease, flatOf, hullTris, LAUNCH_CAPTION, PAINT_PHASE_INDEX, REWORK_CAPTION,
  sailTris, SKILLED_STATION, STATIONS, type Phase, type Tool, type Tri,
} from "./model";

const MAT_TOP = 0.08;
const CUP = new THREE.Vector3(10.8, 0, 0.6);
const WATER_Y = 1.42;

const PAPER = new THREE.Color("#f4f0e6");
const PAINT = new THREE.Color("#c8553d");
const DAY_BG = new THREE.Color("#e9e1d1");
const NIGHT_BG = new THREE.Color("#1b2231");

// ---------------------------------------------------------------------------
// 장면
// ---------------------------------------------------------------------------

const host = document.getElementById("stage")!;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
host.append(renderer.domElement);

const labelRenderer = new CSS2DRenderer();
labelRenderer.domElement.className = "labels";
host.append(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = DAY_BG.clone();
scene.fog = new THREE.Fog(DAY_BG.clone(), 34, 70);

const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 200);
camera.position.set(2.8, 10.4, 19.5);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(3, 0.4, -0.8);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.46;
controls.minDistance = 5;
controls.maxDistance = 36;
controls.autoRotateSpeed = 0.6;

const hemi = new THREE.HemisphereLight("#fff8ec", "#8a6a4a", 1.5);
scene.add(hemi);
const sun = new THREE.DirectionalLight("#fff1da", 2.6);
sun.position.set(-9, 17, 11);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, { left: -19, right: 19, top: 15, bottom: -15, near: 1, far: 60 });
sun.shadow.bias = -0.0004;
sun.shadow.normalBias = 0.02;
scene.add(sun);

function label(html: string, className: string): CSS2DObject {
  const div = document.createElement("div");
  div.className = className;
  div.innerHTML = html;
  return new CSS2DObject(div);
}

function mesh(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation, opts: THREE.MeshStandardMaterialParameters = {}): THREE.Mesh {
  const m = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...opts }));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

// 걸리버의 나무 책상: 캔버스에 나뭇결을 그려 텍스처로 쓴다(외부 이미지 없음).
function woodTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  g.fillStyle = "#c79f74";
  g.fillRect(0, 0, 512, 512);
  for (let i = 0; i < 160; i++) {
    const y = Math.random() * 512;
    g.strokeStyle = `rgba(${90 + Math.random() * 30}, ${55 + Math.random() * 20}, 30, ${0.05 + Math.random() * 0.12})`;
    g.lineWidth = 1 + Math.random() * 3;
    g.beginPath();
    for (let x = 0; x <= 512; x += 16) g.lineTo(x, y + Math.sin(x / 60 + i) * 4);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 2);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

const desk = mesh(new THREE.BoxGeometry(46, 1, 28), "#ffffff", { map: woodTexture(), roughness: 0.75 });
desk.position.y = -0.5;
desk.castShadow = false;
scene.add(desk);

// ---------------------------------------------------------------------------
// 종이배: 펼친 종이(flat)와 접힌 배(folded) 사이를 보간해 접히는 모습을 만든다.
// ---------------------------------------------------------------------------

class FoldMesh {
  readonly mesh: THREE.Mesh;
  private readonly flat: Float32Array;
  private readonly folded: Float32Array;

  constructor(tris: Tri[], material: THREE.Material) {
    const flat: number[] = [];
    const folded: number[] = [];
    for (const tri of tris) {
      for (const v of tri.v) {
        folded.push(...v);
        flat.push(...flatOf(v, tri));
      }
    }
    this.flat = new Float32Array(flat);
    this.folded = new Float32Array(folded);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(flat), 3));
    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.set(0);
  }

  set(t: number): void {
    const e = ease(clamp01(t));
    const attr = this.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const out = attr.array as Float32Array;
    for (let i = 0; i < out.length; i++) out[i] = this.flat[i] + (this.folded[i] - this.flat[i]) * e;
    attr.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mesh.geometry.computeBoundingSphere();
  }
}

function paperMaterial(color: THREE.Color = PAPER): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: color.clone(), side: THREE.DoubleSide, flatShading: true, roughness: 0.95 });
}

class Boat {
  readonly group = new THREE.Group();
  readonly hullMat = paperMaterial();
  readonly hull = new FoldMesh(hullTris(), this.hullMat);
  readonly sail = new FoldMesh(sailTris(), paperMaterial());
  readonly flag = new THREE.Group();
  readonly badge = label("불량 → 재작업", "badge");
  floatPhase = Math.random() * Math.PI * 2;
  // 진수해서 떠 있을 자리. 물그릇 안에서 조금씩 다르게 둔다.
  readonly floatSpot = new THREE.Vector3(CUP.x + (Math.random() - 0.5) * 2, WATER_Y, CUP.z + (Math.random() - 0.5) * 2);

  constructor() {
    this.group.add(this.hull.mesh, this.sail.mesh, this.flag, this.badge);
    const stick = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.55, 6), "#6b4a2b");
    stick.position.y = 0.27;
    const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0.32, -0.09), new THREE.Vector2(0, -0.18)]);
    const cloth = mesh(new THREE.ShapeGeometry(shape), "#c0392b", { side: THREE.DoubleSide });
    cloth.position.y = 0.54;
    this.flag.add(stick, cloth);
    this.flag.position.set(0, 1.2, 0);
    this.flag.scale.setScalar(0.001);
    this.badge.position.set(0, 1.9, 0);
    this.badge.visible = false;
  }

  setPaint(t: number): void {
    this.hullMat.color.lerpColors(PAPER, PAINT, clamp01(t));
  }
}

// 재단할 때 쓰는 큰 종이와 잘려 나가는 자투리. 재단 작업대에 남아 있다.
const cutFx = new THREE.Group();
const sheetMat = new THREE.MeshStandardMaterial({ color: "#f7f3ea", roughness: 0.95, transparent: true, side: THREE.DoubleSide });
const sheet = new THREE.Mesh(new THREE.PlaneGeometry(3.0, 2.9), sheetMat);
sheet.rotation.x = -Math.PI / 2;
sheet.position.y = MAT_TOP + 0.005;
sheet.receiveShadow = true;
cutFx.add(sheet);
const scraps = Array.from({ length: 9 }, (_, i) => {
  const a = (i / 9) * Math.PI * 2;
  const tri = new THREE.Mesh(new THREE.CircleGeometry(0.16, 3), paperMaterial());
  tri.castShadow = true;
  cutFx.add(tri);
  return { mesh: tri, from: new THREE.Vector3(Math.cos(a) * 1.3, 0, Math.sin(a) * 1.25), dir: new THREE.Vector3(Math.cos(a), 0, Math.sin(a)) };
});
cutFx.position.x = BENCH_X[0];
scene.add(cutFx);

function setCut(p: number): void {
  sheetMat.opacity = 1 - ease(clamp01(p * 1.2));
  sheet.scale.setScalar(1 - 0.12 * p);
  for (const [i, s] of scraps.entries()) {
    const q = clamp01(p * 1.4 - i * 0.04);
    s.mesh.visible = q > 0;
    s.mesh.position.copy(s.from).addScaledVector(s.dir, q * 0.9);
    s.mesh.position.y = MAT_TOP + 0.02 + Math.sin(Math.PI * q) * 0.35;
    s.mesh.rotation.set(-Math.PI / 2 + q * 3, q * 4, 0);
  }
}

// ---------------------------------------------------------------------------
// 소품: 작업대, 촛불, 견본 배, 연필, 물그릇
// ---------------------------------------------------------------------------

const candles: { light: THREE.PointLight; flame: THREE.Mesh }[] = [];

STATIONS.forEach((st, i) => {
  const x = BENCH_X[i];
  const mat = mesh(new THREE.BoxGeometry(3.4, MAT_TOP, 2.6), st.color, { roughness: 0.95 });
  mat.position.set(x, MAT_TOP / 2, 0);
  mat.castShadow = false;
  scene.add(mat);
  const tag = label(`<i style="background:${st.color}"></i>${st.name}`, "station-label");
  tag.position.set(x, 0.1, 1.75);
  scene.add(tag);

  // 잔업할 때 켜지는 촛불
  const candle = new THREE.Group();
  const wax = mesh(new THREE.CylinderGeometry(0.11, 0.12, 0.5, 12), "#f3e6c8");
  wax.position.y = 0.25;
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.16, 8),
    new THREE.MeshBasicMaterial({ color: "#ffb347" }));
  flame.position.y = 0.6;
  const light = new THREE.PointLight("#ffae5a", 0, 7, 1.3);
  light.position.y = 0.75;
  candle.add(wax, flame, light);
  candle.position.set(x + 1.45, MAT_TOP, -1.05);
  scene.add(candle);
  candles.push({ light, flame });
});

// 자재 더미: 종이 묶음, 물감 통, 깃발 다발
for (let k = 0; k < 6; k++) {
  const p = mesh(new THREE.BoxGeometry(0.9, 0.035, 0.7), "#f7f3ea");
  p.position.set(BENCH_X[0] - 1.1, 0.02 + k * 0.036, -1.95);
  p.rotation.y = (Math.random() - 0.5) * 0.2;
  scene.add(p);
}
["#c8553d", "#2a78d6", "#fab219"].forEach((c, k) => {
  const pot = mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.28, 14), "#d9d4c8");
  pot.position.set(BENCH_X[2] - 1.2 + k * 0.42, 0.14, -1.95);
  const top = mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.02, 14), c);
  top.position.y = 0.145;
  pot.add(top);
  scene.add(pot);
});
for (let k = 0; k < 4; k++) {
  const f = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.5, 6), "#6b4a2b");
  f.position.set(BENCH_X[3] - 1.2 + k * 0.08, 0.25, -1.95);
  f.rotation.z = (k - 1.5) * 0.12;
  scene.add(f);
}

// 걸리버가 접은 견본: 같은 모양을 크게 키웠다.
const giant = new THREE.Group();
const giantHull = new FoldMesh(hullTris(), paperMaterial());
const giantSail = new FoldMesh(sailTris(), paperMaterial());
giantHull.set(1);
giantSail.set(1);
giant.add(giantHull.mesh, giantSail.mesh);
giant.scale.setScalar(3.8);
giant.position.set(-1, 0, -7.6);
giant.rotation.y = 0.12;
scene.add(giant);
const giantTag = label("<b>걸리버가 접은 견본</b><span>소인들은 이 배를 보고 같은 모양으로 만듭니다</span>", "giant-label");
giantTag.position.set(-1, 0.3, -5.6);
scene.add(giantTag);

// 걸리버의 연필: 소인에게는 통나무만 하다.
const pencil = new THREE.Group();
const body = mesh(new THREE.CylinderGeometry(0.45, 0.45, 13, 6), "#f2c230", { flatShading: true });
const wood = mesh(new THREE.ConeGeometry(0.45, 1.3, 6), "#e3bf8f", { flatShading: true });
wood.position.y = -7.15;
wood.rotation.x = Math.PI;
const lead = mesh(new THREE.ConeGeometry(0.13, 0.38, 6), "#3a3a3a");
lead.position.y = -7.95;
lead.rotation.x = Math.PI;
const band = mesh(new THREE.CylinderGeometry(0.47, 0.47, 0.5, 16), "#b9b9b9", { metalness: 0.6, roughness: 0.35 });
band.position.y = 6.75;
const eraser = mesh(new THREE.CylinderGeometry(0.45, 0.45, 0.7, 16), "#e7a3a3");
eraser.position.y = 7.35;
pencil.add(body, wood, lead, band, eraser);
pencil.rotation.z = Math.PI / 2;
pencil.rotation.y = -0.5;
pencil.position.set(7.5, 0.45, -6.5);
scene.add(pencil);

// 물그릇: 인도한 배가 진수되는 바다
const cupProfile = [
  [0, 0], [1.9, 0], [2.05, 0.08], [2.25, 0.6], [2.4, 1.6], [2.3, 1.6], [2.12, 0.62], [1.95, 0.18], [0, 0.18],
].map(([x, y]) => new THREE.Vector2(x, y));
const cup = mesh(new THREE.LatheGeometry(cupProfile, 48), "#f7f7f4", { roughness: 0.3, side: THREE.DoubleSide });
cup.position.copy(CUP);
const water = new THREE.Mesh(new THREE.CircleGeometry(2.3, 48),
  new THREE.MeshStandardMaterial({ color: "#4f8fc0", roughness: 0.15, metalness: 0.1, transparent: true, opacity: 0.88 }));
water.rotation.x = -Math.PI / 2;
water.position.set(CUP.x, WATER_Y, CUP.z);
water.receiveShadow = true;
const saucer = mesh(new THREE.CylinderGeometry(3.1, 2.8, 0.12, 48), "#f1f0ea", { roughness: 0.3 });
saucer.position.set(CUP.x, 0.06, CUP.z);
scene.add(cup, water, saucer);
const cupTag = label("물그릇 · 진수", "station-label plain");
cupTag.position.set(CUP.x, 0.2, CUP.z + 3.2);
scene.add(cupTag);

// ---------------------------------------------------------------------------
// 소인
// ---------------------------------------------------------------------------

function toolMesh(kind: Tool): THREE.Object3D {
  const g = new THREE.Group();
  if (kind === "knife") {
    const blade = mesh(new THREE.BoxGeometry(0.02, 0.14, 0.05), "#c9ced6", { metalness: 0.7, roughness: 0.3 });
    blade.position.y = -0.08;
    g.add(blade);
  } else if (kind === "hammer") {
    const handle = mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.16, 6), "#7a5532");
    handle.position.y = -0.08;
    const head = mesh(new THREE.BoxGeometry(0.08, 0.035, 0.035), "#555b63", { metalness: 0.5 });
    head.position.y = -0.16;
    g.add(handle, head);
  } else {
    const handle = mesh(new THREE.CylinderGeometry(0.01, 0.01, 0.14, 6), "#7a5532");
    handle.position.y = -0.07;
    const tip = mesh(new THREE.ConeGeometry(0.022, 0.06, 6), kind === "brush" ? "#c8553d" : "#fafafa");
    tip.position.y = -0.16;
    tip.rotation.x = Math.PI;
    g.add(handle, tip);
  }
  g.rotation.x = Math.PI / 2;
  return g;
}

class Lilliputian {
  readonly root = new THREE.Group();
  private readonly armL = new THREE.Group();
  private readonly armR = new THREE.Group();
  private readonly legL = new THREE.Group();
  private readonly legR = new THREE.Group();
  private readonly torso = new THREE.Group();
  private readonly head: THREE.Mesh;
  private target = new THREE.Vector3();
  private workLeft = 0;
  private phase = Math.random() * 10;

  constructor(color: string, tool: Tool, private readonly benchX: number, private readonly side: number, skilled: boolean) {
    const skin = "#f0c8a0";
    for (const [leg, x] of [[this.legL, -0.05], [this.legR, 0.05]] as const) {
      const m = mesh(new THREE.CylinderGeometry(0.035, 0.03, 0.22, 8), "#5b4636");
      m.position.y = -0.11;
      const shoe = mesh(new THREE.BoxGeometry(0.06, 0.03, 0.09), "#2e241c");
      shoe.position.set(0, -0.22, 0.015);
      leg.add(m, shoe);
      leg.position.set(x, 0.24, 0);
      this.root.add(leg);
    }
    const tunic = mesh(new THREE.CylinderGeometry(0.075, 0.115, 0.26, 10), color);
    tunic.position.y = 0.36;
    const belt = mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.025, 10), "#3b2a1c");
    belt.position.y = 0.3;
    this.torso.add(tunic, belt);
    this.head = mesh(new THREE.SphereGeometry(0.075, 14, 10), skin);
    this.head.position.y = 0.56;
    const hair = mesh(new THREE.SphereGeometry(0.079, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), "#5a3b22");
    hair.rotation.x = -0.35;
    this.head.add(hair);
    for (const ex of [-0.027, 0.027]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.01, 6, 4), new THREE.MeshBasicMaterial({ color: "#1c1c1c" }));
      eye.position.set(ex, 0.005, 0.07);
      this.head.add(eye);
    }
    if (skilled) {
      const brim = mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.012, 16), "#2b2b3a");
      brim.position.y = 0.06;
      const crown = mesh(new THREE.CylinderGeometry(0.06, 0.075, 0.13, 14), "#2b2b3a");
      crown.position.y = 0.13;
      const ribbon = mesh(new THREE.CylinderGeometry(0.076, 0.076, 0.025, 14), "#e0b13a", { metalness: 0.4 });
      ribbon.position.y = 0.08;
      this.head.add(brim, crown, ribbon);
      const tag = label("숙련공", "skilled-tag");
      tag.position.y = 0.32;
      this.head.add(tag);
    }
    this.torso.add(this.head);
    for (const [arm, x] of [[this.armL, -0.1], [this.armR, 0.1]] as const) {
      const m = mesh(new THREE.CylinderGeometry(0.025, 0.022, 0.2, 8), color);
      m.position.y = -0.1;
      const hand = mesh(new THREE.SphereGeometry(0.026, 8, 6), skin);
      hand.position.y = -0.21;
      arm.add(m, hand);
      arm.position.set(x, 0.46, 0);
      this.torso.add(arm);
    }
    const t = toolMesh(tool);
    t.position.y = -0.21;
    this.armR.add(t);
    this.root.add(this.torso);
    this.root.scale.setScalar(1.15);
    this.root.position.set(benchX + 1.4 * (side > 0 ? -1 : 1), MAT_TOP, side * 0.95);
    this.target.copy(this.root.position);
  }

  update(dt: number, working: boolean, speed: number): void {
    this.phase += dt * speed;
    const pos = this.root.position;
    let walking = false;

    if (working) {
      if (this.workLeft > 0) {
        this.workLeft -= dt * speed;
      } else if (pos.distanceTo(this.target) < 0.04) {
        // 배 옆의 다른 자리로 옮겨 가서 다시 일한다.
        this.target.set(this.benchX + (Math.random() - 0.5) * 1.8, MAT_TOP, this.side * (0.62 + Math.random() * 0.15));
        this.workLeft = 1.1 + Math.random() * 1.2;
      }
    } else {
      this.target.set(this.benchX + 1.35 * (this.side > 0 ? -1 : 1), MAT_TOP, this.side * 1.0);
      this.workLeft = 0;
    }

    const toTarget = this.target.clone().sub(pos);
    toTarget.y = 0;
    if (toTarget.length() > 0.04 && this.workLeft <= 0) {
      walking = true;
      const step = Math.min(toTarget.length(), 0.75 * speed * dt);
      pos.addScaledVector(toTarget.normalize(), step);
      this.faceTowards(Math.atan2(toTarget.x, toTarget.z), dt);
    } else {
      // 일할 때는 배(z=0)를 본다. 쉴 때는 앞을 본다.
      this.faceTowards(working ? (this.side > 0 ? Math.PI : 0) : (this.side > 0 ? 0 : Math.PI), dt);
    }

    const p = this.phase;
    if (walking) {
      const swing = Math.sin(p * 9) * 0.6;
      this.legL.rotation.x = swing;
      this.legR.rotation.x = -swing;
      this.armL.rotation.x = -swing * 0.8;
      this.armR.rotation.x = swing * 0.8;
      this.torso.position.y = Math.abs(Math.sin(p * 9)) * 0.02;
      this.head.rotation.y = 0;
    } else if (working && this.workLeft > 0) {
      this.legL.rotation.x = this.legR.rotation.x = 0;
      this.armR.rotation.x = -1.25 + Math.sin(p * 11) * 0.65;
      this.armL.rotation.x = -0.7 + Math.sin(p * 11 + 1.5) * 0.15;
      this.torso.rotation.x = 0.18 + Math.sin(p * 11) * 0.04;
      this.torso.position.y = Math.abs(Math.sin(p * 5.5)) * 0.012;
    } else {
      this.legL.rotation.x = this.legR.rotation.x = 0;
      this.armL.rotation.x = this.armR.rotation.x = Math.sin(p * 1.5) * 0.05;
      this.torso.rotation.x = 0;
      this.torso.position.y = Math.sin(p * 2) * 0.004;
      this.head.rotation.y = Math.sin(p * 0.7) * 0.6;
    }
  }

  private faceTowards(angle: number, dt: number): void {
    let d = angle - this.root.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.root.rotation.y += d * Math.min(1, dt * 8);
  }
}

const crews: Lilliputian[][] = STATIONS.map((st, i) =>
  Array.from({ length: st.workers }, (_, k) => {
    const side = k % 2 === 0 ? 1 : -1;
    const w = new Lilliputian(st.color, st.tool, BENCH_X[i], side, i === SKILLED_STATION && k === 0);
    scene.add(w.root);
    return w;
  }));

// ---------------------------------------------------------------------------
// 한 척의 시간표 (model.ts)
// ---------------------------------------------------------------------------

const ui = {
  overtime: false,
  defect: false,
  fast: false,
};

function workSpeed(): number {
  return (ui.fast ? 1.5 : 1) * (ui.overtime ? 1.25 : 1);
}

let boat = new Boat();
scene.add(boat.group);
const floating: Boat[] = [];
let schedule = buildSchedule(ui.defect);
let phaseIndex = 0;
let phaseTime = 0;

function benchPos(i: number): THREE.Vector3 {
  return new THREE.Vector3(BENCH_X[i], MAT_TOP, 0);
}

function startNewBoat(): void {
  floating.push(boat);
  if (floating.length > 3) {
    const old = floating.shift()!;
    scene.remove(old.group);
  }
  boat = new Boat();
  scene.add(boat.group);
  schedule = buildSchedule(ui.defect);
  phaseIndex = 0;
  phaseTime = 0;
}

const caption = document.getElementById("caption")!;

function applyPhase(phase: Phase, p: number): number | null {
  boat.badge.visible = false;
  boat.hullMat.emissive.setRGB(0, 0, 0);
  cutFx.visible = phase.kind === "process" && phase.station === 0;

  switch (phase.kind) {
    case "process": {
      boat.group.position.copy(benchPos(phase.station));
      boat.group.rotation.set(0, 0, 0);
      if (phase.station === 0) setCut(p);
      if (phase.station === 1) { boat.hull.set(p); boat.sail.set(p); }
      if (phase.station === 2) boat.setPaint(p);
      if (phase.station === 3) {
        boat.flag.scale.setScalar(Math.max(0.001, ease(p)));
      }
      caption.textContent = STATIONS[phase.station].caption;
      return phase.station;
    }
    case "rework": {
      boat.group.position.copy(benchPos(phase.station));
      boat.badge.visible = true;
      const pulse = (Math.sin(p * Math.PI * 6) + 1) / 2;
      boat.hullMat.emissive.setRGB(0.55 * pulse, 0.22 * pulse, 0.05 * pulse);
      boat.setPaint(0.55 + 0.45 * p);
      caption.textContent = REWORK_CAPTION;
      return phase.station;
    }
    case "move": {
      const a = benchPos(phase.from), b = benchPos(phase.from + 1);
      const e = ease(p);
      boat.group.position.lerpVectors(a, b, e);
      boat.group.position.y += Math.sin(Math.PI * e) * 0.9;
      boat.group.rotation.z = Math.sin(Math.PI * e) * -0.15;
      caption.textContent = `${STATIONS[phase.from + 1].name} 작업대로 옮기는 중`;
      return null;
    }
    case "launch": {
      const a = benchPos(3), b = boat.floatSpot;
      const e = ease(p);
      boat.group.position.lerpVectors(a, b, e);
      boat.group.position.y += Math.sin(Math.PI * e) * 2.6;
      boat.group.rotation.y = e * 0.8;
      caption.textContent = LAUNCH_CAPTION;
      return null;
    }
    case "rest":
      caption.textContent = "다음 배를 시작합니다";
      return null;
  }
}

// ---------------------------------------------------------------------------
// 낮과 잔업(밤) 조명
// ---------------------------------------------------------------------------

let night = 0;
const tmp = new THREE.Color();

function updateLighting(dt: number, t: number): void {
  night += ((ui.overtime ? 1 : 0) - night) * Math.min(1, dt * 2.5);
  (scene.background as THREE.Color).lerpColors(DAY_BG, NIGHT_BG, night);
  (scene.fog as THREE.Fog).color.copy(scene.background as THREE.Color);
  hemi.intensity = 1.5 - 1.25 * night;
  sun.intensity = 2.6 - 2.2 * night;
  sun.color.lerpColors(tmp.set("#fff1da"), new THREE.Color("#8fa6d9"), night);
  candles.forEach((c, i) => {
    const flicker = 1 + Math.sin(t * 13 + i * 2) * 0.12 + Math.sin(t * 29 + i) * 0.06;
    c.light.intensity = 7 * night * flicker;
    c.flame.visible = night > 0.05;
    c.flame.scale.set(1, flicker, 1);
  });
}

// ---------------------------------------------------------------------------
// 루프
// ---------------------------------------------------------------------------

const clock = new THREE.Clock();

function resize(): void {
  const { clientWidth: w, clientHeight: h } = host;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(host);
resize();

function frame(): void {
  const dt = Math.min(clock.getDelta(), 0.05);
  const t = clock.elapsedTime;
  const speed = workSpeed();

  const phase = schedule[phaseIndex];
  // 작업과 재작업은 처리 속도에 맞춰 빨라지고, 이동과 진수는 그대로다.
  phaseTime += dt * (phase.kind === "process" || phase.kind === "rework" ? speed : 1);
  const p = clamp01(phaseTime / phase.dur);
  const active = applyPhase(phase, p);
  if (phaseTime >= phase.dur) {
    phaseIndex++;
    phaseTime = 0;
    if (phaseIndex >= schedule.length) startNewBoat();
  }

  crews.forEach((crew, i) => crew.forEach((w) => w.update(dt, active === i, speed)));
  floating.forEach((b) => {
    b.floatPhase += dt;
    b.group.position.set(b.floatSpot.x, WATER_Y + Math.sin(b.floatPhase * 1.6) * 0.04, b.floatSpot.z);
    b.group.rotation.z = Math.sin(b.floatPhase * 1.3) * 0.05;
    b.group.rotation.x = Math.sin(b.floatPhase * 1.1) * 0.04;
    b.flag.rotation.y = Math.sin(b.floatPhase * 4) * 0.3;
  });
  boat.flag.rotation.y = Math.sin(t * 4) * 0.25;

  updateLighting(dt, t);
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------
// 토글
// ---------------------------------------------------------------------------

document.querySelectorAll<HTMLButtonElement>("[data-toggle]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.dataset.toggle!;
    if (key === "rotate") {
      controls.autoRotate = !controls.autoRotate;
      btn.classList.toggle("on", controls.autoRotate);
      return;
    }
    const k = key as keyof typeof ui;
    ui[k] = !ui[k];
    btn.classList.toggle("on", ui[k]);
    // 물감칠 칸이 끝나기 전이면 지금 배에도 바로 반영한다. 그 앞 칸은 두 시간표가 같다.
    if (k === "defect" && phaseIndex <= PAINT_PHASE_INDEX) {
      schedule = [...schedule.slice(0, phaseIndex), ...buildSchedule(ui.defect).slice(phaseIndex)];
    }
  });
});
