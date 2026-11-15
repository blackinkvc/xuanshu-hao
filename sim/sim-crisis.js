/* =========================================================================
   玄枢号 · 常驻危机体系（v1.0.0）
   -------------------------------------------------------------------------
   与奇遇牌库分开：危机不是抽牌，而是船上参数跨过阈值后挂上的常驻状态。
   - 触发：每周（默认每 2 周）扫描 crisisStanding.defs[].trigger
   - 常驻：未处理前卡片一直在，debuff 每周生效
   - 处理：主选项 → 二级子项（互斥/多选）→ 同页结算
   - 解除：从 active 移除并写 cooldown；「暂缓」类选项保留卡片但暂时压住 debuff
   所有数值都来自 sim-config.js 的 crisisStanding，本文件只做通用结算。
   ========================================================================= */
(function (global) {
  "use strict";

  var VERSION = "1.0.0";

  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function cfgOf(cfg) { return (cfg && cfg.crisisStanding) || null; }
  function defsOf(cfg) { var c = cfgOf(cfg); return (c && c.defs) || []; }

  function findDef(cfg, id) {
    var list = defsOf(cfg);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function blank() {
    return {
      active: [],
      cooldown: {},
      buffs: [],
      history: [],
      resolved: 0,
      lastEval: -1
    };
  }

  function create(cfg) { return blank(); }

  function ensure(state, cfg) {
    if (!state.crisis || typeof state.crisis !== "object") state.crisis = blank();
    var C = state.crisis;
    if (!Array.isArray(C.active)) C.active = [];
    if (!Array.isArray(C.buffs)) C.buffs = [];
    if (!Array.isArray(C.history)) C.history = [];
    if (!C.cooldown || typeof C.cooldown !== "object") C.cooldown = {};
    if (!isNum(C.resolved)) C.resolved = 0;
    if (!isNum(C.lastEval)) C.lastEval = -1;
    // 丢掉配置里已经不存在的危机，避免旧档卡死
    C.active = C.active.filter(function (a) { return !!findDef(cfg, a.id); });
    return C;
  }

  function isQuiet(state, a) {
    return isNum(a.quietUntil) && state.weeks < a.quietUntil;
  }

  /* ---------------- 触发判定 ---------------- */

  function hit(state, cfg, tr) {
    if (!tr) return false;
    var soc = state.society;
    if (isNum(tr.orderBelow) && isNum(state.order) && state.order < tr.orderBelow) return true;
    if (isNum(tr.structureBelow) && state.ship && isNum(state.ship.structure) &&
      state.ship.structure < tr.structureBelow) return true;
    if (isNum(tr.waterBelow) && state.stocks && isNum(state.stocks.water) &&
      state.stocks.water < tr.waterBelow) return true;
    if (isNum(tr.foodBelow) && state.stocks && isNum(state.stocks.food) &&
      state.stocks.food < tr.foodBelow) return true;
    if (isNum(tr.energyBelow) && state.last && isNum(state.last.energy) &&
      state.last.energy < tr.energyBelow) return true;
    if (isNum(tr.wearAbove) && isNum(state.wear) && state.wear > tr.wearAbove) return true;
    if (isNum(tr.mutinyLevel) && soc && soc.mutiny && soc.mutiny.level >= tr.mutinyLevel) return true;
    if (isNum(tr.infectAbove) && soc && soc.infection &&
      isNum(soc.infection.share) && soc.infection.share > tr.infectAbove) return true;
    if (isNum(tr.autonomyAbove) && soc && soc.machine &&
      isNum(soc.machine.A) && soc.machine.A > tr.autonomyAbove) return true;
    return false;
  }

  /* ---------------- 日志 ---------------- */

  function log(state, cfg, title, text, basis, deltas) {
    try {
      var wp = (cfg.time && cfg.time.weeksPerYear) || 52;
      var wq = (cfg.time && cfg.time.weeksPerQuarter) || 13;
      var y = Math.floor(state.weeks / wp);
      var w = (state.weeks % wp) + 1;
      var entry = {
        t: Math.round((((state.loop - 1) * ((cfg.time && cfg.time.loopYears) || 1000)) +
          state.weeks / wp) * 100) / 100,
        loop: state.loop,
        year: y,
        week: w,
        quarter: Math.floor((state.weeks % wp) / wq) + 1,
        timeLabel: "第 " + (y + 1) + " 年第 " + w + " 周",
        type: "crisis",
        level: "危机",
        title: title,
        text: text,
        basis: basis || ""
      };
      if (deltas) entry.deltas = deltas;
      state.events.push(entry);
      if (cfg.events && cfg.events.keyCap && state.events.length > cfg.events.keyCap) {
        state.events.shift();
      }
    } catch (e) { /* 日志失败不影响结算 */ }
  }

  /* ---------------- 每周：评估触发 + 施加 debuff ---------------- */

  function weekly(state, cfg) {
    var c = cfgOf(cfg);
    if (!c || c.enabled === false) return;
    var C = ensure(state, cfg);
    var every = Math.max(1, c.evalEveryWeeks || 2);

    if (C.lastEval < 0 || state.weeks - C.lastEval >= every) {
      C.lastEval = state.weeks;
      var maxActive = Math.max(1, c.maxActive || 2);
      defsOf(cfg).forEach(function (d) {
        if (C.active.length >= maxActive) return;
        for (var i = 0; i < C.active.length; i++) if (C.active[i].id === d.id) return;
        if (isNum(C.cooldown[d.id]) && state.weeks < C.cooldown[d.id]) return;
        if (!hit(state, cfg, d.trigger)) return;
        C.active.push({
          id: d.id,
          sinceWeek: state.weeks,
          sinceYear: Math.floor(state.weeks / ((cfg.time && cfg.time.weeksPerYear) || 52)),
          quietUntil: -1
        });
        log(state, cfg, "危机事件 · " + d.name,
          d.tag + "越过阈值，进入常驻危机：" + d.debuffText,
          "触发条件：" + (d.triggerText || JSON.stringify(d.trigger || {})),
          { "秩序": 0 });
      });
    }

    C.active.forEach(function (a) {
      var d = findDef(cfg, a.id);
      if (!d || !d.debuff || isQuiet(state, a)) return;
      var b = d.debuff;
      if (isNum(b.orderPerWeek) && isNum(state.order)) {
        state.order = clamp(state.order + b.orderPerWeek, 0, 1);
      }
      if (isNum(b.wearPerWeek)) state.wear = clamp(state.wear + b.wearPerWeek, 0, 1);
      if (isNum(b.structurePerWeek) && state.ship) {
        state.ship.structure = clamp(state.ship.structure + b.structurePerWeek, 0, state.ship.structureMax || 100);
      }
      if (isNum(b.foodPerWeek) && state.stocks) {
        state.stocks.food = Math.max(0, state.stocks.food + b.foodPerWeek);
      }
      if (isNum(b.waterPerWeek) && state.stocks) {
        state.stocks.water = Math.max(0, state.stocks.water + b.waterPerWeek);
      }
    });

    // 到期临时产出修正
    C.buffs = C.buffs.filter(function (b) { return state.weeks < b.until; });
  }

  /* ---------------- 产出乘子 ---------------- */

  function prodMul(state, cfg) {
    var C = state.crisis;
    if (!C) return 1;
    var m = 1;
    (C.active || []).forEach(function (a) {
      if (isQuiet(state, a)) return;
      var d = findDef(cfg, a.id);
      if (d && d.debuff && isNum(d.debuff.prodMul)) m *= d.debuff.prodMul;
    });
    (C.buffs || []).forEach(function (b) {
      if (state.weeks < b.until && isNum(b.prodMul)) m *= b.prodMul;
    });
    return clamp(m, 0.3, 1.2);
  }

  /* ---------------- 结算 ---------------- */

  function awakeTotal(state) {
    var n = 0;
    Object.keys(state.groups || {}).forEach(function (k) { n += (state.groups[k].awake || 0); });
    return n;
  }
  function dormantTotal(state) {
    var n = 0;
    Object.keys(state.groups || {}).forEach(function (k) { n += (state.groups[k].dormant || 0); });
    return n;
  }

  function killPop(state, n) {
    var left = Math.max(0, Math.round(n));
    var awake = awakeTotal(state);
    var ids = Object.keys(state.groups || {});
    if (awake <= 0 || left <= 0) return 0;
    var done = 0;
    ids.forEach(function (id) {
      var g = state.groups[id];
      var take = Math.min(g.awake, Math.round(left * (g.awake / awake)));
      g.awake -= take;
      done += take;
    });
    var rest = left - done;
    for (var i = 0; i < ids.length && rest > 0; i++) {
      var g2 = state.groups[ids[i]];
      var t2 = Math.min(g2.awake, rest);
      g2.awake -= t2;
      rest -= t2;
      done += t2;
    }
    return done;
  }

  function sleepPop(state, n) {
    var free = Math.max(0, ((state.infra && state.infra.pods) || 0) - dormantTotal(state));
    var left = Math.min(Math.max(0, Math.round(n)), free, awakeTotal(state));
    var awake = awakeTotal(state);
    if (left <= 0 || awake <= 0) return 0;
    var ids = Object.keys(state.groups || {});
    var done = 0;
    ids.forEach(function (id) {
      var g = state.groups[id];
      var take = Math.min(g.awake, Math.round(left * (g.awake / awake)));
      g.awake -= take;
      g.dormant += take;
      done += take;
    });
    var rest = left - done;
    for (var i = 0; i < ids.length && rest > 0; i++) {
      var g2 = state.groups[ids[i]];
      var t2 = Math.min(g2.awake, rest);
      g2.awake -= t2;
      g2.dormant += t2;
      rest -= t2;
      done += t2;
    }
    return done;
  }

  function applyOps(state, cfg, ops, lines) {
    (ops || []).forEach(function (op) {
      if (!op || !op.t) return;
      var v = isNum(op.v) ? op.v : 0;
      switch (op.t) {
        case "stock":
          if (op.k === "food") state.stocks.food = Math.max(0, state.stocks.food + v);
          else if (op.k === "water") state.stocks.water = Math.max(0, state.stocks.water + v);
          else if (op.k === "metal") state.stocks.metal = Math.max(0, state.stocks.metal + v);
          else if (op.k === "drug") state.stocks.drug = Math.max(0, state.stocks.drug + v);
          break;
        case "order":
          state.order = clamp(state.order + v, 0, 1);
          break;
        case "structure":
          if (state.ship) state.ship.structure = clamp(state.ship.structure + v, 0, state.ship.structureMax || 100);
          break;
        case "shield":
          if (state.ship) state.ship.shield = clamp(state.ship.shield + v, 0, state.ship.shieldMax || 100);
          break;
        case "wear":
          state.wear = clamp(state.wear + v, 0, 1);
          break;
        case "pop":
          killPop(state, -v);
          break;
        case "sleep":
          sleepPop(state, v);
          break;
        case "prodTmp":
          state.crisis.buffs.push({ prodMul: 1 + v, until: state.weeks + Math.max(1, op.weeks || 4) });
          break;
        case "infectLock":
          if (state.society && state.society.infection) {
            state.society.infection.lockUntil = state.weeks + Math.max(1, op.weeks || 8);
          }
          break;
        case "garrison":
          if (state.society && state.society.garrison) {
            state.society.garrison.strength = clamp(
              (state.society.garrison.strength || 0) + v, 0, cfg.society.garrison.initStrength || 100);
          }
          break;
        case "machineDept":
          if (state.society && state.society.machine &&
            Array.isArray(state.society.machine.depts) && state.society.machine.depts.length) {
            state.society.machine.depts.pop();
          }
          if (state.society && state.society.machine) state.society.machine.counter = 0;
          break;
        case "machineReset":
          if (state.society && state.society.machine) state.society.machine.counter = 0;
          break;
        default:
          break;
      }
    });
    return lines;
  }

  function resolve(state, cfg, id, optionId, subIds) {
    var C = ensure(state, cfg);
    var d = findDef(cfg, id);
    if (!d) return { ok: false, msg: "没有这条危机" };
    var idx = -1;
    for (var i = 0; i < C.active.length; i++) if (C.active[i].id === id) { idx = i; break; }
    if (idx < 0) return { ok: false, msg: "这条危机已经不在了" };

    var opt = null;
    (d.choices || []).forEach(function (o) { if (o.id === optionId) opt = o; });
    if (!opt) return { ok: false, msg: "没有这个应对" };

    var picked = Array.isArray(subIds) ? subIds : [];
    picked = picked.filter(function (sid) {
      var ok = false;
      (opt.subs || []).forEach(function (s) { if (s.id === sid) ok = true; });
      return ok;
    });
    if (opt.mode === "multi") {
      var min = isNum(opt.min) ? opt.min : 1;
      var max = isNum(opt.max) ? opt.max : (opt.subs || []).length;
      if (picked.length < min) return { ok: false, msg: "至少要选 " + min + " 项" };
      if (picked.length > max) return { ok: false, msg: "最多只能选 " + max + " 项" };
    } else {
      if (picked.length !== 1) return { ok: false, msg: "这一项只能选一个子项" };
    }

    var lines = [];
    picked.forEach(function (sid) {
      (opt.subs || []).forEach(function (s) {
        if (s.id !== sid) return;
        applyOps(state, cfg, s.ops, lines);
        if (s.effect) lines.push(s.effect);
      });
    });

    var a = C.active[idx];
    if (isNum(opt.holdWeeks) && opt.holdWeeks > 0) {
      a.quietUntil = state.weeks + opt.holdWeeks;
      lines.push("危机暂缓 " + opt.holdWeeks + " 周");
    } else {
      C.active.splice(idx, 1);
      var cd = isNum(d.cooldownWeeks) ? d.cooldownWeeks :
        (isNum(cfgOf(cfg).cooldownWeeks) ? cfgOf(cfg).cooldownWeeks : 104);
      C.cooldown[id] = state.weeks + cd;
      C.resolved += 1;
      lines.push("危机解除");
    }

    C.history.push({
      id: d.id,
      name: d.name,
      option: opt.label,
      subs: picked.slice(),
      week: state.weeks,
      year: Math.floor(state.weeks / ((cfg.time && cfg.time.weeksPerYear) || 52)),
      lines: lines.slice()
    });
    if (C.history.length > 12) C.history.shift();

    log(state, cfg,
      (isNum(opt.holdWeeks) && opt.holdWeeks > 0 ? "危机暂缓 · " : "危机解除 · ") + d.name,
      opt.label + "：" + lines.join("；"),
      "危机 id=" + d.id + " · 选项=" + opt.id + " · 子项=" + picked.join(","),
      null);

    return {
      ok: true,
      msg: lines.join("；"),
      lines: lines,
      hold: isNum(opt.holdWeeks) && opt.holdWeeks > 0,
      crisis: brief(state, cfg)
    };
  }

  /* ---------------- 给界面看 ---------------- */

  function brief(state, cfg) {
    var C = ensure(state, cfg);
    var defs = defsOf(cfg);
    return {
      version: VERSION,
      resolved: C.resolved,
      active: C.active.map(function (a) {
        var d = findDef(cfg, a.id);
        if (!d) return null;
        return {
          id: d.id,
          name: d.name,
          tag: d.tag,
          sinceWeek: a.sinceWeek,
          sinceYear: a.sinceYear,
          quiet: Math.max(0, (a.quietUntil || 0) - state.weeks),
          debuffText: d.debuffText,
          triggerText: d.triggerText || "",
          rawTrigger: d.trigger || null,
          choices: (d.choices || []).map(function (o) {
            return {
              id: o.id,
              label: o.label,
              desc: o.desc || "",
              mode: o.mode || "one",
              min: isNum(o.min) ? o.min : (o.mode === "multi" ? 1 : 1),
              max: isNum(o.max) ? o.max : (o.subs || []).length,
              holdWeeks: isNum(o.holdWeeks) ? o.holdWeeks : 0,
              rawOpsCount: (o.subs || []).reduce(function (n, s) { return n + ((s.ops || []).length); }, 0),
              subs: (o.subs || []).map(function (s) {
                return { id: s.id, label: s.label, effect: s.effect || "", rawOps: s.ops || [] };
              })
            };
          })
        };
      }).filter(Boolean),
      history: C.history.slice(-8).reverse(),
      defs: defs.length,
      lastEval: C.lastEval
    };
  }

  var api = {
    version: VERSION,
    create: create,
    ensure: ensure,
    weekly: weekly,
    prodMul: prodMul,
    resolve: resolve,
    brief: brief,
    findDef: findDef
  };

  global.XuanShuCrisis = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
