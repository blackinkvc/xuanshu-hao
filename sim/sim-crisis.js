/* =========================================================================
   玄枢号 · 常驻危机体系（v1.0.2）
   -------------------------------------------------------------------------
   与奇遇牌库彻底分开：危机不是抽牌，而是船上参数跨过阈值后挂上的常驻状态。
   - 触发：每周扫描 crisisStanding.defs[].trigger；同周多条越线按严重度排序，
           受 maxNewPerEval（每周新增上限）与 maxActive（并发上限）约束
   - 常驻：未处理前卡片一直在，debuff 每周生效
   - 处理：主选项 → 二级子项（互斥/多选）→ 同页结算；玩家只能选处置方式
   - 花费：资源不足的处置直接拒绝（不会静默扣到 0）
   - 风险：带 risk 的子项掷骰；失败照扣成本、追加失败后果、危机保留
   - 解除：从 active 移除并写 cooldown；「暂缓」类选项保留卡片但暂时压住 debuff
   所有数值都来自 sim-config.js 的 crisisStanding，本文件只做通用结算。
   ========================================================================= */
(function (global) {
  "use strict";

  var VERSION = "1.0.2";

  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function num(v, d) { return isNum(v) ? v : (d || 0); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function cfgOf(cfg) { return (cfg && cfg.crisisStanding) || null; }
  function defsOf(cfg) { var c = cfgOf(cfg); return (c && c.defs) || []; }
  function severityOf(d) { return isNum(d && d.severity) ? d.severity : 3; }

  function randNext(state) {
    if (global.XuanShuRand && global.XuanShuRand.next) return global.XuanShuRand.next(state);
    state.rngA = (state.rngA | 0) + 0x6D2B79F5 | 0;
    var t = Math.imul(state.rngA ^ (state.rngA >>> 15), 1 | state.rngA);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function findDef(cfg, id) {
    var list = defsOf(cfg);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function blank() {
    return {
      active: [],
      cooldown: {},
      streak: {},
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
    if (!C.streak || typeof C.streak !== "object") C.streak = {};
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
    // v6.61：按部件损伤触发（舰体六部件模型）
    if (tr.hullPart && tr.hullPart.id && state.ship && state.ship.hull &&
      state.ship.hull.parts && isNum(tr.hullPart.above) &&
      num(state.ship.hull.parts[tr.hullPart.id], 0) > tr.hullPart.above) return true;
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
    // v6.67：设备类按任意部件越线触发；健康/变异/人口也可作为状态源
    if (tr.hullPartAny && Array.isArray(tr.hullPartAny) && state.ship &&
      state.ship.hull && state.ship.hull.parts) {
      for (var hi = 0; hi < tr.hullPartAny.length; hi++) {
        var hs = tr.hullPartAny[hi];
        if (hs && hs.id && isNum(hs.above) &&
          num(state.ship.hull.parts[hs.id], 0) > hs.above) return true;
      }
    }
    if (isNum(tr.radAbove) && state.health && isNum(state.health.rad) &&
      state.health.rad > tr.radAbove) return true;
    if (isNum(tr.healthBelow) && state.player && state.player.pc &&
      isNum(state.player.pc.health) && state.player.pc.health < tr.healthBelow) return true;
    if (isNum(tr.mutationAbove) && state.player && state.player.pc &&
      isNum(state.player.pc.mutation) && state.player.pc.mutation > tr.mutationAbove) return true;
    if (isNum(tr.popBelow) && awakeTotal(state) < tr.popBelow) return true;
    // v1.0.2：新增状态源
    if (isNum(tr.dormantAbove) && dormantTotal(state) > tr.dormantAbove) return true;
    if (isNum(tr.captivesAtLeast) && state.prison &&
      num(state.prison.captives) >= tr.captivesAtLeast) return true;
    if (isNum(tr.devourAbove) && state.gods &&
      num(state.gods.devour) > tr.devourAbove) return true;
    if (tr.intelAtLeast) {
      var rank = { low: 1, mid: 2, high: 3, truth: 4 };
      var haveIntel = rank[state.player && state.player.intel] || 1;
      var needIntel = rank[tr.intelAtLeast] || 2;
      if (haveIntel >= needIntel) return true;
    }
    if (tr.laborHigh && typeof tr.laborHigh === "object") {
      var lo = laborOf(state, cfg);
      if ((isNum(tr.laborHigh.rate) && lo.rate > tr.laborHigh.rate) ||
        (isNum(tr.laborHigh.count) && lo.unemployed > tr.laborHigh.count)) return true;
    }
    // all：全部子条件同时满足（顶层现有键仍是 OR）
    if (Array.isArray(tr.all) && tr.all.length) {
      var allOk = true;
      for (var ai = 0; ai < tr.all.length; ai++) {
        if (!hit(state, cfg, tr.all[ai])) { allOk = false; break; }
      }
      if (allOk) return true;
    }
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
    laborTick(state, cfg);

    if (C.lastEval < 0 || state.weeks - C.lastEval >= every) {
      C.lastEval = state.weeks;
      var maxActive = Math.max(1, c.maxActive || 2);
      var maxNew = Math.max(1, c.maxNewPerEval || 1);
      var room = Math.max(0, maxActive - C.active.length);
      if (room > 0) {
        // v1.0.2：连续周计数 + 科技概率修正；同一周多条越线按严重度排序，再受双上限约束
        var hits = [];
        defsOf(cfg).forEach(function (d) {
          var activeNow = false;
          for (var i = 0; i < C.active.length; i++) {
            if (C.active[i].id === d.id) { activeNow = true; break; }
          }
          if (activeNow || (isNum(C.cooldown[d.id]) && state.weeks < C.cooldown[d.id])) {
            C.streak[d.id] = 0;
            return;
          }
          var ok = hit(state, cfg, d.trigger);
          if (ok && d.trigger && d.trigger.chanceTech) {
            var ct = d.trigger.chanceTech;
            var p = clamp(num(ct.base, 1) - num(ct.perTech, 0) * techOf(state), 0.01, 1);
            if (randNext(state) >= p) ok = false;
          }
          if (ok) C.streak[d.id] = num(C.streak[d.id], 0) + 1;
          else C.streak[d.id] = 0;
          if (ok && num(C.streak[d.id]) >= triggerWeeks(d)) hits.push(d);
        });
        hits.sort(function (a, b) {
          var gapSev = severityOf(b) - severityOf(a);
          if (gapSev !== 0) return gapSev;
          return String(a.id).localeCompare(String(b.id));
        });
        hits.slice(0, Math.min(room, maxNew)).forEach(function (d) {
          C.streak[d.id] = 0;
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
    }

    C.active.forEach(function (a) {
      var d = findDef(cfg, a.id);
      if (!d || !d.debuff || isQuiet(state, a)) return;
      var b = d.debuff;
      if (isNum(b.orderPerWeek) && isNum(state.order)) {
        state.order = clamp(state.order + b.orderPerWeek, 0, 1);
      }
      if (isNum(b.wearPerWeek)) state.wear = clamp(state.wear + b.wearPerWeek, 0, 1);
      // v6.61：结构常驻伤害已取消，改由 hullTick 逐周积分六部件损伤
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

  // 休眠者损失：按各组休眠人数比例扣
  function killDormant(state, n) {
    var left = Math.max(0, Math.round(n));
    var total = dormantTotal(state);
    if (total <= 0 || left <= 0) return 0;
    var ids = Object.keys(state.groups || {});
    var done = 0;
    ids.forEach(function (id) {
      var g = state.groups[id];
      var take = Math.min(num(g.dormant), Math.round(left * (num(g.dormant) / total)));
      g.dormant = Math.max(0, num(g.dormant) - take);
      done += take;
    });
    var rest = left - done;
    for (var i = 0; i < ids.length && rest > 0; i++) {
      var g2 = state.groups[ids[i]];
      var t2 = Math.min(num(g2.dormant), rest);
      g2.dormant = Math.max(0, num(g2.dormant) - t2);
      rest -= t2;
      done += t2;
    }
    return done;
  }

  // 紧急唤醒：休眠 → 醒态
  function wakePop(state, n) {
    var left = Math.min(Math.max(0, Math.round(n)), dormantTotal(state));
    var total = dormantTotal(state);
    if (left <= 0 || total <= 0) return 0;
    var ids = Object.keys(state.groups || {});
    var done = 0;
    ids.forEach(function (id) {
      var g = state.groups[id];
      var take = Math.min(num(g.dormant), Math.round(left * (num(g.dormant) / total)));
      g.dormant = Math.max(0, num(g.dormant) - take);
      g.awake = num(g.awake) + take;
      done += take;
    });
    return done;
  }

  // 就业字段统一由 sim-society.laborTick 产出；这里只补齐危机线自己的算子字段。
  function ensureLabor(state, cfg) {
    if (!state.labor || typeof state.labor !== "object") state.labor = {};
    var L = state.labor;
    if (!isNum(L.jobsBase)) L.jobsBase = num(cfg.population && cfg.population.laborFull, 1720);
    if (!isNum(L.jobs)) L.jobs = L.jobsBase;
    if (!Array.isArray(L.jobsTemp)) L.jobsTemp = [];
    if (!isNum(L.wageScale)) L.wageScale = 1;
    if (!isNum(L.workScale)) L.workScale = 1;
    if (!isNum(L.competeDelta)) L.competeDelta = 0;
    if (typeof L.split !== "boolean") L.split = false;
    if (!isNum(L.freeFoodUntil)) L.freeFoodUntil = -1;
    if (!isNum(L.competeUntil)) L.competeUntil = -1;
    if (!isNum(L.lastCompeteWeek)) L.lastCompeteWeek = -1;
    if (!isNum(L.quality)) L.quality = 0.55;
    return L;
  }

  function laborOf(state, cfg) {
    var L = ensureLabor(state, cfg);
    // 引擎线已经算过就以 state.labor 为准
    if (isNum(L.labor) && L.byClass) {
      return {
        labor: num(L.labor), jobs: num(L.jobs), unemployed: num(L.unemployed),
        rate: num(L.rate), byClass: L.byClass
      };
    }
    var undecided = (cfg.population && cfg.population.undecidedId) || "undecided";
    var labor = 0;
    Object.keys(state.groups || {}).forEach(function (k) {
      if (k === undecided) return;
      labor += num(state.groups[k].awake);
    });
    var jobs = num(L.jobs, 1720);
    (L.jobsTemp || []).forEach(function (j) {
      if (state.weeks < num(j.until)) jobs += num(j.add);
    });
    var unemployed = Math.max(0, labor - jobs);
    return {
      labor: labor,
      jobs: jobs,
      unemployed: unemployed,
      rate: labor > 0 ? unemployed / labor : 0
    };
  }

  // 多人竞争岗位：持续期内每 4 周判一次，有人上岗有人下岗
  function laborTick(state, cfg) {
    var L = ensureLabor(state, cfg);
    if (Array.isArray(L.jobsTemp)) {
      L.jobsTemp = L.jobsTemp.filter(function (j) { return state.weeks < num(j.until); });
    }
    if (state.weeks >= num(L.competeUntil, -1)) return;
    if (state.weeks - num(L.lastCompeteWeek, -1) < 4) return;
    L.lastCompeteWeek = state.weeks;
    var p = clamp(0.35 + 0.5 * num(L.quality, 0.55), 0.25, 0.85);
    var gain = randNext(state) < p ? 2 : 0;
    var lose = randNext(state) < (1 - p) ? 2 : 0;
    L.competeDelta = Math.max(-L.jobsBase, num(L.competeDelta) + gain - lose);
    if (isNum(state.order)) {
      state.order = clamp(state.order + (gain - lose) * 0.001, 0, 1);
    }
    log(state, cfg, "岗位竞争 · 月度判定",
      "本月 " + gain + " 人上岗、" + lose + " 人下岗（素质评分 " + p.toFixed(2) + "）",
      "竞争期至第 " + (L.competeUntil + 1) + " 周",
      { "秩序": (gain - lose) * 0.001 });
  }

  function countGroup(state, id, ageMin) {
    var g = state.groups && state.groups[id];
    var awake = num(g && g.awake);
    if (!isNum(ageMin)) return awake;
    var people = state.people && state.people.groups && state.people.groups[id];
    if (!Array.isArray(people)) return 0;
    var n = 0;
    people.forEach(function (p) { if (num(p.age) >= ageMin) n++; });
    return Math.min(awake, n);
  }

  function techOf(state) {
    return state.society && state.society.machine
      ? clamp(num(state.society.machine.tech), 0, 1) : 0;
  }

  function triggerWeeks(d) {
    return d && d.trigger && isNum(d.trigger.weeks) ? Math.max(1, d.trigger.weeks) : 1;
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
        case "hullPart":
          // v6.67：按部件修补（v 为损伤变化，负值=降低损伤），失压应修补 life 而不是 structure
          if (op.id && state.ship && state.ship.hull && state.ship.hull.parts &&
              isNum(state.ship.hull.parts[op.id])) {
            state.ship.hull.parts[op.id] =
              clamp(state.ship.hull.parts[op.id] + v, 0, 1);
            if (op.id === "structure" && isNum(state.ship.structureMax)) {
              state.ship.structure = clamp(
                (1 - state.ship.hull.parts.structure) * state.ship.structureMax,
                0, state.ship.structureMax);
            }
          }
          break;
        case "rad":
          if (state.health) state.health.rad = clamp(num(state.health.rad) + v, 0, 1);
          break;
        case "structure":
          // v6.61：结构已是六部件之一，抢修 = 直接降低结构件损伤（ΔD = −v/100）
          if (state.ship && state.ship.hull && state.ship.hull.parts &&
              isNum(state.ship.hull.parts.structure)) {
            state.ship.hull.parts.structure =
              clamp(state.ship.hull.parts.structure - v / 100, 0, 1);
            if (isNum(state.ship.structureMax)) {
              state.ship.structure = clamp(
                (1 - state.ship.hull.parts.structure) * state.ship.structureMax,
                0, state.ship.structureMax);
            }
          } else if (state.ship) {
            state.ship.structure = clamp(state.ship.structure + v, 0, state.ship.structureMax || 100);
          }
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
          ensure(state, cfg).buffs.push({ prodMul: 1 + v, until: state.weeks + Math.max(1, op.weeks || 4) });
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
        // v1.0.2：俘虏/神噬/休眠损失/机器自主
        case "captives":
          if (state.prison) state.prison.captives = clamp(num(state.prison.captives) + v, 0, 999);
          break;
        case "devour":
          if (state.gods) {
            state.gods.devour = clamp(num(state.gods.devour) + v, 0,
              num(cfg.gods && cfg.gods.devourCap, 100));
          }
          break;
        case "dormantLoss":
          killDormant(state, Math.abs(v));
          break;
        case "wake":
          wakePop(state, v);
          break;
        case "machineAuto":
          if (state.society && state.society.machine) {
            state.society.machine.A = clamp(num(state.society.machine.A) + v, 0, 1);
          }
          break;
        // 服从：走 society.effects 的 O/W 偏移，与奇遇同口径
        case "queue":
          if (state.society) {
            if (!state.society.effects) state.society.effects = {};
            if (op.k === "O") {
              state.society.effects.oShift = num(state.society.effects.oShift) + v;
            } else if (op.k === "W") {
              state.society.effects.wShift = num(state.society.effects.wShift) + v;
            } else {
              var qs = state.society.queues || [];
              if (!Array.isArray(qs)) qs = Object.keys(qs).map(function (k) { return qs[k]; });
              qs.forEach(function (q) {
                if (q && isNum(q[op.k])) q[op.k] = clamp(q[op.k] + v, 0, 100);
              });
            }
          }
          break;
        // 按组回收：id=clone 时只动克隆人；ageMin 进一步只取年长克隆人
        case "popGroup": {
          var pg = state.groups && state.groups[op.id];
          if (pg) {
            var take = Math.min(num(pg.awake), Math.abs(v));
            var people = state.people && state.people.groups && state.people.groups[op.id];
            if (Array.isArray(people)) {
              var removed = 0;
              for (var pi = people.length - 1; pi >= 0 && removed < take; pi--) {
                if (isNum(op.ageMin) && !(num(people[pi].age) >= op.ageMin)) continue;
                people.splice(pi, 1); removed++;
              }
              take = removed;
            }
            pg.awake = Math.max(0, num(pg.awake) - take);
          }
          break;
        }
        // 就业/工资占位算子
        case "laborJobs": {
          var lj = ensureLabor(state, cfg);
          lj.jobsTemp.push({ add: v, until: state.weeks + Math.max(1, op.weeks || 52) });
          break;
        }
        case "laborSplit": {
          var ls = ensureLabor(state, cfg);
          if (num(ls.wageScale, 1) > 0.8) {
            ls.split = true;
            ls.wageScale = num(cfg.labor && cfg.labor.wageScaleSplit, 0.8);
            ls.workScale = num(cfg.labor && cfg.labor.workScaleSplit, 0.85);
          }
          break;
        }
        case "freeFood": {
          var lf = ensureLabor(state, cfg);
          lf.freeFoodUntil = Math.max(num(lf.freeFoodUntil, -1), state.weeks) +
            Math.max(1, op.weeks || 13);
          break;
        }
        case "compete": {
          var lc = ensureLabor(state, cfg);
          lc.competeUntil = Math.max(num(lc.competeUntil, -1), state.weeks) +
            Math.max(1, op.weeks || 52);
          break;
        }
        default:
          break;
      }
    });
    return lines;
  }

  var STOCK_LABEL = { food: "粮", water: "水", metal: "金属", drug: "药剂" };
  // 处置前置校验：资源/人口/舱位不够就直接拒绝，避免扣到 0 还算「办成了」
  function checkOps(state, ops) {
    var need = {}, pop = 0, sleep = 0;
    (ops || []).forEach(function (op) {
      if (!op || !op.t) return;
      var v = isNum(op.v) ? op.v : 0;
      if (op.t === "stock" && v < 0 && STOCK_LABEL[op.k]) need[op.k] = num(need[op.k]) + (-v);
      if (op.t === "pop" && v < 0) pop += -v;
      if (op.t === "sleep" && v > 0) sleep += v;
      // v1.0.2：俘虏/分组回收/唤醒/重复削薪
      if (op.t === "captives" && v < 0) {
        var held = num(state.prison && state.prison.captives);
        if (held < -v) return "俘虏不足（需 " + (-v) + "，现有 " + held + "）";
      }
      if (op.t === "popGroup" && v < 0) {
        var available = countGroup(state, op.id, op.ageMin);
        if (available < -v) {
          return (op.ageMin ? "年长克隆人" : "该组人口") + "不足（需 " + (-v) + "，现有 " + available + "）";
        }
      }
      if (op.t === "wake" && v > 0 && dormantTotal(state) < v) {
        return "休眠者不足（需 " + v + "，现有 " + dormantTotal(state) + "）";
      }
      if (op.t === "laborSplit" && state.labor && num(state.labor.wageScale, 1) <= 0.8) {
        return "已经削过薪，不能重复对拆";
      }
    });
    var keys = Object.keys(need);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var have = num(state.stocks && state.stocks[k]);
      if (have + 1e-6 < need[k]) {
        return STOCK_LABEL[k] + "不足（需 " + Math.round(need[k]) +
          "，现有 " + Math.round(have) + "）";
      }
    }
    if (pop > 0 && awakeTotal(state) < pop) return "可调人口不足（需 " + pop + "）";
    if (sleep > 0) {
      var free = Math.max(0, ((state.infra && state.infra.pods) || 0) - dormantTotal(state));
      if (free < sleep) return "休眠舱位不足（需 " + sleep + "，空位 " + free + "）";
    }
    return "";
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

    var pickedSubs = [];
    picked.forEach(function (sid) {
      (opt.subs || []).forEach(function (s) { if (s.id === sid) pickedSubs.push(s); });
    });
    var allOps = [];
    pickedSubs.forEach(function (s) { allOps = allOps.concat(s.ops || []); });
    var shortMsg = checkOps(state, allOps);
    if (shortMsg) return { ok: false, msg: shortMsg };

    var lines = [];
    var failed = false;
    pickedSubs.forEach(function (s) {
      applyOps(state, cfg, s.ops, lines);
      if (s.effect) lines.push(s.effect);
      if (s.risk) {
        var p = clamp(num(s.risk.p, 0.7), 0.01, 0.99);
        if (randNext(state) < p) {
          if (s.risk.success && s.risk.success.length) applyOps(state, cfg, s.risk.success, lines);
          if (s.risk.successText) lines.push(s.risk.successText);
        } else {
          failed = true;
          if (s.risk.fail && s.risk.fail.length) applyOps(state, cfg, s.risk.fail, lines);
          lines.push("处置失败：" + (s.risk.failText || "行动未达到预期"));
        }
      }
    });

    var a = C.active[idx];
    if (failed) {
      // 失败不解除：成本已扣、后果已落，危机继续挂着等下一次处置
      a.quietUntil = -1;
      C.history.push({
        id: d.id,
        name: d.name,
        option: opt.label,
        subs: picked.slice(),
        week: state.weeks,
        year: Math.floor(state.weeks / ((cfg.time && cfg.time.weeksPerYear) || 52)),
        failed: true,
        lines: lines.slice()
      });
      if (C.history.length > 12) C.history.shift();
      log(state, cfg, "危机处置失败 · " + d.name,
        opt.label + "：" + lines.join("；"),
        "危机 id=" + d.id + " · 选项=" + opt.id + " · 子项=" + picked.join(","),
        null);
      return {
        ok: true,
        failed: true,
        msg: lines.join("；"),
        lines: lines,
        hold: false,
        crisis: brief(state, cfg)
      };
    }
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
      weeks: state.weeks,
      resolved: C.resolved,
      active: C.active.map(function (a) {
        var d = findDef(cfg, a.id);
        if (!d) return null;
        return {
          id: d.id,
          name: d.name,
          tag: d.tag,
          severity: severityOf(d),
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
                return {
                  id: s.id,
                  label: s.label,
                  effect: s.effect || "",
                  short: checkOps(state, s.ops),
                  risk: s.risk ? {
                    p: clamp(num(s.risk.p, 0.7), 0.01, 0.99),
                    successText: s.risk.successText || "",
                    failText: s.risk.failText || ""
                  } : null,
                  rawOps: s.ops || []
                };
              })
            };
          })
        };
      }).filter(Boolean).sort(function (x, y) { return (y.severity || 0) - (x.severity || 0); }),
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
    applyOps: applyOps,
    resolve: resolve,
    brief: brief,
    findDef: findDef
  };

  global.XuanShuCrisis = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
