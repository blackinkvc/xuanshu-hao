/* =========================================================================
   玄枢号 · 舰务模拟内核（v0.2 · 周为单位）
   -------------------------------------------------------------------------
   纯计算，不碰 DOM。所有状态都是普通 JSON，可直接搬进主站。
   内部最小时间步 = 1 周；1 年 = 52 周，1 季 = 13 周。
   用法：
     var sim = XuanShuSim.createSim();        // 读取 globalThis.XUANSHU_CONFIG
     sim.setInputs({ ration: 0.9 });
     sim.step(520);                           // 推进 520 周 = 10 年
     var s = sim.getState();
   ========================================================================= */
(function (global) {
  "use strict";

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function deepMerge(base, patch) {
    if (!patch || typeof patch !== "object") return clone(base);
    var out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    Object.keys(patch).forEach(function (k) {
      var bv = base ? base[k] : undefined;
      var pv = patch[k];
      if (pv && typeof pv === "object" && !Array.isArray(pv) &&
          bv && typeof bv === "object" && !Array.isArray(bv)) {
        out[k] = deepMerge(bv, pv);
      } else {
        out[k] = pv;
      }
    });
    return out;
  }

  // 可序列化的 PRNG（seed 跟着状态走，导出/导入不会断）。
  // 真正实现在 sim-config.js 的 XuanShuRand；这里只做一层委托，保证
  // 噪声与随机判定共用同一条流，整船随机序列因此可复现。
  function nextRand(state) {
    if (global.XuanShuRand) return global.XuanShuRand.next(state);
    state.rngA |= 0;
    state.rngA = (state.rngA + 0x6D2B79F5) | 0;
    var t = Math.imul(state.rngA ^ (state.rngA >>> 15), 1 | state.rngA);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /* ---------------- 派生量 ---------------- */

  function totals(state, cfg) {
    var awake = 0, dormant = 0, working = 0;
    cfg.population.groups.forEach(function (g) {
      var s = state.groups[g.id];
      if (!s) return;
      awake += s.awake;
      dormant += s.dormant;
      if (g.id !== cfg.population.undecidedId) working += s.awake;
    });
    return { awake: awake, dormant: dormant, total: awake + dormant, working: working };
  }

  // 旧档兼容：补齐配置里新增的人群（如 v6.23 的「遗民」）。
  function ensureGroups(state, cfg) {
    if (!state || !state.groups) return state;
    (cfg.population.groups || []).forEach(function (g) {
      if (!state.groups[g.id]) {
        state.groups[g.id] = { awake: g.awake || 0, dormant: g.dormant || 0 };
      }
    });
    return state;
  }

  // 旧档兼容：舱位不得低于总人口，且至少留 20% 余量。
  function ensurePods(state, cfg) {
    if (!state || !state.groups) return;
    if (!state.infra) state.infra = { hydro: 0, pods: 0, clonePods: 0 };
    var total = 0;
    (cfg.population.groups || []).forEach(function (g) {
      var s = state.groups[g.id];
      if (!s) return;
      total += Math.round(Number(s.awake) || 0) + Math.round(Number(s.dormant) || 0);
    });
    var min = Math.max(total, Math.ceil(total * 1.2));
    if (!isNum(state.infra.pods) || state.infra.pods < min) state.infra.pods = min;
  }

  function foodDays(state, cfg, t) {
    var demand = t.awake * cfg.food.perCapitaTpy +
      t.dormant * cfg.food.perCapitaTpy * cfg.food.dormantFactor;
    return demand > 0 ? state.stocks.food / (demand / 365) : 9999;
  }

  function waterDays(state, cfg, t) {
    var throughput = t.awake * cfg.water.perCapitaAwake + t.dormant * cfg.water.perCapitaDormant;
    return throughput > 0 ? state.stocks.water / (throughput / 365) : 9999;
  }

  /* 推进工质：最小可用模型（与《推进_内循环_药剂_成瘾_营养_设计表》§1.3 一致）
     r = v / speedBaseC
     P(r) = 68 × (0.25 + 0.75·r³)，封顶 jetPeakMW
     mWeek = perWeekBase × r^expo × P/68                t/周
     mPerLy = mWeek × 52 / (speedBaseC·r)               t/光年（t_ly = 1/(base·r) 年）
     可飞航程 = 剩余工质 / mPerLy（光年）× 9.4607e12 km */
  var KM_PER_LY = 9460730472580.8;

  function propellantUse(cfg, speedC) {
    var sp = (cfg.ship && cfg.ship.propellant) || {};
    var base = (cfg.ship && cfg.ship.speedBaseC) || 0.045;
    var r = Math.max(0.01, (speedC || base) / base);
    var mw = Math.min(68 * (0.25 + 0.75 * Math.pow(r, 3)), sp.jetPeakMW || 102);
    var perWeek = (isNum(sp.perWeekBase) ? sp.perWeekBase : 0.28) *
      Math.pow(r, isNum(sp.expo) ? sp.expo : 2.4) * (mw / 68);
    var weeksPerLy = 52 / (base * r);
    return { mWeek: perWeek, mPerLy: perWeek * weeksPerLy };
  }

  function remainingRangeKm(cfg, propellant, speedC) {
    var u = propellantUse(cfg, speedC);
    if (!(u.mPerLy > 0)) return 0;
    return Math.max(0, propellant || 0) / u.mPerLy * KM_PER_LY;
  }

  function normalizedShares(I) {
    var sum = I.metalHydro + I.metalPods + I.metalClone + I.metalMaint;
    if (sum <= 0) return { hydro: 15, pods: 20, clone: 5, maint: 60 };
    return {
      hydro: I.metalHydro * 100 / sum,
      pods: I.metalPods * 100 / sum,
      clone: I.metalClone * 100 / sum,
      maint: I.metalMaint * 100 / sum
    };
  }

  /* ---------------- 事件 ---------------- */

  // 影响面板只认这 8 项；没有变化的项直接省略，界面显示「没有直接影响」。
  var METRIC_KEYS = ["人口", "健康", "粮食", "秩序", "磨损", "感染", "耐久", "警备"];

  function cleanDeltas(d) {
    if (!d) return null;
    var out = {}, n = 0;
    METRIC_KEYS.forEach(function (k) {
      var v = typeof d[k] === "number" ? d[k] : 0;
      if (!isFinite(v)) v = 0;
      v = Math.round(v * 10) / 10;
      if (v !== 0) { out[k] = v; n++; }
    });
    return n ? out : null;
  }

  // 统一量纲：人口/警备=人，粮食=吨，其余=百分点/点
  function metrics(state, cfg) {
    var tots = totals(state, cfg);
    var p = state.player;
    var soc = state.society || {};
    return {
      "人口": Math.round(tots.total),
      "健康": p && p.pc ? Math.round((typeof p.pc.health === "number" ? p.pc.health : 0)) : 0,
      "粮食": Math.round(state.stocks.food * 10) / 10,
      "秩序": Math.round(state.order * 1000) / 10,
      "磨损": Math.round(state.wear * 100),
      "感染": Math.round(((soc.infection || {}).share || 0) * 100),
      "耐久": Math.round((soc.garrison || {}).durability || 0),
      "警备": Math.round((soc.garrison || {}).strength || 0)
    };
  }

  function diffMetrics(before, after) {
    var out = {};
    METRIC_KEYS.forEach(function (k) {
      var d = (after[k] || 0) - (before[k] || 0);
      if (d !== 0) out[k] = Math.round(d * 10) / 10;
    });
    return out;
  }

  function pushEvent(state, cfg, type, level, title, text, basis, force, deltas, note) {
    if (!force) {
      var last = state.cooldown[type];
      if (last !== undefined && state.weeks - last < cfg.events.cooldownWeeks) return false;
      state.cooldown[type] = state.weeks;
    }
    var evYear = Math.floor(state.weeks / cfg.time.weeksPerYear);
    var evWeek = (state.weeks % cfg.time.weeksPerYear) + 1;
    var entry = {
      t: Math.round(((state.loop - 1) * cfg.time.loopYears + state.weeks / cfg.time.weeksPerYear) * 100) / 100,
      loop: state.loop,
      year: evYear,
      week: evWeek,
      quarter: Math.floor((state.weeks % cfg.time.weeksPerYear) / cfg.time.weeksPerQuarter) + 1,
      timeLabel: "第 " + (evYear + 1) + " 年第 " + evWeek + " 周",
      type: type,
      level: level || "事件",
      title: title,
      text: text,
      basis: basis || ""
    };
    var D = cleanDeltas(deltas);
    if (D) entry.deltas = D;
    if (note) entry.note = note;
    // 日志分级：关键节点长期保留；例行流水只进排障环形缓冲，不进历程页
    if (eventIsKey(cfg, type, entry.level)) {
      state.events.push(entry);
      if (cfg.events.keyCap && state.events.length > cfg.events.keyCap) state.events.shift();
    } else {
      if (!state.logRing) state.logRing = [];
      state.logRing.push(entry);
      var ring = cfg.events.routineRing || 40;
      while (state.logRing.length > ring) state.logRing.shift();
    }
    return true;
  }

  function eventIsKey(cfg, type, level) {
    var e = (cfg && cfg.events) || {};
    var lv = e.keyLevels && e.keyLevels[type];
    if (lv && lv.indexOf(level) >= 0) return true;
    if (e.keyTypes && e.keyTypes.indexOf(type) >= 0) return true;
    if (e.routineTypes && e.routineTypes.indexOf(type) >= 0) return false;
    return true; // 未登记的新类型默认按关键保留，宁可多留也不丢历史
  }

  /**
   * 梦中侵染：眷属越多、古神低语越强，休眠者被拖出梦境的压力越大。
   * 压力是累积量，满 1 即转化 1 人并清零余数；成瘾抵抗若已接入则减半。
   */
  function stepDream(state, cfg, soc, medCoverage) {
    var h = cfg.hibernation || {};
    if (!h.dreamK) return 0;
    if (!state.dream) state.dream = { pressure: 0, infected: 0, lastLog: -99 };
    var dormant = totals(state, cfg).dormant;
    if (dormant <= 0 || !soc) return 0;
    var nv = function (v) { return isNum(v) ? v : 0; };
    var inf = soc.infection || {};
    var thralls = nv(inf.thralls);
    var corr = clamp(nv(inf.meanC) / 100, 0, 1);
    var resist = 0;
    var ad = state.addict;
    if (ad) {
      if (ad.effects && isNum(ad.resistance)) {
        resist = clamp(ad.resistance, 0, 0.95);
      } else {
        var tot = nv(ad.light) + nv(ad.mid) + nv(ad.heavy);
        if (tot > 0) {
          resist = (0.30 * nv(ad.light) + 0.60 * nv(ad.mid) + 0.90 * nv(ad.heavy)) / tot;
        }
      }
    }
    // 戒断：抵抗归零之外，梦中压力再 ×1.5（对应设计表「理智损失 ×1.5」）
    var wTot = ad && ad.withdraw
      ? nv(ad.withdraw.light) + nv(ad.withdraw.mid) + nv(ad.withdraw.heavy) : 0;
    var rate = h.dreamK * (1 + thralls * h.dreamThrallK) *
      (1 + corr * h.dreamWhisperK) *
      (1 - h.dreamDrugShield * clamp(medCoverage, 0, 1)) *
      (1 - resist * 0.5) * (wTot > 0 ? 1.5 : 1);
    state.dream.pressure += rate * dormant;
    if (state.dream.pressure < 1) return 0;
    var n = Math.min(Math.floor(state.dream.pressure), Math.floor(dormant));
    state.dream.pressure -= n;
    var need = n;
    cfg.population.groups.forEach(function (g) {
      if (need <= 0) return;
      var st = state.groups[g.id];
      if (!st || st.dormant <= 0) return;
      var take = Math.min(st.dormant, need);
      st.dormant -= take;
      st.awake += take;
      need -= take;
    });
    var moved = n - need;
    state.dream.infected += moved;
    // 写回常驻的 bonus：thralls 每周由部门重算，只有 bonus 会跨周累积
    inf.bonus = nv(inf.bonus) + moved;
    inf.thralls = nv(inf.thralls) + moved;
    if (moved > 0 && state.weeks - state.dream.lastLog >= (h.dreamLogWeeks || 8)) {
      state.dream.lastLog = state.weeks;
      pushEvent(state, cfg, "dream_infection", "感染", "休眠舱里的低语",
        "本周 " + moved + " 名休眠者被拖出梦境，成为眷属；眷属累计 " + inf.thralls,
        "梦中压力 " + (rate * 100).toFixed(3) + "%/位·周 · 低语 " + corr.toFixed(2) +
          " · 医疗压制 " + Math.round(h.dreamDrugShield * medCoverage * 100) + "%",
        true, { "眷属": moved },
        "被侵染者转为清醒眷属，仍计入人口；成瘾抵抗可减半压力");
    }
    return moved;
  }

  /**
   * 药剂 / 营养 / 成瘾（v0.3）
   * ---------------------------------------------------------------------
   * 顺序：药剂产能 → 营养四维 → 补剂/辐射/变异修复/DNA → 镇痛用药 → 三档成瘾
   *      → 戒断与抵抗。所有数值直接写回 state，效果摘要放 state.addict.effects
   *      与 state.vitals，供产出/秩序/死亡结算读取。
   * 口径见《成瘾与抵抗值_20261114》与《药剂_成瘾_营养_设计表_20261113》。
   */
  function ensureVitals(state, cfg) {
    var M = cfg.med || {}, A = cfg.addict || {};
    if (!state.pools) state.pools = {};
    if (!state.pools.med) state.pools.med = {};
    ["nutri", "rad", "mut", "dna", "pain"].forEach(function (k) {
      if (!isNum(state.pools.med[k])) {
        state.pools.med[k] = (M.init && isNum(M.init[k])) ? M.init[k] : 0;
      }
    });
    if (!state.addict) state.addict = {};
    var ad = state.addict;
    ["light", "mid", "heavy", "use", "useTarget", "blissWeeks"].forEach(function (k) {
      if (!isNum(ad[k])) ad[k] = 0;
    });
    if (!ad.withdraw) ad.withdraw = { light: 0, mid: 0, heavy: 0 };
    if (!isNum(ad.resistance)) ad.resistance = 0;
    if (!isNum(ad.blissNext)) ad.blissNext = 0;
    if (!isNum(ad.lastWithdrawLog)) ad.lastWithdrawLog = -99;
    if (!state.nutrition) state.nutrition = {};
    var nu = state.nutrition;
    ["kcal", "protein", "vit", "micro"].forEach(function (k) {
      if (!isNum(nu[k])) nu[k] = 1;
    });
    ["neuro", "maln", "badProtein", "badMicro"].forEach(function (k) {
      if (!isNum(nu[k])) nu[k] = 0;
    });
    if (!state.health) state.health = { rad: 0 };
    if (!isNum(state.health.rad)) state.health.rad = 0;
    return state;
  }

  function stepVitals(state, cfg, t0, medCoverage, soc) {
    ensureVitals(state, cfg);
    var M = cfg.med, A = cfg.addict, N = cfg.nutrition;
    var ad = state.addict, nu = state.nutrition, pools = state.pools.med;
    var r2 = function (v) { return Math.round(v * 100) / 100; };
    var r3 = function (v) { return Math.round(v * 1000) / 1000; };

    // 1) 药剂产能：医疗覆盖越高，合成线越稳
    Object.keys(M.prodPerWeek).forEach(function (k) {
      pools[k] = clamp(num0(pools[k]) + M.prodPerWeek[k] * (0.85 + 0.15 * clamp(medCoverage, 0, 1)),
        0, M.cap[k]);
    });

    // 2) 营养四维：配给只动热量，其余三维按缺口非线性下滑
    var ration = clamp(num0(state.last && state.last.rationActual, 1), 0, 1.2);
    var gap = clamp((1 - Math.min(1, ration)) / N.rationBase, 0, 1);
    nu.kcal = Math.min(1, ration);
    nu.protein = 1 - N.proteinSlope * gap;
    nu.vit = 1 - N.vitSlope * gap;
    nu.micro = 1 - N.microSlope * gap;
    nu.imm = clamp(0.50 + 0.50 * Math.min(nu.vit, nu.micro) -
      0.40 * Math.max(0, 0.80 - nu.protein), 0, 1.6);
    nu.fit = clamp(0.70 + 0.30 * nu.protein - 0.20 * (1 - nu.micro), 0.5, 1);

    // 3) 营养补剂：只补缺口，不替代产能
    var deficit = ((1 - nu.protein) + (1 - nu.vit) + (1 - nu.micro)) / 3;
    var nutriNeed = t0.awake > 0 ? t0.awake * deficit / Math.max(0.01, M.doseCover.nutri) : 0;
    var nutriUse = Math.min(pools.nutri, nutriNeed);
    pools.nutri = Math.max(0, pools.nutri - nutriUse);
    if (nutriUse > 0 && t0.awake > 0) {
      var lift = nutriUse * M.doseCover.nutri / t0.awake;
      nu.protein = Math.min(1, nu.protein + lift);
      nu.vit = Math.min(1, nu.vit + lift);
      nu.micro = Math.min(1, nu.micro + lift);
    }

    // 4) 神经损伤：微量长期不足的不可逆累积
    if (nu.micro < N.neuroFloor) {
      nu.neuro = clamp(nu.neuro + N.neuroPerWeek *
        clamp((N.neuroFloor - nu.micro) / N.neuroSpan, 0, 1), 0, 1);
    }
    nu.unfit = nu.neuro > N.neuroHard ? 0.80 : 1;

    // 5) 连续不足闩锁
    nu.badProtein = nu.protein < N.proteinBad ? nu.badProtein + 1 : 0;
    nu.badMicro = nu.micro < N.microBad ? nu.badMicro + 1 : 0;
    if (nu.badProtein >= N.malWeeks && nu.maln <= 0) {
      nu.maln = N.malWeeks;
      pushEvent(state, cfg, "nutrition", "营养", "营养不良已成常态",
        "连续 " + N.malWeeks + " 周蛋白低于 " + N.proteinBad + "，进入营养不良状态",
        "蛋白 " + r2(nu.protein) + " · 维矿 " + r2(nu.vit) + " · 微量 " + r2(nu.micro), true,
        null, "长期吃不饱，伤病恢复与免疫一起往下掉");
    }
    if (nu.maln > 0) nu.maln--;

    // 6) 防辐射：高速航行才累积，药剂只压得住一部分
    var radOn = !!(state.ship && state.ship.speedC > M.radSpeed);
    if (radOn) {
      state.health.rad = clamp(state.health.rad + M.radPerWeek *
        (1 - 0.30 * clamp(medCoverage, 0, 1)), 0, 1);
    } else {
      state.health.rad = Math.max(0, state.health.rad - 0.004);
    }
    var radNeed = radOn ? t0.awake * 0.002 * state.health.rad * 4 : 0;
    var radUse = Math.min(pools.rad, radNeed);
    pools.rad = Math.max(0, pools.rad - radUse);
    state.health.rad = Math.max(0, state.health.rad - radUse * M.doseCover.rad);

    // 7) 变异修复：眷属密度（含 bonus）超过 20% 才开，压眷属转化
    var thrallN = soc && soc.infection ? num0(soc.infection.thralls) : 0;
    var infectDensity = clamp(thrallN / Math.max(1, t0.awake), 0, 1);
    var mutNeed = infectDensity > 0.20 ? t0.awake * (infectDensity - 0.20) * 0.02 : 0;
    var mutUse = Math.min(pools.mut, mutNeed);
    pools.mut = Math.max(0, pools.mut - mutUse);
    if (mutUse > 0 && soc && soc.infection && num0(soc.infection.thralls) > 0) {
      var cut = Math.min(soc.infection.thralls, mutUse * M.mutThrallK);
      soc.infection.thralls = Math.max(0, soc.infection.thralls - cut);
      soc.infection.bonus = Math.max(0, num0(soc.infection.bonus) - cut);
    }

    // 8) DNA 修复：每 26 周一轮，神经损伤减半
    var dnaUse = 0;
    if (nu.neuro > 0.02 && state.weeks % M.dnaCourseWeeks === 0 && pools.dna >= M.dnaCourseDoses) {
      pools.dna -= M.dnaCourseDoses;
      dnaUse = M.dnaCourseDoses;
      nu.neuro = nu.neuro * 0.5;
    }

    // 9) 镇痛用药：眷属密度越高用得越多，供给不足的缺口进入戒断
    var infectPct = infectDensity * 100;
    ad.useTarget = t0.awake * clamp(A.useBase + A.usePerInfectPct * infectPct, 0, A.useCap);
    var painCap = pools.pain * M.doseCover.pain;
    ad.use = Math.min(ad.useTarget, painCap);
    pools.pain = Math.max(0, pools.pain - ad.use / M.doseCover.pain);
    var supplyRatio = ad.useTarget > 0 ? clamp(ad.use / ad.useTarget, 0, 1) : 1;

    // 10) 三档成瘾转化（人数为小数，显示时取整）
    var nAdd = Math.max(1, t0.awake);
    var newLight = A.newLightK * ad.use * (1 - Math.min(0.95, (ad.light + ad.mid + ad.heavy) / nAdd));
    var l2m = A.lightToMid * ad.light;
    var m2h = A.midToHeavy * ad.mid;
    ad.light = Math.max(0, ad.light + newLight - l2m - A.quitLight * ad.light);
    ad.mid = Math.max(0, ad.mid + l2m - m2h - A.quitMid * ad.mid);
    ad.heavy = Math.max(0, ad.heavy + m2h - A.quitHeavy * ad.heavy);

    // 11) 化学极乐：条件成立后社会自发进入，8 周一轮
    var heavyShare = ad.heavy / nAdd;
    var lmShare = (ad.light + ad.mid) / nAdd;
    if (!ad.blissUnlocked &&
        (heavyShare >= A.bliss.unlockHeavyShare || lmShare >= A.bliss.unlockLightMidShare)) {
      ad.blissUnlocked = true;
      pushEvent(state, cfg, "addiction", "成瘾", "化学极乐具备条件",
        "重度 " + (heavyShare * 100).toFixed(1) + "%、轻中合计 " + (lmShare * 100).toFixed(1) +
        "%，社会开始自行组织化学极乐",
        "解锁线：重度 ≥ 2% 醒态，或轻+中 ≥ 12%", true, null,
        "短期秩序好看，长期成瘾与出错率一起涨");
    }
    if (ad.blissWeeks > 0) {
      ad.blissWeeks--;
      ad.light += ad.light * A.bliss.lightPerWeek;
    } else if (ad.blissUnlocked && heavyShare >= A.bliss.unlockHeavyShare &&
               state.weeks >= ad.blissNext) {
      ad.blissWeeks = A.bliss.weeks;
      ad.blissNext = state.weeks + A.bliss.retryWeeks;
      pushEvent(state, cfg, "addiction", "成瘾", "化学极乐开始了",
        "接下来 " + A.bliss.weeks + " 周：秩序 +" + (A.bliss.orderGain * 100).toFixed(0) +
        "%、产出 −" + (A.bliss.prodLoss * 100).toFixed(0) + "%，轻症每周 +2%",
        "重度占比 " + (heavyShare * 100).toFixed(1) + "% ≥ 2%，触发社会自发极乐",
        true, { "秩序": Math.round(A.bliss.orderGain * 100) }, "这个秩序红利是借来的");
    }

    // 12) 戒断：供药不足时按档位触发，抵抗归零
    var shortfall = clamp(1 - supplyRatio, 0, 1);
    ad.withdraw.light = ad.light * A.withdrawRoll.light * shortfall;
    ad.withdraw.mid = ad.mid * A.withdrawRoll.mid * shortfall;
    ad.withdraw.heavy = ad.heavy * A.withdrawRoll.heavy * shortfall;
    var wTot = ad.withdraw.light + ad.withdraw.mid + ad.withdraw.heavy;

    // 13) 抵抗值与效果摘要
    var tot = ad.light + ad.mid + ad.heavy;
    var resist = tot > 0
      ? (A.resist.light * ad.light + A.resist.mid * ad.mid + A.resist.heavy * ad.heavy) / tot
      : 0;
    if (ad.blissWeeks > 0) resist = Math.min(0.95, resist + A.bliss.resistBonus);
    if (wTot > 0) resist = 0;
    ad.resistance = r3(resist);
    // 监狱 B 类变异（古神耐受）提供全船抵抗加成，直接进入低语/梦中侵蚀公式；戒断时不给
    if (wTot <= 0 && global.XuanShuPrison && global.XuanShuPrison.resistBonus) {
      var pShield = global.XuanShuPrison.resistBonus(state, cfg);
      if (!isNum(pShield)) pShield = 0;
      if (pShield > 0) ad.resistance = r3(Math.min(0.95, ad.resistance + pShield));
    }
    var fitPen = tot > 0
      ? (A.fitPenalty.light * ad.light + A.fitPenalty.mid * ad.mid + A.fitPenalty.heavy * ad.heavy) / nAdd
      : 0;
    var obey = tot > 0
      ? (A.obey.light * ad.light + A.obey.mid * ad.mid + A.obey.heavy * ad.heavy) / nAdd
      : 0;
    var errK = tot > 0
      ? (A.errorK.light * ad.light + A.errorK.mid * ad.mid + A.errorK.heavy * ad.heavy) / nAdd
      : 0;
    var dMul = tot > 0
      ? (A.deathMul.light * ad.light + A.deathMul.mid * ad.mid + A.deathMul.heavy * ad.heavy) / nAdd
      : 0;
    ad.effects = {
      fitMul: clamp(1 - fitPen, 0.55, 1),
      obey: clamp(obey, 0, 0.18),
      errorK: errK,
      deathMul: dMul,
      resist: ad.resistance,
      bliss: ad.blissWeeks > 0
    };

    // 14) 戒断破坏事件：归因到人数最多的舱段（按醒态比例摊，取最大舱段）
    if (wTot >= 1 && state.weeks - ad.lastWithdrawLog >= A.withdrawLogWeeks) {
      ad.lastWithdrawLog = state.weeks;
      var zname = "居住环";
      if (global.XuanShuPeople && state.people) {
        var br = global.XuanShuPeople.brief(state, cfg);
        var zlist = (br && br.zones) || [];
        var top = null;
        zlist.forEach(function (z) { if (!top || z.total > top.total) top = z; });
        if (top) zname = top.name;
      }
      var dmg = Math.min(0.02, A.withdrawOrderK * wTot);
      state.order = clamp(state.order - dmg, 0.05, 1);
      pushEvent(state, cfg, "withdraw", "事件", "戒断暴动 · " + zname,
        "缺药，本周 " + Math.round(wTot) + " 人进入戒断，" + zname +
        "发生破坏事件（破坏设备/斗殴），秩序 −" + (dmg * 100).toFixed(1) + "%",
        "供药率 " + Math.round(supplyRatio * 100) + "%，戒断触发 轻 5% / 中 12% / 重 25%",
        true, { "秩序": -Math.round(dmg * 1000) / 10 },
        "戒断期间抵抗归零，休眠舱的梦中压力反而更大");
    }

    // 15) 年度台账：一周一行太吵，满一年记一条
    state.vitals = {
      week: state.weeks,
      ration: r2(ration),
      protein: r2(nu.protein), vit: r2(nu.vit), micro: r2(nu.micro),
      imm: r2(nu.imm), fit: r2(nu.fit), neuro: r3(nu.neuro), maln: nu.maln > 0,
      rad: r3(state.health.rad),
      use: Math.round(ad.use), useTarget: Math.round(ad.useTarget),
      light: Math.round(ad.light), mid: Math.round(ad.mid), heavy: Math.round(ad.heavy),
      withdraw: Math.round(wTot), resist: ad.resistance,
      blissWeeks: ad.blissWeeks,
      dnaUse: dnaUse, nutriUse: r2(nutriUse), radUse: r2(radUse), mutUse: r2(mutUse)
    };
    if (state.weeks % cfg.time.weeksPerYear === 0) {
      pushEvent(state, cfg, "addiction", "成瘾", "药剂与成瘾台账",
        "成瘾 轻 " + Math.round(ad.light) + " / 中 " + Math.round(ad.mid) +
        " / 重 " + Math.round(ad.heavy) + "，用药 " + Math.round(ad.use) + " 人",
        "抵抗 " + ad.resistance.toFixed(2) + " · 营养 蛋白 " + r2(nu.protein) +
        " / 维矿 " + r2(nu.vit) + " / 微量 " + r2(nu.micro) + " · 神经损伤 " + r3(nu.neuro) +
        (ad.blissWeeks > 0 ? " · 化学极乐剩 " + ad.blissWeeks + " 周" : ""),
        false, null, "药剂池：镇痛 " + Math.round(pools.pain) + " · 营养 " +
        Math.round(pools.nutri) + " · 防辐射 " + Math.round(pools.rad) + " · 变异 " +
        Math.round(pools.mut) + " · DNA " + Math.round(pools.dna) + " 份");
    }
    return state.vitals;
  }

  function num0(v, d) { return isNum(v) ? v : (isNum(d) ? d : 0); }

  function killProportional(state, cfg, fraction) {
    var n = 0;
    cfg.population.groups.forEach(function (g) {
      var s = state.groups[g.id];
      var d = s.awake * fraction;
      s.awake = Math.max(0, s.awake - d);
      n += d;
    });
    return n;
  }

  function popDue(arr, week) {
    var n = 0;
    for (var i = arr.length - 1; i >= 0; i--) {
      if (arr[i] <= week) { arr.splice(i, 1); n++; }
    }
    return n;
  }

  // 周步长下把速率直接向下取整会削掉年吞吐量；把不足一人的余数留到下一周，
  // 保证 12 次月步与 52 次周步的年总量一致。
  function takeInteger(state, key, amount) {
    var v = amount + (state.flowCarry[key] || 0);
    var n = Math.floor(v);
    state.flowCarry[key] = v - n;
    return n;
  }

  // 只在「条件从假变真」时记一条，避免同类预警刷屏
  function latchEvent(state, cfg, key, condition, type, level, title, text, basis, deltas, note) {
    if (condition) {
      if (!state.latches[key]) {
        state.latches[key] = true;
        pushEvent(state, cfg, type, level, title, text, basis, true, deltas, note);
      }
    } else {
      state.latches[key] = false;
    }
  }

  /* ---------------- 初始化 ---------------- */

  function createState(cfg, seed) {
    var groups = {};
    cfg.population.groups.forEach(function (g) {
      groups[g.id] = { awake: g.awake, dormant: g.dormant };
    });
    var state = {
      loop: 1,
      weeks: 0,
      rngA: seed >>> 0,
      groups: groups,
      stocks: {
        food: cfg.food.stockInit,
        water: cfg.water.stockInit,
        drug: cfg.hibernation.drugInit,
        metal: cfg.metal.stockInit
      },
      infra: {
        hydro: cfg.food.hydroInit,
        pods: cfg.hibernation.podsInit,
        clonePods: cfg.clone.podsInit
      },
      order: cfg.order.init,
      wear: 0,
      // 航速：首页三项操控写这里，能耗 / 磨损 / 遭遇权重都读它
      // 工质：推进剂储量（不是化学燃料），飞行按周扣，剩余量换算成可飞航程
      ship: {
        speedC: (cfg.ship && cfg.ship.speedC) || 0.045,
        propellant: (cfg.ship && cfg.ship.propellant && isNum(cfg.ship.propellant.initT))
          ? cfg.ship.propellant.initT : 2400
      },
      phase: 0,
      phaseUp: 0,
      phaseDown: 0,
      inputs: clone(cfg.inputs),
      projects: { hydro: [], pods: [], clonePods: [] },
      cooldown: {},
      events: [],
      logRing: [],
      series: [],
      flags: { atrocity: false },
      latches: {},
      clonePause: 0,
      streaks: { badRation: 0, extreme: 0, strike: 0 },
      budget: { hydro: 0, pods: 0, clone: 0 },
      buildAcc: { hydro: 0, pods: 0, clonePods: 0 },
      // 整数人口流的余数累积：每周向下取整会把年吞吐量削掉一截，
      // 这里把不足一人的部分留到下周，保证 52 周与 12 月的年总量一致。
      flowCarry: { entry: 0, wake: 0, podStart: 0 },
      maint: { sinceFault: 0, active: false, repairLeft: 0, mttr: cfg.maintenance.mttrWeeks,
               faults: 0, lastCycle: 0, lastShift: 0, lastSupply: 0, lastQuarantine: 0 },
      last: {}
    };
    state.dream = { pressure: 0, infected: 0, lastLog: -99 };
    state.wellbeing = null;
    state.maintFund = { week: 0, need: 0, budget: 0, fromStock: 0, spend: 0 };
    // 药剂池 / 营养 / 成瘾 / 辐射：旧档缺字段时由 ensureVitals 补默认
    ensureVitals(state, cfg);
    state.vitals = null;
    if (global.XuanShuEncounter && global.XuanShuEncounter.ensureTrade) {
      global.XuanShuEncounter.ensureTrade(state, cfg);
    }
    state.last = {
      rationActual: 1,
      energy: cfg.energy.baseMW,
      agriMW: 30,
      indMW: 22,
      medCoverage: 0.8,
      production: 0,
      consumption: 0,
      shortfall: 0,
      entries: 0,
      wakes: 0,
      births: 0,
      cloneOut: 0,
      deaths: 0,
      targetDorm: Math.round(cfg.population.groups.reduce(function (a, g) {
        return a + g.awake + g.dormant;
      }, 0) * cfg.inputs.dormancyTarget),
      metalSupply: cfg.metal.supplyTpy,
      maintGap: 0
    };
    if (global.XuanShuSociety && cfg.society && cfg.society.enabled !== false) {
      state.society = global.XuanShuSociety.create(cfg);
    }
    // 随机判定槽位 / 日志（与 rngA 一样是状态的一部分，随导出/导入走）
    if (global.XuanShuJudge) state.judge = global.XuanShuJudge.ensure(state, cfg);
    // 个体层：真实位置名册（人数变化时同步，位置按周确定性推导）
    if (global.XuanShuPeople && cfg.people && cfg.people.enabled !== false) {
      state.people = global.XuanShuPeople.create(cfg);
    }
    // 玩家身份层：未选身份前不推进时间，但状态先建好，便于前端展示三选一
    if (global.XuanShuPlayer && cfg.player && cfg.player.enabled !== false) {
      state.player = global.XuanShuPlayer.create(cfg);
    }
    // 奇遇与牌库：牌库进度、运气、历史都是长期状态，随存档走
    if (global.XuanShuEncounter && cfg.encounter && cfg.encounter.enabled !== false) {
      state.encounter = global.XuanShuEncounter.create(cfg);
    }
    // 古神契约：契约、神恩、神噬跨轮保留
    if (global.XuanShuGods && cfg.gods && cfg.gods.enabled !== false) {
      state.gods = global.XuanShuGods.create(cfg);
    }
    // 监狱与囚徒：名册随轮内清空，俘虏池与处决统计跨轮由 run 层另记
    if (global.XuanShuPrison && cfg.prison && cfg.prison.enabled !== false) {
      state.prison = global.XuanShuPrison.create(cfg);
    }
    // 千年节点 / 自动推演 / 胜负：开局未选身份前为 started=false，时间闸门关闭
    if (global.XuanShuRun && cfg.run && cfg.run.enabled !== false) {
      state.run = global.XuanShuRun.create(cfg);
    }
    pushSeries(state, cfg);
    return state;
  }

  // 判定压力：全槽位取最大值（与磨损无关），供年度序列采样
  function judgePressureOf(state) {
    var slots = state.judge && state.judge.slots;
    if (!slots) return 0;
    var max = 0;
    Object.keys(slots).forEach(function (k) {
      var p = slots[k] && slots[k].pressure;
      if (typeof p === "number" && isFinite(p) && p > max) max = p;
    });
    return Math.round(max * 1000) / 1000;
  }

  function pushSeries(state, cfg) {
    var t = totals(state, cfg);
    var groups = {};
    var groupsTotal = {};
    cfg.population.groups.forEach(function (g) {
      groups[g.id] = state.groups[g.id].awake;
      groupsTotal[g.id] = state.groups[g.id].awake + state.groups[g.id].dormant;
    });
    state.series.push({
      t: Math.round(((state.loop - 1) * cfg.time.loopYears + state.weeks / cfg.time.weeksPerYear) * 100) / 100,
      loop: state.loop,
      loopYear: Math.round(state.weeks / cfg.time.weeksPerYear * 100) / 100,
      total: t.total,
      awake: t.awake,
      dormant: t.dormant,
      groups: groups,
      groupsTotal: groupsTotal,
      food: state.stocks.food,
      foodDays: foodDays(state, cfg, t),
      water: state.stocks.water,
      waterDays: waterDays(state, cfg, t),
      drug: state.stocks.drug,
      metal: state.stocks.metal,
      hydro: state.infra.hydro,
      pods: state.infra.pods,
      clonePods: state.infra.clonePods,
      order: state.order,
      wear: state.wear,
      judgePressure: judgePressureOf(state),
      phase: state.phase,
      ration: state.last.rationActual,
      energy: state.last.energy,
      medCoverage: state.last.medCoverage,
      // 药剂 / 成瘾 / 营养：年度曲线直接可画
      addict: state.addict ? Math.round(state.addict.light + state.addict.mid + state.addict.heavy) : 0,
      addictHeavy: state.addict ? Math.round(state.addict.heavy) : 0,
      resist: state.addict ? state.addict.resistance : 0,
      protein: state.nutrition ? state.nutrition.protein : 1,
      neuro: state.nutrition ? state.nutrition.neuro : 0,
      mortgageN: state.geneMortgage && state.geneMortgage.active ? Math.round(state.geneMortgage.n) : 0
    });
    if (state.series.length > cfg.time.seriesCap) state.series.shift();
  }

  /* ---------------- 周期事件（周级） ---------------- */

  // 返回本周的产出系数：设备故障停机期间农环降载。
  // 不用随机数：故障间隔由磨损与维修缺口确定性地缩短，MTTR 落在配置的 1–6 周内。
  function stepMaintenance(state, cfg) {
    var M = cfg.maintenance;
    if (!M || M.enabled === false) return 1;
    var m = state.maint;
    var w = state.weeks;
    var yieldF = 1;

    // 故障停机模型可单独开关：只记周期事件时，数值与 v0.1 完全一致
    if (M.downtime === false) {
      // 跳过故障判定，但仍推进周期事件（见下）
    } else if (m.active) {
      m.repairLeft--;
      yieldF = M.downtimeYield;
      if (m.repairLeft <= 0) {
        m.active = false;
        m.sinceFault = 0;
        pushEvent(state, cfg, "maint_done", "维修", "设备修好了",
          "修了 " + m.mttr + " 周，农环恢复正常产量",
          "MTTR 实际 " + m.mttr + " 周（基准 " + M.mttrWeeks + " 周）", true);
      }
    } else {
      m.sinceFault++;
      var wear = clamp(state.wear, 0, 1);
      var gap = clamp(state.last.maintGap || 0, 0, 1);
      var interval = Math.max(M.minIntervalWeeks, Math.round(
        M.baseIntervalWeeks * (1 - M.wearShorten * wear - M.gapShorten * gap)));
      if (m.sinceFault >= interval) {
        // 阈值（故障间隔）已到，是否真的坏由通用判定层决定：
        // 未成立 → 设备带病继续跑，压力累积，冷却后再判。
        var jr = global.XuanShuJudge
          ? global.XuanShuJudge.check(state, cfg, "maint_fault", {
              wear: wear, gap: gap,
              age: clamp(m.sinceFault / Math.max(1, interval), 0, 2)
            }, { note: "故障间隔 " + interval + " 周" })
          : null;
        if (!jr || jr.allow) {
          var sev = clamp(wear + gap, 0, 1);
          m.mttr = clamp(Math.round(M.mttrWeeks + (M.mttrMaxWeeks - M.mttrWeeks) * sev),
            M.mttrMinWeeks, M.mttrMaxWeeks);
          m.repairLeft = m.mttr;
          m.active = true;
          m.faults++;
          yieldF = M.downtimeYield;
          pushEvent(state, cfg, "maint_fault", "维修", "设备停摆 · 抢修中",
            "农环一组停了，粮食产出只剩 " + Math.round(M.downtimeYield * 100) + "%",
            "磨损 " + wear.toFixed(2) + "、维修缺口 " + Math.round(gap * 100) +
            "% → 故障间隔 " + interval + " 周，MTTR " + m.mttr + " 周" +
            (jr ? "；判定 p=" + jr.probability.toFixed(2) + "，随机数 " + jr.rand.toFixed(3) : ""), true,
            null, "设备老化，农环停了一组");
        } else if (jr.judged) {
          // 判定未成立：保留基数（不清零），冷却结束后再判
          m.sinceFault = interval;
        }
      }
    }

    if (w - m.lastCycle >= M.cycleWeeks) {
      m.lastCycle = w;
      pushEvent(state, cfg, "maint_cycle", "维修", "例行检修",
        "这一轮例行检修做完了，没发现结构性问题",
        "每 " + M.cycleWeeks + " 周一个检修窗口", true);
    }
    if (w - m.lastShift >= M.shiftWeeks) {
      m.lastShift = w;
      pushEvent(state, cfg, "shift", "轮班", "换班了",
        "换班完成，现在 " + Math.round(totals(state, cfg).working) + " 人在岗",
        "轮班周期 " + M.shiftWeeks + " 周", true);
    }
    if (w - m.lastSupply >= M.supplyWeeks) {
      m.lastSupply = w;
      // 补给窗口本身是周期事件；是否真的到货走通用判定层：
      // route=0（行星补给切断）时靠累计压力仍有小概率到货。
      var sjr = global.XuanShuJudge
        ? global.XuanShuJudge.check(state, cfg, "supply_window",
            { route: state.inputs.planetCut ? 0 : 1 }, { note: "补给窗口 " + M.supplyWeeks + " 周" })
        : null;
      var arrived = !sjr || sjr.allow;
      if (arrived) {
        var se = (cfg.judge && cfg.judge.items && cfg.judge.items.supply_window &&
          cfg.judge.items.supply_window.successEffect) || {};
        var addF = (se.foodT != null ? se.foodT : (M.supplyFoodT || 0));
        var addM = (se.metalT != null ? se.metalT : (M.supplyMetalT || 0));
        if (addF > 0) state.stocks.food = cfg.food.cap > 0
          ? Math.min(cfg.food.cap, state.stocks.food + addF) : (state.stocks.food + addF);
        if (addM > 0) state.stocks.metal = Math.min(cfg.metal.cap, state.stocks.metal + addM);
        pushEvent(state, cfg, "supply", "补给", "补给到了",
          "行星来的货已入库：粮食 +" + addF + " 吨、金属 +" + addM + " 吨",
          "补给节奏 " + M.supplyWeeks + " 周" +
          (sjr ? "；判定 p=" + sjr.probability.toFixed(2) : ""), true,
          { "粮食": addF }, "行星来货，粮食和金属补了一批");
      } else {
        pushEvent(state, cfg, "supply", "补给", "这次补给没到",
          state.inputs.planetCut ? "行星补给线被切断了，这趟没有货" : "航线延误，这趟没有货",
          "补给节奏 " + M.supplyWeeks + " 周；判定 p=" +
          (sjr ? sjr.probability.toFixed(2) : "—") + "，压力 " +
          (sjr ? sjr.pressure.toFixed(2) : "—") + "，下个窗口更易到货", true,
          null, "补给没到，库存只能继续往下掉");
      }
    }
    if (w - m.lastQuarantine >= M.quarantineWeeks) {
      m.lastQuarantine = w;
      var ishare = (state.society && state.society.infection)
        ? (state.society.infection.share || 0) : 0;
      pushEvent(state, cfg, "quarantine", "检疫",
        ishare >= M.quarantineShare ? "全船检疫升级" : "例行检疫",
        ishare >= M.quarantineShare
          ? Math.round(ishare * 100) + "% 的人已经感染，隔离区扩大"
          : "抽检完了，没发现新的感染者",
        "检疫周期 " + M.quarantineWeeks + " 周", true);
    }
    return yieldF;
  }

  /* ---------------- 周结算 ---------------- */

  function stepWeek(state, cfg) {
    var dt = 1 / cfg.time.weeksPerYear;
    // 随机判定层：先结算冷却结束后的压力衰减
    if (global.XuanShuJudge) global.XuanShuJudge.tick(state, cfg);
    var I = state.inputs;
    // 噪声是「每 tick 的离散扰动」，不能按月直接搬：52 次弱扰动会显著平滑于 12 次。
    // 按「年度方差守恒」折算振幅：a_week = a_month × sqrt(12/52)，而不是除以 4.33。
    var NS = Math.sqrt(cfg.time.monthsPerYear / cfg.time.weeksPerYear);
    var noise = function (amp) { return 1 + amp * NS * (nextRand(state) * 2 - 1); };

    // 奇遇卡的限时修正（state.encounter.mods）：只读查询，不消耗随机数
    var ENC = (global.XuanShuEncounter && state.encounter) ? global.XuanShuEncounter : null;
    var mMul = function (k, b) { return ENC ? ENC.modMul(state, k, b) : b; };
    var mAdd = function (k, b) { return ENC ? ENC.modAdd(state, k, b) : b; };
    // 古神修正（主约 100%，旁约祝福/诅咒 50%）
    var GOD = (global.XuanShuGods && state.gods && state.gods.enabled) ? global.XuanShuGods : null;
    var gMul = function (k, b) { return GOD ? GOD.gMul(state, cfg, k, b) : b; };

    // 先交付到期项目；同类交付按批次累计，避免每交付一个就刷一条事件
    var doneHydro = popDue(state.projects.hydro, state.weeks);
    var donePods = popDue(state.projects.pods, state.weeks);
    var doneClone = popDue(state.projects.clonePods, state.weeks);
    if (!state.buildAcc) state.buildAcc = { hydro: 0, pods: 0, clonePods: 0 };
    state.buildAcc.hydro += doneHydro;
    state.buildAcc.pods += donePods;
    state.buildAcc.clonePods += doneClone;
    state.infra.hydro += doneHydro;
    state.infra.pods += donePods;
    state.infra.clonePods += doneClone;

    if (state.buildAcc.hydro >= 25) {
      pushEvent(state, cfg, "build_hydro", "建设", "水培扩建完成",
        "新增 " + state.buildAcc.hydro + " 个栽培单元，总数 " + state.infra.hydro +
        "，折合 " + (state.buildAcc.hydro * 1000).toLocaleString("en-US") + " 平方米",
        "金属配额到位，工期 " + cfg.metal.hydroLeadWeeks + " 周", true, null,
        "水培多了一批，粮食产出往上走");
      state.buildAcc.hydro = 0;
    }
    if (state.buildAcc.pods >= 50) {
      pushEvent(state, cfg, "build_pods", "建设", "休眠舱造好了",
        "新增 " + state.buildAcc.pods + " 个休眠位，总数 " + state.infra.pods,
        "工期 " + cfg.hibernation.podLeadWeeks + " 周", true, null,
        "能多冻 " + state.buildAcc.pods + " 个人");
      state.buildAcc.pods = 0;
    }
    if (state.buildAcc.clonePods >= 6) {
      pushEvent(state, cfg, "build_clone", "建设", "克隆槽造好了",
        "新增 " + state.buildAcc.clonePods + " 个培育筒，总数 " + state.infra.clonePods,
        "工期 " + cfg.clone.podLeadWeeks + " 周", true, null,
        "克隆产能多了一截");
      state.buildAcc.clonePods = 0;
    }

    var t0 = totals(state, cfg);

    // 工质：按本周航速扣推进剂，扣到 0 为止（不反噬其它系统）
    if (state.ship) {
      var pUse = propellantUse(cfg, state.ship.speedC);
      state.ship.propellant = Math.max(0,
        (isNum(state.ship.propellant) ? state.ship.propellant : 0) - pUse.mWeek);
    }

    // 能源：磨损先削一截，航速再按倍率抬（r=1 时与旧版完全一致）
    var speedRatio = (state.ship && cfg.ship && cfg.ship.speedBaseC)
      ? state.ship.speedC / cfg.ship.speedBaseC : 1;
    var energy = cfg.energy.baseMW * (1 - 0.15 * state.wear) *
      (1 + ((cfg.ship && cfg.ship.energyK) || 0) * (speedRatio - 1));
    var lifeMW = Math.min(cfg.energy.lifeMW, energy);
    var rest = Math.max(0, energy - lifeMW);
    // 休眠维持：舱位电耗先扣，剩余才给农业/工业
    var dormantMW = Math.min(t0.dormant * ((cfg.hibernation && cfg.hibernation.mWPerDormant) || 0), rest);
    rest = Math.max(0, rest - dormantMW);
    var agriMW = rest * I.agriShare;
    var indMW = rest * (1 - I.agriShare);
    var metalSupplyY = (cfg.metal.supplyTpy * clamp(indMW / cfg.energy.industryFullMW, 0, 1)) +
      mAdd("metalPerYear", 0);

    // 医疗
    var medCoverage = clamp(
      (cfg.medical.coverageBase + cfg.medical.coverageGain * I.medical) *
      clamp(lifeMW / cfg.energy.lifeMW, 0.5, 1) *
      (1 - 0.10 * state.wear), 0, 1
    ) + mAdd("medCoverage", 0);
    medCoverage = clamp(medCoverage, 0, 1);

    // 社会层：先结算服从 / 哗变 / 感染，再让秩序与产能吃它的反馈
    if (state.society && global.XuanShuSociety) {
      global.XuanShuSociety.step(state, cfg, {
        ration: state.last.rationActual,
        med: medCoverage,
        wear: state.wear,
        order: state.order,
        awake: t0.awake,
        energy: energy,
        maintGap: state.last.maintGap || 0,
        week: state.weeks
      });
    }

    // 周期事件（周级）：设备故障 / 维修、轮班、补给、隔离检疫
    var maintYield = stepMaintenance(state, cfg);
    var soc = state.society;

    // 基因抵押：逐年抬升秩序惩罚，到期自动赎回或违约
    if (global.XuanShuEncounter && global.XuanShuEncounter.mortgageTick) {
      global.XuanShuEncounter.mortgageTick(state, cfg);
    }
    var GM = state.geneMortgage || null;

    // 药剂 / 营养 / 成瘾：先结算本周的用药与成瘾，再让产出、秩序、死亡吃它的反馈
    stepVitals(state, cfg, t0, medCoverage, soc);
    var AD = state.addict.effects || { fitMul: 1, obey: 0, errorK: 0, deathMul: 0, resist: 0, bliss: false };

    // 梦中侵染：眷属与低语把休眠者拖出梦境；医疗覆盖取上一周值
    stepDream(state, cfg, soc, state.last ? state.last.medCoverage : 0.5);

    // 粮食产出
    // 水培高度自动化：在岗人口只影响边际人力，避免「冻 400 人就把粮食冻没」
    var laborF = (0.80 + 0.20 * clamp(t0.working / cfg.population.laborFull, 0, 1)) *
      (0.75 + 0.25 * clamp(state.order / 0.8, 0, 1));
    var energyF = clamp(agriMW / cfg.food.agriMWFull, 0, 1);
    var waterF = clamp(state.stocks.water / cfg.food.waterBuffer, 0, 1);
    var nutrientF = 0.95 + 0.05 * medCoverage;
    var production = state.infra.hydro * cfg.food.unitYieldTpy *
      energyF * waterF * laborF * nutrientF;
    if (state.streaks.strike > 0) production *= 0.85;
    // 社会层反馈：哗变等级、感染面、机器夺权、封锁/召唤后的产出系数
    if (soc) {
      // 哗变按「受影响人口覆盖度」折算，避免单个部门 L2 就砍掉全船 35% 产出
      var pm = cfg.society.ladder.prodMul[soc.mutiny.level] || 1;
      var pmEff = 1 - (1 - pm) * clamp(soc.mutiny.coverage || 0, 0, 1);
      production *= pmEff *
        (1 - 0.25 * clamp(soc.infection.share || 0, 0, 1)) *
        (1 - cfg.society.machine.prodLoss * Math.min(3, soc.machine.depts.length)) *
        (soc.effects.prodMul || 1) * gMul("prodMul", 1);
    }
    // 废弃宜居星「采集种源」：限时粮食产出加成（v6.31）
    if (state.encounter && state.encounter.foodBonus && state.weeks < state.encounter.foodBonus.until) {
      production *= clamp(num(state.encounter.foodBonus.mul, 1), 1, 1.2);
    }
    production *= maintYield;
    // 营养（体能 fit、神经损伤）与成瘾（三档体能惩罚、化学极乐）对出力的折损
    if (state.nutrition) {
      production *= clamp(state.nutrition.fit * (state.nutrition.unfit || 1), 0.5, 1);
    }
    production *= AD.fitMul;
    if (AD.bliss) production *= (1 - cfg.addict.bliss.prodLoss);
    // 基因抵押：被抵押人群产出 ×0.85，按醒态占比摊到全船
    if (GM && GM.active && t0.awake > 0) {
      production *= (1 - (1 - cfg.trade.mortgage.prodMul) * clamp(GM.n / t0.awake, 0, 1));
    }
    // v1.2 长期折损：年份不可逆衰减 + 农环老化 + 人口结构 + 船况磨损
    // 四项独立相乘；只作用于水培产出，行星来货仍按 planetTpy 恒定。
    var FD = cfg.food.decay;
    if (FD) {
      var absY = (state.loop - 1) * cfg.time.loopYears + state.weeks / cfg.time.weeksPerYear;
      var ageLoss = clamp((FD.yearRate || 0) * absY, 0, 1);
      var ringLoss = (FD.ringK || 0) * clamp(absY / (FD.ringYears || 1), 0, 1);
      var structLoss = (FD.structK || 0) *
        (1 - clamp(t0.working / cfg.population.laborFull, 0, 1));
      var wearLoss = (FD.wearK || 0) * clamp(state.wear, 0, 1);
      // v1.2：maxLoss 只封顶「年份 + 农环」这类不可逆的基础产能折损；
      // 磨损与人口结构属于当期船况/在岗状态，按实际值叠加，不并进同一个上限。
      // 这样勤维护、保住人口结构的经营路线不会被基础上限之外的部分二次惩罚。
      var baseLoss = Math.min(FD.maxLoss == null ? 0.12 : FD.maxLoss, ageLoss + ringLoss);
      var decayF = 1 - clamp(baseLoss + structLoss + wearLoss, 0, 0.95);
      production *= decayF;
    }
    var planet = I.planetCut ? 0 : (cfg.food.planetTpy + mAdd("foodPerYear", 0));

    // 粮食结算：库存永不为负
    var baseDemand = t0.awake * cfg.food.perCapitaTpy +
      t0.dormant * cfg.food.perCapitaTpy * cfg.food.dormantFactor;
    var standardNeed = baseDemand * dt;
    var need = standardNeed * I.ration * mMul("foodUse", 1) * gMul("foodUse", 1);
    // v1.2 储备自然损耗：按现存库存的年率折损，库存越高损耗越多
    var spoil = cfg.food.spoilagePerYear || 0;
    if (spoil > 0) state.stocks.food *= Math.max(0, 1 - spoil * dt);
    var available = state.stocks.food + (production + planet) * dt;
    var consumed = Math.min(need, available);
    var rationActual = standardNeed > 0 ? clamp(consumed / standardNeed, 0, 1.2) : 1;
    state.stocks.food = Math.max(0, available - consumed);
    // cap > 0 才封顶；v1.2 默认 cap=0，天花板已拆，由损耗而非硬上限约束库存
    if (cfg.food.cap > 0) state.stocks.food = Math.min(state.stocks.food, cfg.food.cap);
    var shortfall = need - consumed;

    // 水
    var throughput = t0.awake * cfg.water.perCapitaAwake +
      t0.dormant * cfg.water.perCapitaDormant;
    // 水：闭环回收率 + 可回收比例（「闭环回收突破」这类长期修正）
    var recycle = clamp(cfg.water.recycle + mAdd("waterRecycle", 0) + mAdd("waterRecover", 0), 0, 0.9995) *
      clamp(lifeMW / cfg.energy.lifeMW, 0.60, 1);
    var loss = throughput * (1 - recycle);
    state.stocks.water = clamp(state.stocks.water + (cfg.water.supplyTpy - loss) * dt, 0, cfg.water.cap);

    // 死亡修正
    var extremeActive = !!I.extreme && state.phase >= 3;
    var mal = cfg.death.malK * Math.pow(1 - Math.min(1, rationActual), 2) * (extremeActive ? 0.85 : 1);
    // 免疫不足放大疾病：imm=1.0 时系数 1.0，营养不良再叠 25%
    var NU = state.nutrition || {};
    var imm = isNum(NU.imm) ? NU.imm : 1;
    var nutriDisease = clamp(1 + cfg.nutrition.diseaseK * (1 - imm), 0.70, 1.80) *
      (NU.maln > 0 ? 1.25 : 1);
    var disease = cfg.death.diseaseK * (1 - medCoverage) * (1 + 1.5 * Math.max(0, 1 - rationActual)) *
      nutriDisease;
    var conflict = state.order < 0.45
      ? cfg.death.conflictK * Math.pow((0.45 - state.order) / 0.45, 2) : 0;
    var accident = cfg.death.accidentBase + cfg.death.accidentWear * state.wear;
    var radDeath = cfg.med.radDeathK * clamp(state.health ? state.health.rad : 0, 0, 1);
    var extra = mal + disease + conflict + accident + radDeath;

    // 死亡
    var weekDeaths = 0;
    cfg.population.groups.forEach(function (g) {
      var s = state.groups[g.id];
      var rate = g.mortality * (1 + (AD.deathMul || 0));
      if (GM && GM.active && !g.clone) {
        rate *= 1 + cfg.trade.mortgage.deathMul * clamp(GM.n / Math.max(1, t0.awake), 0, 1);
      }
      if (g.clone) rate = g.mortality / clamp(rationActual, 0.35, 1);
      var d = Math.min(s.awake, s.awake * (rate + extra) * dt * noise(0.08));
      s.awake -= d;
      weekDeaths += d;
      var dd = Math.min(s.dormant, s.dormant * cfg.hibernation.dormantMortality * dt * noise(0.10));
      s.dormant -= dd;
      weekDeaths += dd;
    });

    // 出生（全部进未定）
    var birthsY = I.birthQuota *
      clamp((rationActual - 0.5) / 0.4, 0, 1) *
      (0.6 + 0.4 * medCoverage) *
      (0.7 + 0.3 * clamp(state.order / 0.8, 0, 1)) *
      noise(0.10) * mMul("birthMul", 1) * gMul("birthMul", 1);
    state.groups[cfg.population.undecidedId].awake += birthsY * dt;

    // 成熟：未定 → 在岗
    var und = state.groups[cfg.population.undecidedId];
    var mat = Math.min(und.awake, und.awake * cfg.population.maturationRate * dt);
    und.awake -= mat;
    Object.keys(cfg.population.maturationShares).forEach(function (id) {
      state.groups[id].awake += mat * cfg.population.maturationShares[id];
    });

    // 克隆
    var cloneOutY = state.infra.clonePods * cfg.clone.outputPerPodYear * I.cloneBatch *
      clamp((rationActual - 0.45) / 0.4, 0, 1) *
      clamp(energy / cfg.energy.baseMW, 0, 1) *
      (0.85 + 0.15 * medCoverage) * mMul("cloneMul", 1) * gMul("cloneMul", 1);
    var t1 = totals(state, cfg);
    var cloneShareNow = (state.groups.clone.awake + state.groups.clone.dormant) / Math.max(1, t1.total);
    if (state.clonePause > 0) {
      state.clonePause--;
      cloneOutY = 0;
    } else if (cloneShareNow >= cfg.clone.capShare) {
      state.clonePause = cfg.clone.capPauseWeeks;
      cloneOutY = 0;
    }
    var cloneCapped = state.clonePause > 0 || cloneShareNow >= cfg.clone.capShare;
    var cloneM = cloneOutY * dt;
    state.groups.clone.awake += cloneM * (1 - cfg.clone.nobleShare);
    state.groups.noble.awake += cloneM * cfg.clone.nobleShare;

    // 休眠进出
    var t2 = totals(state, cfg);
    var targetDorm = t2.total * I.dormancyTarget;
    var delta = targetDorm - t2.dormant;
    var entries = 0, wakes = 0, reviveFails = 0;
    // v6.37：休眠资格只认 population.sleepEligible；平民、克隆人、未定不在名单里，永远醒着。
    // 机器人不占舱位、不进 groups，天然不参与。
    var sleepIds = (function () {
      var list = cfg.population && cfg.population.sleepEligible;
      if (Array.isArray(list)) return list.slice();
      return cfg.population.groups
        .filter(function (g) { return g.id !== cfg.population.undecidedId; })
        .map(function (g) { return g.id; });
    })();
    var workingIds = cfg.population.groups
      .filter(function (g) {
        return g.id !== cfg.population.undecidedId && sleepIds.indexOf(g.id) >= 0;
      })
      .map(function (g) { return g.id; });
    // 常规轮换不得把在岗骨干全部送进舱：贵族至少留 minAwake 人醒着管理。
    var groupKeep = {};
    cfg.population.groups.forEach(function (g) { groupKeep[g.id] = g.minAwake || 0; });
    var famineActive = !!(state.run && state.run.famine && state.run.famine.active);

    if (delta > 0) {
      var wantRaw = Math.min(
        delta,
        cfg.hibernation.entryPerWeek,
        Math.max(0, state.infra.pods - t2.dormant),
        state.stocks.drug / cfg.hibernation.drugPerEntry,
        Math.max(0, t2.awake - cfg.population.minAwake),
        t2.awake * 0.02
      );
      var want = takeInteger(state, "entry", wantRaw);
      if (want > 0) {
        var pool = 0;
        workingIds.forEach(function (id) {
          pool += Math.max(0, state.groups[id].awake - groupKeep[id]);
        });
        if (pool > 0) {
          var take = Math.min(want, pool);
          workingIds.forEach(function (id) {
            var free = Math.max(0, state.groups[id].awake - groupKeep[id]);
            if (free <= 0) return;
            var n = take * (free / pool);
            state.groups[id].awake -= n;
            state.groups[id].dormant += n;
          });
          entries = take;
          state.stocks.drug = Math.max(0, state.stocks.drug - take * cfg.hibernation.drugPerEntry);
        }
      }
    } else if (delta < 0 && !famineActive) {
      // 断粮期间不自动唤醒：强制沉睡省下的口粮不能被常规轮换又吐出来。
      var wantWRaw = Math.min(-delta, cfg.hibernation.wakePerWeek, t2.dormant, 60 * medCoverage);
      var wantW = takeInteger(state, "wake", wantWRaw);
      if (wantW > 0) {
        var dpool = 0;
        workingIds.forEach(function (id) { dpool += state.groups[id].dormant; });
        if (dpool > 0) {
          var takeW = Math.min(wantW, dpool);
          var failRate = cfg.hibernation.reviveFail + 0.004 * (1 - medCoverage);
          reviveFails = takeW * failRate;
          workingIds.forEach(function (id) {
            var share = state.groups[id].dormant / dpool;
            var n = takeW * share;
            state.groups[id].dormant -= n;
            state.groups[id].awake += n * (1 - failRate);
          });
          wakes = takeW - reviveFails;
          weekDeaths += reviveFails;
        }
      }
    }

    // 药剂：制药 + 维持
    var dormantNow = totals(state, cfg).dormant;
    var drugProd = cfg.hibernation.drugProdTpy *
      (0.5 + 0.5 * medCoverage) * clamp(energy / cfg.energy.baseMW, 0, 1) * dt;
    var drugMaint = dormantNow * cfg.hibernation.drugPerDormantYear * dt *
      Math.max(0, 1 - (ENC ? ENC.modSum(state, "drugSave") : 0));
    state.stocks.drug = clamp(state.stocks.drug + drugProd - drugMaint, 0, cfg.hibernation.drugCap);

    // 金属与建设（配额按年补给拆分，未用完的配额留在各自账户里滚存）
    var capM = metalSupplyY * dt;
    var share = normalizedShares(I);

    state.budget.hydro = Math.min(state.budget.hydro + capM * share.hydro / 100,
      cfg.metal.hydroMetal * 6);
    state.budget.pods = Math.min(state.budget.pods + capM * share.pods / 100,
      cfg.hibernation.podMetal * 12);
    state.budget.clone = Math.min(state.budget.clone + capM * share.clone / 100,
      cfg.clone.podMetal * 2);

    var maintNeedM = cfg.metal.maintNeedTpy * dt;
    var maintBudget = capM * share.maint / 100;
    var maintSpend = Math.min(maintNeedM, maintBudget);
    var maintFromStock = 0;
    if (maintSpend < maintNeedM) {
      maintFromStock = Math.min(state.stocks.metal, maintNeedM - maintSpend);
      maintSpend += maintFromStock;
    }
    // 维修资金口径：配额优先，不足部分吃金属库存；两项都记进状态供首页读数
    state.maintFund = {
      week: state.weeks,
      need: Math.round(maintNeedM * 10) / 10,
      budget: Math.round(maintBudget * 10) / 10,
      fromStock: Math.round(maintFromStock * 10) / 10,
      spend: Math.round(maintSpend * 10) / 10
    };
    var maintGap = maintNeedM > 0 ? (maintNeedM - maintSpend) / maintNeedM : 0;
    // 失序与感染会拖垮维修效率：金属花了，活没干完
    if (soc) {
      maintGap = clamp(maintGap + 0.30 * (soc.mutiny.level / 5) +
        0.15 * clamp(soc.infection.share || 0, 0, 1) +
        0.50 * clamp(AD.errorK || 0, 0, 0.25), 0, 1);
    }
    // 磨损恶化项随航速放大：跑得越快，同样的维修缺口磨得更狠（r=1 时与旧版一致）
    var wearSpeedK = 1 + (((cfg.ship && cfg.ship.wearK) || 0)) *
      (((state.ship && cfg.ship && cfg.ship.speedBaseC)
        ? state.ship.speedC / cfg.ship.speedBaseC : 1) - 1);
    state.wear = clamp(state.wear +
      (0.50 * maintGap * wearSpeedK - 0.05 * (1 - maintGap)) * dt, 0, 1);

    var constructionSpend = 0;
    var availableMetal = Math.max(0, state.stocks.metal + capM - maintSpend);

    // 水培：在途数量 = 目标年速率 × 滞后年数
    var hydroInProgress = state.projects.hydro.length;
    var desiredHydro = Math.ceil(I.hydroTarget * cfg.metal.hydroLeadWeeks / cfg.time.weeksPerYear);
    var guard = 0;
    while (hydroInProgress < desiredHydro &&
           state.budget.hydro >= cfg.metal.hydroMetal &&
           availableMetal >= cfg.metal.hydroMetal && guard < 60) {
      if (state.infra.hydro + hydroInProgress >= cfg.food.hydroMax) break;
      state.budget.hydro -= cfg.metal.hydroMetal;
      availableMetal -= cfg.metal.hydroMetal;
      constructionSpend += cfg.metal.hydroMetal;
      state.projects.hydro.push(state.weeks + cfg.metal.hydroLeadWeeks);
      hydroInProgress++;
      guard++;
    }

    // 休眠舱：目标休眠超过舱位时自动开工
    var podNeed = Math.ceil(targetDorm - state.infra.pods - state.projects.pods.length);
    if (podNeed > 0) {
      var maxStart = Math.min(cfg.hibernation.maxPodStartPerWeek, Math.ceil(podNeed / 6));
      var starts = 0;
      while (starts < maxStart &&
             state.budget.pods >= cfg.hibernation.podMetal &&
             availableMetal >= cfg.hibernation.podMetal) {
        state.budget.pods -= cfg.hibernation.podMetal;
        availableMetal -= cfg.hibernation.podMetal;
        constructionSpend += cfg.hibernation.podMetal;
        state.projects.pods.push(state.weeks + cfg.hibernation.podLeadWeeks);
        starts++;
      }
    }

    // 克隆槽
    if (I.cloneBatch > 1.05 &&
        (state.infra.clonePods + state.projects.clonePods.length) < cfg.clone.maxPods &&
        state.budget.clone >= cfg.clone.podMetal &&
        availableMetal >= cfg.clone.podMetal) {
      state.budget.clone -= cfg.clone.podMetal;
      availableMetal -= cfg.clone.podMetal;
      constructionSpend += cfg.clone.podMetal;
      state.projects.clonePods.push(state.weeks + cfg.clone.podLeadWeeks);
    }

    // 只开采本周配额（维修 + 已开工建设）；配额不足的部分由库存结算
    var actualSupplyM = Math.min(capM, maintBudget + constructionSpend);
    state.stocks.metal = clamp(
      state.stocks.metal + actualSupplyM - maintSpend - constructionSpend,
      0, cfg.metal.cap
    );

    // 秩序
    var t3 = totals(state, cfg);
    var annualDeathRate = t3.total > 0 ? (weekDeaths / t3.total) * cfg.time.weeksPerYear : 0;
    var orderEq = cfg.order.eqBase
      - cfg.order.rationK * Math.max(0, 0.95 - rationActual)
      - cfg.order.wearK * state.wear
      - cfg.order.extremeK * (extremeActive ? 1 : 0)
      - cfg.order.deathK * clamp((annualDeathRate - 0.03) / 0.03, 0, 1)
      - (state.flags.atrocity ? cfg.order.atrocityK : 0);
    if (soc) {
      orderEq -= cfg.society.ladder.orderPerLevel * soc.mutiny.level;
      orderEq -= 0.10 * clamp(soc.infection.share || 0, 0, 1);
      orderEq -= 0.08 * (1 - clamp(soc.garrison.durability / 100, 0, 1));
    }
    // 成瘾：服从性加成（三档加权），化学极乐额外 +12%；戒断人数按醒态占比扣秩序
    orderEq += clamp(AD.obey || 0, 0, 0.18);
    if (AD.bliss) orderEq += cfg.addict.bliss.orderGain;
    // 基因抵押：抵押期内常年秩序惩罚（逐年递进）
    if (GM && GM.active) orderEq -= num0(GM.yearlyPenalty, 0);
    if (state.addict.withdraw) {
      var wNow = state.addict.withdraw.light + state.addict.withdraw.mid + state.addict.withdraw.heavy;
      orderEq -= 0.10 * clamp(wNow / Math.max(1, t3.awake), 0, 1);
    }
    state.order = clamp(state.order + (orderEq - state.order) * cfg.order.relax * dt, 0.05, 1);

    // 阶段
    var t4 = totals(state, cfg);
    var days = foodDays(state, cfg, t4);
    var targetPhase = 0;
    if (days < 10 || rationActual < 0.50 || t4.total < 1600) targetPhase = 4;
    else if (days < 30 || rationActual < 0.70) targetPhase = 3;
    else if (days < 60 || rationActual < 0.85) targetPhase = 2;
    else if (days < 90 || rationActual < 0.95) targetPhase = 1;

    if (targetPhase > state.phase) {
      state.phaseUp++;
      state.phaseDown = 0;
      if (state.phaseUp >= cfg.phase.upWeeks) {
        var fromName = cfg.phase.names[state.phase];
        state.phase = Math.min(4, state.phase + 1);
        state.phaseUp = 0;
        pushEvent(state, cfg, "phase", "系统", "粮食状况变了",
          fromName + " → " + cfg.phase.names[state.phase],
          "粮食 " + Math.round(days) + " 日，实际配给 " + rationActual.toFixed(2), true,
          null, "粮食只够吃 " + Math.max(1, Math.round(days / 30)) + " 个月");
      }
    } else if (targetPhase < state.phase) {
      state.phaseDown++;
      state.phaseUp = 0;
      var canExit = false;
      if (state.phase === 4) canExit = days >= 20 && rationActual >= 0.55 && t4.total >= 1600;
      else if (state.phase === 3) canExit = days >= 45 && rationActual >= 0.72;
      else if (state.phase === 2) canExit = days >= 75 && rationActual >= 0.88;
      else if (state.phase === 1) canExit = days >= 105 && rationActual >= 0.98;
      if (canExit && state.phaseDown >= cfg.phase.downWeeks) {
        var fromName2 = cfg.phase.names[state.phase];
        state.phase = Math.max(0, state.phase - 1);
        state.phaseDown = 0;
        pushEvent(state, cfg, "phase", "系统", "粮食状况变了",
          fromName2 + " → " + cfg.phase.names[state.phase],
          "粮食 " + Math.round(days) + " 日，实际配给 " + rationActual.toFixed(2), true,
          null, "粮食只够吃 " + Math.max(1, Math.round(days / 30)) + " 个月");
      }
    } else {
      state.phaseUp = 0;
      state.phaseDown = 0;
    }

    // 条件事件（同一状态只记一次，恢复后才重新布防）
    latchEvent(state, cfg, "food_low", days < 60, "food_low", "预警", "粮食快见底",
      "粮食只够吃 " + Math.max(1, Math.round(days / 30)) + " 个月",
      "低于 60 日线；日耗 " + (baseDemand / 365).toFixed(1) + " 吨", null,
      "余粮不到两个月，得赶紧补");

    var wDays = waterDays(state, cfg, t4);
    latchEvent(state, cfg, "water_low", wDays < 20, "water_low", "预警", "循环水偏少",
      "水还剩 " + Math.round(state.stocks.water) + " 吨，够用 " + Math.round(wDays) + " 天",
      "按 28.5 kg/人·日 总用水量折算", null, "水循环撑不了多久");

    latchEvent(state, cfg, "drug_low", state.stocks.drug < 100, "drug_low", "预警", "休眠药剂见底",
      "只剩 " + Math.round(state.stocks.drug) + " 份，够 " + Math.round(state.stocks.drug) + " 人入舱",
      "入舱 1 份/人，维持 0.02 份/人·年", null, "药剂不够，想睡的人排不上");

    latchEvent(state, cfg, "metal_low", state.stocks.metal < 500, "metal_low", "预警", "金属快用完",
      "金属只剩 " + Math.round(state.stocks.metal) + " 吨，建设和维修都得排队",
      "低于 500 吨；建设与维修将受配额限制", null, "金属不够，扩建和维修都要停");

    latchEvent(state, cfg, "pods_full", delta > 0 && state.infra.pods <= t2.dormant + 1 &&
      targetDorm > t2.dormant + 5,
      "pods_full", "预警", "休眠位已满",
      "想睡的有 " + Math.round(targetDorm) + " 人，舱位只有 " + state.infra.pods + " 个",
      "目标 " + Math.round(targetDorm) + " 人，缺口 " + Math.max(0, Math.round(targetDorm - t2.dormant)), null,
      "舱位满了，多出来的人只能继续醒着");

    latchEvent(state, cfg, "clone_cap", cloneCapped, "clone_cap", "预警", "克隆人太多了",
      "克隆人已经占到 " + (cloneShareNow * 100).toFixed(1) + "%",
      "档案上限 18%；产量归零直到占比回落", null, "克隆占比碰到上限，产量先停");

    latchEvent(state, cfg, "pop_floor", t4.total < 1600, "pop_floor", "危机", "人不够了",
      "全船只剩 " + Math.round(t4.total) + " 人，撑不住航行编制",
      "档案下限 1,600 人；生保与航行编制不足", null, "人少了，船已经开不动");

    if (state.order < 0.40) {
      if (!state.latches.strike) {
        state.latches.strike = true;
        state.streaks.strike = cfg.events.strikeWeeks;
        pushEvent(state, cfg, "strike", "事件", "环区停工",
          "秩序 " + Math.round(state.order * 100) + "%，部分环区停工，产出少一成半",
          "秩序低于 0.40；产出 ×0.85，持续 " + cfg.events.strikeWeeks + " 周", true,
          null, "没人听调度，产出掉了一截");
      }
    } else if (state.order >= 0.45) {
      state.latches.strike = false;
    }

    if (rationActual < 0.90) state.streaks.badRation++;
    else state.streaks.badRation = 0;
    if (state.streaks.badRation === cfg.events.bingeWeeks) {
      state.order = clamp(state.order - 0.10, 0.05, 1);
      var killed = killProportional(state, cfg, 0.003);
      pushEvent(state, cfg, "binge", "事件", "抢粮",
        "配给点打起来了：秩序 −10%，这 7 天多死 " + Math.round(killed) + " 人",
        "实际配给 " + rationActual.toFixed(2) + " 连续 " + cfg.events.bingeWeeks + " 周低于 0.90", true,
        { "人口": -Math.round(killed), "秩序": -10 }, "配给不够，配给点打起来了");
    }

    if (extremeActive && rationActual < 0.45) state.streaks.extreme++;
    else state.streaks.extreme = 0;
    if (state.streaks.extreme === cfg.events.atrocityWeeks) {
      state.order = clamp(state.order - 0.18, 0.05, 1);
      var killed2 = killProportional(state, cfg, 0.004);
      state.flags.atrocity = true;
      pushEvent(state, cfg, "atrocity", "危机", "有人吃死者",
        "出现吃死者遗体的事。秩序 −18%，这 7 天多死 " + Math.round(killed2) + " 人",
        "实际配给 " + rationActual.toFixed(2) + " 连续 " + cfg.events.atrocityWeeks + " 周低于 0.45，且已授权极端措施", true,
        { "人口": -Math.round(killed2), "秩序": -18 }, "断粮逼到人吃死者");
    }

    if (reviveFails >= 1) {
      pushEvent(state, cfg, "revive_fail", "事件", "有人没醒过来",
        "这批唤醒有 " + Math.round(reviveFails) + " 人没醒过来",
        "复温失败率 " + ((cfg.hibernation.reviveFail + 0.004 * (1 - medCoverage)) * 100).toFixed(1) + "%", true,
        null, "复温失败，这批人没能下船");
    }

    if (state.streaks.strike > 0) state.streaks.strike--;

    // 记录本周派生量
    state.last = {
      rationActual: rationActual,
      energy: energy,
      agriMW: agriMW,
      indMW: indMW,
      medCoverage: medCoverage,
      production: production,
      consumption: consumed / dt,
      shortfall: shortfall / dt,
      entries: entries,
      wakes: wakes,
      births: birthsY,
      cloneOut: cloneOutY,
      deaths: weekDeaths / dt,
      targetDorm: targetDorm,
      metalSupply: metalSupplyY,
      maintGap: maintGap,
      dormantMW: dormantMW,
      drugMaint: drugMaint
    };

    state.weeks++;
    // 个体层名册跟随人口变化（只在人数变化时增删，不逐人保存位置）
    if (global.XuanShuPeople && cfg.people && cfg.people.enabled !== false) {
      global.XuanShuPeople.sync(state, cfg);
    }
    // 群体健康 / 理智 / 意志：清醒与休眠分开聚合，随周结算刷新
    if (global.XuanShuPeople && cfg.people && cfg.people.enabled !== false) {
      state.wellbeing = global.XuanShuPeople.wellbeing(state, cfg);
    }
    if (global.XuanShuPlayer) {
      global.XuanShuPlayer.sync(state, cfg);
      if (state.weeks % cfg.time.weeksPerYear === 0) {
        // 顺序：周结算 → 玩家周更新（sync 已做）→ 怀孕
        // 奇遇检查已改由 weekly 按 checkEveryYears 调度，这里不再每年硬触发。
        global.XuanShuPlayer.yearly(state, cfg);
        // 古神：神恩回归、周期索取、祝福/诅咒年度结算
        if (global.XuanShuGods) global.XuanShuGods.yearly(state, cfg);
        // 监狱：刑期递减、刑罚年效果、劳动产出、哗变自动抓捕
        if (global.XuanShuPrison) global.XuanShuPrison.yearly(state, cfg);
        // 休眠维系年账：冻着多少人、电与药各耗多少，一眼可查
        var dormNow = totals(state, cfg).dormant;
        if (dormNow > 0) {
          pushEvent(state, cfg, "hibernation", "维系", "休眠维系",
            "冻着 " + Math.round(dormNow) + " 人 · 舱位电耗 " + (dormantMW || 0).toFixed(2) + " MW · 药剂维持 " +
              (drugMaint || 0).toFixed(1) + " 份",
            "梦中压力累计 " + (state.dream ? state.dream.pressure.toFixed(2) : "0") +
              " · 累计眷属 " + (state.dream ? state.dream.infected : 0),
            false, { "人口": 0 }, "维持成本先扣电再扣药；梦中侵染另计");
        }
      }
    }
    if (state.weeks % cfg.time.weeksPerYear === 0) pushSeries(state, cfg);

    // 奇遇检查：按 encounter.checkEveryYears 折算成周（默认每年一次），maxPerYear 封顶
    if (global.XuanShuEncounter) global.XuanShuEncounter.weekly(state, cfg);

    // 失败检查（每周一次，优先级 0–6）：命中即终局，时间冻结
    if (global.XuanShuRun) global.XuanShuRun.weekly(state, cfg);

    // 千年节点 / 胜利 / 回滚：节点年数读 run.nodeYears，不再写死 1000
    var nodeYears = Number(cfg.run && cfg.run.nodeYears);
    if (!(nodeYears > 0)) nodeYears = cfg.time.loopYears || 1000;
    if (cfg.time.rollback && state.weeks >= nodeYears * cfg.time.weeksPerYear) {
      var end = global.XuanShuRun
        ? global.XuanShuRun.onLoopEnd(state, cfg)
        : { action: "rollback" };
      if (end.action === "rollback") rollover(state, cfg);
    }
  }

  /* ---------------- 千年回滚 ---------------- */

  // 只重置舰务/社会层；玩家、奇遇牌库、古神契约、胜负与节点跨轮保留。
  function rollover(state, cfg) {
    var keepEvents = state.events;
    var keepSeries = state.series;
    var keepPlayer = state.player;
    var keepEncounter = state.encounter;
    var keepGods = state.gods;
    var keepRun = state.run;
    var nextLoop = state.loop + 1;
    var seed = state.rngA;
    var fresh = createState(cfg, seed);
    fresh.loop = nextLoop;
    fresh.events = keepEvents;
    fresh.series = keepSeries;
    fresh.inputs = clone(state.inputs);
    fresh.cooldown = state.cooldown;
    state.loop = fresh.loop;
    state.weeks = 0;
    state.rngA = fresh.rngA;
    state.groups = fresh.groups;
    state.stocks = fresh.stocks;
    state.infra = fresh.infra;
    state.order = cfg.order.init;
    state.wear = 0;
    state.phase = 0;
    state.phaseUp = 0;
    state.phaseDown = 0;
    state.projects = fresh.projects;
    state.flags = { atrocity: false };
    state.latches = {};
    state.clonePause = 0;
    state.streaks = { badRation: 0, extreme: 0, strike: 0 };
    state.budget = fresh.budget;
    state.buildAcc = fresh.buildAcc;
    state.flowCarry = fresh.flowCarry;
    state.maint = fresh.maint;
    state.last = fresh.last;
    // 药剂 / 营养 / 成瘾 / 辐射是舰务层，回滚时一并归零
    state.pools = fresh.pools;
    state.addict = fresh.addict;
    state.nutrition = fresh.nutrition;
    state.health = fresh.health;
    state.dream = fresh.dream;
    state.vitals = null;
    state.negotiation = fresh.negotiation;
    state.geneMortgage = fresh.geneMortgage;
    // 监狱名册是舰务层：回滚后清空，俘虏池与新案从头计
    state.prison = fresh.prison;
    if (global.XuanShuSociety) state.society = global.XuanShuSociety.create(cfg);
    if (global.XuanShuPeople) state.people = global.XuanShuPeople.create(cfg);
    // 玩家身份是跨轮长期状态：健康、年龄、权限、动作冷却、契约都保留
    if (global.XuanShuPlayer) {
      state.player = keepPlayer || global.XuanShuPlayer.create(cfg);
      global.XuanShuPlayer.sync(state, cfg);
    }
    // 奇遇牌库进度跨轮保留（剩余/已抽/洗牌轮次/历史/运气）；
    // 限时修正是按周计时的，回滚后周序归零，必须清掉。
    if (global.XuanShuEncounter) {
      state.encounter = keepEncounter || global.XuanShuEncounter.create(cfg);
      state.encounter.mods = [];
      state.encounter.pending = null;
      global.XuanShuEncounter.ensure(state, cfg);
    }
    // 古神契约跨轮保留：主约/旁约、神恩、神噬、索取队列
    if (global.XuanShuGods) {
      state.gods = keepGods || global.XuanShuGods.create(cfg);
      global.XuanShuGods.ensure(state, cfg);
    }
    // 胜负、运气、自动开关、千年节点跨轮保留
    if (global.XuanShuRun) {
      state.run = keepRun || global.XuanShuRun.create(cfg);
      global.XuanShuRun.ensure(state, cfg);
    }
    // 判定日志保留（跨轮审计），槽位与压力清零（新的一轮重新累积）
    if (global.XuanShuJudge && state.judge) state.judge.slots = {};
    pushEvent(state, cfg, "loop", "系统", "这一轮结束",
      "第 " + (nextLoop - 1) + " 轮结束，一切回到本轮起点；进入第 " + nextLoop + " 轮",
      "loopScope = full；人口、库存、设施、磨损回到本轮起点", true);
    pushSeries(state, cfg);
  }

  // 时间闸门：未选身份、节点挂起、终局都不再推进；老存档（run.enabled=false）不受影响。
  function blockReason(state, cfg) {
    var r = state.run;
    if (r && r.enabled && !r.legacy) {
      if (!r.started) return "needMode";
      if (r.pendingNode) return "pendingNode";
      if (r.status && r.status !== "playing") return "ended";
    }
    return "";
  }

  /* ---------------- 实例 ---------------- */

  function createSim(options) {
    options = options || {};
    var base = global.XUANSHU_CONFIG;
    if (!base) throw new Error("缺少 XUANSHU_CONFIG，请先加载 sim-config.js");
    var cfg = deepMerge(base, options.config || {});
    var seed = isNum(options.seed) ? options.seed : 20261111;
    var state = ensureGroups(createState(cfg, seed), cfg);

    var api = {
      version: cfg.version,

      setInputs: function (patch) {
        if (!patch) return api.getInputs();
        Object.keys(patch).forEach(function (k) {
          if (typeof state.inputs[k] === "undefined") return;
          if (typeof state.inputs[k] === "boolean") state.inputs[k] = !!patch[k];
          else if (isNum(patch[k])) state.inputs[k] = patch[k];
        });
        cfg.ui.sliders.forEach(function (sp) {
          if (isNum(state.inputs[sp.key])) {
            state.inputs[sp.key] = clamp(state.inputs[sp.key], sp.min, sp.max);
          }
        });
        return api.getInputs();
      },

      getInputs: function () { return clone(state.inputs); },

      setShip: function (v) {
        if (!isNum(v)) return api.getState();
        var min = (cfg.ship && cfg.ship.speedMin) || 0.020;
        var max = (cfg.ship && cfg.ship.speedMax) || 0.065;
        state.ship.speedC = clamp(v, min, max);
        return api.getState();
      },

      // 首页三项操控的唯一写入口：前端只负责算幅度与权限，
      // 这里统一夹边界、记秩序代价，保证引擎与界面同源。
      hudCommit: function (p) {
        p = p || {};
        var hp = (cfg.hud && cfg.hud.params) || {};
        var before = {
          ration: state.inputs.ration,
          dormancyTarget: state.inputs.dormancyTarget,
          speedC: state.ship.speedC,
          order: state.order
        };
        if (isNum(p.ration) && hp.ration) {
          state.inputs.ration = clamp(p.ration, hp.ration.min, hp.ration.max);
        }
        if (isNum(p.dormancyTarget) && hp.dormancy) {
          state.inputs.dormancyTarget = clamp(p.dormancyTarget, hp.dormancy.min, hp.dormancy.max);
        }
        if (isNum(p.speedC) && hp.speed) {
          state.ship.speedC = clamp(p.speedC, hp.speed.min, hp.speed.max);
        }
        if (isNum(p.orderDelta)) {
          state.order = clamp(state.order + p.orderDelta, 0, 1);
        }
        var after = {
          ration: state.inputs.ration,
          dormancyTarget: state.inputs.dormancyTarget,
          speedC: state.ship.speedC,
          order: state.order
        };
        return { ok: true, before: before, after: after };
      },

      // 推进 n 周（内部最小步长就是 1 周；大跨度由这里循环，阈值判定一次都不会漏）
      // 时间闸门：未选身份 / 千年节点挂起 / 终局时不再推进，返回带 blocked 的快照。
      step: function (weeks) {
        var n = Math.max(0, Math.round(isNum(weeks) ? weeks : 1));
        for (var i = 0; i < n; i++) {
          if (blockReason(state, cfg)) break;
          stepWeek(state, cfg);
        }
        return api.getState();
      },

      stepYears: function (years) {
        return api.step(Math.round((isNum(years) ? years : 1) * cfg.time.weeksPerYear));
      },

      getState: function () {
        var t = totals(state, cfg);
        var days = foodDays(state, cfg, t);
        var cshare = (state.groups.clone.awake + state.groups.clone.dormant) / Math.max(1, t.total);
        var wpy = cfg.time.weeksPerYear;
        return {
          loop: state.loop,
          loopYear: Math.round(state.weeks / wpy * 100) / 100,
          year: Math.round(((state.loop - 1) * cfg.time.loopYears + state.weeks / wpy) * 100) / 100,
          weeks: state.weeks,
          blocked: blockReason(state, cfg) || null,
          weekOfYear: (state.weeks % wpy) + 1,
          quarter: Math.floor((state.weeks % wpy) / cfg.time.weeksPerQuarter) + 1,
          weekOfQuarter: (state.weeks % cfg.time.weeksPerQuarter) + 1,
          months: Math.round(state.weeks * 12 / wpy),   // 对外只给整月；需要精度看 weeks
          total: t.total,
          awake: t.awake,
          dormant: t.dormant,
          working: t.working,
          groups: clone(state.groups),
          stocks: clone(state.stocks),
          infra: clone(state.infra),
          order: state.order,
          wear: state.wear,
          ship: state.ship ? {
            speedC: state.ship.speedC,
            ratio: Math.round((state.ship.speedC /
              ((cfg.ship && cfg.ship.speedBaseC) || 0.045)) * 1000) / 1000,
            propellant: Math.round((state.ship.propellant || 0) * 10) / 10,
            rangeKm: Math.round(remainingRangeKm(cfg, state.ship.propellant, state.ship.speedC))
          } : null,
          phase: state.phase,
          phaseName: cfg.phase.names[state.phase],
          foodDays: days,
          waterDays: waterDays(state, cfg, t),
          cloneShare: cshare,
          inputs: clone(state.inputs),
          shares: normalizedShares(state.inputs),
          rationActual: state.last.rationActual,
          energy: state.last.energy,
          agriMW: state.last.agriMW,
          indMW: state.last.indMW,
          medCoverage: state.last.medCoverage,
          production: state.last.production,
          consumption: state.last.consumption,
          targetDorm: state.last.targetDorm,
          metalSupply: state.last.metalSupply,
          maintGap: state.last.maintGap,
          // 维修资金：本周需求 / 配额 / 库存补足 / 实际支出
          maintFund: state.maintFund ? clone(state.maintFund) : null,
          // 休眠维系：舱位电耗 MW、药剂维持份数
          dormantMW: state.last.dormantMW,
          drugMaint: state.last.drugMaint,
          // 群体状态：清醒 / 休眠两套个体聚合（加权平均 + 分位）
          wellbeing: state.wellbeing || ((global.XuanShuPeople && state.people)
            ? global.XuanShuPeople.wellbeing(state, cfg) : null),
          // 梦里侵染：压力、累计感染、最近日志周
          dream: state.dream ? clone(state.dream) : null,
          // 药剂池 / 营养四维 / 成瘾三档 / 辐射（v6.29）
          med: {
            pools: clone(state.pools.med),
            prodPerWeek: clone(cfg.med.prodPerWeek),
            cap: clone(cfg.med.cap)
          },
          nutrition: state.nutrition ? clone(state.nutrition) : null,
          addict: state.addict ? clone(state.addict) : null,
          health: state.health ? clone(state.health) : null,
          vitals: state.vitals ? clone(state.vitals) : null,
          // 谈判 / 基因抵押（v6.30）
          negotiation: state.negotiation ? clone(state.negotiation) : null,
          geneMortgage: state.geneMortgage ? clone(state.geneMortgage) : null,
          births: state.last.births,
          deaths: state.last.deaths,
          cloneOut: state.last.cloneOut,
          entries: state.last.entries,
          wakes: state.last.wakes,
          projects: {
            hydro: state.projects.hydro.length,
            pods: state.projects.pods.length,
            clonePods: state.projects.clonePods.length
          },
          society: (global.XuanShuSociety && state.society)
            ? global.XuanShuSociety.summary(state, cfg) : null,
          // 真值聚合：分区人数（个人明细走 snapshot({view:"truth"})）
          people: (global.XuanShuPeople && state.people)
            ? global.XuanShuPeople.brief(state, cfg) : null,
          // 随机判定摘要：计数、最近 10 条、各槽压力/冷却
          judge: (global.XuanShuJudge && state.judge)
            ? global.XuanShuJudge.brief(state, cfg) : null,
          // 玩家身份摘要：当前身份、个人属性、可见范围
          player: (global.XuanShuPlayer && state.player)
            ? global.XuanShuPlayer.brief(state, cfg) : null,
          // 奇遇摘要：待选三张、牌库进度、运气、历史
          encounter: (global.XuanShuEncounter && state.encounter)
            ? global.XuanShuEncounter.brief(state, cfg) : null,
          // 古神摘要：主约、神恩、祝福/诅咒、神噬、待回应索取
          gods: (global.XuanShuGods && state.gods)
            ? global.XuanShuGods.brief(state, cfg) : null,
          // 监狱摘要：在押、俘虏池、刑罚分布、名册前 12 人与献祭历史
          prison: (global.XuanShuPrison && state.prison)
            ? global.XuanShuPrison.brief(state, cfg) : null,
          // 千年节点 / 自动推演 / 胜负摘要
          run: (global.XuanShuRun && state.run)
            ? global.XuanShuRun.brief(state, cfg) : null
        };
      },

      /* ---------- 个体真实位置 / 玩家视图 ---------- */
      getPeople: function (opts) {
        if (!global.XuanShuPeople) return { view: "truth", total: 0, persons: [], zones: [] };
        return global.XuanShuPeople.truth(state, cfg, opts || {});
      },

      playerView: function (opts) {
        if (!global.XuanShuPeople) return { view: "player", persons: [], zones: [] };
        return global.XuanShuPeople.playerView(state, cfg, opts || {});
      },

      truthView: function (opts) {
        if (!global.XuanShuPeople) return { view: "truth", persons: [], zones: [] };
        return global.XuanShuPeople.truth(state, cfg, opts || {});
      },

      /* ---------- 判定日志 ---------- */
      getJudgeLog: function () {
        return global.XuanShuJudge ? global.XuanShuJudge.log(state, cfg) : [];
      },

      exportJudgeLog: function (format) {
        return global.XuanShuJudge
          ? global.XuanShuJudge.exportLog(state, cfg, format || "csv") : "";
      },

      getSociety: function () {
        return (global.XuanShuSociety && state.society)
          ? global.XuanShuSociety.summary(state, cfg) : null;
      },

      triggerMutiny: function (dept) {
        return global.XuanShuSociety
          ? global.XuanShuSociety.triggerMutiny(state, cfg, dept)
          : { ok: false, msg: "社会层未加载" };
      },

      triggerInfection: function (group) {
        return global.XuanShuSociety
          ? global.XuanShuSociety.triggerInfection(state, cfg, group)
          : { ok: false, msg: "社会层未加载" };
      },

      societyAction: function (name, payload) {
        return global.XuanShuSociety
          ? global.XuanShuSociety.act(state, cfg, name, payload || {})
          : { ok: false, msg: "社会层未加载" };
      },

      getSeries: function () { return state.series; },
      getEvents: function () { return state.events; },
      getConfig: function () { return cfg; },

      /* ---------- 玩家身份层 ---------- */
      startGame: function (mode, opts) {
        var r = global.XuanShuPlayer
          ? global.XuanShuPlayer.start(state, cfg, mode, opts || {})
          : { ok: false, msg: "身份层没加载" };
        // 选定身份即开跑：run.started 放行时间闸门
        if (r && r.ok !== false && global.XuanShuRun) global.XuanShuRun.start(state, cfg);
        return r;
      },

      getPlayer: function () {
        return global.XuanShuPlayer ? global.XuanShuPlayer.brief(state, cfg) : null;
      },

      listActions: function () {
        return global.XuanShuPlayer ? global.XuanShuPlayer.listActions(state, cfg) : [];
      },

      playerAct: function (id, payload) {
        return global.XuanShuPlayer
          ? global.XuanShuPlayer.act(state, cfg, id, payload || {})
          : { ok: false, msg: "身份层没加载" };
      },

      /* ---------- 奇遇与牌库 ---------- */
      getEncounter: function () {
        return global.XuanShuEncounter ? global.XuanShuEncounter.brief(state, cfg) : null;
      },

      chooseCard: function (index, opts) {
        return global.XuanShuEncounter
          ? global.XuanShuEncounter.choose(state, cfg, index, opts || {})
          : { ok: false, msg: "奇遇层未加载" };
      },

      /* ---------- 古神契约 ---------- */
      getGods: function () {
        return global.XuanShuGods ? global.XuanShuGods.brief(state, cfg) : null;
      },

      /* ---------- 监狱与献祭 ---------- */
      getPrison: function () {
        return global.XuanShuPrison ? global.XuanShuPrison.brief(state, cfg) : null;
      },

      prisonCandidates: function () {
        return global.XuanShuPrison ? global.XuanShuPrison.candidates(state, cfg) : [];
      },

      prisonSacrifice: function (sel) {
        return global.XuanShuPrison
          ? global.XuanShuPrison.sacrifice(state, cfg, sel || {})
          : { ok: false, msg: "监狱层未加载" };
      },

      /** 回应周期索取（目前是赤织母的献祭） */
      resolveTithe: function (accept) {
        return global.XuanShuGods
          ? global.XuanShuGods.resolveTithe(state, cfg, !!accept)
          : { ok: false, msg: "古神层未加载" };
      },

      /* ---------- 千年节点 / 自动推演 / 胜负 ---------- */
      getRun: function () {
        return global.XuanShuRun ? global.XuanShuRun.brief(state, cfg) : null;
      },

      /** 结算千年节点："auto" 自动推演 / "manual" 继续手动；结算后立即回滚进下一轮 */
      resolveMillennium: function (mode) {
        if (!global.XuanShuRun) return { ok: false, msg: "run 层未加载" };
        var r = global.XuanShuRun.resolve(state, cfg, mode);
        if (r.ok && r.rollback) rollover(state, cfg);
        return r;
      },

      /** 任意时刻切自动/手动；切回手动的当轮仍会走完，下一次千年节点重新挂起 */
      setAuto: function (v) {
        return global.XuanShuRun
          ? global.XuanShuRun.setAuto(state, cfg, v)
          : { ok: false, msg: "run 层未加载" };
      },

      /** 无粮阶梯干预（仅高身份）：harvest 抢收 / stop 指定先停哪级 / recycle 下令回收 / resume 继续 */
      famineAct: function (choice) {
        return global.XuanShuRun
          ? global.XuanShuRun.famineAct(state, cfg, choice)
          : { ok: false, msg: "run 层未加载" };
      },

      /** 废弃殖民舰七选项：一次提交一组勾选，原地出结果；收队后才清 pending */
      derelictResolve: function (sel) {
        return global.XuanShuEncounter
          ? global.XuanShuEncounter.derelictResolve(state, cfg, sel || {})
          : { ok: false, msg: "encounter 层未加载" };
      },
      derelictClose: function () {
        return global.XuanShuEncounter
          ? global.XuanShuEncounter.derelictClose(state, cfg, {})
          : { ok: false, msg: "encounter 层未加载" };
      },

      /** 五类行星：面板选项 / 结算 / 收队（v6.31） */
      planetView: function () {
        return global.XuanShuEncounter && global.XuanShuEncounter.planetView
          ? global.XuanShuEncounter.planetView(state, cfg)
          : null;
      },
      planetResolve: function (sel) {
        return global.XuanShuEncounter
          ? global.XuanShuEncounter.planetResolve(state, cfg, sel || {})
          : { ok: false, msg: "encounter 层未加载" };
      },
      planetClose: function () {
        return global.XuanShuEncounter
          ? global.XuanShuEncounter.planetClose(state, cfg, {})
          : { ok: false, msg: "encounter 层未加载" };
      },

      /** 谈判：出价 / 掠夺；收场后清 pending（v6.30） */
      negotiationView: function (debug) {
        return global.XuanShuEncounter && global.XuanShuEncounter.negotiationView
          ? global.XuanShuEncounter.negotiationView(state, cfg, !!debug)
          : null;
      },
      negotiationResolve: function (sel) {
        return global.XuanShuEncounter
          ? global.XuanShuEncounter.negotiationResolve(state, cfg, sel || {})
          : { ok: false, msg: "encounter 层未加载" };
      },
      negotiationClose: function () {
        return global.XuanShuEncounter
          ? global.XuanShuEncounter.negotiationClose(state, cfg, {})
          : { ok: false, msg: "encounter 层未加载" };
      },
      mortgageView: function () {
        return global.XuanShuEncounter && global.XuanShuEncounter.mortgageView
          ? global.XuanShuEncounter.mortgageView(state, cfg)
          : null;
      },
      mortgageStart: function (sel) {
        return global.XuanShuEncounter
          ? global.XuanShuEncounter.mortgageStart(state, cfg, sel || {})
          : { ok: false, msg: "encounter 层未加载" };
      },
      mortgageRedeem: function () {
        return global.XuanShuEncounter && global.XuanShuEncounter.mortgageRedeem
          ? global.XuanShuEncounter.mortgageRedeem(state, cfg)
          : { ok: false, msg: "encounter 层未加载" };
      },
      mortgageClose: function () {
        return global.XuanShuEncounter && global.XuanShuEncounter.mortgageClose
          ? global.XuanShuEncounter.mortgageClose(state, cfg, {})
          : { ok: false, msg: "encounter 层未加载" };
      },

      /** 自动推演一个 chunk（默认 1 年）；遇节点先按自动结算，遇终局立即停 */
      autoStep: function (years) {
        if (!global.XuanShuRun) return api.getState();
        if (state.run && state.run.pendingNode) {
          var rr = global.XuanShuRun.resolve(state, cfg, "auto");
          if (rr.ok) rollover(state, cfg);
        }
        var y = isNum(years) ? years
          : ((cfg.run && isNum(cfg.run.autoChunkYears)) ? cfg.run.autoChunkYears : 1);
        var n = Math.max(1, Math.round(y * cfg.time.weeksPerYear));
        for (var i = 0; i < n; i++) {
          if (blockReason(state, cfg)) break;
          stepWeek(state, cfg);
        }
        return api.getState();
      },

      reset: function () {
        state = createState(cfg, seed);
        return api.getState();
      },

      exportState: function () { return JSON.stringify(state); },

      // 轻量快照：不含历史序列与事件，供页面做「预演」用，避免每次拖动都搬运整条曲线
      snapshot: function () {
        var s = clone(state);
        s.series = [];
        s.events = [];
        return s;
      },

      restore: function (obj) {
        if (!obj || !obj.groups || !obj.stocks) throw new Error("状态格式不正确");
        state = clone(obj);
        ensureGroups(state, cfg);
        ensurePods(state, cfg);
        ensureVitals(state, cfg);
        if (global.XuanShuEncounter && global.XuanShuEncounter.ensureTrade) {
          global.XuanShuEncounter.ensureTrade(state, cfg);
        }
        if (global.XuanShuPlayer) global.XuanShuPlayer.ensure(state, cfg);
        if (global.XuanShuEncounter) global.XuanShuEncounter.ensure(state, cfg);
        if (global.XuanShuGods) global.XuanShuGods.ensure(state, cfg);
        if (global.XuanShuPrison) global.XuanShuPrison.ensure(state, cfg);
        if (global.XuanShuRun) global.XuanShuRun.ensure(state, cfg);
        return api.getState();
      },

      importState: function (json) {
        var obj = typeof json === "string" ? JSON.parse(json) : json;
        if (!obj || !obj.groups || !obj.stocks) throw new Error("状态格式不正确");
        state = obj;
        // 旧档兼容：没有 ship 时补基准速度，读档后行为与旧版一致
        if (!state.ship || !isNum(state.ship.speedC)) {
          state.ship = { speedC: (cfg.ship && cfg.ship.speedC) || 0.045 };
        }
        if (!isNum(state.ship.propellant)) {
          state.ship.propellant = (cfg.ship && cfg.ship.propellant && isNum(cfg.ship.propellant.initT))
            ? cfg.ship.propellant.initT : 2400;
        }
        ensureGroups(state, cfg);
        ensurePods(state, cfg);
        ensureVitals(state, cfg);
        if (global.XuanShuEncounter && global.XuanShuEncounter.ensureTrade) {
          global.XuanShuEncounter.ensureTrade(state, cfg);
        }
        if (global.XuanShuPlayer) global.XuanShuPlayer.ensure(state, cfg);
        if (global.XuanShuEncounter) global.XuanShuEncounter.ensure(state, cfg);
        if (global.XuanShuGods) global.XuanShuGods.ensure(state, cfg);
        if (global.XuanShuPrison) global.XuanShuPrison.ensure(state, cfg);
        if (global.XuanShuRun) global.XuanShuRun.ensure(state, cfg);
        return api.getState();
      }
    };

    return api;
  }

  global.XuanShuSim = {
    version: "0.1.0",
    createSim: createSim,
    createState: createState,
    totals: totals,
    normalizedShares: normalizedShares,
    metrics: metrics,
    diffMetrics: diffMetrics,
    killProportional: killProportional,
    cleanDeltas: cleanDeltas,
    eventIsKey: eventIsKey
  };

  if (typeof module !== "undefined" && module.exports) module.exports = global.XuanShuSim;
})(typeof globalThis !== "undefined" ? globalThis : this);
