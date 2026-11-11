/* =========================================================================
   玄枢号 · 引擎门面（sim-engine.js）
   -------------------------------------------------------------------------
   这是计算内核对外的唯一入口。它不碰 DOM、不碰样式、不读页面。
   内核仍是三个文件：
     sim-config.js    参数唯一来源
     sim-society.js   社会层（队列、权力树、五级哗变、感染、警备、机器）
     sim-core.js      舰务层（人口、粮食、水、金属、能源、维修、秩序）
   本文件只做「参数 → 实例 → 快照 → 操作 → 订阅」的收口，不改任何数值。

   加载顺序（浏览器）：
     sim-config.js → sim-society.js → sim-core.js → sim-engine.js
   Node：
     const engine = require("./sim-engine.js");
   ========================================================================= */
(function (global) {
  "use strict";

  var VERSION = "1.0.0";

  var ACTION_ALIAS = {
    "镇压": "suppress",
    "让步": "concede",
    "处决": "execute",
    "封舱": "lockdown",
    "封舱隔离": "lockdown",
    "换人": "replace",
    "审讯": "interrogate",
    "仪式": "ritual",
    "suppress": "suppress",
    "concede": "concede",
    "execute": "execute",
    "lockdown": "lockdown",
    "replace": "replace",
    "interrogate": "interrogate",
    "ritual": "ritual"
  };

  var EVENT_ALIAS = {
    "mutiny": "mutiny",
    "infection": "infection",
    "哗变": "mutiny",
    "感染": "infection"
  };

  // 允许的公开操作名（与 sim-config 的 society.actions 对应）
  var ACTION_KEYS = ["suppress", "concede", "execute", "replace", "interrogate", "lockdown", "ritual"];

  function ensureDeps() {
    if (global.XUANSHU_CONFIG && global.XuanShuSim && global.XuanShuSociety) return;
    if (typeof require === "function") {
      try {
        if (!global.XUANSHU_CONFIG) require("./sim-config.js");
        if (!global.XuanShuSociety) require("./sim-society.js");
        if (!global.XuanShuSim) require("./sim-core.js");
      } catch (e) { /* 浏览器里没有 require，走下面的报错 */ }
    }
    if (!global.XUANSHU_CONFIG || !global.XuanShuSim) {
      throw new Error("引擎依赖未就绪：请按 sim-config.js → sim-society.js → sim-core.js → sim-engine.js 加载");
    }
    if (!global.XuanShuSociety) {
      throw new Error("引擎依赖未就绪：缺少 sim-society.js（社会层）");
    }
  }

  /**
   * 创建一台引擎实例（一台舰、一条时间线）。
   * @param {Object} [options]
   * @param {Object} [options.config]  对 sim-config 的深合并覆盖（只覆盖，不替换）
   * @param {number} [options.seed]    保留字段；当前模型不使用随机数
   * @returns {Object} engine
   */
  function create(options) {
    ensureDeps();
    options = options || {};
    var sim = global.XuanShuSim.createSim(options);
    var subscribers = [];

    function emit(kind, result, extra) {
      var payload = {
        kind: kind,
        result: result || null,
        months: extra && typeof extra.months === "number" ? extra.months : null,
        snapshot: sim.getState()
      };
      for (var i = 0; i < subscribers.length; i++) {
        try { subscribers[i](payload); } catch (e) { /* 订阅者异常不影响引擎 */ }
      }
    }

    /**
     * 推进时间。1 step = 1 个月。
     * @param {number} [months=1]
     * @returns {Object} 推进后的公开快照（与 sim.getState() 逐字段一致）
     */
    function step(months) {
      var n = Math.max(0, Math.floor(typeof months === "number" ? months : 1));
      var s = sim.step(n);
      emit("step", null, { months: n });
      return s;
    }

    /**
     * 读取当前快照。返回新对象，改它不会影响引擎内部状态。
     * @returns {Object} snapshot
     */
    function snapshot() {
      return sim.getState();
    }

    /**
     * 触发一次事件（不走自然阈值）。
     * @param {"mutiny"|"infection"} type
     * @param {string} [value] mutiny 传部门名；infection 传队列 id
     * @returns {{ok:boolean,msg:string,snapshot:Object}}
     */
    function trigger(type, value) {
      var t = EVENT_ALIAS[type] || EVENT_ALIAS[String(type).toLowerCase()];
      var res;
      if (t === "mutiny") res = sim.triggerMutiny(value);
      else if (t === "infection") res = sim.triggerInfection(value);
      else res = { ok: false, msg: "未知事件类型：" + type };
      res = res || { ok: false, msg: "事件未返回结果" };
      if (res.ok !== false) emit("trigger", res, {});
      return { ok: res.ok !== false, msg: res.msg || "", snapshot: sim.getState() };
    }

    /**
     * 应用一次操作。支持中文名与英文键。
     * 操作：镇压/suppress、让步/concede、处决/execute、封舱/lockdown、
     *       换人/replace、审讯/interrogate、仪式/ritual。
     * 事件：apply("event", { type: "mutiny"|"infection", value: "..." })
     * @param {string} action
     * @param {Object|string} [payload]
     * @returns {{ok:boolean,msg:string,action:string,snapshot:Object}}
     */
    function apply(action, payload) {
      var name = String(action == null ? "" : action);
      if (name === "event" || name === "trigger" || name === "触发事件") {
        var p = payload || {};
        var r = trigger(p.type || p.event, p.value || p.dept || p.group);
        return { ok: r.ok, msg: r.msg, action: "event", snapshot: r.snapshot };
      }
      var key = ACTION_ALIAS[name] || ACTION_ALIAS[name.toLowerCase()];
      if (!key || ACTION_KEYS.indexOf(key) < 0) {
        return { ok: false, msg: "未知操作：" + name, action: name, snapshot: sim.getState() };
      }
      var res = sim.societyAction(key) || { ok: false, msg: "操作未返回结果" };
      if (res.ok !== false) emit("apply", res, {});
      return { ok: res.ok !== false, msg: res.msg || "", action: key, snapshot: sim.getState() };
    }

    /**
     * 订阅状态变化。每次 step / apply / trigger / reset / import 后触发。
     * @param {(p:{kind:string,result:Object|null,months:number|null,snapshot:Object})=>void} fn
     * @returns {Function} 取消订阅
     */
    function subscribe(fn) {
      if (typeof fn !== "function") return function () {};
      subscribers.push(fn);
      return function () {
        var i = subscribers.indexOf(fn);
        if (i >= 0) subscribers.splice(i, 1);
      };
    }

    return {
      version: VERSION,
      configVersion: sim.version,

      // —— 五个核心接口 ——
      step: step,               // 推进一个时间步（默认 1 月）
      snapshot: snapshot,       // 读取当前快照
      apply: apply,             // 应用一次操作
      subscribe: subscribe,     // 订阅状态变化

      // —— 只读辅助（给图表与事件流用） ——
      getEvents: function () { return sim.getEvents(); },
      getSeries: function () { return sim.getSeries(); },
      getInputs: function () { return sim.getInputs(); },

      /**
       * 调参入口：只允许修改 sim-config 的 ui.sliders 里声明的键。
       * 返回当前输入值。会发出一次 kind="apply" 通知。
       */
      setInputs: function (patch) {
        var r = sim.setInputs(patch);
        emit("apply", { ok: true, msg: "输入已更新" }, {});
        return r;
      },

      /**
       * 导出/导入完整状态（含历史序列与事件），用于本地存档与主站共享状态。
       * import 后发出 kind="import" 通知。
       */
      exportState: function () { return sim.exportState(); },
      importState: function (json) {
        var r = sim.importState(json);
        emit("import", { ok: true, msg: "状态已导入" }, {});
        return r;
      },

      /** 回到初始状态，发出 kind="reset" 通知。 */
      reset: function () {
        var r = sim.reset();
        emit("reset", { ok: true, msg: "已重置" }, {});
        return r;
      }
    };
  }

  global.XuanShuEngine = {
    version: VERSION,
    create: create,
    actions: ACTION_KEYS.slice(),
    events: ["mutiny", "infection"]
  };

  if (typeof module !== "undefined" && module.exports) module.exports = global.XuanShuEngine;
})(typeof globalThis !== "undefined" ? globalThis : this);
