/* =========================================================================
   玄枢号 · 通用随机判定层（sim-judge.js）
   -------------------------------------------------------------------------
   所有「某个量达到阈值后再掷一次骰子」的机制都走这里：
     五级哗变阶梯 / 感染转化与眷属 / 召唤 / 机器哗变 / 设备故障 / 补给窗口。

   一次判定的完整语义：
     1) 调用方预筛阈值（连续周数、覆盖度等），达线才调用 check()；
     2) 倾向分 T = bias + Σ(因素 × 系数) + 累计压力 × 压力系数；
     3) p = logistic(T) 或线性窗口(T)；
     4) 取一个随机数 u（与 sim-core 共用 state.rngA）；
     5) u < p 成立；不成立则 压力 += pressurePerFail，进入冷却；
        冷却期内不再判；冷却结束后压力按 pressureDecayPerWeek 部分衰减；
     6) lockOnFirst / freezeOnFirst 处理「一次判定后固定下来」的量。

   可复现：随机数只来自 state.rngA，状态导出包含 rngA 与 judge 槽位/日志，
   同一 seed 与同一操作序列，逐位相同；导入后继续跑也一致。
   ========================================================================= */
(function (global) {
  "use strict";

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function num(v) { return typeof v === "number" && isFinite(v) ? v : 0; }

  function ensure(state, cfg) {
    if (!state.judge || typeof state.judge !== "object") {
      state.judge = { seq: 0, slots: {}, log: [], lastWeek: -1 };
    }
    if (!state.judge.slots) state.judge.slots = {};
    if (!state.judge.log) state.judge.log = [];
    state.judge.cfgVersion = cfg && cfg.version;
    return state.judge;
  }

  function slotOf(state, key) {
    var J = ensure(state, {});
    var s = J.slots[key];
    if (!s) {
      s = {
        pressure: 0, cooldownUntil: 0, attempts: 0, successes: 0,
        locked: false, frozen: {}, last: null
      };
      J.slots[key] = s;
    }
    return s;
  }

  function rand01(state) {
    if (global.XuanShuRand) return global.XuanShuRand.next(state);
    // 兜底：与 XuanShuRand 同算法的内联实现（正常加载顺序下不会走到）
    state.rngA |= 0;
    state.rngA = (state.rngA + 0x6D2B79F5) | 0;
    var t = Math.imul(state.rngA ^ (state.rngA >>> 15), 1 | state.rngA);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function probabilityOf(cfg, T) {
    var J = (cfg && cfg.judge) || {};
    if (J.mapping === "linear") {
      var w = num(J.linearWidth) || 0.35;
      return clamp(0.5 + T / (2 * w), 0, 1);
    }
    var k = num(J.logisticK) || 3.2;
    return 1 / (1 + Math.exp(-k * T));
  }

  /**
   * 发出一次判定请求。
   * @param {Object} state 引擎状态
   * @param {Object} cfg   配置
   * @param {string} id    配置里的判定项（judge.items[id]）
   * @param {Object} factors 因素值，如 { stress: 0.52, coverage: 0.31 }
   * @param {Object} [meta] { slot: "infection_thrall:L4_clone", note: "..." }
   * @returns {{judged:boolean, fired:boolean, allow:boolean, reason:string,
   *            tendency:number, probability:number, rand:number, pressure:number}}
   */
  function check(state, cfg, id, factors, meta) {
    meta = meta || {};
    var J = cfg && cfg.judge;
    if (!J || J.enabled === false) {
      return { judged: false, fired: false, allow: true, reason: "disabled" };
    }
    var def = J.items && J.items[id];
    if (!def) {
      return { judged: false, fired: false, allow: true, reason: "no-config" };
    }

    var key = meta.slot || id;
    var s = slotOf(state, key);
    var w = state.weeks | 0;

    if (s.locked) {
      return { judged: false, fired: false, allow: false, reason: "locked", pressure: s.pressure };
    }
    if (w < s.cooldownUntil) {
      return {
        judged: false, fired: false, allow: false, reason: "cooldown",
        cooldownLeft: s.cooldownUntil - w, pressure: s.pressure
      };
    }

    // 冻结因素：第一次判定时记下，之后一直用冻结值
    var freezeList = def.freezeOnFirst || [];
    if (freezeList.length && !s.frozenAt) {
      s.frozenAt = w;
      freezeList.forEach(function (k) { s.frozen[k] = num(factors && factors[k]); });
    }

    var used = {};
    var T = num(def.bias);
    Object.keys(def.factors || {}).forEach(function (k) {
      var v;
      if (k === "pressure") v = s.pressure;
      else if (s.frozen && Object.prototype.hasOwnProperty.call(s.frozen, k)) v = s.frozen[k];
      else v = num(factors && factors[k]);
      used[k] = Math.round(v * 1000) / 1000;
      T += def.factors[k] * v;
    });
    T = clamp(T, -6, 6);

    var p = probabilityOf(cfg, T);
    var u = rand01(state);
    var fired = u < p;

    s.attempts++;
    var cd = def.cooldownWeeks != null ? def.cooldownWeeks
      : (J.cooldownDefault != null ? J.cooldownDefault : 8);

    if (fired) {
      s.successes++;
      s.pressure = clamp(s.pressure * (def.pressureKeepOnSuccess != null ? def.pressureKeepOnSuccess : 1),
        0, num(J.pressureCap) || 3);
    } else {
      var add = def.pressurePerFail != null ? def.pressurePerFail
        : (J.onFailPressure != null ? J.onFailPressure : 0.30);
      s.pressure = clamp(s.pressure + add, 0, num(J.pressureCap) || 3);
    }
    s.cooldownUntil = w + Math.max(0, Math.round(cd));
    if (def.lockOnFirst) s.locked = true;

    var entry = {
      week: w,
      loop: state.loop,
      // 1 基年号，含轮次偏移；与快照里的 year 同一口径（快照为可带小数的年数）
      year: (state.loop - 1) * ((cfg.time && cfg.time.loopYears) || 1000) + Math.floor(w / 52) + 1,
      weekOfYear: (w % 52) + 1,
      quarter: Math.floor((w % 52) / 13) + 1,
      id: id,
      slot: key,
      label: def.label || id,
      tendency: Math.round(T * 1000) / 1000,
      probability: Math.round(p * 1000) / 1000,
      rand: Math.round(u * 1000000) / 1000000,
      result: fired ? "成立" : "未成立",
      pressure: Math.round(s.pressure * 1000) / 1000,
      attempts: s.attempts,
      factors: used,
      note: meta.note || ""
    };
    s.last = {
      week: w, tendency: entry.tendency, probability: entry.probability,
      rand: entry.rand, fired: fired, pressure: entry.pressure
    };

    var log = ensure(state, cfg).log;
    log.push(entry);
    var cap = num(J.logCap) || 400;
    if (log.length > cap) log.splice(0, log.length - cap);

    return {
      judged: true, fired: fired, allow: fired,
      reason: fired ? "success" : "failed",
      tendency: entry.tendency, probability: entry.probability,
      rand: entry.rand, pressure: entry.pressure, attempts: s.attempts,
      entry: entry
    };
  }

  /** 每周推进：冷却结束后按配置部分衰减累计压力（0 = 不清零）。 */
  function tick(state, cfg) {
    var J = cfg && cfg.judge;
    if (!J || J.enabled === false) return;
    var j = ensure(state, cfg);
    var w = state.weeks | 0;
    Object.keys(j.slots).forEach(function (key) {
      var s = j.slots[key];
      var baseId = key.split(":")[0];
      var def = (J.items && J.items[baseId]) || {};
      var dec = def.pressureDecayPerWeek != null ? def.pressureDecayPerWeek
        : (J.pressureDecayPerWeek || 0);
      if (dec > 0 && w > s.cooldownUntil && s.pressure > 0) {
        s.pressure = Math.max(0, s.pressure - dec);
      }
    });
    j.lastWeek = w;
  }

  /** 给页面/主站的摘要：开关、映射方式、计数、最近 10 条。 */
  function brief(state, cfg) {
    var J = cfg && cfg.judge;
    if (!J || J.enabled === false) return { enabled: false };
    var j = ensure(state, cfg);
    var slots = j.slots || {};
    var keys = Object.keys(slots);
    var byItem = {};
    keys.forEach(function (k) {
      var s = slots[k];
      var id = k.split(":")[0];
      var b = byItem[id] || (byItem[id] = { attempts: 0, successes: 0, pressure: 0, cooldown: 0 });
      b.attempts += s.attempts;
      b.successes += s.successes;
      b.pressure = Math.max(b.pressure, Math.round(s.pressure * 100) / 100);
      b.cooldown = Math.max(b.cooldown, Math.max(0, (s.cooldownUntil || 0) - state.weeks));
    });
    var recent = (j.log || []).slice(-10).reverse().map(function (e) {
      return {
        week: e.week, year: e.year, weekOfYear: e.weekOfYear, quarter: e.quarter,
        id: e.id, label: e.label, tendency: e.tendency,
        probability: e.probability, rand: e.rand, result: e.result,
        pressure: e.pressure, factors: e.factors
      };
    });
    return {
      enabled: true,
      mapping: J.mapping || "logistic",
      total: (j.log || []).length,
      seq: j.seq || 0,
      items: byItem,
      recent: recent
    };
  }

  function csvCell(v) {
    var s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /**
   * 导出判定日志。
   * @param {"csv"|"json"} format
   */
  function exportLog(state, cfg, format) {
    var j = ensure(state, cfg);
    var rows = j.log || [];
    if (format === "json") {
      return JSON.stringify({
        kind: "xuanshu-judge-log",
        version: cfg && cfg.version,
        exportedWeek: state.weeks,
        mapping: (cfg.judge && cfg.judge.mapping) || "logistic",
        count: rows.length,
        entries: rows
      }, null, 2);
    }
    var head = ["周序", "轮", "年", "周", "季", "判定项", "标识", "触发量(因素)", "倾向分",
      "概率", "随机数", "结果", "累计压力", "第几次", "备注"];
    var lines = [head.join(",")];
    rows.forEach(function (e) {
      lines.push([
        e.week, e.loop, e.year + 1, e.weekOfYear, e.quarter, e.label, e.id,
        JSON.stringify(e.factors), e.tendency, e.probability, e.rand,
        e.result, e.pressure, e.attempts, e.note
      ].map(csvCell).join(","));
    });
    return lines.join("\n");
  }

  function log(state, cfg) {
    return ensure(state, cfg).log.slice();
  }

  global.XuanShuJudge = {
    version: "1.0.0",
    check: check,
    tick: tick,
    brief: brief,
    log: log,
    exportLog: exportLog,
    probabilityOf: probabilityOf,
    ensure: ensure
  };

  if (typeof module !== "undefined" && module.exports) module.exports = global.XuanShuJudge;
})(typeof globalThis !== "undefined" ? globalThis : this);
