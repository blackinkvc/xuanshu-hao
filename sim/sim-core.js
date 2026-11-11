/* =========================================================================
   玄枢号 · 舰务模拟内核（v0.1）
   -------------------------------------------------------------------------
   纯计算，不碰 DOM。所有状态都是普通 JSON，可直接搬进主站。
   用法：
     var sim = XuanShuSim.createSim();        // 读取 globalThis.XUANSHU_CONFIG
     sim.setInputs({ ration: 0.9 });
     sim.step(120);                           // 推进 120 个月 = 10 年
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

  // 可序列化的 PRNG（seed 跟着状态走，导出/导入不会断）
  function nextRand(state) {
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
      awake += s.awake;
      dormant += s.dormant;
      if (g.id !== cfg.population.undecidedId) working += s.awake;
    });
    return { awake: awake, dormant: dormant, total: awake + dormant, working: working };
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

  function pushEvent(state, cfg, type, level, title, text, basis, force) {
    if (!force) {
      var last = state.cooldown[type];
      if (last !== undefined && state.months - last < cfg.events.cooldownMonths) return false;
      state.cooldown[type] = state.months;
    }
    state.events.push({
      t: (state.loop - 1) * cfg.time.loopYears + state.months / 12,
      loop: state.loop,
      year: Math.floor(state.months / 12),
      month: (state.months % 12) + 1,
      type: type,
      level: level || "事件",
      title: title,
      text: text,
      basis: basis || ""
    });
    if (state.events.length > 600) state.events.shift();
    return true;
  }

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

  function popDue(arr, month) {
    var n = 0;
    for (var i = arr.length - 1; i >= 0; i--) {
      if (arr[i] <= month) { arr.splice(i, 1); n++; }
    }
    return n;
  }

  // 只在「条件从假变真」时记一条，避免同类预警刷屏
  function latchEvent(state, cfg, key, condition, type, level, title, text, basis) {
    if (condition) {
      if (!state.latches[key]) {
        state.latches[key] = true;
        pushEvent(state, cfg, type, level, title, text, basis, true);
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
      months: 0,
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
      phase: 0,
      phaseUp: 0,
      phaseDown: 0,
      inputs: clone(cfg.inputs),
      projects: { hydro: [], pods: [], clonePods: [] },
      cooldown: {},
      events: [],
      series: [],
      flags: { atrocity: false },
      latches: {},
      clonePause: 0,
      streaks: { badRation: 0, extreme: 0, strike: 0 },
      budget: { hydro: 0, pods: 0, clone: 0 },
      buildAcc: { hydro: 0, pods: 0, clonePods: 0 },
      last: {}
    };
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
    pushSeries(state, cfg);
    return state;
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
      t: (state.loop - 1) * cfg.time.loopYears + state.months / 12,
      loop: state.loop,
      loopYear: state.months / 12,
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
      phase: state.phase,
      ration: state.last.rationActual,
      energy: state.last.energy,
      medCoverage: state.last.medCoverage
    });
    if (state.series.length > cfg.time.seriesCap) state.series.shift();
  }

  /* ---------------- 月度结算 ---------------- */

  function stepMonth(state, cfg) {
    var dt = 1 / 12;
    var I = state.inputs;
    var noise = function (amp) { return 1 + amp * (nextRand(state) * 2 - 1); };

    // 先交付到期项目；同类交付按批次累计，避免每交付一个就刷一条事件
    var doneHydro = popDue(state.projects.hydro, state.months);
    var donePods = popDue(state.projects.pods, state.months);
    var doneClone = popDue(state.projects.clonePods, state.months);
    if (!state.buildAcc) state.buildAcc = { hydro: 0, pods: 0, clonePods: 0 };
    state.buildAcc.hydro += doneHydro;
    state.buildAcc.pods += donePods;
    state.buildAcc.clonePods += doneClone;
    state.infra.hydro += doneHydro;
    state.infra.pods += donePods;
    state.infra.clonePods += doneClone;

    if (state.buildAcc.hydro >= 25) {
      pushEvent(state, cfg, "build_hydro", "建设", "水培扩建交付",
        "新增 " + state.buildAcc.hydro + " 个栽培单元，总数 " + state.infra.hydro +
        "，等效 " + (state.buildAcc.hydro * 1000).toLocaleString("en-US") + " m²",
        "金属配额到位，工期 " + cfg.metal.hydroLeadMonths + " 个月", true);
      state.buildAcc.hydro = 0;
    }
    if (state.buildAcc.pods >= 50) {
      pushEvent(state, cfg, "build_pods", "建设", "休眠舱交付",
        "新增 " + state.buildAcc.pods + " 个休眠位，总数 " + state.infra.pods,
        "工期 " + cfg.hibernation.podLeadMonths + " 个月", true);
      state.buildAcc.pods = 0;
    }
    if (state.buildAcc.clonePods >= 6) {
      pushEvent(state, cfg, "build_clone", "建设", "克隆槽交付",
        "新增 " + state.buildAcc.clonePods + " 个培育筒，总数 " + state.infra.clonePods,
        "工期 " + cfg.clone.podLeadMonths + " 个月", true);
      state.buildAcc.clonePods = 0;
    }

    var t0 = totals(state, cfg);

    // 能源
    var energy = cfg.energy.baseMW * (1 - 0.15 * state.wear);
    var lifeMW = Math.min(cfg.energy.lifeMW, energy);
    var rest = Math.max(0, energy - lifeMW);
    var agriMW = rest * I.agriShare;
    var indMW = rest * (1 - I.agriShare);
    var metalSupplyY = cfg.metal.supplyTpy * clamp(indMW / cfg.energy.industryFullMW, 0, 1);

    // 医疗
    var medCoverage = clamp(
      (cfg.medical.coverageBase + cfg.medical.coverageGain * I.medical) *
      clamp(lifeMW / cfg.energy.lifeMW, 0.5, 1) *
      (1 - 0.10 * state.wear), 0, 1
    );

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
        month: state.months
      });
    }
    var soc = state.society;

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
        (soc.effects.prodMul || 1);
    }
    var planet = I.planetCut ? 0 : cfg.food.planetTpy;

    // 粮食结算：库存永不为负
    var baseDemand = t0.awake * cfg.food.perCapitaTpy +
      t0.dormant * cfg.food.perCapitaTpy * cfg.food.dormantFactor;
    var standardNeed = baseDemand * dt;
    var need = standardNeed * I.ration;
    var available = state.stocks.food + (production + planet) * dt;
    var consumed = Math.min(need, available);
    var rationActual = standardNeed > 0 ? clamp(consumed / standardNeed, 0, 1.2) : 1;
    state.stocks.food = Math.max(0, available - consumed);
    state.stocks.food = Math.min(state.stocks.food, cfg.food.cap);
    var shortfall = need - consumed;

    // 水
    var throughput = t0.awake * cfg.water.perCapitaAwake +
      t0.dormant * cfg.water.perCapitaDormant;
    var recycle = cfg.water.recycle * clamp(lifeMW / cfg.energy.lifeMW, 0.60, 1);
    var loss = throughput * (1 - recycle);
    state.stocks.water = clamp(state.stocks.water + (cfg.water.supplyTpy - loss) * dt, 0, cfg.water.cap);

    // 死亡修正
    var extremeActive = !!I.extreme && state.phase >= 3;
    var mal = cfg.death.malK * Math.pow(1 - Math.min(1, rationActual), 2) * (extremeActive ? 0.85 : 1);
    var disease = cfg.death.diseaseK * (1 - medCoverage) * (1 + 1.5 * Math.max(0, 1 - rationActual));
    var conflict = state.order < 0.45
      ? cfg.death.conflictK * Math.pow((0.45 - state.order) / 0.45, 2) : 0;
    var accident = cfg.death.accidentBase + cfg.death.accidentWear * state.wear;
    var extra = mal + disease + conflict + accident;

    // 死亡
    var monthDeaths = 0;
    cfg.population.groups.forEach(function (g) {
      var s = state.groups[g.id];
      var rate = g.mortality;
      if (g.clone) rate = g.mortality / clamp(rationActual, 0.35, 1);
      var d = Math.min(s.awake, s.awake * (rate + extra) * dt * noise(0.08));
      s.awake -= d;
      monthDeaths += d;
      var dd = Math.min(s.dormant, s.dormant * cfg.hibernation.dormantMortality * dt * noise(0.10));
      s.dormant -= dd;
      monthDeaths += dd;
    });

    // 出生（全部进未定）
    var birthsY = I.birthQuota *
      clamp((rationActual - 0.5) / 0.4, 0, 1) *
      (0.6 + 0.4 * medCoverage) *
      (0.7 + 0.3 * clamp(state.order / 0.8, 0, 1)) *
      noise(0.10);
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
      (0.85 + 0.15 * medCoverage);
    var t1 = totals(state, cfg);
    var cloneShareNow = (state.groups.clone.awake + state.groups.clone.dormant) / Math.max(1, t1.total);
    if (state.clonePause > 0) {
      state.clonePause--;
      cloneOutY = 0;
    } else if (cloneShareNow >= cfg.clone.capShare) {
      state.clonePause = 24;
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
    var workingIds = cfg.population.groups
      .filter(function (g) { return g.id !== cfg.population.undecidedId; })
      .map(function (g) { return g.id; });

    if (delta > 0) {
      var want = Math.min(
        delta,
        cfg.hibernation.entryPerMonth,
        Math.max(0, state.infra.pods - t2.dormant),
        state.stocks.drug / cfg.hibernation.drugPerEntry,
        Math.max(0, t2.awake - cfg.population.minAwake),
        t2.awake * 0.02
      );
      want = Math.floor(want);
      if (want > 0) {
        var pool = 0;
        workingIds.forEach(function (id) { pool += state.groups[id].awake; });
        if (pool > 0) {
          var take = Math.min(want, pool);
          workingIds.forEach(function (id) {
            var share = state.groups[id].awake / pool;
            var n = take * share;
            state.groups[id].awake -= n;
            state.groups[id].dormant += n;
          });
          entries = take;
          state.stocks.drug = Math.max(0, state.stocks.drug - take * cfg.hibernation.drugPerEntry);
        }
      }
    } else if (delta < 0) {
      var wantW = Math.min(-delta, cfg.hibernation.wakePerMonth, t2.dormant, 60 * medCoverage);
      wantW = Math.floor(wantW);
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
          monthDeaths += reviveFails;
        }
      }
    }

    // 药剂：制药 + 维持
    var dormantNow = totals(state, cfg).dormant;
    var drugProd = cfg.hibernation.drugProdTpy *
      (0.5 + 0.5 * medCoverage) * clamp(energy / cfg.energy.baseMW, 0, 1) * dt;
    var drugMaint = dormantNow * cfg.hibernation.drugPerDormantYear * dt;
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
    var maintSpend = Math.min(maintNeedM, capM * share.maint / 100);
    if (maintSpend < maintNeedM) {
      maintSpend += Math.min(state.stocks.metal, maintNeedM - maintSpend);
    }
    var maintGap = maintNeedM > 0 ? (maintNeedM - maintSpend) / maintNeedM : 0;
    // 失序与感染会拖垮维修效率：金属花了，活没干完
    if (soc) {
      maintGap = clamp(maintGap + 0.30 * (soc.mutiny.level / 5) +
        0.15 * clamp(soc.infection.share || 0, 0, 1), 0, 1);
    }
    state.wear = clamp(state.wear + (0.50 * maintGap - 0.05 * (1 - maintGap)) * dt, 0, 1);

    var constructionSpend = 0;
    var availableMetal = Math.max(0, state.stocks.metal + capM - maintSpend);

    // 水培：在途数量 = 目标年速率 × 滞后年数
    var hydroInProgress = state.projects.hydro.length;
    var desiredHydro = Math.ceil(I.hydroTarget * cfg.metal.hydroLeadMonths / 12);
    var guard = 0;
    while (hydroInProgress < desiredHydro &&
           state.budget.hydro >= cfg.metal.hydroMetal &&
           availableMetal >= cfg.metal.hydroMetal && guard < 60) {
      if (state.infra.hydro + hydroInProgress >= cfg.food.hydroMax) break;
      state.budget.hydro -= cfg.metal.hydroMetal;
      availableMetal -= cfg.metal.hydroMetal;
      constructionSpend += cfg.metal.hydroMetal;
      state.projects.hydro.push(state.months + cfg.metal.hydroLeadMonths);
      hydroInProgress++;
      guard++;
    }

    // 休眠舱：目标休眠超过舱位时自动开工
    var podNeed = Math.ceil(targetDorm - state.infra.pods - state.projects.pods.length);
    if (podNeed > 0) {
      var maxStart = Math.min(cfg.hibernation.maxPodStartPerMonth, Math.ceil(podNeed / 6));
      var starts = 0;
      while (starts < maxStart &&
             state.budget.pods >= cfg.hibernation.podMetal &&
             availableMetal >= cfg.hibernation.podMetal) {
        state.budget.pods -= cfg.hibernation.podMetal;
        availableMetal -= cfg.hibernation.podMetal;
        constructionSpend += cfg.hibernation.podMetal;
        state.projects.pods.push(state.months + cfg.hibernation.podLeadMonths);
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
      state.projects.clonePods.push(state.months + cfg.clone.podLeadMonths);
    }

    // 只开采实际需要的金属；缺口才吃库存，避免库存无意义地涨到上限
    var needM = maintSpend + constructionSpend;
    var actualSupplyM = Math.min(capM, needM);
    state.stocks.metal = clamp(
      state.stocks.metal + actualSupplyM - maintSpend - constructionSpend,
      0, cfg.metal.cap
    );

    // 秩序
    var t3 = totals(state, cfg);
    var annualDeathRate = t3.total > 0 ? (monthDeaths / t3.total) * 12 : 0;
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
      if (state.phaseUp >= 2) {
        var fromName = cfg.phase.names[state.phase];
        state.phase = Math.min(4, state.phase + 1);
        state.phaseUp = 0;
        pushEvent(state, cfg, "phase", "系统", "阶段变化",
          fromName + " → " + cfg.phase.names[state.phase],
          "粮食 " + Math.round(days) + " 日，实际配给 " + rationActual.toFixed(2), true);
      }
    } else if (targetPhase < state.phase) {
      state.phaseDown++;
      state.phaseUp = 0;
      var canExit = false;
      if (state.phase === 4) canExit = days >= 20 && rationActual >= 0.55 && t4.total >= 1600;
      else if (state.phase === 3) canExit = days >= 45 && rationActual >= 0.72;
      else if (state.phase === 2) canExit = days >= 75 && rationActual >= 0.88;
      else if (state.phase === 1) canExit = days >= 105 && rationActual >= 0.98;
      if (canExit && state.phaseDown >= 3) {
        var fromName2 = cfg.phase.names[state.phase];
        state.phase = Math.max(0, state.phase - 1);
        state.phaseDown = 0;
        pushEvent(state, cfg, "phase", "系统", "阶段变化",
          fromName2 + " → " + cfg.phase.names[state.phase],
          "粮食 " + Math.round(days) + " 日，实际配给 " + rationActual.toFixed(2), true);
      }
    } else {
      state.phaseUp = 0;
      state.phaseDown = 0;
    }

    // 条件事件（同一状态只记一次，恢复后才重新布防）
    latchEvent(state, cfg, "food_low", days < 60, "food_low", "预警", "粮食余量预警",
      "粮食 " + Math.round(state.stocks.food) + " t，约 " + Math.round(days) + " 日",
      "低于 60 日线；日耗 " + (baseDemand / 365).toFixed(1) + " t");

    var wDays = waterDays(state, cfg, t4);
    latchEvent(state, cfg, "water_low", wDays < 20, "water_low", "预警", "循环水缓冲偏低",
      "水储备 " + Math.round(state.stocks.water) + " t，约 " + Math.round(wDays) + " 日用量",
      "按 28.5 kg/人·日 总用水量折算");

    latchEvent(state, cfg, "drug_low", state.stocks.drug < 100, "drug_low", "预警", "休眠药剂见底",
      "库存 " + Math.round(state.stocks.drug) + " 份",
      "入舱 1 份/人，维持 0.02 份/人·年");

    latchEvent(state, cfg, "metal_low", state.stocks.metal < 500, "metal_low", "预警", "金属库存告急",
      "库存 " + Math.round(state.stocks.metal) + " t",
      "低于 500 t；建设与维修将受配额限制");

    latchEvent(state, cfg, "pods_full", delta > 0 && state.infra.pods <= t2.dormant + 1 &&
      targetDorm > t2.dormant + 5,
      "pods_full", "预警", "休眠位已满",
      "休眠 " + Math.round(t2.dormant) + " / 舱位 " + state.infra.pods,
      "目标 " + Math.round(targetDorm) + " 人，缺口 " + Math.max(0, Math.round(targetDorm - t2.dormant)));

    latchEvent(state, cfg, "clone_cap", cloneCapped, "clone_cap", "预警", "触及克隆上限",
      "克隆占比 " + (cloneShareNow * 100).toFixed(1) + "%",
      "档案上限 18%；产量归零直到占比回落");

    latchEvent(state, cfg, "pop_floor", t4.total < 1600, "pop_floor", "危机", "人口跌破危机下限",
      "在册 " + Math.round(t4.total) + " 人",
      "档案下限 1,600 人；生保与航行编制不足");

    if (state.order < 0.40) {
      if (!state.latches.strike) {
        state.latches.strike = true;
        state.streaks.strike = 6;
        pushEvent(state, cfg, "strike", "事件", "环区停工",
          "秩序 " + state.order.toFixed(2) + "，部分环区停止常规作业",
          "秩序低于 0.40；产出 ×0.85，持续 6 个月", true);
      }
    } else if (state.order >= 0.45) {
      state.latches.strike = false;
    }

    if (rationActual < 0.90) state.streaks.badRation++;
    else state.streaks.badRation = 0;
    if (state.streaks.badRation === cfg.events.bingeMonths) {
      state.order = clamp(state.order - 0.10, 0.05, 1);
      var killed = killProportional(state, cfg, 0.003);
      pushEvent(state, cfg, "binge", "事件", "配给点争抢",
        "登记冲突，秩序 −0.10，当月额外死亡 " + Math.round(killed) + " 人",
        "实际配给 " + rationActual.toFixed(2) + " 连续 " + cfg.events.bingeMonths + " 个月低于 0.90", true);
    }

    if (extremeActive && rationActual < 0.45) state.streaks.extreme++;
    else state.streaks.extreme = 0;
    if (state.streaks.extreme === cfg.events.atrocityMonths) {
      state.order = clamp(state.order - 0.18, 0.05, 1);
      var killed2 = killProportional(state, cfg, 0.004);
      state.flags.atrocity = true;
      pushEvent(state, cfg, "atrocity", "危机", "底线事件",
        "配给体系外出现以死者遗体为食的记录，细节封存。秩序 −0.18，当月额外死亡 " + Math.round(killed2) + " 人",
        "实际配给 " + rationActual.toFixed(2) + " 连续 " + cfg.events.atrocityMonths + " 个月低于 0.45，且已授权极端措施", true);
    }

    if (reviveFails >= 1) {
      pushEvent(state, cfg, "revive_fail", "事件", "复温失败",
        "本批唤醒失败 " + Math.round(reviveFails) + " 人",
        "复温失败率 " + ((cfg.hibernation.reviveFail + 0.004 * (1 - medCoverage)) * 100).toFixed(1) + "%", true);
    }

    if (state.streaks.strike > 0) state.streaks.strike--;

    // 记录本月派生量
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
      deaths: monthDeaths / dt,
      targetDorm: targetDorm,
      metalSupply: metalSupplyY,
      maintGap: maintGap
    };

    state.months++;
    if (state.months % 12 === 0) pushSeries(state, cfg);

    // 1000 年回滚
    if (cfg.time.rollback && state.months >= cfg.time.loopYears * 12) {
      var keepEvents = state.events;
      var keepSeries = state.series;
      var nextLoop = state.loop + 1;
      var seed = state.rngA;
      var fresh = createState(cfg, seed);
      fresh.loop = nextLoop;
      fresh.events = keepEvents;
      fresh.series = keepSeries;
      fresh.inputs = clone(state.inputs);
      fresh.cooldown = state.cooldown;
      state.loop = fresh.loop;
      state.months = 0;
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
      state.last = fresh.last;
      if (global.XuanShuSociety) state.society = global.XuanShuSociety.create(cfg);
      pushEvent(state, cfg, "loop", "系统", "循环回滚",
        "第 " + (nextLoop - 1) + " 轮结束，全量回滚；进入第 " + nextLoop + " 轮",
        "loopScope = full；人口、库存、设施、磨损回到本轮起点", true);
      pushSeries(state, cfg);
    }
  }

  /* ---------------- 实例 ---------------- */

  function createSim(options) {
    options = options || {};
    var base = global.XUANSHU_CONFIG;
    if (!base) throw new Error("缺少 XUANSHU_CONFIG，请先加载 sim-config.js");
    var cfg = deepMerge(base, options.config || {});
    var seed = isNum(options.seed) ? options.seed : 20261111;
    var state = createState(cfg, seed);

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

      step: function (months) {
        var n = Math.max(0, Math.floor(isNum(months) ? months : 1));
        for (var i = 0; i < n; i++) stepMonth(state, cfg);
        return api.getState();
      },

      stepYears: function (years) {
        return api.step(Math.round((isNum(years) ? years : 1) * 12));
      },

      getState: function () {
        var t = totals(state, cfg);
        var days = foodDays(state, cfg, t);
        var cshare = (state.groups.clone.awake + state.groups.clone.dormant) / Math.max(1, t.total);
        return {
          loop: state.loop,
          loopYear: state.months / 12,
          year: (state.loop - 1) * cfg.time.loopYears + state.months / 12,
          months: state.months,
          total: t.total,
          awake: t.awake,
          dormant: t.dormant,
          working: t.working,
          groups: clone(state.groups),
          stocks: clone(state.stocks),
          infra: clone(state.infra),
          order: state.order,
          wear: state.wear,
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
            ? global.XuanShuSociety.summary(state, cfg) : null
        };
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

      societyAction: function (name) {
        return global.XuanShuSociety
          ? global.XuanShuSociety.act(state, cfg, name)
          : { ok: false, msg: "社会层未加载" };
      },

      getSeries: function () { return state.series; },
      getEvents: function () { return state.events; },
      getConfig: function () { return cfg; },

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
        return api.getState();
      },

      importState: function (json) {
        var obj = typeof json === "string" ? JSON.parse(json) : json;
        if (!obj || !obj.groups || !obj.stocks) throw new Error("状态格式不正确");
        state = obj;
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
    normalizedShares: normalizedShares
  };

  if (typeof module !== "undefined" && module.exports) module.exports = global.XuanShuSim;
})(typeof globalThis !== "undefined" ? globalThis : this);
