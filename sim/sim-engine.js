/* =========================================================================
   玄枢号 · 引擎门面（sim-engine.js）v2
   -------------------------------------------------------------------------
   这是计算内核对外的唯一入口。它不碰 DOM、不碰样式、不读页面。
   内核仍是三个文件：
     sim-config.js    参数唯一来源（v0.2 起全部时间系数以「周」为单位）
     sim-society.js   社会层（队列、权力树、五级哗变、感染、警备、机器）
     sim-core.js      舰务层（人口、粮食、水、金属、能源、维修、秩序）
   本文件只做「参数 → 实例 → 快照 → 操作 → 订阅」的收口，不改任何数值。

   v2 变更（相对 v1.0.0）：
     内部最小时间步从「1 月」改为「1 周」；1 年 = 52 周，1 季 = 13 周。
     step() 的入参从「月数」改为「步数 + 单位」，默认 1 季（13 周）。
     大跨度（1 年 / 10 年）在内部按周循环，阈值与连续周数一次都不会跳过。

   v2.1 变更（相对 v2.0.0）：
     新增 sim-judge.js（通用随机判定层）与 sim-people.js（个体真实位置）；
     snapshot() 支持 { view:"truth" } / { view:"player", intel }；
     RNG 与判定槽位随 exportState / importState 一起走，续跑逐位一致。

   加载顺序（浏览器）：
     sim-config.js → sim-judge.js → sim-people.js → sim-society.js
     → sim-player.js → sim-encounter.js → sim-gods.js → sim-run.js
     → sim-core.js → sim-engine.js
   Node：
     const engine = require("./sim-engine.js");
   ========================================================================= */
(function (global) {
  "use strict";

  var VERSION = "2.11.0";

  // 一周为 1：单位 → 周数。month 不是整数周，按 52/12 折算后再取整。
  var UNITS = {
    week: 1,
    month: 52 / 12,     // 4.3333
    quarter: 13,
    year: 52,
    decade: 520
  };
  var UNIT_LABEL = {
    week: "周", month: "月", quarter: "季", year: "年", decade: "10 年"
  };
  var UNIT_ALIAS = {
    "周": "week", "星期": "week", "week": "week", "weeks": "week", "w": "week",
    "月": "month", "month": "month", "months": "month", "m": "month",
    "季": "quarter", "季度": "quarter", "quarter": "quarter", "quarters": "quarter", "q": "quarter",
    "年": "year", "year": "year", "years": "year", "y": "year",
    "十年": "decade", "10年": "decade", "decade": "decade", "decades": "decade"
  };

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
    if (global.XUANSHU_CONFIG && global.XuanShuSim && global.XuanShuSociety && global.XuanShuPrison) return;
    if (typeof require === "function") {
      try {
        if (!global.XUANSHU_CONFIG) require("./sim-config.js");
        if (!global.XuanShuJudge) require("./sim-judge.js");
        if (!global.XuanShuPeople) require("./sim-people.js");
        if (!global.XuanShuPrison) require("./sim-prison.js");
        if (!global.XuanShuSociety) require("./sim-society.js");
        if (!global.XuanShuPlayer) require("./sim-player.js");
        if (!global.XuanShuEncounter) require("./sim-encounter.js");
        if (!global.XuanShuGods) require("./sim-gods.js");
        if (!global.XuanShuRun) require("./sim-run.js");
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

  function normalizeUnit(unit) {
    var u = UNIT_ALIAS[String(unit == null ? "" : unit).toLowerCase()] || UNIT_ALIAS[String(unit == null ? "" : unit)];
    return u || null;
  }

  /**
   * 创建一台引擎实例（一台舰、一条时间线）。
   * @param {Object} [options]
   * @param {Object} [options.config]  对 sim-config 的深合并覆盖（只覆盖，不替换）
   * @param {number} [options.seed]    随机数种子（默认 20260101）。同 seed + 同操作序列逐位可复现
   * @returns {Object} engine
   */
  function create(options) {
    ensureDeps();
    options = options || {};
    var sim = global.XuanShuSim.createSim(options);
    var subscribers = [];

    function emit(kind, result, extra) {
      var st = sim.getState();
      var payload = {
        kind: kind,
        result: result || null,
        weeks: extra && typeof extra.weeks === "number" ? extra.weeks : 0,
        unit: extra && extra.unit ? extra.unit : null,
        count: extra && typeof extra.count === "number" ? extra.count : null,
        year: st.year,
        weekOfYear: st.weekOfYear,
        snapshot: st
      };
      for (var i = 0; i < subscribers.length; i++) {
        try { subscribers[i](payload); } catch (e) { /* 订阅者异常不影响引擎 */ }
      }
    }

    /**
     * 推进时间。1 step = 1 个计量单位（默认 1 季 = 13 周）。
     * 大跨度（1 年 = 52 周、10 年 = 520 周）在内部逐周推进后返回一次快照，
     * 因此不会因为步长大而跳过任何阈值判定。
     * @param {number} [count=1]  单位数量
     * @param {"week"|"month"|"quarter"|"year"|"decade"} [unit="quarter"]
     * @returns {Object} 推进后的公开快照（与 sim.getState() 逐字段一致）
     */
    function step(count, unit) {
      var u = unit == null ? "quarter" : normalizeUnit(unit);
      if (!u) throw new Error("未知时间单位：" + unit + "（可选 week / month / quarter / year / decade）");
      var c = typeof count === "number" && isFinite(count) ? count : 1;
      var weeks = Math.max(0, Math.round(c * UNITS[u]));
      var s = sim.step(weeks);
      s.view = "truth";
      emit("step", null, { weeks: weeks, unit: u, count: c });
      return s;
    }

    /** 直接按周推进（等价于 step(n, "week")）。 */
    function stepWeeks(n) { return step(n, "week"); }
    /** 按年推进（等价于 step(n, "year")）。 */
    function stepYears(n) { return step(n, "year"); }

    /**
     * 读取快照。
     *   snapshot()                         → 真值聚合（所有字段都是真值；不含 4,000 条个人明细）
     *   snapshot({ view: "truth" })        → 真值明细（每个人 + 精确分区/房间/岗位）
     *   snapshot({ view: "player", intel }) → 玩家视图（按情报档位裁剪，带误差半径/时间延迟）
     * intel：low / mid / high，缺省 mid。
     * @param {Object} [opts]
     * @returns {Object}
     */
    function snapshot(opts) {
      if (!opts) {
        var s = sim.getState();
        s.view = "truth";   // 显式标记：默认快照全部是真值（人物明细仍要显式请求）
        return s;
      }
      if (opts.view === "player") return sim.playerView({ intel: opts.intel || "mid" });
      if (opts.view === "truth") return sim.truthView({ detail: opts.detail !== false });
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
     * 注意：操作冷却与持续时长均以「周」计，返回值里的 msg 会写明还剩多少周。
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
     * 订阅状态变化。每次 step / apply / trigger / setInputs / reset / import 后触发。
     * @param {(p:{kind:string,result:Object|null,weeks:number,unit:string|null,
     *             count:number|null,year:number,weekOfYear:number,snapshot:Object})=>void} fn
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
      timeUnit: "week",
      units: UNITS,

      // —— 五个核心接口 ——
      step: step,               // 推进（默认 1 季 = 13 周）
      snapshot: snapshot,       // 读取当前快照
      apply: apply,             // 应用一次操作
      subscribe: subscribe,     // 订阅状态变化

      // —— 显式单位别名 ——
      stepWeeks: stepWeeks,
      stepYears: stepYears,

      // —— 只读辅助（给图表与事件流用） ——
      getEvents: function () { return sim.getEvents(); },
      getSeries: function () { return sim.getSeries(); },
      getInputs: function () { return sim.getInputs(); },

      // —— 个体位置：真值 / 玩家视图 ——
      getPeople: function (opts) { return sim.getPeople(opts || { detail: true }); },
      playerView: function (intel) { return sim.playerView({ intel: intel || "mid" }); },
      truthView: function () { return sim.truthView({ detail: true }); },

      // —— 玩家身份层（v2.2.0） ——
      /**
       * 开局三选一 / 创造模式入口。
       * @param {"ruler"|"mid"|"slave"|"creator"} mode
       * @param {{dept?:string, name?:string, queueId?:string}} [opts]
       */
      startGame: function (mode, opts) {
        var r = sim.startGame(mode, opts || {});
        emit("player", r, {});
        return r;
      },
      getPlayer: function () { return sim.getPlayer(); },
      /** 返回全部动作的 {id,label,cat,modeOk,available,reason,code,cdLeft,desc} */
      listActions: function () { return sim.listActions(); },
      /** 执行一个动作；门禁失败返回 {ok:false,msg,code}，不抛异常 */
      doAction: function (id, payload) {
        if (id === "jump_time" && payload && (payload.weeks || payload.years)) {
          var w = payload.weeks || Math.round(payload.years * 52);
          var r0 = sim.playerAct(id, payload);
          if (r0.ok) stepWeeks(w);
          emit("player", r0, {});
          return r0;
        }
        var r = sim.playerAct(id, payload || {});
        emit("player", r, {});
        return r;
      },
      playerAct: function (id, payload) { return this.doAction(id, payload); },

      // —— 奇遇与牌库（v2.2.0） ——
      /** 待选三张 / 牌库进度 / 运气 / 历史 */
      getEncounter: function () { return sim.getEncounter(); },
      /**
       * 三选一结算，立即生效、不可反悔。
       * @param {number} index 0–2
       * @param {{choice?:string, auto?:boolean}} [opts] 卡牌有子选项时传 choice
       * 返回 {ok, msg, needChoice?, choices?, card, encounter}
       */
      chooseCard: function (index, opts) {
        var r = sim.chooseCard(index, opts || {});
        emit("encounter", r, {});
        return r;
      },

      // —— 断粮处置 / 废弃殖民舰七选项（v6.23） ——
      /** 粮食卡一次提交一组勾选：sleep / stop[] / recycle / harvest */
      famineAct: function (choice) {
        if (typeof sim.famineAct !== "function") return { ok: false, msg: "引擎未提供断粮干预" };
        var r = sim.famineAct(choice || {});
        emit("famine", r, {});
        return r;
      },
      /** 废弃殖民舰：按勾选组合结算一次，结果留在 pending 上供原地展示 */
      derelictResolve: function (sel) {
        if (typeof sim.derelictResolve !== "function") return { ok: false, msg: "引擎未提供废弃殖民舰结算" };
        var r = sim.derelictResolve(sel || {});
        emit("encounter", r, {});
        return r;
      },
      /** 收队：把这一单写进历史并清掉 pending */
      derelictClose: function () {
        if (typeof sim.derelictClose !== "function") return { ok: false, msg: "引擎未提供废弃殖民舰结算" };
        var r = sim.derelictClose();
        emit("encounter", r, {});
        return r;
      },

      // —— 五类行星（v6.31） ——
      planetView: function () {
        if (typeof sim.planetView !== "function") return null;
        return sim.planetView();
      },
      planetResolve: function (sel) {
        if (typeof sim.planetResolve !== "function") return { ok: false, msg: "引擎未提供行星结算" };
        var r = sim.planetResolve(sel || {});
        emit("encounter", r, {});
        return r;
      },
      planetClose: function () {
        if (typeof sim.planetClose !== "function") return { ok: false, msg: "引擎未提供行星收队" };
        var r = sim.planetClose();
        emit("encounter", r, {});
        return r;
      },

      // —— 谈判 / 基因抵押（v6.30） ——
      negotiationView: function () {
        if (typeof sim.negotiationView !== "function") return null;
        return sim.negotiationView(true);
      },
      negotiationOffer: function (sel) {
        if (typeof sim.negotiationResolve !== "function") return { ok: false, msg: "引擎未提供谈判结算" };
        var r = sim.negotiationResolve(sel || {});
        emit("encounter", r, {});
        return r;
      },
      negotiationClose: function () {
        if (typeof sim.negotiationClose !== "function") return { ok: false, msg: "引擎未提供谈判收场" };
        var r = sim.negotiationClose();
        emit("encounter", r, {});
        return r;
      },
      mortgageView: function () {
        if (typeof sim.mortgageView !== "function") return null;
        return sim.mortgageView();
      },
      mortgageStart: function (sel) {
        if (typeof sim.mortgageStart !== "function") return { ok: false, msg: "引擎未提供基因抵押" };
        var r = sim.mortgageStart(sel || {});
        emit("encounter", r, {});
        return r;
      },
      mortgageRedeem: function () {
        if (typeof sim.mortgageRedeem !== "function") return { ok: false, msg: "引擎未提供基因抵押" };
        var r = sim.mortgageRedeem();
        emit("encounter", r, {});
        return r;
      },
      mortgageClose: function () {
        if (typeof sim.mortgageClose !== "function") return { ok: false, msg: "引擎未提供基因抵押收场" };
        var r = sim.mortgageClose();
        emit("encounter", r, {});
        return r;
      },

      // —— 监狱与献祭（v2.6.1） ——
      /** 囚徒名册、刑罚分布、俘虏池、累计处决/释放/献祭 */
      getPrison: function () {
        return typeof sim.getPrison === "function" ? sim.getPrison() : null;
      },
      /** 七类献祭来源的可用人数（UI 只展示四组） */
      prisonCandidates: function () {
        return typeof sim.prisonCandidates === "function" ? sim.prisonCandidates() : [];
      },
      /** 献祭结算；source 见 sim-config.sacrifice.sources，time: day/night/private */
      prisonSacrifice: function (sel) {
        if (typeof sim.prisonSacrifice !== "function") return { ok: false, msg: "引擎未提供献祭结算" };
        var r = sim.prisonSacrifice(sel || {});
        emit("prison", r, {});
        return r;
      },

      // —— 古神契约（v2.2.0） ——
      /** 四位神的主约/旁约、神恩、祝福/诅咒、神噬、待回应索取 */
      getGods: function () { return sim.getGods(); },
      /** 回应周期索取；accept=true 接受献祭 */
      resolveTithe: function (accept) {
        var r = sim.resolveTithe(accept);
        emit("gods", r, {});
        return r;
      },

      // —— 千年节点 / 自动推演 / 胜负（v2.2.0） ——
      /** 胜负、节点、运气、连续计数、历史 */
      getRun: function () { return sim.getRun(); },
      /**
       * 结算千年节点；结算后立即回滚进下一轮。
       * @param {"auto"|"manual"} mode auto=自动推演到结束，manual=继续手动
       */
      resolveMillennium: function (mode) {
        var r = sim.resolveMillennium(mode);
        emit("run", r, {});
        return r;
      },
      /** 任意时刻切自动/手动；false 时当前轮走完，下个千年节点重新挂起 */
      setAuto: function (v) {
        var r = sim.setAuto(v);
        emit("run", r, {});
        return r;
      },
      /** 自动推演一个 chunk（默认 1 年）；返回快照，run 未结束可循环调用 */
      autoStep: function (years) {
        var s = sim.autoStep(years);
        emit("auto", null, { weeks: 0 });
        return s;
      },

      // —— 随机判定：日志与导出 ——
      getJudgeLog: function () { return sim.getJudgeLog(); },
      /**
       * 导出判定日志（触发量、倾向分、随机数、结果、累计压力）。
       * @param {"csv"|"json"} [format="csv"]
       */
      exportJudgeLog: function (format) { return sim.exportJudgeLog(format || "csv"); },

      /**
       * 调参入口：只允许修改 sim-config 的 ui.sliders 里声明的键。
       * 返回当前输入值。会发出一次 kind="apply" 通知。
       */
      setInputs: function (patch) {
        var r = sim.setInputs(patch);
        emit("apply", { ok: true, msg: "输入已更新" }, {});
        return r;
      },

      /** 首页三项操控：一次写入配给 / 休眠 / 航速（含秩序代价），返回前后值。 */
      hudCommit: function (patch) {
        var r = sim.hudCommit(patch);
        emit("apply", { ok: true, msg: "船上三项已结算" }, {});
        return r;
      },

      /**
       * 导出/导入完整状态（含历史序列与事件），用于本地存档与主站共享状态。
       * v2 的存档里时间字段是 weeks；导入 v1 存档会因字段不符被拒绝。
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
    timeUnit: "week",
    units: UNITS,
    unitLabel: UNIT_LABEL,
    create: create,
    actions: ACTION_KEYS.slice(),
    events: ["mutiny", "infection"]
  };

  if (typeof module !== "undefined" && module.exports) module.exports = global.XuanShuEngine;
})(typeof globalThis !== "undefined" ? globalThis : this);
