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
      if (last !== undefined && state.weeks - last < cfg.events.cooldownWeeks) return false;
      state.cooldown[type] = state.weeks;
    }
    state.events.push({
      t: Math.round(((state.loop - 1) * cfg.time.loopYears + state.weeks / cfg.time.weeksPerYear) * 100) / 100,
      loop: state.loop,
      year: Math.floor(state.weeks / cfg.time.weeksPerYear),
      week: (state.weeks % cfg.time.weeksPerYear) + 1,
      quarter: Math.floor((state.weeks % cfg.time.weeksPerYear) / cfg.time.weeksPerQuarter) + 1,
      type: type,
      level: level || "事件",
      title: title,
      text: text,
      basis: basis || ""
    });
    if (state.events.length > cfg.time.eventCap) state.events.shift();
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
      // 整数人口流的余数累积：每周向下取整会把年吞吐量削掉一截，
      // 这里把不足一人的部分留到下周，保证 52 周与 12 月的年总量一致。
      flowCarry: { entry: 0, wake: 0, podStart: 0 },
      maint: { sinceFault: 0, active: false, repairLeft: 0, mttr: cfg.maintenance.mttrWeeks,
               faults: 0, lastCycle: 0, lastShift: 0, lastSupply: 0, lastQuarantine: 0 },
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
    // 随机判定槽位 / 日志（与 rngA 一样是状态的一部分，随导出/导入走）
    if (global.XuanShuJudge) state.judge = global.XuanShuJudge.ensure(state, cfg);
    // 个体层：真实位置名册（人数变化时同步，位置按周确定性推导）
    if (global.XuanShuPeople && cfg.people && cfg.people.enabled !== false) {
      state.people = global.XuanShuPeople.create(cfg);
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
      medCoverage: state.last.medCoverage
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
        pushEvent(state, cfg, "maint_done", "维修", "设备修复完成",
          "停机 " + m.mttr + " 周后恢复，农环回到满负荷",
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
          pushEvent(state, cfg, "maint_fault", "维修", "设备故障 · 停机检修",
            "农环一组栽培单元停机，产出降至 " + Math.round(M.downtimeYield * 100) + "%",
            "磨损 " + wear.toFixed(2) + "、维修缺口 " + Math.round(gap * 100) +
            "% → 故障间隔 " + interval + " 周，MTTR " + m.mttr + " 周" +
            (jr ? "；判定 p=" + jr.probability.toFixed(2) + "，随机数 " + jr.rand.toFixed(3) : ""), true);
        } else if (jr.judged) {
          // 判定未成立：保留基数（不清零），冷却结束后再判
          m.sinceFault = interval;
        }
      }
    }

    if (w - m.lastCycle >= M.cycleWeeks) {
      m.lastCycle = w;
      pushEvent(state, cfg, "maint_cycle", "维修", "季度例行检修",
        "第 " + Math.round(w / cfg.time.weeksPerQuarter) + " 季检修完成，未发现结构性缺陷",
        "每 " + M.cycleWeeks + " 周一个检修窗口", true);
    }
    if (w - m.lastShift >= M.shiftWeeks) {
      m.lastShift = w;
      pushEvent(state, cfg, "shift", "轮班", "轮班交接",
        "本班次交接完成，在岗 " + Math.round(totals(state, cfg).working) + " 人",
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
        if (addF > 0) state.stocks.food = Math.min(cfg.food.cap, state.stocks.food + addF);
        if (addM > 0) state.stocks.metal = Math.min(cfg.metal.cap, state.stocks.metal + addM);
        pushEvent(state, cfg, "supply", "补给", "补给窗口 · 行星来货",
          "本窗口补给已入库并完成对账" +
          (addF || addM ? "（粮食 +" + addF + " t、金属 +" + addM + " t）" : ""),
          "补给节奏 " + M.supplyWeeks + " 周" +
          (sjr ? "；判定 p=" + sjr.probability.toFixed(2) : ""), true);
      } else {
        pushEvent(state, cfg, "supply", "补给", "补给窗口 · 未到货",
          state.inputs.planetCut ? "行星补给已切断，本窗口无来货" : "航线延误，本窗口无来货",
          "补给节奏 " + M.supplyWeeks + " 周；判定 p=" +
          (sjr ? sjr.probability.toFixed(2) : "—") + "，压力 " +
          (sjr ? sjr.pressure.toFixed(2) : "—") + "，下个窗口更易到货", true);
      }
    }
    if (w - m.lastQuarantine >= M.quarantineWeeks) {
      m.lastQuarantine = w;
      var ishare = (state.society && state.society.infection)
        ? (state.society.infection.share || 0) : 0;
      pushEvent(state, cfg, "quarantine", "检疫",
        ishare >= M.quarantineShare ? "全船检疫 · 升级" : "例行检疫",
        ishare >= M.quarantineShare
          ? "感染面 " + Math.round(ishare * 100) + "%，隔离区扩大"
          : "抽检完成，未发现新的转化个案",
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
      pushEvent(state, cfg, "build_hydro", "建设", "水培扩建交付",
        "新增 " + state.buildAcc.hydro + " 个栽培单元，总数 " + state.infra.hydro +
        "，等效 " + (state.buildAcc.hydro * 1000).toLocaleString("en-US") + " m²",
        "金属配额到位，工期 " + cfg.metal.hydroLeadWeeks + " 周", true);
      state.buildAcc.hydro = 0;
    }
    if (state.buildAcc.pods >= 50) {
      pushEvent(state, cfg, "build_pods", "建设", "休眠舱交付",
        "新增 " + state.buildAcc.pods + " 个休眠位，总数 " + state.infra.pods,
        "工期 " + cfg.hibernation.podLeadWeeks + " 周", true);
      state.buildAcc.pods = 0;
    }
    if (state.buildAcc.clonePods >= 6) {
      pushEvent(state, cfg, "build_clone", "建设", "克隆槽交付",
        "新增 " + state.buildAcc.clonePods + " 个培育筒，总数 " + state.infra.clonePods,
        "工期 " + cfg.clone.podLeadWeeks + " 周", true);
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
        week: state.weeks
      });
    }

    // 周期事件（周级）：设备故障 / 维修、轮班、补给、隔离检疫
    var maintYield = stepMaintenance(state, cfg);
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
    production *= maintYield;
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
    var weekDeaths = 0;
    cfg.population.groups.forEach(function (g) {
      var s = state.groups[g.id];
      var rate = g.mortality;
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
    var workingIds = cfg.population.groups
      .filter(function (g) { return g.id !== cfg.population.undecidedId; })
      .map(function (g) { return g.id; });

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

    // 只开采实际需要的金属；缺口才吃库存，避免库存无意义地涨到上限
    var needM = maintSpend + constructionSpend;
    var actualSupplyM = Math.min(capM, needM);
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
      if (canExit && state.phaseDown >= cfg.phase.downWeeks) {
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
        state.streaks.strike = cfg.events.strikeWeeks;
        pushEvent(state, cfg, "strike", "事件", "环区停工",
          "秩序 " + state.order.toFixed(2) + "，部分环区停止常规作业",
          "秩序低于 0.40；产出 ×0.85，持续 " + cfg.events.strikeWeeks + " 周", true);
      }
    } else if (state.order >= 0.45) {
      state.latches.strike = false;
    }

    if (rationActual < 0.90) state.streaks.badRation++;
    else state.streaks.badRation = 0;
    if (state.streaks.badRation === cfg.events.bingeWeeks) {
      state.order = clamp(state.order - 0.10, 0.05, 1);
      var killed = killProportional(state, cfg, 0.003);
      pushEvent(state, cfg, "binge", "事件", "配给点争抢",
        "登记冲突，秩序 −0.10，本周额外死亡 " + Math.round(killed) + " 人",
        "实际配给 " + rationActual.toFixed(2) + " 连续 " + cfg.events.bingeWeeks + " 周低于 0.90", true);
    }

    if (extremeActive && rationActual < 0.45) state.streaks.extreme++;
    else state.streaks.extreme = 0;
    if (state.streaks.extreme === cfg.events.atrocityWeeks) {
      state.order = clamp(state.order - 0.18, 0.05, 1);
      var killed2 = killProportional(state, cfg, 0.004);
      state.flags.atrocity = true;
      pushEvent(state, cfg, "atrocity", "危机", "底线事件",
        "配给体系外出现以死者遗体为食的记录，细节封存。秩序 −0.18，本周额外死亡 " + Math.round(killed2) + " 人",
        "实际配给 " + rationActual.toFixed(2) + " 连续 " + cfg.events.atrocityWeeks + " 周低于 0.45，且已授权极端措施", true);
    }

    if (reviveFails >= 1) {
      pushEvent(state, cfg, "revive_fail", "事件", "复温失败",
        "本批唤醒失败 " + Math.round(reviveFails) + " 人",
        "复温失败率 " + ((cfg.hibernation.reviveFail + 0.004 * (1 - medCoverage)) * 100).toFixed(1) + "%", true);
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
      maintGap: maintGap
    };

    state.weeks++;
    // 个体层名册跟随人口变化（只在人数变化时增删，不逐人保存位置）
    if (global.XuanShuPeople && cfg.people && cfg.people.enabled !== false) {
      global.XuanShuPeople.sync(state, cfg);
    }
    if (state.weeks % cfg.time.weeksPerYear === 0) pushSeries(state, cfg);

    // 1000 年回滚
    if (cfg.time.rollback && state.weeks >= cfg.time.loopYears * cfg.time.weeksPerYear) {
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
      if (global.XuanShuSociety) state.society = global.XuanShuSociety.create(cfg);
      if (global.XuanShuPeople) state.people = global.XuanShuPeople.create(cfg);
      // 判定日志保留（跨轮审计），槽位与压力清零（新的一轮重新累积）
      if (global.XuanShuJudge && state.judge) state.judge.slots = {};
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

      // 推进 n 周（内部最小步长就是 1 周；大跨度由这里循环，阈值判定一次都不会漏）
      step: function (weeks) {
        var n = Math.max(0, Math.round(isNum(weeks) ? weeks : 1));
        for (var i = 0; i < n; i++) stepWeek(state, cfg);
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
            ? global.XuanShuSociety.summary(state, cfg) : null,
          // 真值聚合：分区人数（个人明细走 snapshot({view:"truth"})）
          people: (global.XuanShuPeople && state.people)
            ? global.XuanShuPeople.brief(state, cfg) : null,
          // 随机判定摘要：计数、最近 10 条、各槽压力/冷却
          judge: (global.XuanShuJudge && state.judge)
            ? global.XuanShuJudge.brief(state, cfg) : null
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
