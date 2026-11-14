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
    if (!e.planetsDone || typeof e.planetsDone !== "object") e.planetsDone = {};
    if (typeof e.planetCount !== "number") e.planetCount = 0;
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
    // 三张稀有度全相同（含可用性替换后）时换掉最后一张，保证至少两种稀有度。
    if (picked.length >= 2) {
      var rar0 = picked[0].rarity;
      var allSame = picked.every(function (c) { return c.rarity === rar0; });
      if (allSame) {
        var others = cardsOf(cfg, cat).filter(function (c) {
          return c.rarity !== rar0 && !picked.some(function (p) { return p.id === c.id; });
        });
        if (others.length) {
          var swap = others[Math.floor(randNext(state) * others.length)];
          var lastCard = picked[picked.length - 1];
          picked[picked.length - 1] = swap;
          views[views.length - 1] = cardView(state, cfg, cat, swap);
          var di = d.drawn.indexOf(lastCard.id);
          if (di >= 0) d.drawn.splice(di, 1);
          d.drawn.push(swap.id);
          var ri2 = d.remaining.indexOf(swap.id);
          if (ri2 >= 0) d.remaining.splice(ri2, 1);
          d.remaining.push(lastCard.id);
        }
      }
    }
    return { cat: cat, cards: views, raw: picked };
  }

  /* ---------------- 前置 ---------------- */

  // 只报「差多少」的定性档，不把阈值和现值报成两个精确数
  function shortTone(cur, need) {
    var d = need - cur;
    var rel = need > 0 ? d / need : d;
    if (rel <= 0.12) return "还差一点";
    if (rel <= 0.35) return "还差一截";
    return "差得远";
  }

  // 遗迹 / 殖民地 / 遗弃船 / 外星文明：按科技差 d = T_r − t 分四档结算
  function gapOutcome(state, cfg, type) {
    var G = cfg.exploreGap && cfg.exploreGap.types && cfg.exploreGap.types[type];
    if (!G) return null;
    var soc = state.society || {};
    var tech = clamp(num(soc.machine && soc.machine.tech, 0), 0, 1);
    var target = num(G.targetTech, 0);
    var d = target - tech;
    var tier, delta = 0, matMul = 1, success = 0;
    if (d > num(G.high, 0) + 1e-9) {
      return {
        type: type, label: G.label, tier: "D", tierLabel: "高出太多",
        available: false, reason: "科技相差甚远，无法探索",
        d: d, tech: tech, target: target, deltaTech: 0, matBase: 0,
        matMul: 0, metal: 0, success: 0
      };
    }
    if (d < num(G.lowMin, -num(G.low, 0)) - 1e-9) {
      tier = "A";
      delta = 0;
      // 从较低档位起 ×1.2，每再低 0.10 加 5%，封顶 ×1.4
      matMul = Math.min(1.4, 1.2 + 0.05 * Math.floor((num(G.lowMin, 0) - d + 1e-9) / 0.10));
      success = num(G.success && G.success.A, 0.9);
    } else if (d <= num(G.low, 0) + 1e-9) {
      tier = "B";
      delta = Math.min(0.03, Math.max(0, d));
      matMul = 1;
      success = num(G.success && G.success.B, 0.8);
    } else {
      tier = "C";
      delta = Math.min(0.03 + 0.30 * (d - num(G.low, 0)), d);
      matMul = 0.85;
      success = num(G.success && G.success.C, 0.45);
    }
    // 保证不会因为四舍五入越过目标科技（d 为负时科技增量必须为 0）
    delta = Math.min(delta, Math.max(0, d));
    var metal = Math.round(num(G.matBase, 0) * matMul);
    return {
      type: type, label: G.label, tier: tier,
      tierLabel: { A: "远低于你", B: "与你相当", C: "略高于你" }[tier],
      available: true, reason: "",
      d: d, tech: tech, target: target,
      deltaTech: Math.round(delta * 10000) / 10000,
      matBase: num(G.matBase, 0), matMul: matMul, metal: metal, success: success
    };
  }

  function gapFailText(cfg, type) {
    var F = (cfg.exploreGap.types[type] || {}).fail || {};
    var a = [];
    if (F.infect) a.push("全船感染 +" + F.infect);
    if (F.wear) a.push("磨损 +" + F.wear);
    if (F.pop) a.push("人口 " + F.pop);
    return a.join("、");
  }

  function gapView(state, cfg, type) {
    var g = gapOutcome(state, cfg, type);
    if (!g) return null;
    if (!g.available) {
      return { effectText: g.reason, costText: "", followText: "科技差距太大", info: g };
    }
    var eff = (g.deltaTech > 0 ? "科技 +" + g.deltaTech.toFixed(3) : "科技无增量（对方低于你）") +
      "、金属 +" + g.metal + " 吨";
    var fail = gapFailText(cfg, type);
    var cost = "成功率 " + Math.round(g.success * 100) + "%" + (fail ? "；失败：" + fail : "");
    return { effectText: eff, costText: cost, followText: "科技差：对方" + g.tierLabel, info: g };
  }

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
    if (card.gap) {
      var gvNeed = gapOutcome(state, cfg, card.gap);
      if (gvNeed && !gvNeed.available) return { ok: false, reason: gvNeed.reason };
      return { ok: true, reason: "" };
    }
    if (typeof nd.techMin === "number" && tech < nd.techMin) {
      return { ok: false, reason: "科技" + shortTone(tech, nd.techMin) + "，还够不到这块" };
    }
    if (typeof nd.orderMin === "number" && order < nd.orderMin) {
      return { ok: false, reason: "秩序" + shortTone(order, nd.orderMin) + "，现在压不住" };
    }
    if (typeof nd.infectionMin === "number" && share * 100 < nd.infectionMin) {
      return { ok: false, reason: "感染面" + shortTone(share * 100, nd.infectionMin) + "，还没到那个程度" };
    }
    if (typeof nd.thrallsMin === "number" && thralls < nd.thrallsMin) {
      return { ok: false, reason: "眷属" + shortTone(thralls, nd.thrallsMin) + "，人手不够" };
    }
    if (typeof nd.popMin === "number" && total < nd.popMin) {
      return { ok: false, reason: "船上的人" + shortTone(total, nd.popMin) + "，凑不齐" };
    }
    if (typeof nd.dormantMin === "number" && dormant < nd.dormantMin) {
      return { ok: false, reason: "舱里的人" + shortTone(dormant, nd.dormantMin) + "，不够" };
    }
    if (typeof nd.healthMin === "number" && health < nd.healthMin) {
      return { ok: false, reason: "你的身体" + shortTone(health, nd.healthMin) + "，撑不住" };
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
    var gview = c.gap ? gapView(state, cfg, c.gap) : null;
    return {
      id: c.id,
      cat: cat,
      name: c.name,
      rarity: c.rarity,
      available: n.ok,
      reason: n.reason,
      effectText: gview ? gview.effectText : (c.effectText || ""),
      costText: gview ? gview.costText : (c.costText || ""),
      followText: gview ? gview.followText : (c.followText || ""),
      gap: c.gap || "",
      gapInfo: gview ? gview.info : null,
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
      } else if (k === "gapReward") {
        var gOut = gapOutcome(state, cfg, op.type);
        if (!gOut || !gOut.available) {
          notes.push(gOut ? gOut.reason : "这里探不了");
        } else if (randNext(state) < gOut.success) {
          if (gOut.deltaTech > 0 && soc.machine) {
            soc.machine.tech = clamp(num(soc.machine.tech) + gOut.deltaTech, 0, 1);
            notes.push("科技 +" + gOut.deltaTech.toFixed(3));
          } else {
            notes.push("科技没有长进");
          }
          state.stocks.metal = clamp(num(state.stocks.metal) + gOut.metal, 0, caps.metal);
          notes.push("金属 +" + gOut.metal + " 吨");
        } else {
          var gFail = (cfg.exploreGap.types[op.type] || {}).fail || {};
          if (gFail.infect) { addC(state, num(gFail.infect)); notes.push("感染 +" + gFail.infect); }
          if (gFail.wear) {
            state.wear = clamp(num(state.wear) + num(gFail.wear), 0, 1);
            notes.push("磨损 +" + gFail.wear);
          }
          if (gFail.pop) { popAdjust(state, cfg, "undecided", num(gFail.pop)); notes.push("人口 " + gFail.pop); }
          notes.push("探索失败");
        }
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
    // 行星接触：探索类奇遇有 chanceExplore 概率转成五类行星之一
    var planet = null;
    if (cat === "explore" && randNext(state) < num(planetCfg(cfg).chanceExplore, 0.15)) {
      planet = rollPlanet(state, cfg);
    }
    if (planet) {
      e.pending = {
        id: "enc_" + state.loop + "_" + state.weeks,
        cat: cat, catLabel: "探索 · 行星接触",
        year: Math.floor(absYear(state, cfg)), week: state.weeks,
        cards: [planet.card], createdWeek: state.weeks, auto: false,
        planet: planet
      };
      e.gapYears = 0;
      e.lastWeek = state.weeks;
      e.lastYear = Math.floor(absYear(state, cfg));
      e.last = { week: state.weeks, year: e.lastYear, cat: cat,
        probability: Math.round(num(jr.probability) * 1000) / 1000, fired: true };
      e.counts.total = num(e.counts.total) + 1;
      e.counts.byCat[cat] = num(e.counts.byCat[cat]) + 1;
      if (state.run && state.run.auto) {
        var popt = planetOptions(state, cfg, e.pending.planet);
        var pick = null;
        for (var qi = 0; qi < popt.length; qi++) {
          if (popt[qi].key === "retreat" && popt[qi].ok) { pick = popt[qi]; break; }
        }
        if (!pick) for (var qj = 0; qj < popt.length; qj++) if (popt[qj].ok) { pick = popt[qj]; break; }
        if (pick) planetResolve(state, cfg, { opt: pick.key });
        planetClose(state, cfg, { auto: true });
        return null;
      }
      return e.pending;
    }
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
    if (e.pending.cards.some(function (c) { return c.id === "ex_derelict"; })) {
      e.pending.derelict = makeDerelict(state, cfg);
    }
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
    if (e.pending.derelict) {
      var d = e.pending.derelict;
      var t = global.XuanShuSim ? global.XuanShuSim.totals(state, cfg) : { dormant: 0 };
      var free = Math.max(0, Math.floor(num(state.infra && state.infra.pods, 0) - t.dormant));
      var tries = [
        { salvage: 1, takeSome: Math.min(400, free, d.dormant) },
        { salvage: 1, gene: 1 },
        { gene: 1 },
        { salvage: 1 }
      ];
      for (var k = 0; k < tries.length; k++) {
        if (tries[k].takeSome <= 0) delete tries[k].takeSome;
        var rr = derelictResolve(state, cfg, tries[k]);
        if (rr.ok) return derelictClose(state, cfg, { auto: true });
      }
      return derelictClose(state, cfg, { auto: true });
    }
    if (e.pending.planet) {
      var popt2 = planetOptions(state, cfg, e.pending.planet);
      var pick2 = null;
      for (var pk = 0; pk < popt2.length; pk++) {
        if (popt2[pk].key === "retreat" && popt2[pk].ok) { pick2 = popt2[pk]; break; }
      }
      if (!pick2) for (var pm = 0; pm < popt2.length; pm++) if (popt2[pm].ok) { pick2 = popt2[pm]; break; }
      if (pick2) planetResolve(state, cfg, { opt: pick2.key });
      return planetClose(state, cfg, { auto: true });
    }
    var i = autoPick(state, cfg);
    if (i < 0) return null;
    var card = e.pending.cards[i];
    // 自动推演：谈判按 0.75P 直接还价并收场；抵押不做（债务交给玩家）
    if (card && card.id === "tr_negotiator") {
      ensureTrade(state, cfg);
      makeCounterparty(state, cfg);
      negotiationResolve(state, cfg, { ratio: 0.75 });
      return negotiationClose(state, cfg, { auto: true });
    }
    if (card && card.id === "tr_gene_mortgage") {
      return choose(state, cfg, i, { auto: true, tradeDone: true, choice: (card.choices || [])[0] });
    }
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
    if (card.id === "ex_derelict" && !opts.derelictDone) {
      return { ok: true, needDerelict: true, derelict: derelictView(state, cfg),
        card: card, msg: "废弃殖民舰要在卡片里逐项勾选" };
    }
    if (card.id.indexOf("pl_") === 0 && e.pending.planet && !opts.planetDone) {
      return { ok: true, needPlanet: true, planet: planetView(state, cfg),
        card: card, msg: "先在面板里选接触方式" };
    }
    if (card.id === "tr_negotiator" && !opts.tradeDone) {
      ensureTrade(state, cfg);
      makeCounterparty(state, cfg);
      return { ok: true, needNegotiation: true, negotiation: negotiationView(state, cfg),
        card: card, msg: "先在面板里出价或改为武力夺取" };
    }
    if (card.id === "tr_gene_mortgage" && !opts.tradeDone) {
      return { ok: true, needMortgage: true, mortgage: mortgageView(state, cfg),
        card: card, msg: "先填人数与期限" };
    }
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

  /* ---------------- 废弃殖民舰 · 七选项 ---------------- */

  function derelictCfg(cfg) { return (cfg.encounter || {}).derelict || {}; }

  function propOf(state) {
    return num(state.ship && state.ship.propellant, 0);
  }

  // 工质的唯一扣减入口：所有选项都先汇总到这里，不足就整单拒绝并报差额。
  function spendPropellant(state, tons) {
    var have = propOf(state);
    if (tons > have + 1e-9) {
      return { ok: false, short: Math.round((tons - have) * 10) / 10, have: have, need: tons };
    }
    state.ship.propellant = Math.max(0, have - tons);
    return { ok: true, have: have, spent: tons };
  }

  function techOf(state) {
    return num(state.society && state.society.machine && state.society.machine.tech, 0);
  }
  function addTech(state, v) {
    if (!state.society) return;
    if (!state.society.machine) state.society.machine = {};
    state.society.machine.tech = clamp(techOf(state) + v, 0, 1);
  }

  function killAwake(state, n) {
    var order = ["combat", "service", "tech", "medical", "undecided", "clone", "original"];
    var left = Math.max(0, Math.round(n)), killed = 0;
    order.forEach(function (id) {
      if (left <= 0) return;
      var s = state.groups && state.groups[id];
      if (!s) return;
      var take = Math.min(num(s.awake), left);
      s.awake -= take;
      left -= take;
      killed += take;
    });
    return killed;
  }

  function makeDerelict(state, cfg) {
    var D = derelictCfg(cfg);
    if (D.enabled === false || !D.ships || !D.ships.length) return null;
    var ship = D.ships[Math.floor(randNext(state) * D.ships.length)] || D.ships[0];
    if (!state.derelicts || typeof state.derelicts !== "object") state.derelicts = {};
    var seen = state.derelicts[ship.id] || null;
    state.derelicts[ship.id] = {
      firstSeenYear: seen ? seen.firstSeenYear : Math.floor(absYear(state, cfg)),
      times: (seen ? seen.times : 0) + 1,
      profiles: ship.crew.slice()
    };
    return {
      id: ship.id, name: ship.name, cls: ship.cls, note: ship.note,
      tech: ship.tech, hull: ship.hull, hazard: ship.hazard,
      dormant: ship.dormant, salvage: Object.assign({}, ship.salvage),
      left: Object.assign({}, ship.salvage),
      gene: Object.assign({}, ship.gene),
      profiles: ship.crew.slice(),
      exploreRuns: 0, salvageRuns: 0,
      peopleTaken: 0, peopleWoken: 0, proteinTaken: 0, geneTaken: false,
      result: null
    };
  }

  function revivFailRate(state, cfg) {
    var med = clamp(num(state.last && state.last.medCoverage, 0.8), 0, 1);
    return (cfg.hibernation.reviveFail || 0.012) + 0.004 * (1 - med);
  }

  function derelictCost(ship, sel, cfg) {
    var P = derelictCfg(cfg).prop || {};
    var cost = 0;
    cost += Math.max(0, num(sel.explore)) * num(P.explore, 12);
    cost += Math.max(0, num(sel.salvage)) * num(P.salvage, 18);
    if (sel.protein) cost += num(P.protein, 15);
    if (sel.wakeAll) cost += num(P.dock, 8) + ship.dormant * num(P.perPerson, 0.012);
    if (sel.takeSome) cost += num(P.dock, 8) + num(sel.takeSome) * num(P.perPerson, 0.012);
    if (sel.takeAll) cost += num(P.dock, 8) + ship.dormant * num(P.perPerson, 0.012);
    if (sel.gene) cost += num(P.gene, 6);
    return Math.round(cost * 10) / 10;
  }

  function derelictView(state, cfg) {
    var e = ensure(state, cfg);
    var d = e.pending && e.pending.derelict;
    if (!d) return null;
    var D = derelictCfg(cfg);
    var t = global.XuanShuSim ? global.XuanShuSim.totals(state, cfg) : { dormant: 0, total: 0 };
    var pods = num(state.infra && state.infra.pods, 0);
    var free = Math.max(0, Math.floor(pods - t.dormant));
    var per = num(D.proteinPerBody, 0.05);
    return {
      id: d.id, name: d.name, cls: d.cls, note: d.note,
      tech: d.tech, hull: d.hull, hazard: d.hazard,
      dormant: Math.round(d.dormant),
      salvage: Object.assign({}, d.left),
      gene: Object.assign({}, d.gene),
      profiles: d.profiles.slice(),
      prop: { have: Math.round(propOf(state) * 10) / 10 },
      pods: { total: pods, used: Math.round(t.dormant), free: free },
      maxSorties: num(D.maxSorties, 3),
      unit: {
        explore: num((D.prop || {}).explore, 12),
        salvage: num((D.prop || {}).salvage, 18),
        protein: num((D.prop || {}).protein, 15),
        dock: num((D.prop || {}).dock, 8),
        perPerson: num((D.prop || {}).perPerson, 0.012),
        gene: num((D.prop || {}).gene, 6)
      },
      yields: {
        proteinFood: Math.round(d.dormant * per * 10) / 10,
        proteinPerBody: per,
        salvageShare: num(D.salvageShare, 0.4),
        reviveFail: Math.round(revivFailRate(state, cfg) * 1000) / 10,
        teamSize: num(D.teamSize, 20)
      },
      result: d.result,
      canAct: !d.result
    };
  }

  function derelictResolve(state, cfg, sel) {
    var e = ensure(state, cfg);
    if (!e.pending) return { ok: false, msg: "当前没有待结算的奇遇" };
    var d = e.pending.derelict;
    if (!d) return { ok: false, msg: "这局不是废弃殖民舰" };
    if (d.result) return { ok: false, msg: "这一单已经结算过了" };
    sel = sel || {};
    var D = derelictCfg(cfg);
    var explore = clamp(Math.round(num(sel.explore)), 0, num(D.maxSorties, 3));
    var salvageN = clamp(Math.round(num(sel.salvage)), 0, num(D.maxSorties, 3));
    var mutex = ["protein", "wakeAll", "takeSome", "takeAll", "gene"].filter(function (k) { return sel[k]; });
    if (mutex.length > 1) return { ok: false, msg: "后五项只能选一个" };
    var t0 = global.XuanShuSim ? global.XuanShuSim.totals(state, cfg) : { dormant: 0 };
    var free = Math.max(0, Math.floor(num(state.infra && state.infra.pods, 0) - t0.dormant));
    var takeN = sel.takeSome ? Math.round(num(sel.takeSome)) : (sel.takeAll ? d.dormant : 0);
    if (sel.takeSome && (takeN <= 0 || takeN > d.dormant)) return { ok: false, msg: "带走人数不对" };
    if (sel.takeAll && d.dormant > free) {
      return { ok: false, msg: "休眠余位不够：还差 " + (d.dormant - free) + " 个舱位" };
    }
    if (takeN > free) return { ok: false, msg: "休眠余位不够：还差 " + (takeN - free) + " 个舱位" };
    if (!explore && !salvageN && mutex.length === 0) return { ok: false, msg: "至少选一项" };

    var cost = derelictCost(d, { explore: explore, salvage: salvageN, protein: !!sel.protein,
      wakeAll: !!sel.wakeAll, takeSome: sel.takeSome ? takeN : 0, takeAll: !!sel.takeAll, gene: !!sel.gene }, cfg);
    var paid = spendPropellant(state, cost);
    if (!paid.ok) return { ok: false, msg: "工质不足：还差 " + paid.short + " 吨", short: paid.short, need: paid.need };

    var lines = [], deaths = 0, techGain = 0, foodAdd = 0, mAdd = 0, wAdd = 0, drAdd = 0;
    var caps = { food: cfg.food.cap, water: cfg.water.cap, metal: cfg.metal.cap, drug: cfg.hibernation.drugCap };

    // 探索：每次 20 人小队，伤亡上限 20
    for (var i = 0; i < explore; i++) {
      d.exploreRuns++;
      var okP = clamp(0.30 + 0.55 * num(d.hull) - 0.25 * num(d.hazard), 0.10, 0.95);
      var ok = randNext(state) < okP;
      var cas = Math.round(num(D.teamSize, 20) * (0.05 + num(d.hazard) * (ok ? 0.25 : 0.55)));
      cas = clamp(cas, 0, num(D.teamSize, 20));
      var lost = killAwake(state, cas);
      deaths += lost;
      var gap = Math.max(0, num(d.tech) - techOf(state));
      var gain = ok ? Math.min(0.012, gap * 0.35 + 0.002) : Math.min(0.004, gap * 0.12);
      addTech(state, gain);
      techGain += gain;
      lines.push("探索第 " + d.exploreRuns + " 次：" + (ok ? "摸进主控舱" : "只到外环") +
        "，科技 +" + (gain * 100).toFixed(2) + "%，伤亡 " + lost + " 人");
    }

    // 回收物资：每次拿走剩余的四成
    for (var j = 0; j < salvageN; j++) {
      d.salvageRuns++;
      var parts = [];
      ["metal", "water", "drug", "food"].forEach(function (k) {
        var got = Math.round(num(d.left[k]) * num(D.salvageShare, 0.4));
        if (got <= 0) return;
        d.left[k] = Math.max(0, num(d.left[k]) - got);
        state.stocks[k] = Math.min(num(caps[k], 1e9), num(state.stocks[k]) + got);
        if (k === "metal") mAdd += got;
        if (k === "water") wAdd += got;
        if (k === "drug") drAdd += got;
        if (k === "food") foodAdd += got;
        parts.push(({ metal: "金属", water: "淡水", drug: "药剂", food: "粮食" })[k] + " +" + got);
      });
      var sc = clamp(Math.round(num(D.teamSize, 20) * 0.10 * num(d.hazard)), 0, 10);
      var sl = killAwake(state, sc);
      deaths += sl;
      lines.push("回收第 " + d.salvageRuns + " 次：" + (parts.join("、") || "只剩空舱") +
        (sl ? "，伤亡 " + sl + " 人" : ""));
    }

    // 回收蛋白质
    if (sel.protein) {
      var bodies = Math.round(d.dormant);
      var gotFood = Math.round(bodies * num(D.proteinPerBody, 0.05) * 10) / 10;
      state.stocks.food = Math.min(num(cfg.food.cap, 1e9), num(state.stocks.food) + gotFood);
      state.order = clamp(num(state.order) - 0.03, 0.05, 1);
      state.society.queues.forEach(function (q) { q.O = clamp(num(q.O, 50) - 2, 0, 100); });
      d.proteinTaken = bodies;
      d.dormant = 0;
      foodAdd += gotFood;
      lines.push("回收蛋白质：" + bodies + " 人折粮 " + gotFood + " 吨，秩序 −3");
    }

    // 苏醒全部：复用同一套复温死亡公式
    if (sel.wakeAll) {
      var fail = revivFailRate(state, cfg);
      var n0 = Math.round(d.dormant);
      var dead = Math.round(n0 * fail);
      var alive = Math.max(0, n0 - dead);
      state.groups.derelict.awake += alive;
      d.peopleWoken = alive;
      d.dormant = 0;
      deaths += dead;
      lines.push("苏醒全部：" + n0 + " 人唤醒，复温失败 " + dead + " 人（失败率 " +
        (fail * 100).toFixed(1) + "%），" + alive + " 人登船");
    }

    // 带走部分 / 全部：占本舰休眠余位
    if (takeN > 0) {
      state.groups.derelict.dormant += takeN;
      d.peopleTaken = takeN;
      d.dormant = Math.max(0, d.dormant - takeN);
      lines.push((sel.takeAll ? "带走全部：" : "带走部分：") + takeN + " 人进本舰休眠舱，余位剩 " +
        Math.max(0, free - takeN));
    }

    // 留下基因
    if (sel.gene) {
      addTech(state, num(d.gene.tech));
      state.stocks.drug = Math.min(num(cfg.hibernation.drugCap, 1e9), num(state.stocks.drug) + num(d.gene.drug));
      d.geneTaken = true;
      techGain += num(d.gene.tech);
      drAdd += num(d.gene.drug);
      lines.push("留下基因：科技 +" + (num(d.gene.tech) * 100).toFixed(2) + "%、药剂 +" + num(d.gene.drug) +
        "；休眠者留在原位");
    }

    var summary = lines.join("；");
    d.result = { lines: lines, cost: cost, deaths: deaths, techGain: techGain,
      food: foodAdd, metal: mAdd, water: wAdd, drug: drAdd };
    pushEvent(state, cfg, "encounter", "废弃殖民舰 · " + d.name,
      d.cls + "：" + summary,
      "工质 −" + cost + " 吨；" + (d.note || ""),
      { "粮食": Math.round(foodAdd), "金属": Math.round(mAdd), "科技": Math.round(techGain * 1000) / 10 },
      deaths ? "减员 " + deaths + " 人" : "无减员");
    return { ok: true, msg: summary, result: d.result, derelict: derelictView(state, cfg) };
  }

  function derelictClose(state, cfg, opts) {
    opts = opts || {};
    var e = ensure(state, cfg);
    if (!e.pending) return { ok: false, msg: "当前没有待结算的奇遇" };
    var d = e.pending.derelict;
    if (d && !d.result) return { ok: false, msg: "还没结算" };
    var entry = {
      year: e.pending.year, cat: e.pending.cat, cardId: "ex_derelict",
      cardName: d ? ("废弃殖民舰 · " + d.name) : "废弃殖民舰",
      rarity: "rare", choice: 0, sub: d ? d.name : "", week: state.weeks, auto: !!opts.auto
    };
    e.history.push(entry);
    var cap = num((cfg.encounter || {}).historyCap, 200);
    if (e.history.length > cap) e.history.shift();
    e.pending = null;
    return { ok: true, msg: "", encounter: brief(state, cfg) };
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

  /* ---------------- 谈判 · 心理价 / 四档出价 / 掠夺（v6.30） ---------------- */

  function tradeCfg(cfg) { return cfg.trade || {}; }

  function ensureTrade(state, cfg) {
    var e = ensure(state, cfg);
    if (!state.negotiation || typeof state.negotiation !== "object") {
      state.negotiation = { lastP: 0, lastOffer: 0, lastRatio: 0, hostileUntil: 0, greedMul: 1, active: false, result: null };
    }
    var n = state.negotiation;
    ["lastP", "lastOffer", "lastRatio", "hostileUntil"].forEach(function (k) {
      if (typeof n[k] !== "number") n[k] = 0;
    });
    if (typeof n.greedMul !== "number") n.greedMul = 1;
    if (typeof n.active !== "boolean") n.active = false;
    if (n.result === undefined) n.result = null;
    if (!state.geneMortgage || typeof state.geneMortgage !== "object") {
      state.geneMortgage = { active: false, n: 0, years: 0, startWeek: 0, dueWeek: 0,
        yearlyPenalty: 0, paid: 0, defaulted: false, redeemed: false, spouseSplit: 0 };
    }
    return e;
  }

  function playerForce(state) {
    var soc = state.society || {};
    var g = soc.garrison || {};
    var dur = clamp(num(g.durability, 80) / 100, 0, 1);
    var combat = state.groups && state.groups.combat ? num(state.groups.combat.awake) : 0;
    var tech = soc.machine ? num(soc.machine.tech) : 0.3;
    return round1(num(g.strength, 60) * (0.6 + 0.4 * dur) + combat * 0.2 + tech * 40);
  }

  function round1(v) { return Math.round(v * 10) / 10; }

  function typeLabelOf(k) {
    return ({ colony: "殖民站", alien: "外星文明", hostile: "敌对据点", abandoned: "遗弃据点", ruins: "遗迹" })[k] || "据点";
  }

  function makeCounterparty(state, cfg) {
    var T = tradeCfg(cfg);
    var types = Object.keys(T.popValueByType || { colony: 22 });
    var type = types[Math.min(types.length - 1, Math.floor(randNext(state) * types.length))] || "colony";
    var pop = rnd(T.popRange[0] || 120) + Math.floor(randNext(state) *
      Math.max(1, (T.popRange[1] || 420) - (T.popRange[0] || 120)));
    var rare = rnd(T.rareRange[0] || 20) + Math.floor(randNext(state) *
      Math.max(1, (T.rareRange[1] || 90) - (T.rareRange[0] || 20)));
    var tier = (T.tierRange[0] || 1) + Math.floor(randNext(state) *
      Math.max(1, (T.tierRange[1] || 5) - (T.tierRange[0] || 1) + 1));
    var aggr = randNext(state);
    var F = 80 + 40 * tier + 30 * aggr;
    var M = playerForce(state);
    var gr = T.greed || {};
    var greed = M > F * 1.5 ? num(gr.normal, 1) : (M >= F ? num(gr.stalemate, 1.3) : num(gr.weak, 1.6));
    var popValue = pop * num((T.popValueByType || {})[type], 22);
    var P = Math.round((popValue + tier * num(T.techValueK, 120) + rare * num(T.rareValueK, 12)) * greed);
    P = Math.round(P * (state.weeks < num(state.negotiation.hostileUntil) ? num(T.hostileGreed, 1.3) : 1));
    var n = state.negotiation;
    n.cp = { type: type, pop: pop, rare: rare, tier: tier, aggr: round1(aggr * 100) / 100,
      F: Math.round(F), M: M, greed: greed, P: P };
    n.P = P;
    n.active = true;
    n.result = null;
    n.offered = -1;
    return n.cp;
  }

  function availableValue(state, cfg) {
    var V = tradeCfg(cfg).unitValue || {};
    var s = state.stocks || {};
    return round1(num(s.metal) * num(V.metal, 1) + num(s.food) * num(V.food, 0.5) +
      num(s.drug) * num(V.drug, 2) + num(s.water) * num(V.water, 0.5));
  }

  function payValue(state, cfg, value) {
    var T = tradeCfg(cfg), V = T.unitValue || {}, s = state.stocks || {};
    var order = ["metal", "food", "drug", "water"];
    var remain = value, spent = {};
    for (var i = 0; i < order.length; i++) {
      var k = order[i], u = num(V[k], 1);
      var avail = num(s[k]) * u;
      var take = Math.min(avail, remain);
      if (take > 0) {
        s[k] = Math.max(0, num(s[k]) - take / u);
        spent[k] = Math.round(take / u * 10) / 10;
        remain -= take;
      }
    }
    return { ok: remain <= 0.5, short: Math.max(0, Math.round(remain * 10) / 10), spent: spent };
  }

  function freePods(state, cfg) {
    var t = global.XuanShuSim && global.XuanShuSim.totals ? global.XuanShuSim.totals(state, cfg) : null;
    var dormant = t ? num(t.dormant) : 0;
    return Math.max(0, Math.floor(num(state.infra && state.infra.pods, 0) - dormant));
  }

  function deliver(state, cfg, cp, mode, lines) {
    var T = tradeCfg(cfg);
    var techGain = 0, metalAdd = 0, popAdd = 0;
    if (mode === "resource" || mode === "full") {
      metalAdd = Math.round(cp.rare * num(T.rareValueK, 12) * (mode === "full" ? 1 : 0.6));
      state.stocks.metal = Math.min(num(cfg.metal.cap, 1e9), num(state.stocks.metal) + metalAdd);
      lines.push("得到：稀有资源折金属 +" + metalAdd + " 吨");
    }
    if (mode === "tech" || mode === "full") {
      techGain = Math.round(cp.tier * num(T.techGainK, 0.02) * 1000) / 1000;
      addTech(state, techGain);
      lines.push("得到：科技 +" + techGain + "（对方科技档 " + cp.tier + "）");
    }
    if (mode === "full") {
      var want = Math.round(cp.pop * num(T.popTransferK, 0.10));
      popAdd = Math.min(want, freePods(state, cfg));
      if (popAdd > 0) state.groups.derelict.dormant += popAdd;
      lines.push("得到：休眠移民 +" + popAdd + " 人" +
        (popAdd < want ? "（舱位不足，原定 " + want + " 人）" : ""));
    }
    return { techGain: techGain, metalAdd: metalAdd, popAdd: popAdd };
  }

  // 按价值从高到低扣人：科技 > 贵族 > 医疗 > 战斗 > 勤务 > 未定 > 克隆 > 遗民
  function removeValuePop(state, cfg, n) {
    var order = ["tech", "noble", "medical", "combat", "service", "undecided", "clone", "derelict"];
    var left = n, taken = 0;
    for (var i = 0; i < order.length && left > 0; i++) {
      var g = state.groups[order[i]];
      if (!g) continue;
      var take = Math.min(num(g.awake), left);
      if (take > 0) { g.awake -= take; left -= take; taken += take; }
    }
    return Math.round(taken);
  }

  function spouseSplitOf(state, cfg, removed, pool) {
    var s = num(tradeCfg(cfg).spouseShare, 0.45);
    return Math.round(s * removed * Math.max(0, 1 - removed / Math.max(1, pool)));
  }

  function negotiationView(state, cfg, debug) {
    ensureTrade(state, cfg);
    var n = state.negotiation;
    if (!n.cp) makeCounterparty(state, cfg);
    var cp = n.cp, T = tradeCfg(cfg);
    var offers = (T.offers || [0.4, 0.75, 1.2, 2.2]).map(function (r) {
      var value = Math.round(cp.P * r);
      return { ratio: r, value: value, payOk: availableValue(state, cfg) >= value };
    });
    var v = {
      type: cp.type, typeLabel: typeLabelOf(cp.type),
      pop: cp.pop, rare: cp.rare, tier: cp.tier,
      forceF: cp.F, forceM: cp.M, plunderOk: cp.M >= cp.F,
      have: round1(availableValue(state, cfg)),
      offers: offers,
      hostile: state.weeks < num(n.hostileUntil),
      hostileWeeksLeft: Math.max(0, Math.round(num(n.hostileUntil) - state.weeks)),
      result: n.result || null,
      hint: n.result ? "" : "对方只肯给一句准话：这个数「远低于 / 接近 / 高于」他们心里的价。"
    };
    if (debug) v.P = cp.P;
    return v;
  }

  function negotiationResolve(state, cfg, sel) {
    ensureTrade(state, cfg);
    var n = state.negotiation;
    if (!n.cp) return { ok: false, msg: "没有谈判对象" };
    if (n.result) return { ok: false, msg: "这一单已经结算" };
    var cp = n.cp, T = tradeCfg(cfg);
    var lines = [];
    var ratio = num(sel && sel.ratio, -1);
    var plunder = !!(sel && sel.plunder);

    n.lastRatio = plunder ? num(T.plunderTotalK, 2) : ratio;
    n.lastP = cp.P;
    n.lastOffer = Math.round(cp.P * n.lastRatio);
    n.active = false;

    if (plunder) {
      if (cp.M < cp.F) {
        n.active = true;
        return { ok: false, msg: "我方战力 " + cp.M + " 对 " + cp.F + "，硬抢不成立" };
      }
      var total = Math.round(cp.P * num(T.plunderTotalK, 2));
      var sh = T.plunderShare || {};
      var drugAdd = Math.round(total * num(sh.drug, 0.2) / num((T.unitValue || {}).drug, 2));
      var metalAdd = Math.round(total * num(sh.metal, 0.4) / num((T.unitValue || {}).metal, 1));
      var foodAdd = Math.round(total * num(sh.food, 0.2) / num((T.unitValue || {}).food, 0.5));
      var waterAdd = Math.round(total * num(sh.water, 0.1) / num((T.unitValue || {}).water, 0.5));
      var popWant = Math.round(total * num(sh.pop, 0.1) / num((T.unitValue || {}).pop, 3));
      var popAdd = Math.min(popWant, cp.pop, freePods(state, cfg));
      state.stocks.drug = Math.min(num(cfg.hibernation.drugCap, 1e9), num(state.stocks.drug) + drugAdd);
      state.stocks.metal = Math.min(num(cfg.metal.cap, 1e9), num(state.stocks.metal) + metalAdd);
      state.stocks.food = Math.min(num(cfg.food.cap, 1e9), num(state.stocks.food) + foodAdd);
      state.stocks.water = Math.min(num(cfg.water.cap, 1e9), num(state.stocks.water) + waterAdd);
      if (popAdd > 0) state.groups.derelict.dormant += popAdd;
      var split = spouseSplitOf(state, cfg, popAdd, cp.pop);
      var ord = num((T.plunderOrder || {}).normal, 0.04) * (split > 0 ? num((T.plunderOrder || {}).spouseMul, 1.1) : 1);
      state.order = clamp(num(state.order) - ord, 0.05, 1);
      n.hostileUntil = state.weeks + num(T.hostileWeeks, 520);
      lines.push("付出：无，武力夺取固定按 2P 折算（P=" + cp.P + "）");
      lines.push("得到：药剂 +" + drugAdd + " 份、金属 +" + metalAdd + " 吨、粮 +" + foodAdd +
        " 吨、水 +" + waterAdd + " 吨、休眠移民 +" + popAdd + " 人");
      lines.push("关系：敌对 " + Math.round(num(T.hostileWeeks, 520) / 52) + " 年；秩序 −" +
        (ord * 100).toFixed(1) + "%" + (split > 0 ? "（夫妻拆散 " + split + " 对，惩罚 ×1.1）" : "") +
        (popAdd < popWant ? "；舱位不足，少带走 " + (popWant - popAdd) + " 人" : ""));
      n.result = { lines: lines, kind: "plunder", spouseSplit: split, popAdd: popAdd };
      pushEvent(state, cfg, "trade", "谈判", "武力夺取 · " + typeLabelOf(cp.type),
        "2P=" + total + " 当量；" + lines[1],
        "我方战力 " + cp.M + " ≥ 对方 " + cp.F + "；夫妻拆散 " + split + " 对",
        true, { "秩序": -Math.round(ord * 1000) / 10, "金属": metalAdd, "人口": popAdd },
        "对方星球标记敌视，同类事件心理价 +30%");
      return { ok: true, msg: lines.join("；"), result: n.result, negotiation: negotiationView(state, cfg) };
    }

    if (!(ratio > 0)) return { ok: false, msg: "先选一个出价" };
    var offerValue = Math.round(cp.P * ratio);
    if (availableValue(state, cfg) < offerValue) {
      n.active = true;
      return { ok: false, msg: "可动用资源 " + availableValue(state, cfg) + "，出价要 " + offerValue };
    }
    var pay = payValue(state, cfg, offerValue);
    if (!pay.ok) { n.active = true; return { ok: false, msg: "资源不足，差 " + pay.short }; }
    var spentTxt = Object.keys(pay.spent).map(function (k) {
      return ({ metal: "金属", food: "粮", drug: "药剂", water: "水" }[k] || k) + " −" + pay.spent[k];
    }).join("、") || "无";

    if (ratio < 0.5) {
      var loss = Math.round(10 + Math.min(20, 40 * (0.5 - ratio)));
      var dead = removeValuePop(state, cfg, loss);
      var split2 = spouseSplitOf(state, cfg, dead, 2400);
      var ord2 = 0.02 * (split2 > 0 ? 1.1 : 1);
      state.order = clamp(num(state.order) - ord2, 0.05, 1);
      n.hostileUntil = state.weeks + num(T.hostileWeeks, 520);
      lines.push("付出：" + spentTxt + "（" + offerValue + " 当量）");
      lines.push("得到：无，对方拒绝并动手，人口 −" + dead + " 人");
      lines.push("关系：敌对，短期内无法再谈；秩序 −" + (ord2 * 100).toFixed(1) + "%" +
        (split2 > 0 ? "（夫妻拆散 " + split2 + " 对，惩罚 ×1.1）" : ""));
      n.result = { lines: lines, kind: "refuse", split: split2 };
    } else if (ratio < 1.0) {
      var giveTech = randNext(state) < num(T.partialTechP, 0.5);
      var got = deliver(state, cfg, cp, giveTech ? "tech" : "resource", lines);
      state.order = clamp(num(state.order) - 0.01, 0.05, 1);
      lines.unshift("付出：" + spentTxt + "（" + offerValue + " 当量，出价 / P ≈ " + ratio.toFixed(2) + "）");
      lines.push("关系：部分成交，对方态度下降，人口不给；秩序 −1%");
      got.partial = true;
      n.result = { lines: lines, kind: "partial", got: got };
    } else if (ratio < 2.0) {
      var got3 = deliver(state, cfg, cp, "full", lines);
      lines.unshift("付出：" + spentTxt + "（" + offerValue + " 当量，出价 / P ≈ " + ratio.toFixed(2) + "）");
      lines.push("关系：全额成交，关系中性");
      n.result = { lines: lines, kind: "full", got: got3 };
    } else {
      var got4 = deliver(state, cfg, cp, "full", lines);
      state.order = clamp(num(state.order) - 0.04, 0.05, 1);
      addC(state, 2);
      lines.unshift("付出：" + spentTxt + "（" + offerValue + " 当量，出价 / P ≈ " + ratio.toFixed(2) + "）");
      lines.push("关系：掠夺性出价，对方收钱但全船鄙夷；秩序 −4%、感染 +2");
      n.result = { lines: lines, kind: "predatory", got: got4 };
    }
    pushEvent(state, cfg, "trade", "谈判", "谈判 · " + typeLabelOf(cp.type),
      lines.join("；"),
      "P=" + cp.P + "，出价 " + offerValue + "，比值 " + ratio.toFixed(2) +
      "，我方战力 " + cp.M + " / 对方 " + cp.F,
      true, null, "三次结算行见奇遇面板");
    return { ok: true, msg: lines.join("；"), result: n.result, negotiation: negotiationView(state, cfg) };
  }

  function negotiationClose(state, cfg, opts) {
    opts = opts || {};
    var e = ensure(state, cfg);
    if (!e.pending) return { ok: false, msg: "当前没有待结算的奇遇" };
    var n = state.negotiation;
    if (!n || !n.result) return { ok: false, msg: "这一单还没结算" };
    e.history.push({
      year: e.pending.year, cat: e.pending.cat, cardId: "tr_negotiator",
      cardName: "行星代理人", rarity: "rare", choice: 0,
      sub: n.result.kind, week: state.weeks, auto: !!opts.auto
    });
    var cap = num((cfg.encounter || {}).historyCap, 200);
    if (e.history.length > cap) e.history.shift();
    e.pending = null;
    n.cp = null;
    n.active = false;
    return { ok: true, msg: "", encounter: brief(state, cfg) };
  }

  /* ---------------- 基因抵押（v6.30） ---------------- */

  function mortgageCfg(cfg) { return (cfg.trade || {}).mortgage || {}; }

  function eligibleMortgage(state) {
    var gs = state.groups || {};
    return Math.floor(num(gs.undecided && gs.undecided.awake) +
      num(gs.original && gs.original.awake));
  }

  function mortgageTier(state) {
    return 1 + Math.round(num(state.society && state.society.machine && state.society.machine.tech, 0.3) * 4);
  }

  function mortgageYearMul(cfg, years) {
    var ym = mortgageCfg(cfg).yearMul || { 5: 1, 10: 1.4, 20: 2 };
    return num(ym[years], 1);
  }

  function mortgageValue(state, cfg) {
    var M = mortgageCfg(cfg);
    return round1(num(M.valueMetal, 12) + num(M.valueTechK, 6) * mortgageTier(state));
  }

  function mortgageView(state, cfg) {
    ensureTrade(state, cfg);
    var gm = state.geneMortgage, M = mortgageCfg(cfg);
    var V = mortgageValue(state, cfg);
    var yearAdd = { 5: 0, 10: 0, 20: 0 };
    [5, 10, 20].forEach(function (y) {
      yearAdd[y] = Math.round(1000 * Math.round(V * num(M.instantK, 0.6) * mortgageYearMul(cfg, y)) / 1000);
    });
    var redeemPrice = 0;
    if (gm.active) {
      var leftYears = Math.max(1, Math.ceil((num(gm.dueWeek) - state.weeks) / 52));
      redeemPrice = Math.round(leftYears * num(gm.n) * V * num(M.redeemK, 0.8));
    }
    return {
      active: !!gm.active, n: Math.round(num(gm.n)), years: Math.round(num(gm.years)),
      eligible: eligibleMortgage(state), value: V, tier: mortgageTier(state),
      perYear: yearAdd, yearMuls: { 5: mortgageYearMul(cfg, 5), 10: mortgageYearMul(cfg, 10), 20: mortgageYearMul(cfg, 20) },
      dueWeek: Math.round(num(gm.dueWeek)), yearsLeft: gm.active
        ? Math.max(0, Math.ceil((num(gm.dueWeek) - state.weeks) / 52)) : 0,
      yearlyPenalty: num(gm.yearlyPenalty), redeemPrice: redeemPrice,
      paid: Math.round(num(gm.paid)), defaulted: !!gm.defaulted, redeemed: !!gm.redeemed,
      result: gm.resultPending ? gm.result : null,
      have: round1(availableValue(state, cfg))
    };
  }

  function mortgageStart(state, cfg, sel) {
    ensureTrade(state, cfg);
    var gm = state.geneMortgage, M = mortgageCfg(cfg);
    if (gm.active) return { ok: false, msg: "已经有一笔抵押在跑，先赎回" };
    var n = Math.round(num(sel && sel.n));
    var years = Math.round(num(sel && sel.years, 5));
    if (!(n > 0)) return { ok: false, msg: "先填抵押人数" };
    if ([5, 10, 20].indexOf(years) < 0) return { ok: false, msg: "期限只能是 5 / 10 / 20 年" };
    var elig = eligibleMortgage(state);
    if (n > elig) return { ok: false, msg: "育龄人口只有 " + elig + " 人" };
    var V = mortgageValue(state, cfg);
    var gross = Math.round(n * V * num(M.instantK, 0.6) * mortgageYearMul(cfg, years));
    state.stocks.metal = Math.min(num(cfg.metal.cap, 1e9), num(state.stocks.metal) + gross);
    gm.active = true;
    gm.n = n; gm.years = years;
    gm.startWeek = state.weeks;
    gm.dueWeek = state.weeks + years * 52;
    gm.yearlyPenalty = num((M.orderByYear || [0.02])[0], 0.02);
    gm.paid = gross;
    gm.defaulted = false;
    gm.redeemed = false;
    gm.spouseSplit = 0;
    gm.resultPending = true;
    gm.result = {
      lines: [
        "付出：未来 " + years + " 年内 " + n + " 人的基因处置权（每年秩序惩罚，产出 ×0.85、寿命 −5%）",
        "得到：金属 +" + gross + " 吨（单人价值 " + V + " × 0.6 × 年化 " + mortgageYearMul(cfg, years) + "）",
        "关系：到期需付 " + Math.round(years * n * V * num(M.redeemK, 0.8)) + " 金属当量赎回（剩余年 × 人数 × 单人价值 × 0.8），否则违约扣人"
      ],
      kind: "start"
    };
    pushEvent(state, cfg, "trade", "谈判", "签下基因抵押",
      n + " 人 × " + years + " 年，即时金属 +" + gross + " 吨",
      "单人价值 " + V + "；年化系数 " + mortgageYearMul(cfg, years) + "；首年秩序 −" +
      (gm.yearlyPenalty * 100).toFixed(0) + "%",
      true, { "金属": gross }, "这是把未来折成今天");
    return { ok: true, msg: "抵押已生效", result: gm.result, mortgage: mortgageView(state, cfg) };
  }

  function mortgageSettle(state, cfg, manual) {
    ensureTrade(state, cfg);
    var gm = state.geneMortgage, M = mortgageCfg(cfg);
    if (!gm.active) return { ok: false, msg: "没有进行中的抵押" };
    gm.resultPending = !!manual;
    var V = mortgageValue(state, cfg);
    var leftYears = Math.max(1, Math.ceil((num(gm.dueWeek) - state.weeks) / 52));
    var price = Math.round(leftYears * num(gm.n) * V * num(M.redeemK, 0.8));
    var pay = availableValue(state, cfg) >= price ? payValue(state, cfg, price) : { ok: false, short: price };
    var lines = [];
    if (pay.ok) {
      gm.active = false;
      gm.redeemed = true;
      gm.result = { lines: [
        "付出：" + (pay.spent ? Object.keys(pay.spent).map(function (k) {
          return ({ metal: "金属", food: "粮", drug: "药剂", water: "水" }[k] || k) + " −" + pay.spent[k];
        }).join("、") : "金属 −" + price),
        "得到：" + gm.n + " 人的基因处置权收回，秩序惩罚停止",
        "关系：赎回完成，未违约"
      ], kind: "redeem" };
      pushEvent(state, cfg, "trade", "谈判", "赎回基因抵押",
        gm.n + " 人赎回，付出 " + price + " 金属当量",
        "剩余年限 " + leftYears + " 年 × " + gm.n + " 人 × 单人价值 " + V + " × 0.8",
        true, null, "债务结清");
      return { ok: true, msg: "赎回成功", mortgage: mortgageView(state, cfg) };
    }
    // 违约：按价值从高到低扣人，配偶分离额外 +10% 秩序惩罚
    var taken = removeValuePop(state, cfg, Math.round(num(gm.n)));
    var split = spouseSplitOf(state, cfg, taken, 2400);
    var ord = num(M.defaultOrder, 0.10) * (split > 0 ? 1.10 : 1);
    state.order = clamp(num(state.order) - ord, 0.05, 1);
    addC(state, num(M.defaultInfect, 3));
    gm.active = false;
    gm.defaulted = true;
    gm.spouseSplit = split;
    gm.result = { lines: [
      "付出：" + taken + " 人被强制带走（按价值从高到低），秩序 −" + (ord * 100).toFixed(1) + "%",
      "得到：无，抵押到期未赎回",
      "关系：违约，感染 +" + num(M.defaultInfect, 3) + (split > 0 ? "；夫妻拆散 " + split + " 对，惩罚 ×1.1" : "")
    ], kind: "default" };
    pushEvent(state, cfg, "trade", "谈判", "基因抵押违约",
      taken + " 人被带走，秩序 −" + (ord * 100).toFixed(1) + "%",
      "到期未赎回；配偶拆散 " + split + " 对" + (split > 0 ? "，秩序惩罚 ×1.1" : "") +
      "；感染 +" + num(M.defaultInfect, 3),
      true, { "秩序": -Math.round(ord * 1000) / 10, "人口": -taken }, "债主上门不谈判");
    return { ok: true, msg: "抵押违约", mortgage: mortgageView(state, cfg) };
  }

  // 每周推进：逐年提升秩序惩罚；到期自动尝试赎回，不足则违约
  function mortgageTick(state, cfg) {
    ensureTrade(state, cfg);
    var gm = state.geneMortgage;
    if (!gm.active) return;
    var M = mortgageCfg(cfg);
    var idx = Math.max(0, Math.floor((state.weeks - num(gm.startWeek)) / 52));
    var arr = M.orderByYear || [0.02, 0.04, 0.06, 0.08, 0.12];
    gm.yearlyPenalty = num(arr[Math.min(idx, arr.length - 1)], 0.12);
    if (state.weeks >= num(gm.dueWeek)) mortgageSettle(state, cfg, false);
  }

  function mortgageClose(state, cfg, opts) {
    opts = opts || {};
    var e = ensure(state, cfg);
    if (!e.pending) return { ok: false, msg: "当前没有待结算的奇遇" };
    e.history.push({
      year: e.pending.year, cat: e.pending.cat, cardId: "tr_gene_mortgage",
      cardName: "基因抵押商", rarity: "rare", choice: 0,
      sub: state.geneMortgage && state.geneMortgage.active ? "signed" : "passed",
      week: state.weeks, auto: !!opts.auto
    });
    var cap = num((cfg.encounter || {}).historyCap, 200);
    if (e.history.length > cap) e.history.shift();
    e.pending = null;
    if (state.geneMortgage) {
      state.geneMortgage.result = null;
      state.geneMortgage.resultPending = false;
    }
    return { ok: true, msg: "", encounter: brief(state, cfg) };
  }

  /* ---------------- 五类行星 · 接触判定 ---------------- */

  var PLANET_LABEL = {
    colony: "前人类殖民地", alien: "外星文明", hostile: "敌对星球",
    abandoned: "废弃宜居星", ruins: "古神遗迹"
  };
  var PLANET_RARITY = { colony: "common", alien: "epic", hostile: "rare", abandoned: "common", ruins: "legendary" };

  function planetCfg(cfg) { return ((cfg.encounter || {}).planets) || {}; }

  function ensurePlanets(state, cfg) {
    var e = ensure(state, cfg);
    if (!e.planetsDone || typeof e.planetsDone !== "object") e.planetsDone = {};
    if (typeof e.planetCount !== "number") e.planetCount = 0;
    return e;
  }

  function pickPlanetType(state, cfg) {
    var P = planetCfg(cfg), W = P.weights || {}, e = ensurePlanets(state, cfg);
    var keys = Object.keys(W).filter(function (k) {
      if (k === "derelict") return false;
      var cap = num((P.unique || {})[k], 0);
      return !(cap > 0 && num(e.planetsDone[k]) >= cap);
    });
    var total = 0;
    keys.forEach(function (k) { total += Math.max(0, num(W[k])); });
    if (!keys.length || total <= 0) return null;
    var r = randNext(state) * total;
    for (var i = 0; i < keys.length; i++) {
      r -= Math.max(0, num(W[keys[i]]));
      if (r <= 0) return keys[i];
    }
    return keys[keys.length - 1];
  }

  function planetForce(state, cfg) {
    var soc = state.society || {};
    var tech = clamp(num((soc.machine || {}).tech, 0.3), 0, 1);
    var combat = state.groups && state.groups.combat ? num(state.groups.combat.awake) : 0;
    var avail = 1;
    if (global.XuanShuSociety && global.XuanShuSociety.garrisonAvail) {
      avail = clamp(num(global.XuanShuSociety.garrisonAvail(state, cfg), 1), 0.2, 1);
    }
    return Math.round(combat * (0.6 + 0.4 * tech) * avail);
  }

  function addStock(state, cfg, key, add) {
    var cap = key === "metal" ? num(cfg.metal.cap, 0)
      : key === "food" ? num(cfg.food.cap, 0)
        : key === "water" ? num(cfg.water.cap, 0)
          : num(cfg.hibernation.drugCap, 0);
    if (!(cap > 0)) cap = Infinity;
    state.stocks[key] = Math.min(cap, num(state.stocks[key]) + add);
  }

  function addTech(state, d) {
    var m = state.society && state.society.machine;
    if (m) m.tech = clamp(num(m.tech) + d, 0, 1);
  }

  function rollPlanet(state, cfg) {
    var P = planetCfg(cfg), e = ensurePlanets(state, cfg);
    if (!P.enabled) return null;
    var type = pickPlanetType(state, cfg);
    if (!type) return null;
    var tech = techOf(state);
    var dwell = Math.max(1, rnd((P.dwellWeeks || {})[type] || 3));
    var minTech = num((P.minTech || {})[type], 0);
    var techOk = tech >= minTech;
    var contactP = 1 - Math.exp(-num(P.scanK, 0.06) * dwell * (0.5 + tech));
    var contacted = randNext(state) < contactP;
    var hp = P.hostile || {};
    var tier = 1 + Math.floor(randNext(state) * 3);
    var aggr = randNext(state);
    var F = contacted && type === "hostile"
      ? Math.round(num(hp.forceBase, 80) + num(hp.forceTier, 40) * tier + num(hp.forceAggr, 30) * aggr)
      : 0;
    var M = type === "hostile" ? planetForce(state, cfg) : 0;
    var ratio = F > 0 ? M / F : 0;
    var pop = 0;
    var rg = (P.popRange || {})[type];
    if (rg) pop = Math.round(num(rg[0]) + randNext(state) * Math.max(1, num(rg[1]) - num(rg[0])));

    var dwellFood = 0, dwellProp = 0;
    var fWant = dwell * num(P.dwellFood, 6);
    dwellFood = Math.round(Math.min(num(state.stocks.food), fWant));
    if (dwellFood > 0) addStock(state, cfg, "food", -dwellFood);
    var pWant = dwell * num(P.dwellProp, 1.5);
    var pHave = num(state.ship && state.ship.propellant);
    dwellProp = Math.round(Math.min(pHave, pWant) * 10) / 10;
    if (dwellProp > 0 && state.ship) state.ship.propellant = Math.max(0, pHave - dwellProp);

    var p = {
      id: "pl-" + state.weeks + "-" + type, type: type, week: state.weeks,
      year: Math.floor(state.weeks / 52), tier: tier, dwell: dwell,
      minTech: minTech, techOk: techOk, contactP: Math.round(contactP * 1000) / 1000,
      contacted: contacted, pop: pop, F: F, M: M, ratio: Math.round(ratio * 100) / 100,
      dwellFood: dwellFood, dwellProp: dwellProp, forced: null, result: null
    };

    // 敌对星球：接触即判定，<0.5 当场吃亏，只保留撤退
    if (type === "hostile" && contacted && ratio < 0.5) {
      var loss = Math.round(num((hp.lossBad || [20, 60])[0]) +
        randNext(state) * (num((hp.lossBad || [20, 60])[1]) - num((hp.lossBad || [20, 60])[0])));
      var t = global.XuanShuSim && global.XuanShuSim.totals ? global.XuanShuSim.totals(state, cfg) : null;
      var totalPop = t ? Math.max(1, num(t.awake) + num(t.dormant)) : 4000;
      if (global.XuanShuSim && global.XuanShuSim.killProportional) {
        global.XuanShuSim.killProportional(state, cfg, loss / totalPop);
      }
      state.wear = clamp(num(state.wear) + num(hp.wearBad, 0.03), 0, 1);
      p.forced = loss;
      p.result = {
        kind: "forced",
        lines: [
          "接触：对方先开火，我方 M " + M + " 对 F " + F + "（比值 " + p.ratio + "）",
          "损失：人口 −" + loss + " 人、舰体磨损 +" + Math.round(num(hp.wearBad, 0.03) * 100) + "%",
          "关系：只能撤回轨道，本星球不能再谈"
        ]
      };
      pushEvent(state, cfg, "planet", "行星接触", "敌对星球 · 被迫撤离",
        "M " + M + " / F " + F + " < 0.5，接触即遭伏击；人口 −" + loss,
        "战力比 " + p.ratio, true,
        { "人口": -loss, "磨损": Math.round(num(hp.wearBad, 0.03) * 1000) / 10 }, "同类星球下次可先侦察再接近");
    }

    e.planetCount += 1;
    e.planetsDone[type] = num(e.planetsDone[type]) + (type === "ruins" ? 1 : 0);
    p.card = {
      id: "pl_" + type, name: PLANET_LABEL[type] || "未知行星",
      rarity: PLANET_RARITY[type] || "rare", cat: "explore", available: true,
      effectText: "接触" + (PLANET_LABEL[type] || "行星") + "（停留 " + dwell + " 周）",
      costText: "粮 −" + dwellFood + " 吨 / 工质 −" + dwellProp + " 吨",
      followText: contacted ? "已建立接触" : "未建立接触"
    };
    return p;
  }

  function planetOptions(state, cfg, p) {
    var P = planetCfg(cfg), opts = [];
    function opt(key, label, ok, reason) { opts.push({ key: key, label: label, ok: ok !== false, reason: reason || "" }); }
    var pro = num(state.ship && state.ship.propellant);
    if (p.forced) { opt("retreat", "撤回航线", true, ""); return opts; }
    if (!p.contacted) {
      opt("retreat", "返回航线（未接触）", pro >= 2, pro >= 2 ? "" : "工质不足 2 吨");
      return opts;
    }
    if (p.type === "colony") {
      if (!p.techOk) {
        opt("orbit", "轨道级测绘（科技不足）", true);
        opt("retreat", "返回航线", true);
        return opts;
      }
      opt("archive", "取走殖民地档案（科技 +2~5%）", true);
      opt("loot", "搜刮仓储（金属 +30~80 / 粮 +40~120）", true);
      opt("survivors", "带走幸存者（人口，需舱位）", freePods(state, cfg) > 0, "没有空舱位");
      opt("retreat", "不接触，返回航线", true);
    } else if (p.type === "alien") {
      opt("negotiate", "按心理价交易（付资源，换科技与人口）", true);
      opt("techswap", "技术交换（金属 −60~120，科技 +3%）", num(state.stocks.metal) >= 60, "金属不足 60 吨");
      opt("refuse", "婉拒并离开", true);
    } else if (p.type === "hostile") {
      var hp = P.hostile || {};
      var pv = p.ratio >= 1 ? num(hp.popValueSmall, 3) : (p.ratio >= 0.5 ? num(hp.popValueMid, 4.2) : num(hp.popValueBig, 5.5));
      p.paid = Math.round(p.pop * pv * (p.ratio < 1 ? 1.3 : 1));
      opt("negotiate", "按心理价买平安（" + p.paid + " 当量）", availableValue(state, cfg) >= p.paid, "可动用资源不足");
      opt("plunder", "武力夺取（需 M ≥ F）", p.M >= p.F, "战力不足");
      opt("retreat", "退出轨道（秩序 −1%）", true);
    } else if (p.type === "abandoned") {
      if (!p.techOk) {
        opt("orbit", "轨道级测绘（科技不足）", true);
        opt("retreat", "返回航线", true);
        return opts;
      }
      opt("eco", "接管生态舱（水培 +2~6，金属 −20）", num(state.stocks.metal) >= 20, "金属不足 20 吨");
      opt("seeds", "采集种源（粮产 +1~3%，26 周）", true);
      opt("scrap", "拆解残骸（金属 +80~160，耗时 +2 周）", true);
      opt("retreat", "不接触，返回航线", true);
    } else if (p.type === "ruins") {
      if (!p.techOk) {
        opt("observe", "在轨观测（低语减半）", true);
        opt("retreat", "返回航线", true);
        return opts;
      }
      opt("gift_tech", "带走技术残片（科技 +5%）", true);
      opt("gift_pop", "带走沉睡信众（人口）", freePods(state, cfg) > 0, "没有空舱位");
      opt("gift_res", "带走物资（金属 +150 / 药剂 +20）", true);
      opt("gift_gene", "带走基因样本（金属 +20 / 科技 +1%）", true);
      opt("retreat", "不取，返回航线", true);
    }
    return opts;
  }

  function planetView(state, cfg) {
    var e = ensurePlanets(state, cfg);
    var p = e.pending && e.pending.planet;
    if (!p) return null;
    var opts = p.result ? [] : planetOptions(state, cfg, p);
    return {
      id: p.id, type: p.type, label: PLANET_LABEL[p.type] || "未知行星",
      tier: p.tier, dwell: p.dwell, contacted: !!p.contacted, contactP: p.contactP,
      techOk: !!p.techOk, minTech: p.minTech, pop: p.pop,
      M: p.M, F: p.F, ratio: p.ratio, forced: p.forced || 0,
      dwellFood: p.dwellFood, dwellProp: p.dwellProp,
      paid: p.paid || 0, result: p.result, opts: opts,
      hint: p.type === "hostile"
        ? "敌对星球的接触概率与战力比决定选项：<0.5 当场吃亏；0.5–1 谈判加价 30%；>1 可抢。"
        : "接触概率由停留周数与科技决定；低于最低科技只能拿轨道级结果。"
    };
  }

  function planetResolve(state, cfg, sel) {
    var e = ensurePlanets(state, cfg);
    var p = e.pending && e.pending.planet;
    if (!p) return { ok: false, msg: "当前没有行星接触" };
    if (p.result) return { ok: false, msg: "这一颗已经结算" };
    var key = (sel && sel.opt) || "";
    var opts = planetOptions(state, cfg, p);
    var found = null;
    for (var i = 0; i < opts.length; i++) if (opts[i].key === key) found = opts[i];
    if (!found) return { ok: false, msg: "没有这个选项" };
    if (!found.ok) return { ok: false, msg: found.reason || "现在做不了" };

    var P = planetCfg(cfg), lines = [], kind = key;
    var hp = P.hostile || {}, AB = P.abandoned || {}, RU = P.ruins || {};

    if (key === "retreat") {
      if (p.type === "hostile") state.order = clamp(num(state.order) - 0.01, 0.05, 1);
      lines.push("选择：退回航线，不再接触");
      lines.push("消耗：粮 −" + p.dwellFood + " 吨、工质 −" + p.dwellProp + " 吨（停留 " + p.dwell + " 周）");
      lines.push("关系：无变化" + (p.type === "hostile" ? "；秩序 −1%" : ""));
    } else if (key === "orbit" || key === "observe") {
      var orderLoss = key === "observe" ? 0.01 * (1 + 0.5 * p.tier) : 0;
      if (orderLoss) {
        state.order = clamp(num(state.order) - orderLoss, 0.05, 1);
        addC(state, p.tier);
        lines.push("选择：在轨观测，不落地");
        lines.push("损失：秩序 −" + (orderLoss * 100).toFixed(1) + "%、感染 +" + p.tier);
        lines.push("得到：一段无法解读的信号记录（无实装收益）");
      } else {
        lines.push("选择：轨道级测绘，科技低于 " + Math.round(p.minTech * 100) + "%，无法落地");
        lines.push("得到：星表数据（无实装收益）");
        lines.push("关系：无变化");
      }
    } else if (key === "archive") {
      var tg = num((P.archiveTech || [0.02, 0.05])[0]) +
        randNext(state) * (num((P.archiveTech || [0.02, 0.05])[1]) - num((P.archiveTech || [0.02, 0.05])[0]));
      tg = Math.round(tg * 10000) / 10000;
      addTech(state, tg);
      lines.push("选择：进入殖民地档案库");
      lines.push("得到：科技 +" + (tg * 100).toFixed(2) + "%");
      lines.push("关系：无变化；停留消耗已扣");
      kind = "archive";
    } else if (key === "loot") {
      var mL = Math.round(num((P.loot || {}).metal[0]) + randNext(state) * (num((P.loot || {}).metal[1]) - num((P.loot || {}).metal[0])));
      var fL = Math.round(num((P.loot || {}).food[0]) + randNext(state) * (num((P.loot || {}).food[1]) - num((P.loot || {}).food[0])));
      addStock(state, cfg, "metal", mL); addStock(state, cfg, "food", fL);
      lines.push("选择：搜刮殖民地仓储");
      lines.push("得到：金属 +" + mL + " 吨、粮 +" + fL + " 吨");
      lines.push("关系：无变化");
    } else if (key === "survivors") {
      var pods = freePods(state, cfg);
      var want = Math.max(1, Math.round(p.pop * 0.25));
      var got = Math.min(want, pods);
      state.groups.derelict.awake += got;
      addC(state, 1);
      lines.push("选择：带走殖民地幸存者");
      lines.push("得到：遗民 +" + got + " 人（编入遗民组，清醒）；感染 +1");
      lines.push("关系：舱位剩 " + Math.max(0, pods - got) + "；" + (got < want ? "其余人留在原地" : "全部带走"));
    } else if (key === "negotiate" && p.type === "alien") {
      var payA = Math.round(p.pop * 20);
      var pa = payValue(state, cfg, payA);
      if (!pa.ok) return { ok: false, msg: "资源不足，差 " + pa.short };
      var techA = num(P.alienTech, 0.03);
      addTech(state, techA);
      var podsA = freePods(state, cfg);
      var popA = Math.min(Math.max(1, Math.round(p.pop * 0.1)), podsA);
      if (popA > 0) state.groups.derelict.awake += popA;
      lines.push("付出：" + Object.keys(pa.spent).map(function (k) {
        return ({ metal: "金属", food: "粮", drug: "药剂", water: "水" }[k] || k) + " −" + pa.spent[k];
      }).join("、"));
      lines.push("得到：科技 +" + (techA * 100).toFixed(1) + "%、外来人口 +" + popA + " 人");
      lines.push("关系：建立了第一次接触；停留消耗已扣");
    } else if (key === "negotiate" && p.type === "hostile") {
      var payH = payValue(state, cfg, p.paid);
      if (!payH.ok) return { ok: false, msg: "资源不足，差 " + payH.short };
      addTech(state, 0.01);
      state.order = clamp(num(state.order) + 0.01, 0, 1);
      lines.push("付出：" + Object.keys(payH.spent).map(function (k) {
        return ({ metal: "金属", food: "粮", drug: "药剂", water: "水" }[k] || k) + " −" + payH.spent[k];
      }).join("、") + "（心理价 " + p.paid + "）");
      lines.push("得到：航线情报，科技 +1%、秩序 +1%");
      lines.push("关系：对方收钱放行，不结仇；停留消耗已扣");
    } else if (key === "techswap") {
      var costA = Math.round(num((P.alienMetal || [60, 120])[0]) +
        randNext(state) * (num((P.alienMetal || [60, 120])[1]) - num((P.alienMetal || [60, 120])[0])));
      if (num(state.stocks.metal) < costA) return { ok: false, msg: "金属不足 " + costA + " 吨" };
      addStock(state, cfg, "metal", -costA);
      addTech(state, 0.03);
      lines.push("付出：金属 −" + costA + " 吨");
      lines.push("得到：科技 +3%");
      lines.push("关系：等价交换，无附加");
    } else if (key === "refuse") {
      state.order = clamp(num(state.order) + 0.01, 0, 1);
      lines.push("选择：婉拒接触，保持距离");
      lines.push("得到：无；秩序 +1%");
      lines.push("关系：对方没有强留");
    } else if (key === "plunder") {
      if (p.M < p.F) return { ok: false, msg: "战力不足" };
      var mt = Math.round(p.pop * num(hp.popValueSmall, 3) * 2);
      var dm = Math.round(mt * 0.4), df = Math.round(mt * 0.2), dd = Math.round(mt * 0.2);
      var dp = Math.min(Math.round(mt * 0.1 / 3), freePods(state, cfg));
      addStock(state, cfg, "metal", dm); addStock(state, cfg, "food", df); addStock(state, cfg, "drug", dd);
      if (dp > 0) state.groups.derelict.dormant += dp;
      addTech(state, 0.01);
      state.order = clamp(num(state.order) - 0.03, 0.05, 1);
      addC(state, 2);
      lines.push("选择：武力夺取（M " + p.M + " ≥ F " + p.F + "）");
      lines.push("得到：金属 +" + dm + " 吨、粮 +" + df + " 吨、药剂 +" + dd + " 份、休眠俘获 +" + dp + " 人、科技 +1%");
      lines.push("关系：秩序 −3%、感染 +2");
    } else if (key === "eco") {
      var units = Math.round(num((AB.hydroUnits || [2, 6])[0]) +
        randNext(state) * (num((AB.hydroUnits || [2, 6])[1]) - num((AB.hydroUnits || [2, 6])[0])));
      addStock(state, cfg, "metal", -num(AB.hydroMetal, 20));
      state.infra.hydro = num(state.infra.hydro) + units;
      lines.push("付出：金属 −" + num(AB.hydroMetal, 20) + " 吨");
      lines.push("得到：水培单元 +" + units);
      lines.push("关系：生态舱并入本舰");
    } else if (key === "seeds") {
      var pct = num((AB.seedPct || [0.01, 0.03])[0]) +
        randNext(state) * (num((AB.seedPct || [0.01, 0.03])[1]) - num((AB.seedPct || [0.01, 0.03])[0]));
      pct = Math.round(pct * 1000) / 1000;
      if (!state.encounter.foodBonus) state.encounter.foodBonus = null;
      state.encounter.foodBonus = { mul: 1 + pct, until: state.weeks + num(AB.seedWeeks, 26) };
      lines.push("选择：采集原生种源");
      lines.push("得到：粮食产出 +" + (pct * 100).toFixed(1) + "%，持续 " + num(AB.seedWeeks, 26) + " 周");
      lines.push("关系：无变化");
    } else if (key === "scrap") {
      var sm = Math.round(num((AB.scrapMetal || [80, 160])[0]) +
        randNext(state) * (num((AB.scrapMetal || [80, 160])[1]) - num((AB.scrapMetal || [80, 160])[0])));
      addStock(state, cfg, "metal", sm);
      state.weeks += num(AB.scrapWeeks, 2);
      lines.push("选择：拆解废弃星残骸");
      lines.push("得到：金属 +" + sm + " 吨");
      lines.push("代价：拆解耗时 " + num(AB.scrapWeeks, 2) + " 周（航行周已前移）");
    } else if (key.indexOf("gift_") === 0) {
      var whisper = (num(RU.whisperBase, 0.8) + num(RU.whisperTier, 0.4) * p.tier) * p.dwell;
      var mind = Math.round(whisper * 10) / 10;
      var ord = Math.round(whisper * 0.01 * 1000) / 1000;
      state.order = clamp(num(state.order) - ord, 0.05, 1);
      addC(state, 1 + p.tier);
      if (key === "gift_tech") {
        addTech(state, num(RU.techGain, 0.05));
        lines.push("得到：科技 +" + (num(RU.techGain, 0.05) * 100).toFixed(1) + "%");
      } else if (key === "gift_pop") {
        var rg2 = RU.popRange || [40, 100];
        var n2 = Math.round(num(rg2[0]) + randNext(state) * (num(rg2[1]) - num(rg2[0])));
        n2 = Math.min(n2, freePods(state, cfg));
        state.groups.derelict.dormant += n2;
        lines.push("得到：沉睡信众 +" + n2 + " 人（休眠）");
      } else if (key === "gift_res") {
        addStock(state, cfg, "metal", num(RU.metal, 150));
        addStock(state, cfg, "drug", num(RU.drug, 20));
        lines.push("得到：金属 +" + num(RU.metal, 150) + " 吨、药剂 +" + num(RU.drug, 20) + " 份");
      } else {
        addStock(state, cfg, "metal", 20);
        addTech(state, 0.01);
        lines.push("得到：基因样本（金属 +20 吨、科技 +1%）");
      }
      lines.push("代价：低语 " + mind + "，秩序 −" + (ord * 100).toFixed(1) + "%、感染 +" + (1 + p.tier));
      lines.unshift("选择：进入遗迹取走一件");
    }

    p.result = { kind: kind, lines: lines };
    pushEvent(state, cfg, "planet", "行星接触", PLANET_LABEL[p.type] + " · " + lines[0],
      lines[1] || "", "接触概率 " + Math.round(p.contactP * 100) + "% / 停留 " + p.dwell + " 周",
      true, null, "同类行星的接触判定沿用同一套公式");
    return { ok: true, msg: lines.join("；"), result: p.result, planet: planetView(state, cfg) };
  }

  function planetClose(state, cfg, opts) {
    opts = opts || {};
    var e = ensurePlanets(state, cfg);
    if (!e.pending) return { ok: false, msg: "当前没有待结算的奇遇" };
    var p = e.pending.planet;
    e.history.push({
      year: e.pending.year, cat: e.pending.cat,
      cardId: p ? "pl_" + p.type : "planet", cardName: p ? (PLANET_LABEL[p.type] || "行星") : "行星",
      rarity: p ? (PLANET_RARITY[p.type] || "rare") : "rare", choice: 0,
      sub: p && p.result ? p.result.kind : "passed",
      week: state.weeks, auto: !!opts.auto
    });
    var cap = num((cfg.encounter || {}).historyCap, 200);
    if (e.history.length > cap) e.history.shift();
    e.pending = null;
    return { ok: true, msg: "", encounter: brief(state, cfg) };
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
        auto: !!e.pending.auto,
        derelict: e.pending.derelict ? derelictView(state, cfg) : null,
        planet: e.pending.planet ? planetView(state, cfg) : null,
        negotiation: state.negotiation && state.negotiation.cp ? negotiationView(state, cfg) : null,
        mortgage: e.pending.cards && e.pending.cards.some(function (c) { return c.id === "tr_gene_mortgage"; })
          ? mortgageView(state, cfg) : null
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
    gapOutcome: gapOutcome,
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
    rarities: RARITY_RANK,
    derelictResolve: derelictResolve,
    derelictClose: derelictClose,
    derelictView: derelictView,
    // 五类行星（v6.31）
    ensurePlanets: ensurePlanets,
    rollPlanet: rollPlanet,
    planetView: planetView,
    planetResolve: planetResolve,
    planetClose: planetClose,
    // 谈判 / 基因抵押（v6.30）
    negotiationView: negotiationView,
    negotiationResolve: negotiationResolve,
    negotiationClose: negotiationClose,
    mortgageView: mortgageView,
    mortgageStart: mortgageStart,
    mortgageRedeem: function (state, cfg) { return mortgageSettle(state, cfg, true); },
    mortgageClose: mortgageClose,
    mortgageTick: mortgageTick,
    ensureTrade: ensureTrade
  };

  global.XuanShuEncounter = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : global);
