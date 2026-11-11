/* =========================================================================
   玄枢号 · 社会层内核（权力 / 服从 / 哗变 / 感染）
   -------------------------------------------------------------------------
   与 sim-core.js 共用同一份 state；由 sim-core 在每周结算时调用 step()。
   设计底线：不用随机数。所有触发都是「属性 + 阈值 + 连续周数」。
   时间单位：周（1 年 = 52 周，1 季 = 13 周）；原「连续 N 个月」已换算为整数周。
   标注：公式系数集中在 sim-config.js 的 society 块。
   ========================================================================= */
(function (global) {
  "use strict";

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function num(v) { return isFinite(v) ? v : 0; }

  // 效果衰减：原「每 tick ×0.90」是月步长的乘性衰减，换成周步长要开 (12/52) 次方
  var SHIFT_DECAY = global.XuanShuTime
    ? global.XuanShuTime.powWeek(0.90) : Math.pow(0.90, 12 / 52);

  var LEVEL_LABEL = [
    "平稳", "L1 个别不服从", "L2 小范围哗变",
    "L3 多部门串联", "L4 全船暴动", "L5 结构重构"
  ];

  function pushEvent(state, cfg, type, level, title, text, basis) {
    state.events.push({
      t: (state.loop - 1) * cfg.time.loopYears + state.weeks / cfg.time.weeksPerYear,
      loop: state.loop,
      year: Math.floor(state.weeks / cfg.time.weeksPerYear),
      week: (state.weeks % cfg.time.weeksPerYear) + 1,
      quarter: Math.floor((state.weeks % cfg.time.weeksPerYear) / cfg.time.weeksPerQuarter) + 1,
      type: type,
      level: level,
      title: title,
      text: text,
      basis: basis || ""
    });
    if (state.events.length > cfg.time.eventCap) state.events.shift();
  }

  /* ---------------- 队列模板 ---------------- */
  // 只切醒态 2,400：L1 1 / L2 12 / L3 152 / L4 2,235
  function buildQueues() {
    var qs = [];
    var depts = ["指挥", "战斗", "技术", "勤务", "医疗", "农环"];

    qs.push({ id: "L1", name: "最高贵族", layer: "L1", dept: "指挥",
      kind: "L1", edu: "elite", w: 1, age: 140, mut: 5, exp: 6, superior: null });

    for (var i = 0; i < 12; i++) {
      qs.push({ id: "L2_" + (i + 1), name: "中层贵族 " + (i + 1), layer: "L2",
        dept: depts[i % 6], kind: "L2", edu: "elite", w: 1,
        age: 80 + (i % 5) * 14, mut: 4, exp: 5, superior: "L1" });
    }

    var l3 = [
      ["L3_cmd", "指挥·精英", "指挥", 24],
      ["L3_combat", "战斗·督导", "战斗", 18],
      ["L3_tech", "技术·管理", "技术", 48],
      ["L3_serv", "勤务·督导", "勤务", 22],
      ["L3_med", "医疗·督导", "医疗", 16],
      ["L3_agri", "农环·管理", "农环", 16],
      ["L3_branch", "贵族旁支", "指挥", 8]
    ];
    l3.forEach(function (a, idx) {
      qs.push({ id: a[0], name: a[1], layer: "L3", dept: a[2], kind: "L3",
        edu: "elite", w: a[3], age: 55 + (idx % 4) * 8, mut: 8, exp: 4,
        superior: "L2_" + ((idx % 6) + 1) });
    });

    var l4 = [
      ["L4_serv", "勤务奴隶", "勤务", 406, 65, 30],
      ["L4_combat", "战斗奴隶", "战斗", 257, 45, 35],
      ["L4_tech", "技术劳工", "技术", 254, 50, 25],
      ["L4_med", "医疗辅助", "医疗", 186, 55, 28],
      ["L4_orig", "原初体", "指挥", 12, 90, 15],
      ["L4_clone", "变异克隆", "农环", 440, 25, 45],
      ["L4_und", "未定·未成年", "勤务", 680, 16, 20]
    ];
    l4.forEach(function (a) {
      var sup = "L3_serv";
      if (a[2] === "指挥") sup = "L3_cmd";
      else if (a[2] === "战斗") sup = "L3_combat";
      else if (a[2] === "技术") sup = "L3_tech";
      else if (a[2] === "医疗") sup = "L3_med";
      else if (a[2] === "农环") sup = "L3_agri";
      qs.push({ id: a[0], name: a[1], layer: "L4", dept: a[2], kind: a[0] === "L4_clone" ? "L4clone" : "L4",
        edu: "slave", w: a[3], age: a[4], mut: a[5], exp: 2, superior: sup });
    });

    qs.forEach(function (q) {
      q.n = q.w;
      q.O = 50; q.W = 30; q.D = 0; q.span = 0; q.spanCap = 0;
      q.S = 0.3; q.Sstruct = 0; q.C = 4; q.thrallFrac = 0;
      q.stage = 0; q.highWeeks = 0; q.breakWeeks = 0; q.broken = false;
      q.p = 0; q.mixedWeeks = 0; q.wPerm = 0; q.oPerm = 0;
      q.dPenalty = 0; q.network = 1; q.logged = {}; q.shock = 0; q.mig = 0;
    });
    return qs;
  }

  function create(cfg) {
    var s = {
      queues: buildQueues(),
      depts: {},
      mutiny: { level: 0, since: 0, dept: "", coverage: 0,
                l1: 0, l3: 0, l4: 0, l5: 0, holdUntil: -1, l1dead: false },
      infection: { meanC: 0, maxC: 0, thralls: 0, share: 0,
                   summonSince: 0, perm: 0, lockUntil: 0, bonus: 0 },
      machine: { level: 0, depts: [], since: -1, A: 0, tech: 0, counter: 0, maxChain: 1 },
      garrison: {
        strength: cfg.society.garrison.initStrength,
        durability: cfg.society.garrison.initDurability,
        metal: cfg.society.garrison.initMetal,
        suppressors: cfg.society.garrison.suppressors,
        infiltrators: cfg.society.garrison.infiltrators,
        suppressorWear: 0,
        lastExpose: 0,
        losses: 0
      },
      effects: { oShift: 0, wShift: 0, prodMul: 1, prodWeeks: 0,
                 isoBoost: 0, isoWeeks: 0, infSpread: 1, infWeeks: 0,
                 popLoss: 0, popWeeks: 0, laborMul: 1 },
      actions: { cd: {}, uses: {} },
      exec: [],
      energyHist: [],
      replaceCount: 0,
      env: { c: 0.82, iso: 0.65, combatRatio: 1 }
    };
    cfg.society.depts.forEach(function (d) {
      s.depts[d] = { name: d, I: 0.3, over: 0, level: 0, since: -1, up: 0, down: 0 };
    });
    // 首帧属性：不等第一次 step，避免面板先显示占位值
    var d4 = {};
    s.queues.forEach(function (q) { if (q.layer === "L4") d4[q.dept] = (d4[q.dept] || 0) + q.w; });
    s.queues.forEach(function (q) {
      q.O = clamp(baseOOf(q, cfg), 0, 100);
      q.W = clamp(baseWOf(q, cfg), 0, 100);
      if (q.layer === "L1" || q.layer === "L2") {
        q.D = clamp(cfg.society.dominion.base + cfg.society.dominion.ageK * (q.age - 35), 0, 100);
        q.spanCap = cfg.society.dominion.spanBase + cfg.society.dominion.spanK * q.D;
        q.span = q.layer === "L1" ? 12 : 6 + Math.ceil((d4[q.dept] || 0) / 40);
        q.Sstruct = clamp(q.span / Math.max(1, q.spanCap) - 1, 0, 0.6);
      } else {
        q.D = 0; q.span = 0; q.spanCap = 0; q.Sstruct = 0;
      }
    });
    return s;
  }

  /* ---------------- 派生量 ---------------- */

  function garrisonAvail(state, cfg) {
    var g = state.society.garrison;
    if (!g) return 0;
    var man = clamp(g.strength / cfg.society.garrison.initStrength, 0, 1.2);
    var dur = 0.5 + 0.5 * clamp(g.durability / 100, 0, 1);
    return clamp(man * dur, 0, 1.2);
  }

  // 通用判定层入口：未加载时退化为「按原逻辑直接成立」
  function judgeCall(state, cfg, id, factors, meta) {
    if (!global.XuanShuJudge) return { judged: false, allow: true, reason: "disabled" };
    return global.XuanShuJudge.check(state, cfg, id, factors, meta);
  }

  function failEffect(cfg, id) {
    var def = cfg.judge && cfg.judge.items && cfg.judge.items[id];
    return (def && def.failEffect) || {};
  }

  function comfortOf(state, cfg, env) {
    var c = cfg.society.comfort;
    var crowd = clamp(env.awake / 3000, 0, 1);
    return c.wRation * clamp(env.ration, 0, 1.2) +
      c.wWear * (1 - clamp(env.wear, 0, 1)) +
      c.wMed * clamp(env.med, 0, 1) +
      c.wCrowd * (1 - crowd);
  }

  function execPct(state) {
    var m = state.weeks, sum = 0;
    state.society.exec = state.society.exec.filter(function (e) { return m - e.m < 52; });
    state.society.exec.forEach(function (e) { sum += e.frac; });
    return sum * 100;
  }

  function lifespanOf(q, cfg) {
    if (q.layer === "L1") return cfg.society.lifespan.L1;
    if (q.layer === "L2") return cfg.society.lifespan.L2;
    if (q.layer === "L3") return cfg.society.lifespan.L3;
    return q.kind === "L4clone" ? cfg.society.lifespan.clone : cfg.society.lifespan.L4;
  }

  function baseOOf(q, cfg) {
    if (q.layer === "L1") return cfg.society.baseO.L1;
    if (q.layer === "L2") return cfg.society.baseO.L2;
    if (q.layer === "L3") return cfg.society.baseO.L3;
    return q.kind === "L4clone" ? cfg.society.baseO.L4clone : cfg.society.baseO.L4;
  }

  function baseWOf(q, cfg) {
    // 基线自由意志按「出身」取，不随教育迁移状态变化；
    // 教育迁移的效果由 q.mig 按比例折算，否则一迁移整队 +32。
    if (q.layer !== "L4") return cfg.society.baseW.elite;
    if (q.kind === "L4clone") return cfg.society.baseW.slave;
    return q.id === "L4_orig" ? cfg.society.baseW.elite : cfg.society.baseW.slave;
  }

  function resistOf(q, cfg) {
    if (q.layer === "L1") return cfg.society.infection.resist.L1;
    if (q.layer === "L2") return cfg.society.infection.resist.L2;
    if (q.layer === "L3") return cfg.society.infection.resist.L3;
    return q.kind === "L4clone" ? cfg.society.infection.resist.L4c : cfg.society.infection.resist.L4n;
  }

  function infectionShareOf(state) {
    var tot = 0, hit = 0;
    state.society.queues.forEach(function (q) {
      tot += q.n;
      if (q.C >= 60) hit += q.n;
    });
    return tot > 0 ? hit / tot : 0;
  }

  /* ---------------- 属性更新 ---------------- */

  function updateQueues(state, cfg, env) {
    var soc = state.society;
    var c = comfortOf(state, cfg, env);
    soc.env.c = c;
    var cp = execPct(state);
    var infShare = infectionShareOf(state);
    var thralls = 0, totN = 0, sumC = 0, maxC = 0, sumO = 0, sumW = 0, totNon = 0;

    // 部门 L4 人数，用于 L2 管辖跨度
    var deptL4 = {};
    cfg.society.depts.forEach(function (d) { deptL4[d] = 0; });
    soc.queues.forEach(function (q) { if (q.layer === "L4") deptL4[q.dept] += q.n; });

    soc.queues.forEach(function (q) {
      q.n = Math.max(0, env.awake * q.w / cfg.society.awakeBase);
      var cf = cfg.society.comfort;
      var dev = (c - cf.center) / cf.width;
      var oPhys = -cf.maxPenalty * clamp(dev * dev, 0, 1);
      var oTrauma = -Math.min(cfg.society.trauma.oCap, cfg.society.trauma.oK * cp);

      var wInf = q.stage === 1 ? 6 : (q.stage === 2 ? 12 : 0);
      if (q.thrallFrac > 0.5) wInf = 0;

      var O = baseOOf(q, cfg) + oPhys - 0.45 * q.C + oTrauma + q.oPerm + soc.effects.oShift
        - q.mig * cfg.society.eduMigration.oLoss;
      var W = baseWOf(q, cfg) +
        cfg.society.will.expK * Math.log(1 + q.exp) +
        cfg.society.will.comfortGain * clamp((c - cfg.society.will.comfortStart) / cfg.society.will.comfortSpan, 0, 1) +
        q.mig * cfg.society.eduMigration.wGain +
        wInf + Math.min(cfg.society.trauma.wCap, cfg.society.trauma.wK * cp) +
        q.wPerm + soc.effects.wShift;

      q.O = clamp(O, 0, 100);
      q.W = clamp(W, 0, 100);

      // 手动哗变余震：连续若干周把该队列压在低服从 / 高自由意志区间，
      // 否则下一周属性重算会把触发值抹掉，事件只闪一下就消失。
      if (q.shock > 0) {
        q.O = Math.min(q.O, cfg.society.trigger.mutinyO);
        q.W = Math.max(q.W, cfg.society.trigger.mutinyW);
        q.shock--;
      }

      if (q.layer === "L1" || q.layer === "L2") {
        var net = clamp(q.network - 0.12 * soc.replaceCount, 0.35, 1);
        var execPen = clamp(cp / 12, 0, 0.6);
        q.D = clamp(cfg.society.dominion.base +
          cfg.society.dominion.ageK * (q.age - 35) +
          cfg.society.dominion.netK * net -
          cfg.society.dominion.execK * execPen - q.dPenalty, 0, 100);
        q.spanCap = cfg.society.dominion.spanBase + cfg.society.dominion.spanK * q.D;
        q.span = q.layer === "L1" ? 12 : 6 + Math.ceil((deptL4[q.dept] || 0) / 40);
        q.Sstruct = clamp(q.span / Math.max(1, q.spanCap) - 1, 0, 0.6);
      } else {
        q.D = 0; q.span = 0; q.spanCap = 0; q.Sstruct = 0;
      }

      q.S = clamp(
        cfg.society.stress.oK * (1 - q.O / 100) +
        cfg.society.stress.wK * clamp((q.W - 50) / 50, 0, 1) +
        cfg.society.stress.structK * q.Sstruct +
        cfg.society.stress.infK * (q.C >= 60 ? 1 : 0.25),
        0, 1
      );

      // 断裂：连续 9 周（原 2 个月）越线；断裂节点成为失序起点
      if (q.S >= cfg.society.stress.breakAt) q.breakWeeks++;
      else q.breakWeeks = 0;
      if (q.breakWeeks >= cfg.society.stress.breakWeeks && !q.broken) {
        q.broken = true;
        soc.queues.forEach(function (o) {
          if (o !== q && o.dept === q.dept) o.S = clamp(o.S + cfg.society.stress.spread * q.S, 0, 1);
        });
        pushEvent(state, cfg, "structure", "结构", "权力节点断裂",
          "「" + q.dept + " · " + q.name + "」越过应力线，成为该部门失序起点",
          "S=" + q.S.toFixed(2) + " ≥ " + cfg.society.stress.breakAt +
          "，连续 " + cfg.society.stress.breakWeeks + " 周；相邻节点 S +0.20×S");
      }
      if (q.broken && q.S < cfg.society.stress.breakAt - 0.12) {
        q.broken = false; q.breakWeeks = 0;
      }

      // 教育迁移（慢性通道）：p 走满一格 = 该队列 1% 的人完成迁移，
      // 属性按「已迁移比例」折算，避免整个阶层几十年就翻过来。
      if (q.edu === "slave" || q.edu === "mixed") {
        q.p += cfg.society.eduMigration.rate * (1 + cfg.society.eduMigration.expK * q.exp);
        if (q.p >= 1) {
          q.p = 0;
          q.mig = Math.min(0.20, q.mig + 0.01);
          q.edu = "mixed";
          pushEvent(state, cfg, "education", "社会", "奴隶队列出现精英教育",
            "「" + q.dept + " · " + q.name + "」约 1% 人员完成教育迁移",
            "累计迁移 " + (q.mig * 100).toFixed(0) + "%；队列平均自由意志 +" +
            (q.mig * cfg.society.eduMigration.wGain).toFixed(1) +
            "，服从度 −" + (q.mig * cfg.society.eduMigration.oLoss).toFixed(1));
        }
      }
      q.exp = Math.min(10, q.exp + cfg.society.will.expPerWeek);

      // 汇总
      totN += q.n;
      sumC += q.C * q.n;
      maxC = Math.max(maxC, q.C);
      if (q.thrallFrac > 0) thralls += q.n * q.thrallFrac;
      if (q.thrallFrac < 0.5) { sumO += q.O * q.n; sumW += q.W * q.n; totNon += q.n; }
    });

    soc.infection.meanC = totN > 0 ? sumC / totN : 0;
    soc.infection.maxC = maxC;
    soc.infection.thralls = thralls + (soc.infection.bonus || 0);
    soc.infection.share = infShare;
    soc.meanO = totNon > 0 ? sumO / totNon : 0;
    soc.meanW = totNon > 0 ? sumW / totNon : 0;
  }

  /* ---------------- 部门与阶梯 ---------------- */

  function updateDepts(state, cfg) {
    var soc = state.society;
    cfg.society.depts.forEach(function (d) {
      var D = soc.depts[d];
      var sum = 0, n = 0, over = 0;
      soc.queues.forEach(function (q) {
        if (q.dept !== d) return;
        sum += q.S * q.n; n += q.n;
        if (q.S >= cfg.society.ladder.l1At) over += q.n;
      });
      D.I = n > 0 ? sum / n : 0;
      D.over = n > 0 ? over / n : 0;

      if (D.I >= cfg.society.ladder.l2At && D.over >= cfg.society.ladder.l2QueueShare) {
        D.up++; D.down = 0;
        if (D.up >= cfg.society.ladder.l2Weeks && D.level < 2) {
          // 阈值已到：这一次是否真的哗变，交给通用判定层（每部门独立槽位）
          var r2 = judgeCall(state, cfg, "mutiny_l2", {
            index: D.I, over: D.over,
            will: clamp((soc.meanW || 0) / 100, 0, 1),
            garrison: clamp(garrisonAvail(state, cfg), 0, 1)
          }, { slot: "mutiny_l2:" + d, note: "部门 " + d });
          if (r2.allow) {
            D.level = 2; D.since = state.weeks;
            pushEvent(state, cfg, "mutiny", "哗变 L2", "小范围哗变 · " + d,
              "「" + d + "」部门进入 L2：该部门产出 −35%，全船按覆盖度折算，秩序平衡点下移",
              "部门失序指数 I=" + D.I.toFixed(2) + " ≥ " + cfg.society.ladder.l2At +
              "，越线队列占 " + Math.round(D.over * 100) + "%，连续 " + cfg.society.ladder.l2Weeks +
              " 周；判定 p=" + (r2.probability != null ? r2.probability.toFixed(2) : "—"));
          } else if (r2.judged) {
            var fe2 = (cfg.judge.items.mutiny_l2.failEffect || {});
            soc.queues.forEach(function (q) {
              if (q.dept === d) q.S = clamp(q.S + (fe2.stressAdd || 0), 0, 1);
            });
          }
        }
      } else if (D.I < cfg.society.ladder.l2Exit) {
        D.down++; D.up = 0;
        if (D.down >= cfg.society.ladder.l2ExitWeeks && D.level >= 2) {
          D.level = 0; D.since = -1;
          pushEvent(state, cfg, "mutiny", "事件", "部门恢复 · " + d,
            "「" + d + "」恢复正常作业", "I=" + D.I.toFixed(2) + " < " + cfg.society.ladder.l2Exit +
            "，连续 " + cfg.society.ladder.l2ExitWeeks + " 周");
        }
      } else {
        D.up = 0; D.down = 0;
      }
    });
  }

  function updateLadder(state, cfg) {
    var soc = state.society, L = cfg.society.ladder;
    var deptsAt2 = cfg.society.depts.filter(function (d) { return soc.depts[d].level >= 2; });
    var coverage = 0;
    cfg.society.depts.forEach(function (d) {
      if (soc.depts[d].level >= 2) {
        soc.queues.forEach(function (q) { if (q.dept === d) coverage += q.n; });
      }
    });
    var awake = soc.queues.reduce(function (a, q) { return a + q.n; }, 0);
    coverage = awake > 0 ? coverage / awake : 0;
    soc.mutiny.coverage = coverage;

    // L1：任一队列 S ≥ 0.45 连续 2 月
    var anyOver = soc.queues.some(function (q) { return q.S >= L.l1At; });
    soc.mutiny.l1 = anyOver ? soc.mutiny.l1 + 1 : 0;

    // L3：≥2 个部门同时 L2，且串联指数 K ≥ 0.50
    var iso = clamp(0.35 * (state.last.medCoverage || 0.8) + 0.20 * state.order +
      0.35 * clamp(garrisonAvail(state, cfg), 0, 1) +
      0.10 * clamp(state.society.garrison.infiltrators / 6, 0, 1), 0, 1);
    var K = 0.5 * (soc.meanW / 100) + 0.3 * 0.5 + 0.2 * (1 - iso);
    soc.kIndex = K;
    if (deptsAt2.length >= L.l3Depts && K >= L.l3K) soc.mutiny.l3++;
    else soc.mutiny.l3 = 0;

    var l1 = soc.queues.filter(function (q) { return q.layer === "L1"; })[0];
    var dEff = l1 ? l1.D * (1 - 0.5 * soc.queues.filter(function (q) { return q.broken; }).length / Math.max(1, soc.queues.length)) : 0;
    soc.mutiny.dEff = dEff;

    if (coverage >= L.l4Coverage && dEff < L.l4D) soc.mutiny.l4++;
    else soc.mutiny.l4 = 0;

    var l5cond = soc.mutiny.l1dead || (dEff < L.l5D && coverage >= L.l5Coverage);
    if (l5cond) soc.mutiny.l5++;
    else soc.mutiny.l5 = 0;

    var level = 0;
    var raw = 0;
    if (soc.mutiny.holdUntil > state.weeks) raw = 5;
    else if (soc.mutiny.l5 >= L.l5Weeks) raw = 5;
    else if (soc.mutiny.l4 >= L.l4Weeks) raw = 4;
    else if (soc.mutiny.l3 >= L.l3Weeks) raw = 3;
    else if (deptsAt2.length >= 1) raw = 2;
    else if (soc.mutiny.l1 >= L.l1Weeks) raw = 1;

    // 阶梯只负责「够不够格升级」，这一次成不成立由通用判定层掷骰。
    // 失败：压力累积 + 冷却，等级维持原状；冷却后再判时基数更高。
    level = soc.mutiny.level;
    if (raw === 2) {
      // L2 的判定已在 updateDepts 里按部门逐个做过，这里只做汇总升级
      level = 2;
    } else if (raw > level) {
      var jid = "mutiny_l" + raw;
      var maxS = 0, maxQ = null;
      soc.queues.forEach(function (q) { if (q.S > maxS) { maxS = q.S; maxQ = q; } });
      var factors;
      if (raw === 1) {
        factors = {
          stress: maxS, coverage: coverage,
          will: clamp((soc.meanW || 0) / 100, 0, 1),
          garrison: clamp(garrisonAvail(state, cfg), 0, 1)
        };
      } else if (raw === 2) {
        factors = { index: 0.6, over: 0.2, will: clamp((soc.meanW || 0) / 100, 0, 1),
          garrison: clamp(garrisonAvail(state, cfg), 0, 1) };
      } else if (raw === 3) {
        factors = { depts: deptsAt2.length / Math.max(1, cfg.society.depts.length),
          k: K, will: clamp((soc.meanW || 0) / 100, 0, 1) };
      } else if (raw === 4) {
        factors = { coverage: coverage, weak: 1 - clamp(dEff / 100, 0, 1) };
      } else {
        factors = { coverage: coverage, weak: 1 - clamp(dEff / 100, 0, 1),
          dead: soc.mutiny.l1dead ? 1 : 0 };
      }
      var rj = judgeCall(state, cfg, jid, factors, { note: "L" + raw + " 升级" });
      if (rj.allow) {
        level = raw;
      } else if (rj.judged) {
        var fe = failEffect(cfg, jid);
        if (raw === 1 && maxQ && fe.stressAdd) maxQ.S = clamp(maxQ.S + fe.stressAdd, 0, 1);
        if (raw === 2) {
          soc.queues.forEach(function (q) {
            if (deptsAt2.indexOf(q.dept) >= 0) q.S = clamp(q.S + (fe.stressAdd || 0), 0, 1);
          });
        }
      }
    } else if (raw < level) {
      level = raw;   // 降级仍按阈值，不掷骰
    }

    if (level > soc.mutiny.level) {
      soc.mutiny.since = state.weeks;
      var dname = deptsAt2.length ? deptsAt2.join(" / ") : (soc.queues.filter(function (q) { return q.S >= L.l1At; })[0] || {}).dept || "—";
      soc.mutiny.dept = dname;
      pushEvent(state, cfg, "mutiny", "哗变 L" + level, "哗变升级 · " + LEVEL_LABEL[level],
        level >= 4 ? "全船范围失序，产出与维修同时下滑" : "失序从「" + dname + "」扩散",
        "覆盖 " + Math.round(coverage * 100) + "% 醒态人口，D_L1_eff=" + dEff.toFixed(0) +
        "，K=" + K.toFixed(2) + "，等级 " + soc.mutiny.level + " → " + level);
    } else if (level < soc.mutiny.level) {
      pushEvent(state, cfg, "mutiny", "事件", "哗变降级",
        LEVEL_LABEL[soc.mutiny.level] + " → " + LEVEL_LABEL[level],
        "覆盖降至 " + Math.round(coverage * 100) + "%");
    }
    soc.mutiny.level = level;

    // L5：L1 被杀 / 结构重构
    if (level >= 5 && !soc.mutiny.l1dead) {
      soc.mutiny.l1dead = true;
      soc.mutiny.holdUntil = state.weeks + L.l5HoldWeeks;
      var nl1 = soc.queues.filter(function (q) { return q.layer === "L1"; })[0];
      if (nl1) { nl1.O = 60; nl1.W = 40; nl1.D = 35; nl1.age = 60; nl1.name = "新任最高贵族"; }
      state.order = clamp(state.order - 0.20, 0.05, 1);
      pushEvent(state, cfg, "mutiny", "哗变 L5", "最高贵族被杀 · 权力结构重构",
        "新任 L1 即位，统御力从 35 起；" + L.l5HoldWeeks + " 周内无法恢复原有秩序",
        "L4 覆盖 ≥50% 且 D_L1_eff<30 连续 " + L.l5Weeks + " 周，或 L1 已死亡");
    }
    if (soc.mutiny.l1dead && state.weeks > soc.mutiny.holdUntil + L.l5HoldWeeks * 2) {
      soc.mutiny.l1dead = false;
      soc.mutiny.l5 = 0; soc.mutiny.level = 1;
    }

    // 哗变死亡
    var dr = L.deathPerWeek[level] || 0;
    if (dr > 0) {
      cfg.population.groups.forEach(function (g) {
        var s = state.groups[g.id];
        s.awake = Math.max(0, s.awake - s.awake * dr);
      });
    }
  }

  /* ---------------- 警备：独立存量 + 二型机器人 ---------------- */

  function updateGarrison(state, cfg, env) {
    var soc = state.society, G = cfg.society.garrison, g = soc.garrison;

    // 人员补员：从未定抽调，保持总人口不变
    if (g.strength < G.initStrength && state.order > 0.4) {
      var flow = Math.min(G.recoverStrengthPerWeek, G.initStrength - g.strength,
        state.groups.undecided.awake * 0.002);
      g.strength += flow;
      state.groups.undecided.awake = Math.max(0, state.groups.undecided.awake - flow);
    }
    g.durability = clamp(g.durability + G.recoverDur, 0, 100);

    // 机器人维修：优先吃警备金属库存，其次从主金属库存调拨
    var needM = G.robotMetalTpy / cfg.time.weeksPerYear;
    var takeG = Math.min(g.metal, needM);
    g.metal -= takeG;
    var rest = needM - takeG;
    if (rest > 0) {
      var takeS = Math.min(state.stocks.metal, rest);
      state.stocks.metal -= takeS;
      rest -= takeS;
    }
    if (rest > 0.1) {
      g.durability = clamp(g.durability - G.lackDurabilityPerWeek, 0, 100);
      if (!g.loggedMetal) {
        g.loggedMetal = true;
        pushEvent(state, cfg, "garrison", "警备", "警备维修缺金属",
          "二型机器人降功率运行，警备耐久下降",
          "每周需 " + needM.toFixed(2) + " t，缺口 " + rest.toFixed(2) + " t");
      }
    } else {
      g.loggedMetal = false;
      g.metal = clamp(g.metal + G.recoverMetal, 0, G.initMetal * 1.5);
    }

    // 镇压机磨损：每 1.0 即损失一架，且推高不信任
    if (g.suppressorWear >= 1 && g.suppressors > 0) {
      g.suppressors--;
      g.suppressorWear = 0;
      g.losses++;
      state.order = clamp(state.order - 0.04, 0.05, 1);
      soc.effects.wShift += 2;
      pushEvent(state, cfg, "garrison", "警备", "镇压机损毁",
        "重型镇压机在冲突中报废，目击者情绪恶化",
        "剩余镇压机 " + g.suppressors + " 架；秩序 −0.04，自由意志 +2");
    }

    // 潜伏机暴露：感染面扩大时，伪装被识破的概率上升（按固定周期检查，不用随机数）
    if (g.infiltrators > 0 && soc.infection.share > 0.15 &&
        state.weeks - g.lastExpose >= G.exposeWeeks) {
      g.lastExpose = state.weeks;
      g.infiltrators--;
      g.losses++;
      state.order = clamp(state.order - 0.04, 0.05, 1);
      soc.effects.wShift += 2;
      pushEvent(state, cfg, "garrison", "警备", "潜伏机暴露",
        "一台伪装单元被人群识破，审讯威慑下降",
        "感染面 " + Math.round(soc.infection.share * 100) + "% > 15%，检查周期 " +
        G.exposeWeeks + " 周；剩余潜伏机 " + g.infiltrators + " 台");
    }
  }

  /* ---------------- 感染 ---------------- */

  function updateInfection(state, cfg, env) {
    var soc = state.society, F = cfg.society.infection;
    var thrallDensity = soc.infection.thralls / Math.max(1, env.awake);
    var cp = execPct(state) / 100;
    var iso = clamp(0.35 * env.med + 0.20 * env.order +
      0.35 * clamp(garrisonAvail(state, cfg), 0, 1) +
      0.10 * clamp(soc.garrison.infiltrators / 6, 0, 1) + soc.effects.isoBoost, 0, 1);
    soc.env.iso = iso;
    var spread = soc.effects.infWeeks > 0 ? soc.effects.infSpread : 1;

    soc.queues.forEach(function (q) {
      var ageTerm = F.ageK * Math.min(Math.max(0, q.age - 10), F.ageCap);
      var lifeTerm = F.lifeK * Math.max(0, lifespanOf(q, cfg) - F.lifeFloor);
      var d = F.base + ageTerm + lifeTerm +
        F.mutK * (q.mut / 100) +
        F.isoK * (1 - iso) +
        F.densityK * thrallDensity -
        F.medK * env.med -
        F.execK * cp + soc.infection.perm;
      d = clamp(d * resistOf(q, cfg) * spread, 0, F.cap);
      q.C = clamp(q.C + d, 0, 100);

      var stage = q.C >= F.thrall ? 3 : (q.C >= F.deform ? 2 : (q.C >= F.hearing ? 1 : 0));
      if (stage > q.stage) {
        pushEvent(state, cfg, "infection", "感染", "感染阶段上升 · " + q.name,
          ["", "出现幻听记录，夜间离舱 +1", "体表畸变，产出 −20%，隔离需求上升", "眷属化进程"][stage],
          "感染度 " + q.C.toFixed(0) + "（阈值 " + [0, F.hearing, F.deform, F.thrall][stage] + "）");
      }
      q.stage = stage;

      if (q.C >= F.thrall) q.highWeeks++;
      else q.highWeeks = 0;

      var need = F.thrallWeeks[q.layer] || 52;
      if (q.highWeeks >= need) {
        // 连续周数达标 → 这一次转化成不成立由通用判定层决定；
        // 失败：该队列 C 上升（failEffect.cAdd），压力累积，冷却后再判。
        var rc = judgeCall(state, cfg, "infection_thrall", {
          c: q.C / 100, iso: iso, stage: q.stage / 3
        }, { slot: "infection_thrall:" + q.id, note: q.name + " · " + q.layer });
        if (rc.allow) {
          var rate = (q.layer === "L1" || q.layer === "L2") ? F.convertRateNoble : F.convertRate;
          q.thrallFrac = clamp(q.thrallFrac + rate * (1 - q.thrallFrac), 0, 0.95);
          if (!q.logged.thrall) {
            q.logged.thrall = true;
            pushEvent(state, cfg, "infection", "眷属", "出现眷属 · " + q.name,
              "「" + q.dept + "」报告人员外观异常但行为顺从，已单列登记",
              "感染度 ≥" + F.thrall + " 连续 " + need + " 周；转化率 " + (rate * 100).toFixed(3) +
              "%/周；判定 p=" + (rc.probability != null ? rc.probability.toFixed(2) : "—"));
          }
        } else if (rc.judged) {
          var fec = failEffect(cfg, "infection_thrall");
          q.C = clamp(q.C + (fec.cAdd || 0), 0, 100);
          q.highWeeks = need;   // 保留触发基数，冷却结束后再判
        }
      }
    });

    // 召唤判定：12 名 / 均值 55 / 峰值 90，连续 26 周（原 6 个月）
    var S = cfg.society.summon;
    if (soc.infection.thralls >= S.n &&
        soc.infection.meanC >= S.meanC &&
        soc.infection.maxC >= S.maxC) soc.infection.summonSince++;
    else soc.infection.summonSince = 0;

    if (soc.infection.summonSince >= S.weeks && state.weeks >= soc.infection.lockUntil) {
      // 阈值全部满足后仍是一次判定：眷属数量、感染均值/峰值共同构成倾向分；
      // 均值与峰值在首次判定时冻结（freezeOnFirst），之后不再变。
      var rs = judgeCall(state, cfg, "summon", {
        thralls: clamp(soc.infection.thralls / S.n, 0, 3),
        meanC: clamp(soc.infection.meanC / 100, 0, 1),
        maxC: clamp(soc.infection.maxC / 100, 0, 1)
      }, { note: "召唤 · 连续 " + S.weeks + " 周" });
      if (rs.allow) {
        summon(state, cfg);
      } else if (rs.judged) {
        var fes = failEffect(cfg, "summon");
        soc.infection.bonus = (soc.infection.bonus || 0) + (fes.thrallsAdd || 0);
        soc.queues.forEach(function (q) {
          q.C = clamp(q.C + (fes.cAdd || 0), 0, 100);
        });
      }
    }
  }

  function mechanization(state, cfg) {
    var S = cfg.society.summon;
    return clamp(
      S.mechHydro * clamp(state.infra.hydro / cfg.food.hydroMax, 0, 1) +
      S.mechClone * clamp(state.infra.clonePods / cfg.clone.maxPods, 0, 1) +
      S.mechWear * (1 - clamp(state.wear, 0, 1)) +
      S.mechMed * clamp(state.last.medCoverage || 0.8, 0, 1), 0, 1);
  }

  function summon(state, cfg) {
    var soc = state.society, S = cfg.society.summon;
    var mech = mechanization(state, cfg);
    var prodMul = clamp(S.prodBase + S.prodMech * mech, 0.3, 1);
    var laborMul = clamp(S.laborBase + S.laborExtra * mech, 0.5, 1);
    var laborShare = 0.35; // 农环 / 维修 / 手工装配占产出比重
    var eff = prodMul * (1 - laborShare + laborShare * laborMul);

    state.order = clamp(state.order - S.orderLoss, 0.05, 1);
    soc.effects.prodMul = Math.min(soc.effects.prodMul, eff);
    soc.effects.prodWeeks = S.prodWeeks;
    soc.effects.popLoss = S.popLoss / S.popWeeks;
    soc.effects.popWeeks = S.popWeeks;
    soc.effects.laborMul = laborMul;
    soc.infection.perm += S.permBase;
    soc.infection.lockUntil = state.weeks + S.lockYears * cfg.time.weeksPerYear;
    soc.infection.summonSince = 0;
    soc.infection.bonus = (soc.infection.bonus || 0) + S.newThralls + S.newThrallK * soc.infection.thralls;

    soc.queues.forEach(function (q) {
      q.S = clamp(q.S + S.stressAdd, 0, 1);
      q.C = clamp(q.C + 12, 0, 100);
    });

    pushEvent(state, cfg, "summon", "召唤", "全船级事件 · 低语汇聚",
      "多处同时出现定向吟诵，人口与产出在随后的周里持续流失；措辞已克制，细节封存",
      "眷属 " + Math.round(soc.infection.thralls) + " 名（阈值 " + S.n + "）· 均值 " +
      soc.infection.meanC.toFixed(0) + "（阈值 " + S.meanC + "）· 峰值 " +
      soc.infection.maxC.toFixed(0) + "（阈值 " + S.maxC + "）连续 " + S.weeks + " 周；" +
      "机械化率 " + Math.round(mech * 100) + "%，产能系数 " + eff.toFixed(2));
  }

  /* ---------------- 机器 ---------------- */

  function updateMachine(state, cfg, env) {
    var soc = state.society, M = cfg.society.machine;
    var energyCV = 0;
    var h = soc.energyHist;
    // 能量波动窗口：原 12 个月，现在要满 52 周才算（窗口太短会被周的抖动放大）
    if (h.length >= M.energyHistWeeks) {
      var mean = h.reduce(function (a, b) { return a + b; }, 0) / h.length;
      var varr = h.reduce(function (a, b) { return a + (b - mean) * (b - mean); }, 0) / h.length;
      energyCV = mean > 0 ? Math.sqrt(varr) / mean : 0;
    }
    var tech = clamp(
      M.techHydro * clamp(state.infra.hydro / cfg.food.hydroMax, 0, 1) +
      M.techClone * clamp(state.infra.clonePods / cfg.clone.maxPods, 0, 1) +
      M.techMed * clamp(env.med, 0, 1), 0, 1);
    var maint = clamp(state.last.maintGap || 0, 0, 1);
    var garrisonWeak = 1 - clamp(garrisonAvail(state, cfg), 0, 1);
    var A = clamp(0.50 * tech + 0.30 * maint + 0.20 * energyCV + 0.10 * garrisonWeak, 0, 1);
    var maxChain = M.maxChainBase + Math.floor(tech * (M.maxChainTech - M.maxChainBase) + 1e-6);

    soc.machine.tech = tech;
    soc.machine.A = A;
    soc.machine.maxChain = maxChain;
    soc.machine.energyCV = energyCV;

    var armed = A >= M.at && (soc.meanO || 0) < M.oLow;
    soc.machine.counter = armed ? soc.machine.counter + 1 : 0;

    if (soc.machine.counter >= M.weeks && soc.machine.depts.length < maxChain) {
      var take = null;
      if (soc.machine.depts.length === 0) take = M.firstDept;
      else if (soc.machine.depts.length === 1 && A >= M.secondAt &&
        (maint >= M.secondMaint || energyCV >= M.secondEnergy)) take = "技术";
      else if (soc.machine.depts.length === 2 && A >= M.thirdAt) take = "勤务";
      if (take && soc.machine.depts.indexOf(take) < 0) {
        // 夺取部门同样掷骰：A / 科技 / 服从度缺口构成倾向分；
        // 科技等级首次判定后冻结，失败只累积压力、不夺权。
        var rm = judgeCall(state, cfg, "machine_takeover", {
          autonomy: A, tech: tech,
          weakO: 1 - clamp((soc.meanO || 0) / 100, 0, 1)
        }, { note: "目标部门 " + take });
        if (rm.allow) {
          soc.machine.depts.push(take);
          soc.machine.counter = 0;
          pushEvent(state, cfg, "machine", "机器哗变", "机器夺取「" + take + "」",
            "该部门停摆 " + M.procWeeks + " 周，之后以 60% 产出运行并忽略人类指令",
            "自主性 A=" + A.toFixed(2) + " ≥ " + (soc.machine.depts.length === 1 ? M.at :
              (soc.machine.depts.length === 2 ? M.secondAt : M.thirdAt)) +
            "，人类平均服从度 " + (soc.meanO || 0).toFixed(0) + " < " + M.oLow +
            "，科技等级 " + tech.toFixed(2) + "（可连锁 " + maxChain + " 个部门）；判定 p=" +
            (rm.probability != null ? rm.probability.toFixed(2) : "—"));
        } else if (rm.judged) {
          soc.machine.counter = M.weeks;   // 保留触发基数，冷却后再判
        }
      }
    }
  }

  /* ---------------- 扑灭手段 ---------------- */

  function act(state, cfg, name) {
    var a = cfg.society.actions[name];
    if (!a) return { ok: false, msg: "未知手段" };
    var soc = state.society;
    var cd = soc.actions.cd[name] || 0;
    if (state.weeks < cd) return { ok: false, msg: a.label + "冷却中，还需 " + (cd - state.weeks) + " 周" };
    if (a.needL1 && soc.mutiny.l1dead) return { ok: false, msg: "L1 已死亡，仪式失效" };

    var used = soc.actions.uses[name] || 0;
    var mul = a.uses[Math.min(used, a.uses.length - 1)];
    var extra = "";

    if (name === "suppress") {
      var g = soc.garrison, G = cfg.society.garrison;
      if (g.durability < 20) return { ok: false, msg: "警备耐久低于 20，无法组织镇压" };
      var avail = garrisonAvail(state, cfg);
      var eff = a.o * mul * clamp(G.effectMin + (1 - G.effectMin) * clamp(avail, 0, 1), G.effectMin, 1.15);
      g.durability = clamp(g.durability - a.durCost * mul, 0, 100);
      g.metal = Math.max(0, g.metal - a.metal * mul);
      g.suppressorWear += a.wear * mul;
      soc.effects.oShift += eff;
      // 自由意志是「持续 26 周的抬升」，剂量按 26 周 = 6 个月折算，
      // 不能直接乘 26：那会把台阶抬高 4.33 倍（旧版乘的是 6 个月）。
      soc.effects.wShift += a.w * a.wWeeks * cfg.time.monthsPerYear / cfg.time.weeksPerYear;
      // 真实死亡：冲突中的连带伤亡（不是警备编制减员）
      cfg.population.groups.forEach(function (gr) {
        var s = state.groups[gr.id];
        s.awake = Math.max(0, s.awake - s.awake * a.death * mul);
      });
      state.order = clamp(state.order + a.order, 0.05, 1);
      extra = "警备耐久 −" + Math.round(a.durCost * mul) + "、金属 −" + Math.round(a.metal * mul) +
        " t，服从 +" + eff.toFixed(0) + "（警备可用度 " + Math.round(avail * 100) + "%）";
    } else if (name === "concede") {
      var demandW = (state.last.consumption || 0) / cfg.time.weeksPerYear;
      var cost = demandW * a.foodShare * a.foodWeeks;
      state.stocks.food = Math.max(0, state.stocks.food - cost);
      soc.effects.oShift += a.o * mul;
      soc.effects.wShift += a.w * mul;
      state.order = clamp(state.order + a.order, 0.05, 1);
      extra = "动用粮食 " + Math.round(cost) + " t，服从 +" + (a.o * mul).toFixed(0);
    } else if (name === "execute") {
      cfg.population.groups.forEach(function (g) {
        var s = state.groups[g.id];
        s.awake = Math.max(0, s.awake - s.awake * a.death * mul);
      });
      soc.effects.oShift += a.o * mul;
      soc.effects.wShift += a.w * mul;
      var worst = soc.queues.filter(function (q) { return q.layer === "L2" && q.dept === soc.mutiny.dept; })[0] ||
        soc.queues.filter(function (q) { return q.layer === "L2"; })[0];
      if (worst) { worst.dPenalty += 5; worst.wPerm += a.w * mul; }
      soc.exec.push({ m: state.weeks, frac: a.death * mul });
      extra = "处决约 " + Math.round((state.total || 0) * a.death * mul) + " 人，涉事中层统御 −5";
    } else if (name === "replace") {
      var l2 = soc.queues.filter(function (q) { return q.layer === "L2" && q.dept === soc.mutiny.dept; })[0];
      if (l2) l2.dPenalty += 8;
      soc.replaceCount++;
      soc.queues.forEach(function (q) {
        if (q.dept === soc.mutiny.dept) q.S = clamp(q.S + a.spread, 0, 1);
      });
      soc.effects.oShift += a.o * mul;
      extra = "统御 −8，同部门其他节点 S +0.12";
    } else if (name === "interrogate") {
      if (soc.garrison.infiltrators <= 0) return { ok: false, msg: "没有可用的潜伏机" };
      soc.garrison.metal = Math.max(0, soc.garrison.metal - a.metal * mul);
      soc.garrison.durability = clamp(soc.garrison.durability - a.durCost * mul, 0, 100);
      soc.effects.oShift += a.o * mul;
      soc.effects.wShift += a.w * mul;
      soc.effects.isoBoost = Math.max(soc.effects.isoBoost, a.iso);
      soc.effects.isoWeeks = Math.max(soc.effects.isoWeeks, a.isoWeeks);
      extra = "潜伏机审讯：服从 +" + (a.o * mul).toFixed(0) + "，隔离 +" + a.iso + "（" +
        a.isoWeeks + " 周），金属 −" + Math.round(a.metal * mul) + " t";
    } else if (name === "lockdown") {
      soc.garrison.durability = clamp(soc.garrison.durability - a.durCost * mul, 0, 100);
      soc.garrison.metal = Math.max(0, soc.garrison.metal - a.metal * mul);
      soc.effects.prodMul = Math.min(soc.effects.prodMul, a.prodMul);
      soc.effects.prodWeeks = Math.max(soc.effects.prodWeeks, a.prodWeeks);
      soc.effects.isoBoost = Math.max(soc.effects.isoBoost, a.iso);
      soc.effects.isoWeeks = a.isoWeeks;
      soc.effects.infSpread = a.infSpread;
      soc.effects.infWeeks = a.isoWeeks;
      extra = "产出 ×" + a.prodMul + "，隔离 +" + a.iso + "，感染扩散 ×" + a.infSpread +
        "，警备耐久 −" + Math.round(a.durCost * mul);
    } else if (name === "ritual") {
      var costR = (state.last.consumption || 0) / cfg.time.weeksPerYear * a.foodShare;
      state.stocks.food = Math.max(0, state.stocks.food - costR);
      soc.effects.oShift += a.o * mul;
      soc.effects.wShift += a.w * mul;
      extra = "消耗粮食 " + Math.round(costR) + " t，服从 +" + (a.o * mul).toFixed(0);
    }

    soc.actions.uses[name] = used + 1;
    soc.actions.cd[name] = state.weeks + a.cdWeeks;

    pushEvent(state, cfg, "action", "处置", a.label,
      extra + "；第 " + (used + 1) + " 次效果 ×" + mul.toFixed(2),
      "冷却 " + a.cdWeeks + " 周；递减序列 " + a.uses.join(" / ") + "；" + (a.note || ""));
    return { ok: true, msg: a.label + "：" + extra };
  }

  /* ---------------- 手动触发 ---------------- */

  function triggerMutiny(state, cfg, dept) {
    var soc = state.society, T = cfg.society.trigger;
    var target = dept || soc.mutiny.dept || "技术";
    var all = soc.queues.filter(function (q) {
      return q.dept === target && q.layer !== "L1" && q.layer !== "L2";
    });
    if (!all.length) all = soc.queues.filter(function (q) { return q.dept === target; });
    if (!all.length) return { ok: false, msg: "该部门没有可用队列" };
    var q = all.slice().sort(function (a, b) { return b.n - a.n; })[0];

    // 整个部门的管理层与执行层一起停摆（贵族不动），保证部门失序指数
    // 能真实越过 L2 阈值，而不是触发值下个月就被重算抹掉。
    all.forEach(function (x) {
      x.O = Math.min(x.O, T.mutinyO);
      x.W = Math.max(x.W, T.mutinyW);
      x.S = Math.max(x.S, T.mutinyS);
      x.broken = true;
      x.breakWeeks = 3;
      x.shock = T.mutinyWeeks;
    });

    var D = soc.depts[target];
    D.I = Math.max(D.I, cfg.society.ladder.l2At + 0.03);
    D.over = Math.max(D.over, 0.2);
    D.up = cfg.society.ladder.l2Weeks;
    D.level = 2;
    D.since = state.weeks;
    soc.mutiny.level = Math.max(2, soc.mutiny.level);
    soc.mutiny.dept = target;

    pushEvent(state, cfg, "mutiny", "哗变 L2", "手动触发 · 小范围哗变（" + target + "）",
      "「" + target + "」当班人员集体停工，产出下降；事件流会记录后续升级或平息",
      "将「" + target + "」的 " + all.length + " 个队列（" + q.name + " 等）压到 O≤" +
      T.mutinyO + " / W≥" + T.mutinyW + " / S≥" + T.mutinyS +
      "，持续 " + T.mutinyWeeks + " 周；部门 I=" + D.I.toFixed(2) + "，满足 L2 进入条件");
    return { ok: true, msg: "已于「" + target + "」触发 L2 哗变（" + all.length + " 个队列）" };
  }

  function triggerInfection(state, cfg, group) {
    var soc = state.society, T = cfg.society.trigger, F = cfg.society.infection;
    var main = group ? soc.queues.filter(function (x) { return x.id === group; })[0] : null;
    if (!main) main = soc.queues.filter(function (x) { return x.id === "L4_clone"; })[0];
    if (!main) return { ok: false, msg: "没有可用的克隆队列" };

    // 一次「扩散」而不是单点感染：主队列 + 同舱高密度队列一起抬升，
    // 否则全船均值与眷属数都够不到召唤阈值，链条走不完。
    var plan = [
      [main, T.infectC],
      ["L4_clone", T.infectC],
      ["L4_serv", T.infectSpreadC],
      ["L4_und", T.infectSpreadC],
      ["L4_tech", T.infectSpreadC],
      ["L4_med", T.infectSpreadC],
      ["L4_combat", T.infectSpreadC2]
    ];
    var hit = [];
    plan.forEach(function (p) {
      var q = typeof p[0] === "string"
        ? soc.queues.filter(function (x) { return x.id === p[0]; })[0] : p[0];
      if (!q) return;
      var c = Math.min(100, p[1]);
      if (q.C >= c - 1) return;
      q.C = c;
      q.mut = Math.max(q.mut, 78);
      q.stage = q.C >= F.thrall ? 3 : (q.C >= F.deform ? 2 : 1);
      if (q.C >= F.thrall) {
        q.highWeeks = Math.max(q.highWeeks, (F.thrallWeeks[q.layer] || 52) - 1);
        q.thrallFrac = Math.max(q.thrallFrac, 0.010);
      }
      hit.push(q.name + " " + q.C.toFixed(0));
    });

    pushEvent(state, cfg, "infection", "感染", "手动触发 · 感染扩散（" + main.name + "）",
      "同舱与相邻舱段先后出现幻听、体表畸变，隔离程序启动；转化会逐周累积",
      "抬升队列：" + hit.join(" / ") + "；峰值 " + T.infectC +
      " ≥ 召唤峰值阈值 " + F.thrall + "，连续 " + (F.thrallWeeks[main.layer] || 52) + " 周转为眷属");
    return { ok: true, msg: "感染已扩散至 " + hit.length + " 个队列（" + hit.join("、") + "）" };
  }

  /* ---------------- 周结算入口 ---------------- */

  function step(state, cfg, env) {
    if (!state.society || !cfg.society || cfg.society.enabled === false) return;
    var soc = state.society;

    soc.energyHist.push(env.energy);
    if (soc.energyHist.length > cfg.society.machine.energyHistWeeks) soc.energyHist.shift();

    // 效果倒计时
    if (soc.effects.prodWeeks > 0) {
      soc.effects.prodWeeks--;
      if (soc.effects.prodWeeks === 0) soc.effects.prodMul = 1;
    }
    if (soc.effects.isoWeeks > 0) {
      soc.effects.isoWeeks--;
      if (soc.effects.isoWeeks === 0) { soc.effects.isoBoost = 0; soc.effects.infSpread = 1; }
    }
    if (soc.effects.popWeeks > 0) {
      cfg.population.groups.forEach(function (g) {
        var s = state.groups[g.id];
        s.awake = Math.max(0, s.awake - s.awake * soc.effects.popLoss);
      });
      soc.effects.popWeeks--;
    }

    updateQueues(state, cfg, env);
    updateDepts(state, cfg);
    updateLadder(state, cfg);
    updateGarrison(state, cfg, env);
    updateInfection(state, cfg, env);
    updateMachine(state, cfg, env);

    // 效果衰减：原月步长是 ×0.90/tick，周步长用 0.90^(12/52)=0.976/tick，
    // 半衰期仍是约 6.6 个月，效果的积分面积不变。
    soc.effects.oShift *= SHIFT_DECAY;
    soc.effects.wShift *= SHIFT_DECAY;
    if (Math.abs(soc.effects.oShift) < 0.05) soc.effects.oShift = 0;
    if (Math.abs(soc.effects.wShift) < 0.05) soc.effects.wShift = 0;
  }

  /* ---------------- 给页面 / 主站的摘要 ---------------- */

  function summary(state, cfg) {
    var s = state.society;
    if (!s) return null;
    var ga = garrisonAvail(state, cfg), g = s.garrison;
    return {
      weekNow: state.weeks,
      meanO: s.meanO || 0,
      meanW: s.meanW || 0,
      kIndex: s.kIndex || 0,
      queues: s.queues.map(function (q) {
        return {
          id: q.id, name: q.name, layer: q.layer, dept: q.dept, kind: q.kind,
          n: q.n, O: q.O, W: q.W, D: q.D, span: q.span, spanCap: q.spanCap,
          S: q.S, C: q.C, broken: q.broken, stage: q.stage,
          thrallFrac: q.thrallFrac, edu: q.edu, exp: q.exp, mig: q.mig || 0,
          superior: q.superior, age: q.age
        };
      }),
      depts: cfg.society.depts.map(function (d) {
        var D = s.depts[d];
        return { name: d, I: D.I, over: D.over, level: D.level, since: D.since };
      }),
      mutiny: {
        level: s.mutiny.level, label: LEVEL_LABEL[s.mutiny.level] || "—",
        dept: s.mutiny.dept, coverage: s.mutiny.coverage,
        since: s.mutiny.since, l1dead: s.mutiny.l1dead,
        hold: Math.max(0, (s.mutiny.holdUntil || 0) - state.weeks),
        dEff: s.mutiny.dEff || 0
      },
      infection: {
        meanC: s.infection.meanC, maxC: s.infection.maxC,
        thralls: s.infection.thralls, share: s.infection.share,
        perm: s.infection.perm,
        summonSince: s.infection.summonSince,
        lock: Math.max(0, (s.infection.lockUntil || 0) - state.weeks)
      },
      machine: {
        level: s.machine.level, depts: s.machine.depts.slice(),
        A: s.machine.A, tech: s.machine.tech, maxChain: s.machine.maxChain,
        energyCV: s.machine.energyCV || 0
      },
      garrison: {
        strength: g.strength,
        durability: g.durability,
        metal: g.metal,
        suppressors: g.suppressors,
        infiltrators: g.infiltrators,
        wear: g.suppressorWear,
        avail: ga,
        losses: g.losses,
        init: cfg.society.garrison.initStrength
      },
      effects: {
        oShift: s.effects.oShift, wShift: s.effects.wShift,
        prodMul: s.effects.prodMul, prodWeeks: s.effects.prodWeeks,
        isoBoost: s.effects.isoBoost, isoWeeks: s.effects.isoWeeks,
        popWeeks: s.effects.popWeeks
      },
      actions: { cd: Object.assign({}, s.actions.cd), uses: Object.assign({}, s.actions.uses) },
      env: { c: s.env.c, iso: s.env.iso, garrison: ga, mech: mechanization(state, cfg) },
      thresholds: cfg.society.summon
    };
  }

  global.XuanShuSociety = {
    create: create,
    step: step,
    summary: summary,
    act: act,
    triggerMutiny: triggerMutiny,
    triggerInfection: triggerInfection,
    LEVEL_LABEL: LEVEL_LABEL
  };

  if (typeof module !== "undefined" && module.exports) module.exports = global.XuanShuSociety;
})(typeof globalThis !== "undefined" ? globalThis : this);
