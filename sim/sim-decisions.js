/* =========================================================================
   玄枢号 · 待决策机制（v1.2.0）
   -------------------------------------------------------------------------
   与「常驻危机」（sim-crisis.js）分工：
   - 危机：参数越线 → 挂卡 → 选完立即解除 / 定时暂缓
   - 待决策：事件越线 → 生成待决项 → 选完立即落账，条目转入「观察中」
     带着解决条件继续挂着；每周检查，条件连续满足满 N 周才自动关闭并写「已解决」
   状态机：open（待决策）→ watching（观察中）→ resolved（已解决）
   观察中若条件中断，留在 watching 并把连续计数归零，不回退到 open
   引擎只提供全集与可用性（按身份 + 当前状态），界面自己从可用项里随机抽 3 个。
   效果结算复用 sim-crisis.js 的 applyOps；本文件只补 4 个待决策专用算子。
   ========================================================================= */
(function (global) {
  "use strict";

  var VERSION = "1.2.0";
  var STATUS_TEXT = { open: "待决策", watching: "观察中", resolved: "已解决" };
  var PP = 0.01; // 百分点换算：配置里 order −3 / prodTmp −10 表示 −3% / −10%

  function isNum(v) { return typeof v === "number" && isFinite(v); }
  function num(v, d) { return isNum(v) ? v : (d || 0); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function ccfg(cfg) { return (cfg && cfg.decisions) || null; }
  function defsOf(cfg) { var c = ccfg(cfg); return (c && c.defs) || []; }
  function weeksPerYear(cfg) { return (cfg && cfg.time && cfg.time.weeksPerYear) || 52; }

  function findDef(cfg, id) {
    var list = defsOf(cfg);
    for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
    return null;
  }

  function blank() {
    return {
      version: VERSION,
      seq: 0,
      items: [],
      resolved: 0,
      lastEval: -1,
      watch: {},    // 触发器连续周计数（按条件键分槽）
      alerts: [],   // 跨档提醒流水
      alertSeq: 0
    };
  }

  function create(cfg) { validateOnce(cfg); return blank(); }

  function ensure(state, cfg) {
    validateOnce(cfg);
    if (!state.decisions || typeof state.decisions !== "object") state.decisions = blank();
    var D = state.decisions;
    if (!Array.isArray(D.items)) D.items = [];
    if (D.cooldown) delete D.cooldown;   // v1.0 的同类冷却，1.1 起废弃
    if (!D.watch || typeof D.watch !== "object") D.watch = {};
    if (!Array.isArray(D.alerts)) D.alerts = [];
    if (!isNum(D.alertSeq)) D.alertSeq = 0;
    D.version = VERSION;
    if (!isNum(D.seq)) D.seq = 0;
    if (!isNum(D.resolved)) D.resolved = 0;
    if (!isNum(D.lastEval)) D.lastEval = -1;
    // 丢掉配置里已经不存在的模板，避免旧档卡死
    D.items = D.items.filter(function (it) { return !!findDef(cfg, it.defId); });
    D.items.forEach(function (it) {
      // v1.1 的「未解决」= selected，1.2 起统一叫 watching（观察中）
      if (it.status === "selected") it.status = "watching";
      if (!STATUS_TEXT[it.status]) it.status = it.chosen ? "watching" : "open";
      if (!isNum(it.severityLevel)) it.severityLevel = 0;
      if (typeof it.severityText !== "string") it.severityText = "";
      if (it.alert === undefined) it.alert = null;
      if (!isNum(it.alertSeq)) it.alertSeq = 0;
    });
    return D;
  }

  /* ---------------- 身份 ---------------- */

  function queueClass(id) {
    if (!id) return null;
    if (id === "L1") return "lord";
    if (id === "L3_branch" || id.indexOf("L2_") === 0) return "noble";
    if (id.indexOf("L3_") === 0) return "commoner";
    if (id === "L4_clone") return "clone";
    if (id.indexOf("L4_") === 0) return "slave";
    return null;
  }

  function classOf(state, cfg) {
    var p = (state && state.player) || {};
    if (p.mode === "creator") return "creator";
    if (p.mode === "ruler") return "lord";
    var qc = queueClass(p.pc && p.pc.queueId);
    if (qc) return qc;
    if (p.mode === "mid") return "noble";
    if (p.mode === "slave") return "slave";
    return "commoner";
  }

  function classLabel(state, cfg, cls) {
    var c = ccfg(cfg) || {};
    var labels = c.labels || {};
    cls = cls || classOf(state, cfg);
    return labels[cls] || cls;
  }

  /* ---------------- 读数 ---------------- */

  function awakeTotal(state) {
    var n = 0;
    Object.keys(state.groups || {}).forEach(function (k) { n += num(state.groups[k].awake); });
    return n;
  }
  function addictTotal(state) {
    var a = state.addict || {};
    return num(a.light) + num(a.mid) + num(a.heavy);
  }
  function withdrawTotal(state) {
    var w = (state.addict && state.addict.withdraw) || {};
    return num(w.light) + num(w.mid) + num(w.heavy);
  }
  function medPool(state) { return (state.pools && state.pools.med) || {}; }
  function stockOf(state) { return state.stocks || {}; }
  function mutinyLevel(state) {
    return num(state.society && state.society.mutiny && state.society.mutiny.level);
  }

  function metric(state, cfg, key) {
    var med = medPool(state), st = stockOf(state);
    switch (key) {
      case "orderPct": return num(state.order) * 100;
      case "mutiny": return mutinyLevel(state);
      case "pain": case "nutri": case "rad": case "mut": case "dna":
        return num(med[key]);
      case "drug": case "food": case "metal": case "water":
        return num(st[key]);
      case "coins": return num(state.coins);
      case "addictTotal": return addictTotal(state);
      case "addictSharePct": {
        var aw = awakeTotal(state);
        return aw > 0 ? addictTotal(state) / aw * 100 : 0;
      }
      case "withdraw": return withdrawTotal(state);
      case "withdrawSharePct": {
        var aw2 = awakeTotal(state);
        return aw2 > 0 ? withdrawTotal(state) / aw2 * 100 : 0;
      }
      case "medCoveragePct": return num(state.last && state.last.medCoverage) * 100;
      default: return 0;
    }
  }

  /* ---------------- 可用性 ---------------- */

  function needReason(state, cfg, need) {
    if (!need) return "";
    var st = stockOf(state), med = medPool(state);
    var orderPct = num(state.order) * 100;
    if (isNum(need.orderMin) && orderPct < need.orderMin) {
      return "秩序不足（需要 ≥ " + need.orderMin + "%，现有 " + Math.round(orderPct) + "%）";
    }
    if (isNum(need.orderMax) && orderPct > need.orderMax) {
      return "秩序过高（需要 ≤ " + need.orderMax + "%，现有 " + Math.round(orderPct) + "%）";
    }
    if (isNum(need.foodMin) && num(st.food) < need.foodMin) {
      return "粮食不足（需要 ≥ " + need.foodMin + " 吨，现有 " + Math.floor(num(st.food)) + " 吨）";
    }
    if (isNum(need.metalMin) && num(st.metal) < need.metalMin) {
      return "金属不足（需要 ≥ " + need.metalMin + " 吨，现有 " + Math.floor(num(st.metal)) + " 吨）";
    }
    if (isNum(need.drugMin) && num(st.drug) < need.drugMin) {
      return "休眠药剂不足（需要 ≥ " + need.drugMin + " 份，现有 " + Math.floor(num(st.drug)) + " 份）";
    }
    if (isNum(need.painMin) && num(med.pain) < need.painMin) {
      return "镇痛药剂不足（需要 ≥ " + need.painMin + " 份，现有 " + Math.floor(num(med.pain)) + " 份）";
    }
    if (isNum(need.coinsMin) && num(state.coins) < need.coinsMin) {
      return "舰内星币不足（需要 ≥ " + need.coinsMin + "，现有 " + Math.floor(num(state.coins)) + "）";
    }
    if (isNum(need.mutinyMax) && mutinyLevel(state) > need.mutinyMax) {
      return "哗变等级过高（需要 ≤ " + need.mutinyMax + " 级，现有 " + mutinyLevel(state) + " 级）";
    }
    if (isNum(need.addictMin) && addictTotal(state) < need.addictMin) {
      return "成瘾人数不足（需要 ≥ " + need.addictMin + " 人，现有 " + addictTotal(state) + " 人）";
    }
    return "";
  }

  function availability(state, cfg, opt) {
    var cls = classOf(state, cfg);
    if (cls !== "creator" && Array.isArray(opt.who) && opt.who.length &&
        opt.who.indexOf(cls) < 0) {
      var labels = (ccfg(cfg) || {}).labels || {};
      var who = opt.who.map(function (x) { return labels[x] || x; }).join("/");
      return { available: false, reason: "不可选：这是「" + who + "」才能做的决定" };
    }
    var r = needReason(state, cfg, opt.need);
    if (r) return { available: false, reason: "不可选：" + r };
    return { available: true, reason: "" };
  }

  function optionView(state, cfg, o) {
    var av = availability(state, cfg, o);
    return {
      id: o.id,
      label: o.label,
      desc: o.desc || "",
      risk: o.risk || "",
      effectsText: (o.effectsText || []).slice(),
      who: (o.who || []).slice(),
      need: o.need || null,
      ops: o.ops || [],
      resolve: o.resolve || null,
      available: av.available,
      reason: av.reason
    };
  }

  /* ---------------- 结算 ---------------- */

  function applyOps(state, cfg, ops) {
    var base = [];
    (ops || []).forEach(function (op) {
      if (!op || !op.t) return;
      var v = isNum(op.v) ? op.v : 0;
      if (op.t === "addict") {
        var ad = state.addict;
        if (ad && (op.k === "light" || op.k === "mid" || op.k === "heavy")) {
          ad[op.k] = Math.max(0, Math.round(num(ad[op.k]) + v));
        }
      } else if (op.t === "med") {
        var med = medPool(state);
        if (isNum(med[op.k])) med[op.k] = Math.max(0, med[op.k] + v);
      } else if (op.t === "coins") {
        state.coins = Math.max(0, num(state.coins) + v);
      } else if (op.t === "mutiny") {
        var m = state.society && state.society.mutiny;
        if (m) m.level = clamp(Math.round(num(m.level) + v), 0, 5);
      } else if (op.t === "order") {
        base.push({ t: "order", v: v * PP });
      } else if (op.t === "prodTmp") {
        base.push({ t: "prodTmp", v: v * PP, weeks: op.weeks });
      } else {
        base.push(op);
      }
    });
    if (!base.length) return;
    if (global.XuanShuCrisis && typeof global.XuanShuCrisis.applyOps === "function") {
      global.XuanShuCrisis.applyOps(state, cfg, base, []);
      return;
    }
    // 兜底（仅模块级冒烟可能出现）：只处理不依赖危机的三类
    base.forEach(function (op) {
      if (op.t === "order") state.order = clamp(num(state.order) + op.v, 0, 1);
      else if (op.t === "stock" && state.stocks) {
        state.stocks[op.k] = Math.max(0, num(state.stocks[op.k]) + op.v);
      } else if (op.t === "prodTmp") {
        if (!state.crisis) state.crisis = { active: [], cooldown: {}, buffs: [], history: [], resolved: 0, lastEval: -1 };
        state.crisis.buffs.push({ prodMul: 1 + op.v, until: num(state.weeks) + Math.max(1, num(op.weeks, num((ccfg(cfg) || {}).defaultBuffWeeks, 4))) });
      }
    });
  }

  /* ---------------- 解决条件 ---------------- */

  function condRaw(state, cfg, cond) {
    if (!cond) return { ok: false, parts: [], text: "未设置解决条件" };
    var parts = [];
    if (Array.isArray(cond.all)) {
      cond.all.forEach(function (c) { parts.push(condRaw(state, cfg, c)); });
      return {
        ok: parts.length > 0 && parts.every(function (p) { return p.ok; }),
        parts: parts,
        text: cond.text || ""
      };
    }
    if (Array.isArray(cond.any)) {
      cond.any.forEach(function (c) { parts.push(condRaw(state, cfg, c)); });
      return {
        ok: parts.some(function (p) { return p.ok; }),
        parts: parts,
        text: cond.text || ""
      };
    }
    var v = metric(state, cfg, cond.key);
    var ok = true;
    if (isNum(cond.above)) ok = ok && v >= cond.above;
    if (isNum(cond.below)) ok = ok && v < cond.below;
    return {
      ok: ok,
      key: cond.key,
      current: Math.round(v * 10) / 10,
      above: isNum(cond.above) ? cond.above : null,
      below: isNum(cond.below) ? cond.below : null,
      parts: [],
      text: cond.text || ""
    };
  }

  function evalCond(state, cfg, cond, prevStreak) {
    var raw = condRaw(state, cfg, cond);
    var need = Math.max(1, (cond && cond.weeks) || num((ccfg(cfg) || {}).defaultResolveWeeks, 18));
    var streak = raw.ok ? num(prevStreak) + 1 : 0;
    return {
      ok: raw.ok && streak >= need,
      met: raw.ok,
      streak: streak,
      need: need,
      current: isNum(raw.current) ? raw.current : null,
      target: raw.above !== null && raw.above !== undefined ? ("≥ " + raw.above) :
        (raw.below !== null && raw.below !== undefined ? ("< " + raw.below) : ""),
      parts: raw.parts,
      text: raw.text || ""
    };
  }

  /* ---------------- 触发 ---------------- */

  // trigOne 是 if/else-if 链：一个节点对象只能写一个条件键，
  // 多条件必须用 { all: [...] } / { anyOf: [...] } 组合，否则后面的键会被静默忽略。
  var LEAF_KEYS = [
    "painDeficit", "orderPctBelow", "mutinyLevelAtLeast", "withdrawAbove",
    "withdrawSharePctAtLeast", "addictSharePctAbove", "painBelow", "drugBelow",
    "medCoveragePctBelow", "foodBelow"
  ];

  function leafKeys(node) {
    var out = [];
    LEAF_KEYS.forEach(function (k) { if (node[k] !== undefined) out.push(k); });
    return out;
  }

  function checkNode(node, where) {
    if (!node || typeof node !== "object") return;
    var kids = Array.isArray(node.all) ? node.all :
      (Array.isArray(node.anyOf) ? node.anyOf : (Array.isArray(node.any) ? node.any : null));
    if (kids) {
      kids.forEach(function (n, i) { checkNode(n, where + "[" + i + "]"); });
      return;
    }
    var ks = leafKeys(node);
    if (ks.length > 1) {
      throw new Error("待决策触发条件写法错误：" + where + " 同一节点含多个条件键 [" +
        ks.join(", ") + "]，请拆成 { all: [{...}, {...}] }");
    }
  }

  /** 校验所有模板的 trigger 与 tiers[].when；配置写错时在首次使用时直接抛错。 */
  function validate(cfg) {
    (defsOf(cfg) || []).forEach(function (d) {
      checkNode(d.trigger, "decisions." + d.id + ".trigger");
      (d.tiers || []).forEach(function (t) {
        checkNode(t.when, "decisions." + d.id + ".tiers[" + (t.id || "?") + "].when");
      });
    });
  }

  var checkedCfgs = typeof WeakSet !== "undefined" ? new WeakSet() : null;
  function validateOnce(cfg) {
    if (!cfg) return;
    if (checkedCfgs && checkedCfgs.has(cfg)) return;
    validate(cfg);
    if (checkedCfgs) checkedCfgs.add(cfg);
  }

  function trigOne(state, cfg, tr, watch) {
    if (!tr) return "";
    if (leafKeys(tr).length > 1) {
      throw new Error("待决策触发条件写法错误：同一节点含多个条件键 [" +
        leafKeys(tr).join(", ") + "]，请拆成 { all: [{...}, {...}] }");
    }
    var st = stockOf(state), med = medPool(state);
    // 连续周条件：计数写在 watch 里，跨周保留；不满足即归零
    if (tr.painDeficit) {
      var pd = tr.painDeficit;
      var pk = "painDeficit@" + num(pd.below);
      var slot = watch ? num(watch[pk]) : 0;
      slot = num(med.pain) < num(pd.below) ? slot + 1 : 0;
      if (watch) watch[pk] = slot;
      if (slot >= Math.max(1, num(pd.weeks, num((ccfg(cfg) || {}).defaultTriggerWeeks, 1)))) {
        return "镇痛池连续 " + slot + " 周 < " + num(pd.below) + " 份";
      }
      return "";
    }
    if (isNum(tr.orderPctBelow) && num(state.order) * 100 < tr.orderPctBelow) {
      return "秩序 " + Math.round(num(state.order) * 100) + "% < " + tr.orderPctBelow + "%";
    }
    if (isNum(tr.mutinyLevelAtLeast) && mutinyLevel(state) >= tr.mutinyLevelAtLeast) {
      return "哗变等级 " + mutinyLevel(state) + " ≥ " + tr.mutinyLevelAtLeast + " 级";
    }
    if (isNum(tr.withdrawAbove) && withdrawTotal(state) >= tr.withdrawAbove) {
      return "全船戒断人数 " + withdrawTotal(state) + " ≥ " + tr.withdrawAbove;
    }
    if (isNum(tr.withdrawSharePctAtLeast) && metric(state, cfg, "withdrawSharePct") >= tr.withdrawSharePctAtLeast) {
      return "戒断占比 " + Math.round(metric(state, cfg, "withdrawSharePct")) + "% ≥ " + tr.withdrawSharePctAtLeast + "%";
    }
    if (isNum(tr.addictSharePctAbove) && metric(state, cfg, "addictSharePct") >= tr.addictSharePctAbove) {
      return "成瘾占比 " + Math.round(metric(state, cfg, "addictSharePct")) + "% ≥ " + tr.addictSharePctAbove + "%";
    }
    if (isNum(tr.painBelow) && num(med.pain) < tr.painBelow) {
      return "镇痛药剂池 " + Math.floor(num(med.pain)) + " 份 < " + tr.painBelow + " 份";
    }
    if (isNum(tr.drugBelow) && num(st.drug) < tr.drugBelow) {
      return "休眠药剂 " + Math.floor(num(st.drug)) + " 份 < " + tr.drugBelow + " 份";
    }
    if (isNum(tr.medCoveragePctBelow) && num(state.last && state.last.medCoverage) * 100 < tr.medCoveragePctBelow) {
      return "医疗覆盖 " + Math.round(num(state.last && state.last.medCoverage) * 100) + "% < " + tr.medCoveragePctBelow + "%";
    }
    if (isNum(tr.foodBelow) && num(st.food) < tr.foodBelow) {
      return "粮食 " + Math.floor(num(st.food)) + " 吨 < " + tr.foodBelow + " 吨";
    }
    return "";
  }

  function triggerHit(state, cfg, d, watch) {
    return nodeHit(state, cfg, d.trigger, watch);
  }

  /** 组合条件求值：all 全中、anyOf/any 任一；不顺短路，保证连续周计数每项都走到。 */
  function nodeHit(state, cfg, node, watch) {
    if (!node) return "";
    if (Array.isArray(node.all)) {
      var ok = true, whys = [];
      node.all.forEach(function (n) {
        var w = nodeHit(state, cfg, n, watch);
        if (!w) ok = false; else whys.push(w);
      });
      return ok && whys.length ? whys.join(" · ") : "";
    }
    if (Array.isArray(node.anyOf) || Array.isArray(node.any)) {
      var list = node.anyOf || node.any, got = "";
      list.forEach(function (n) {
        var w = nodeHit(state, cfg, n, watch);
        if (w && !got) got = w;
      });
      return got;
    }
    return trigOne(state, cfg, node, watch);
  }

  /** 当前档位：命中档里取最深的一档；都不命中回落到模板静态 severity。 */
  function tierAt(state, cfg, d) {
    var best = null;
    (d.tiers || []).forEach(function (t) {
      if (!t || !t.when) return;
      if (!nodeHit(state, cfg, t.when, null)) return;
      if (!best || num(t.level, 0) > num(best.level, 0)) best = t;
    });
    if (!best) return { id: "", level: 0, label: d.severity || "", text: "" };
    return {
      id: best.id || "",
      level: num(best.level, 0),
      label: best.label || d.severity || "",
      text: best.text || ""
    };
  }

  /* ---------------- 日志 ---------------- */

  function log(state, cfg, level, title, text, basis) {
    try {
      var wp = weeksPerYear(cfg);
      var wq = (cfg && cfg.time && cfg.time.weeksPerQuarter) || 13;
      var y = Math.floor(state.weeks / wp);
      var w = (state.weeks % wp) + 1;
      state.events.push({
        t: Math.round((((state.loop || 1) - 1) * ((cfg && cfg.time && cfg.time.loopYears) || 1000) +
          state.weeks / wp) * 100) / 100,
        loop: state.loop || 1,
        year: y,
        week: w,
        quarter: Math.floor((state.weeks % wp) / wq) + 1,
        timeLabel: "第 " + (y + 1) + " 年第 " + w + " 周",
        type: "decision",
        level: level,
        title: title,
        text: text,
        basis: basis || ""
      });
      if (cfg.events && cfg.events.keyCap && state.events.length > cfg.events.keyCap) {
        state.events.shift();
      }
    } catch (e) { /* 日志失败不影响结算 */ }
  }

  /* ---------------- 开一条待决策 ---------------- */

  function hasLive(D, type) {
    for (var i = 0; i < D.items.length; i++) {
      if (D.items[i].type === type && D.items[i].status !== "resolved") return true;
    }
    return false;
  }

  function open(state, cfg, defId, triggerText, tier) {
    var d = findDef(cfg, defId);
    if (!d) return { ok: false, msg: "没有这条决策模板" };
    if (d.enabled === false) return { ok: false, msg: "这条决策已关闭" };
    var D = ensure(state, cfg);
    if (hasLive(D, d.type)) return { ok: false, msg: "同类型决策还挂着" };
    var t = tier || { id: "", level: 0, label: d.severity || "", text: "" };
    var item = {
      id: "dec_" + (++D.seq),
      type: d.type,
      defId: d.id,
      title: d.title,
      brief: d.brief || "",
      severity: t.label || d.severity || "",
      severityLevel: num(t.level),
      severityText: t.text || "",
      triggerWeek: state.weeks,
      triggerYear: Math.floor(state.weeks / weeksPerYear(cfg)),
      triggerText: triggerText || d.triggerText || "",
      options: (d.options || []).map(function (o) { return optionView(state, cfg, o); }),
      chosen: false,
      choice: null,
      status: "open",
      resolveCond: null,
      resolveProg: null,
      resolvedWeek: null,
      resolvedText: "",
      alert: null,
      alertSeq: 0
    };
    D.items.unshift(item);
    log(state, cfg, "待决策", "待决策 · " + d.title,
      item.brief, "触发：" + item.triggerText + " · 身份=" + classLabel(state, cfg) +
        (t.level ? " · 档位 " + t.level : ""));
    prune(D, cfg);
    return { ok: true, item: item };
  }

  /** 跨档提醒流水：给右栏/弹窗取「最近一次升级」，不再开新条目。 */
  function pushAlert(D, cfg, a) {
    D.alertSeq += 1;
    a.seq = D.alertSeq;
    D.alerts.push(a);
    var cap = Math.max(0, num((ccfg(cfg) || {}).keepAlerts, 12));
    while (D.alerts.length > cap) D.alerts.shift();
    return a;
  }

  /* ---------------- 选择 ---------------- */

  function findItem(D, id) {
    for (var i = 0; i < D.items.length; i++) if (D.items[i].id === id) return D.items[i];
    return null;
  }

  function choose(state, cfg, id, optionId) {
    var D = ensure(state, cfg);
    var item = findItem(D, id);
    if (!item) return { ok: false, msg: "没有这条待决策" };
    if (item.status !== "open") return { ok: false, msg: "这条已经处理过了" };
    var d = findDef(cfg, item.defId);
    if (!d) return { ok: false, msg: "决策模板已移除" };
    var opt = null;
    (d.options || []).forEach(function (o) { if (o.id === optionId) opt = o; });
    if (!opt) return { ok: false, msg: "没有这个选项" };
    var av = availability(state, cfg, opt);
    if (!av.available) return { ok: false, msg: av.reason };

    applyOps(state, cfg, opt.ops || []);
    item.chosen = true;
    item.status = "watching";
    item.choice = {
      optionId: opt.id,
      label: opt.label,
      week: state.weeks,
      year: Math.floor(state.weeks / weeksPerYear(cfg)),
      lines: (opt.effectsText || []).slice()
    };
    item.resolveCond = opt.resolve || d.resolveDefault || null;
    item.resolveProg = evalCond(state, cfg, item.resolveCond, 0);
    item.options = (d.options || []).map(function (o) { return optionView(state, cfg, o); });

    log(state, cfg, "决策", "决策已下 · " + d.title,
      opt.label + "：" + (opt.effectsText || []).join("；"),
      "决策 id=" + item.id + " · 选项=" + opt.id +
        " · 解决条件=" + (item.resolveCond ? (item.resolveCond.text || item.resolveCond.key || "组合条件") : "无"));

    return {
      ok: true,
      msg: (opt.effectsText || []).join("；"),
      lines: (opt.effectsText || []).slice(),
      decision: view(state, cfg, item),
      decisions: brief(state, cfg)
    };
  }

  /* ---------------- 每周：触发 + 条件检查 ---------------- */

  function weekly(state, cfg) {
    var c = ccfg(cfg);
    if (!c || c.enabled === false) return;
    var D = ensure(state, cfg);

    var every = Math.max(1, c.evalEveryWeeks || 1);
    if (D.lastEval >= 0 && state.weeks - D.lastEval < every) return;
    D.lastEval = state.weeks;

    var maxOpen = Math.max(1, c.maxOpen || 3);
    (c.defs || []).forEach(function (d) {
      if (d.enabled === false) return;
      // 触发与档位每类都要算：连续周计数不能因为已有在办项而停摆
      var why = triggerHit(state, cfg, d, D.watch);
      var tier = tierAt(state, cfg, d);
      var live = liveItem(D, d.type);
      if (live) {
        // 未解决期间不重复开条；只有档位继续恶化才提醒一次（取历史最深档，不回落）
        if (tier.level > num(live.severityLevel)) {
          var from = num(live.severityLevel);
          live.severityLevel = tier.level;
          live.severity = tier.label || live.severity;
          live.severityText = tier.text || "";
          var al = pushAlert(D, cfg, {
            type: d.type, defId: d.id, itemId: live.id,
            week: state.weeks, year: Math.floor(state.weeks / weeksPerYear(cfg)),
            fromLevel: from, toLevel: tier.level,
            label: tier.label, text: tier.text
          });
          live.alert = {
            seq: al.seq, week: state.weeks, level: tier.level,
            label: tier.label, text: tier.text
          };
          live.alertSeq = al.seq;
          log(state, cfg, "待决策", "待决策升级 · " + d.title,
            (tier.label || "") + "：" + (tier.text || why || ""),
            "决策 id=" + live.id + " · 档位 " + from + "→" + tier.level);
        }
        return;
      }
      if (!why) return;
      var openCount = D.items.filter(function (i) { return i.status === "open"; }).length;
      if (openCount >= maxOpen) return;
      open(state, cfg, d.id, why, tier);
    });

    D.items.forEach(function (it) {
      var d = findDef(cfg, it.defId);
      if (!d) return;
      if (it.status === "open") {
        it.options = (d.options || []).map(function (o) { return optionView(state, cfg, o); });
        return;
      }
      if (it.status !== "watching") return;
      var prev = it.resolveProg ? it.resolveProg.streak : 0;
      var r = evalCond(state, cfg, it.resolveCond, prev);
      it.resolveProg = r;
      // 条件中断只把连续计数归零，仍留在 watching；决策已落账，不回退成待拍板
      if (!r.ok) return;
      it.status = "resolved";
      it.resolvedWeek = state.weeks;
      it.resolvedText = r.text || ("解决条件达成，持续 " + r.need + " 周");
      D.resolved += 1;
      log(state, cfg, "已解决", "已解决 · " + it.title,
        (it.choice ? it.choice.label + "：" : "") + it.resolvedText,
        "决策 id=" + it.id + " · 持续 " + r.streak + " 周");
    });

    prune(D, cfg);
  }

  function liveItem(D, type) {
    for (var i = 0; i < D.items.length; i++) {
      if (D.items[i].type === type && D.items[i].status !== "resolved") return D.items[i];
    }
    return null;
  }

  function prune(D, cfg) {
    var c = ccfg(cfg) || {};
    var keep = Math.max(0, isNum(c.keepResolved) ? c.keepResolved : 20);
    var seen = 0;
    D.items = D.items.filter(function (it) {
      if (it.status !== "resolved") return true;
      seen += 1;
      return seen <= keep;
    });
    var cap = Math.max(10, c.maxItems || 60);
    while (D.items.length > cap) {
      var drop = -1;
      for (var i = D.items.length - 1; i >= 0; i--) {
        if (D.items[i].status === "resolved") { drop = i; break; }
      }
      if (drop < 0) break;
      D.items.splice(drop, 1);
    }
  }

  /* ---------------- 给界面看 ---------------- */

  function view(state, cfg, it) {
    var d = findDef(cfg, it.defId);
    return {
      id: it.id,
      type: it.type,
      defId: it.defId,
      title: it.title,
      brief: it.brief,
      severity: it.severity,
      severityLevel: num(it.severityLevel),
      severityText: it.severityText || "",
      alert: it.alert || null,
      alertSeq: num(it.alertSeq),
      triggerWeek: it.triggerWeek,
      triggerYear: it.triggerYear,
      triggerText: it.triggerText,
      options: d ? (d.options || []).map(function (o) { return optionView(state, cfg, o); }) : it.options,
      chosen: it.chosen,
      choice: it.choice,
      status: it.status,
      statusText: STATUS_TEXT[it.status] || it.status,
      resolveCond: it.resolveCond,
      resolveProg: it.resolveProg,
      resolvedWeek: it.resolvedWeek,
      resolvedText: it.resolvedText
    };
  }

  /** 各事件当前档位：右栏常显，不依赖条目是否已在队列里。 */
  function severityMap(state, cfg) {
    var D = ensure(state, cfg);
    var out = {};
    (defsOf(cfg) || []).forEach(function (d) {
      if (d.enabled === false) return;
      var t = tierAt(state, cfg, d);
      var scratch = {};
      Object.keys(D.watch || {}).forEach(function (k) { scratch[k] = D.watch[k]; });
      var why = triggerHit(state, cfg, d, scratch);
      out[d.type] = {
        defId: d.id,
        id: t.id,
        level: t.level,
        label: t.label,
        text: t.text,
        total: (d.tiers || []).length,
        hit: !!why,
        triggerText: why || ""
      };
    });
    return out;
  }

  function brief(state, cfg) {
    var D = ensure(state, cfg);
    var cls = classOf(state, cfg);
    return {
      version: VERSION,
      weeks: state.weeks,
      identity: cls,
      identityLabel: classLabel(state, cfg, cls),
      resolved: D.resolved,
      open: D.items.filter(function (i) { return i.status === "open"; }).length,
      watching: D.items.filter(function (i) { return i.status === "watching"; }).length,
      pending: D.items.filter(function (i) { return i.status === "watching"; }).length,
      lastEval: D.lastEval,
      severity: severityMap(state, cfg),
      alerts: (D.alerts || []).slice(),
      items: D.items.map(function (it) { return view(state, cfg, it); })
    };
  }

  var api = {
    version: VERSION,
    create: create,
    ensure: ensure,
    weekly: weekly,
    open: open,
    choose: choose,
    tick: weekly,
    brief: brief,
    validate: validate,
    findDef: findDef,
    classOf: classOf,
    classLabel: classLabel,
    availability: availability
  };

  global.XuanShuDecisions = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : (typeof globalThis !== "undefined" ? globalThis : this));
