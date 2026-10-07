// 걸리버의 책상 위 스마트야드. 소인들이 블록을 조립해 종이배를 만든다.
// 관제실(전경)과 현장(가까운 눈높이)이 같은 장면을 카메라만 바꿔 쓴다.
// 그리는 내용은 frame.ts의 Frame뿐이다. 이 파일은 규칙을 모른다.

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DObject, CSS2DRenderer } from "three/addons/renderers/CSS2DRenderer.js";
import type { Frame, LotView } from "./frame";
import { mesh, Person } from "./people";
import { clamp01, ease, flatOf, hullTris, sailTris, type Tri } from "../proto/model";
import { STATE_INFO, STATION_COLOR } from "../labels";

// ----- 배치 (책상 위 좌표, 단위는 대략 소인 키의 4배) -----
const STATION_X = [-9, -3.5, 2, 8.5];
const MAT_W = 3.2, MAT_D = 2.6, MAT_TOP = 0.08;
const QUEUE_Z = 2.2;
const LANE_Z = 3.7;
const DEPOT = new THREE.Vector3(-12, 0, LANE_Z);
const CUP = new THREE.Vector3(13.4, 0, 0.6);
const WATER_Y = 1.42;
const LOUNGE = new THREE.Vector3(-11.4, 0, -4.4);
const SHELF_X = [-7.2, -4.7, -2.2];
const SHELF_Z = -4.8;
const LAB = new THREE.Vector3(4.2, 0, -5);

const PAPER = new THREE.Color("#f4f0e6");
const PAINT = new THREE.Color("#c8553d");
const BG = new THREE.Color("#e9e1d1");
const UNIT = 0.3;

export type CameraMode = "control" | "field";

export interface DaySource {
  /** 그날 안에서 흐른 비율(0~1)을 받아 장면을 돌려준다. */
  frameAt(frac: number): Frame;
  playing: boolean;
  msPerDay: number;
  /** 걷지 않고 바로 옮긴다: 날짜를 건너뛰었거나 배속이 빠를 때. */
  snap: boolean;
}

function label(html: string, className: string): CSS2DObject {
  const div = document.createElement("div");
  div.className = className;
  div.innerHTML = html;
  return new CSS2DObject(div);
}

function setLabel(obj: CSS2DObject, html: string): void {
  if (obj.element.innerHTML !== html) obj.element.innerHTML = html;
}

function woodTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d")!;
  g.fillStyle = "#c79f74";
  g.fillRect(0, 0, 512, 512);
  // 나뭇결. 매번 같은 모양이 나오도록 난수 대신 사인으로 그린다.
  for (let i = 0; i < 160; i++) {
    const y = (i * 97.13) % 512;
    g.strokeStyle = `rgba(${90 + (i * 37) % 30}, ${55 + (i * 13) % 20}, 30, ${0.05 + ((i * 7) % 12) / 100})`;
    g.lineWidth = 1 + (i % 3);
    g.beginPath();
    for (let x = 0; x <= 512; x += 16) g.lineTo(x, y + Math.sin(x / 60 + i) * 4);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(3, 2);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function paperMaterial(color: THREE.Color = PAPER): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: color.clone(), side: THREE.DoubleSide, flatShading: true, roughness: 0.95 });
}

/** 펼친 종이와 접힌 배 사이를 보간한다(시안과 같은 방법). */
class FoldMesh {
  readonly mesh: THREE.Mesh;
  private readonly flat: Float32Array;
  private readonly folded: Float32Array;
  private last = -1;

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
    this.set(0);
  }

  set(t: number): void {
    const e = ease(clamp01(t));
    if (Math.abs(e - this.last) < 1e-3) return;
    this.last = e;
    const attr = this.mesh.geometry.getAttribute("position") as THREE.BufferAttribute;
    const out = attr.array as Float32Array;
    for (let i = 0; i < out.length; i++) out[i] = this.flat[i] + (this.folded[i] - this.flat[i]) * e;
    attr.needsUpdate = true;
    this.mesh.geometry.computeVertexNormals();
    this.mesh.geometry.computeBoundingSphere();
  }
}

// ---------------------------------------------------------------------------
// 로트: 블록 12개 → 6개 → 3개(도장) → 배
// ---------------------------------------------------------------------------

class Lot {
  readonly group = new THREE.Group();
  private readonly units: THREE.Mesh[] = [];
  private readonly unitMat = paperMaterial();
  private readonly sheet: THREE.Mesh;
  /** 절단 자투리: 소조립 정반에서 종이를 자를 때 튀어 나가는 종잇조각. */
  private readonly scraps: THREE.Mesh[] = [];
  private readonly boat = new THREE.Group();
  private readonly hullMat = paperMaterial();
  private readonly hull = new FoldMesh(hullTris(), this.hullMat);
  private readonly sail = new FoldMesh(sailTris(), paperMaterial());
  private readonly flag = new THREE.Group();
  readonly tag: CSS2DObject;
  /** 크레인 훅이 따라갈 로트 기준 x(로컬). 탑재 중이 아니면 null. */
  hookX: number | null = null;
  hookY = 0;
  readonly target = new THREE.Vector3();
  floatPhase = 0;

  constructor(readonly ship: string) {
    const geo = new THREE.BoxGeometry(UNIT, 0.22, UNIT);
    for (let u = 0; u < 12; u++) {
      const m = new THREE.Mesh(geo, this.unitMat);
      m.castShadow = true;
      this.units.push(m);
      this.group.add(m);
    }
    this.sheet = mesh(new THREE.BoxGeometry(1.5, 0.06, 1.1), "#f7f3ea");
    this.sheet.position.y = 0.03;
    const scrapGeo = new THREE.CircleGeometry(0.15, 3);
    const scrapMat = paperMaterial(new THREE.Color("#e3d9c3"));
    for (let k = 0; k < 10; k++) {
      const scrap = new THREE.Mesh(scrapGeo, scrapMat);
      scrap.castShadow = true;
      scrap.visible = false;
      this.scraps.push(scrap);
      this.group.add(scrap);
    }
    const stick = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.55, 6), "#6b4a2b");
    stick.position.y = 0.27;
    const shape = new THREE.Shape([new THREE.Vector2(0, 0), new THREE.Vector2(0.32, -0.09), new THREE.Vector2(0, -0.18)]);
    const cloth = mesh(new THREE.ShapeGeometry(shape), "#c0392b", { side: THREE.DoubleSide });
    cloth.position.y = 0.54;
    this.flag.add(stick, cloth);
    this.flag.position.y = 1.2;
    this.boat.add(this.hull.mesh, this.sail.mesh, this.flag);
    this.boat.scale.setScalar(0.85);
    this.tag = label("", "lot-tag");
    this.tag.position.y = 1.0;
    this.group.add(this.sheet, this.boat, this.tag);
  }

  /** 소조립(절단) 중이면 자투리가 종이 둘레에서 튀어 나갔다가 떨어진다. time은 초. */
  animateCut(cutting: boolean, time: number): void {
    this.scraps.forEach((scrap, k) => {
      scrap.visible = cutting;
      if (!cutting) return;
      const a = (k / this.scraps.length) * Math.PI * 2 + 0.4;
      const u = (time * 0.9 + k * 0.37) % 1;            // 조각마다 엇갈려 끝없이 반복
      scrap.position.set(Math.cos(a) * (0.6 + u * 1.0), 0.06 + Math.sin(Math.PI * u) * 0.7, Math.sin(a) * (0.5 + u * 0.8));
      scrap.rotation.set(-Math.PI / 2 + u * 4, u * 5 + k, 0);
    });
  }

  /** form: 0 부재(종이 묶음) … 4 배. bench면 소조립 중에 블록이 하나씩 생긴다. */
  setForm(form: number, onBench: boolean): void {
    this.hookX = null;
    const stage = Math.floor(form + 1e-9);
    const t = form - stage;
    this.sheet.visible = stage === 0;
    this.sheet.scale.setScalar(stage === 0 ? 1 - 0.6 * t : 1);
    this.boat.visible = stage >= 3 && (stage === 4 || t > 0);

    // 블록 배치: 6열 × 2행. 짝(열 2개)이 먼저 붙고(12 → 6), 그다음 앞뒤 줄이 붙는다(6 → 3).
    let gp = 0.12, gr = 0.12;
    if (stage === 1) gp = 0.12 * (1 - ease(t));
    if (stage >= 2) gp = 0;
    if (stage === 2) gr = 0.12 * (1 - ease(t));
    if (stage >= 3) gr = 0;
    const gb = 0.22;
    const paint = stage < 2 ? 0 : stage === 2 ? t : 1;
    this.unitMat.color.lerpColors(PAPER, PAINT, paint);
    this.hullMat.color.copy(PAINT);

    const visibleUnits = stage === 0 ? (onBench ? Math.ceil(12 * t) : 0) : 12;
    // 탑재(3 → 4): 대블록 3개를 크레인이 하나씩 배 자리로 옮긴다.
    const moving = stage === 3 ? Math.min(2, Math.floor(t * 3)) : -1;
    const u3 = stage === 3 ? t * 3 - moving : 0;
    const pileX = stage === 3 ? -0.9 : 0;
    const boatX = 0.75;

    this.units.forEach((m, u) => {
      const c = u % 6, r = Math.floor(u / 6);
      const pair = Math.floor(c / 2), within = c % 2;
      const px = (pair - 1) * (2 * UNIT + gb + gp);
      let x = px + (within - 0.5) * (UNIT + gp) + pileX;
      const z = (r - 0.5) * (UNIT + gr);
      let y = 0.11;
      let visible = u < visibleUnits && stage < 4;
      if (stage === 3) {
        if (pair < moving) visible = false;
        else if (pair === moving) {
          // 훅에 매달려 이동: 앞 절반은 들어 옮기고, 뒤 절반이면 이미 배에 붙었다.
          const k = clamp01(u3 / 0.55);
          if (u3 > 0.6) visible = false;
          x = x + (boatX - (px + pileX)) * ease(k);
          y = 0.11 + Math.sin(Math.PI * k) * 1.4;
          this.hookX = px + pileX + (boatX - (px + pileX)) * ease(k);
          this.hookY = y + 0.15;
        }
      }
      m.visible = visible;
      m.position.set(x, y, z);
      m.scale.setScalar(stage === 0 && onBench && u === visibleUnits - 1 ? 0.6 + 0.4 * ((12 * t) % 1) : 1);
    });

    if (stage >= 3) {
      const fold = stage === 4 ? 1 : t;
      this.hull.set(fold);
      this.sail.set(fold);
      this.flag.scale.setScalar(stage === 4 ? 1 : Math.max(0.001, clamp01((t - 0.8) / 0.2)));
      this.boat.position.set(stage === 4 ? 0 : boatX, 0, 0);
    }
  }
}

// ---------------------------------------------------------------------------
// 장면
// ---------------------------------------------------------------------------

export class Yard {
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly labels = new CSS2DRenderer();
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 200);
  private readonly controls: OrbitControls;
  private readonly timer = new THREE.Timer();
  private host: HTMLElement | null = null;
  private resizeObserver = new ResizeObserver(() => this.resize());
  private running = false;

  private source: DaySource | null = null;
  private sourceAt = 0;
  private lots = new Map<string, Lot>();
  private readonly people: Person[] = [];
  private readonly senior = new Person("senior");
  private readonly manager = new Person("manager");
  private readonly stationProps: {
    tag: CSS2DObject; smoke: THREE.Group; tape: THREE.Group; candle: THREE.PointLight; flame: THREE.Mesh;
  }[] = [];
  private readonly carts: { group: THREE.Group; tag: CSS2DObject; smoke: THREE.Group }[] = [];
  private readonly shelves: { boxes: THREE.Mesh[]; tag: CSS2DObject }[] = [];
  private readonly lounge: CSS2DObject;
  private readonly labTag: CSS2DObject;
  private readonly labWindow: THREE.MeshStandardMaterial;
  private readonly trolley = new THREE.Group();
  private readonly hook = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 1, 6), new THREE.MeshStandardMaterial({ color: "#333" }));
  private readonly camGoal = { pos: new THREE.Vector3(1, 22, 16.5), target: new THREE.Vector3(1, 0, -1.8) };
  private camMoving = 0;

  constructor() {
    const r = this.renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    this.labels.domElement.className = "scene-labels";

    this.scene.background = BG.clone();
    this.scene.fog = new THREE.Fog(BG.clone(), 40, 80);
    this.camera.position.copy(this.camGoal.pos);
    this.controls = new OrbitControls(this.camera, r.domElement);
    this.controls.target.copy(this.camGoal.target);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.46;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 45;
    this.controls.addEventListener("start", () => { this.camMoving = 0; });

    const hemi = new THREE.HemisphereLight("#fff8ec", "#8a6a4a", 1.5);
    const sun = new THREE.DirectionalLight("#fff1da", 2.6);
    sun.position.set(-9, 17, 11);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -22, right: 22, top: 15, bottom: -15, near: 1, far: 60 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.02;
    this.scene.add(hemi, sun);

    const desk = mesh(new THREE.BoxGeometry(50, 1, 30), "#ffffff", { map: woodTexture(), roughness: 0.75 });
    desk.position.y = -0.5;
    desk.castShadow = false;
    this.scene.add(desk);

    this.buildStations();
    this.buildCrane();
    this.buildLane();
    this.lounge = this.buildLounge();
    this.buildShelves();
    const lab = this.buildLab();
    this.labTag = lab.tag;
    this.labWindow = lab.window;
    this.buildSea();
    this.buildGiant();

    for (let i = 0; i < 8; i++) {
      const p = new Person("worker");
      this.people.push(p);
      this.scene.add(p.root);
    }
    this.scene.add(this.senior.root, this.manager.root);
    this.manager.place(new THREE.Vector3(-1, 0, 5.4), Math.PI, "stand", true);
  }

  // ----- 구성 -----

  private buildStations(): void {
    STATION_X.forEach((x, i) => {
      const ids = Object.keys(STATION_COLOR);
      const color = STATION_COLOR[ids[i]];
      const mat = mesh(new THREE.BoxGeometry(MAT_W, MAT_TOP, MAT_D), color, { roughness: 0.95 });
      mat.position.set(x, MAT_TOP / 2, 0);
      mat.castShadow = false;
      this.scene.add(mat);
      const tag = label("", "station-tag");
      tag.position.set(x, 0.1, -1.75);
      this.scene.add(tag);

      // 고장: 연기 / 사고: 통제 테이프
      const smoke = new THREE.Group();
      for (let k = 0; k < 6; k++) {
        const puff = mesh(new THREE.SphereGeometry(0.22, 10, 8), "#6e6e6e", { transparent: true, opacity: 0.55 });
        puff.castShadow = false;
        smoke.add(puff);
      }
      smoke.position.set(x + 1.1, 0.4, -0.9);
      smoke.visible = false;
      this.scene.add(smoke);

      const tape = new THREE.Group();
      const hw = MAT_W / 2 + 0.35, hd = MAT_D / 2 + 0.35;
      const corners = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]];
      corners.forEach(([cx, cz], k) => {
        const post = mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.6, 8), "#2b2b2b");
        post.position.set(cx, 0.3, cz);
        tape.add(post);
        const [nx, nz] = corners[(k + 1) % 4];
        const len = Math.hypot(nx - cx, nz - cz);
        const band = mesh(new THREE.BoxGeometry(len, 0.08, 0.02), "#f2c230", { emissive: "#3a2d00" });
        band.position.set((cx + nx) / 2, 0.5, (cz + nz) / 2);
        band.rotation.y = -Math.atan2(nz - cz, nx - cx);
        tape.add(band);
      });
      tape.position.set(x, 0, 0);
      tape.visible = false;
      this.scene.add(tape);

      // 잔업: 촛불
      const candle = new THREE.Group();
      const wax = mesh(new THREE.CylinderGeometry(0.11, 0.12, 0.5, 12), "#f3e6c8");
      wax.position.y = 0.25;
      const flame = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.16, 8), new THREE.MeshBasicMaterial({ color: "#ffb347" }));
      flame.position.y = 0.6;
      const light = new THREE.PointLight("#ffae5a", 0, 7, 1.3);
      light.position.y = 0.75;
      candle.add(wax, flame, light);
      candle.position.set(x + MAT_W / 2 + 0.3, 0, -1.2);
      this.scene.add(candle);

      this.stationProps.push({ tag, smoke, tape, candle: light, flame });
    });
  }

  private buildCrane(): void {
    const x = STATION_X[3];
    const steel = "#c9a227";
    const crane = new THREE.Group();
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const leg = mesh(new THREE.BoxGeometry(0.16, 3.4, 0.16), steel, { metalness: 0.3 });
        leg.position.set(sx * 2.0, 1.7, sz * 1.8);
        crane.add(leg);
      }
      const side = mesh(new THREE.BoxGeometry(0.16, 0.16, 3.76), steel, { metalness: 0.3 });
      side.position.set(sx * 2.0, 3.4, 0);
      crane.add(side);
    }
    const girder = mesh(new THREE.BoxGeometry(4.3, 0.28, 0.32), steel, { metalness: 0.3 });
    girder.position.set(0, 3.5, 0);
    crane.add(girder);
    const box = mesh(new THREE.BoxGeometry(0.4, 0.3, 0.5), "#3d4a5c");
    this.trolley.add(box);
    this.trolley.position.set(0, 3.25, 0);
    this.hook.castShadow = true;
    crane.add(this.trolley, this.hook);
    crane.position.set(x, 0, 0);
    this.scene.add(crane);
    const tag = label("골리앗 크레인", "place-tag");
    tag.position.set(x, 3.9, 0);
    this.scene.add(tag);
  }

  private buildLane(): void {
    const lane = mesh(new THREE.BoxGeometry(STATION_X[3] - DEPOT.x + 3, 0.02, 1.0), "#b9b2a4", { roughness: 1 });
    lane.position.set((DEPOT.x + STATION_X[3]) / 2 + 1.5, 0.01, LANE_Z);
    lane.castShadow = false;
    this.scene.add(lane);
    for (let k = 0; k < 2; k++) {
      const group = new THREE.Group();
      const deck = mesh(new THREE.BoxGeometry(1.7, 0.2, 1.0), "#5d6b78", { metalness: 0.2 });
      deck.position.y = 0.22;
      const cab = mesh(new THREE.BoxGeometry(0.35, 0.3, 0.9), "#d6a400");
      cab.position.set(-0.95, 0.3, 0);
      group.add(deck, cab);
      for (const wx of [-0.6, 0.6]) {
        for (const wz of [-0.42, 0.42]) {
          const wheel = mesh(new THREE.CylinderGeometry(0.12, 0.12, 0.08, 12), "#222");
          wheel.rotation.x = Math.PI / 2;
          wheel.position.set(wx, 0.12, wz);
          group.add(wheel);
        }
      }
      const smoke = new THREE.Group();
      for (let s = 0; s < 4; s++) {
        const puff = mesh(new THREE.SphereGeometry(0.16, 8, 6), "#6e6e6e", { transparent: true, opacity: 0.55 });
        puff.castShadow = false;
        smoke.add(puff);
      }
      smoke.visible = false;
      group.add(smoke);
      const tag = label(`T${k + 1}`, "place-tag small");
      tag.position.y = 0.9;
      group.add(tag);
      group.position.set(DEPOT.x, 0, LANE_Z + k * 1.15);
      group.visible = false;
      this.scene.add(group);
      this.carts.push({ group, tag, smoke });
    }
  }

  private buildLounge(): CSS2DObject {
    const floor = mesh(new THREE.BoxGeometry(4.2, 0.03, 3.0), "#d9d2c3", { roughness: 1 });
    floor.position.set(LOUNGE.x, 0.015, LOUNGE.z);
    floor.castShadow = false;
    this.scene.add(floor);
    for (const row of [0, 1]) {
      const bench = mesh(new THREE.BoxGeometry(3.4, 0.12, 0.4), "#9c7b55");
      bench.position.set(LOUNGE.x, 0.3, LOUNGE.z - 0.6 + row * 1.2);
      this.scene.add(bench);
    }
    const tag = label("", "place-tag");
    tag.position.set(LOUNGE.x, 1.3, LOUNGE.z - 1.2);
    this.scene.add(tag);
    return tag;
  }

  private loungeSeat(i: number): THREE.Vector3 {
    const row = Math.floor(i / 4), col = i % 4;
    return new THREE.Vector3(LOUNGE.x - 1.2 + col * 0.8, 0.2, LOUNGE.z - 0.6 + row * 1.2);
  }

  private buildShelves(): void {
    const colors = ["#f7f3ea", "#c8553d", "#c0392b"];
    SHELF_X.forEach((x, i) => {
      for (const sx of [-1, 1]) {
        const side = mesh(new THREE.BoxGeometry(0.08, 1.6, 0.9), "#8a6a4a");
        side.position.set(x + sx * 1.0, 0.8, SHELF_Z);
        this.scene.add(side);
      }
      for (const y of [0.05, 0.6, 1.15]) {
        const board = mesh(new THREE.BoxGeometry(2.0, 0.05, 0.9), "#a07e58");
        board.position.set(x, y, SHELF_Z);
        this.scene.add(board);
      }
      // 상자 24개: 선반 3단 × 4개 = 12개까지, 넘치면 바닥(앞)에 쌓는다 → 재고 과다
      const boxes: THREE.Mesh[] = [];
      for (let k = 0; k < 24; k++) {
        const box = mesh(new THREE.BoxGeometry(0.36, 0.32, 0.5), "#c9a26b");
        const top = mesh(new THREE.BoxGeometry(0.3, 0.02, 0.44), colors[i]);
        top.position.y = 0.17;
        box.add(top);
        if (k < 12) {
          const level = Math.floor(k / 4), slot = k % 4;
          box.position.set(x - 0.66 + slot * 0.44, 0.24 + level * 0.55, SHELF_Z);
        } else {
          const j = k - 12, slot = j % 4, level = Math.floor(j / 4);
          box.position.set(x - 0.66 + slot * 0.44, 0.16 + level * 0.33, SHELF_Z + 0.9);
        }
        box.visible = false;
        this.scene.add(box);
        boxes.push(box);
      }
      const tag = label("", "shelf-tag");
      tag.position.set(x, 1.75, SHELF_Z + 0.2);
      this.scene.add(tag);
      this.shelves.push({ boxes, tag });
    });
    const sign = label("자재창고", "place-tag");
    sign.position.set(SHELF_X[1], 2.9, SHELF_Z - 0.6);
    this.scene.add(sign);
  }

  private buildLab(): { tag: CSS2DObject; window: THREE.MeshStandardMaterial } {
    const body = mesh(new THREE.BoxGeometry(3.0, 1.6, 2.0), "#eef2f4");
    body.position.set(LAB.x, 0.8, LAB.z);
    const roof = mesh(new THREE.ConeGeometry(2.0, 0.8, 4), "#5d7a8c");
    roof.position.set(LAB.x, 2.0, LAB.z);
    roof.rotation.y = Math.PI / 4;
    const window = new THREE.MeshStandardMaterial({ color: "#3a4a58", emissive: "#000000" });
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.6), window);
    pane.position.set(LAB.x, 0.95, LAB.z + 1.01);
    this.scene.add(body, roof, pane);
    const tag = label("", "place-tag");
    tag.position.set(LAB.x, 2.8, LAB.z);
    this.scene.add(tag);
    return { tag, window };
  }

  private buildSea(): void {
    const profile = [[0, 0], [1.9, 0], [2.05, 0.08], [2.25, 0.6], [2.4, 1.6], [2.3, 1.6], [2.12, 0.62], [1.95, 0.18], [0, 0.18]]
      .map(([x, y]) => new THREE.Vector2(x, y));
    const cup = mesh(new THREE.LatheGeometry(profile, 48), "#f7f7f4", { roughness: 0.3, side: THREE.DoubleSide });
    cup.position.copy(CUP);
    const water = new THREE.Mesh(new THREE.CircleGeometry(2.3, 48),
      new THREE.MeshStandardMaterial({ color: "#4f8fc0", roughness: 0.15, transparent: true, opacity: 0.88 }));
    water.rotation.x = -Math.PI / 2;
    water.position.set(CUP.x, WATER_Y, CUP.z);
    const saucer = mesh(new THREE.CylinderGeometry(3.1, 2.8, 0.12, 48), "#f1f0ea", { roughness: 0.3 });
    saucer.position.set(CUP.x, 0.06, CUP.z);
    this.scene.add(cup, water, saucer);
    const tag = label("물그릇 · 인도한 배", "place-tag");
    tag.position.set(CUP.x, 0.3, CUP.z + 3.3);
    this.scene.add(tag);
  }

  private buildGiant(): void {
    const giant = new THREE.Group();
    const hull = new FoldMesh(hullTris(), paperMaterial());
    const sail = new FoldMesh(sailTris(), paperMaterial());
    hull.set(1);
    sail.set(1);
    giant.add(hull.mesh, sail.mesh);
    giant.scale.setScalar(3.6);
    giant.position.set(10, 0, -9);
    giant.rotation.y = -0.3;
    this.scene.add(giant);
    const tag = label("<b>걸리버가 접은 견본</b>", "place-tag");
    tag.position.set(10, 5.6, -9);
    this.scene.add(tag);
  }

  // ----- 연결 -----

  /** 캔버스를 다른 패널로 옮긴다(관제실 ↔ 현장). */
  attach(host: HTMLElement): void {
    if (this.host === host) return;
    if (this.host) this.resizeObserver.unobserve(this.host);
    this.host = host;
    host.append(this.renderer.domElement, this.labels.domElement);
    this.resizeObserver.observe(host);
    this.resize();
  }

  /** 새 결과. 배 로트를 다시 만든다. */
  load(ships: string[]): void {
    for (const lot of this.lots.values()) {
      this.scene.remove(lot.group);
      // CSS2D 라벨은 부모를 지워도 DOM에 남는다. 직접 뗀다.
      lot.tag.element.remove();
    }
    this.lots.clear();
    ships.forEach((id, i) => {
      const lot = new Lot(id);
      lot.floatPhase = i * 1.7;
      lot.group.visible = false;
      this.lots.set(id, lot);
      this.scene.add(lot.group);
    });
  }

  setSource(source: DaySource): void {
    this.source = source;
    this.sourceAt = performance.now();
    this.draw(source.snap);
  }

  setCamera(mode: CameraMode, station: number | null = null): void {
    if (mode === "control" || station === null) {
      this.camGoal.pos.set(1, 22, 16.5);
      this.camGoal.target.set(1, 0, -1.8);
    } else {
      const x = STATION_X[station];
      this.camGoal.pos.set(x + 2.2, 4.6, 8.2);
      this.camGoal.target.set(x, 0.5, 0.6);
    }
    this.camMoving = 1;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer.reset();
    const loop = (now: number) => {
      if (!this.running) return;
      this.timer.update(now);
      this.frame();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
  }

  // ----- 매 프레임 -----

  private resize(): void {
    if (!this.host) return;
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private frame(): void {
    const dt = Math.min(this.timer.getDelta(), 0.05);
    const t = this.timer.getElapsed();
    this.draw(false);
    for (const p of [...this.people, this.senior, this.manager]) p.update(dt);
    for (const lot of this.lots.values()) {
      if (!lot.group.visible) continue;
      lot.group.position.lerp(lot.target, Math.min(1, dt * 10));
    }
    this.animateProps(t);
    if (this.camMoving > 0) {
      const k = Math.min(1, dt * 3);
      this.camera.position.lerp(this.camGoal.pos, k);
      this.controls.target.lerp(this.camGoal.target, k);
      if (this.camera.position.distanceTo(this.camGoal.pos) < 0.05) this.camMoving = 0;
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }

  private draw(snap: boolean): void {
    const src = this.source;
    if (!src) return;
    const frac = src.playing ? clamp01((performance.now() - this.sourceAt) / src.msPerDay) : 1;
    const f = src.frameAt(frac);
    const jump = snap || src.snap;

    // 로트
    let hook: { x: number; y: number } | null = null;
    for (const view of f.lots) {
      const lot = this.lots.get(view.ship);
      if (!lot) continue;
      lot.group.visible = view.place !== "hidden";
      if (!lot.group.visible) continue;
      const pos = this.lotPosition(view, frac, f);
      lot.target.copy(pos);
      if (jump || view.place === "carried" || view.place === "sea") lot.group.position.copy(pos);
      lot.setForm(view.form, view.place === "bench");
      lot.animateCut(view.place === "bench" && view.station === 0 && (view.state === "work" || view.state === "rework"), performance.now() / 1000);
      if (view.place === "sea") {
        lot.group.rotation.set(Math.sin(lot.floatPhase * 1.1) * 0.04, 0.6 + lot.floatPhase, Math.sin(lot.floatPhase * 1.3) * 0.05);
      } else {
        lot.group.rotation.set(0, 0, 0);
      }
      if (view.place === "bench" && view.station === 3 && lot.hookX !== null) hook = { x: lot.hookX, y: lot.hookY };
      setLabel(lot.tag, this.lotLabel(view));
      lot.tag.position.y = view.form >= 3 ? 1.9 : 1.0;
    }

    // 크레인 훅: 탑재 중이면 블록을 따라간다.
    const hx = hook ? hook.x : 0;
    const hy = hook ? hook.y + 0.15 : 2.4;
    this.trolley.position.x = hx;
    const len = 3.1 - hy;
    this.hook.scale.y = Math.max(0.05, len);
    this.hook.position.set(hx, 3.1 - len / 2, 0);

    // 정반: 인원, 시니어, 중지, 잔업
    let person = 0;
    f.stations.forEach((st, i) => {
      const x = STATION_X[i];
      const props = this.stationProps[i];
      const working = st.state === "work" || st.state === "rework";
      for (let k = 0; k < st.workers; k++) {
        const side = k % 2 === 0 ? 1 : -1;
        const at = new THREE.Vector3(x - 0.9 * side, MAT_TOP, side * 1.0);
        const p = this.people[person++];
        p?.place(at, side > 0 ? Math.PI : 0, working ? "work" : "stand", jump);
        p?.holdKnife(i === 0 && working);
      }
      if (st.senior) {
        this.senior.root.visible = true;
        this.senior.place(new THREE.Vector3(x + 1.3, MAT_TOP, -0.2), -Math.PI / 2, working ? "work" : "stand", jump);
        this.senior.holdKnife(i === 0 && working);
      }
      props.smoke.visible = st.stop === "breakdown";
      props.tape.visible = st.stop === "accident";
      props.candle.intensity = st.overtime ? 5 : 0;
      props.flame.visible = st.overtime;
      const chip = st.stop === "accident" ? chipHtml("accident_stop", "사고 · 통제")
        : st.stop === "breakdown" ? chipHtml("breakdown_stop", "고장 · 수리 중")
        : st.state === "labor_wait" ? chipHtml("labor_wait", "인력 대기")
        : st.state === "material_wait" ? chipHtml("material_wait", "자재 대기")
        : i === 0 && working ? `<span class="chip cut">절단 중</span>` : "";
      setLabel(props.tag, `<i style="background:${STATION_COLOR[st.id]}"></i>${st.name}${st.overtime ? " · 잔업" : ""}${chip}`);
    });
    if (!f.stations.some((st) => st.senior)) this.senior.root.visible = false;

    // 작업대기소: 오늘 배정되지 않은 사람은 앉아서 기다린다(인원 과다가 보인다).
    for (let k = 0; k < f.idleWorkers && person < this.people.length; k++) {
      this.people[person].holdKnife(false);
      this.people[person++].place(this.loungeSeat(k), 0, "sit", jump);
    }
    const used = person;
    this.people.forEach((p, i) => { p.root.visible = i < used; });
    setLabel(this.lounge, `작업대기소 · 쉬는 사람 <b>${f.idleWorkers}</b>명`);

    // 트랜스포터
    f.transporters.forEach((tr, k) => {
      const cart = this.carts[k];
      cart.group.visible = true;
      const lot = tr.ship ? f.lots.find((l) => l.ship === tr.ship) : undefined;
      let at: THREE.Vector3;
      if (tr.state === "move" && lot) {
        at = lot.place === "carried"
          ? this.lotPosition(lot, frac, f).setY(0)
          : new THREE.Vector3(STATION_X[lot.station] - 1.4, 0, LANE_Z);
      } else if (tr.state === "breakdown_stop") {
        at = cart.group.position.clone();
      } else {
        at = new THREE.Vector3(DEPOT.x, 0, LANE_Z + k * 1.15);
      }
      cart.group.position.lerp(at, jump ? 1 : 0.2);
      cart.smoke.visible = tr.state === "breakdown_stop";
      setLabel(cart.tag, tr.state === "breakdown_stop" ? `${tr.id} ${chipHtml("breakdown_stop", "고장")}` : tr.id);
    });
    for (let k = f.transporters.length; k < this.carts.length; k++) this.carts[k].group.visible = false;

    // 자재창고: 선반이 비면 "입고 D-n" 팻말
    f.shelves.forEach((sh, i) => {
      const shelf = this.shelves[i];
      const shown = Math.min(sh.qty, shelf.boxes.length);
      shelf.boxes.forEach((b, k) => { b.visible = k < shown; });
      const note = sh.qty > 0 ? `<b>${sh.qty}</b>` : sh.nextArrival ? chipHtml("material_wait", `입고 D-${sh.nextArrival - f.day}`) : "<b>0</b>";
      setLabel(shelf.tag, `${sh.name} ${note}`);
    });

    // 연구소
    const rs = f.research;
    this.labWindow.emissive.set(rs.current ? "#7fd1ff" : "#000000");
    this.labWindow.emissiveIntensity = rs.current ? 0.8 : 0;
    const now = rs.current ? `${rs.current.name} ${rs.current.done}/${rs.current.total}일` : "진행 중인 연구 없음";
    const done = rs.finished.length ? `<br><small>완료: ${rs.finished.join(", ")}</small>` : "";
    setLabel(this.labTag, `연구소 · ${now}${done}`);
  }

  private lotPosition(view: LotView, frac: number, f: Frame): THREE.Vector3 {
    const x = STATION_X[view.station];
    switch (view.place) {
      case "bench": return new THREE.Vector3(x, MAT_TOP, 0);
      case "queue": return new THREE.Vector3(x - 0.9 - view.slot * 1.9, 0, QUEUE_Z);
      case "outbound": return new THREE.Vector3(x + 1.2 + view.slot * 1.9, 0, QUEUE_Z);
      case "carried": {
        const from = x + 1.2, to = STATION_X[view.station + 1] - 0.9;
        return new THREE.Vector3(from + (to - from) * ease(frac), 0.32, LANE_Z);
      }
      case "sea": {
        const lot = this.lots.get(view.ship)!;
        lot.floatPhase += 0.016;
        const i = f.lots.filter((l) => l.place === "sea").indexOf(view);
        const a = i * 1.6;
        return new THREE.Vector3(CUP.x + Math.cos(a) * 1.1, WATER_Y + Math.sin(lot.floatPhase * 1.6) * 0.04, CUP.z + Math.sin(a) * 1.1);
      }
      default: return new THREE.Vector3(DEPOT.x, -5, 0);
    }
  }

  private lotLabel(view: LotView): string {
    const chip = view.state === "rework" ? chipHtml("rework", "재작업")
      : view.place === "bench" && view.state === "work" ? ""
      : view.place === "sea" ? (view.late ? `<span class="chip late">지연 인도</span>` : "")
      : STATE_INFO[view.state] ? chipHtml(view.state, STATE_INFO[view.state].name) : "";
    return `<b>${view.ship}</b>${chip}`;
  }

  private animateProps(t: number): void {
    const puffs = (g: THREE.Group, height: number) => {
      if (!g.visible) return;
      g.children.forEach((c, k) => {
        const u = (t * 0.6 + k / g.children.length) % 1;
        c.position.set(Math.sin(k * 2.1 + t) * 0.15, u * height, Math.cos(k * 1.7) * 0.15);
        c.scale.setScalar(0.6 + u * 1.2);
        ((c as THREE.Mesh).material as THREE.MeshStandardMaterial).opacity = 0.6 * (1 - u);
      });
    };
    this.stationProps.forEach((p) => {
      puffs(p.smoke, 2.2);
      p.flame.scale.set(1, 1 + Math.sin(t * 13) * 0.12, 1);
    });
    this.carts.forEach((c) => puffs(c.smoke, 1.4));
  }
}

function chipHtml(state: string, text: string): string {
  const info = STATE_INFO[state];
  const light = state === "material_wait" || state === "labor_wait";
  return `<span class="chip" style="background:${info?.color ?? "#898781"};color:${light ? "#1f2a24" : "#fff"}">${text}</span>`;
}
