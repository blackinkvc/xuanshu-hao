/* =========================================================================
   玄枢号 · 监狱与献祭（sim-prison.js）
   -------------------------------------------------------------------------
   囚徒个体：罪名 → 判罚 → 刑罚年效果 → 死亡 / 释放；献祭按来源与知情传播结算。
   所有常量来自 sim-config 的 prison / sacrifice 两段，不在这里另写一套。
   随机只走 state.rngA（全局唯一随机数流）。
   ========================================================================= */
(function (global) {
  "use strict";

  var VERSION = "1.0.0";

  var LAYER_OF_GROUP = {
    original: "L1", noble: "L1", combat: "L2", tech: "L3",
    service: "L4", medical: "L4", clone: "L4", undecided: "L4", derelict: "L4"
  };

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
      type: "prison", level: "监狱", title: title, text: text, basis: basis || ""
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

  /* ---------------- 初始化 ---------------- */

  function create(cfg) {
    return {
      version: VERSION,
      enabled: !(cfg.prison && cfg.prison.enabled === false),
      roster: [],
      captives: 0,
      history: [],
      seq: 0,
      stats: { convicted: 0, executed: 0, died: 0, released: 0, sacrificed: 0, mutated: 0 },
      lastCrimeWeek: -999
    };
  }

  function ensure(state, cfg) {
    if (!state.prison || typeof state.prison !== "object") state.prison = create(cfg);
    var p = state.prison;
    if (!Array.isArray(p.roster)) p.roster = [];
    if (!Array.isArray(p.history)) p.history = [];
    if (!p.stats) p.stats = { convicted: 0, executed: 0, died: 0, released: 0, sacrificed: 0, mutated: 0 };
    if (typeof p.stats.mutated !== "number") p.stats.mutated = 0;
    if (typeof p.captives !== "number") p.captives = 0;
    if (typeof p.seq !== "number") p.seq = p.roster.length;
    if (typeof p.lastCrimeWeek !== "number") p.lastCrimeWeek = -999;
    if (typeof p.enabled !== "boolean") p.enabled = !(cfg.prison && cfg.prison.enabled === false);
    return p;
  }

  /* ---------------- 人口口径 ---------------- */

  function awakeTotal(state) {
    var n = 0;
    Object.keys(state.groups || {}).forEach(function (k) { n += num(state.groups[k].awake); });
    return Math.max(0, Math.round(n));
  }

  function dormantTotal(state) {
    var n = 0;
    Object.keys(state.groups || {}).forEach(function (k) { n += num(state.groups[k].dormant); });
    return Math.max(0, Math.round(n));
  }

  function layerOf(gid) { return LAYER_OF_GROUP[gid] || "L4"; }

  /** 全船清醒人口的阶级权重均值（按各组人数加权）。 */
  function avgLayerWeight(state, cfg) {
    var W = (cfg.sacrifice && cfg.sacrifice.classWeight) || { L1: 1.5, L2: 1.25, L3: 1.0, L4: 0.75 };
    var sw = 0, sv = 0;
    Object.keys(state.groups || {}).forEach(function (gid) {
      var n = num(state.groups[gid].awake);
      if (n <= 0) return;
      sw += n;
      sv += n * num(W[layerOf(gid)], 1);
    });
    return sw > 0 ? sv / sw : 1;
  }

  /** 从某组扣 1 个清醒者；没指定组时按清醒人数占比抽。 */
  function takeAwake(state, gid) {
    var gs = state.groups || {};
    if (gid && gs[gid] && num(gs[gid].awake) > 0) {
      gs[gid].awake = num(gs[gid].awake) - 1;
      return gid;
    }
    var ids = Object.keys(gs).filter(function (k) { return k !== "noble" && num(gs[k].awake) > 0; });
    if (!ids.length) ids = Object.keys(gs).filter(function (k) { return num(gs[k].awake) > 0; });
    if (!ids.length) return null;
    var total = ids.reduce(function (a, k) { return a + num(gs[k].awake); }, 0);
    var r = randNext(state) * total, acc = 0;
    for (var i = 0; i < ids.length; i++) {
      acc += num(gs[ids[i]].awake);
      if (r < acc - 1e-9) {
        gs[ids[i]].awake = num(gs[ids[i]].awake) - 1;
        return ids[i];
      }
    }
    gs[ids[0]].awake = num(gs[ids[0]].awake) - 1;
    return ids[0];
  }

  function addAwake(state, gid) {
    if (state.groups && state.groups[gid]) {
      state.groups[gid].awake = num(state.groups[gid].awake) + 1;
      return true;
    }
    return false;
  }

  function penalty(cfg, id) {
    return ((cfg.prison && cfg.prison.penalties) || {})[id] || {};
  }

  function crime(cfg, id) {
    return ((cfg.prison && cfg.prison.crimes) || {})[id] || null;
  }

  /* ---------------- 判罚 ---------------- */

  function triggerCrime(state, cfg, opts) {
    opts = opts || {};
    var P = ensure(state, cfg);
    if (!P.enabled) return { ok: false, msg: "监狱层未启用" };
    var key = opts.crime || "sabotage";
    var cr = crime(cfg, key);
    if (!cr) return { ok: false, msg: "未知罪名：" + key };
    var sev = clamp(rnd(opts.severity || 1), 1, 3);
    var prob = key === "nobleRevolt" ? num(cr.prob, 0.85) : num((cr.prob || {})[sev], 0.5);
    if (typeof opts.count !== "number" && randNext(state) > prob) {
      P.lastCrimeWeek = state.weeks;
      return { ok: true, convicted: 0, severity: sev, msg: "这次没收网到人" };
    }

    var involve = num(opts.involved, 12);
    var rate = num((cfg.prison.captureRate || {})[sev], 0.25);
    var count = typeof opts.count === "number" && opts.count > 0
      ? rnd(opts.count)
      : clamp(Math.round(involve * rate), 1, num(cfg.prison.maxPerCrime, 8));
    if (key === "nobleRevolt") count = clamp(count, num(cr.min, 1), num(cr.max, 3));

    var pool = (cr.pool || ["jail"]).slice();
    var yearsRange = (cr.years || {})[sev] || [100, 140];
    var entries = [];
    for (var i = 0; i < count; i++) {
      var gid = key === "nobleRevolt"
        ? (num(state.groups && state.groups.noble && state.groups.noble.awake) > 0 ? "noble" : null)
        : (opts.group || null);
      gid = takeAwake(state, gid);
      if (!gid) break;
      var pid = "C" + (++P.seq);
      var penId = pool[Math.floor(randNext(state) * pool.length)] || "jail";
      var pen = penalty(cfg, penId);
      var years = yearsRange[0] + Math.floor(randNext(state) * Math.max(1, yearsRange[1] - yearsRange[0] + 1));
      if (sev >= 3 && cr.lifeAt3) years = 9999;
      var term = Math.max(1, Math.round(years * num(pen.termMul, 1)));
      var pr = {
        id: pid,
        name: "囚徒 " + pid,
        gid: gid,
        layer: layerOf(gid),
        noble: gid === "noble",
        crime: key,
        crimeName: cr.name || key,
        penalty: penId,
        penaltyName: pen.name || penId,
        severity: sev,
        sentenceYears: years,
        termYears: term,
        served: 0,
        hp: 100,
        mind: clamp(100 + num(pen.mindStart, 0), 0, 100),
        will: clamp(100 + num(pen.willStart, 0), 0, 100),
        status: "held",
        startYear: Math.round(absYear(state, cfg)),
        endYear: null,
        note: "",
        dose: 0,
        mutated: false,
        mutation: "",
        mutYear: null,
        mutationLabor: 0
      };
      P.roster.push(pr);
      entries.push(pr);
      P.stats.convicted++;
    }
    P.lastCrimeWeek = state.weeks;
    var cap = num(cfg.prison.rosterCap, 60);
    if (P.roster.length > cap) {
      var keep = P.roster.filter(function (x) { return x.status === "held"; });
      var rest = P.roster.filter(function (x) { return x.status !== "held"; });
      P.roster = keep.concat(rest.slice(-Math.max(0, cap - keep.length)));
    }

    if (entries.length) {
      pushEvent(state, cfg, "判罚 · " + (cr.name || key),
        "本次判罚 " + entries.length + " 人：" + entries.map(function (e) {
          return e.name + "（" + e.penaltyName + "，" + (e.sentenceYears >= 9999 ? "无期" : e.sentenceYears + " 年") + "）";
        }).join("、"),
        "第 " + sev + " 档严重度 · 捕获率 " + Math.round(rate * 100) + "%",
        { "人口": -entries.length }, "囚徒从各编制中划出，进入监狱名册");
    }
    return { ok: true, convicted: entries.length, severity: sev, entries: entries, roster: list(state, cfg) };
  }

  /* ---------------- 年度结算 ---------------- */

  function yearly(state, cfg) {
    var P = ensure(state, cfg);
    if (!P.enabled) return null;
    if (state.weeks % cfg.time.weeksPerYear !== 0) return null;

    var labor = 0, died = 0, released = 0, mutations = [], orderGain = 0;
    var MF = (cfg.prison && cfg.prison.mutation) || {};
    P.roster.forEach(function (pr) {
      if (pr.status !== "held") return;
      var pen = penalty(cfg, pr.penalty);
      pr.served++;

      var hpLoss = num(pen.hpPerYear, 0);
      pr.hp = clamp(num(pr.hp, 100) + hpLoss, 0, 100);
      var mindMul = pr.noble ? num(pen.nobleMindMul, 1) : 1;
      pr.mind = clamp(num(pr.mind, 100) + num(pen.mindPerYear, 0) * mindMul, 0, 100);
      pr.will = clamp(num(pr.will, 100) + num(pen.willPerYear, 0)
        + (pr.served === 1 ? num(pen.willFirstYear, 0) : 0), 0, 100);

      // 辐射刑：先按原死亡曲线结算，再对存活者判变异（冬季只累加剂量）
      if (pr.penalty === "rad") {
        pr.dose = clamp(num(pr.dose, 0) + num(MF.dosePerYear, 0.06), 0, 3);
      }
      if (num(pen.deathRiskK, 0) > 0) {
        var deathP = clamp((100 - num(pr.hp, 100)) / 100 * num(pen.deathRiskK, 0), 0, 0.95);
        if (randNext(state) < deathP) pr.hp = 0;
      }
      if (pr.hp <= 0) {
        pr.status = "dead";
        pr.endYear = Math.round(absYear(state, cfg));
        pr.note = "刑罚执行中死亡";
        P.stats.died++;
        died++;
        return;
      }

      // 辐射变异：只触发一次，后果写进个体属性与名册
      if (pr.penalty === "rad" && !pr.mutated) {
        var mutP = Math.min(num(MF.maxChance, 0.6), num(pr.dose, 0) * num(MF.chanceK, 0.55));
        pr.mutChance = Math.round(mutP * 1000) / 1000;
        if (randNext(state) < mutP) {
          var traits = MF.traits || [];
          var tr = traits.length ? traits[Math.floor(randNext(state) * traits.length) % traits.length] : {};
          pr.mutated = true;
          pr.mutation = tr.name || "未分类变异";
          pr.mutYear = Math.round(absYear(state, cfg));
          pr.hp = clamp(num(pr.hp, 100) + num(tr.hp), 0, 100);
          pr.mind = clamp(num(pr.mind, 100) + num(tr.mind), 0, 100);
          pr.will = clamp(num(pr.will, 100) + num(tr.will), 0, 100);
          pr.mutationLabor = num(tr.labor);
          P.stats.mutated++;
          mutations.push(pr.name + "（" + pr.mutation + "）");
          if (pr.hp <= 0) {
            pr.status = "dead";
            pr.endYear = Math.round(absYear(state, cfg));
            pr.note = "变异后器官衰竭";
            P.stats.died++;
            died++;
            return;
          }
        }
      }

      if (pr.served === 1 && num(pen.orderShift, 0)) {
        orderGain += num(pen.orderShift, 0);
      } else if (pr.served > 1 && pr.served <= num(pen.orderYearsMax, 0) && num(pen.orderYearly, 0)) {
        orderGain += num(pen.orderYearly, 0);
      }
      var laborPer = num(pen.laborMetalPerYear, 0) + num(pr.mutationLabor, 0);
      if (laborPer > 0) labor += laborPer;

      if (pr.served >= pr.termYears) {
        pr.status = "released";
        pr.endYear = Math.round(absYear(state, cfg));
        pr.note = "刑满释放";
        P.stats.released++;
        released++;
        addAwake(state, pr.gid);
      }
    });

    if (orderGain > 0) {
      var capOrder = num(cfg.prison.orderShiftCap, 0.06);
      state.order = clamp(num(state.order) + Math.min(orderGain, capOrder), 0.05, 1);
    }
    if (labor > 0) {
      var cap = num(cfg.metal && cfg.metal.cap, 0);
      state.stocks.metal = clamp(num(state.stocks.metal) + labor, 0, cap > 0 ? cap : 1e9);
    }
    if (died || released || mutations.length) {
      pushEvent(state, cfg, "监狱年度结算",
        "在押 " + P.roster.filter(function (x) { return x.status === "held"; }).length +
        " 人 · 本年死亡 " + died + " · 释放 " + released + " · 劳动产出 " + Math.round(labor) + " 吨金属" +
        (mutations.length ? " · 辐射变异 " + mutations.length + " 例：" + mutations.join("、") : ""),
        "刑期按年递减；健康归零即死亡；辐射刑按累计剂量结算变异概率",
        { "人口": released, "金属": Math.round(labor) }, "名册与人口同步");
    }

    // 哗变 L2 及以上：自动抓捕一批涉事者（26 周冷却）
    var lv = num(state.society && state.society.mutiny && state.society.mutiny.level, 0);
    if (lv >= 2 && state.weeks - num(P.lastCrimeWeek, -999) >= num(cfg.prison.autoRiotCoolWeeks, 26)) {
      triggerCrime(state, cfg, { crime: "riot", severity: clamp(lv - 1, 1, 3), involved: 18 });
    }
    return brief(state, cfg);
  }

  /* ---------------- 可用来源 ---------------- */

  var SOURCE_ORDER = [
    "prisoner_normal", "prisoner_noble", "crew_normal", "crew_noble",
    "captive", "dormant_normal", "dormant_noble"
  ];

  function sourceCount(state, cfg, id) {
    var P = ensure(state, cfg);
    var gs = state.groups || {};
    var held = P.roster.filter(function (x) { return x.status === "held"; });
    switch (id) {
      case "prisoner_normal": return held.filter(function (x) { return !x.noble; }).length;
      case "prisoner_noble": return held.filter(function (x) { return x.noble; }).length;
      case "crew_normal": {
        var n = 0;
        Object.keys(gs).forEach(function (k) { if (k !== "noble") n += num(gs[k].awake); });
        return Math.round(n);
      }
      case "crew_noble": return Math.round(num(gs.noble && gs.noble.awake));
      case "captive": return Math.max(0, Math.round(num(P.captives)));
      case "dormant_normal": {
        var d = 0;
        Object.keys(gs).forEach(function (k) { if (k !== "noble") d += num(gs[k].dormant); });
        return Math.round(d);
      }
      case "dormant_noble": return Math.round(num(gs.noble && gs.noble.dormant));
      default: return 0;
    }
  }

  function noteFor(id) {
    return {
      prisoner_normal: "监狱里的普通囚徒",
      prisoner_noble: "监狱里的贵族囚徒",
      crew_normal: "醒着的平民",
      crew_noble: "醒着的贵族",
      captive: "俘虏池",
      dormant_normal: "休眠舱里的普通人",
      dormant_noble: "休眠舱里的贵族"
    }[id] || id;
  }

  function candidates(state, cfg) {
    var S = (cfg.sacrifice && cfg.sacrifice.sources) || {};
    return SOURCE_ORDER.map(function (id) {
      var n = sourceCount(state, cfg, id);
      var s = S[id] || {};
      return {
        id: id,
        name: s.name || noteFor(id),
        note: noteFor(id),
        noble: !!s.noble,
        count: n,
        available: n > 0,
        reason: n > 0 ? "" : "没有可用的" + noteFor(id)
      };
    });
  }

  /* ---------------- 献祭 ---------------- */

  function addC(state, v) {
    ((state.society && state.society.queues) || []).forEach(function (q) {
      q.C = clamp(num(q.C) + v, 0, 100);
    });
  }

  function sacrifice(state, cfg, sel) {
    sel = sel || {};
    var P = ensure(state, cfg);
    if (!P.enabled) return { ok: false, msg: "监狱层未启用" };
    var S = ((cfg.sacrifice && cfg.sacrifice.sources) || {})[sel.source];
    if (!S) return { ok: false, msg: "未知献祭来源：" + (sel.source || "空") };
    var have = sourceCount(state, cfg, sel.source);
    if (have <= 0) return { ok: false, msg: "没有可用的" + noteFor(sel.source) };

    var time = sel.time || "night";
    var timeK = num((cfg.sacrifice.timeSlots || {})[time], 0.6);
    var side = 1;
    var god = sel.god || null;
    if (global.XuanShuGods) {
      var prim = global.XuanShuGods.primaryOf ? global.XuanShuGods.primaryOf(state, cfg) : null;
      if (god && prim && god !== prim) side = num(cfg.sacrifice.sideMul, 0.5);
      else if (!god) side = 1;
    }
    var noble = !!S.noble;
    var favor = Math.round(num(S.favor) * side * (noble ? num(cfg.sacrifice.nobleMul, 1.4) : 1));

    // 先落账再结算收益，保证人数与结果一致
    var target = "";
    var spreadK = 1;
    if (sel.source.indexOf("prisoner") === 0) {
      var pick = null;
      for (var i = 0; i < P.roster.length; i++) {
        var x = P.roster[i];
        if (x.status !== "held" || x.noble !== noble) continue;
        pick = x;
        if (!sel.pid || x.id === sel.pid) break;
      }
      if (!pick) return { ok: false, msg: "名册里没有匹配的囚徒" };
      pick.status = "dead";
      pick.endYear = Math.round(absYear(state, cfg));
      pick.note = "被献祭";
      spreadK = num(penalty(cfg, pick.penalty).spreadMul, 1);
      target = pick.name + "（" + pick.penaltyName + "）";
    } else if (sel.source === "captive") {
      P.captives = Math.max(0, num(P.captives) - 1);
      target = "1 名俘虏";
    } else if (sel.source === "crew_normal" || sel.source === "crew_noble") {
      var gid = takeAwake(state, sel.source === "crew_noble" ? "noble" : null);
      if (!gid) return { ok: false, msg: "没有可献祭的清醒者" };
      target = "1 名" + (sel.source === "crew_noble" ? "贵族" : "船员");
    } else if (sel.source === "dormant_normal" || sel.source === "dormant_noble") {
      var dg = sel.source === "dormant_noble" ? "noble" : (num(state.groups.original && state.groups.original.dormant) > 0 ? "original" : "noble");
      var g = state.groups && state.groups[dg];
      if (!g || num(g.dormant) <= 0) return { ok: false, msg: "休眠舱里没有可献祭的人" };
      g.dormant = num(g.dormant) - 1;
      target = "1 名休眠" + (dg === "noble" ? "贵族" : "者");
    }

    // 收益
    if (favor && global.XuanShuGods && global.XuanShuGods.adjustFavor) {
      global.XuanShuGods.adjustFavor(state, cfg, god, favor);
    }
    var orderD = num(S.order);
    if (orderD) state.order = clamp(num(state.order) + orderD, 0.05, 1);
    if (num(S.infectionC)) addC(state, num(S.infectionC));
    if (num(S.devour) && state.gods) {
      state.gods.devour = clamp(num(state.gods.devour) + num(S.devour), 0, num(cfg.gods && cfg.gods.devourCap, 100));
    }
    if (num(S.thralls) && state.society && state.society.infection) {
      state.society.infection.thralls = Math.max(0, num(state.society.infection.thralls) + num(S.thralls));
    }

    // 知情传播
    var discovered = true;
    if (sel.source.indexOf("dormant") === 0) {
      discovered = randNext(state) < num(S.discoverK, 0.35);
    }
    var awake = awakeTotal(state);
    var known = discovered
      ? clamp(Math.round(num(S.witness) * num(S.spread) * spreadK * num(S.identityK, 1) * timeK * num(S.sourceK, 1)), 0, awake)
      : 0;
    var share = awake > 0 ? known / awake : 0;
    var avgW = avgLayerWeight(state, cfg);
    var weighted = clamp(share * avgW, 0, 1);
    var drop = num(S.baseDrop) * weighted;
    var unrest = num(S.baseUnrest) * weighted;
    if (sel.source.indexOf("dormant") === 0 && discovered) {
      drop *= num(cfg.sacrifice.dormantExposedDropMul, 2.2);
      state.order = clamp(num(state.order) + num(cfg.sacrifice.dormantExposedOrder, -0.03), 0.05, 1);
    }
    drop = Math.round(drop * 100) / 100;
    unrest = Math.round(unrest * 100) / 100;
    var soc = state.society;
    if (soc && soc.effects) {
      soc.effects.oShift = num(soc.effects.oShift) - drop;
      soc.effects.wShift = num(soc.effects.wShift) + unrest;
      soc.effects.oWeeks = Math.max(num(soc.effects.oWeeks), cfg.time.weeksPerYear / 2);
      soc.effects.wWeeks = Math.max(num(soc.effects.wWeeks), cfg.time.weeksPerYear / 2);
    }

    P.stats.sacrificed++;
    var rec = {
      year: Math.round(absYear(state, cfg)),
      week: state.weeks,
      source: sel.source,
      sourceName: S.name || noteFor(sel.source),
      target: target,
      god: god || "",
      favor: favor,
      orderPct: Math.round(orderD * 1000) / 10,
      known: known,
      awake: awake,
      share: Math.round(share * 1000) / 1000,
      avgWeight: Math.round(avgW * 100) / 100,
      drop: drop,
      unrest: unrest,
      discovered: discovered,
      time: time
    };
    P.history.push(rec);
    P.lastResult = rec;
    if (P.history.length > num(cfg.prison.historyCap, 200)) P.history.shift();

    var delta = { "神恩": favor, "秩序": Math.round(orderD * 1000) / 10 };
    if (drop) delta["服从"] = -drop;
    if (unrest) delta["不服"] = unrest;
    pushEvent(state, cfg, "献祭 · " + (S.name || noteFor(sel.source)),
      target + " 被献祭。知情 " + known + " / " + awake + " 人（" +
      (time === "day" ? "白天公开" : time === "private" ? "私密处决" : "夜间") + "）" +
      (discovered ? "" : "，没有惊动任何人") +
      " · 服从 " + (drop >= 0 ? "−" : "+") + Math.abs(drop) + " · 不服 +" + unrest,
      "神恩 " + (favor >= 0 ? "+" : "") + favor + "，知情占比 " + Math.round(share * 100) +
      "%，平均阶级权重 " + (Math.round(avgW * 100) / 100),
      delta, "献祭按来源与知情范围结算，不是无条件全船服从");
    return { ok: true, msg: "献祭已结算", result: rec, sacrifice: brief(state, cfg) };
  }

  /* ---------------- 只读视图 ---------------- */

  function list(state, cfg) {
    var P = ensure(state, cfg);
    var held = P.roster.filter(function (x) { return x.status === "held"; });
    var dist = {};
    held.forEach(function (x) { dist[x.penaltyName] = (dist[x.penaltyName] || 0) + 1; });
    return {
      held: held.length,
      total: P.roster.length,
      captives: Math.max(0, Math.round(num(P.captives))),
      distribution: dist,
      roster: P.roster.slice(-12).map(function (x) {
        return {
          id: x.id, name: x.name, status: x.status, noble: !!x.noble,
          crimeName: x.crimeName, penaltyName: x.penaltyName,
          sentenceYears: x.sentenceYears, termYears: x.termYears, served: x.served,
          hp: Math.round(x.hp), mind: Math.round(x.mind), will: Math.round(x.will),
          dose: Math.round(num(x.dose, 0) * 100) / 100,
          mutated: !!x.mutated, mutation: x.mutation || "", mutYear: x.mutYear || null,
          note: x.note || ""
        };
      }),
      stats: {
        convicted: P.stats.convicted, executed: P.stats.executed,
        died: P.stats.died, released: P.stats.released, sacrificed: P.stats.sacrificed,
        mutated: num(P.stats.mutated)
      },
      history: P.history.slice(-10)
    };
  }

  function brief(state, cfg) {
    return list(state, cfg);
  }

  var api = {
    version: VERSION,
    create: create,
    ensure: ensure,
    triggerCrime: triggerCrime,
    yearly: yearly,
    candidates: candidates,
    sacrifice: sacrifice,
    list: list,
    brief: brief,
    avgLayerWeight: avgLayerWeight
  };

  global.XuanShuPrison = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
