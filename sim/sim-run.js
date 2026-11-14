/* =========================================================================
   玄枢号 · 千年节点 / 自动推演 / 胜负（sim-run.js）
   -------------------------------------------------------------------------
   每 1,000 年一次节点；41,000 年（41 轮）胜利；7 条失败按优先级。
   state.run 跨轮保留：运气、自动开关、节点、胜负、连续计数。
   随机只走 state.rngA。
   ========================================================================= */
(function (global) {
  "use strict";

  var VERSION = "1.0.0";

  var FAILS = [
    { id: "player_death", label: "你死了" },
    { id: "rebellion", label: "死于叛乱" },
    { id: "extinction", label: "文明断绝" },
    { id: "machine_takeover", label: "机器接管" },
    { id: "god_devour", label: "古神吞噬" },
    { id: "order_collapse", label: "秩序崩溃" },
    { id: "famine", label: "断粮" },
    { id: "thrall_takeover", label: "全船眷属化" }
  ];

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function num(v, d) { return typeof v === "number" && isFinite(v) ? v : (d || 0); }
  function rnd(v) { return Math.round(num(v, 0)); }

  function absWeek(state, cfg) {
    return (state.loop - 1) * cfg.time.loopYears * cfg.time.weeksPerYear + state.weeks;
  }
  function absYear(state, cfg) {
    return absWeek(state, cfg) / cfg.time.weeksPerYear;
  }

  function pushEvent(state, cfg, level, title, text, basis, deltas, note) {
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
      type: "run", level: level || "系统", title: title, text: text, basis: basis || ""
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

  function createFamine() {
    return {
      active: false, settled: false, weeks: 0, stage: 0,
      layers: [], stoppedPop: 0, recycled: 0, starved: 0, rebellions: 0, rebelKilled: 0,
      slept: 0, sleepBlocked: 0,
      lastStepAt: -999, awaiting: null, startWeek: -1, startYear: -1,
      realDeaths: 0, peakTotal: 0,
      policy: { order: null, recycle: true, earlyHarvest: false }
    };
  }

  function create(cfg) {
    var R = cfg.run || {};
    return {
      version: VERSION,
      enabled: R.enabled !== false,
      legacy: false,
      started: false,
      luck: 0,
      auto: !!R.autoDefault,
      status: "playing",
      won: false,
      lost: false,
      loseId: "",
      loseReason: "",
      endedWeek: -1,
      endedYear: -1,
      pendingNode: null,
      counters: { orderCollapse: 0, famine: 0, noL2: 0 },
      famine: createFamine(),
      history: []
    };
  }

  function ensure(state, cfg) {
    if (!state.run || typeof state.run !== "object") {
      state.run = create(cfg);
      state.run.enabled = false;
      state.run.legacy = true;
      state.run.started = true;
    }
    var g = state.run;
    if (!g.counters) g.counters = { orderCollapse: 0, famine: 0, noL2: 0 };
    if (!g.famine) g.famine = createFamine();
    if (typeof g.famine.slept !== "number") g.famine.slept = 0;
    if (typeof g.famine.sleepBlocked !== "number") g.famine.sleepBlocked = 0;
    if (!g.famine.policy) g.famine.policy = { order: null, recycle: true, earlyHarvest: false };
    if (!g.history) g.history = [];
    if (!g.status) g.status = "playing";
    if (g.pendingNode === undefined) g.pendingNode = null;
    if (typeof g.luck !== "number") g.luck = 0;
    return g;
  }

  function start(state, cfg) {
    var g = ensure(state, cfg);
    g.started = true;
    g.status = "playing";
    g.won = false;
    g.lost = false;
    g.loseId = "";
    g.loseReason = "";
    g.endedWeek = -1;
    g.endedYear = -1;
    g.pendingNode = null;
    g.counters = { orderCollapse: 0, famine: 0, noL2: 0 };
    if (!(g.luck > 0)) {
      g.luck = (global.XuanShuEncounter && state.encounter)
        ? global.XuanShuEncounter.luckOf(state, cfg)
        : 1;
    }
    return g;
  }

  function totals(state, cfg) {
    if (global.XuanShuSim && global.XuanShuSim.totals) return global.XuanShuSim.totals(state, cfg);
    var total = 0, awake = 0, dormant = 0;
    Object.keys(state.groups || {}).forEach(function (k) {
      total += num(state.groups[k].awake) + num(state.groups[k].dormant);
      awake += num(state.groups[k].awake);
      dormant += num(state.groups[k].dormant);
    });
    return { total: total, awake: awake, dormant: dormant };
  }

  function foodDays(state, cfg, t) {
    var demand = t.awake * cfg.food.perCapitaTpy +
      t.dormant * cfg.food.perCapitaTpy * cfg.food.dormantFactor;
    return demand > 0 ? num(state.stocks.food) / (demand / 365) : 9999;
  }

  function l2Alive(state) {
    var n = 0;
    ((state.society && state.society.queues) || []).forEach(function (q) {
      if (q.layer === "L2" && num(q.n) > 0) n += 1;
    });
    return n;
  }

  function lose(state, cfg, id, reason) {
    var g = ensure(state, cfg);
    if (g.status !== "playing") return g;
    g.status = "lost";
    g.lost = true;
    g.loseId = id;
    g.loseReason = reason;
    g.endedWeek = absWeek(state, cfg);
    g.endedYear = Math.round(absYear(state, cfg) * 100) / 100;
    g.history.push({ year: g.endedYear, type: "lose", id: id, reason: reason });
    pushEvent(state, cfg, "终局", "失败了 · " + (FAILS.filter(function (f) { return f.id === id; })[0] || {}).label,
      reason, "触发顺序 " + (FAILS.map(function (f) { return f.id; }).indexOf(id) + 1) + "/" + FAILS.length,
      null, reason);
    return g;
  }

  function win(state, cfg) {
    var g = ensure(state, cfg);
    if (g.status !== "playing") return g;
    g.status = "won";
    g.won = true;
    g.endedWeek = absWeek(state, cfg);
    g.endedYear = num(cfg.run.targetYear, 41000);
    g.history.push({ year: g.endedYear, type: "win", reason: "玄枢号穿越 41,000 年，文明延续。" });
    pushEvent(state, cfg, "终局", "胜利 · 41,000 年", "玄枢号穿越 41,000 年，文明延续。",
      "绝对年 ≥ " + num(cfg.run.targetYear, 41000), null, "你把这艘船带到了终点");
    return g;
  }

  /* ---------------- 无粮阶梯（停供 → 回收 → 叛乱） ---------------- */

  function rng(state) {
    state.rngA = (state.rngA + 0x6D2B79F5) | 0;
    var t = Math.imul(state.rngA ^ (state.rngA >>> 15), 1 | state.rngA);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  var Q_GROUP = {
    L1: "noble", L2: "noble",
    L3_cmd: "noble", L3_combat: "combat", L3_tech: "tech",
    L3_serv: "service", L3_med: "medical", L3_agri: "tech", L3_branch: "noble",
    L4_serv: "service", L4_combat: "combat", L4_tech: "tech",
    L4_med: "medical", L4_orig: "original", L4_clone: "clone", L4_und: "undecided"
  };

  function queuesOf(state, layer) {
    return ((state.society && state.society.queues) || []).filter(function (q) {
      return q.layer === layer && num(q.n) > 0;
    });
  }

  function layerPop(state, layer) {
    return queuesOf(state, layer).reduce(function (a, q) { return a + num(q.n); }, 0);
  }

  // 从某一等级按队列比例减人，同时同步聚合人口，保证粮食/人口口径一致
  function killLayer(state, cfg, layer, count) {
    var qs = queuesOf(state, layer);
    var total = qs.reduce(function (a, q) { return a + num(q.n); }, 0);
    if (total <= 0 || count <= 0) return 0;
    var want = Math.min(count, total), done = 0;
    qs.forEach(function (q) {
      var dn = Math.min(num(q.n), want * num(q.n) / total);
      q.n = Math.max(0, num(q.n) - dn);
      var gid = Q_GROUP[q.id];
      var gr = gid && state.groups && state.groups[gid];
      if (gr) {
        var take = Math.min(num(gr.awake), dn);
        gr.awake = Math.max(0, num(gr.awake) - take);
        done += take;
      }
    });
    return done;
  }

  function avgObedience(soc) {
    var sum = 0, n = 0;
    ((soc && soc.queues) || []).forEach(function (q) {
      if (num(q.thrallFrac) < 0.5) { sum += num(q.O, 50) * num(q.n); n += num(q.n); }
    });
    return n > 0 ? sum / n : 50;
  }

  function combatShare(soc) {
    var c = 0, n = 0;
    ((soc && soc.queues) || []).forEach(function (q) {
      n += num(q.n);
      if (q.dept === "战斗" && num(q.thrallFrac) < 0.5) c += num(q.n);
    });
    return n > 0 ? c / n : 0;
  }

  function famineReason(state, cfg, g, kind) {
    var fam = g.famine;
    var t = totals(state, cfg);
    var parts = [];
    parts.push("存粮空了 " + fam.weeks + " 周");
    parts.push("停供 " + (fam.layers.join("→") || "无") +
      "（覆盖 " + Math.round(fam.stoppedPop) + " 人）");
    parts.push("回收 " + Math.round(fam.recycled) + " 人为粮");
    if (fam.slept > 0) parts.push("强制沉睡 " + Math.round(fam.slept) + " 人（贵族优先）");
    parts.push("饿死 " + Math.round(fam.starved) + " 人");
    if (fam.rebellions) parts.push("叛乱 " + fam.rebellions + " 次、死 " + Math.round(fam.rebelKilled || 0) + " 人");
    parts.push("共减员 " + Math.round(fam.realDeaths) + " 人");
    parts.push("船上还剩 " + Math.round(t.total) + " 人（清醒 " + Math.round(t.awake) +
      " / 休眠 " + Math.round(t.dormant) + "）");
    if (kind === "rebellion") {
      return "死于叛乱：" + parts.join("；") + "。";
    }
    return "断粮：" + parts.join("；") + "，人口已不足最低编制。";
  }

  function rebellionCheck(state, cfg, g, soc, fam) {
    var R = ((cfg.run || {}).famine || {}).rebellion || {};
    var t = totals(state, cfg);
    var force = soc.garrison
      ? clamp(num(soc.garrison.strength, 1) /
        Math.max(1, num((cfg.society.garrison || {}).initStrength, 1)), 0, 1)
      : 1;
    var forceScore = clamp(0.6 * force + 0.4 * Math.min(1, combatShare(soc) / 0.08), 0, 1);
    var stopShare = t.total > 0 ? fam.stoppedPop / t.total : 0;
    var recShare = fam.peakTotal > 0 ? fam.recycled / fam.peakTotal : 0;
    var T = num(R.orderK, 2.2) * (1 - clamp(num(state.order), 0, 1)) +
      num(R.obedienceK, 1.4) * (1 - clamp(avgObedience(soc) / 100, 0, 1)) +
      num(R.thrallK, 1.6) * clamp(num(soc.infection && soc.infection.share), 0, 1) +
      num(R.combatK, 1.8) * (1 - forceScore) +
      num(R.stopK, 2.0) * clamp(stopShare, 0, 1) +
      num(R.recycleK, 3.0) * clamp(recShare, 0, 1) +
      num(R.bias, -1.05);
    var p = 1 / (1 + Math.exp(-3.2 * T));
    if (rng(state) >= p) return { fired: false, p: p, force: forceScore };

    fam.rebellions++;
    var cas = Math.min(t.total * 0.08, t.total * (num(R.casualtyBase, 0.04) + num(R.casualtyK, 0.18) * p));
    var killed = killLayer(state, cfg, "L4", cas * 0.75);
    killed += killLayer(state, cfg, "L3", cas * 0.25);
    fam.rebelKilled += killed;
    fam.realDeaths += killed;
    state.order = clamp(num(state.order) - 0.12, 0.05, 1);
    ((soc && soc.queues) || []).forEach(function (q) { q.O = clamp(num(q.O, 50) - 8, 0, 100); });

    var pc = state.player && state.player.pc;
    var deathP = clamp(num(R.playerDeathBase, 0.35) + 0.4 * p - 0.3 * forceScore, 0.05, 0.9);
    var dead = false;
    if (pc && state.player.mode !== "creator" && rng(state) < deathP) {
      pc.alive = false;
      pc.health = 0;
      dead = true;
    }
    pushEvent(state, cfg, "断粮", dead ? "叛乱 · 你被杀死" : "叛乱爆发",
      "秩序 " + num(state.order).toFixed(2) + "、平均服从 " + Math.round(avgObedience(soc)) +
      "、眷属 " + Math.round(num(soc.infection && soc.infection.share) * 100) + "%、战斗力量 " +
      Math.round(forceScore * 100) + "%，判定概率 " + Math.round(p * 100) + "%：叛乱死了 " +
      Math.round(killed) + " 人。",
      "停供 " + fam.layers.join("/") + "；已回收 " + Math.round(fam.recycled) + " 人",
      null, dead ? "你在叛乱中死了" : "叛乱被压下去，但船更虚弱了");
    if (dead) return { fired: true, p: p, dead: true, result: lose(state, cfg, "rebellion", famineReason(state, cfg, g, "rebellion")) };
    return { fired: true, p: p, dead: false };
  }

  /* 强制沉睡：断粮时把有资格者（贵族）送进空余休眠舱，按 5% 口粮折算。
     由粮食卡 / 托管的 sleep 项调用；克隆人、平民没有资格，机器人不参与。 */
  function sleepNobles(state, cfg, fam, wantAll) {
    var noble = state.groups && state.groups.noble;
    if (!noble || noble.awake <= 0) return 0;
    var t = totals(state, cfg);
    var free = Math.max(0, Math.floor(num(state.infra && state.infra.pods, 0) - t.dormant));
    var want = wantAll ? Math.round(noble.awake) : Math.max(0, Math.round(num(wantAll)));
    var can = Math.min(want, free);
    if (can > 0) {
      noble.awake -= can;
      noble.dormant += can;
      fam.slept = num(fam.slept, 0) + can;
    }
    if (want > can) fam.sleepBlocked = num(fam.sleepBlocked, 0) + (want - can);
    return can;
  }

  function famineStep(state, cfg, g, t, soc) {
    var F = (cfg.run || {}).famine;
    if (!F) return null;
    var fam = g.famine;
    var days = foodDays(state, cfg, t);
    var stockOut = num(state.stocks.food) <= 0 && days < num(F.triggerDays, 3);

    if (!fam.active) {
      if (!stockOut) { g.counters.famine = 0; return null; }
      fam.active = true; fam.settled = false; fam.weeks = 0; fam.stage = 0;
      fam.layers = []; fam.stoppedPop = 0; fam.recycled = 0; fam.starved = 0;
      fam.realDeaths = 0; fam.rebellions = 0; fam.peakTotal = t.total;
      fam.slept = 0; fam.sleepBlocked = 0;
      fam.lastStepAt = -999; fam.lastRecycle = -999; fam.lastRebel = -999; fam.lastAuto = -9999;
      fam.startWeek = absWeek(state, cfg);
      fam.startYear = Math.round(absYear(state, cfg) * 100) / 100;
      fam.awaiting = null;
      pushEvent(state, cfg, "断粮", "粮食危机",
        "存粮见底，粮食卡已挂到决定栏：停供、强制沉睡、回收、抢收都由你勾选，不再自动往下推。",
        "存粮日 < " + num(F.triggerDays, 3) + "；可选 " + (F.recycleOrder || []).join("→"),
        null, "危机不消除就一直挂着");
    }

    fam.weeks++;
    g.counters.famine = fam.weeks;
    if (fam.settled) return null;

    // 库存真正恢复（≥30 天存量）才解除阶梯；只是回到 0.1 吨不算恢复
    if (!stockOut && num(state.stocks.food) > 0 && days >= 30) {
      fam.active = false; fam.awaiting = null; fam.stage = 0;
      fam.layers = []; fam.stoppedPop = 0;
      g.counters.famine = 0;
      pushEvent(state, cfg, "断粮", "配给恢复",
        "存粮回到正数，阶梯停供解除。", "库存 " + Math.round(num(state.stocks.food)) + " 吨");
      return null;
    }

    var stepW = num(F.stepWeeks, 8);

    // v6.23：阶梯不再自动推进。危机挂着，等玩家在粮食卡里勾选后由 famineAct 结算。
    fam.awaiting = { at: fam.weeks, manual: true };
    if (g.auto) autoFamine(state, cfg, fam);

    // 停供人群饿死
    if (fam.stoppedPop > 0) {
      var dt = 1 / cfg.time.weeksPerYear;
      var deaths = fam.stoppedPop * num(F.starveRate, 0.35) * dt;
      for (var i = fam.layers.length - 1; i >= 0 && deaths > 0; i--) {
        var took = killLayer(state, cfg, fam.layers[i], deaths);
        deaths -= took;
        fam.starved += took;
        fam.realDeaths += took;
      }
      fam.stoppedPop = fam.layers.reduce(function (a, L) { return a + layerPop(state, L); }, 0);
    }

    // v6.23：回收也由玩家在粮食卡里勾选，不再自动执行。

    // 叛乱：停供/回收后满一个阶梯间隔才判，且每 8 周最多一次（保证高身份有反应时间）
    if ((fam.stage > 0 || fam.recycled > 0) && fam.weeks >= stepW &&
        fam.weeks - num(fam.lastRebel, -999) >= stepW) {
      fam.lastRebel = fam.weeks;
      var reb = rebellionCheck(state, cfg, g, soc, fam);
      if (reb.dead) return reb.result;
    }

    // 人口不足最低编制 → 断粮终局（比灭绝更准确的原因）
    var t2 = totals(state, cfg);
    if (t2.total < num(((cfg.run || {}).fail || {}).minPopulation, 200)) {
      return lose(state, cfg, "famine", famineReason(state, cfg, g, "famine"));
    }

    // 低人口稳态：现有产出已能覆盖需求
    var prod = num(state.last && state.last.production, 0) + num(cfg.food.planetTpy, 0);
    var need = t2.awake * cfg.food.perCapitaTpy +
      t2.dormant * cfg.food.perCapitaTpy * cfg.food.dormantFactor;
    if (t2.total >= num(((cfg.run || {}).fail || {}).minPopulation, 200) &&
        num(state.stocks.food) > 0 && prod >= need * 0.98) {
      fam.settled = true;
      fam.active = false;
      fam.awaiting = null;
      g.counters.famine = 0;
      pushEvent(state, cfg, "断粮", "进入低人口稳态",
        "人口降到 " + Math.round(t2.total) + "，年产 " + Math.round(prod) + " 吨已能覆盖需求。",
        "停供与回收结束，继续航行");
    }
    return null;
  }

  /* 托管时的粮食卡自动勾选：每 8 周最多一次，先沉睡、再停下一级、必要时回收一小批。 */
  function autoFamine(state, cfg, fam) {
    if (state.weeks - num(fam.lastAuto, -9999) < 8) return null;
    fam.lastAuto = state.weeks;
    var F = (cfg.run || {}).famine || {};
    var order = (fam.policy.order && fam.policy.order.length) ? fam.policy.order : (F.recycleOrder || []);
    var sel = {};
    var next = null;
    for (var i = 0; i < order.length; i++) {
      if (fam.layers.indexOf(order[i]) < 0) { next = order[i]; break; }
    }
    if (next) sel.stop = [next];
    if (state.groups && state.groups.noble && state.groups.noble.awake > 0) sel.sleep = "all";
    if (fam.layers.length >= 2) {
      var target = fam.layers[fam.layers.length - 1];
      var avail = layerPop(state, target);
      if (avail > 0) sel.recycle = Math.max(1, Math.round(avail * 0.05));
    }
    return famineAct(state, cfg, sel);
  }

  /* 粮食卡：一次提交一组勾选，按真实数值当场结算。
     choice = { sleep: N|"all", stop: ["L4","L3"...], recycle: N, harvest: bool }
     身份只决定哪些项可选：creator/ruler 全开；mid 可抢收；slave 只能沉睡与停供。 */
  function famineAct(state, cfg, choice) {
    var g = ensure(state, cfg);
    var fam = g.famine;
    choice = choice || {};
    if (!fam.active) return { ok: false, msg: "当前没有断粮事件" };
    var F = (cfg.run || {}).famine || {};
    var mode = (state.player && state.player.mode) || "slave";
    var canRecycle = mode === "creator" || mode === "ruler";
    var canHarvest = mode === "creator" || mode === "ruler" || mode === "mid";
    var order = (fam.policy.order && fam.policy.order.length) ? fam.policy.order : (F.recycleOrder || []);
    var lines = [];

    if (choice.stop) {
      var wanted = (Array.isArray(choice.stop) ? choice.stop : [choice.stop])
        .filter(function (L) { return order.indexOf(L) >= 0; });
      wanted.forEach(function (L) {
        if (fam.layers.indexOf(L) >= 0) return;
        var n = layerPop(state, L);
        if (n <= 0) return;
        fam.layers.push(L);
        lines.push("停供 " + L + "（" + Math.round(n) + " 人）");
      });
      fam.stage = fam.layers.length;
      fam.stoppedPop = fam.layers.reduce(function (a, L) { return a + layerPop(state, L); }, 0);
      fam.policy.order = order;
    }

    if (choice.sleep) {
      var noble = state.groups.noble || { awake: 0, dormant: 0 };
      var t0 = totals(state, cfg);
      var free = Math.max(0, Math.floor(num(state.infra && state.infra.pods, 0) - t0.dormant));
      var want = choice.sleep === "all" ? Math.round(noble.awake) : Math.min(noble.awake, Math.round(num(choice.sleep)));
      var can = sleepNobles(state, cfg, fam, choice.sleep === "all" ? true : Math.max(0, want));
      if (can > 0) lines.push("强制沉睡 " + can + " 名贵族");
      if (want > can) {
        lines.push("舱位不足，还有 " + Math.round(want - can) + " 名贵族没能沉睡（余位 " + free + "）");
      }
    }

    if (choice.harvest) {
      if (!canHarvest) return { ok: false, msg: "当前身份不能下令抢收" };
      if (fam.harvested) return { ok: false, msg: "这一轮已经抢收过了" };
      var add = num(state.production, 0) * 0.02;
      fam.harvested = true;
      state.stocks.food += add;
      lines.push("提前抢收 +" + Math.round(add) + " 吨");
    }

    if (choice.recycle) {
      if (!canRecycle) return { ok: false, msg: "当前身份不能下令回收" };
      if (!fam.layers.length) return { ok: false, msg: "先停供，才能回收" };
      var target = fam.layers[fam.layers.length - 1];
      var avail = layerPop(state, target);
      var wantR = choice.recycle === "all" ? avail : Math.round(num(choice.recycle));
      var got = killLayer(state, cfg, target, Math.min(avail, Math.max(0, wantR)));
      if (got > 0) {
        var per = cfg.food.perCapitaTpy * num(F.recycleYield, 0.55);
        var foodAdd = got * per;
        fam.recycled += got;
        fam.realDeaths += got;
        fam.lastRecycle = fam.weeks;
        state.stocks.food += foodAdd;
        state.order = clamp(num(state.order) - 0.05, 0.05, 1);
        ((state.society && state.society.queues) || []).forEach(function (q) {
          q.O = clamp(num(q.O, 50) - 4, 0, 100);
        });
        fam.stoppedPop = fam.layers.reduce(function (a, L) { return a + layerPop(state, L); }, 0);
        lines.push("回收 " + Math.round(got) + " 人为粮（+" + foodAdd.toFixed(1) + " 吨，秩序 −5）");
      } else {
        lines.push("可回收人口已经为空");
      }
    }

    if (!lines.length) return { ok: false, msg: "至少勾一项" };
    fam.awaiting = { at: fam.weeks, manual: true };
    var summary = lines.join("；");
    pushEvent(state, cfg, "断粮", "粮食卡 · 处置",
      summary + "。",
      "停供 " + (fam.layers.join("/") || "无") + "；累计沉睡 " + Math.round(fam.slept) +
      "、回收 " + Math.round(fam.recycled) + "、饿死 " + Math.round(fam.starved),
      null, "叛乱风险按秩序/服从/眷属比重新判定");
    return { ok: true, msg: summary, lines: lines, famine: brief(state, cfg).famine };
  }

  /* ---------------- 每周失败检查 ---------------- */

  function weekly(state, cfg) {
    var g = ensure(state, cfg);
    if (!g.enabled || g.legacy || !g.started || g.status !== "playing") return null;
    var F = (cfg.run && cfg.run.fail) || {};
    var t = totals(state, cfg);
    var soc = state.society || {};
    var p = state.player;
    var pc = p && p.pc;

    // 连续计数
    g.counters.orderCollapse = num(state.order) < 0.15 ? g.counters.orderCollapse + 1 : 0;
    g.counters.noL2 = l2Alive(state) === 0 ? g.counters.noL2 + 1 : 0;

    // 0 玩家死亡（创造模式为观察者，不因此终局）
    if (pc && (!p.mode || p.mode !== "creator") && (pc.alive === false || num(pc.health) <= 0)) {
      return lose(state, cfg, "player_death", "你的健康归零，意识在维生舱里熄灭。");
    }

    // 无粮阶梯：停供 → 回收 → 叛乱；可能直接判负（玩家死于叛乱 / 人口不足）
    var famRes = famineStep(state, cfg, g, t, soc);
    if (famRes) return famRes;

    // 1 灭绝（断粮阶梯接管时由阶梯自己判，避免原因写成「文明断绝」）
    if (!g.famine.active && (t.total < num(F.minPopulation, 200) || g.counters.noL2 >= num(F.l2EmptyWeeks, 26))) {
      return lose(state, cfg, "extinction", "船上的人不到 " + num(F.minPopulation, 200) +
        "，或中层贵族连续 " + num(F.l2EmptyWeeks, 26) + " 周一个不剩。");
    }
    // 2 机器接管
    if (soc.machine && (soc.machine.depts || []).length >= num(F.machineDepts, 4)) {
      return lose(state, cfg, "machine_takeover", "机器已经管了 " + num(F.machineDepts, 4) +
        " 个以上部门，船上的事不再由人定。");
    }
    // 3 古神吞噬
    if (state.gods && num(state.gods.devour) >= num((cfg.gods || {}).devourCap, 100)) {
      return lose(state, cfg, "god_devour", "古神的吞噬到了顶，玄枢号被吞进腹中。");
    }
    // 4 秩序崩溃（断粮期间交给叛乱判定）
    if (!g.famine.active && g.counters.orderCollapse >= num(F.orderCollapseWeeks, 26)) {
      return lose(state, cfg, "order_collapse", "秩序连续 " + num(F.orderCollapseWeeks, 26) +
        " 周低于 15%，船上已经没人执行命令。");
    }
    // 5 全船眷属化
    if (soc.infection && num(soc.infection.share) >= num(F.thrallShare, 0.75) &&
        num(soc.infection.thralls) >= num(F.thrallCount, 1200)) {
      return lose(state, cfg, "thrall_takeover", "七成半以上的人感染、眷属超过 " +
        num(F.thrallCount, 1200) + " 人，全船完成转化。");
    }
    return null;
  }

  /* ---------------- 千年节点 ---------------- */

  function onLoopEnd(state, cfg) {
    var g = ensure(state, cfg);
    if (!g.enabled || g.legacy) return { action: "rollback", legacy: true };
    if (g.status !== "playing") return { action: "frozen", status: g.status };
    var now = absYear(state, cfg);
    var target = num(cfg.run.targetYear, 41000);
    if (now >= target - 0.001) {
      win(state, cfg);
      return { action: "win", status: g.status };
    }
    if (g.auto) return { action: "rollback", auto: true };
    if (!g.pendingNode) {
      g.pendingNode = { year: Math.round(now), atWeek: state.weeks,
        atAbsWeek: absWeek(state, cfg),
        text: "第 " + Math.round(now) + " 年：让电脑代玩到结束，还是继续手动？" };
      g.history.push({ year: Math.round(now), type: "node", text: "千年节点挂起" });
      pushEvent(state, cfg, "节点", "千年节点",
        "已抵达第 " + Math.round(now) + " 年。可以让电脑代玩到结束，也可以继续手动。",
        "每 1,000 年一次，时间冻结直到选择");
    }
    return { action: "freeze", pendingNode: g.pendingNode };
  }

  function resolve(state, cfg, mode) {
    var g = ensure(state, cfg);
    if (!g.pendingNode) return { ok: false, msg: "当前没有待决的千年节点" };
    // 只有玩家显式选择才结算：其余调用（含漏传参数）一律不改 run.auto
    if (mode !== "auto" && mode !== "manual") return { ok: false, msg: "请先选择走法" };
    var m = mode;
    var node = g.pendingNode;
    g.pendingNode = null;
    g.auto = m === "auto";
    g.history.push({ year: node.year, type: "choice", mode: m,
      text: m === "auto" ? "选择自动推演" : "选择继续手动" });
    pushEvent(state, cfg, "节点", "千年节点 · " + (m === "auto" ? "电脑代玩" : "继续手动"),
      m === "auto" ? "开始电脑代玩，奇遇会按你的处境自动选牌；你随时可以接手。" : "继续手动，随时可以切回电脑代玩。",
      "第 " + Math.round(node.year + 1) + " 年");
    return { ok: true, mode: m, node: node, rollback: true };
  }

  function setAuto(state, cfg, v) {
    var g = ensure(state, cfg);
    g.auto = !!v;
    g.history.push({ year: Math.round(absYear(state, cfg)), type: "auto", text: g.auto ? "开启电脑代玩" : "关闭电脑代玩" });
    return { ok: true, auto: g.auto };
  }

  function shouldStop(state, cfg) {
    var g = ensure(state, cfg);
    if (!g.enabled || g.legacy) return false;
    return g.status !== "playing" || !!g.pendingNode;
  }

  function brief(state, cfg) {
    var g = ensure(state, cfg);
    var target = num(cfg.run && cfg.run.targetYear, 41000);
    var now = absYear(state, cfg);
    var luck = g.luck > 0 ? g.luck
      : (state.encounter && state.encounter.luckDrawn ? state.encounter.luck : 1);
    return {
      version: VERSION,
      enabled: !!g.enabled && !g.legacy,
      legacy: !!g.legacy,
      started: !!g.started,
      needMode: !g.started,
      status: g.status,
      auto: !!g.auto,
      won: !!g.won,
      lost: !!g.lost,
      loseId: g.loseId || "",
      loseReason: g.loseReason || "",
      pendingNode: g.pendingNode,
      year: Math.round(now * 100) / 100,
      loop: state.loop,
      targetYear: target,
      targetLoops: num(cfg.run && cfg.run.targetLoops, 41),
      nextNodeIn: Math.max(0, Math.ceil((Math.floor(now / 1000) + 1) * 1000 - now)),
      progress: clamp(now / target, 0, 1),
      endedWeek: g.endedWeek,
      endedYear: g.endedYear,
      luck: Math.round(num(luck, 1) * 100) / 100,
      counters: g.counters,
      famine: (function () {
        var fm = (cfg.run || {}).famine || {};
        var mode = (state.player && state.player.mode) || "slave";
        var order = (g.famine.policy && g.famine.policy.order && g.famine.policy.order.length)
          ? g.famine.policy.order : (fm.recycleOrder || []);
        var tt = totals(state, cfg);
        var noble = state.groups.noble || { awake: 0, dormant: 0 };
        var free = Math.max(0, Math.floor(num(state.infra && state.infra.pods, 0) - tt.dormant));
        return {
          active: !!g.famine.active,
          settled: !!g.famine.settled,
          weeks: g.famine.weeks,
          stage: g.famine.stage,
          layers: (g.famine.layers || []).slice(),
          stoppedPop: Math.round(g.famine.stoppedPop),
          recycled: Math.round(g.famine.recycled),
          starved: Math.round(g.famine.starved),
          rebellions: g.famine.rebellions,
          slept: Math.round(g.famine.slept || 0),
          sleepBlocked: Math.round(g.famine.sleepBlocked || 0),
          awaiting: g.famine.awaiting,
          canAct: true,
          startYear: g.famine.startYear,
          mode: mode,
          can: {
            sleep: true,
            stop: true,
            recycle: mode === "creator" || mode === "ruler",
            harvest: mode === "creator" || mode === "ruler" || mode === "mid"
          },
          order: order.slice(),
          layerPops: order.map(function (L) { return { id: L, pop: Math.round(layerPop(state, L)) }; }),
          noblesAwake: Math.round(noble.awake),
          noblesDormant: Math.round(noble.dormant),
          podsFree: free,
          recycleYield: Math.round(cfg.food.perCapitaTpy * num(fm.recycleYield, 0.55) * 1000) / 1000,
          harvestGain: Math.round(num(state.production, 0) * 0.02),
          harvestUsed: !!g.famine.harvested,
          settledAt: g.famine.settled ? g.famine.weeks : null
        };
      })(),
      failList: FAILS,
      history: (g.history || []).slice(-20)
    };
  }

  var api = {
    version: VERSION,
    create: create,
    ensure: ensure,
    start: start,
    weekly: weekly,
    onLoopEnd: onLoopEnd,
    resolve: resolve,
    resolveMillennium: resolve,
    setAuto: setAuto,
    famineAct: famineAct,
    shouldStop: shouldStop,
    brief: brief,
    win: win,
    lose: lose,
    absYear: absYear,
    failList: FAILS
  };

  global.XuanShuRun = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : global);
