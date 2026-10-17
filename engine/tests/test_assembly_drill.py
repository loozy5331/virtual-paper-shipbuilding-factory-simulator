"""조립 현장 배정(4.30, D77)과 몰리는 날의 결정(4.31·4.32, D78·D79) 검증. 규칙 문서 3장 "몰리는 날의 결정"과 10장 예시 11·12.

결정은 예시 9의 판(test_blocks.mini)으로 손 계산한다. 실습 판(assembly)은 등급 조율(D70)과 결정 지점만 본다.
"""

import copy
import unittest

from shipyard import ConfigError, forecast, load_presets, load_scenario, simulate

from tests.test_blocks import mini

ASM = ("sub_assembly", "block_assembly")


def manual_mini(budget=100):
    """예시 9의 판(X 피더 1순위, Y 예인선 2순위, 소조립 작업장 1곳, 조립 6명 = 가용 48 MH)에서 소조립을 직접 대응으로."""
    cfg, sc = mini([("X", "FEEDER", 1, 40), ("Y", "TUG", 2, 40)])
    sc["options"] = {"crews": ["normal"], "methods": ["standard"], "material_grades": ["standard"], "max_units": 2,
                     "split": False, "decisions": True}
    sc["decision_stations"] = ["sub_assembly"]
    sc["contingency"] = {"sub_assembly": budget}
    sc["contingency_max"] = 500
    cfg["stations"]["sub_assembly"]["dispatch_mode"] = "manual"
    return cfg, sc


def done_days(result, ship):
    return [b["done_day"] for b in result["blocks"] if b["ship"] == ship and b["station"] == "sub_assembly"]


def play(cfg, choose, sc=None):
    """결정 기록을 비워 두고 처음 묻는 날마다 choose(situation)로 정하며 끝까지(화면이 하는 일)."""
    cfg = copy.deepcopy(cfg)
    cfg["decisions"] = []
    while True:
        r = simulate(cfg, sc, baseline=False)
        if not r["pending"]:
            return cfg, r
        cfg["decisions"].append(choose(r["pending"]))


def both_manual():
    """B안에서 중조립도 직접 대응(선배의 팁: 병목 공정에서 묻기)."""
    cfg = copy.deepcopy(load_presets("assembly")[1]["config"])
    cfg["stations"]["block_assembly"]["dispatch_mode"] = "manual"
    return cfg


def policy(rule, act=None):
    """몰리는 날마다 직접 대응 공정 정책을 rule로, act(블록 줄)가 주는 조치를 예산 안에서."""
    def choose(pd):
        actions = {}
        for st in pd["stations"].values():
            left = st["budget_left"]
            for w in st["waiting"]:
                kind = act(w) if act else None   # 조치 하나(문자열) 또는 여러 개(목록, 4.42)
                cost = sum(w["quotes"][k]["cost"] for k in ([kind] if isinstance(kind, str) else kind or []))
                if kind and cost <= left:
                    actions[w["id"]] = kind
                    left -= cost
        return {"day": pd["day"], "policy": {sid: rule for sid, st in pd["stations"].items() if st["manual"]}, "actions": actions}
    return choose


class Example11(unittest.TestCase):
    """10장 예시 11: 1일에 X 소조립 8블록(6 MH씩 48)과 Y 8블록(4 MH씩 32)이 함께 기다린다. 80 MH > 가용 48 MH, 두 척 → 묻는다."""

    def test_pending_on_crunch_day(self):
        cfg, sc = manual_mini()
        r = simulate(cfg, sc, baseline=False)
        pd = r["pending"]
        self.assertEqual((pd["day"], pd["need_mh"], pd["capacity_mh"]), (1, 80, 48))
        st = pd["stations"]["sub_assembly"]
        self.assertEqual((len(st["waiting"]), st["budget"], st["budget_left"], st["policy"]), (16, 100, 100, None))
        self.assertEqual(st["rule_orders"]["spt"][:2], ["Y-SA1", "Y-SA2"])   # 작업 짧은 순: Y 블록(0.5)이 X(0.75)보다 먼저
        # 묻는 동안은 기본 대응(선박 순서)으로 끝까지 돈다: 예시 9와 같다
        self.assertEqual(done_days(r, "X"), [1, 1, 2, 2, 2, 3, 3, 3])

    def test_policy_spt(self):
        # 작업 짧은 순 정책: 하루 처리량 2로 Y 블록(0.5) 4개씩 1·2일, X 블록(0.75)은 3일부터 3·3·4·4·4·5·5·5
        cfg, sc = manual_mini()
        cfg["decisions"] = [{"day": 1, "policy": {"sub_assembly": "spt"}}]
        r = simulate(cfg, sc, baseline=False)
        self.assertIsNone(r["pending"])
        self.assertEqual(done_days(r, "Y"), [1, 1, 1, 1, 2, 2, 2, 2])
        self.assertEqual(done_days(r, "X"), [3, 3, 4, 4, 4, 5, 5, 5])

    def test_quotes(self):
        # 견적(정원 2명): X 블록 0.75 → 잔업 1일(2 × 10 × 0.5 = 10), 특근 1일(2 × 10 × 1.5 = 30),
        # 외주 0.75 × 10 × 2 = 15, 0.75 ÷ 2 → 1일 + 운반 2일 = 3일 뒤(4일) 돌아온다
        cfg, sc = manual_mini()
        q = simulate(cfg, sc, baseline=False)["pending"]["stations"]["sub_assembly"]["waiting"][0]["quotes"]
        self.assertEqual((q["overtime"]["cost"], q["extra"]["cost"], q["outsource"]["cost"], q["outsource"]["back_day"]), (10, 30, 15, 4))


class Example12(unittest.TestCase):
    """10장 예시 12, 블록 조치(4.32): 예시 11의 1일."""

    def test_outsource_returns_after_transport(self):
        # X-SA1 외주: 대기열을 떠나 4일에 소조립을 마친 블록으로 돌아온다(직접 하면 1일에 끝났을 블록이 3일 늦는다).
        # 나머지 X 블록은 하나씩 앞당겨진다. 비용 15는 비상 예산에서
        cfg, sc = manual_mini()
        cfg["decisions"] = [{"day": 1, "actions": {"X-SA1": "outsource"}}]
        r = simulate(cfg, sc, baseline=False)
        self.assertEqual(done_days(r, "X")[0], 4)
        self.assertEqual(r["costs"]["emergency"], 15)
        self.assertTrue(any(e["type"] == "outsource" and e["back_day"] == 4 for e in r["events"]))

    def test_overtime_speeds_block(self):
        # X-SA1 잔업: 그 블록이 든 날 작업장은 10시간(처리량 2.5). 1일에 X-SA1(0.75)·SA2·SA3(+0.25) → X-SA3이 1일에 끝나지 않고
        # 이어 하기: 2.5 = 0.75 × 3 + 0.25. 1일 끝난 블록은 셋(정규 하루는 둘)
        cfg, sc = manual_mini()
        cfg["decisions"] = [{"day": 1, "actions": {"X-SA1": "overtime"}}]
        r = simulate(cfg, sc, baseline=False)
        self.assertEqual(done_days(r, "X")[:3], [1, 1, 1])
        self.assertEqual(r["costs"]["emergency"], 10)

    def test_defer_goes_last(self):
        cfg, sc = manual_mini()
        cfg["decisions"] = [{"day": 1, "actions": {"X-SA1": "defer"}}]
        r = simulate(cfg, sc, baseline=False)
        self.assertEqual(max(done_days(r, "X") + done_days(r, "Y")), done_days(r, "X")[0])

    def test_over_budget_refused(self):
        # 예산 20: 잔업(10) + 외주(15)는 넘친다 → 외주는 거절되어 기록된다
        cfg, sc = manual_mini(budget=20)
        cfg["decisions"] = [{"day": 1, "actions": {"X-SA1": "overtime", "X-SA2": "outsource"}}]
        r = simulate(cfg, sc, baseline=False)
        self.assertEqual((r["decisions"][0]["actions"], r["decisions"][0]["refused"]), ({"X-SA1": "overtime"}, {"X-SA2": "over_budget"}))
        self.assertEqual(r["costs"]["emergency"], 10)

    def test_review_rows(self):
        cfg, sc = manual_mini()
        cfg["decisions"] = [{"day": 1, "policy": {"sub_assembly": "spt"}, "actions": {"X-SA1": "overtime"}}]
        r = simulate(cfg, sc, baseline=False)
        rows = {row["choice"]: row for row in r["review"][0]["rows"]}
        self.assertEqual(list(rows), ["mine", "ship", "edd", "slack", "spt", "no_actions", "auto"])
        self.assertEqual(rows["mine"]["spent"], 10)

    def test_validation_and_lock(self):
        cfg, sc = manual_mini()
        for bad in [{"day": 1, "policy": {"sub_assembly": "fast"}}, {"day": 1, "actions": {"X-SA1": "pray"}}, {"day": 0}]:
            with self.subTest(bad=bad), self.assertRaises(ConfigError):
                simulate({**cfg, "decisions": [bad]}, sc, baseline=False)
        with self.assertRaises(ConfigError):
            simulate({**cfg, "contingency": {"sub_assembly": 9999}}, sc, baseline=False)
        cfg2 = copy.deepcopy(cfg)
        cfg2["stations"]["block_assembly"]["dispatch_mode"] = "manual"   # 직접 대응 공정이 아니다
        with self.assertRaises(ConfigError):
            simulate(cfg2, sc, baseline=False)
        block = copy.deepcopy(load_presets("block")[1]["config"])
        block["stations"]["sub_assembly"]["dispatch_mode"] = "manual"
        with self.assertRaises(ConfigError):
            simulate(block, baseline=False)

    def test_decisions_end_and_auto(self):
        cfg, sc = manual_mini()
        self.assertIsNone(simulate({**cfg, "decisions_end": True}, sc, baseline=False)["pending"])
        cfg["stations"]["sub_assembly"]["dispatch_mode"] = "auto"
        self.assertNotIn("pending", simulate(cfg, sc, baseline=False))


class AssemblyScenario(unittest.TestCase):
    def test_full_yard_after_assembly(self):
        sc = load_scenario("assembly")
        self.assertEqual(sc["skip"], ["painting", "pre_outfitting"])
        self.assertEqual((sc["decision_stations"], sc["options"]["max_units"]), (list(ASM), 2))
        r = simulate(load_presets("assembly")[1]["config"], baseline=False)
        self.assertTrue(all("sea_trial" in s["spans"] for s in r["ships"]))

    def test_crunch_days(self):
        # 4.36(D84), 4.41(사용자 "조립에서 문제가 생길 여지가 있을 때"): 묻는 날 = 작업장 앞 블록이 블록 납기를 넘길 날이
        # 그 배의 덤 여유(계획 완료 ~ 목표 완료)보다 커서 배가 버퍼를 쓸 것 같은 새 배가 생긴 날
        _, r = play(load_presets("assembly")[1]["config"], policy("edd"))
        self.assertEqual([d["day"] for d in r["decisions"]], [19, 21])
        no_ba = copy.deepcopy(load_presets("assembly")[1]["config"])
        del no_ba["stations"]["block_assembly"]["dispatch_mode"]   # 중조립을 기본 대응으로 두면 21일 한 번
        self.assertEqual([d["day"] for d in play(no_ba, policy("edd"))[1]["decisions"]], [21])
        _, r = play(both_manual(), policy("edd"))
        self.assertEqual([d["day"] for d in r["decisions"]], [19, 21])
        sit = r["decisions"][0]["situation"]
        self.assertEqual({s: (v["over"], v["spare"], v["use"]) for s, v in sit["ships"].items() if v["over"]}, {"S3": (3, 2, 1)})


class AssemblyGrade(unittest.TestCase):
    """등급 조율(D70, 4.36): B안(버퍼 S1 3·S2 2·S3 4일, 묻는 동안 기본 대응)은 85.5점이지만 S2가 하루 늦어 납기 상한으로 B(D81).
    중조립도 직접 대응하고 버퍼를 먹을 블록에 잔업이면 A, 자동화 연구 + 가공·탑재 1명이면 S."""

    def test_presets(self):
        presets = {p["id"]: p["config"] for p in load_presets("assembly")}
        cases = {"unmanaged": (39.6, "F", 0), "managed": (85.5, "B", 2), "all_in": (46.6, "F", 1)}
        for pid, want in cases.items():
            r = simulate(presets[pid])
            self.assertEqual((r["grade"]["score"], r["grade"]["grade"], r["qcd"]["delivery"]["on_time"]), want, pid)
        cap = simulate(presets["managed"])["grade"]["cap"]
        self.assertEqual(cap, {"grade": "B", "from": "A", "late": ["S2"]})
        self.assertEqual(simulate(presets["managed"])["pending"]["day"], 19)
        # 4.42(D89, 사용자): 중조립도 기본이 직접 대응
        self.assertEqual({sid for sid, st in presets["managed"]["stations"].items() if st.get("dispatch_mode") == "manual"},
                         {"sub_assembly", "block_assembly"})
        self.assertEqual(presets["managed"]["pools"]["assembly"], 5)   # 하루 40 MH(슬라이드의 당일 가용 작업시간)

    def test_actions_rescue_or_hurt(self):
        # 소조립만 직접 대응(B안)이면 21일 S2 소조립 블록만 묻고, 어떤 정책도 S2가 하루 늦다
        late = lambda r: {s["id"]: s["late_days"] for s in r["ships"] if s["late_days"]}
        for rule in ("ship", "edd", "slack", "spt"):
            self.assertEqual(late(play(load_presets("assembly")[1]["config"], policy(rule))[1]), {"S2": 1}, rule)
        # 중조립도 직접 대응(4.41): 19일 S3 중조립 블록이 버퍼를 쓸 것 같아 묻는다. S3 중조립 블록에 특근 → S3가 중조립을 빨리 비워
        # S2까지 3척(예산 90, A). 모든 블록에 잔업은 S2 하루(돈만 쓴다), 선박 순서도 S2 하루
        cfg = both_manual()
        c, ex = play(cfg, policy("edd", lambda w: "extra" if w["ship"] == "S3" and w["id"].startswith("S3-BA") else None))
        self.assertEqual((late(ex), ex["costs"]["emergency"], simulate(c)["grade"]["grade"]), ({}, 90, "A"))
        self.assertEqual(late(play(cfg, policy("edd", lambda w: "overtime"))[1]), {"S2": 1})
        self.assertEqual(late(play(cfg, policy("ship"))[1]), {"S2": 1})

    def test_combined_actions(self):
        # 4.42(D89): 블록 조치를 여러 개. 값은 더한다. S3 중조립 블록에 특근 + 응원 투입 → 3척(96), 잔업 + 응원 투입은 S2 하루
        late = lambda r: {s["id"]: s["late_days"] for s in r["ships"] if s["late_days"]}
        cfg = both_manual()
        combo = lambda kinds: (lambda w: kinds if w["id"].startswith("S3-BA") else None)
        _, r = play(cfg, policy("edd", combo(["extra", "assist"])))
        self.assertEqual((late(r), r["costs"]["emergency"]), ({}, 96))
        self.assertEqual(r["decisions"][0]["actions"]["S3-BA2"], ["extra", "assist"])
        self.assertEqual(late(play(cfg, policy("edd", combo(["overtime", "assist"])))[1]), {"S2": 1})
        ev = simulate(play(cfg, policy("edd", combo(["extra", "assist"])))[0], baseline=False)["block_eval"]["all"]["actions"]
        self.assertEqual(ev, {"extra": 3, "assist": 3})

    def test_combined_action_rules(self):
        # 외주·포기는 혼자만, 잔업·특근은 둘 중 하나, 같은 조치는 한 번
        cfg = both_manual()
        day = simulate(cfg, baseline=False)["pending"]["day"]
        for bad in (["outsource", "assist"], ["defer", "overtime"], ["overtime", "extra"], ["assist", "assist"], ["warp"]):
            with self.assertRaises(ConfigError, msg=str(bad)):
                simulate({**cfg, "decisions": [{"day": day, "actions": {"S3-BA2": bad}}]}, baseline=False)
        simulate({**cfg, "decisions": [{"day": day, "actions": {"S3-BA2": ["extra", "assist", "expedite"]}}]}, baseline=False)

    def test_assist_and_expedite(self):
        # 4.40(D87): 응원 투입은 그 작업장에 정원 + 1명(대기소에서 먼저 데려와 다른 작업장이 빈다), 수당은 싸다.
        # 이 판은 사람이 병목이라 늦는 블록마다 응원을 넣어도 다른 작업장이 비어 S2는 여전히 하루 늦는다
        cfg = both_manual()
        _, r = play(cfg, policy("edd", lambda w: "assist" if w.get("over") else None))
        self.assertEqual(({s["id"]: s["late_days"] for s in r["ships"] if s["late_days"]}, r["costs"]["emergency"]), ({"S2": 1}, 10))
        # 긴급 자재 조달은 키트가 입고 전일 때만: 21일 S2 중조립 첫 블록(물감 3일 지연)에서만 고를 수 있고, 다음 날 입고로 당긴다
        avail = []

        def choose(pd):
            for st in pd["stations"].values():
                for w in st["waiting"]:
                    if w["quotes"]["expedite"].get("available"):
                        avail.append((pd["day"], w["id"], w["quotes"]["expedite"]["arrival_day"]))
            return policy("edd", lambda w: "expedite" if w["quotes"]["expedite"].get("available") else None)(pd)
        _, r = play(cfg, choose)
        self.assertEqual(avail, [(21, "S2-BA1", 22)])
        ev = [e for e in r["events"] if e["type"] == "expedite"]
        self.assertEqual([(e["day"], e["ship"], e["material"], e["arrival_day"]) for e in ev], [(21, "S2", "paint", 22)])
        self.assertEqual(r["costs"]["emergency"], 80)

    def test_more_platens_without_people_hurts(self):
        # 4.37(D85, 사용자 "가"): 작업장(정반) 증설을 연다. 조립 5명 그대로 소조립 정반만 2곳이면 사람이 나뉘어 더 늦고(증설비 300),
        # 병목은 정반이 아니라 사람이다. 사람을 한 명 늘리면 지연은 없지만 인건비로 이익이 준다
        base = simulate(load_presets("assembly")[1]["config"])
        cfg = copy.deepcopy(load_presets("assembly")[1]["config"])
        cfg["stations"]["sub_assembly"]["units"] = 2
        r = simulate(cfg)
        self.assertEqual(({s["id"]: s["late_days"] for s in r["ships"] if s["late_days"]}, r["costs"]["investment"]), ({"S1": 1, "S2": 1}, 300))
        self.assertLess(r["grade"]["score"], base["grade"]["score"])
        cfg = copy.deepcopy(load_presets("assembly")[1]["config"])
        cfg["pools"]["assembly"] = 6
        r = simulate(cfg)
        self.assertEqual((r["qcd"]["delivery"]["on_time"], r["profit"] < base["profit"]), (3, True))

    def test_block_eval_levels(self):
        # 블록 평가(3.2): 전체 = 공정별 합 = 작업장별 합 = 선박별 합
        r = simulate(load_presets("assembly")[1]["config"], baseline=False)
        ev = r["block_eval"]
        for level in ("stations", "units", "ships"):
            self.assertEqual(sum(v["blocks"] for v in ev[level].values()), ev["all"]["blocks"], level)
            self.assertEqual(sum(v["late_days"] for v in ev[level].values()), ev["all"]["late_days"], level)
        self.assertEqual(ev["all"]["blocks"], 42)

    def test_rules_recommend(self):
        self.assertEqual(simulate(load_presets("assembly")[1]["config"])["recommend"]["best"], "spt")



class Forecast(unittest.TestCase):
    """액션 카드 결과 미리보기(4.34, D82): 고르는 중인 결정대로 하고 그 뒤는 기본 대응으로 끝까지."""

    def setUp(self):
        self.cfg = both_manual()
        self.day = simulate(self.cfg, baseline=False)["pending"]["day"]

    def ask(self, **decision):
        return forecast({**self.cfg, "decisions": [{"day": self.day, **decision}]})

    def test_mine_matches_running_it(self):
        # 4.39(D86): 미리보기는 그날 아침까지 알고 있는 것만. 그날부터 새 사건이 없는 실행(quiet_from)과 같다
        f = self.ask(policy={"block_assembly": "ship"})
        cfg = {**self.cfg, "decisions": [{"day": self.day, "policy": {"block_assembly": "ship"}}], "decisions_end": True}
        r = simulate(cfg, {**load_scenario("assembly"), "quiet_from": self.day}, baseline=False)
        self.assertEqual(f["mine"]["late"], {s["id"]: s["late_days"] for s in r["ships"]})
        self.assertEqual(f["mine"]["completed"], {s["id"]: s["completed_day"] for s in r["ships"]})
        self.assertEqual(f["policies"]["block_assembly"]["ship"], f["mine"])
        self.assertEqual(f["policies"]["block_assembly"]["keep"], f["keep"])

    def test_spent_and_budget(self):
        pend = simulate(self.cfg, baseline=False)["pending"]["stations"]
        sid = next(k for k, v in pend.items() if v["manual"] and v["waiting"])   # 19일: 중조립
        r = pend[sid]
        bid = r["waiting"][0]["id"]
        f = self.ask(actions={bid: "overtime"})
        self.assertEqual(f["mine"]["spent"][sid], r["waiting"][0]["quotes"]["overtime"]["cost"])
        self.assertEqual(f["keep"]["spent"][sid], 0)
        self.assertEqual(f["budget"][sid], 200)

    def test_block_times_for_the_gantt(self):
        # 4.38(조치 요청 진행도 간트): 카드에 보이는 블록(작업 중 + 작업장 앞)마다 이 선택이면 언제 끝나나. 외주는 작업장 없이 돌아온 날
        pend = simulate(self.cfg, baseline=False)["pending"]["stations"]
        ids = {r["id"] for st in pend.values() if st["manual"] and st["waiting"] for r in st["waiting"] + st["inside"]}
        sit = next(v for v in pend.values() if v["manual"] and v["waiting"])
        last = sit["waiting"][-1]["id"]
        f = self.ask(actions={last: "outsource"})
        self.assertEqual(set(f["mine"]["block_times"]), ids)
        out = f["mine"]["block_times"][last]
        self.assertEqual((out["unit"], out["done_day"]), (None, sit["waiting"][-1]["quotes"]["outsource"]["back_day"]))
        self.assertIsNotNone(f["keep"]["block_times"][last]["unit"])

    def test_no_future_events(self):
        # quiet_from(4.39, D86): 그날부터 새 사건이 없다. B안을 15일부터 조용히 돌리면 S2도 늦지 않지만(18일 중조립 고장 전),
        # 실제로는 S2가 하루 늦는다. 19일부터 조용히 돌리면 고장이 이미 일어나 S2가 하루 늦다
        cfg = {**copy.deepcopy(load_presets("assembly")[1]["config"]), "decisions_end": True}
        quiet = lambda d: simulate(cfg, {**load_scenario("assembly"), "quiet_from": d}, baseline=False)
        late = lambda r: {s["id"]: s["late_days"] for s in r["ships"] if s["late_days"]}
        self.assertEqual((late(quiet(15)), late(quiet(19)), late(simulate(cfg, baseline=False))), ({}, {"S2": 1}, {"S2": 1}))

    def test_wrong_day(self):
        with self.assertRaises(ConfigError):
            forecast({**self.cfg, "decisions": [{"day": self.day + 1}]})



class QueueCap(unittest.TestCase):
    """작업장 적치 한도(4.35, D83): 넘치는 블록은 가공 적치장에서 기다리고, 작업장·액션 카드는 적치된 블록만 본다."""

    def b_plan(self, cap):
        cfg = copy.deepcopy(load_presets("assembly")[1]["config"])
        if cap is None:
            del cfg["stations"]["sub_assembly"]["queue_cap"]
        else:
            cfg["stations"]["sub_assembly"]["queue_cap"] = cap
        return cfg

    def test_card_shows_staged_only(self):
        # 중조립도 직접 대응한 판에서 21일 카드: 소조립 적치 2개면 작업장 앞 2개 + 적치장 2개, 한도 없으면 4개가 다 앞에
        def last(cap):
            cfg = both_manual()
            if cap is None:
                del cfg["stations"]["sub_assembly"]["queue_cap"]
            else:
                cfg["stations"]["sub_assembly"]["queue_cap"] = cap
            return play(cfg, policy("edd"))[1]["decisions"][-1]["situation"]["stations"]["sub_assembly"]
        st = last(2)
        self.assertEqual((st["queue_cap"], len(st["waiting"]), len(st["yard"])), (2, 2, 2))
        st = last(None)
        self.assertEqual((st["queue_cap"], len(st["waiting"]), st["yard"]), (None, 4, []))

    def test_never_more_than_cap_in_front(self):
        r = simulate(self.b_plan(3), baseline=False)
        sub = [b for b in r["blocks"] if b["station"] == "sub_assembly"]
        for d in range(r["days"]):
            front = sum(1 for b in sub if b["daily"][d]["state"] in ("station_wait", "material_wait") and not b["daily"][d].get("yard"))
            self.assertLessEqual(front, 3, d + 1)
        self.assertTrue(any(day.get("yard") for b in sub for day in b["daily"]))

    def test_sub_assembly_cap_keeps_the_result(self):
        # 이 판은 병목이 중조립이라 소조립 적치 한도는 결과를 바꾸지 않는다(B안 기본 4, 판 조율 그대로)
        base = simulate(self.b_plan(None))
        for cap in (2, 4, 8):
            r = simulate(self.b_plan(cap))
            self.assertEqual((r["grade"]["score"], r["profit"]), (base["grade"]["score"], base["profit"]), cap)

    def test_validation(self):
        cfg = self.b_plan(9)
        with self.assertRaises(ConfigError):
            simulate(cfg, baseline=False)
        cfg = self.b_plan(4)
        cfg["stations"]["cutting"]["queue_cap"] = 2
        with self.assertRaises(ConfigError):
            simulate(cfg, baseline=False)
        simple = copy.deepcopy(load_presets("simple")[1]["config"])
        simple["stations"]["sub_assembly"]["queue_cap"] = 2
        with self.assertRaises(ConfigError):
            simulate(simple, baseline=False)



class ProjectBuffer(unittest.TestCase):
    """프로젝트 버퍼(4.36, D84): 계획 = 변수 없는 실행. 착수일은 버퍼에서 거꾸로, 블록 납기는 계획에서 끝나는 날, 납기일 인도와 보관비."""

    def b(self, bufs=None):
        cfg = copy.deepcopy(load_presets("assembly")[1]["config"])
        for sid, n in (bufs or {}).items():
            cfg["ships"][sid]["buffer"] = n
        return cfg

    def test_plan_meets_target(self):
        from shipyard import preview
        bp = preview(self.b())["buffer_plan"]["ships"]
        self.assertEqual({sid: (v["start"], v["finish"], v["target"]) for sid, v in bp.items()},
                         {"S1": (1, 27, 27), "S2": (18, 34, 34), "S3": (9, 32, 34)})
        self.assertTrue(all(v["feasible"] for v in bp.values()))

    def test_plan_is_the_run_without_events(self):
        # 계획대로면(변수 없음) 계획 완료에 끝나고 늦는 블록이 없다
        from shipyard import preview
        from shipyard.sim import ideal_scenario
        cfg = self.b()
        bp = preview(cfg)["buffer_plan"]["ships"]
        r = simulate(cfg, ideal_scenario(load_scenario("assembly")), baseline=False)
        self.assertEqual({s["id"]: s["completed_day"] for s in r["ships"]}, {sid: v["finish"] for sid, v in bp.items()})
        self.assertEqual(r["block_due"]["on_time"], r["block_due"]["blocks"])

    def test_delivery_on_due_day_and_storage(self):
        r = simulate(self.b(), baseline=False)
        s3 = next(s for s in r["ships"] if s["id"] == "S3")
        self.assertEqual((s3["completed_day"], s3["delivered_day"], s3["buffer"]), (35, 38, 4))
        self.assertEqual(r["costs"]["storage"], 3 * 4000 * 0.01)

    def test_infeasible_buffer_is_a_plan_risk(self):
        from shipyard import preview
        pv = preview(self.b({"S1": 6}))
        self.assertEqual([(x["ship"], x["station"]) for x in pv["plan_risks"]], [("S1", "buffer")])
        self.assertEqual(pv["buffer_plan"]["ships"]["S1"]["start"], 1)

    def test_validation(self):
        with self.assertRaises(ConfigError):
            simulate(self.b({"S1": 9}), baseline=False)
        simple = copy.deepcopy(load_presets("simple")[1]["config"])
        next(iter(simple["ships"].values()))["buffer"] = 1
        with self.assertRaises(ConfigError):
            simulate(simple, baseline=False)


if __name__ == "__main__":
    unittest.main()
