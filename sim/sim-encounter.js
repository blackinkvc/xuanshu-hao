/* =========================================================================
   玄枢号 · 奇遇与牌库（sim-encounter.js）
   -------------------------------------------------------------------------
   每年最后一周判一次「是否发生奇遇」；成立后按当前真值抽类别，
   从该类牌库抽 3 张，交给玩家三选一（或自动推演选牌）。

   状态全部在 state.encounter：
     luck / gapYears / pending / history / counts / deck / mods / peek
   随机只走 state.rngA（XuanShuRand），不引入新随机源。
   ========================================================================= */
(function (global) {
  "use strict";

  var VERSION = "1.0.0";

  var CAT_LABEL = {
    explore: "探索", tech: "科技", resource: "资源", society: "社会",
    oldgod: "古神", crisis: "危机", trade: "交易"
  };
  var RARITY_RANK = { common: 0, rare: 1, epic: 2, legendary: 3 };

  // 临时修正的语义：乘性 / 加性
  var MUL_KEYS = {
    prodMul: 1, cloneMul: 1, birthMul: 1, foodUse: 1,
    eduMul: 1, infectSpread: 1
  };
  var ADD_KEYS = {
    foodPerYear: 0, metalPerYear: 0, medCoverage: 0, vision: 0, garrison: 0
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

  var STOCK_LABEL = { food: "粮食", water: "水", metal: "金属", drug: "药剂" };
  var STOCK_UNIT = { food: "吨", water: "吨", metal: "吨", drug: "份" };
  var QUEUE_LABEL = { O: "服从", W: "不服", C: "感染", S: "压力" };
  var PC_LABEL = {
    health: "健康", compliance: "服从", will: "意志", dominion: "统御",
    authority: "权限", infectionC: "感染", stage: "感染阶段", stress: "压力"
  };
  var INFRA_LABEL = { hydro: "水培", pods: "休眠舱", clonePods: "克隆槽" };
  var RARITY_LABEL = { common: "常见", uncommon: "少见", rare: "稀有", epic: "罕见", legend: "传说" };

  function pushEvent(state, cfg, type, level, title, text, basis, deltas, note) {
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
      type: type,
      level: level || "奇遇",
      title: title,
      text: text,
      basis: basis || ""
    };
    var D = global.XuanShuSim && global.XuanShuSim.cleanDeltas
      ? global.XuanShuSim.cleanDeltas(deltas) : null;
    if (D) entry.deltas = D;
    if (note) entry.note = note;
    state.events.push(entry);
    if (state.events.length > cfg.time.eventCap) state.events.shift();
  }

  function emptyDeck() {
    var d = {};
    (global.XUANSHU_CONFIG && global.XUANSHU_CONFIG.deck && global.XUANSHU_CONFIG.deck.categories || [])
      .forEach(function (c) { d[c] = { remaining: [], drawn: [], cycle: 0, filled: false }; });
    return d;
  }

  function create(cfg) {
    var deck = {};
    ((cfg.deck && cfg.deck.categories) || []).forEach(function (c) {
      deck[c] = { remaining: [], drawn: [], cycle: 0, filled: false };
    });
    return {
      version: VERSION,
      enabled: !!(cfg.encounter && cfg.encounter.enabled !== false),
      legacy: false,
      luck: 1,
      luckDrawn: false,
      lastWeek: -1,
      lastYear: 0,
      gapYears: 0,
      pending: null,
      history: [],
      counts: { total: 0, byCat: {} },
      deck: deck,
      mods: [],
      peek: 0,
      last: null
    };
  }

  function ensure(state, cfg) {
    if (!state.encounter || typeof state.encounter !== "object") {
      state.encounter = create(cfg);
      // 老存档：奇遇默认关闭，保持原有模拟行为不被改写
      state.encounter.enabled = false;
      state.encounter.legacy = true;
      state.encounter.luckDrawn = true;
    }
    var e = state.encounter;
    if (!e.deck || typeof e.deck !== "object") e.deck = create(cfg).deck;
    ((cfg.deck && cfg.deck.categories) || []).forEach(function (c) {
      if (!e.deck[c]) e.deck[c] = { remaining: [], drawn: [], cycle: 0, filled: false };
    });
    if (!e.history) e.history = [];
    if (!e.counts) e.counts = { total: 0, byCat: {} };
    if (!e.counts.byCat) e.counts.byCat = {};
    if (!e.mods) e.mods = [];
    if (typeof e.gapYears !== "number") e.gapYears = 0;
    if (typeof e.luck !== "number") e.luck = 1;
    if (!e.pending) e.pending = null;
    return e;
  }

  /* ---------------- 运气 ---------------- */

  function luckOf(state, cfg) {
    var e = ensure(state, cfg);
    if (state.run && typeof state.run.luck === "number" && state.run.luck > 0) return state.run.luck;
    if (!e.luckDrawn) {
      var E = cfg.encounter || {};
      var n = Math.max(1, rnd(E.luckDraws || 3));
      var sum = 0;
      for (var i = 0; i < n; i++) sum += randNext(state);
      e.luck = clamp((E.luckMin || 0.55) + ((E.luckMax || 1.45) - (E.luckMin || 0.55)) * (sum / n),
        E.luckMin || 0.55, E.luckMax || 1.45);
      e.luckDrawn = true;
    }
    return e.luck;
  }

  /* ---------------- 类别权重 ---------------- */

  function shortageOf(state, cfg) {
    var metalShort = clamp(1 - num(state.stocks.metal) / 180, 0, 1);
    var foodDays = 9999, waterDays = 9999;
    var t = global.XuanShuSim ? global.XuanShuSim.totals(state, cfg) : null;
    if (t) {
      var demand = t.awake * cfg.food.perCapitaTpy +
        t.dormant * cfg.food.perCapitaTpy * cfg.food.dormantFactor;
      foodDays = demand > 0 ? num(state.stocks.food) / (demand / 365) : 9999;
      var thru = t.awake * cfg.water.perCapitaAwake + t.dormant * cfg.water.perCapitaDormant;
      waterDays = thru > 0 ? num(state.stocks.water) / (thru / 365) : 9999;
    }
    var foodShort = clamp(1 - foodDays / 90, 0, 1);
    var waterShort = clamp(1 - waterDays / 30, 0, 1);
    return { food: foodShort, water: waterShort, metal: metalShort,
      avg: (foodShort + waterShort + metalShort) / 3 };
  }

  function categoryWeights(state, cfg) {
    var soc = state.society || {};
    var machine = soc.machine || {};
    var inf = soc.infection || {};
    var mut = soc.mutiny || {};
    var g = soc.garrison || {};
    var tech = clamp(num(machine.tech, 0), 0, 1);
    var share = clamp(num(inf.share, 0), 0, 1);
    var thralls = num(inf.thralls, 0);
    var meanC = clamp(num(inf.meanC, 0), 0, 100);
    var order = clamp(num(state.order, 0.8), 0, 1);
    var wear = clamp(num(state.wear, 0), 0, 1);
    var phase = num(state.phase, 0);
    var mutLv = num(mut.level, 0);
    var gAvail = 0;
    if (global.XuanShuSociety && global.XuanShuSociety.garrisonAvail) {
      gAvail = global.XuanShuSociety.garrisonAvail(state, cfg);
    } else {
      var man = clamp(num(g.strength) / num(cfg.society.garrison.initStrength, 1), 0, 1.2);
      gAvail = clamp(man * (0.5 + 0.5 * clamp(num(g.durability) / 100, 0, 1)), 0, 1.2);
    }
    var sh = shortageOf(state, cfg);

    var w = {
      explore: 1.00 + 2.20 * tech + 0.60 * (1 - share),
      tech: 0.80 + 1.60 * tech,
      resource: 0.80 + 1.60 * sh.avg + 0.80 * sh.food,
      society: 0.80 + 1.80 * (1 - order) + 0.50 * mutLv,
      oldgod: 0.35 + 0.30 * thralls + 2.60 * (meanC / 100) + 2.00 * share,
      crisis: 0.70 + 0.50 * phase + 1.60 * wear + 1.20 * (1 - clamp(gAvail, 0, 1)),
      trade: 0.70 + 1.20 * (1 - order) + 0.60 * sh.metal
    };

    // 配置覆盖
    var cw = cfg.encounter && cfg.encounter.categoryWeights;
    if (cw) {
      Object.keys(cw).forEach(function (k) {
        if (typeof w[k] === "number") w[k] = Math.max(0, cw[k]);
      });
    }
    // 卡牌后续影响（限时）
    wheelMods(state, cfg).forEach(function (m) {
      var cat = String(m.key || "").replace("encounter.", "");
      if (typeof w[cat] !== "number" || state.weeks >= m.until) return;
      if (m.mul) w[cat] *= Math.max(0, m.v);
      else w[cat] = Math.max(0, w[cat] + m.v);
    });
    // 星启者主约：探索权重 ×1.5
    if (global.XuanShuGods && state.gods && state.gods.enabled) {
      w.explore *= global.XuanShuGods.gMul(state, cfg, "exploreMul", 1);
    }
    // 航速钩子：按类别乘 r^K，跑得快危机/探索升、贸易/社会降。
    // 不能对所有类别同乘——pickCategory 会按总和归一化，统一乘等于没改。
    if (state.ship && cfg.ship && cfg.ship.speedBaseC) {
      var sr = state.ship.speedC / cfg.ship.speedBaseC;
      var ek = cfg.ship.encounterK || {};
      if (sr > 0 && sr !== 1) {
        Object.keys(ek).forEach(function (c) {
          if (typeof w[c] === "number" && typeof ek[c] === "number") {
            w[c] *= Math.pow(Math.max(0.2, sr), ek[c]);
          }
        });
      }
    }
    return w;
  }

  function wheelMods(state, cfg) {
    return (ensure(state, cfg).mods || []).filter(function (m) {
      return m && String(m.key || "").indexOf("encounter.") === 0;
    });
  }

  function pickCategory(state, cfg) {
    var w = categoryWeights(state, cfg);
    var cats = (cfg.deck && cfg.deck.categories) || Object.keys(w);
    var sum = 0, i;
    for (i = 0; i < cats.length; i++) sum += Math.max(0, w[cats[i]] || 0);
    if (sum <= 0) return cats[0];
    var u = randNext(state) * sum;
    for (i = 0; i < cats.length; i++) {
      u -= Math.max(0, w[cats[i]] || 0);
      if (u <= 0) return cats[i];
    }
    return cats[cats.length - 1];
  }

  /* ---------------- 牌库 ---------------- */

  function cardsOf(cfg, cat) {
    return ((cfg.deck && cfg.deck.cards && cfg.deck.cards[cat]) || []);
  }

  function cardOf(cfg, cat, id) {
    var list = cardsOf(cfg, cat);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function findCard(cfg, id) {
    var cats = (cfg.deck && cfg.deck.categories) || [];
    for (var i = 0; i < cats.length; i++) {
      var c = cardOf(cfg, cats[i], id);
      if (c) return { cat: cats[i], card: c };
    }
    return null;
  }

  function refill(state, cfg, cat) {
    var d = ensure(state, cfg).deck[cat];
    var ids = cardsOf(cfg, cat).map(function (c) { return c.id; });
    for (var i = ids.length - 1; i > 0; i--) {
      var j = Math.floor(randNext(state) * (i + 1));
      var tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
    }
    d.remaining = ids;
    d.filled = true;
    d.cycle = num(d.cycle, 0) + 1;
    return d;
  }

  function pickRarity(state, cfg) {
    var W = cfg.deck.rarityWeights || { common: 0.58, rare: 0.28, epic: 0.11, legendary: 0.03 };
    var keys = ["common", "rare", "epic", "legendary"];
    var sum = 0, i;
    for (i = 0; i < keys.length; i++) sum += Math.max(0, num(W[keys[i]]));
    if (sum <= 0) return "common";
    var u = randNext(state) * sum;
    for (i = 0; i < keys.length; i++) {
      u -= Math.max(0, num(W[keys[i]]));
      if (u <= 0) return keys[i];
    }
    return "common";
  }

  function drawThree(state, cfg, cat) {
    var e = ensure(state, cfg);
    var d = e.deck[cat];
    var count = Math.max(1, rnd(cfg.deck.drawCount || 3));
    if (!d.filled || d.remaining.length < count) refill(state, cfg, cat);

    var picked = [];
    while (picked.length < count) {
      if (d.remaining.length === 0) refill(state, cfg, cat);
      var want = pickRarity(state, cfg);
      // 星启者祝福：科技卡稀有度 +1 档
      if (cat === "tech" && global.XuanShuGods) {
        var boost = global.XuanShuGods.rarityBoost(state, cfg, cat);
        var rk = ["common", "rare", "epic", "legendary"];
        want = rk[Math.min(rk.length - 1, rk.indexOf(want) + (boost || 0))];
      }
      var pool = cardsOf(cfg, cat).filter(function (c) {
        return c.rarity === want && d.remaining.indexOf(c.id) >= 0 &&
          picked.every(function (p) { return p.id !== c.id; });
      });
      if (!pool.length) {
        pool = cardsOf(cfg, cat).filter(function (c) {
          return d.remaining.indexOf(c.id) >= 0 &&
            picked.every(function (p) { return p.id !== c.id; });
        });
      }
      if (!pool.length) break;
      var c2 = pool[Math.floor(randNext(state) * pool.length)];
      var at = d.remaining.indexOf(c2.id);
      if (at >= 0) d.remaining.splice(at, 1);
      d.drawn.push(c2.id);
      picked.push(c2);
    }

    // 调试发牌：优先替换第一张
    var grant = state.player && state.player.pendingGrant;
    if (grant) {
      var f = findCard(cfg, grant);
      if (f && picked.length) {
        picked[0] = f.card;
        if (f.cat !== cat) cat = f.cat;
      }
      state.player.pendingGrant = "";
    }

    // 至少 1 张可用：全锁时用同类别一张满足前置的 common 替换
    var views = picked.map(function (c) { return cardView(state, cfg, cat, c); });
    if (views.length && !views.some(function (v) { return v.available; })) {
      var repl = cardsOf(cfg, cat).filter(function (c) {
        return c.rarity === "common" && checkNeed(state, cfg, c).ok &&
          !picked.some(function (p) { return p.id === c.id; });
      })[0];
      if (repl) {
        views[views.length - 1] = cardView(state, cfg, cat, repl);
        var ri = d.remaining.indexOf(repl.id);
        if (ri >= 0) d.remaining.splice(ri, 1);
        d.drawn.push(repl.id);
        picked[views.length - 1] = repl;
      }
    }
    return { cat: cat, cards: views, raw: picked };
  }

  /* ---------------- 前置 ---------------- */

  function checkNeed(state, cfg, card) {
    var nd = card.need || {};
    var soc = state.society || {};
    var tech = num(soc.machine && soc.machine.tech, 0);
    var share = num(soc.infection && soc.infection.share, 0);
    var thralls = num(soc.infection && soc.infection.thralls, 0);
    var order = num(state.order, 0);
    var total = 0, dormant = 0;
    if (global.XuanShuSim) {
      var t = global.XuanShuSim.totals(state, cfg);
      total = t.total; dormant = t.dormant;
    }
    var p = state.player || {};
    var health = num(p.pc && p.pc.health, 0);
    if (nd.mode && p.mode && nd.mode.indexOf(p.mode) < 0) {
      return { ok: false, reason: "这张卡只给「" + nd.mode.map(function (m) {
        return { ruler: "最高贵族", mid: "中层贵族", slave: "奴隶", creator: "创造模式" }[m] || "这个身份";
      }).join("」「") + "」身份" };
    }
    if (typeof nd.techMin === "number" && tech < nd.techMin) {
      return { ok: false, reason: "科技要到 " + nd.techMin.toFixed(2) + "，现在只有 " + tech.toFixed(2) };
    }
    if (typeof nd.orderMin === "number" && order < nd.orderMin) {
      return { ok: false, reason: "秩序要到 " + Math.round(nd.orderMin * 100) + "%，现在只有 " + Math.round(order * 100) + "%" };
    }
    if (typeof nd.infectionMin === "number" && share * 100 < nd.infectionMin) {
      return { ok: false, reason: "感染要到 " + nd.infectionMin + "%，现在只有 " + Math.round(share * 100) + "%" };
    }
    if (typeof nd.thrallsMin === "number" && thralls < nd.thrallsMin) {
      return { ok: false, reason: "眷属要到 " + nd.thrallsMin + " 个，现在只有 " + rnd(thralls) + " 个" };
    }
    if (typeof nd.popMin === "number" && total < nd.popMin) {
      return { ok: false, reason: "船上至少要有 " + nd.popMin + " 人，现在只有 " + rnd(total) + " 人" };
    }
    if (typeof nd.dormantMin === "number" && dormant < nd.dormantMin) {
      return { ok: false, reason: "舱里至少要有 " + nd.dormantMin + " 人，现在只有 " + rnd(dormant) + " 人" };
    }
    if (typeof nd.healthMin === "number" && health < nd.healthMin) {
      return { ok: false, reason: "健康要到 " + nd.healthMin + "，现在只有 " + rnd(health) };
    }
    if (nd.godPact && !(state.gods && hasPact(state))) {
      return { ok: false, reason: "得先跟古神立约" };
    }
    return { ok: true, reason: "" };
  }

  function hasPact(state) {
    var g = state.gods;
    if (!g || !g.pacts) return false;
    return Object.keys(g.pacts).some(function (k) { return g.pacts[k] && g.pacts[k].pact; });
  }

  function cardView(state, cfg, cat, c) {
    var n = checkNeed(state, cfg, c);
    return {
      id: c.id,
      cat: cat,
      name: c.name,
      rarity: c.rarity,
      available: n.ok,
      reason: n.reason,
      effectText: c.effectText || "",
      costText: c.costText || "",
      followText: c.followText || "",
      choices: (c.choices || []).slice(),
      need: c.need || {},
      ops: c.ops || [],
      follow: c.follow || []
    };
  }

  /* ---------------- 临时修正 ---------------- */

  function modMul(state, key, base) {
    base = typeof base === "number" ? base : 1;
    var e = state.encounter;
    if (!e || !e.mods) return base;
    var out = base;
    e.mods.forEach(function (m) {
      if (m && m.key === key && state.weeks < m.until && MUL_KEYS[key]) out *= num(m.v, 1);
    });
    return out;
  }

  function modAdd(state, key, base) {
    base = typeof base === "number" ? base : 0;
    var e = state.encounter;
    if (!e || !e.mods) return base;
    var out = base;
    e.mods.forEach(function (m) {
      if (m && m.key === key && state.weeks < m.until) out += num(m.v, 0);
    });
    return out;
  }

  function modSum(state, key) {
    return modAdd(state, key, 0);
  }

  function addMod(state, cfg, key, v, weeks, mul, cardId) {
    var e = ensure(state, cfg);
    var w = Math.max(1, rnd(weeks || 52));
    e.mods.push({ key: key, v: num(v), until: state.weeks + w, weeks: w,
      mul: !!mul, cardId: cardId || "" });
    if (e.mods.length > 200) e.mods.shift();
  }

  /* ---------------- 结算操作 ---------------- */

  function queueAll(state, fn) {
    ((state.society && state.society.queues) || []).forEach(fn);
  }

  function addC(state, v) {
    queueAll(state, function (q) { q.C = clamp(num(q.C) + v, 0, 100); });
  }

  function popAdjust(state, cfg, group, v) {
    var gs = state.groups || {};
    if (group && gs[group]) {
      gs[group].awake = Math.max(0, num(gs[group].awake) + v);
      return;
    }
    if (group === "L4") {
      var ids = Object.keys(gs).filter(function (k) {
        return k !== "noble" && k !== "original" && k !== "undecided";
      });
      if (!ids.length) ids = ["undecided"];
      var per = v / ids.length;
      ids.forEach(function (k) { gs[k].awake = Math.max(0, num(gs[k].awake) + per); });
      return;
    }
    if (gs.undecided) gs.undecided.awake = Math.max(0, num(gs.undecided.awake) + v);
  }

  function godOp(state, cfg, op) {
    if (!state.gods || !state.gods.pacts) return false;
    var G = global.XuanShuGods;
    if (op.t === "devour") {
      state.gods.devour = clamp(num(state.gods.devour) + num(op.v), 0, 100);
      return true;
    }
    if (op.t === "god" || op.t === "godFavor") {
      if (G && G.adjustFavor) {
        G.adjustFavor(state, cfg, op.god || (G.primaryOf && G.primaryOf(state)), num(op.favor != null ? op.favor : op.v));
        return true;
      }
      return false;
    }
    if (op.t === "summon") {
      state.gods.devour = clamp(num(state.gods.devour) + 5, 0, 100);
      addC(state, 3);
      if (state.society && state.society.infection) {
        state.society.infection.thralls = num(state.society.infection.thralls) + 1;
      }
      return true;
    }
    return false;
  }

  function applyOps(state, cfg, card, choice, notes) {
    var ops = (card.ops || []).slice();
    var soc = state.society || {};
    var caps = {
      food: cfg.food.cap > 0 ? cfg.food.cap : 1e9, water: cfg.water.cap,
      metal: cfg.metal.cap, drug: cfg.hibernation.drugCap
    };
    ops.forEach(function (op) {
      var k = op.t;
      if (k === "stock") {
        var key = op.k;
        state.stocks[key] = clamp(num(state.stocks[key]) + num(op.v), 0, caps[key] || 1e9);
        notes.push((STOCK_LABEL[key] || key) + " " + (op.v >= 0 ? "+" : "") + op.v +
          " " + (STOCK_UNIT[key] || ""));
      } else if (k === "stockPct") {
        var key2 = op.k;
        state.stocks[key2] = clamp(num(state.stocks[key2]) * (1 + num(op.v)), 0, caps[key2] || 1e9);
        notes.push((STOCK_LABEL[key2] || key2) + " " + (op.v >= 0 ? "+" : "") + Math.round(op.v * 100) + "%");
      } else if (k === "infra") {
        var cap = op.k === "hydro" ? cfg.food.hydroMax
          : (op.k === "clonePods" ? cfg.clone.maxPods : 1e9);
        state.infra[op.k] = clamp(num(state.infra[op.k]) + num(op.v), 0, cap);
        notes.push((INFRA_LABEL[op.k] || op.k) + " " + (op.v >= 0 ? "+" : "") + op.v);
      } else if (k === "order") {
        state.order = clamp(num(state.order) + num(op.v), 0.05, 1);
        notes.push("秩序 " + (op.v >= 0 ? "+" : "") + Math.round(op.v * 100) + "%");
      } else if (k === "wear") {
        state.wear = clamp(num(state.wear) + num(op.v), 0, 1);
        notes.push("磨损 " + (op.v >= 0 ? "+" : "") + Math.round(op.v * 100) + "%");
      } else if (k === "tech") {
        if (soc.machine) soc.machine.tech = clamp(num(soc.machine.tech) + num(op.v), 0, 1);
        notes.push("科技 " + (op.v >= 0 ? "+" : "") + op.v);
      } else if (k === "queue") {
        if (op.k === "O") {
          if (soc.effects) soc.effects.oShift += num(op.v);
        } else if (op.k === "W") {
          if (soc.effects) soc.effects.wShift += num(op.v);
        } else {
          queueAll(state, function (q) {
            if (op.scope === "one" && q.id !== (state.player && state.player.pc.queueId)) return;
            if (op.k === "C") q.C = clamp(num(q.C) + num(op.v), 0, 100);
            if (op.k === "S") q.S = clamp(num(q.S) + num(op.v), 0, 1);
          });
        }
        notes.push("队伍" + (QUEUE_LABEL[op.k] || "") + " " + (op.v >= 0 ? "+" : "") + op.v);
      } else if (k === "infect") {
        addC(state, num(op.v));
        notes.push("感染 +" + op.v);
      } else if (k === "randomInfect") {
        if (randNext(state) < num(op.p, 0.3)) {
          addC(state, num(op.v));
          notes.push("有人被感染 +" + op.v);
        }
      } else if (k === "thralls") {
        if (soc.infection) soc.infection.thralls = Math.max(0, num(soc.infection.thralls) + num(op.v));
        notes.push("眷属 " + (op.v >= 0 ? "+" : "") + op.v);
      } else if (k === "garrison") {
        if (soc.garrison && typeof soc.garrison[op.k] === "number") {
          soc.garrison[op.k] = Math.max(0, num(soc.garrison[op.k]) + num(op.v));
          notes.push("警备" + (op.k === "durability" ? "耐久" : "兵力") + " " +
            (op.v >= 0 ? "+" : "") + op.v);
        }
      } else if (k === "pop") {
        popAdjust(state, cfg, op.group, num(op.v));
        notes.push("人口 " + (op.v >= 0 ? "+" : "") + op.v);
      } else if (k === "dormant") {
        if (state.groups && state.groups.original) {
          state.groups.original.dormant = Math.max(0, num(state.groups.original.dormant) + num(op.v));
        }
        notes.push("休眠 " + (op.v >= 0 ? "+" : "") + op.v);
      } else if (k === "player") {
        if (state.player && state.player.pc) {
          var p = state.player.pc;
          p[op.k] = clamp(num(p[op.k]) + num(op.v), 0, 100);
          notes.push((PC_LABEL[op.k] || "你自己") + " " + (op.v >= 0 ? "+" : "") + op.v);
        }
      } else if (k === "godFavor" || k === "god" || k === "devour" || k === "summon") {
        if (godOp(state, cfg, op)) notes.push("古神的态度变了");
        else notes.push("古神没有回应");
      } else if (k === "mod") {
        addMod(state, cfg, op.key, op.v, op.weeks, !!op.mul, card.id);
        if (op.key === "prodMul" && soc.effects) {
          soc.effects.prodMul *= num(op.v, 1);
          soc.effects.prodWeeks = Math.max(num(soc.effects.prodWeeks), rnd(op.weeks || 52));
        }
        if (op.key === "infectSpread" && soc.effects) {
          soc.effects.infSpread = Math.max(0, 1 + num(op.v));
          soc.effects.infWeeks = Math.max(num(soc.effects.infWeeks), rnd(op.weeks || 26));
        }
        notes.push("留下一段长期影响");
      } else if (k === "flag") {
        if (state.player) {
          state.player.flags = state.player.flags || {};
          state.player.flags[op.k] = state.weeks + num(op.weeks, 52);
        }
        notes.push("这件事被记了一笔");
      } else if (k === "intel") {
        if (state.player) {
          state.player.intelBuff = { level: op.level || "high", until: state.weeks + num(op.weeks, 52) };
        }
        notes.push("情报升到「" + ({ low: "街谈巷议", mid: "部门里的消息", high: "高层里的消息", truth: "全部真相" }[op.level] || "高层里的消息") + "」");
      } else if (k === "peek") {
        ensure(state, cfg).peek = Math.max(0, rnd(op.v));
        notes.push("能先看 " + op.v + " 张牌");
      } else if (k === "birth") {
        if (state.groups && state.groups.undecided) {
          state.groups.undecided.awake = num(state.groups.undecided.awake) + num(op.v);
        }
        notes.push("出生 +" + op.v);
      } else if (k === "deptI") {
        var dep = state.player && state.player.pc.dept || "勤务";
        var D = soc.depts && soc.depts[dep];
        if (D) D.I = clamp(num(D.I) + num(op.v), 0, 1);
        notes.push("「" + dep + "」失序 " + (op.v >= 0 ? "+" : "") + op.v);
      } else if (k === "machine") {
        if (soc.machine) {
          if (op.k === "maxChain") soc.machine.maxChain = num(soc.machine.maxChain) + num(op.v);
          else if (op.k === "autonomy") soc.machine.A = clamp(num(soc.machine.A) + num(op.v), 0, 1);
          else if (op.k === "tech") soc.machine.tech = clamp(num(soc.machine.tech) + num(op.v), 0, 1);
        }
        notes.push("机器的状态变了");
      } else if (k === "removeL2") {
        var l2 = ((soc.queues || []).filter(function (q) { return q.layer === "L2"; }))[0];
        if (l2) l2.dPenalty = num(l2.dPenalty) + 8;
        notes.push("拿掉了 " + op.v + " 个中层贵族");
      } else if (k === "vision") {
        addMod(state, cfg, "vision", op.v, 99999, false, card.id);
        notes.push("看得更远");
      }
    });

    // 卡牌 choices 的具体分支
    if (choice) applyChoice(state, cfg, card, choice, notes);
    return notes;
  }

  function applyChoice(state, cfg, card, choice, notes) {
    var soc = state.society || {};
    var v = 0;
    switch (card.id) {
      case "ex_signal":
        if (choice === "tech") { if (soc.machine) soc.machine.tech = clamp(num(soc.machine.tech) + 0.10, 0, 1); notes.push("科技 +0.10"); }
        else if (choice === "thralls") { if (soc.infection) soc.infection.thralls += 3; notes.push("眷属 +3"); }
        else { notes.push(pactByChoice(state, cfg, "random")); }
        break;
      case "cr_decompression":
        if (choice === "pay") { state.stocks.metal = Math.max(0, num(state.stocks.metal) - 15); notes.push("金属 −15 吨"); }
        else { popAdjust(state, cfg, "L4", -12); state.order = clamp(num(state.order) - 0.03, 0.05, 1); notes.push("人口 −12、秩序 −3%"); }
        break;
      case "tr_trader":
        if (choice === "food") { state.stocks.food = num(state.stocks.food) + 50; state.stocks.metal = Math.max(0, num(state.stocks.metal) - 20); notes.push("粮 +50 吨、金属 −20 吨"); }
        else { state.stocks.metal = num(state.stocks.metal) + 40; state.stocks.food = Math.max(0, num(state.stocks.food) - 20); notes.push("金属 +40 吨、粮 −20 吨"); }
        break;
      case "tr_slave_trade":
        if (choice === "buy") { popAdjust(state, cfg, "undecided", 20); state.stocks.metal = Math.max(0, num(state.stocks.metal) - 35); notes.push("人口 +20、金属 −35 吨"); }
        else { popAdjust(state, cfg, "L4", -20); state.stocks.metal = num(state.stocks.metal) + 25; notes.push("人口 −20、金属 +25 吨"); }
        break;
      case "tr_relic_auction":
        if (choice === "tech") { if (soc.machine) soc.machine.tech = clamp(num(soc.machine.tech) + 0.04, 0, 1); notes.push("科技 +0.04"); }
        else if (choice === "thralls") { if (soc.infection) soc.infection.thralls += 3; notes.push("眷属 +3"); }
        else { notes.push(pactByChoice(state, cfg, "random")); }
        break;
      case "og_pact":
        notes.push(pactByChoice(state, cfg, choice));
        break;
      default:
        v = 0;
    }
    return notes;
  }

  function pactByChoice(state, cfg, choice) {
    if (!state.gods || !global.XuanShuGods || !global.XuanShuGods.makePact) return "古神层未就绪";
    var ids = ["maw", "weaver", "star", "fecund"];
    var id = ids.indexOf(choice) >= 0 ? choice : ids[Math.floor(randNext(state) * ids.length)];
    var r = global.XuanShuGods.makePact(state, cfg, id, false);
    return r && r.ok ? "与「" + (r.name || id) + "」立约" : "立约失败";
  }

  /* ---------------- 年度判定 ---------------- */

  function fallbackCheck(state, cfg, luck, gap) {
    var E = cfg.encounter || {};
    var T = num(E.baseBias, -0.723) + 0.55 * (luck - 1) + 0.035 * gap;
    var k = (cfg.judge && cfg.judge.logisticK) || 3.2;
    var p = 1 / (1 + Math.exp(-k * T));
    var u = randNext(state);
    return { judged: true, fired: u < p, allow: u < p, probability: p, rand: u };
  }

  function yearly(state, cfg) {
    var e = ensure(state, cfg);
    if (!e.enabled || e.legacy) return null;
    if (!state.player || !state.player.started) return null;
    var wpy = cfg.time.weeksPerYear;
    if (state.weeks % wpy !== 0) return null;
    // 每轮最后一周交给回滚/节点结算，不生成奇遇
    if (state.weeks >= cfg.time.loopYears * wpy) return null;
    // 41000 年当年直接进胜利结算
    if (absYear(state, cfg) >= 41000) return null;

    if (e.pending) { e.gapYears = num(e.gapYears) + 1; return null; }

    var E = cfg.encounter || {};
    var luck = luckOf(state, cfg);
    var gap = Math.max(0, num(e.gapYears) - num(E.droughtAfterYears, 12));
    var force = !!state.player.debugForceEncounter;
    var jr = force ? { fired: true, probability: 1, rand: 1, tendency: 0 }
      : (global.XuanShuJudge
        ? global.XuanShuJudge.check(state, cfg, "encounter_year",
            { luck: luck - 1, gap: gap }, { slot: "encounter_year", note: "年度奇遇" })
        : fallbackCheck(state, cfg, luck, gap));

    if (!jr.fired) {
      e.gapYears = num(e.gapYears) + 1;
      e.last = { week: state.weeks, year: Math.floor(absYear(state, cfg)),
        probability: Math.round(num(jr.probability) * 1000) / 1000,
        fired: false };
      return null;
    }

    state.player.debugForceEncounter = false;
    var cat = pickCategory(state, cfg);
    var drawn = drawThree(state, cfg, cat);
    var id = "enc_" + state.loop + "_" + state.weeks;
    e.pending = {
      id: id,
      cat: cat,
      catLabel: CAT_LABEL[cat] || cat,
      year: Math.floor(absYear(state, cfg)),
      week: state.weeks,
      cards: drawn.cards,
      createdWeek: state.weeks,
      auto: false
    };
    e.gapYears = 0;
    e.lastWeek = state.weeks;
    e.lastYear = Math.floor(absYear(state, cfg));
    e.last = { week: state.weeks, year: e.lastYear, cat: cat,
      probability: Math.round(num(jr.probability) * 1000) / 1000, fired: true };
    e.counts.total = num(e.counts.total) + 1;
    e.counts.byCat[cat] = num(e.counts.byCat[cat]) + 1;
    // 自动推演：按身份偏好 + 稀有度立即选牌，不停机
    if (state.run && state.run.auto) {
      autoResolve(state, cfg);
      return null;
    }
    return e.pending;
  }

  // 自动选牌：确定性（身份偏好 → 稀有度 → 候选顺序），消耗同一 rngA
  function autoResolve(state, cfg) {
    var e = ensure(state, cfg);
    if (!e.pending) return null;
    var i = autoPick(state, cfg);
    if (i < 0) return null;
    var card = e.pending.cards[i];
    var opts = { auto: true };
    if (card && card.choices && card.choices.length) opts.choice = card.choices[0];
    return choose(state, cfg, i, opts);
  }

  /* ---------------- 三选一 ---------------- */

  function choose(state, cfg, index, opts) {
    opts = opts || {};
    var e = ensure(state, cfg);
    if (!e.pending) return { ok: false, msg: "当前没有待结算的奇遇" };
    var i = Math.floor(num(index, -1));
    var card = e.pending.cards[i];
    if (!card) return { ok: false, msg: "没有这张卡" };
    if (!card.available) return { ok: false, msg: "这张卡现在拿不到：" + card.reason, code: "locked" };
    if (card.choices && card.choices.length && !opts.choice) {
      return { ok: true, needChoice: true, choices: card.choices.slice(),
        card: card, msg: "这张卡还要再选一步" };
    }
    var full = cardOf(cfg, e.pending.cat, card.id) || card;
    var notes = [];
    var M0 = global.XuanShuSim.metrics(state, cfg);
    applyOps(state, cfg, full, opts.choice, notes);
    if (global.XuanShuGods) global.XuanShuGods.afterCard(state, cfg);
    var summary = notes.length ? notes.join("、") : (card.effectText || "");

    var entry = {
      year: e.pending.year,
      cat: e.pending.cat,
      cardId: card.id,
      cardName: card.name,
      rarity: card.rarity,
      choice: i,
      sub: opts.choice || "",
      week: state.weeks,
      auto: !!opts.auto
    };
    e.history.push(entry);
    var cap = num((cfg.encounter || {}).historyCap, 200);
    if (e.history.length > cap) e.history.shift();

    pushEvent(state, cfg, "encounter", "奇遇",
      "奇遇 · " + card.name,
      summary + (card.costText ? "（代价：" + card.costText + "）" : ""),
      "类别 " + (e.pending.catLabel || e.pending.cat) + "，稀有度 " +
      (RARITY_LABEL[card.rarity] || "未知") + "，选了第 " + (i + 1) + " 张" +
      (opts.auto ? "（电脑代选）" : ""),
      global.XuanShuSim.diffMetrics(M0, global.XuanShuSim.metrics(state, cfg)),
      card.followText || "");

    e.pending = null;
    return {
      ok: true, msg: summary, card: card,
      auto: !!opts.auto, effects: notes,
      encounter: brief(state, cfg)
    };
  }

  function autoPick(state, cfg) {
    var e = ensure(state, cfg);
    if (!e.pending) return -1;
    var prefs = {
      ruler: ["society", "tech", "resource", "explore", "trade", "oldgod", "crisis"],
      mid: ["tech", "resource", "society", "trade", "explore", "oldgod", "crisis"],
      slave: ["resource", "society", "trade", "explore", "oldgod", "crisis", "tech"],
      creator: []
    };
    var mode = (state.player && state.player.mode) || "creator";
    var order = prefs[mode] || [];
    var best = -1, bestRank = 99, bestRar = -1;
    e.pending.cards.forEach(function (c, i) {
      if (!c.available) return;
      var rank = order.indexOf(c.cat);
      if (rank < 0) rank = order.length;
      var rar = RARITY_RANK[c.rarity] || 0;
      if (rank < bestRank || (rank === bestRank && rar > bestRar)) {
        best = i; bestRank = rank; bestRar = rar;
      }
    });
    if (best < 0) best = e.pending.cards.findIndex(function (c) { return c.available; });
    return best;
  }

  /* ---------------- 摘要 ---------------- */

  function brief(state, cfg) {
    var e = ensure(state, cfg);
    var deck = {};
    Object.keys(e.deck || {}).forEach(function (cat) {
      var d = e.deck[cat];
      deck[cat] = {
        remaining: (d.remaining || []).length,
        drawn: (d.drawn || []).length,
        cycle: num(d.cycle),
        label: CAT_LABEL[cat] || cat
      };
    });
    return {
      version: VERSION,
      enabled: !!e.enabled && !e.legacy,
      legacy: !!e.legacy,
      luck: Math.round(num(e.luck, 1) * 100) / 100,
      luckDrawn: !!e.luckDrawn,
      gapYears: num(e.gapYears),
      pending: e.pending ? {
        id: e.pending.id,
        cat: e.pending.cat,
        catLabel: e.pending.catLabel,
        year: e.pending.year,
        week: e.pending.week,
        cards: e.pending.cards,
        auto: !!e.pending.auto
      } : null,
      counts: e.counts,
      deck: deck,
      mods: (e.mods || []).filter(function (m) { return state.weeks < m.until; }).map(function (m) {
        return { key: m.key, v: m.v, leftWeeks: m.until - state.weeks, mul: !!m.mul };
      }),
      history: (e.history || []).slice(-20),
      last: e.last,
      peek: num(e.peek)
    };
  }

  var api = {
    version: VERSION,
    create: create,
    ensure: ensure,
    yearly: yearly,
    yearlyCheck: yearly,
    luckOf: luckOf,
    categoryWeights: categoryWeights,
    pickCategory: pickCategory,
    drawThree: drawThree,
    checkNeed: checkNeed,
    choose: choose,
    chooseCard: choose,
    autoPick: autoPick,
    autoResolve: autoResolve,
    brief: brief,
    applyOps: applyOps,
    modMul: modMul,
    modAdd: modAdd,
    modSum: modSum,
    addMod: addMod,
    labels: CAT_LABEL,
    rarities: RARITY_RANK
  };

  global.XuanShuEncounter = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : global);
