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
    state.events.push(entry);
    if (state.events.length > cfg.time.eventCap) state.events.shift();
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
      reason, "触发顺序 " + (FAILS.map(function (f) { return f.id; }).indexOf(id) + 1) + "/7",
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
    var fam = num(state.stocks.food) <= 0 && foodDays(state, cfg, t) < 3;
    g.counters.famine = fam ? g.counters.famine + 1 : 0;
    g.counters.noL2 = l2Alive(state) === 0 ? g.counters.noL2 + 1 : 0;

    // 0 玩家死亡（创造模式为观察者，不因此终局）
    if (pc && (!p.mode || p.mode !== "creator") && (pc.alive === false || num(pc.health) <= 0)) {
      return lose(state, cfg, "player_death", "你的健康归零，意识在维生舱里熄灭。");
    }
    // 1 灭绝
    if (t.total < num(F.minPopulation, 200) || g.counters.noL2 >= num(F.l2EmptyWeeks, 26)) {
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
    // 4 秩序崩溃
    if (g.counters.orderCollapse >= num(F.orderCollapseWeeks, 26)) {
      return lose(state, cfg, "order_collapse", "秩序连续 " + num(F.orderCollapseWeeks, 26) +
        " 周低于 15%，船上已经没人执行命令。");
    }
    // 5 断粮
    if (g.counters.famine >= num(F.famineWeeks, 12)) {
      return lose(state, cfg, "famine", "连续 " + num(F.famineWeeks, 12) +
        " 周没有粮，最后一个醒着的人倒在农环。");
    }
    // 6 全船眷属化
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
    var m = mode === "auto" ? "auto" : "manual";
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
