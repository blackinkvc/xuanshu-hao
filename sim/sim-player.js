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

  function pushEvent(state, cfg, type, level, title, text, deltas, note) {
    if (!state.events) state.events = [];
    var evYear = Math.floor(state.weeks / cfg.time.weeksPerYear);
    var evWeek = (state.weeks % cfg.time.weeksPerYear) + 1;
    var entry = {
      t: (state.loop - 1) * cfg.time.loopYears + state.weeks / cfg.time.weeksPerYear,
      loop: state.loop,
      year: evYear,
      week: evWeek,
      quarter: Math.floor((state.weeks % cfg.time.weeksPerYear) / cfg.time.weeksPerQuarter) + 1,
      timeLabel: "第 " + (evYear + 1) + " 年第 " + evWeek + " 周",
      type: type,
      level: level,
      title: title,
      text: text,
      basis: ""
    };
    var D = global.XuanShuSim && global.XuanShuSim.cleanDeltas
      ? global.XuanShuSim.cleanDeltas(deltas) : null;
    if (D) entry.deltas = D;
    if (note) entry.note = note;
    var key = global.XuanShuSim && global.XuanShuSim.eventIsKey
      ? global.XuanShuSim.eventIsKey(cfg, entry.type, entry.level) : true;
    if (key) {
      state.events.push(entry);
      if (cfg.events.keyCap && state.events.length > cfg.events.keyCap) state.events.shift();
    } else {
      if (!state.logRing) state.logRing = [];
      state.logRing.push(entry);
      var ring = cfg.events.routineRing || 40;
      while (state.logRing.length > ring) state.logRing.shift();
    }
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
      geneDamage: 18, addiction: 0,
      care: {
        stock: { calm: 2, stim: 2, suppress: 2, deep: 2 },
        active: null, leisure: null, genes: {}, repairs: 0,
        hpBonus: 0, mindBonus: 0, spiritBonus: 0, willBonus: 0,
        infectResist: 0, leisureWeek: -1
      },
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
    // v6.52 个体养护：老存档补 care 结构与每支药剂库存
    if (!p.pc.care || typeof p.pc.care !== "object") p.pc.care = d.care;
    var c = p.pc.care;
    var cd = d.care;
    Object.keys(cd).forEach(function (k) {
      if (typeof c[k] === "undefined") c[k] = cd[k];
    });
    if (!c.stock || typeof c.stock !== "object") c.stock = cd.stock;
    var dcfg = cfg.player && cfg.player.care;
    if (dcfg && dcfg.drugs) {
      Object.keys(dcfg.drugs).forEach(function (k) {
        if (typeof c.stock[k] !== "number") c.stock[k] = num(dcfg.drugs[k].stock, 2);
      });
    }
    if (typeof p.pc.geneDamage !== "number") p.pc.geneDamage = 18;
    if (typeof p.pc.addiction !== "number") p.pc.addiction = 0;
    if (!c.genes || typeof c.genes !== "object") c.genes = {};
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
    if (!cfg.player || cfg.player.enabled === false) return { ok: false, msg: "身份层没开" };
    if (cfg.player.modes.indexOf(mode) < 0) return { ok: false, msg: "没有这个身份" };
    if (mode === "creator" && cfg.player.creatorEntry === false) {
      return { ok: false, msg: "创造模式入口已关闭" };
    }
    var p = ensure(state, cfg);
    if (p.started) return { ok: false, msg: "本局已经选过身份了" };
    var q = queueFor(state, cfg, mode, opts);
    if (mode !== "creator" && !q) return { ok: false, msg: "这个身份现在没有能落脚的位置" };

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
    pushEvent(state, cfg, "player_start", "身份", "你登上了玄枢号",
      "你以" + modeLabel(mode) + "的身份登舰，情报只够看到" + intelText(p.intel) + "。",
      null, "身份定了，接下来怎么活看你自己");
    return { ok: true, msg: "你以" + modeLabel(mode) + "的身份登舰", player: brief(state, cfg) };
  }

  var INTEL_TEXT = {
    low: "街谈巷议",
    mid: "部门里的消息",
    high: "高层里的消息",
    truth: "全部真相"
  };
  function intelText(level) { return INTEL_TEXT[level] || "一点风声"; }

  function modeLabel(mode) {
    return { ruler: "最高贵族", mid: "中层贵族", slave: "奴隶", creator: "创造模式" }[mode] || mode;
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
      // 低语屏障（v6.52 基因强化）：按比例抵掉本周感染读数
      var ires = num(p.pc.care && p.pc.care.infectResist, 0);
      if (ires > 0) p.pc.infectionC = clamp(p.pc.infectionC * (1 - ires), 0, 100);
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
    careTick(state, cfg, p);
    p.pc.health = clamp(p.pc.health, 0, 100);
    if (p.pc.health <= 0 && p.pc.alive) {
      p.pc.alive = false;
      p.pc.health = 0;
      pushEvent(state, cfg, "player_death", "终局", "你死了", "健康归零，意识在维生舱里熄灭。",
      { "健康": -100 }, "这具身体撑不住了");
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
        pushEvent(state, cfg, "player_birth", "身份", "你有了一个孩子", "健康 −10，船上多了 1 个孩子。",
      { "健康": -10, "人口": 1 }, "船上添了一口人");
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
      // 理智：眷属侵染越深，精神状态越差（个体口径，不是群体聚合）
      mind: clamp(Math.round(100 - num(p.pc.stage) * 18 - num(p.pc.infectionC) * 0.35 +
        num(p.pc.care && p.pc.care.mindBonus, 0) + num(p.pc.care && p.pc.care.mindPenalty, 0) +
        careBuffSum(p.pc.care, "mind")), 0, 100),
      // 活跃精神：意志 + 场上加成
      spirit: clamp(Math.round(num(p.pc.will) + num(p.pc.willBonus) + num(p.pc.complianceBonus) * 0.5 +
        num(p.pc.care && p.pc.care.spiritBonus, 0) + careBuffSum(p.pc.care, "spirit")), 0, 100),
      addiction: clamp(Math.round(num(p.pc.addiction, 0)), 0, 100),
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
        return "这个动作只有" + a.mode.map(function (m) { return "「" + modeLabel(m) + "」"; }).join("、") +
          "能做，你的身份做不了";
      case "confined":
        left = Math.max(0, p.pc.confinedUntil - stateOf(p).weeks);
        return "你被关在" + zone + "，还剩 " + left + " 周，没人会听你的";
      case "interrogated":
        left = Math.max(0, p.pc.interrogatedUntil - stateOf(p).weeks);
        return "审讯还没完（还剩 " + left + " 周），你现在做什么都会被记下来";
      case "hidden":
        left = Math.max(0, p.pc.hiddenUntil - stateOf(p).weeks);
        return "你正躲着，还剩 " + left + " 周，动不了";
      case "health":
        return "健康只有 " + rnd(p.pc.health) + "（要 ≥" + need + "），你连站都站不稳";
      case "pregnant":
        return "怀孕第 " + rnd(p.pc.pregnantWeeks) + " 周，做不了这个";
      case "stage":
        return "感染已经到了" + stageName(p.pc.stage) + "，身体不听使唤";
      case "infection":
        return "感染度只有 " + rnd(p.pc.infectionC) + "（要 ≥" + need + "），你还没听见低语";
      case "compliance":
        return "服从度只有 " + rnd(p.pc.compliance) + "（要 ≥" + need + "），你的话传不出这层甲板";
      case "willMin":
        return "不服只有 " + rnd(p.pc.will) + "，低于 " + need + "，你还没下定决心";
      case "willMax":
        return "不服已经到了 " + rnd(p.pc.will) + "，高于 " + need + "，你不肯再按旧规矩来";
      case "dominion":
        var target = (a.effect && a.effect.type === "purge_tech") ? "技术环"
          : (p.mode === "mid" ? (p.pc.dept || "这个部门") : "全船");
        return "统御力只有 " + rnd(p.pc.dominion) + "（要 ≥" + need + "），你号令不动" + target;
      case "authority":
        return "你的权限只有 " + rnd(p.pc.authority) + "（要 ≥" + need + "），" +
          (p.pc.dept || "这个部门") + "不归你管";
      case "order":
        return "全船秩序 " + pct(num(stateOf(p).order, 0)) + "（要 ≥" + pct(need) + "），现在下令只会激起反弹";
      case "orderMax":
        return "全船秩序 " + pct(num(stateOf(p).order, 0)) + "（要 ≤" + pct(need) + "），现在太稳了，反而不好动手";
      case "garrison":
        return "警备还能用 " + pct(garrisonAvail(stateOf(p), cfg)) + "（要 ≥" + pct(need) + "），没人手执行";
      case "garrisonMax":
        return "警备还能用 " + pct(garrisonAvail(stateOf(p), cfg)) + "（要 ≤" + pct(need) + "），巡逻太密，跑不掉";
      case "lockdown":
        return "现在封着舱，门打不开";
      case "zone":
        return "你不在" + need + "，够不到控制台";
      case "dept":
        return "你只管" + p.pc.dept + "，" + need + "不归你调";
      case "intel":
        return "情报不够，你现在只知道" + intelText(p.intel);
      case "cooldown":
        left = Math.max(0, (p.actionCd[a.id] || 0) - stateOf(p).weeks);
        return "距离上次「" + a.label + "」还要 " + left + " 周";
      default:
        return "现在做不了这个动作";
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
    if (g.lockdown === "yes" && !at.lockdown) return { ok: false, code: "lockdown", reason: "现在没封锁，这个动作做不了" };
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
    if (!a) return { ok: false, msg: "没有这个动作" };
    var g = gate(state, cfg, id, payload);
    if (!g.ok) return { ok: false, msg: g.reason, code: g.code, action: id };

    var M0 = global.XuanShuSim.metrics(state, cfg);
    var msg = "";
    var critical = false;
    var at;

    if (a.society) {
      var r = global.XuanShuSociety && global.XuanShuSociety.act
        ? global.XuanShuSociety.act(state, cfg, a.society, { dept: payload.dept }) : { ok: false, msg: "社会层未加载" };
      if (!r.ok) return { ok: false, msg: r.msg, action: id };
      msg = r.msg;
      if (id === "replace_mid") p.pc.dominionBonus = num(p.pc.dominionBonus) - 8;
      if (id === "lockdown") p.lockdownUntil = Math.max(p.lockdownUntil, state.weeks + cfg.society.actions.lockdown.isoWeeks);
      if (id === "interrogate") {
        // 审讯的语义结果：除了压服，还要换回情报——把涉事部门标出来，情报抬一档
        var ib = effectiveIntel(state, cfg, p) === "low" ? "mid" : "high";
        p.intelBuff = { level: ib, until: state.weeks + cfg.society.actions.interrogate.isoWeeks };
        var md = state.society.mutiny.dept ||
          ((state.society.queues || []).filter(function (q) { return q.layer === "L2"; })[0] || {}).dept || "";
        msg += "；情报升到「" + intelText(ib) + "」" +
          (md ? "，涉事部门「" + md + "」被标出" : "，但没锁定具体部门");
      }
      markCd(p, id, a.cdWeeks);
    } else {
      at = attrs(state, cfg);
      var et = a.effect ? a.effect.type : "";

      if (et === "input") {
        // 按「旧值 → 新值」结算：没改动就不扣秩序、也不占冷却，
        // 避免把「点一下」当成一次真实调整（旧版拿 1.00 当基准，点一次白扣秩序）。
        var prevV = num(state.inputs[a.effect.key], 1);
        var v = payload.value;
        if (typeof v !== "number") v = prevV;
        v = clamp(v, a.effect.min, a.effect.max);
        var dv = Math.round((v - prevV) * 10000) / 10000;
        state.inputs[a.effect.key] = v;
        if (Math.abs(dv) > 1e-9) {
          state.order = clamp(num(state.order) + dv * 0.05, 0.05, 1);
          addQueue100(state, null, "O", dv * 10);
          msg = a.label + "：" + prevV.toFixed(2) + " → " + v.toFixed(2) +
            "，秩序 " + (dv >= 0 ? "+" : "") + (dv * 5).toFixed(1) + "%";
          markCd(p, id, a.cdWeeks);
        } else {
          msg = a.label + "：已经是 " + v.toFixed(2) + "，这次没有改动（不计冷却）";
        }
      } else if (et === "audience") {
        state.order = clamp(num(state.order) + 0.02, 0.05, 1);
        addQueue100(state, null, "O", 2);
        var base = effectiveIntel(state, cfg, p);
        var buff = base === "low" ? "mid" : "high";
        p.intelBuff = { level: buff, until: state.weeks + 8 };
        msg = "巡视完：秩序 +2%、服从 +2，情报升到「" + intelText(buff) + "」，管 8 周";
        markCd(p, id, a.cdWeeks);
      } else if (et === "purge_tech") {
        var techBefore = state.society.machine ? num(state.society.machine.tech) : 0;
        if (state.society.machine) state.society.machine.tech = clamp(techBefore - 0.03, 0, 1);
        var techAfter = state.society.machine ? num(state.society.machine.tech) : 0;
        var dT = state.society.depts && state.society.depts["技术"];
        var iBefore = dT ? num(dT.I) : 0;
        if (dT) dT.I = clamp(iBefore - 0.15, 0, 1);
        addQueue100(state, function (q) { return q.dept === "技术"; }, "W", 4);
        msg = "技术环清洗完：科技 " + techBefore.toFixed(2) + " → " + techAfter.toFixed(2) +
          "，技术部门失序 " + iBefore.toFixed(2) + " → " + (dT ? num(dT.I).toFixed(2) : "—") +
          "，技术部门不服 +4";
        markCd(p, id, a.cdWeeks);
      } else if (et === "petition") {
        var okP = randNext(state) < 0.5;
        if (okP) {
          var needFood = num(state.stocks.food) < 60;
          var needMetal = num(state.stocks.metal) < 80;
          if (needFood) { state.stocks.food = num(state.stocks.food) + 20; msg = "上面批了：粮食 +20 吨"; }
          else if (needMetal) { state.stocks.metal = num(state.stocks.metal) + 15; msg = "上面批了：金属 +15 吨"; }
          else { state.society.garrison.strength = num(state.society.garrison.strength) + 5; msg = "上面批了：警备多 5 个人"; }
        } else {
          state.order = clamp(num(state.order) - 0.01, 0.05, 1);
          msg = "上面驳回了：秩序 −1%";
        }
        markCd(p, id, a.cdWeeks);
      } else if (et === "inform_peer") {
        p.pc.authorityBonus = num(p.pc.authorityBonus) + 5;
        var peers = qlist(state).filter(function (q) { return q.layer === "L2" && q.id !== p.pc.queueId; });
        if (peers.length) peers[0].S = clamp(num(peers[0].S) + 0.05, 0, 1);
        addQueue100(state, function (q) { return q.dept === p.pc.dept; }, "W", 2);
        msg = "举报成功：权限 +5，被举报的人压力 +0.05，本部门不服 +2";
        markCd(p, id, a.cdWeeks);
      } else if (et === "embezzle") {
        var okE = riskCheck(state, cfg, a);
        state.order = clamp(num(state.order) - 0.02, 0.05, 1);
        if (okE) {
          if (num(state.stocks.food) < 60) { state.stocks.food = num(state.stocks.food) + 15; msg = "截下 15 吨粮：秩序 −2%"; }
          else { state.stocks.metal = num(state.stocks.metal) + 20; msg = "截下 20 吨金属：秩序 −2%"; }
        } else {
          critical = riskFail(state, cfg, id, p);
          msg = "被查出来了：权限 −8，同僚压力 +0.08";
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
        msg = "加班：服从 +2、不服 −2、健康 −4，产出略升";
        markCd(p, id, a.cdWeeks);
      } else if (et === "steal_food") {
        var okS = riskCheck(state, cfg, a);
        if (okS) {
          state.stocks.food = num(state.stocks.food) + 8;
          msg = "偷到了：粮食 +8 吨";
        } else {
          critical = riskFail(state, cfg, id, p);
          msg = "被抓了：健康 −6，关 4 周禁闭";
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
            msg = "卖粮换了 20 吨金属：粮 −" + Math.round(sell) + " 吨";
          } else {
            state.stocks.metal = Math.max(0, num(state.stocks.metal) - 10);
            state.stocks.food = num(state.stocks.food) + 35;
            msg = "用 10 吨金属换了 35 吨粮";
          }
        } else {
          critical = riskFail(state, cfg, id, p);
          msg = "黑市被端了：金属 −10 吨，关 4 周禁闭";
        }
        markCd(p, id, a.cdWeeks);
      } else if (et === "inform") {
        var okI = riskCheck(state, cfg, a);
        addQueue100(state, function (q) { return q.id === p.pc.queueId; }, "O", 4);
        addQueue100(state, function (q) { return q.id === p.pc.queueId; }, "W", 2);
        var peers2 = qlist(state).filter(function (q) { return q.layer === "L4" && q.id !== p.pc.queueId; });
        if (peers2.length) peers2[0].S = clamp(num(peers2[0].S) + 0.05, 0, 1);
        if (okI) msg = "告密成功：服从 +4、不服 +2，同僚压力 +0.05";
        else { critical = riskFail(state, cfg, id, p); msg = "告密被报复：健康 −8，关 4 周禁闭"; }
        markCd(p, id, a.cdWeeks);
      } else if (et === "sabotage") {
        var okD = riskCheck(state, cfg, a);
        if (okD) {
          state.wear = clamp(num(state.wear) + 0.03, 0, 1);
          var dS = state.society.depts && state.society.depts[p.pc.dept];
          if (dS) dS.I = clamp(num(dS.I) + 0.05, 0, 1);
          msg = "破坏成了：磨损 +3%，部门失序 +0.05";
        } else {
          critical = riskFail(state, cfg, id, p);
          msg = "破坏失败：健康 −15，关 8–12 周禁闭，部门失序 +0.08";
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
        msg = "照料眷属：眷属 +1，全船感染 +1，服从 −1";
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
    var D = global.XuanShuSim.diffMetrics(M0, global.XuanShuSim.metrics(state, cfg));
    pushEvent(state, cfg, "player_action", "行动",
      modeLabel(p.mode) + " · " + a.label,
      msg + (p.mode === "creator" ? "（调试）" : ""),
      D,
      p.mode === "creator" ? "" : "你亲自动了手");
    return { ok: true, msg: msg, action: id, critical: critical, deltas: global.XuanShuSim.cleanDeltas(D), player: brief(state, cfg) };
  }

  /* 身份块：阶级 / 职务 / 权柄位置 / 派系 / 贵族身份 / 休眠资格 */
  function identity(state, cfg) {
    var p = ensure(state, cfg);
    var q = findQueue(state, p.pc.queueId);
    var layer = p.mode === "creator" ? "creator" : (q ? q.layer
      : (p.mode === "ruler" ? "L1" : p.mode === "mid" ? "L2" : p.mode === "slave" ? "L4" : "L1"));
    var layerName = layer === "creator" ? "创造者"
      : (cfg.society && cfg.society.layerNames && cfg.society.layerNames[layer]) || layer;
    var noble = p.mode === "creator" || layer === "L1" || layer === "L2";
    var dept = p.pc.dept || (q && q.dept) || (p.mode === "creator" ? "全船" : "");
    return {
      layer: layer,
      layerName: layerName,
      noble: noble,
      sleepEligible: noble,
      title: layer === "creator" ? "创造者" : modeLabel(p.mode),
      dept: dept,
      zone: p.pc.zone,
      zoneName: zoneName(cfg, p.pc.zone),
      allegiance: p.pc.stage >= 1 ? "眷属" : (noble ? "贵族" : "平民"),
      faction: dept || "无派系"
    };
  }

  /* ---------------- 个体养护（v6.52）：药剂 / 基因修复 / 基因强化 / 娱乐 ---------------- */

  function careCfg(cfg) { return (cfg.player && cfg.player.care) || null; }

  function techPoints(state, k) {
    var tech = num(state.society && state.society.machine && state.society.machine.tech, 0);
    return Math.round(tech / num(k && k.techScale, 0.01));
  }

  // 寿命唯一算法：上限 = 120 − 损伤 × 0.8（修复 10 点即 +8 年，不再叠加）
  function lifespanOf(cfg, damage) {
    var k = careCfg(cfg);
    if (!k) return 120;
    return Math.round(num(k.lifespanBase, 120) - num(damage, 0) * num(k.damageK, 0.8));
  }

  function careAddBuff(c, key, v, weeks) {
    if (!v) return;
    if (!c.buffs) c.buffs = [];
    var w = Math.max(1, Math.round(num(weeks, 4)));
    c.buffs.push({ k: key, v: num(v, 0), weeks: w, left: w });
  }

  function careBuffSum(c, key) {
    var s = 0;
    ((c && c.buffs) || []).forEach(function (b) { if (b && b.k === key) s += num(b.v); });
    return s;
  }

  function careTick(state, cfg, p) {
    var k = careCfg(cfg);
    if (!k) return;
    var pc = p.pc;
    var c = pc.care;
    if (!c) return;
    // 基因损伤自然累积
    pc.geneDamage = clamp(num(pc.geneDamage, 0) + num(k.damageBaseWeekly, 0) +
      num(pc.infectionC, 0) * num(k.damageInfectK, 0), 0, num(k.damageCap, 60));
    // 药剂 / 娱乐的临时加成逐周递减
    if (c.buffs && c.buffs.length) {
      c.buffs.forEach(function (b) { b.left = num(b.left, 0) - 1; });
      c.buffs = c.buffs.filter(function (b) { return b.left > 0; });
    }
    if (c.active && state.weeks >= num(c.active.until, 0)) c.active = null;
    if (c.leisure && state.weeks >= num(c.leisure.until, 0)) {
      c.leisure = null;
      c.leisureWeek = -1;
    }
    // 成瘾：≥60 掉意志与健康；≥85 戒断
    if (num(pc.addiction, 0) >= num(k.addictWillOver, 60)) {
      pc.willBonus = clamp(num(pc.willBonus, 0) - num(k.addictWillWeekly, 0.1), -12, 50);
      pc.health -= num(k.addictHealthWeekly, 0.05);
    }
    if (num(pc.addiction, 0) >= num(k.addictBreak, 85) && !c.withdraw) {
      c.withdraw = true;
      c.mindPenalty = -10;
      pushEvent(state, cfg, "player_withdraw", "身份", "戒断发作",
        "成瘾压过了 " + k.addictBreak + "，理智 −10、意志持续下滑。", { "理智": -10 }, "再用药只会更深");
    } else if (num(pc.addiction, 0) < num(k.addictBreak, 85) - 10 && c.withdraw) {
      c.withdraw = false;
      c.mindPenalty = 0;
    }
    if (!c.active) pc.addiction = clamp(num(pc.addiction, 0) - 0.02, 0, 100);
    // 寿命：超过上限后每周掉健康
    var life = lifespanOf(cfg, pc.geneDamage);
    if (num(pc.age, 0) >= life) {
      pc.health -= 0.3;
      if (!c.overLife) {
        c.overLife = true;
        pushEvent(state, cfg, "player_aging", "身份", "寿命将尽",
          "基因损伤 " + Math.round(pc.geneDamage) + "，寿命上限 " + life + " 岁，你已经 " +
          Math.round(num(pc.age, 0)) + " 岁。", null, "去修基因，或者开始交代后事");
      }
    }
    // 娱乐：娱乐类事件的频率按所选活动放大 / 压低（基准 1.2%/周）
    if (c.leisure && state.weeks < num(c.leisure.until, 0)) {
      var lg = (k.leisure || {})[c.leisure.id];
      if (lg && randNext(state) < 0.012 * num(lg.freq, 1)) {
        var flavor = {
          cinema: "放映厅里坐满了人，有人跟着旧片子笑出声。",
          feast: "宴席摆到甲板上，酒和肉香压过了舱里的铁锈味。",
          retreat: "你独自待在静修室，外面的噪声隔了一层。"
        }[c.leisure.id] || "你安排了一场消遣。";
        pushEvent(state, cfg, "player_leisure", "日常", "娱乐：" + (lg.name || "消遣"),
          flavor, null, "情绪被拉回来了");
      }
    }
  }

  function careBrief(state, cfg) {
    var k = careCfg(cfg);
    var p = ensure(state, cfg);
    var pc = p.pc;
    var c = pc.care || {};
    if (!k) return null;
    var tp = techPoints(state, k);
    var dmg = Math.round(num(pc.geneDamage, 0) * 10) / 10;
    var life = lifespanOf(cfg, dmg);
    var age = Math.round(num(pc.age, 0));
    var repairs = num(c.repairs, 0);
    var drugs = Object.keys(k.drugs || {}).map(function (id) {
      var d = k.drugs[id];
      return {
        id: id, name: d.name, tech: d.tech, weeks: d.weeks,
        effectText: d.effectText, sideText: d.sideText, addict: d.addict,
        stock: num(c.stock && c.stock[id], 0), techOk: tp >= d.tech,
        left: tp < d.tech ? d.tech - tp : 0,
        active: !!(c.active && c.active.id === id && state.weeks < num(c.active.until, 0))
      };
    });
    var genes = Object.keys(k.genes || {}).map(function (id) {
      var g = k.genes[id];
      return {
        id: id, name: g.name, tech: g.tech, text: g.text,
        costText: [g.drug ? "药剂 " + g.drug : "", g.metal ? "金属 " + g.metal : "",
          g.food ? "粮 " + g.food : ""].filter(Boolean).join(" + ") || "无",
        researched: !!c.genes[id], techOk: tp >= g.tech,
        left: tp < g.tech ? g.tech - tp : 0
      };
    });
    var leisure = Object.keys(k.leisure || {}).map(function (id) {
      var l = k.leisure[id];
      return {
        id: id, name: l.name, weeks: l.weeks, food: l.food, text: l.text, freq: l.freq,
        active: !!(c.leisure && c.leisure.id === id && state.weeks < num(c.leisure.until, 0)),
        leftWeeks: c.leisure && c.leisure.id === id ? Math.max(0, num(c.leisure.until, 0) - state.weeks) : 0
      };
    });
    return {
      techPoints: tp,
      damage: dmg,
      lifespan: life,
      age: age,
      remaining: Math.max(0, life - age),
      repaired: repairs,
      repairCap: num(k.repairCap, 60),
      repairStep: num(k.repairStep, 10),
      repairTech: num(k.repairTech, 20),
      repairDrug: num(k.repairDrug, 30),
      repairMetal: num(k.repairMetal, 12),
      repairReady: tp >= k.repairTech && dmg >= k.repairStep && repairs + k.repairStep <= k.repairCap,
      damageK: num(k.damageK, 0.8),
      addiction: Math.round(num(pc.addiction, 0)),
      withdraw: !!c.withdraw,
      drugs: drugs,
      genes: genes,
      leisure: leisure,
      activeLeisure: c.leisure ? c.leisure.id : "",
      buffs: (c.buffs || []).map(function (b) { return { k: b.k, v: b.v, left: b.left }; })
    };
  }

  function playerCare(state, cfg, id, payload) {
    payload = payload || {};
    var k = careCfg(cfg);
    if (!k) return { ok: false, msg: "个体养护配置没加载" };
    var p = ensure(state, cfg);
    var pc = p.pc;
    if (!p.started) return { ok: false, msg: "尚未选择身份" };
    if (!pc.alive) return { ok: false, msg: "你已经死了" };
    var c = pc.care;
    var tp = techPoints(state, k);
    var key = payload.key || payload.drug || payload.gene || payload.leisure || "";

    if (id === "drug") {
      var d = k.drugs[key];
      if (!d) return { ok: false, msg: "没有这支药剂" };
      if (tp < d.tech) return { ok: false, msg: "科技 " + tp + " 点，还差 " + (d.tech - tp) + " 点才能用「" + d.name + "」" };
      if (num(c.stock[key], 0) < 1) return { ok: false, msg: "「" + d.name + "」没有库存了" };
      if (num(state.stocks && state.stocks.drug, 0) < 1) return { ok: false, msg: "药剂池见底，先补药剂" };
      c.stock[key] = num(c.stock[key], 0) - 1;
      state.stocks.drug = Math.max(0, num(state.stocks.drug, 0) - 1);
      pc.addiction = clamp(num(pc.addiction, 0) + num(d.addict, 0), 0, 100);
      pc.health = clamp(num(pc.health, 0) + num(d.hp, 0), 0, 100);
      careAddBuff(c, "mind", d.mind, d.weeks);
      careAddBuff(c, "spirit", d.spirit, d.weeks);
      c.active = { id: key, until: state.weeks + num(d.weeks, 4) };
      pushEvent(state, cfg, "player_drug", "身份", "用了「" + d.name + "」",
        d.effectText + "；代价：" + d.sideText + "；成瘾 " + (num(d.addict, 0) >= 0 ? "+" : "") +
        d.addict + "。", null, "管 " + d.weeks + " 周");
      return { ok: true, msg: "用了「" + d.name + "」：" + d.effectText + "（" + d.weeks + " 周）", care: careBrief(state, cfg) };
    }

    if (id === "repair") {
      var cap = num(k.repairCap, 60), step = num(k.repairStep, 10);
      if (tp < num(k.repairTech, 20)) return { ok: false, msg: "科技 " + tp + " 点，修复需要 " + k.repairTech + " 点" };
      if (num(pc.geneDamage, 0) < step) return { ok: false, msg: "基因损伤 " + Math.round(pc.geneDamage) + "，不到一次修复的 " + step + " 点" };
      if (num(c.repairs, 0) + step > cap) return { ok: false, msg: "累计修复已达上限 " + cap + " 点" };
      if (num(state.stocks.drug, 0) < num(k.repairDrug, 30)) return { ok: false, msg: "药剂不足（需 " + k.repairDrug + " 份）" };
      if (num(state.stocks.metal, 0) < num(k.repairMetal, 12)) return { ok: false, msg: "金属不足（需 " + k.repairMetal + " 吨）" };
      state.stocks.drug = num(state.stocks.drug, 0) - num(k.repairDrug, 30);
      state.stocks.metal = num(state.stocks.metal, 0) - num(k.repairMetal, 12);
      pc.geneDamage = Math.max(0, num(pc.geneDamage, 0) - step);
      c.repairs = num(c.repairs, 0) + step;
      if (num(pc.age, 0) < lifespanOf(cfg, pc.geneDamage)) c.overLife = false;
      pushEvent(state, cfg, "player_repair", "身份", "基因损伤修复",
        "损伤 −" + step + "，寿命上限 +" + Math.round(step * num(k.damageK, 0.8)) +
        " 年，现为 " + lifespanOf(cfg, pc.geneDamage) + " 岁。",
        { "药剂": -num(k.repairDrug, 30), "金属": -num(k.repairMetal, 12) }, "一条命按十年买");
      return { ok: true, msg: "修复完成：损伤 −" + step + "，寿命上限 " + lifespanOf(cfg, pc.geneDamage) + " 岁", care: careBrief(state, cfg) };
    }

    if (id === "gene") {
      var g = k.genes[key];
      if (!g) return { ok: false, msg: "没有这项基因强化" };
      if (c.genes[key]) return { ok: false, msg: "「" + g.name + "」已经研发过" };
      if (tp < g.tech) return { ok: false, msg: "科技 " + tp + " 点，还差 " + (g.tech - tp) + " 点才能研发「" + g.name + "」" };
      if (num(state.stocks.drug, 0) < num(g.drug, 0)) return { ok: false, msg: "药剂不足（需 " + g.drug + " 份）" };
      if (num(state.stocks.metal, 0) < num(g.metal, 0)) return { ok: false, msg: "金属不足（需 " + g.metal + " 吨）" };
      if (num(state.stocks.food, 0) < num(g.food, 0)) return { ok: false, msg: "粮食不足（需 " + g.food + " 吨）" };
      state.stocks.drug = Math.max(0, num(state.stocks.drug, 0) - num(g.drug, 0));
      state.stocks.metal = Math.max(0, num(state.stocks.metal, 0) - num(g.metal, 0));
      state.stocks.food = Math.max(0, num(state.stocks.food, 0) - num(g.food, 0));
      c.genes[key] = true;
      c.hpBonus = num(c.hpBonus, 0) + num(g.hpBonus, 0);
      c.mindBonus = num(c.mindBonus, 0) + num(g.mindBonus, 0);
      c.spiritBonus = num(c.spiritBonus, 0) + num(g.spiritBonus, 0);
      if (g.willBonus) pc.willBonus = clamp(num(pc.willBonus, 0) + g.willBonus, -20, 80);
      if (g.infectResist) c.infectResist = clamp(num(c.infectResist, 0) + g.infectResist, 0, 0.6);
      if (g.hpBonus) pc.health = clamp(num(pc.health, 0) + g.hpBonus, 0, 100);
      pushEvent(state, cfg, "player_gene", "身份", "基因强化：" + g.name,
        g.text + "。", null, "这一步改的是身体本身");
      return { ok: true, msg: "已研发「" + g.name + "」：" + g.text, care: careBrief(state, cfg) };
    }

    if (id === "leisure") {
      var l = k.leisure[key];
      if (!l) return { ok: false, msg: "没有这项娱乐安排" };
      if (num(state.stocks.food, 0) < num(l.food, 0)) return { ok: false, msg: "粮食不足（需 " + l.food + " 吨）" };
      state.stocks.food = Math.max(0, num(state.stocks.food, 0) - num(l.food, 0));
      if (l.order) state.order = clamp(num(state.order, 0.5) + num(l.order, 0), 0.05, 1);
      careAddBuff(c, "mind", l.mind, l.weeks);
      careAddBuff(c, "spirit", l.spirit, l.weeks);
      c.leisure = { id: key, until: state.weeks + num(l.weeks, 4), freq: num(l.freq, 1) };
      var chaos = num(l.risk, 0) > 0 && randNext(state) < num(l.risk, 0);
      if (chaos) state.order = clamp(num(state.order, 0.5) - 0.02, 0.05, 1);
      pushEvent(state, cfg, "player_leisure", "日常", "安排了「" + l.name + "」",
        l.text + (chaos ? "；现场闹出了事：秩序 −2%。" : "。"), null,
        "娱乐事件频率 ×" + num(l.freq, 1).toFixed(2));
      return { ok: true, msg: "已安排「" + l.name + "」" + (chaos ? "，现场闹事：秩序 −2%" : ""), care: careBrief(state, cfg) };
    }

    return { ok: false, msg: "未知养护操作：" + id };
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
      care: careBrief(state, cfg),
      identity: identity(state, cfg),
      personal: {
        influence: rnd(p.pc.dominion),
        compliance: rnd(p.pc.compliance),
        deterrence: rnd(p.pc.authority),
        ration: num(state.inputs && state.inputs.ration, 1),
        bonds: p.pc.pregnant ? "怀孕 " + rnd(p.pc.pregnantWeeks) + " 周" : "无",
        thralls: num(state.society && state.society.infection && state.society.infection.thralls, 0),
        status: state.weeks < p.pc.confinedUntil ? "在押"
          : state.weeks < p.pc.interrogatedUntil ? "受审"
            : state.weeks < p.pc.hiddenUntil ? "潜藏" : "在岗"
      },
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
    careBrief: careBrief,
    playerCare: playerCare,
    lifespanOf: lifespanOf,
    modeLabel: modeLabel,
    zoneOfDept: zoneOfDept
  };

  global.XuanShuPlayer = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : global);
