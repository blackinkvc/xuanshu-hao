/* =========================================================================
   玄枢号 · 玩家身份层（sim-player.js）
   -------------------------------------------------------------------------
   玩家不是额外人口，而是名册中某个真实个体的「身份壳」。
   本模块只做四件事：
     1. create / ensure / start：身份状态与开局三选一
     2. sync / yearly：从社会层队列同步属性，更新健康与怀孕
     3. gate / listActions：29 个动作的可用性与人话拒绝原因
     4. act：动作结算（治理动作委托 sim-society，个人动作在本层结算）

   随机只走 state.rngA（XuanShuRand），不引入新随机源。
   ========================================================================= */
(function (global) {
  "use strict";

  var VERSION = "1.0.0";

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function num(v, d) { return typeof v === "number" && isFinite(v) ? v : (d || 0); }
  function rnd(v) { return Math.round(num(v, 0)); }
  function pct(v) { return Math.round(num(v, 0) * 100) + "%"; }

  function randNext(state) {
    if (global.XuanShuRand && global.XuanShuRand.next) return global.XuanShuRand.next(state);
    state.rngA = (state.rngA | 0) + 0x6D2B79F5 | 0;
    var t = Math.imul(state.rngA ^ (state.rngA >>> 15), 1 | state.rngA);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  function pushEvent(state, cfg, type, level, title, text) {
    if (!state.events) state.events = [];
    state.events.push({
      t: (state.loop - 1) * cfg.time.loopYears + state.weeks / cfg.time.weeksPerYear,
      loop: state.loop,
      year: Math.floor(state.weeks / cfg.time.weeksPerYear),
      week: (state.weeks % cfg.time.weeksPerYear) + 1,
      quarter: Math.floor((state.weeks % cfg.time.weeksPerYear) / cfg.time.weeksPerQuarter) + 1,
      type: type,
      level: level,
      title: title,
      text: text,
      basis: ""
    });
    if (state.events.length > cfg.time.eventCap) state.events.shift();
  }

  function qlist(state) {
    return (state.society && state.society.queues) || [];
  }

  function findQueue(state, id) {
    var qs = qlist(state);
    for (var i = 0; i < qs.length; i++) if (qs[i].id === id) return qs[i];
    return null;
  }

  function deptQueues(state, dept) {
    return qlist(state).filter(function (q) { return !dept || q.dept === dept; });
  }

  function zoneOfDept(cfg, dept) {
    var zs = (cfg.people && cfg.people.zones) || [];
    for (var i = 0; i < zs.length; i++) {
      if ((zs[i].depts || []).indexOf(dept) >= 0) return zs[i].id;
    }
    return "Z_hab";
  }

  function zoneName(cfg, id) {
    var zs = (cfg.people && cfg.people.zones) || [];
    for (var i = 0; i < zs.length; i++) if (zs[i].id === id) return zs[i].name;
    return id;
  }

  function garrisonAvail(state, cfg) {
    var g = state.society && state.society.garrison;
    if (!g) return 0;
    var man = clamp(g.strength / cfg.society.garrison.initStrength, 0, 1.2);
    var dur = 0.5 + 0.5 * clamp(g.durability / 100, 0, 1);
    return clamp(man * dur, 0, 1.2);
  }

  function stageName(stage) {
    return stage >= 3 ? "眷属" : (stage === 2 ? "畸变" : (stage === 1 ? "低语" : "清醒"));
  }

  function defaultPc() {
    return {
      name: "无名者", seq: 0, queueId: "", dept: "指挥", zone: "Z_cmd",
      health: 82, pregnant: 0, pregnantWeeks: 0,
      complianceBonus: 0, willBonus: 0, dominionBonus: 0, authorityBonus: 0,
      compliance: 50, will: 30, dominion: 0, authority: 0,
      infectionC: 0, stage: 0, age: 34, infectionYears: 0,
      confinedUntil: -1, interrogatedUntil: -1, hiddenUntil: -1,
      alive: true
    };
  }

  function create(cfg) {
    return {
      version: VERSION,
      started: false, legacy: false, mode: null, chosenWeek: 0,
      pc: defaultPc(),
      intel: "low",
      intelBuff: null,
      scope: { zones: [], depts: [] },
      actionCd: {},
      lockdownUntil: -1,
      history: [],
      flags: {},
      debugForceEncounter: false,
      pendingGrant: "",
      pendingJumpWeeks: 0
    };
  }

  function ensure(state, cfg) {
    if (!state.player || typeof state.player !== "object") {
      state.player = create(cfg);
      // 老存档：不启用身份与奇遇，保持原有模拟行为
      state.player.mode = "creator";
      state.player.legacy = true;
      state.player.intel = "truth";
    }
    var p = state.player;
    if (!p.pc) p.pc = defaultPc();
    var d = defaultPc();
    Object.keys(d).forEach(function (k) {
      if (typeof p.pc[k] === "undefined") p.pc[k] = d[k];
    });
    if (!p.actionCd || typeof p.actionCd !== "object") p.actionCd = {};
    if (!p.scope) p.scope = { zones: [], depts: [] };
    if (!p.history) p.history = [];
    if (typeof p.lockdownUntil !== "number") p.lockdownUntil = -1;
    if (typeof p.chosenWeek !== "number") p.chosenWeek = 0;
    if (typeof p.intel !== "string") p.intel = cfg.player.intel[p.mode] || "low";
    return p;
  }

  function queueFor(state, cfg, mode, opts) {
    opts = opts || {};
    var qs = qlist(state);
    if (mode === "ruler") {
      return findQueue(state, opts.queueId || "L1") || qs.filter(function (q) { return q.layer === "L1"; })[0] || null;
    }
    if (mode === "mid") {
      var dept = opts.dept || "指挥";
      return qs.filter(function (q) { return q.layer === "L2" && q.dept === dept; })[0] ||
        qs.filter(function (q) { return q.layer === "L2"; })[0] || null;
    }
    if (mode === "slave") {
      var d2 = opts.dept || "勤务";
      return qs.filter(function (q) { return q.layer === "L4" && q.dept === d2; })[0] ||
        qs.filter(function (q) { return q.layer === "L4"; })[0] || null;
    }
    return null;
  }

  function start(state, cfg, mode, opts) {
    if (!cfg.player || cfg.player.enabled === false) return { ok: false, msg: "玩家身份层未启用" };
    if (cfg.player.modes.indexOf(mode) < 0) return { ok: false, msg: "未知身份：" + mode };
    if (mode === "creator" && cfg.player.creatorEntry === false) {
      return { ok: false, msg: "创造模式入口已关闭" };
    }
    var p = ensure(state, cfg);
    if (p.started) return { ok: false, msg: "本局已选择身份：" + p.mode };
    var q = queueFor(state, cfg, mode, opts);
    if (mode !== "creator" && !q) return { ok: false, msg: "没有可绑定的队列" };

    p.started = true;
    p.legacy = false;
    p.mode = mode;
    p.chosenWeek = state.weeks;
    p.pc = defaultPc();
    p.pc.health = cfg.player.startingHealth;
    p.pc.name = (opts && opts.name) || (mode === "ruler" ? "最高贵族" : (mode === "mid" ? "中层贵族" : "无名奴隶"));
    p.intel = cfg.player.intel[mode] || "low";
    p.intelBuff = null;
    p.scope = { zones: [], depts: [] };

    if (q) {
      p.pc.queueId = q.id;
      p.pc.dept = q.dept || "勤务";
      p.pc.zone = zoneOfDept(cfg, p.pc.dept);
      p.pc.seq = mode === "ruler" ? 0 : (mode === "mid" ? 1 : 100);
      p.pc.compliance = clamp(q.O + num(cfg.player.modeCompliance[mode]), 0, 100);
      p.pc.will = clamp(q.W + num(cfg.player.modeWill[mode]), 0, 100);
      p.pc.dominion = clamp(num(q.D) + num(cfg.player.titleDominion[mode]), 0, 100);
      p.pc.authority = num(cfg.player.authority[mode]);
      p.pc.infectionC = num(q.C);
      p.pc.stage = p.pc.infectionC >= 85 ? 3 : (p.pc.infectionC >= 60 ? 2 : (p.pc.infectionC >= 30 ? 1 : 0));
    } else {
      p.pc.queueId = "";
      p.pc.dept = "";
      p.pc.zone = "Z_cmd";
      p.pc.authority = 100;
      p.pc.dominion = 100;
      p.intel = "truth";
    }

    p.scope = scopeOf(state, cfg, p);
    pushEvent(state, cfg, "player_start", "身份",
      "开局 · " + modeLabel(mode),
      "绑定 " + (q ? q.name + "（" + q.id + "）" : "观测者") + "；可见情报 " + p.intel);
    return { ok: true, msg: "已选择身份：" + modeLabel(mode), player: brief(state, cfg) };
  }

  function modeLabel(mode) {
    return { ruler: "统治者", mid: "中层贵族", slave: "奴隶", creator: "创造模式" }[mode] || mode;
  }

  function intelRank(s) {
    return { low: 0, mid: 1, high: 2, truth: 3 }[s] || 0;
  }

  function effectiveIntel(state, cfg, p) {
    if (p.mode === "creator") return "truth";
    var base = cfg.player.intel[p.mode] || "low";
    if (p.intelBuff && state.weeks < p.intelBuff.until) {
      var lv = p.intelBuff.level;
      if (intelRank(lv) > intelRank(base)) return lv;
    }
    return base;
  }

  function scopeOf(state, cfg, p) {
    if (p.mode === "creator") return { zones: [], depts: [], all: true };
    if (p.mode === "ruler") return { zones: [], depts: [], all: true };
    if (p.mode === "mid") {
      var z = zoneOfDept(cfg, p.pc.dept);
      return { zones: [z], depts: [p.pc.dept], all: false };
    }
    return { zones: [p.pc.zone], depts: [], all: false };
  }

  function sync(state, cfg) {
    var p = ensure(state, cfg);
    if (!p.started || p.mode === "creator") {
      p.scope = scopeOf(state, cfg, p);
      return;
    }
    var q = findQueue(state, p.pc.queueId);
    if (q) {
      p.pc.compliance = clamp(num(q.O) + num(p.pc.complianceBonus) + num(cfg.player.modeCompliance[p.mode]), 0, 100);
      p.pc.will = clamp(num(q.W) + num(p.pc.willBonus) + num(cfg.player.modeWill[p.mode]), 0, 100);
      p.pc.dominion = clamp(num(q.D) + num(p.pc.dominionBonus) + num(cfg.player.titleDominion[p.mode]), 0, 100);
      p.pc.infectionC = clamp(num(q.C), 0, 100);
      p.pc.stage = p.pc.infectionC >= 85 ? 3 : (p.pc.infectionC >= 60 ? 2 : (p.pc.infectionC >= 30 ? 1 : 0));
    }
    p.pc.authority = clamp(num(cfg.player.authority[p.mode]) + num(p.pc.authorityBonus), 0, 100);

    var I = state.inputs || {};
    var ration = num(I.ration, 1);
    var med = num(state.last && state.last.medCoverage, 0.8);
    var h = num(p.pc.health, cfg.player.startingHealth);
    h += (80 - h) * num(cfg.player.healthRegress, 0.01);
    h += (ration - 1) * 6;
    h += (med - 0.80) * 10;
    h -= p.pc.infectionC * 0.02;
    // v1.3 感染慢性侵蚀：按感染-年累积，超过免疫容忍度后线性扣健康。
    // 累积量记在玩家身上，跨千年回滚保留；容忍度以内完全不生效。
    p.pc.infectionYears = num(p.pc.infectionYears, 0) + p.pc.infectionC / 100 / 52;
    var chronic = Math.max(0, p.pc.infectionYears - num(cfg.player.infectionFreeYears, 800));
    h -= num(cfg.player.infectionChronicK, 0) * chronic;
    if (p.pc.pregnant) h -= 0.10;
    if (state.weeks < p.pc.confinedUntil) h -= 0.35;
    if (state.weeks < p.pc.interrogatedUntil) h -= 0.50;
    p.pc.health = clamp(h, 0, 100);
    if (p.pc.health <= 0 && p.pc.alive) {
      p.pc.alive = false;
      p.pc.health = 0;
      pushEvent(state, cfg, "player_death", "终局", "玩家死亡", "健康归零，身份层终止。");
    }
    p.intel = effectiveIntel(state, cfg, p);
    p.scope = scopeOf(state, cfg, p);
  }

  function yearly(state, cfg) {
    var p = ensure(state, cfg);
    if (!p.started || p.mode === "creator" || !p.pc.alive) return;
    p.pc.age = num(p.pc.age, 34) + 1;

    if (p.pc.pregnant) {
      p.pc.pregnantWeeks = num(p.pc.pregnantWeeks, 0) + 1;
      if (p.pc.pregnantWeeks >= cfg.player.pregnancyWeeks) {
        p.pc.pregnant = 0;
        p.pc.pregnantWeeks = 0;
        p.pc.health = clamp(p.pc.health - 10, 0, 100);
        if (state.groups && state.groups.undecided) {
          state.groups.undecided.awake = num(state.groups.undecided.awake) + 1;
        }
        pushEvent(state, cfg, "player_birth", "身份", "玩家分娩", "健康 −10，未定人口 +1。");
      }
      return;
    }

    if (p.pc.health < 50 || state.weeks < p.pc.confinedUntil || state.weeks < p.pc.interrogatedUntil) return;
    var chance = num(cfg.player.pregnancyBase, 0.08) * (p.pc.health / 100) *
      (1 - p.pc.infectionC / 150);
    if (p.mode === "ruler" || p.mode === "mid") chance += 0.02;
    // 丰穰之腹的祝福：孕期概率 ×1.5（旁约 ×1.25）
    if (global.XuanShuGods) chance *= global.XuanShuGods.pregnancyMul(state, cfg);
    if (randNext(state) < chance) {
      p.pc.pregnant = 1;
      p.pc.pregnantWeeks = 0;
      pushEvent(state, cfg, "player_pregnant", "身份", "怀孕", "孕期 " + cfg.player.pregnancyWeeks + " 周。");
    }
  }

  /* ---------------- 属性与门禁 ---------------- */

  function attrs(state, cfg) {
    var p = ensure(state, cfg);
    return {
      health: rnd(p.pc.health),
      compliance: rnd(p.pc.compliance),
      will: rnd(p.pc.will),
      dominion: rnd(p.pc.dominion),
      authority: rnd(p.pc.authority),
      infectionC: rnd(p.pc.infectionC),
      stage: p.pc.stage,
      stageName: stageName(p.pc.stage),
      pregnant: !!p.pc.pregnant,
      pregnantWeeks: rnd(p.pc.pregnantWeeks),
      confined: state.weeks < p.pc.confinedUntil,
      interrogated: state.weeks < p.pc.interrogatedUntil,
      hidden: state.weeks < p.pc.hiddenUntil,
      zone: p.pc.zone,
      zoneName: zoneName(cfg, p.pc.zone),
      dept: p.pc.dept,
      intel: p.intel,
      order: num(state.order, 0),
      garrison: garrisonAvail(state, cfg),
      lockdown: state.weeks < p.lockdownUntil
    };
  }

  function mergeGate(act, mode) {
    var g = {};
    var keys = ["gate", mode === "mid" ? "gateMid" : (mode === "slave" ? "gateSlave" : null)];
    keys.forEach(function (k) {
      if (!k || !act[k]) return;
      Object.keys(act[k]).forEach(function (x) { g[x] = act[k][x]; });
    });
    return g;
  }

  function reason(p, cfg, a, code, need) {
    var q = findQueue(stateOf(p), p.pc.queueId);
    var zone = zoneName(cfg, p.pc.zone);
    var left;
    switch (code) {
      case "mode":
        return "该动作只有" + a.mode.map(modeLabel).join(" / ") + "可用，" + modeLabel(p.mode) + "没有这条路径";
      case "confined":
        left = Math.max(0, p.pc.confinedUntil - stateOf(p).weeks);
        return "你被禁闭在" + zone + "，还剩 " + left + " 周，没有人会听你的号令";
      case "interrogated":
        left = Math.max(0, p.pc.interrogatedUntil - stateOf(p).weeks);
        return "审讯尚未结束（还剩 " + left + " 周），任何动作都会被记录";
      case "hidden":
        left = Math.max(0, p.pc.hiddenUntil - stateOf(p).weeks);
        return "你正在躲藏，还剩 " + left + " 周，不能行动";
      case "health":
        return "健康只有 " + rnd(p.pc.health) + "（需 ≥" + need + "），你连站都站不稳";
      case "pregnant":
        return "孕期第 " + rnd(p.pc.pregnantWeeks) + " 周，无法执行该动作";
      case "stage":
        return "感染已到" + stageName(p.pc.stage) + "阶段，身体不听使唤";
      case "infection":
        return "感染度只有 " + rnd(p.pc.infectionC) + "（需 ≥" + need + "），你还没有听见低语";
      case "compliance":
        return "服从度只有 " + rnd(p.pc.compliance) + "（需 ≥" + need + "），你的命令传不出这层甲板";
      case "willMin":
        return "自由意志 " + rnd(p.pc.will) + " 低于 " + need + "，你还没有下定决心";
      case "willMax":
        return "自由意志 " + rnd(p.pc.will) + " 高于 " + need + "，你已经不肯按旧规矩行事";
      case "dominion":
        var target = (a.effect && a.effect.type === "purge_tech") ? "技术环"
          : (p.mode === "mid" ? (p.pc.dept || "该部门") : "全船");
        return "统御力不足 " + rnd(p.pc.dominion) + "（需 ≥" + need + "），无法号令" + target;
      case "authority":
        return "你的权限等级 " + rnd(p.pc.authority) + "（需 ≥" + need + "），" +
          (p.pc.dept || "该部门") + "不在你的管辖内";
      case "order":
        return "全船秩序 " + pct(num(stateOf(p).order, 0)) + "（需 ≥" + pct(need) + "），现在下令只会激起反弹";
      case "orderMax":
        return "全船秩序 " + pct(num(stateOf(p).order, 0)) + "（需 ≤" + pct(need) + "），现在太稳了，反而不好动手";
      case "garrison":
        return "警备可用度 " + pct(garrisonAvail(stateOf(p), cfg)) + "（需 ≥" + pct(need) + "），没有人手执行";
      case "garrisonMax":
        return "警备可用度 " + pct(garrisonAvail(stateOf(p), cfg)) + "（需 ≤" + pct(need) + "），巡逻太密，跑不掉";
      case "lockdown":
        return "当前处于封锁状态，舱门不开";
      case "zone":
        return "你不在" + need + "，够不到控制台";
      case "dept":
        return "你只管" + p.pc.dept + "，" + need + "不归你调";
      case "intel":
        return "情报档位不足（当前 " + p.intel + "，需 " + need + "），你根本不知道目标在哪";
      case "cooldown":
        left = Math.max(0, (p.actionCd[a.id] || 0) - stateOf(p).weeks);
        return "距离上次「" + a.label + "」还需要 " + left + " 周";
      default:
        return "当前无法执行该动作";
    }
  }

  // 小工具：reason 需要 state，但参数里只传 p；用队列上的反向引用避免污染接口
  var _stateRef = null;
  function stateOf(p) { return _stateRef || { weeks: 0, order: 0, society: { garrison: null } }; }

  function gate(state, cfg, id, payload) {
    _stateRef = state;
    var p = ensure(state, cfg);
    var a = cfg.player.actions[id];
    if (!a) return { ok: false, code: "unknown", reason: "未知动作：" + id };
    if (!p.started && !p.legacy) return { ok: false, code: "nomode", reason: "尚未选择身份，不能行动" };
    // 创造模式不受身份限制：29 个动作全部可调用
    if (p.mode === "creator") return { ok: true, code: "", reason: "" };
    if (a.mode.indexOf(p.mode) < 0) {
      return { ok: false, code: "mode", reason: reason(p, cfg, a, "mode") };
    }

    var g = mergeGate(a, p.mode);
    var at = attrs(state, cfg);

    if (g.confined === false && at.confined) return { ok: false, code: "confined", reason: reason(p, cfg, a, "confined") };
    if (g.interrogated === false && at.interrogated) return { ok: false, code: "interrogated", reason: reason(p, cfg, a, "interrogated") };
    if (id === "interrogate" && num(state.society.garrison.infiltrators) < 1) {
      return { ok: false, code: "infiltrator", reason: "没有可用的潜伏机（需 ≥1 台），审讯无法开始" };
    }
    if (at.hidden && id !== "hide") return { ok: false, code: "hidden", reason: reason(p, cfg, a, "hidden") };
    if (num(g.healthMin) && at.health < g.healthMin) return { ok: false, code: "health", reason: reason(p, cfg, a, "health", g.healthMin) };
    if (g.pregnant === "deny" && at.pregnant) return { ok: false, code: "pregnant", reason: reason(p, cfg, a, "pregnant") };
    if (typeof g.stageMax === "number" && at.stage > g.stageMax) return { ok: false, code: "stage", reason: reason(p, cfg, a, "stage") };
    if (typeof g.infectionMin === "number" && at.infectionC < g.infectionMin) return { ok: false, code: "infection", reason: reason(p, cfg, a, "infection", g.infectionMin) };
    if (typeof g.complianceMin === "number" && at.compliance < g.complianceMin) return { ok: false, code: "compliance", reason: reason(p, cfg, a, "compliance", g.complianceMin) };
    if (typeof g.willMin === "number" && at.will < g.willMin) return { ok: false, code: "willMin", reason: reason(p, cfg, a, "willMin", g.willMin) };
    if (typeof g.willMax === "number" && at.will > g.willMax) return { ok: false, code: "willMax", reason: reason(p, cfg, a, "willMax", g.willMax) };
    if (typeof g.dominionMin === "number" && at.dominion < g.dominionMin) return { ok: false, code: "dominion", reason: reason(p, cfg, a, "dominion", g.dominionMin) };
    if (typeof g.authorityMin === "number" && at.authority < g.authorityMin) return { ok: false, code: "authority", reason: reason(p, cfg, a, "authority", g.authorityMin) };
    if (typeof g.orderMin === "number" && at.order < g.orderMin) return { ok: false, code: "order", reason: reason(p, cfg, a, "order", g.orderMin) };
    if (typeof g.orderMax === "number" && at.order > g.orderMax) return { ok: false, code: "orderMax", reason: reason(p, cfg, a, "orderMax", g.orderMax) };
    if (typeof g.garrisonMin === "number" && at.garrison < g.garrisonMin) return { ok: false, code: "garrison", reason: reason(p, cfg, a, "garrison", g.garrisonMin) };
    if (typeof g.garrisonMax === "number" && at.garrison > g.garrisonMax) return { ok: false, code: "garrisonMax", reason: reason(p, cfg, a, "garrisonMax", g.garrisonMax) };
    if (g.lockdown === "no" && at.lockdown) return { ok: false, code: "lockdown", reason: reason(p, cfg, a, "lockdown") };
    if (g.lockdown === "yes" && !at.lockdown) return { ok: false, code: "lockdown", reason: "当前没有封锁，无法执行该动作" };
    if (g.zones && g.zones.length && g.zones.indexOf(p.pc.zone) < 0) {
      return { ok: false, code: "zone", reason: reason(p, cfg, a, "zone", g.zones.map(function (z) { return zoneName(cfg, z); }).join(" / ")) };
    }
    if (g.deptOnly && payload && payload.dept && payload.dept !== p.pc.dept) {
      return { ok: false, code: "dept", reason: reason(p, cfg, a, "dept", payload.dept) };
    }
    if (g.intelMin && intelRank(at.intel) < intelRank(g.intelMin)) {
      return { ok: false, code: "intel", reason: reason(p, cfg, a, "intel", g.intelMin) };
    }
    var cdLeft = (p.actionCd[id] || 0) - state.weeks;
    if (cdLeft > 0) {
      return { ok: false, code: "cooldown", reason: "距离上次「" + a.label + "」还需要 " + cdLeft + " 周" };
    }
    return { ok: true, code: "", reason: "" };
  }

  function listActions(state, cfg) {
    var p = ensure(state, cfg);
    var out = [];
    Object.keys(cfg.player.actions).forEach(function (id) {
      var a = cfg.player.actions[id];
      var g = gate(state, cfg, id);
      out.push({
        id: id, label: a.label, cat: a.cat, mode: a.mode,
        modeOk: !!p.mode && a.mode.indexOf(p.mode) >= 0,
        available: g.ok, reason: g.reason, code: g.code,
        cdLeft: Math.max(0, (p.actionCd[id] || 0) - state.weeks),
        desc: a.desc || ""
      });
    });
    return out;
  }

  /* ---------------- 动作结算 ---------------- */

  function addQueue(state, filter, key, v) {
    qlist(state).forEach(function (q) {
      if (!filter || filter(q)) q[key] = clamp(num(q[key]) + v, 0, 1);
    });
  }

  function addQueue100(state, filter, key, v, cfgKey) {
    qlist(state).forEach(function (q) {
      if (!filter || filter(q)) q[key] = clamp(num(q[key]) + v, 0, 100);
    });
  }

  function markCd(p, id, weeks) {
    p.actionCd[id] = Math.max(p.actionCd[id] || 0, weeks);
  }

  function riskCheck(state, cfg, a) {
    var p = ensure(state, cfg);
    var at = attrs(state, cfg);
    var factors = {
      skill: (p.mode === "slave" ? at.will : at.dominion) / 100,
      guard: at.garrison,
      risk: num(a.risk, 0.3),
      will: at.will / 100,
      pressure: 0
    };
    var success = true;
    if (global.XuanShuJudge) {
      var r = global.XuanShuJudge.check(state, cfg, "player_risk", factors, { slot: "player_risk:" + a.id });
      success = r.judged ? r.fired : (randNext(state) > num(a.risk, 0.3));
    } else {
      success = randNext(state) > num(a.risk, 0.3);
    }
    return success;
  }

  function riskFail(state, cfg, id, p) {
    var critical = false;
    if (id === "steal_food") {
      p.pc.health = clamp(p.pc.health - 6, 0, 100);
      p.pc.confinedUntil = Math.max(p.pc.confinedUntil, state.weeks + 4);
    } else if (id === "black_market") {
      state.stocks.metal = Math.max(0, num(state.stocks.metal) - 10);
      p.pc.confinedUntil = Math.max(p.pc.confinedUntil, state.weeks + 4);
    } else if (id === "sabotage") {
      p.pc.health = clamp(p.pc.health - 15, 0, 100);
      p.pc.confinedUntil = Math.max(p.pc.confinedUntil, state.weeks + 8 + Math.floor(randNext(state) * 5));
      var d0 = state.society.depts[p.pc.dept];
      if (d0) d0.I = clamp(d0.I + 0.08, 0, 1);
    } else if (id === "escape") {
      p.pc.health = clamp(p.pc.health - 20, 0, 100);
      p.pc.confinedUntil = Math.max(p.pc.confinedUntil, state.weeks + 12);
      if (randNext(state) < 0.1) {
        p.pc.alive = false;
        p.pc.health = 0;
        critical = true;
      }
    } else if (id === "eavesdrop") {
      p.pc.confinedUntil = Math.max(p.pc.confinedUntil, state.weeks + 4);
    } else if (id === "embezzle") {
      p.pc.authorityBonus = num(p.pc.authorityBonus) - 8;
      var q = findQueue(state, p.pc.queueId);
      if (q) q.S = clamp(q.S + 0.08, 0, 1);
    } else if (id === "inform" || id === "inform_peer") {
      p.pc.health = clamp(p.pc.health - 8, 0, 100);
      p.pc.confinedUntil = Math.max(p.pc.confinedUntil, state.weeks + 4);
    }
    return critical;
  }

  function setStatePath(state, path, value) {
    if (!path || typeof path !== "string") return false;
    var parts = path.split(".");
    if (parts[0] === "state") parts.shift();
    if (!parts.length) return false;
    var o = state;
    for (var i = 0; i < parts.length - 1; i++) {
      if (parts[i] === "__proto__" || parts[i] === "prototype" || parts[i] === "constructor") return false;
      if (!o[parts[i]] || typeof o[parts[i]] !== "object") o[parts[i]] = {};
      o = o[parts[i]];
    }
    var last = parts[parts.length - 1];
    if (last === "__proto__" || last === "prototype" || last === "constructor") return false;
    o[last] = value;
    return true;
  }

  function act(state, cfg, id, payload) {
    payload = payload || {};
    var p = ensure(state, cfg);
    var a = cfg.player.actions[id];
    if (!a) return { ok: false, msg: "未知动作：" + id };
    var g = gate(state, cfg, id, payload);
    if (!g.ok) return { ok: false, msg: g.reason, code: g.code, action: id };

    var msg = "";
    var critical = false;
    var at;

    if (a.society) {
      var r = global.XuanShuSociety && global.XuanShuSociety.act
        ? global.XuanShuSociety.act(state, cfg, a.society) : { ok: false, msg: "社会层未加载" };
      if (!r.ok) return { ok: false, msg: r.msg, action: id };
      msg = r.msg;
      if (id === "replace_mid") p.pc.dominionBonus = num(p.pc.dominionBonus) - 8;
      if (id === "lockdown") p.lockdownUntil = Math.max(p.lockdownUntil, state.weeks + cfg.society.actions.lockdown.isoWeeks);
      markCd(p, id, a.cdWeeks);
    } else {
      at = attrs(state, cfg);
      var et = a.effect ? a.effect.type : "";

      if (et === "input") {
        var v = payload.value;
        if (typeof v !== "number") v = num(state.inputs[a.effect.key], 1);
        v = clamp(v, a.effect.min, a.effect.max);
        state.inputs[a.effect.key] = v;
        var dv = v - 1;
        state.order = clamp(num(state.order) + dv * 0.05, 0.05, 1);
        addQueue100(state, null, "O", dv * 10);
        msg = a.label + "：设为 " + v.toFixed(2) + "，秩序 " + (dv >= 0 ? "+" : "") + (dv * 5).toFixed(1) + "%";
        markCd(p, id, a.cdWeeks);
      } else if (et === "audience") {
        state.order = clamp(num(state.order) + 0.02, 0.05, 1);
        addQueue100(state, null, "O", 2);
        var base = effectiveIntel(state, cfg, p);
        var buff = base === "low" ? "mid" : "high";
        p.intelBuff = { level: buff, until: state.weeks + 8 };
        msg = "巡视：秩序 +2%，服从 +2，情报提升到 " + buff + "（8 周）";
        markCd(p, id, a.cdWeeks);
      } else if (et === "purge_tech") {
        if (state.society.machine) state.society.machine.tech = clamp(num(state.society.machine.tech) - 0.03, 0, 1);
        var dT = state.society.depts["技术"];
        if (dT) dT.I = clamp(num(dT.I) - 0.15, 0, 1);
        addQueue100(state, function (q) { return q.dept === "技术"; }, "W", 4);
        msg = "清洗技术环：科技 −0.03，技术环失序 −0.15，技术队列自由意志 +4";
        markCd(p, id, a.cdWeeks);
      } else if (et === "petition") {
        var okP = randNext(state) < 0.5;
        if (okP) {
          var needFood = num(state.stocks.food) < 60;
          var needMetal = num(state.stocks.metal) < 80;
          if (needFood) { state.stocks.food = num(state.stocks.food) + 20; msg = "上奏获批：粮食 +20 t"; }
          else if (needMetal) { state.stocks.metal = num(state.stocks.metal) + 15; msg = "上奏获批：金属 +15 t"; }
          else { state.society.garrison.strength = num(state.society.garrison.strength) + 5; msg = "上奏获批：警备兵力 +5"; }
        } else {
          state.order = clamp(num(state.order) - 0.01, 0.05, 1);
          msg = "上奏被驳回：秩序 −1%";
        }
        markCd(p, id, a.cdWeeks);
      } else if (et === "inform_peer") {
        p.pc.authorityBonus = num(p.pc.authorityBonus) + 5;
        var peers = qlist(state).filter(function (q) { return q.layer === "L2" && q.id !== p.pc.queueId; });
        if (peers.length) peers[0].S = clamp(num(peers[0].S) + 0.05, 0, 1);
        addQueue100(state, function (q) { return q.dept === p.pc.dept; }, "W", 2);
        msg = "举报同僚：权限 +5，同僚应力 +0.05，本部门自由意志 +2";
        markCd(p, id, a.cdWeeks);
      } else if (et === "embezzle") {
        var okE = riskCheck(state, cfg, a);
        state.order = clamp(num(state.order) - 0.02, 0.05, 1);
        if (okE) {
          if (num(state.stocks.food) < 60) { state.stocks.food = num(state.stocks.food) + 15; msg = "截留成功：粮食 +15 t，秩序 −2%"; }
          else { state.stocks.metal = num(state.stocks.metal) + 20; msg = "截留成功：金属 +20 t，秩序 −2%"; }
        } else {
          critical = riskFail(state, cfg, id, p);
          msg = "截留被发现：权限 −8，同僚应力 +0.08";
        }
        markCd(p, id, a.cdWeeks);
      } else if (et === "inspect") {
        p.intelBuff = { level: effectiveIntel(state, cfg, p) === "low" ? "mid" : "high", until: state.weeks + 26 };
        var dI = state.society.depts[p.pc.dept];
        if (dI) dI.I = clamp(num(dI.I) - 0.05, 0, 1);
        msg = "巡查部门：情报 +1 档 26 周，部门失序 −0.05";
        markCd(p, id, a.cdWeeks);
      } else if (et === "overtime") {
        addQueue100(state, function (q) { return q.id === p.pc.queueId; }, "O", 2);
        addQueue100(state, function (q) { return q.id === p.pc.queueId; }, "W", -2);
        p.pc.health = clamp(p.pc.health - 4, 0, 100);
        if (state.society.effects) state.society.effects.oShift += 1;
        msg = "加班：服从 +2、自由 −2、健康 −4，产出略升";
        markCd(p, id, a.cdWeeks);
      } else if (et === "steal_food") {
        var okS = riskCheck(state, cfg, a);
        if (okS) {
          state.stocks.food = num(state.stocks.food) + 8;
          msg = "偷配给成功：粮食 +8 t";
        } else {
          critical = riskFail(state, cfg, id, p);
          msg = "偷配给被发现：健康 −6，禁闭 4 周";
        }
        markCd(p, id, a.cdWeeks);
      } else if (et === "hide") {
        p.pc.hiddenUntil = Math.max(p.pc.hiddenUntil, state.weeks + 4);
        msg = "躲藏：4 周内被侦测概率 −50%，期间不能行动";
        markCd(p, id, a.cdWeeks);
      } else if (et === "black_market") {
        var choice = payload.choice || "buy_food";
        var okB = riskCheck(state, cfg, a);
        if (okB) {
          if (choice === "sell_food") {
            var sell = Math.min(25, num(state.stocks.food));
            state.stocks.food = num(state.stocks.food) - sell;
            state.stocks.metal = num(state.stocks.metal) + 20;
            msg = "黑市卖出：粮 −" + Math.round(sell) + " t，金属 +20 t";
          } else {
            state.stocks.metal = Math.max(0, num(state.stocks.metal) - 10);
            state.stocks.food = num(state.stocks.food) + 35;
            msg = "黑市买入：金属 −10 t，粮食 +35 t";
          }
        } else {
          critical = riskFail(state, cfg, id, p);
          msg = "黑市被查：金属 −10 t，禁闭 4 周";
        }
        markCd(p, id, a.cdWeeks);
      } else if (et === "inform") {
        var okI = riskCheck(state, cfg, a);
        addQueue100(state, function (q) { return q.id === p.pc.queueId; }, "O", 4);
        addQueue100(state, function (q) { return q.id === p.pc.queueId; }, "W", 2);
        var peers2 = qlist(state).filter(function (q) { return q.layer === "L4" && q.id !== p.pc.queueId; });
        if (peers2.length) peers2[0].S = clamp(num(peers2[0].S) + 0.05, 0, 1);
        if (okI) msg = "告密成功：服从 +4、自由 +2，同僚应力 +0.05";
        else { critical = riskFail(state, cfg, id, p); msg = "告密被报复：健康 −8，禁闭 4 周"; }
        markCd(p, id, a.cdWeeks);
      } else if (et === "sabotage") {
        var okD = riskCheck(state, cfg, a);
        if (okD) {
          state.wear = clamp(num(state.wear) + 0.03, 0, 1);
          var dS = state.society.depts[p.pc.dept];
          if (dS) dS.I = clamp(num(dS.I) + 0.05, 0, 1);
          msg = "破坏成功：磨损 +0.03，部门失序 +0.05";
        } else {
          critical = riskFail(state, cfg, id, p);
          msg = "破坏失败：健康 −15，禁闭 8–12 周，部门失序 +0.08";
        }
        markCd(p, id, a.cdWeeks);
      } else if (et === "escape") {
        var okR = riskCheck(state, cfg, a);
        if (okR) {
          p.pc.zone = "Z_hold";
          p.flags.escaped = true;
          msg = "逃亡成功：已进入休眠舱区";
        } else {
          critical = riskFail(state, cfg, id, p);
          msg = critical ? "逃亡失败：健康归零，身份层终止" : "逃亡失败：健康 −20，禁闭 12 周";
        }
        markCd(p, id, a.cdWeeks);
      } else if (et === "tend_thralls") {
        if (state.society.infection) state.society.infection.thralls = num(state.society.infection.thralls) + 1;
        addQueue100(state, null, "C", 1);
        addQueue100(state, function (q) { return q.id === p.pc.queueId; }, "O", -1);
        msg = "照料眷属：眷属 +1，全队列感染 +1，服从 −1";
        markCd(p, id, a.cdWeeks);
      } else if (et === "eavesdrop") {
        var okV = riskCheck(state, cfg, a);
        if (okV) {
          p.intelBuff = { level: effectiveIntel(state, cfg, p) === "low" ? "mid" : "high", until: state.weeks + 13 };
          msg = "偷听成功：情报 +1 档 13 周";
        } else {
          critical = riskFail(state, cfg, id, p);
          msg = "偷听被发现：禁闭 4 周";
        }
        markCd(p, id, a.cdWeeks);
      } else if (et === "debug_force_encounter") {
        p.debugForceEncounter = true;
        msg = "已排队一次强制奇遇，将在下一次年度检查生成";
      } else if (et === "debug_set_state") {
        var okSet = setStatePath(state, payload.path, payload.value);
        msg = okSet ? "已写入 " + payload.path + " = " + JSON.stringify(payload.value) : "写入失败：非法路径";
        if (!okSet) return { ok: false, msg: msg, action: id };
      } else if (et === "debug_jump_time") {
        var weeks = num(payload.weeks, num(payload.years, 0) * cfg.time.weeksPerYear);
        p.pendingJumpWeeks = Math.max(0, Math.round(weeks));
        msg = "跳时请求已记录：" + p.pendingJumpWeeks + " 周（由引擎逐周执行）";
      } else if (et === "debug_grant_card") {
        p.pendingGrant = payload.cardId || "";
        msg = p.pendingGrant ? "已登记发牌：" + p.pendingGrant : "未指定 cardId";
        if (!p.pendingGrant) return { ok: false, msg: msg, action: id };
      } else if (et === "debug_reveal_truth") {
        msg = "已切到真值视图（仅前端显示）";
      } else {
        msg = a.label + "：已执行";
        markCd(p, id, a.cdWeeks);
      }
    }

    p.history.push({ week: state.weeks, year: Math.floor(state.weeks / cfg.time.weeksPerYear), action: id, ok: true, msg: msg });
    if (p.history.length > 200) p.history.shift();
    pushEvent(state, cfg, "player_action", "行动",
      modeLabel(p.mode) + " · " + a.label,
      msg + (p.mode === "creator" ? "（调试）" : ""));
    return { ok: true, msg: msg, action: id, critical: critical, player: brief(state, cfg) };
  }

  function brief(state, cfg) {
    var p = ensure(state, cfg);
    var at = attrs(state, cfg);
    return {
      version: VERSION,
      started: p.started,
      legacy: p.legacy,
      mode: p.mode,
      modeLabel: p.mode ? modeLabel(p.mode) : "",
      chosenWeek: p.chosenWeek,
      name: p.pc.name,
      alive: p.pc.alive,
      age: rnd(p.pc.age),
      attrs: at,
      scope: p.scope,
      lockdown: state.weeks < p.lockdownUntil,
      actionCount: Object.keys(cfg.player.actions).length,
      debug: p.mode === "creator"
    };
  }

  var api = {
    version: VERSION,
    create: create,
    ensure: ensure,
    start: start,
    startGame: start,
    sync: sync,
    yearly: yearly,
    attrs: attrs,
    gate: gate,
    listActions: listActions,
    act: act,
    brief: brief,
    modeLabel: modeLabel,
    zoneOfDept: zoneOfDept
  };

  global.XuanShuPlayer = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : global);
