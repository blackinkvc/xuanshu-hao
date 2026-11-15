/*
  玄枢号 · 商栈与掠夺（sim-trade.js）
  ---------------------------------------------------------------------------
  第四波：十种商船 / 商业空间站兑换 / 基础换算 / 三槽随机出货 / 星图 /
  古神雕像 / 买卖舰员与克隆人 / 买卖休眠者 / 掠夺三档 / 伪装海盗。

  纯函数式挂在 global.XuanShuTrade 上，状态存 state.trade，seed 决定出货。
  不接管时间推进，不改主结算；所有收益与代价都写回既有 stocks / groups / order。
*/
(function (global) {
  "use strict";

  function num(v, d) {
    return typeof v === "number" && isFinite(v) ? v : (typeof d === "number" ? d : 0);
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function h32(x) {
    x = x >>> 0;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x;
  }
  function mix(a, b) { return h32((a >>> 0) ^ Math.imul(b >>> 0, 0x9E3779B1)); }
  function rnd(t, salt) {
    return mix(mix(t.salt >>> 0, (t.visits + 1) | 0), (salt + 7) | 0) / 4294967296;
  }
  function pickN(t, salt, lo, hi) {
    return Math.round(lo + (hi - lo) * rnd(t, salt));
  }

  /* 货类：单位、基础单价（金属吨 / 单位）、单槽数量区间 */
  var GOODS = {
    food:    { name: "粮",       unit: "吨", uv: 0.5, qty: [200, 900] },
    water:   { name: "淡水",     unit: "吨", uv: 0.5, qty: [200, 900] },
    metal:   { name: "金属",     unit: "吨", uv: 1.0, qty: [30, 180] },
    drug:    { name: "药剂",     unit: "份", uv: 2.0, qty: [20, 120] },
    pop:     { name: "醒态人口", unit: "人", uv: 1.5, qty: [40, 200] },
    clone:   { name: "克隆人",   unit: "人", uv: 0.9, qty: [20, 100] },
    dormant: { name: "休眠者",   unit: "人", uv: 0.8, qty: [20, 120] },
    statue:  { name: "古神雕像", unit: "座", uv: 400, qty: [1, 3] }
  };

  /* 十种商船：goods 是货架可能出现的货类，k 是价格系数 */
  var SHIPS = [
    { id: "grain",   name: "粮商驳船",   goods: ["food", "water"], k: 0.55, risk: "低" },
    { id: "metal",   name: "金属回收船", goods: ["metal", "drug"], k: 0.90, risk: "低" },
    { id: "drug",    name: "药剂冷链船", goods: ["drug", "water"], k: 1.60, risk: "中" },
    { id: "people",  name: "奴隶运输船", goods: ["pop", "dormant"], k: 1.20, risk: "中" },
    { id: "clone",   name: "克隆船",     goods: ["clone", "drug"], k: 0.70, risk: "低" },
    { id: "relic",   name: "古物贩子",   goods: ["statue", "metal"], k: 2.20, risk: "中" },
    { id: "arms",    name: "军火贩子",   goods: ["metal", "food"], k: 1.30, risk: "高" },
    { id: "intel",   name: "情报船",     goods: ["drug", "metal"], k: 1.50, risk: "中" },
    { id: "station", name: "商业空间站", goods: ["food", "water", "metal", "drug", "pop", "dormant", "statue"], k: 1.00, risk: "安全" },
    { id: "pirate",  name: "海盗船",     goods: ["metal", "drug", "food"], k: 0.85, risk: "极高" }
  ];

  /* 星图：五个常去节点，只做导航与货类提示，不消耗游戏时间 */
  var STARS = [
    { id: "agri",    name: "粮区",     weeks: 3, risk: "低",   goods: "粮 / 淡水" },
    { id: "mine",    name: "矿区",     weeks: 4, risk: "低",   goods: "金属 / 药剂" },
    { id: "pharm",   name: "药区",     weeks: 5, risk: "中",   goods: "药剂 / 淡水" },
    { id: "slave",   name: "奴隶港",   weeks: 6, risk: "中",   goods: "醒态人口 / 休眠者" },
    { id: "station", name: "商业空间站", weeks: 8, risk: "安全", goods: "全货类 / 雕像" }
  ];

  function ensure(state) {
    if (!state.trade || typeof state.trade !== "object") state.trade = {};
    var t = state.trade;
    if (typeof t.salt !== "number") t.salt = (num(state.rngA, 20260101) >>> 0);
    ["visits", "rep", "heat", "statues"].forEach(function (k) {
      if (typeof t[k] !== "number") t[k] = k === "rep" ? 50 : 0;
    });
    if (!t.stats || typeof t.stats !== "object") t.stats = { buy: 0, sell: 0, raid: 0 };
    if (t.offer === undefined) t.offer = null;
    if (!Array.isArray(t.lines)) t.lines = [];
    return t;
  }

  function pushLine(t, text) {
    t.lines.unshift(text);
    if (t.lines.length > 6) t.lines.length = 6;
  }

  function roll(state, cfg) {
    var t = ensure(state);
    var r0 = rnd(t, 0);
    var ship;
    if (r0 < 0.08) ship = SHIPS[8];
    else if (r0 < 0.18) ship = SHIPS[9];
    else ship = SHIPS[Math.floor(rnd(t, 1) * 8) % 8];
    var slots = [];
    // v6.57 魅力消费点二：主角魅力影响交涉折让（±6%），买卖同价口径
    var pc = state.player && state.player.pc;
    var charm = clamp(num(pc && pc.charm, 52) + num(pc && pc.will, 0) * 0.15, 0, 100);
    var charmMul = clamp(1 - (charm - 50) * 0.0012, 0.92, 1.08);
    for (var i = 0; i < 3; i++) {
      var gid = ship.goods[Math.floor(rnd(t, 10 + i * 3) * ship.goods.length) % ship.goods.length];
      var g = GOODS[gid];
      var qty = pickN(t, 20 + i * 3, g.qty[0], g.qty[1]);
      var greed = 1 + (rnd(t, 30 + i) - 0.5) * 0.3;
      var heatMul = 1 + num(t.heat, 0) * 0.004;
      var repMul = 1 - (num(t.rep, 50) - 50) * 0.002;
      var price = Math.max(1, Math.round(qty * g.uv * ship.k * greed * heatMul * repMul * charmMul));
      slots.push({ good: gid, name: g.name, unit: g.unit, qty: qty, price: price });
    }
    t.offer = { ship: ship.id, shipName: ship.name, risk: ship.risk, slots: slots,
      charm: Math.round(charm), charmMul: Math.round(charmMul * 1000) / 1000,
      at: num(state.weeks, 0) };
    t.visits += 1;
    return t.offer;
  }

  function addStock(state, good, n) {
    state.stocks = state.stocks || {};
    state.stocks[good] = Math.max(0, num(state.stocks[good], 0) + n);
  }
  function takeStock(state, good, n) {
    var have = Math.max(0, num(state.stocks && state.stocks[good], 0));
    var take = Math.min(have, n);
    state.stocks[good] = have - take;
    return take;
  }
  function freePods(state) {
    var dormant = 0;
    var groups = state.groups || {};
    Object.keys(groups).forEach(function (k) { dormant += Math.max(0, num(groups[k].dormant, 0)); });
    return Math.max(0, Math.floor(num(state.infra && state.infra.pods, 0) - dormant));
  }
  function addPeople(state, kind, n) {
    var groups = state.groups || {};
    if (kind === "clone") {
      if (!groups.clone) return 0;
      groups.clone.awake = Math.max(0, num(groups.clone.awake, 0) + n);
      return n;
    }
    var gid = groups.undecided ? "undecided" : (groups.service ? "service" : null);
    if (!gid) return 0;
    if (kind === "dormant") groups[gid].dormant = Math.max(0, num(groups[gid].dormant, 0) + n);
    else groups[gid].awake = Math.max(0, num(groups[gid].awake, 0) + n);
    return n;
  }
  function takePeople(state, kind, n) {
    var order = ["undecided", "service", "medical", "tech", "combat", "noble", "clone"];
    var left = n;
    for (var i = 0; i < order.length && left > 0; i++) {
      var g = state.groups && state.groups[order[i]];
      if (!g) continue;
      var key = kind === "dormant" ? "dormant" : "awake";
      var take = Math.min(left, Math.max(0, num(g[key], 0)));
      g[key] = num(g[key], 0) - take;
      left -= take;
    }
    return n - left;
  }

  function deal(state, cfg, p) {
    var t = ensure(state);
    var o = t.offer;
    if (!o) return { ok: false, msg: "先叫一艘商船" };
    var i = Math.floor(num(p && p.slot, -1));
    var slot = o.slots[i];
    if (!slot) return { ok: false, msg: "没有这个货槽" };
    var mode = (p && p.mode) === "sell" ? "sell" : "buy";
    var g = GOODS[slot.good];
    if (mode === "buy") {
      var price = Math.max(1, Math.round(slot.price * 1.15)); // 买价 = 挂牌价 × 1.15（含泊位费）
      if (num(state.stocks && state.stocks.metal, 0) < price) {
        return { ok: false, msg: "金属不足：需要 " + price + " 吨，库存 " + Math.round(num(state.stocks && state.stocks.metal, 0)) + " 吨" };
      }
      if (slot.good === "pop" || slot.good === "clone" || slot.good === "dormant") {
        if (slot.good === "dormant" && freePods(state) < slot.qty) {
          return { ok: false, msg: "休眠舱余位不足：需要 " + slot.qty + "，余 " + freePods(state) };
        }
        addPeople(state, slot.good, slot.qty);
      } else if (slot.good === "statue") {
        t.statues = Math.max(0, num(t.statues, 0) + slot.qty);
      } else {
        addStock(state, slot.good, slot.qty);
      }
      state.stocks.metal = Math.max(0, num(state.stocks.metal, 0) - price);
      t.rep = clamp(num(t.rep, 50) + 1, 0, 100);
      t.stats.buy += 1;
      var line = "买入 " + slot.name + " " + slot.qty + " " + g.unit + "，付 " + price + " 吨金属";
      pushLine(t, line);
      return { ok: true, msg: line, lines: t.lines.slice() };
    }
    // 卖：按库存上限成交，回收价 = 挂牌价 × 0.8
    var qty = slot.qty;
    var got = 0;
    if (slot.good === "pop" || slot.good === "clone" || slot.good === "dormant") {
      var moral = num(state.morality, 60);
      if (moral < 30) return { ok: false, msg: "道德值低于 30，舰员拒绝卖人" };
      got = takePeople(state, slot.good, qty);
      state.morality = clamp(moral - clamp(2 + got / 20, 2, 10), 0, 100);
      state.order = clamp(num(state.order, 1) - 0.01, 0, 1);
    } else if (slot.good === "statue") {
      got = Math.min(qty, Math.floor(num(t.statues, 0)));
      t.statues = Math.max(0, num(t.statues, 0) - got);
    } else {
      got = takeStock(state, slot.good, qty);
    }
    if (got <= 0) return { ok: false, msg: "库存不够，卖不出去" };
    var gain = Math.max(1, Math.round(got * slot.price / slot.qty * 0.8));
    addStock(state, "metal", gain);
    t.rep = clamp(num(t.rep, 50) + 0.5, 0, 100);
    t.stats.sell += 1;
    var line2 = "卖出 " + slot.name + " " + got + " " + g.unit + "，得 " + gain + " 吨金属";
    pushLine(t, line2);
    return { ok: true, msg: line2, lines: t.lines.slice() };
  }

  var RAID = [
    { tier: 1, name: "一档 · 货舱", metal: [40, 80], food: [20, 40], order: 0.02, heat: 8, rep: 3 },
    { tier: 2, name: "二档 · 商船", metal: [90, 160], food: [40, 90], order: 0.04, heat: 18, rep: 7, lossP: 0.30 },
    { tier: 3, name: "三档 · 空间站", metal: [180, 320], food: [80, 160], order: 0.08, heat: 35, rep: 12, needCombat: 20 }
  ];

  function raid(state, cfg, p) {
    var t = ensure(state);
    ensure(state);
    var tier = Math.max(1, Math.min(3, Math.floor(num(p && p.tier, 1))));
    var R = RAID[tier - 1];
    var combat = Math.max(0, num(state.groups && state.groups.combat && state.groups.combat.awake, 0));
    if (tier === 3 && combat < R.needCombat) {
      state.ship.structure = Math.max(0, num(state.ship && state.ship.structure, 0) - 2);
      state.order = clamp(num(state.order, 1) - 0.03, 0, 1);
      t.heat = clamp(num(t.heat, 0) + 12, 0, 100);
      var fail = "三档失败：战斗编制 " + Math.round(combat) + " < " + R.needCombat + "，结构 −2、秩序 −3%、热度 +12";
      pushLine(t, fail);
      return { ok: false, msg: fail, lines: t.lines.slice() };
    }
    var mGain = pickN(t, 40 + tier, R.metal[0], R.metal[1]);
    var fGain = pickN(t, 50 + tier, R.food[0], R.food[1]);
    addStock(state, "metal", mGain);
    addStock(state, "food", fGain);
    if (tier === 2 && rnd(t, 60) < R.lossP) {
      var lost = takePeople(state, "awake", pickN(t, 61, 2, 6));
      if (lost > 0) pushLine(t, "交火减员 " + lost + " 人");
    }
    if (tier === 3 && rnd(t, 62) < 0.2) {
      t.statues = Math.max(0, num(t.statues, 0) + 1);
    }
    state.order = clamp(num(state.order, 1) - R.order, 0, 1);
    t.heat = clamp(num(t.heat, 0) + R.heat, 0, 100);
    t.rep = clamp(num(t.rep, 50) - R.rep, 0, 100);
    t.stats.raid += 1;
    var line = "掠夺 " + R.name + "：金属 +" + mGain + "、粮 +" + fGain + "，秩序 −" + Math.round(R.order * 100) + "%、热度 +" + R.heat;
    pushLine(t, line);
    return { ok: true, msg: line, lines: t.lines.slice() };
  }

  function disguise(state, cfg) {
    var t = ensure(state);
    if (num(t.heat, 0) <= 0) return { ok: false, msg: "热度已经是 0，无需伪装" };
    var useStatue = num(t.statues, 0) >= 1;
    if (!useStatue && num(state.stocks && state.stocks.drug, 0) < 20) {
      return { ok: false, msg: "伪装需要 1 座雕像或 20 份药剂" };
    }
    if (useStatue) t.statues = num(t.statues, 0) - 1;
    else state.stocks.drug = num(state.stocks.drug, 0) - 20;
    var before = num(t.heat, 0);
    t.heat = clamp(before - 25, 0, 100);
    var line = "伪装海盗：" + (useStatue ? "耗 1 座雕像" : "耗 20 份药剂") + "，热度 " + Math.round(before) + " → " + Math.round(t.heat);
    pushLine(t, line);
    return { ok: true, msg: line, lines: t.lines.slice() };
  }

  var PEOPLE_PRICE = {
    awake: { buy: 30, sell: 12, name: "舰员" },
    dormant: { buy: 8, sell: 5, name: "休眠者" },
    clone: { buy: 12, sell: 6, name: "克隆人" }
  };

  function people(state, cfg, p) {
    var t = ensure(state);
    var kind = (p && p.kind) || "awake";
    var P = PEOPLE_PRICE[kind] || PEOPLE_PRICE.awake;
    var n = Math.max(1, Math.floor(num(p && p.n, 1)));
    var dir = (p && p.dir) === "sell" ? "sell" : "buy";
    if (dir === "buy") {
      if (kind === "dormant" && freePods(state) < n) {
        return { ok: false, msg: "休眠舱余位不足：需要 " + n + "，余 " + freePods(state) };
      }
      var cost = n * P.buy;
      if (num(state.stocks && state.stocks.metal, 0) < cost) {
        return { ok: false, msg: "金属不足：需要 " + cost + " 吨，库存 " + Math.round(num(state.stocks && state.stocks.metal, 0)) + " 吨" };
      }
      var got = addPeople(state, kind, n);
      if (got <= 0) return { ok: false, msg: "没有可接收的分组" };
      state.stocks.metal = Math.max(0, num(state.stocks.metal, 0) - cost);
      var line = "买入" + P.name + " " + got + " 人，付 " + cost + " 吨金属";
      pushLine(t, line);
      return { ok: true, msg: line, lines: t.lines.slice() };
    }
    var moral = num(state.morality, 60);
    if (moral < 30) return { ok: false, msg: "道德值低于 30，拒绝卖人" };
    var sold = takePeople(state, kind, n);
    if (sold <= 0) return { ok: false, msg: "没有可卖的" + P.name };
    var gain = sold * P.sell;
    addStock(state, "metal", gain);
    state.morality = clamp(moral - clamp(2 + sold / 20, 2, 10), 0, 100);
    state.order = clamp(num(state.order, 1) - 0.01, 0, 1);
    var line2 = "卖出" + P.name + " " + sold + " 人，得 " + gain + " 吨金属，道德 −" + Math.round(clamp(2 + sold / 20, 2, 10));
    pushLine(t, line2);
    return { ok: true, msg: line2, lines: t.lines.slice() };
  }

  function statue(state, cfg, p) {
    var t = ensure(state);
    if (num(t.statues, 0) < 1) return { ok: false, msg: "没有古神雕像" };
    var use = (p && p.use) || "tech";
    if (use === "enshrine") {
      // 供奉：按累计供奉座数分低/中/高三档，效果随档递增
      var TIERS = [
        { name: "低档", infect: 2, order: 0.01, god: 0.08, tech: 0 },
        { name: "中档", infect: 4, order: 0.02, god: 0.14, tech: 0 },
        { name: "高档", infect: 6, order: 0.03, god: 0.20, tech: 0.02 }
      ];
      var tier = Math.min(3, num(t.enshrined, 0) + 1);
      var D = TIERS[tier - 1];
      t.statues = num(t.statues, 0) - 1;
      t.enshrined = tier;
      t.statueTier = tier;
      t.statueTierName = D.name;
      if (state.society && state.society.infection) {
        state.society.infection.share = Math.max(0, num(state.society.infection.share, 0) - D.infect / 100);
      }
      state.order = clamp(num(state.order, 1) + D.order, 0, 1);
      if (D.tech > 0 && state.society && state.society.machine) {
        state.society.machine.tech = num(state.society.machine.tech, 0) + D.tech;
      }
      if (!state.encounter) state.encounter = { mods: [] };
      if (!state.encounter.mods) state.encounter.mods = [];
      state.encounter.mods.push({
        key: "encounter.oldgod", v: D.god, until: state.weeks + 5200, weeks: 5200,
        mul: false, cardId: "statue"
      });
      var le = "供奉 1 座古神雕像（" + D.name + "）：感染 −" + D.infect + "、秩序 +" +
        Math.round(D.order * 100) + "%" + (D.tech ? "、科技 +" + Math.round(D.tech * 100) + " 点" : "") +
        "，100 年内遇古神概率 +" + D.god.toFixed(2);
      pushLine(t, le);
      return { ok: true, msg: le, lines: t.lines.slice() };
    }
    t.statues = num(t.statues, 0) - 1;
    if (use === "tech") {
      if (state.society && state.society.machine) {
        state.society.machine.tech = num(state.society.machine.tech, 0) + 0.05;
      }
      var l1 = "拆解 1 座雕像：科技 +5 点";
      pushLine(t, l1);
      return { ok: true, msg: l1, lines: t.lines.slice() };
    }
    addStock(state, "metal", 120);
    var l2 = "卖出 1 座雕像：金属 +120 吨";
    pushLine(t, l2);
    return { ok: true, msg: l2, lines: t.lines.slice() };
  }

  function brief(state, cfg) {
    var t = ensure(state);
    return {
      ok: true,
      rep: Math.round(num(t.rep, 50)),
      heat: Math.round(num(t.heat, 0)),
      statues: Math.round(num(t.statues, 0)),
      enshrined: Math.round(num(t.enshrined, 0)),
      statueTier: Math.round(num(t.statueTier, 0)),
      statueTierName: t.statueTierName || "",
      visits: Math.round(num(t.visits, 0)),
      offer: t.offer,
      lines: t.lines.slice(),
      ships: SHIPS.map(function (s) { return { id: s.id, name: s.name, risk: s.risk, goods: s.goods.slice() }; }),
      stars: STARS.slice(),
      units: Object.keys(GOODS).map(function (k) { return { id: k, name: GOODS[k].name, unit: GOODS[k].unit, uv: GOODS[k].uv }; }),
      price: PEOPLE_PRICE
    };
  }

  global.XuanShuTrade = {
    ensure: ensure,
    brief: brief,
    roll: roll,
    deal: deal,
    raid: raid,
    disguise: disguise,
    people: people,
    statue: statue,
    GOODS: GOODS,
    SHIPS: SHIPS,
    STARS: STARS
  };
})(typeof window !== "undefined" ? window : global);
