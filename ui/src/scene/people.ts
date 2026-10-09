// 소인: 정반에서 일하거나, 작업대기소에 앉아 있거나, 그 사이를 걷는다.
// 생김새는 정원 노움 같은 소인국 사람(2.1): 고깔모자, 둥근 코, 짧은 다리, 둥근 배, 수염.
// 고깔모자 색이 역할이다(색각 검증을 통과한 작업모 색). 안전은 고깔 대신 전신 안전벨트(하네스)로 보여 준다. 손실색과 겹치므로 어두운 테두리를 두고, 시니어는 흰 띠로도 구분한다.
//
// 그림 스타일 둘(2.1): 관제실 CCTV는 "익명" — 모두 같은 체격, 눈·수염·머리 없음, 이름 없음(누군지 알 수 없다).
// 작업모를 쓰고 직접 나간 현장은 "일러스트" — 사람마다 얼굴, 수염과 머리, 피부색, 체격이 다르고 이름표를 단다.
// 원격으로는 공정을 보고, 사람은 직접 가야 보인다(근태 감시 우려에 대한 설계상의 답).

import * as THREE from "three";
import { CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";

export type SceneStyle = "cctv" | "field";

// 현장에서 보이는 생김새. 사람 번호로 고른다(결정적: 같은 사람은 늘 같은 모습).
const SKIN = ["#f0c8a0", "#e2b48c", "#c99a74", "#f5d2b0", "#d8a982"];
const HAIR = ["#e9e5dc", "#2b2018", "#9a9a9a", "#6b4a2f", "#b5562b", "#1a1a1a", "#4a3222", "#2f2a26"];
const BUILD = [[1.0, 1.0], [1.06, 0.96], [0.94, 1.06], [1.03, 1.08], [0.97, 0.94]] as const;   // [키, 체격]
// 가상 인물 이름. 실제 사람이 아니다.
export const WORKER_NAMES = ["김하늘", "이도윤", "박서연", "최민준", "정지우", "강예린", "조현우", "윤서진"];
export const SENIOR_NAME = "한정호 반장";

export const HAT = { worker: "#d6a400", manager: "#d9480f", senior: "#6f42c1" } as const;
export type Role = keyof typeof HAT;

export function mesh(geometry: THREE.BufferGeometry, color: THREE.ColorRepresentation,
  opts: THREE.MeshStandardMaterialParameters = {}): THREE.Mesh {
  const m = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...opts }));
  m.castShadow = true;
  m.receiveShadow = true;
  return m;
}

export type Pose = "work" | "sit" | "stand";

/** 몸통: 아래가 넓고 배가 둥근 노움 체형. 회전체라 이음매 없이 매끈하다. */
const BODY = [[0, 0.12], [0.1, 0.13], [0.125, 0.18], [0.13, 0.25], [0.115, 0.32], [0.085, 0.37], [0.05, 0.395], [0, 0.4]] as const;
const HEAD_Y = 0.46;
const HAT_H = 0.24;

/** 몸통 반지름(높이 y에서). 하네스 끈이 몸에 붙어 지나가게 한다. */
function bodyRadius(y: number): number {
  for (let i = 1; i < BODY.length; i++) {
    const [r0, y0] = BODY[i - 1];
    const [r1, y1] = BODY[i];
    if (y <= y1) return r0 + (r1 - r0) * ((y - y0) / (y1 - y0));
  }
  return 0;
}

/** 몸에 붙은 끈: 정해 둔 높이들을 지나는 매끈한 관. side 1이면 앞, -1이면 뒤. */
function strap(x: number, ys: number[], side: 1 | -1, color: string): THREE.Mesh {
  const pts = ys.map((y) => new THREE.Vector3(x, y, side * (Math.sqrt(Math.max(0, bodyRadius(y) ** 2 - x * x)) + 0.006)));
  return mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 16, 0.008, 6), color);
}

const HARNESS = "#2f3742";   // 안전벨트 끈: 역할 색과 겹치지 않는 어두운 남색

/** 고깔모자: 끝이 뒤로 살짝 휜 원뿔. */
function hatGeometry(): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(0.092, HAT_H, 28, 6);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const t = (pos.getY(i) + HAT_H / 2) / HAT_H;
    pos.setZ(i, pos.getZ(i) - 0.07 * t * t);
  }
  g.computeVertexNormals();
  return g;
}

/** 값을 목표로 부드럽게 옮긴다(자세가 바뀔 때 툭 끊기지 않게). */
function damp(from: number, to: number, k: number): number {
  return from + (to - from) * k;
}

export class Person {
  readonly root = new THREE.Group();
  private readonly armL = new THREE.Group();
  private readonly armR = new THREE.Group();
  private readonly legL = new THREE.Group();
  private readonly legR = new THREE.Group();
  private readonly torso = new THREE.Group();
  private readonly head: THREE.Mesh;
  private readonly target = new THREE.Vector3();
  private facing = 0;
  private pose: Pose = "stand";
  private phase = Math.random() * 10;
  private speed = 0;
  /** 오른손의 칼. 소조립(절단)에서 일할 때만 든다. */
  private readonly knife = new THREE.Group();
  /** 현장(일러스트)에서만 보이는 얼굴, 수염과 머리, 이름표 */
  private readonly face = new THREE.Group();
  private readonly hair = new THREE.Group();
  readonly nameTag: CSS2DObject;
  private readonly build: readonly [number, number];
  private readonly skinMeshes: THREE.Mesh[] = [];
  private readonly fieldSkin: THREE.Color;
  private style: SceneStyle = "cctv";
  private tagShown = true;

  constructor(role: Role, look = 0, name = "") {
    const skin = "#f0c8a0";
    this.build = BUILD[look % BUILD.length];
    this.fieldSkin = new THREE.Color(SKIN[look % SKIN.length]);
    const hairColor = HAIR[look % HAIR.length];
    const cloth = role === "manager" ? "#3d4a5c" : "#5c6b62";

    // 짧은 다리와 둥근 장화
    for (const [leg, x] of [[this.legL, -0.045], [this.legR, 0.045]] as const) {
      const m = mesh(new THREE.CapsuleGeometry(0.032, 0.07, 6, 14), "#4a3b30");
      m.position.y = -0.07;
      const boot = mesh(new THREE.SphereGeometry(0.045, 16, 10), "#3a2a1e");
      boot.scale.set(1, 0.6, 1.4);
      boot.position.set(0, -0.125, 0.02);
      leg.add(m, boot);
      leg.position.set(x, 0.15, 0);
      this.root.add(leg);
    }

    const body = mesh(new THREE.LatheGeometry(BODY.map(([r, y]) => new THREE.Vector2(r, y)), 28), cloth);
    const belt = mesh(new THREE.TorusGeometry(0.128, 0.012, 8, 32), "#3b2a1d");
    belt.rotation.x = Math.PI / 2;
    belt.position.y = 0.2;
    const buckle = mesh(new THREE.BoxGeometry(0.04, 0.03, 0.012), "#c9a640", { metalness: 0.4, roughness: 0.5 });
    buckle.position.set(0, 0.2, 0.135);
    this.torso.add(body, belt, buckle);
    // 전신 안전벨트(하네스): 어깨끈 둘이 어깨를 넘어 등으로, 가슴끈, 등의 D링. 다리 고리는 다리에 단다.
    for (const x of [-0.05, 0.05]) {
      this.torso.add(strap(x, [0.2, 0.26, 0.32, 0.36], 1, HARNESS), strap(x, [0.2, 0.26, 0.32, 0.36], -1, HARNESS));
      const over = mesh(new THREE.TorusGeometry(Math.sqrt(bodyRadius(0.36) ** 2 - x * x) + 0.006, 0.008, 6, 16, Math.PI), HARNESS);
      over.rotation.y = Math.PI / 2;
      over.position.set(x, 0.36, 0);
      over.scale.y = 0.45;
      this.torso.add(over);
    }
    const cz = bodyRadius(0.3);
    const chest = mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.06, 0.3, Math.sqrt(cz * cz - 0.0036) + 0.008), new THREE.Vector3(0, 0.3, cz + 0.012),
      new THREE.Vector3(0.06, 0.3, Math.sqrt(cz * cz - 0.0036) + 0.008)]), 8, 0.008, 6), HARNESS);
    const dRing = mesh(new THREE.TorusGeometry(0.016, 0.004, 6, 16), "#b9bec4", { metalness: 0.6, roughness: 0.35 });
    dRing.position.set(0, 0.33, -bodyRadius(0.33) - 0.012);
    this.torso.add(chest, dRing);
    for (const leg of [this.legL, this.legR]) {
      const loop = mesh(new THREE.TorusGeometry(0.037, 0.008, 6, 20), HARNESS);
      loop.rotation.x = Math.PI / 2;
      loop.position.y = -0.02;
      leg.add(loop);
    }
    if (role === "manager") {
      // 관리자 조끼와 태블릿
      const vestProfile = BODY.slice(2, 6).map(([r, y]) => new THREE.Vector2(r * 1.06, y));
      const vest = mesh(new THREE.LatheGeometry(vestProfile, 28), HAT.manager, { side: THREE.DoubleSide });
      const tablet = mesh(new THREE.BoxGeometry(0.1, 0.07, 0.01), "#22303c");
      tablet.position.set(0, 0.28, 0.16);
      tablet.rotation.x = -0.5;
      this.torso.add(vest, tablet);
    }

    this.head = mesh(new THREE.SphereGeometry(0.08, 24, 18), skin);
    this.head.position.y = HEAD_Y;
    this.skinMeshes.push(this.head);
    // 둥근 코: 노움의 실루엣이라 CCTV에서도 보인다.
    const nose = mesh(new THREE.SphereGeometry(0.03, 16, 12), skin);
    nose.position.set(0, -0.005, 0.08);
    this.skinMeshes.push(nose);
    this.head.add(nose);

    // 얼굴(현장에서만): 눈, 눈썹. 수염이 없는 사람은 입도.
    const ink = new THREE.MeshBasicMaterial({ color: "#1c1c1c" });
    for (const ex of [-0.03, 0.03]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), ink);
      eye.scale.set(1, 1.3, 0.6);
      eye.position.set(ex, 0.024, 0.071);
      const brow = new THREE.Mesh(new THREE.CapsuleGeometry(0.004, 0.02, 2, 6), new THREE.MeshBasicMaterial({ color: hairColor }));
      brow.rotation.z = Math.PI / 2 + (ex < 0 ? 0.2 : -0.2) * ((look % 3) - 1);
      brow.position.set(ex, 0.045, 0.067);
      this.face.add(eye, brow);
    }
    // 수염과 머리(현장에서만): 번호에 따라 긴 수염 / 짧은 수염 / 수염 없이 땋은 머리.
    const kind = look % 3;
    if (kind === 0 || kind === 1) {
      const beard = kind === 0
        ? mesh(new THREE.ConeGeometry(0.075, 0.17, 24), hairColor)
        : mesh(new THREE.SphereGeometry(0.07, 20, 14), hairColor);
      if (kind === 0) {
        beard.rotation.x = Math.PI;   // 끝이 아래로
        beard.position.set(0, -0.1, 0.04);
        beard.scale.z = 0.7;
      } else {
        beard.scale.set(1, 0.8, 0.6);
        beard.position.set(0, -0.045, 0.045);
      }
      const moustache = mesh(new THREE.CapsuleGeometry(0.012, 0.05, 4, 10), hairColor);
      moustache.rotation.z = Math.PI / 2;
      moustache.position.set(0, -0.032, 0.083);
      this.face.add(beard, moustache);
    } else {
      const mouth = new THREE.Mesh(new THREE.TorusGeometry(0.013, 0.003, 4, 12, Math.PI), new THREE.MeshBasicMaterial({ color: "#7a3b30" }));
      mouth.position.set(0, -0.04, 0.072);
      mouth.rotation.z = Math.PI;
      this.face.add(mouth);
      for (const bx of [-0.07, 0.07]) {
        const braid = mesh(new THREE.CapsuleGeometry(0.016, 0.08, 4, 10), hairColor);
        braid.position.set(bx, -0.07, -0.01);
        this.hair.add(braid);
      }
    }
    const back = mesh(new THREE.SphereGeometry(0.083, 24, 12, 0, Math.PI * 2, Math.PI * 0.3, Math.PI * 0.4), hairColor);
    back.rotation.x = -0.5;
    back.position.z = -0.006;
    this.hair.add(back);
    this.face.visible = false;
    this.hair.visible = false;
    this.head.add(this.face, this.hair);

    // 고깔모자 + 어두운 테두리, 시니어는 흰 띠
    const hat = mesh(hatGeometry(), HAT[role]);
    hat.position.y = 0.02 + HAT_H / 2;
    const brim = mesh(new THREE.TorusGeometry(0.092, 0.013, 8, 32), "#2b2b2b");
    brim.rotation.x = Math.PI / 2;
    brim.position.y = 0.02;
    this.head.add(hat, brim);
    if (role === "senior") {
      const band = mesh(new THREE.TorusGeometry(0.077, 0.012, 8, 32), "#ffffff");
      band.rotation.x = Math.PI / 2;
      band.position.y = 0.065;
      this.head.add(band);
    }
    this.torso.add(this.head);

    for (const [arm, x] of [[this.armL, -0.115], [this.armR, 0.115]] as const) {
      const m = mesh(new THREE.CapsuleGeometry(0.026, 0.1, 6, 12), cloth);
      m.position.y = -0.07;
      const hand = mesh(new THREE.SphereGeometry(0.032, 16, 12), skin);
      hand.position.y = -0.15;
      this.skinMeshes.push(hand);
      arm.add(m, hand);
      arm.position.set(x, 0.34, 0);
      this.torso.add(arm);
    }
    const handle = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.08, 10), "#7a5532");
    handle.position.y = -0.04;
    const blade = mesh(new THREE.BoxGeometry(0.025, 0.2, 0.07), "#dfe4ea", { metalness: 0.6, roughness: 0.25, emissive: "#2a2f36" });
    blade.position.y = -0.18;
    this.knife.add(handle, blade);
    this.knife.position.y = -0.17;
    this.knife.rotation.x = Math.PI / 2;
    this.knife.visible = false;
    this.armR.add(this.knife);
    this.root.add(this.torso);
    this.root.scale.setScalar(1.8);

    // 이름표(현장에서만): 고깔모자 끝 바로 위 작은 팻말. 머리에 붙여 앉거나 숙여도 따라간다. 가상 인물이다.
    const tag = document.createElement("div");
    tag.className = "name-tag";
    tag.textContent = name;
    this.nameTag = new CSS2DObject(tag);
    this.nameTag.position.set(0, 0.33, -0.05);
    this.nameTag.visible = false;
    this.head.add(this.nameTag);
  }

  setName(name: string): void {
    this.nameTag.element.textContent = name;
    this.setVisible(this.root.visible);
  }

  /** 보이기/숨기기. CSS2D 이름표는 부모를 숨겨도 남으므로 함께 숨긴다. */
  setVisible(visible: boolean): void {
    this.root.visible = visible;
    this.syncTag();
  }

  /** 이름표는 현장에서 가까이 볼 때만(전경에서는 겹치고, "가까이 가야 사람이 보인다"). */
  showTag(on: boolean): void {
    this.tagShown = on;
    this.syncTag();
  }

  private syncTag(): void {
    this.nameTag.visible = this.root.visible && this.tagShown && this.style === "field" && this.nameTag.element.textContent !== "";
  }

  /** CCTV(익명): 같은 체격, 눈·수염·머리·이름 없음. 현장(일러스트): 사람마다 다른 생김새와 이름표. */
  setStyle(style: SceneStyle): void {
    this.style = style;
    const field = style === "field";
    this.face.visible = field;
    this.hair.visible = field;
    this.syncTag();
    const [height, width] = field ? this.build : [1, 1];
    this.root.scale.set(1.8 * width, 1.8 * height, 1.8 * width);
    for (const m of this.skinMeshes) {
      (m.material as THREE.MeshStandardMaterial).color.set(field ? this.fieldSkin : "#f0c8a0");
    }
  }

  holdKnife(on: boolean): void {
    this.knife.visible = on;
  }

  /** 가야 할 자리와 자세. snap이면 걷지 않고 바로 옮긴다(배속이 빠르거나 날짜를 건너뛸 때). */
  place(at: THREE.Vector3, facing: number, pose: Pose, snap: boolean): void {
    this.target.copy(at);
    this.facing = facing;
    this.pose = pose;
    if (snap) {
      this.root.position.copy(at);
      this.root.rotation.y = facing;
      this.speed = 0;
    }
  }

  update(dt: number): void {
    this.phase += dt;
    const pos = this.root.position;
    const toTarget = this.target.clone().sub(pos);
    toTarget.y = 0;
    const dist = toTarget.length();
    const walking = dist > 0.05;
    // 걸음: 출발할 때 빨라지고 도착할 때 느려진다.
    const want = walking ? Math.min(3.2, dist * 4) : 0;
    this.speed = damp(this.speed, want, Math.min(1, dt * 6));
    if (walking) {
      pos.addScaledVector(toTarget.normalize(), Math.min(dist, this.speed * dt));
      pos.y = this.target.y;
      this.turn(Math.atan2(toTarget.x, toTarget.z), dt);
    } else {
      this.turn(this.facing, dt);
    }

    // 자세마다 목표 각도를 정하고, 지금 각도에서 부드럽게 옮긴다.
    const p = this.phase;
    const breath = Math.sin(p * 2.2) * 0.004;
    let legL = 0, legR = 0, armL = 0, armR = 0, lean = 0, sway = 0, lift = breath, look = 0;
    if (walking) {
      const stride = Math.min(1, this.speed / 2);
      const swing = Math.sin(p * 10) * 0.7 * stride;
      legL = swing;
      legR = -swing;
      armL = -swing * 0.8;
      armR = swing * 0.8;
      sway = Math.sin(p * 10) * 0.06 * stride;   // 짧은 다리라 몸이 좌우로 뒤뚱인다
      lift = Math.abs(Math.sin(p * 10)) * 0.018 * stride;
      lean = 0.08 * stride;
    } else if (this.pose === "work") {
      // 작업: 천천히 들어 올리고 빠르게 내려친다.
      const t = (p * 1.6) % 1;
      const up = t < 0.75 ? THREE.MathUtils.smootherstep(t / 0.75, 0, 1) : 1 - (t - 0.75) / 0.25;
      armR = -0.5 - 1.3 * up;
      armL = -0.7 + Math.sin(p * 3) * 0.1;
      lean = 0.12 + (1 - up) * 0.1;
    } else if (this.pose === "sit") {
      legL = legR = -1.4;
      lift = -0.08 + breath;
      armL = armR = -0.35;
      look = Math.sin(p * 0.5) * 0.5;
    } else {
      armL = armR = Math.sin(p * 1.5) * 0.05;
      look = Math.sin(p * 0.7) * 0.6;
    }
    const k = Math.min(1, dt * 12);
    this.legL.rotation.x = damp(this.legL.rotation.x, legL, k);
    this.legR.rotation.x = damp(this.legR.rotation.x, legR, k);
    this.armL.rotation.x = damp(this.armL.rotation.x, armL, this.pose === "work" ? 1 : k);
    this.armR.rotation.x = damp(this.armR.rotation.x, armR, this.pose === "work" ? 1 : k);
    this.torso.rotation.x = damp(this.torso.rotation.x, lean, k);
    this.torso.rotation.z = damp(this.torso.rotation.z, sway, k);
    this.torso.position.y = damp(this.torso.position.y, lift, k);
    this.head.rotation.y = damp(this.head.rotation.y, look, Math.min(1, dt * 4));
  }

  private turn(angle: number, dt: number): void {
    let d = angle - this.root.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.root.rotation.y += d * Math.min(1, dt * 8);
  }
}
