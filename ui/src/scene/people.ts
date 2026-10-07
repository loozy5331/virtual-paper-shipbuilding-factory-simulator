// 소인: 정반에서 일하거나, 작업대기소에 앉아 있거나, 그 사이를 걷는다.
// 작업모 색은 색각 검증을 통과한 값이다. 손실색과 겹치므로 어두운 테두리를 두고, 시니어는 흰 띠로도 구분한다.

import * as THREE from "three";

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
  /** 오른손의 칼. 소조립(절단)에서 일할 때만 든다. */
  private readonly knife = new THREE.Group();

  constructor(role: Role) {
    const skin = "#f0c8a0";
    const cloth = role === "manager" ? "#3d4a5c" : "#5c6b62";
    for (const [leg, x] of [[this.legL, -0.05], [this.legR, 0.05]] as const) {
      const m = mesh(new THREE.CylinderGeometry(0.035, 0.03, 0.22, 8), "#4a3b30");
      m.position.y = -0.11;
      const shoe = mesh(new THREE.BoxGeometry(0.06, 0.03, 0.09), "#2e241c");
      shoe.position.set(0, -0.22, 0.015);
      leg.add(m, shoe);
      leg.position.set(x, 0.24, 0);
      this.root.add(leg);
    }
    const tunic = mesh(new THREE.CylinderGeometry(0.075, 0.115, 0.26, 10), cloth);
    tunic.position.y = 0.36;
    this.torso.add(tunic);
    if (role === "manager") {
      // 관리자 조끼와 태블릿
      const vest = mesh(new THREE.CylinderGeometry(0.08, 0.118, 0.2, 10, 1, true), HAT.manager, { side: THREE.DoubleSide });
      vest.position.y = 0.38;
      const tablet = mesh(new THREE.BoxGeometry(0.1, 0.07, 0.01), "#22303c");
      tablet.position.set(0, 0.4, 0.13);
      tablet.rotation.x = -0.5;
      this.torso.add(vest, tablet);
    }
    this.head = mesh(new THREE.SphereGeometry(0.075, 14, 10), skin);
    this.head.position.y = 0.56;
    for (const ex of [-0.027, 0.027]) {
      const eye = new THREE.Mesh(new THREE.SphereGeometry(0.01, 6, 4), new THREE.MeshBasicMaterial({ color: "#1c1c1c" }));
      eye.position.set(ex, 0.005, 0.07);
      this.head.add(eye);
    }
    // 작업모: 반구 + 챙, 아래에 어두운 테두리
    const hat = mesh(new THREE.SphereGeometry(0.084, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), HAT[role]);
    hat.position.y = 0.012;
    const brim = mesh(new THREE.CylinderGeometry(0.105, 0.105, 0.014, 16), "#2b2b2b");
    brim.position.y = 0.012;
    this.head.add(hat, brim);
    if (role === "senior") {
      const band = mesh(new THREE.CylinderGeometry(0.086, 0.086, 0.022, 16), "#ffffff");
      band.position.y = 0.04;
      this.head.add(band);
    }
    this.torso.add(this.head);
    for (const [arm, x] of [[this.armL, -0.1], [this.armR, 0.1]] as const) {
      const m = mesh(new THREE.CylinderGeometry(0.025, 0.022, 0.2, 8), cloth);
      m.position.y = -0.1;
      const hand = mesh(new THREE.SphereGeometry(0.026, 8, 6), skin);
      hand.position.y = -0.21;
      arm.add(m, hand);
      arm.position.set(x, 0.46, 0);
      this.torso.add(arm);
    }
    const handle = mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.08, 6), "#7a5532");
    handle.position.y = -0.04;
    const blade = mesh(new THREE.BoxGeometry(0.025, 0.2, 0.07), "#dfe4ea", { metalness: 0.6, roughness: 0.25, emissive: "#2a2f36" });
    blade.position.y = -0.18;
    this.knife.add(handle, blade);
    this.knife.position.y = -0.22;
    this.knife.rotation.x = Math.PI / 2;
    this.knife.visible = false;
    this.armR.add(this.knife);
    this.root.add(this.torso);
    this.root.scale.setScalar(1.8);
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
    }
  }

  update(dt: number): void {
    this.phase += dt;
    const pos = this.root.position;
    const toTarget = this.target.clone().sub(pos);
    toTarget.y = 0;
    const walking = toTarget.length() > 0.05;
    if (walking) {
      pos.addScaledVector(toTarget.normalize(), Math.min(toTarget.length(), 3.2 * dt));
      pos.y = this.target.y;
      this.turn(Math.atan2(toTarget.x, toTarget.z), dt);
    } else {
      this.turn(this.facing, dt);
    }

    const p = this.phase;
    this.legL.rotation.x = this.legR.rotation.x = 0;
    this.torso.rotation.x = 0;
    this.torso.position.y = 0;
    if (walking) {
      const swing = Math.sin(p * 9) * 0.6;
      this.legL.rotation.x = swing;
      this.legR.rotation.x = -swing;
      this.armL.rotation.x = -swing * 0.8;
      this.armR.rotation.x = swing * 0.8;
      this.torso.position.y = Math.abs(Math.sin(p * 9)) * 0.02;
    } else if (this.pose === "work") {
      this.armR.rotation.x = -1.25 + Math.sin(p * 11) * 0.65;
      this.armL.rotation.x = -0.7 + Math.sin(p * 11 + 1.5) * 0.15;
      this.torso.rotation.x = 0.18 + Math.sin(p * 11) * 0.04;
    } else if (this.pose === "sit") {
      this.legL.rotation.x = this.legR.rotation.x = -1.4;
      this.torso.position.y = -0.17;
      this.armL.rotation.x = this.armR.rotation.x = -0.35;
      this.head.rotation.y = Math.sin(p * 0.5) * 0.5;
    } else {
      this.armL.rotation.x = this.armR.rotation.x = Math.sin(p * 1.5) * 0.05;
      this.head.rotation.y = Math.sin(p * 0.7) * 0.6;
    }
  }

  private turn(angle: number, dt: number): void {
    let d = angle - this.root.rotation.y;
    d = Math.atan2(Math.sin(d), Math.cos(d));
    this.root.rotation.y += d * Math.min(1, dt * 8);
  }
}
