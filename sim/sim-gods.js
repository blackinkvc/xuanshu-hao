/* =========================================================================
   玄枢号 · 古神契约（sim-gods.js）
   -------------------------------------------------------------------------
   四位古神：缄默之喉 / 赤织母 / 星启者 / 丰穰之腹。
   state.gods 跨轮保留：契约、主约/旁约、神恩、祝福/诅咒、周期索取、神噬。
   随机只走 state.rngA。
   ========================================================================= */
(function (global) {
  "use strict";

  var VERSION = "1.1.0";
  var IDS = ["maw", "weaver", "star", "fecund"];
  var NAMES = { maw: "缄默之喉", weaver: "赤织母", star: "星启者", fecund: "丰穰之腹" };

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function num(v, d) { return typeof v === "number" && isFinite(v) ? v : (d || 0); }
  function rnd(v) { return Math.round(num(v, 0)); }

  function randNext(state) {
    if (global.XuanShuRand && global.XuanShuRand.next) return global.XuanShuRand.next(state);
    state.rngA = (state.rngA | 0) + 0x6D2B79F5 | 0;
    var t = Math.imul(state.rngA ^ (state.rngA >>> 15), 1 | state.rngA);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function absYear(state, cfg) {
    return (state.loop - 1) * cfg.time.loopYears + state.weeks / cfg.time.weeksPerYear;
  }

  function pushEvent(state, cfg, title, text, basis, deltas, note) {
    if (!state.events) state.events = [];
    var evYear = Math.floor(state.weeks / cfg.time.weeksPerYear);
    var evWeek = (state.weeks % cfg.time.weeksPerYear) + 1;
    var entry = {
      t: Math.round(absYear(state, cfg) * 100) / 100,
      loop: state.loop,
      year: evYear,
      week: evWeek,
      quarter: Math.floor((state.weeks % cfg.time.weeksPerYear) / cfg.time.weeksPerQuarter) + 1,
      timeLabel: "第 " + (evYear + 1) + " 年第 " + evWeek + " 周",
      type: "gods", level: "古神", title: title, text: text, basis: basis || ""
    };
    var D = global.XuanShuSim && global.XuanShuSim.cleanDeltas
      ? global.XuanShuSim.cleanDeltas(deltas) : null;
    if (D) entry.deltas = D;
    if (note) entry.note = note;
    var key = global.XuanShuSim && global.XuanShuSim.eventIsKey
      ? global.XuanShuSim.eventIsKey(cfg, entry.type, entry.level) : true;
    if (key) {
      state.events.push(entry);
      if (cfg.events.keyCap && state.events.length > cfg.events.keyCap) state.events.shift();
    } else {
      if (!state.logRing) state.logRing = [];
      state.logRing.push(entry);
      var ring = cfg.events.routineRing || 40;
      while (state.logRing.length > ring) state.logRing.shift();
    }
  }

  function create(cfg) {
    var pacts = {};
    IDS.forEach(function (id) {
      pacts[id] = { pact: false, primary: false, favor: 0, since: 0, lastTithe: 0,
        blessed: false, cursed: false };
    });
    return {
      version: VERSION,
      enabled: !(cfg.gods && cfg.gods.enabled === false),
      legacy: false,
      pacts: pacts,
      devour: 0,
      pendingTithe: null,
      history: [],
      mods: [],
      // 教会：眷属规模长出的组织；成形后神恩才在界面可见
      church: { formed: false, since: 0, formedYear: 0, dissolvedYear: 0,
        score: 0, weeksUp: 0, weeksDown: 0, thralls: 0, ratio: 0, leader: null },
      // 神直接收人：同神 15 年、全局 8 年冷却（年为单位）
      rapture: {}
    };
  }

  function ensure(state, cfg) {
    if (!state.gods || typeof state.gods !== "object") {
      state.gods = create(cfg);
      state.gods.enabled = false;
      state.gods.legacy = true;
    }
    var g = state.gods;
    if (!g.pacts) g.pacts = create(cfg).pacts;
    IDS.forEach(function (id) {
      if (!g.pacts[id]) g.pacts[id] = { pact: false, primary: false, favor: 0, since: 0,
        lastTithe: 0, blessed: false, cursed: false };
      if (typeof g.pacts[id].favor !== "number") g.pacts[id].favor = 0;
    });
    if (typeof g.devour !== "number") g.devour = 0;
    if (!g.history) g.history = [];
    if (!Array.isArray(g.mods)) g.mods = [];
    if (g.pendingTithe === undefined) g.pendingTithe = null;
    if (!g.church || typeof g.church !== "object") {
      g.church = { formed: false, since: 0, formedYear: 0, dissolvedYear: 0,
        score: 0, weeksUp: 0, weeksDown: 0, thralls: 0, ratio: 0, leader: null };
    }
    if (!g.church.formed) { g.church.weeksUp = num(g.church.weeksUp); g.church.weeksDown = num(g.church.weeksDown); }
    if (!g.rapture || typeof g.rapture !== "object") g.rapture = {};
    return g;
  }

  function item(cfg, id) {
    return (cfg.gods && cfg.gods.items && cfg.gods.items[id]) || {};
  }

  function primaryOf(state, cfg) {
    var g = ensure(state, cfg);
    for (var i = 0; i < IDS.length; i++) {
      if (g.pacts[IDS[i]].pact && g.pacts[IDS[i]].primary) return IDS[i];
    }
    return null;
  }

  function pacted(state, cfg) {
    var g = ensure(state, cfg);
    return IDS.filter(function (id) { return g.pacts[id].pact; });
  }

  function isBlessed(state, cfg, id) {
    return !!ensure(state, cfg).pacts[id].blessed;
  }

  function isCursed(state, cfg, id) {
    return !!ensure(state, cfg).pacts[id].cursed;
  }

  /* ---------------- 立约 ---------------- */

  function onPact(state, cfg, id) {
    var it = item(cfg, id);
    var o = it.onPact || {};
    var soc = state.society || {};
    var p = state.player && state.player.pc;
    if (o.dominion && p) p.dominionBonus = num(p.dominionBonus) + num(o.dominion);
    if (o.order) state.order = clamp(num(state.order) + num(o.order), 0.05, 1);
    if (o.tech && soc.machine) soc.machine.tech = clamp(num(soc.machine.tech) + num(o.tech), 0, 1);
    if (o.thralls && soc.infection) soc.infection.thralls = num(soc.infection.thralls) + num(o.thralls);
    if (o.infectionC) {
      ((soc.queues) || []).forEach(function (q) { q.C = clamp(num(q.C) + num(o.infectionC), 0, 100); });
    }
    if (o.garrison && soc.garrison) {
      Object.keys(o.garrison).forEach(function (k) {
        if (typeof soc.garrison[k] === "number") {
          soc.garrison[k] = clamp(num(soc.garrison[k]) + num(o.garrison[k]), 0,
            k === "durability" ? 100 : 1e9);
        }
      });
    }
  }

  function makePact(state, cfg, id, quiet) {
    var g = ensure(state, cfg);
    if (!g.enabled) return { ok: false, msg: "古神层未启用" };
    if (IDS.indexOf(id) < 0) return { ok: false, msg: "未知古神：" + id };
    var rec = g.pacts[id];
    var now = absYear(state, cfg);
    var old = primaryOf(state, cfg);

    if (rec.pact && rec.primary) {
      return { ok: true, name: NAMES[id], msg: "已与「" + NAMES[id] + "」保持主约" };
    }
    if (old && old !== id) {
      g.pacts[old].primary = false;
      g.pacts[old].favor = clamp(num(g.pacts[old].favor) - 20, -num(cfg.gods.favorCap, 100), num(cfg.gods.favorCap, 100));
    }
    var first = !rec.pact;
    rec.pact = true;
    rec.primary = true;
    rec.since = now;
    if (!rec.lastTithe) rec.lastTithe = now;
    if (first) onPact(state, cfg, id);

    g.history.push({ year: Math.round(now), id: id, type: "pact",
      text: (first ? "立约" : "改主约") + " · " + NAMES[id] });
    if (g.history.length > 200) g.history.shift();
    if (!quiet) {
      pushEvent(state, cfg, "古神契约 · " + NAMES[id],
        (first ? "你与「" : "主约改为「") + NAMES[id] + "」，" +
        (item(cfg, id).lean || "") + "。旧主约降为旁约。",
        "主约：" + (primaryOf(state, cfg) || "无"));
    }
    return { ok: true, name: NAMES[id], id: id, first: first };
  }

  /* ---------------- 神恩 ---------------- */

  function adjustFavor(state, cfg, id, v) {
    var g = ensure(state, cfg);
    if (!g.enabled) return { ok: false, msg: "古神层未启用" };
    var tid = id;
    if (!tid || !g.pacts[tid] || !g.pacts[tid].pact) {
      tid = primaryOf(state, cfg) || (function () {
        var ps = pacted(state, cfg);
        return ps.length ? ps[Math.floor(randNext(state) * ps.length)] : "maw";
      })();
    }
    var rec = g.pacts[tid];
    var before = num(rec.favor);
    // v6.37：神恩上下限读 gods.favorCap
    var cap = Math.max(1, num(cfg.gods.favorCap, 100));
    rec.favor = clamp(before + num(v), -cap, cap);
    if (rec.favor !== before) {
      g.history.push({ year: Math.round(absYear(state, cfg)), id: tid, type: "favor",
        text: "神恩 " + (v >= 0 ? "+" : "") + v + " → " + Math.round(rec.favor) });
      if (g.history.length > 200) g.history.shift();
    }
    return { ok: true, id: tid, favor: rec.favor };
  }

  function devourAdd(state, cfg, v) {
    var g = ensure(state, cfg);
    var before = num(g.devour);
    g.devour = clamp(before + num(v), 0, num(cfg.gods.devourCap, 100));
    if (g.devour > before) {
      g.history.push({ year: Math.round(absYear(state, cfg)), type: "devour",
        text: "神噬 +" + (g.devour - before) + " → " + Math.round(g.devour) });
      if (g.history.length > 200) g.history.shift();
    }
    return g.devour;
  }

  /* ---------------- 教会（神恩的可见开关） ---------------- */

  function churchCfg(cfg) {
    return (cfg.gods && cfg.gods.church) || {};
  }

  function totalAwake(state) {
    var t = 0;
    Object.keys(state.groups || {}).forEach(function (k) { t += num(state.groups[k].awake); });
    return t;
  }

  // 每周算一次：眷属占比 45% + 感染压力 20% + 医疗缺口 15% + 统治缺口 20%
  function churchMetrics(state, cfg) {
    var C = churchCfg(cfg);
    var soc = state.society || {};
    var inf = soc.infection || {};
    var awake = totalAwake(state);
    var thralls = num(inf.thralls);
    var r = thralls / Math.max(1, awake);
    var rN = clamp(r / Math.max(0.001, num(C.ratioK, 0.12)), 0, 1);
    var p = clamp(num(inf.meanC) / 100, 0, 1);
    var m = clamp(num(state.last && state.last.medCoverage, 0.8), 0, 1);
    var c = 0.55 * clamp(num(state.order), 0, 1) + 0.45 * clamp(num(soc.meanO) / 100, 0, 1);
    var S = num(C.wRatio, 0.45) * rN + num(C.wPressure, 0.20) * p +
      num(C.wMedGap, 0.15) * (1 - m) + num(C.wControlGap, 0.20) * (1 - c);
    var gateThralls = Math.max(num(C.minThralls, 8), num(C.minThrallFrac, 0.02) * awake);
    var leaderMin = num(C.leaderMinThrallFrac, 0.02);
    var leader = null;
    ((soc.queues) || []).forEach(function (q) {
      if (q.layer !== "L2" && q.layer !== "L3") return;
      var f = num(q.thrallFrac);
      if (f < leaderMin) return;
      if (!leader || f > leader.thrallFrac) {
        leader = { id: q.id, name: q.name, dept: q.dept, thrallFrac: f };
      }
    });
    return { awake: awake, thralls: thralls, r: r, rN: rN, p: p, m: m, c: c,
      S: S, gate: thralls >= gateThralls, gateThralls: gateThralls,
      leader: leader, leaderMin: leaderMin };
  }

  function dissolveChurch(state, cfg, now, why) {
    var g = ensure(state, cfg);
    var ch = g.church;
    ch.formed = false;
    ch.since = 0;
    ch.dissolvedYear = Math.round(now);
    ch.weeksUp = 0;
    ch.weeksDown = 0;
    g.history.push({ year: Math.round(now), type: "churchEnd", text: "教会解散 · " + why });
    if (g.history.length > 200) g.history.shift();
    pushEvent(state, cfg, "古神教会 · 解散",
      "教会散了，神恩重新隐去。原因：" + why + "。",
      "眷属 " + Math.round(num(ch.thralls)) + " 人 · 占比 " +
        (num(ch.ratio) * 100).toFixed(1) + "% · S=" + num(ch.score).toFixed(2),
      null, "神恩不再显示，但古神并未离开");
  }

  function updateChurch(state, cfg) {
    var g = ensure(state, cfg);
    if (!g.enabled || g.legacy) return null;
    var C = churchCfg(cfg);
    if (C.enabled === false) return null;
    var now = absYear(state, cfg);
    var mt = churchMetrics(state, cfg);
    var ch = g.church;
    ch.score = Math.round(mt.S * 1000) / 1000;
    ch.thralls = Math.round(mt.thralls);
    ch.ratio = Math.round(mt.r * 1000) / 1000;
    ch.leader = mt.leader;

    if (!ch.formed) {
      if (mt.gate && mt.S >= num(C.formScore, 0.55)) ch.weeksUp = num(ch.weeksUp) + 1;
      else ch.weeksUp = 0;
      if (num(ch.weeksUp) >= num(C.formWeeks, 4)) {
        ch.formed = true;
        ch.since = now;
        ch.formedYear = Math.round(now);
        ch.weeksDown = 0;
        g.history.push({ year: Math.round(now), type: "church", text: "教会成形" });
        if (g.history.length > 200) g.history.shift();
        pushEvent(state, cfg, "古神教会 · 成形",
          "眷属规模够了，船上出现了自己的教会。神恩第一次显形。",
          "S=" + mt.S.toFixed(2) + " ≥ " + num(C.formScore, 0.55) + " 连续 " +
            num(C.formWeeks, 4) + " 周；眷属 " + Math.round(mt.thralls) + " 人（" +
            (mt.r * 100).toFixed(1) + "%）" +
            (mt.leader ? "；会长 " + mt.leader.name + "（" + mt.leader.dept + "）" : ""),
          null, "神恩现在可以在古神卡里看到");
      }
    } else {
      // 立刻解散的硬条件：眷属占比过低 / 会长被清洗（含会长眷属率跌破门槛）
      if (mt.r < num(C.dissolveRatio, 0.015)) {
        dissolveChurch(state, cfg, now, "眷属占比跌破 " + (num(C.dissolveRatio, 0.015) * 100).toFixed(1) + "%");
      } else if (!mt.gate) {
        dissolveChurch(state, cfg, now, "眷属人数跌破门槛");
      } else if (!mt.leader || mt.leader.thrallFrac < mt.leaderMin) {
        dissolveChurch(state, cfg, now, "会长被清洗");
      } else if (mt.S < num(C.dissolveScore, 0.42)) {
        ch.weeksDown = num(ch.weeksDown) + 1;
        if (num(ch.weeksDown) >= num(C.dissolveWeeks, 12)) {
          dissolveChurch(state, cfg, now, "S 连续 " + num(C.dissolveWeeks, 12) + " 周低于 " + num(C.dissolveScore, 0.42));
        }
      } else {
        ch.weeksDown = 0;
      }
    }
    return ch;
  }

  /* ---------------- 耐受 / 索取曲线 ---------------- */

  // 已立约诸神中取最高神恩，作为全船耐受的来源
  function favorFrac(state, cfg) {
    var g = ensure(state, cfg);
    var best = 0;
    IDS.forEach(function (id) {
      if (g.pacts[id].pact) best = Math.max(best, num(g.pacts[id].favor));
    });
    var cap = Math.max(1, num(cfg.gods.favorCap, 100));
    return clamp(best / cap, 0, 1);
  }

  function toleranceOf(state, cfg) {
    var T = (cfg.gods && cfg.gods.tolerance) || {};
    var f = favorFrac(state, cfg);
    var max = num(T.max, 0.45);
    return max * (1 - Math.exp(-f / Math.max(0.01, num(T.tau, 0.45))));
  }

  // 感染公式乘子（1 = 无减免）
  function infectionTolerance(state, cfg) {
    var g = state.gods;
    if (!g || !g.enabled || g.legacy) return 1;
    return 1 - toleranceOf(state, cfg);
  }

  // 梦中侵蚀乘子（1 = 无减免）
  function dreamTolerance(state, cfg) {
    var g = state.gods;
    if (!g || !g.enabled || g.legacy) return 1;
    var T = (cfg.gods && cfg.gods.tolerance) || {};
    return 1 - num(T.dreamMul, 0.6) * toleranceOf(state, cfg);
  }

  function godFrac(state, cfg, id) {
    var rec = ensure(state, cfg).pacts[id];
    var cap = Math.max(1, num(cfg.gods.favorCap, 100));
    return clamp(num(rec && rec.favor) / cap, 0, 1);
  }

  // 什一税额度倍率（1–2.2）
  function demandAmountMul(state, cfg, id) {
    var D = (cfg.gods && cfg.gods.demand) || {};
    var f = godFrac(state, cfg, id);
    return Math.min(num(D.amountCap, 2.2),
      1 + num(D.amountK, 1.2) * (1 - Math.exp(-f / Math.max(0.01, num(D.amountTau, 0.55)))));
  }

  // 索取频率倍率（1–1.8）
  function demandFreqMul(state, cfg, id) {
    var D = (cfg.gods && cfg.gods.demand) || {};
    var f = godFrac(state, cfg, id);
    return Math.min(num(D.freqCap, 1.8),
      1 + num(D.freqK, 0.8) * (1 - Math.exp(-f / Math.max(0.01, num(D.freqTau, 0.55)))));
  }

  function titheInterval(state, cfg, id, every) {
    if (!(every > 0)) return 0;
    return Math.max(5, Math.round(every / demandFreqMul(state, cfg, id)));
  }

  /* ---------------- 神直接收人 ---------------- */

  function raptureCheck(state, cfg, now) {
    var g = ensure(state, cfg);
    if (!g.enabled || g.legacy) return null;
    var R = (cfg.gods && cfg.gods.rapture) || {};
    var cap = Math.max(1, num(cfg.gods.favorCap, 100));
    var cdGlobal = num(R.cooldownGlobal, 8);
    if (now - num(g.rapture.global, -999) < cdGlobal) return null;
    var hit = null;
    IDS.forEach(function (id) {
      if (hit) return;
      var rec = g.pacts[id];
      if (!rec.pact) return;
      if (num(rec.favor) < num(R.minFavor, 60)) return;
      var cdSame = num(R.cooldownSameGod, 15);
      if (now - num(g.rapture[id], -999) < cdSame) return;
      var f = clamp(num(rec.favor) / cap, 0, 1);
      var tier = null;
      (R.tiers || []).forEach(function (t) { if (f >= num(t.min)) tier = t; });
      if (!tier) return;
      var p = num(tier.p) * (rec.primary ? 1 : num(R.sidePactMul, 0.5));
      if (randNext(state) >= p) return;

      var awake = totalAwake(state);
      var mul = num((R.godPopMul || {})[id], 1);
      var raw = Math.round(awake * num(tier.pop) * mul);
      var maxTake = Math.floor(awake * num(R.maxShare, 0.12));
      var take = Math.min(awake, Math.max(num(R.minTake, 5), raw));
      take = Math.min(take, Math.max(1, maxTake));
      var lost = removePop(state, take);
      if (lost <= 0) return;

      // 回赠：四位神各自不同
      var rew = (R.rewards || {})[id] || {};
      var soc = state.society || {};
      var deltas = { "人口": -lost };
      var gift = [];
      if (id === "maw") {
        if (!state.stocks) state.stocks = {};
        state.stocks.metal = num(state.stocks.metal) + num(rew.metal);
        state.stocks.food = num(state.stocks.food) + num(rew.food);
        deltas["金属"] = num(rew.metal); deltas["粮"] = num(rew.food);
        gift.push("金属 +" + num(rew.metal) + " 吨、粮 +" + num(rew.food) + " 吨");
      } else if (id === "weaver") {
        state.order = clamp(num(state.order) + num(rew.order), 0.05, 1);
        if (soc.garrison) soc.garrison.durability = clamp(num(soc.garrison.durability) + num(rew.durability), 0, 100);
        deltas["秩序"] = Math.round(num(rew.order) * 100);
        gift.push("秩序 +" + Math.round(num(rew.order) * 100) + "%、驻军耐久 +" + num(rew.durability));
      } else if (id === "star") {
        if (soc.machine) soc.machine.tech = clamp(num(soc.machine.tech) + num(rew.tech), 0, 1);
        if (state.player) state.player.intelBuff = { level: rew.intel || "high", until: state.weeks + num(rew.intelWeeks, 52) };
        gift.push("科技 +" + num(rew.tech) + "、情报「高层」" + num(rew.intelWeeks, 52) + " 周");
      } else if (id === "fecund") {
        if (state.groups && state.groups.undecided) {
          state.groups.undecided.awake = num(state.groups.undecided.awake) + num(rew.birth);
        }
        deltas["人口"] = -lost + num(rew.birth);
        gift.push("新生 +" + num(rew.birth) + " 人");
      }

      // 可见后果：眷属暴增 + 秩序剧变
      var inf = soc.infection || (soc.infection = {});
      var gainThralls = Math.round(lost * num(R.thrallShare, 0.25));
      inf.bonus = num(inf.bonus) + gainThralls;
      inf.thralls = num(inf.thralls) + gainThralls;
      state.order = clamp(num(state.order) - num(R.orderHit, 0.06), 0.05, 1);
      adjustFavor(state, cfg, id, rec.primary ? num(R.favorGain, 5) : num(R.favorGainSide, 2));

      g.rapture[id] = now;
      g.rapture.global = now;
      g.history.push({ year: Math.round(now), id: id, type: "rapture",
        lost: lost, thralls: gainThralls, text: "神直接收人 " + lost + " 人" });
      if (g.history.length > 200) g.history.shift();

      pushEvent(state, cfg, "古神收人 · " + NAMES[id],
        NAMES[id] + "亲自伸手，从船上取走 " + lost + " 人；回赠：" + gift.join("、") +
        "。眷属 +" + gainThralls + "，秩序 −" + Math.round(num(R.orderHit, 0.06) * 100) + "%。",
        "神恩 ≥ " + num(R.minFavor, 60) + " · 年度概率 " + (p * 100).toFixed(0) +
          "%（旁约减半）· 取人 " + (num(tier.pop) * 100).toFixed(1) + "% × 神系数 " + mul,
        deltas, "这是赐福，也是收人；同一局有冷却");
      hit = { id: id, lost: lost, thralls: gainThralls };
    });
    return hit;
  }

  /* ---------------- 人口与部门 ---------------- */

  function removePop(state, n) {
    var gs = state.groups || {};
    var order = ["undecided", "service", "combat", "tech", "medical", "clone", "original"];
    var left = n;
    order.forEach(function (k) {
      if (left <= 0 || !gs[k]) return;
      var take = Math.min(left, num(gs[k].awake));
      gs[k].awake = num(gs[k].awake) - take;
      left -= take;
    });
    return n - left;
  }

  function randomDept(state, cfg) {
    var ds = (cfg.society && cfg.society.depts) || [];
    if (!ds.length) return null;
    return ds[Math.floor(randNext(state) * ds.length)];
  }

  /* ---------------- 祝福 / 诅咒 ---------------- */

  function refreshFlags(state, cfg, id, now) {
    var g = ensure(state, cfg);
    var rec = g.pacts[id];
    var G = cfg.gods || {};
    var blessAt = num(G.blessAt, 50), curseAt = num(G.curseAt, -50), calmAt = num(G.calmAt, 40);
    if (!rec.pact) { rec.blessed = false; rec.cursed = false; return; }
    if (!rec.blessed && rec.favor >= blessAt) {
      rec.blessed = true;
      g.history.push({ year: Math.round(now), id: id, type: "bless", text: "祝福 · " + NAMES[id] });
      pushEvent(state, cfg, "古神祝福 · " + NAMES[id], "古神满意了，祝福生效。",
        "好感 ≥" + blessAt, null, "古神站到了你这边");
    } else if (rec.blessed && rec.favor < calmAt) {
      rec.blessed = false;
      g.history.push({ year: Math.round(now), id: id, type: "blessEnd", text: "祝福消退 · " + NAMES[id] });
    }
    if (!rec.cursed && rec.favor <= curseAt) {
      rec.cursed = true;
      g.history.push({ year: Math.round(now), id: id, type: "curse", text: "诅咒 · " + NAMES[id] });
      pushEvent(state, cfg, "古神诅咒 · " + NAMES[id], "古神发怒了，诅咒降临。",
        "好感 ≤" + curseAt, null, "古神开始惩罚这条船");
    } else if (rec.cursed && rec.favor > -calmAt) {
      rec.cursed = false;
      g.history.push({ year: Math.round(now), id: id, type: "curseEnd", text: "诅咒消退 · " + NAMES[id] });
    }
  }

  function applyAnnualBlessCurse(state, cfg, id, now) {
    var g = ensure(state, cfg);
    var rec = g.pacts[id];
    var soc = state.society || {};
    var it = item(cfg, id);
    var side = rec.primary ? 1 : 0.5;
    if (rec.blessed) {
      if (id === "weaver" && soc.garrison) {
        var per = num((it.bless || {}).garrisonDurabilityPerYear, 26) * side;
        soc.garrison.durability = clamp(num(soc.garrison.durability) + per, 0, 100);
      }
      if (id === "weaver" && soc.effects) {
        soc.effects.infSpread = Math.min(num(soc.effects.infSpread, 1),
          num((it.bless || {}).convertMul, 0.80));
        soc.effects.infWeeks = Math.max(num(soc.effects.infWeeks), cfg.time.weeksPerYear);
      }
      if (id === "maw" && soc.queues && num((it.bless || {}).infectionC)) {
        soc.queues.forEach(function (q) {
          q.C = clamp(num(q.C) + num(it.bless.infectionC) * side, 0, 100);
        });
      }
    }
    if (rec.cursed && now % 10 === 0) {
      if (id === "maw") {
        var total = 0;
        Object.keys(state.groups || {}).forEach(function (k) { total += num(state.groups[k].awake); });
        var share = num(((it.curse) || {}).popSharePerDecade, 0.01);
        var lost = removePop(state, Math.max(1, Math.round(total * share)));
        if (lost) pushEvent(state, cfg, "缄默之喉 · 人口流失", "古神饿了，吞掉 " + lost + " 人。", "诅咒",
          { "人口": -lost }, "每十年少一批人");
      }
      if (id === "weaver") {
        var dep = randomDept(state, cfg);
        if (dep) {
          var dS = num(((it.curse) || {}).deptSPerDecade, 0.10);
          ((soc.queues) || []).forEach(function (q) {
            if (q.dept === dep && (q.layer === "L2" || q.layer === "L3")) q.S = clamp(num(q.S) + dS, 0, 1);
          });
          pushEvent(state, cfg, "赤织母 · 部门失序", dep + "的人更不服管了。", "诅咒",
            { "秩序": -3 }, "一个部门开始顶牛");
        }
      }
    }
    if (rec.cursed && id === "fecund") {
      var FC = it.curse || {};
      if (randNext(state) < num(FC.cloneMutant, 0.10)) {
        ((soc.queues) || []).forEach(function (q) { q.C = clamp(num(q.C) + 2, 0, 100); });
        var d2 = removePop(state, Math.max(1, Math.round(5 * num(FC.cloneDeathMul, 1.2))));
        pushEvent(state, cfg, "丰穰之腹 · 畸变", "克隆体畸变，感染加重，死了 " + d2 + " 人。", "诅咒",
          { "人口": -d2, "感染": 2 }, "克隆槽里出了怪胎");
      }
    }
  }

  /* ---------------- 周期索取 ---------------- */

  function mawTithe(state, cfg, now) {
    var total = 0;
    Object.keys(state.groups || {}).forEach(function (k) { total += num(state.groups[k].awake); });
    // v6.40：什一税额度随神恩上升（1–2.2 倍，指数边际递减）
    var T = (item(cfg, "maw") || {}).tithe || {};
    var need = Math.max(num(T.minPop, 8),
      Math.round(total * num(T.popShare, 0.008) * demandAmountMul(state, cfg, "maw")));
    var lost = removePop(state, need);
    pushEvent(state, cfg, "缄默之喉 · 吞食", "古神又饿了，吞下 " + lost + " 人。", "周期索取",
      { "人口": -lost }, "这条船定期要交人");
    return lost;
  }

  function starTithe(state, cfg) {
    var mul = demandAmountMul(state, cfg, "star");
    if (randNext(state) < 0.5) {
      var loss = Math.round(5 * mul);
      state.order = clamp(num(state.order) - 0.01 * loss, 0.05, 1);
      pushEvent(state, cfg, "星启者 · 知识代价", "星启者带走一部分知识，秩序 −" + loss + "%。", "周期索取",
        { "秩序": -loss }, "知道得越多，越难管");
    } else {
      var drug = Math.round(40 * mul);
      state.stocks.drug = Math.max(0, num(state.stocks.drug) - drug);
      pushEvent(state, cfg, "星启者 · 知识代价", "星启者拿走了 " + drug + " 份休眠药剂。", "周期索取",
        null, "药剂被抽走一批");
    }
  }

  function resolveTithe(state, cfg, accept, silent) {
    var g = ensure(state, cfg);
    if (!g.pendingTithe) return { ok: false, msg: "当前没有待回应的索取" };
    var t = g.pendingTithe;
    var it = item(cfg, t.id);
    var T = it.tithe || {};
    var soc = state.society || {};
    var msg;
    if (t.id === "weaver") {
      if (accept) {
        adjustFavor(state, cfg, "weaver", num(T.acceptFavor, 10));
        state.order = clamp(num(state.order) + num(T.acceptOrder, 0.03), 0.05, 1);
        var l2 = ((soc.queues || []).filter(function (q) { return q.layer === "L2"; }))[0];
        if (l2) l2.dPenalty = num(l2.dPenalty) + 6;
        else removePop(state, num(T.l4, 20));
        msg = "献祭被接受了，古神满意，秩序 +3%。";
      } else {
        adjustFavor(state, cfg, "weaver", num(T.refuseFavor, -30));
        var refuseC = num(T.refuseC, 4) * demandAmountMul(state, cfg, "weaver");
        ((soc.queues) || []).forEach(function (q) { q.C = clamp(num(q.C) + refuseC, 0, 100); });
        msg = "你拒绝了，古神发怒，所有人感染加重。";
      }
    } else {
      msg = "索取已经了结。";
    }
    if (!silent) pushEvent(state, cfg, "古神索取 · " + NAMES[t.id], msg, "第 " + Math.round(t.year + 1) + " 年",
      accept ? { "秩序": 3 } : { "感染": 4 }, accept ? "献祭换来了暂时的安宁" : "拒绝的代价是全船");
    g.pendingTithe = null;
    return { ok: true, msg: msg, accept: !!accept };
  }

  /* ---------------- 年度 ---------------- */

  function yearly(state, cfg) {
    var g = ensure(state, cfg);
    if (!g.enabled || g.legacy) return null;
    if (state.weeks % cfg.time.weeksPerYear !== 0) return null;
    var now = absYear(state, cfg);
    var soc = state.society || {};
    var it;

    // 上一年未回应的织母索取 → 视为拒绝
    if (g.pendingTithe && g.pendingTithe.id === "weaver" && now > g.pendingTithe.year + 0.5) {
      resolveTithe(state, cfg, false);
    }

    IDS.forEach(function (id) {
      var rec = g.pacts[id];
      if (!rec.pact) return;
      it = item(cfg, id);

      // 神恩自然回归：每 10 年向 0 靠 2 点
      if (now % 10 === 0 && rec.favor !== 0) {
        var step = Math.min(num(cfg.gods.favorRegressPerDecade, 2), Math.abs(rec.favor));
        rec.favor += rec.favor > 0 ? -step : step;
      }
      // 先刷新祝福/诅咒状态，再结算其效果（当年跨阈值当年生效）
      refreshFlags(state, cfg, id, now);

      // 被动
      if (id === "star" && soc.machine) {
        soc.machine.tech = clamp(num(soc.machine.tech) + num((it.passive || {}).techPerYear, 0.002), 0, 1);
      }
      if (id === "fecund") {
        var cAdd = num((it.passive || {}).infectionCPerYear, 0.5);
        ((soc.queues) || []).forEach(function (q) { q.C = clamp(num(q.C) + cAdd, 0, 100); });
      }
      if (id === "maw" && rec.primary) {
        devourAdd(state, cfg, num(cfg.gods.mawDevourPerYear, 0.5));
      }

      // 周期索取：间隔随神恩缩短（最快 5 年一次）
      var every = titheInterval(state, cfg, id, num(it.titheEveryYears, 0));
      var dueYear = num(rec.lastTithe, now);
      if (every > 0 && now - dueYear >= every) {
        rec.lastTithe = now;
        if (id === "maw") {
          mawTithe(state, cfg, now);
        } else if (id === "weaver") {
          if (!g.pendingTithe) {
            g.pendingTithe = { id: "weaver", year: Math.round(now), atWeek: state.weeks,
              ask: "赤织母要一次献祭：处决 1 个中层贵族，或 20 个平民。", acceptText: "献祭", refuseText: "拒绝" };
            pushEvent(state, cfg, "赤织母 · 索取献祭",
              "赤织母每 50 年要一次献祭：答应就秩序 +3%，拒绝就全船感染加重。", "周期索取");
          }
        } else if (id === "star") {
          starTithe(state, cfg);
        }
      }

      if (id === "star" && rec.cursed && soc.machine) {
        // v6.37：机器自主年增量读 curse.machineAutonomyPerYear
        soc.machine.A = clamp(num(soc.machine.A) + num((it.curse || {}).machineAutonomyPerYear, 0.02), 0, 1);
      }
      applyAnnualBlessCurse(state, cfg, id, now);
    });

    // 神直接收人：每年一次，受同神 15 年 / 全局 8 年冷却约束
    raptureCheck(state, cfg, now);

    return g.pendingTithe;
  }

  function afterCard(state, cfg) {
    var g = ensure(state, cfg);
    if (!g.enabled || g.legacy) return;
    var now = absYear(state, cfg);
    IDS.forEach(function (id) {
      if (g.pacts[id].pact) refreshFlags(state, cfg, id, now);
    });
    g.devour = clamp(num(g.devour), 0, num(cfg.gods.devourCap, 100));
  }

  /* ---------------- 修正查询 ---------------- */

  function gMul(state, cfg, key, base) {
    var g = state.gods;
    if (!g || !g.enabled || g.legacy || !g.pacts) return typeof base === "number" ? base : 1;
    var out = typeof base === "number" ? base : 1;
    var prim = primaryOf(state, cfg);
    IDS.forEach(function (id) {
      var rec = g.pacts[id];
      if (!rec || !rec.pact) return;
      var side = rec.primary ? 1 : 0.5;
      if (key === "birthMul" && id === "fecund") out *= 1 + (1.25 - 1) * side;
      if (key === "cloneMul" && id === "fecund") out *= 1 + (1.15 - 1) * side;
      if (key === "foodUse" && id === "fecund") {
        out *= num((item(cfg, "fecund").passive || {}).foodUseMul, 1.08);
      }
      if (key === "prodMul" && id === "maw" && rec.blessed) out *= 1 + 0.03 * side;
      if (key === "exploreMul" && id === "star") out *= (prim === "star" ? 1.5 : 1.2);
    });
    return out;
  }

  function pregnancyMul(state, cfg) {
    var g = state.gods;
    if (!g || !g.enabled || g.legacy) return 1;
    var rec = g.pacts.fecund;
    if (!rec || !rec.pact || !rec.blessed) return 1;
    // v6.37：怀孕倍率读 bless.pregnancy，副约只取一半增幅
    var base = num((item(cfg, "fecund").bless || {}).pregnancy, 1.5);
    return 1 + (base - 1) * (rec.primary ? 1 : 0.5);
  }

  function rarityBoost(state, cfg, cat) {
    var g = state.gods;
    if (!g || !g.enabled || g.legacy) return 0;
    var rec = g.pacts.star;
    if (cat === "tech" && rec && rec.pact && rec.blessed) {
      // v6.37：稀有度提升档数读 bless.techRarity，副约向下取整
      var n = num((item(cfg, "star").bless || {}).techRarity, 1);
      return rec.primary ? n : Math.floor(n * 0.5);
    }
    return 0;
  }

  // v6.37：星启者诅咒对机器哗变概率的放大（接进 machine_takeover 判定）
  function machineMutinyMul(state, cfg) {
    var g = state.gods;
    if (!g || !g.enabled || g.legacy || !g.pacts) return 1;
    var rec = g.pacts.star;
    if (!rec || !rec.pact || !rec.cursed) return 1;
    return num((item(cfg, "star").curse || {}).machineMutinyMul, 1.4);
  }

  function brief(state, cfg) {
    var g = ensure(state, cfg);
    var now = absYear(state, cfg);
    var ch = g.church || {};
    var visible = !!ch.formed;   // 教会未成形时不下发神恩数值
    var list = IDS.map(function (id) {
      var it = item(cfg, id);
      var rec = g.pacts[id];
      var every = titheInterval(state, cfg, id, num(it.titheEveryYears, 0));
      return {
        id: id,
        name: it.name || NAMES[id],
        lean: it.lean || "",
        pact: !!rec.pact,
        primary: !!rec.primary,
        favor: visible ? Math.round(num(rec.favor)) : null,
        blessed: !!rec.blessed,
        cursed: !!rec.cursed,
        since: Math.round(num(rec.since)),
        demandMul: rec.pact ? Math.round(demandAmountMul(state, cfg, id) * 100) / 100 : 1,
        freqMul: rec.pact ? Math.round(demandFreqMul(state, cfg, id) * 100) / 100 : 1,
        nextTitheIn: rec.pact && every > 0
          ? Math.max(0, Math.ceil(every - (now - num(rec.lastTithe, now)))) : null
      };
    });
    var f = favorFrac(state, cfg);
    var tol = toleranceOf(state, cfg);
    var cm = churchMetrics(state, cfg);
    return {
      version: VERSION,
      enabled: !!g.enabled && !g.legacy,
      legacy: !!g.legacy,
      primary: primaryOf(state, cfg),
      devour: Math.round(num(g.devour) * 10) / 10,
      devourCap: num(cfg.gods.devourCap, 100),
      pacts: list,
      pendingTithe: g.pendingTithe,
      church: {
        formed: visible,
        favorVisible: visible,
        since: Math.round(num(ch.since)),
        formedYear: num(ch.formedYear),
        dissolvedYear: num(ch.dissolvedYear),
        score: num(ch.score),
        thralls: num(ch.thralls),
        ratio: num(ch.ratio),
        weeksUp: num(ch.weeksUp),
        weeksDown: num(ch.weeksDown),
        leader: ch.leader || null,
        gateThralls: Math.round(cm.gateThralls),
        gate: !!cm.gate,
        formScore: num((cfg.gods.church || {}).formScore, 0.55),
        formWeeks: num((cfg.gods.church || {}).formWeeks, 4),
        dissolveScore: num((cfg.gods.church || {}).dissolveScore, 0.42),
        dissolveWeeks: num((cfg.gods.church || {}).dissolveWeeks, 12)
      },
      tolerance: {
        f: Math.round(f * 1000) / 1000,
        tol: Math.round(tol * 1000) / 1000,
        infectionMul: Math.round((1 - tol) * 1000) / 1000,
        dreamMul: Math.round((1 - num(((cfg.gods || {}).tolerance || {}).dreamMul, 0.6) * tol) * 1000) / 1000
      },
      history: (g.history || []).slice(-20),
      lastRapture: (function () {
        var hs = (g.history || []).filter(function (h) { return h.type === "rapture"; });
        return hs.length ? hs[hs.length - 1] : null;
      })()
    };
  }

  var api = {
    version: VERSION,
    create: create,
    ensure: ensure,
    makePact: makePact,
    primaryOf: primaryOf,
    pacted: pacted,
    adjustFavor: adjustFavor,
    devourAdd: devourAdd,
    weekly: updateChurch,
    churchMetrics: churchMetrics,
    infectionTolerance: infectionTolerance,
    dreamTolerance: dreamTolerance,
    toleranceOf: toleranceOf,
    favorFrac: favorFrac,
    demandAmountMul: demandAmountMul,
    demandFreqMul: demandFreqMul,
    raptureCheck: raptureCheck,
    yearly: yearly,
    afterCard: afterCard,
    resolveTithe: resolveTithe,
    brief: brief,
    isBlessed: isBlessed,
    isCursed: isCursed,
    gMul: gMul,
    pregnancyMul: pregnancyMul,
    rarityBoost: rarityBoost,
    machineMutinyMul: machineMutinyMul,
    names: NAMES,
    ids: IDS
  };

  global.XuanShuGods = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : global);
