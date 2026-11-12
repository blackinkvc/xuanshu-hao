/* =========================================================================
   玄枢号 · 古神契约（sim-gods.js）
   -------------------------------------------------------------------------
   四位古神：缄默之喉 / 赤织母 / 星启者 / 丰穰之腹。
   state.gods 跨轮保留：契约、主约/旁约、神恩、祝福/诅咒、周期索取、神噬。
   随机只走 state.rngA。
   ========================================================================= */
(function (global) {
  "use strict";

  var VERSION = "1.0.0";
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
    state.events.push(entry);
    if (state.events.length > cfg.time.eventCap) state.events.shift();
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
      mods: []
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
      g.pacts[old].favor = clamp(num(g.pacts[old].favor) - 20, -100, 100);
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
    rec.favor = clamp(before + num(v), -100, 100);
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
        var lost = removePop(state, Math.max(1, Math.round(total * 0.01)));
        if (lost) pushEvent(state, cfg, "缄默之喉 · 人口流失", "古神饿了，吞掉 " + lost + " 人。", "诅咒",
          { "人口": -lost }, "每十年少一批人");
      }
      if (id === "weaver") {
        var dep = randomDept(state, cfg);
        if (dep) {
          ((soc.queues) || []).forEach(function (q) {
            if (q.dept === dep && (q.layer === "L2" || q.layer === "L3")) q.S = clamp(num(q.S) + 0.10, 0, 1);
          });
          pushEvent(state, cfg, "赤织母 · 部门失序", dep + "的人更不服管了。", "诅咒",
            { "秩序": -3 }, "一个部门开始顶牛");
        }
      }
    }
    if (rec.cursed && id === "fecund") {
      if (randNext(state) < 0.10) {
        ((soc.queues) || []).forEach(function (q) { q.C = clamp(num(q.C) + 2, 0, 100); });
        var d2 = removePop(state, 5);
        pushEvent(state, cfg, "丰穰之腹 · 畸变", "克隆体畸变，感染加重，死了 " + d2 + " 人。", "诅咒",
          { "人口": -d2, "感染": 2 }, "克隆槽里出了怪胎");
      }
    }
  }

  /* ---------------- 周期索取 ---------------- */

  function mawTithe(state, cfg, now) {
    var total = 0;
    Object.keys(state.groups || {}).forEach(function (k) { total += num(state.groups[k].awake); });
    var need = Math.max(8, Math.round(total * 0.008));
    var lost = removePop(state, need);
    pushEvent(state, cfg, "缄默之喉 · 吞食", "古神又饿了，吞下 " + lost + " 人。", "周期索取",
      { "人口": -lost }, "这条船定期要交人");
    return lost;
  }

  function starTithe(state, cfg) {
    if (randNext(state) < 0.5) {
      state.order = clamp(num(state.order) - 0.05, 0.05, 1);
      pushEvent(state, cfg, "星启者 · 知识代价", "星启者带走一部分知识，秩序 −5%。", "周期索取",
        { "秩序": -5 }, "知道得越多，越难管");
    } else {
      state.stocks.drug = Math.max(0, num(state.stocks.drug) - 40);
      pushEvent(state, cfg, "星启者 · 知识代价", "星启者拿走了 40 份休眠药剂。", "周期索取",
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
        ((soc.queues) || []).forEach(function (q) { q.C = clamp(num(q.C) + num(T.refuseC, 4), 0, 100); });
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

      // 周期索取
      var every = num(it.titheEveryYears, 0);
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
        soc.machine.A = clamp(num(soc.machine.A) + 0.02, 0, 1);
      }
      applyAnnualBlessCurse(state, cfg, id, now);
    });

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
      if (key === "foodUse" && id === "fecund") out *= 1.08;
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
    return 1 + (rec.primary ? 0.5 : 0.25);
  }

  function rarityBoost(state, cfg, cat) {
    var g = state.gods;
    if (!g || !g.enabled || g.legacy) return 0;
    var rec = g.pacts.star;
    if (cat === "tech" && rec && rec.pact && rec.blessed) return 1;
    return 0;
  }

  function brief(state, cfg) {
    var g = ensure(state, cfg);
    var now = absYear(state, cfg);
    var list = IDS.map(function (id) {
      var it = item(cfg, id);
      var rec = g.pacts[id];
      var every = num(it.titheEveryYears, 0);
      return {
        id: id,
        name: it.name || NAMES[id],
        lean: it.lean || "",
        pact: !!rec.pact,
        primary: !!rec.primary,
        favor: Math.round(num(rec.favor)),
        blessed: !!rec.blessed,
        cursed: !!rec.cursed,
        since: Math.round(num(rec.since)),
        nextTitheIn: rec.pact && every > 0
          ? Math.max(0, Math.ceil(every - (now - num(rec.lastTithe, now)))) : null
      };
    });
    return {
      version: VERSION,
      enabled: !!g.enabled && !g.legacy,
      legacy: !!g.legacy,
      primary: primaryOf(state, cfg),
      devour: Math.round(num(g.devour) * 10) / 10,
      devourCap: num(cfg.gods.devourCap, 100),
      pacts: list,
      pendingTithe: g.pendingTithe,
      history: (g.history || []).slice(-20)
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
    yearly: yearly,
    afterCard: afterCard,
    resolveTithe: resolveTithe,
    brief: brief,
    isBlessed: isBlessed,
    isCursed: isCursed,
    gMul: gMul,
    pregnancyMul: pregnancyMul,
    rarityBoost: rarityBoost,
    names: NAMES,
    ids: IDS
  };

  global.XuanShuGods = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : global);
