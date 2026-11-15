/* =========================================================================
   玄枢号 · 个体层（sim-people.js）
   -------------------------------------------------------------------------
   引擎始终保存每个人的真实位置：分区（zone）/ 房间（room）/ 岗位（post）。
   玩家看到的只是按情报档位裁剪后的视图，不修改真值。

   两层接口：
     truth(state, cfg)              → 真值：每个人 + 精确位置
     playerView(state, cfg, opts)   → 玩家视图：可见者带误差半径/时间延迟，
                                      未植入者进入盲区，只给人数，不撒点
   字段归属写在 playerView().fieldMap 与接口文档里，前端不需要猜。

   性能：不逐周遍历 4,000 人。人员名册只在人数变化时增删（sync），
   位置由 (seq, 周) 的确定性哈希即时算出，因此不占额外状态、也不消耗随机数。
   ========================================================================= */
(function (global) {
  "use strict";

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function num(v, d) { return typeof v === "number" && isFinite(v) ? v : (d || 0); }

  // 32 位整数哈希（FNV-1a 变体），用于把「个人 + 用途」映射到 [0,1)
  function h32(a, b) {
    var h = (0x811c9dc5 ^ (a | 0)) | 0;
    h = Math.imul(h ^ ((b | 0) + 0x9e3779b9), 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    return h >>> 0;
  }
  function h01(a, b) { return h32(a, b) / 4294967296; }

  /* -------------------------------------------------------------------------
     行动状态（v6.55）
     宏观状态挂在人身上；队列只做聚合。系数口径：
       output 该状态对岗位产能的乘数；ration 口粮消耗乘数（1 = 正常）；
       hp/mind 每周变化；inf 每周感染变化乘数；order 每周秩序贡献（按人头摊薄）。
     pri 越大越优先。医疗隔离最高；休眠最低，但物理休眠仍由 sync 强制。
     ------------------------------------------------------------------------- */
  var ACTIONS = {
    "医疗隔离": { pri: 90, output: 0.00, ration: 0.90, hp: 0.70, inf: 0.50, order: 0.000, mind: -0.20, call: false, trade: false, sac: false },
    "任务":     { pri: 70, output: 1.10, ration: 1.15, hp: -0.20, inf: 1.10, order: 0.003, mind: -0.15, call: true,  trade: false, sac: false },
    "监禁":     { pri: 60, output: 0.00, ration: 0.60, hp: -0.25, inf: 1.10, order: -0.010, mind: -0.55, call: false, trade: true,  sac: true },
    "教团仪式": { pri: 50, output: 0.35, ration: 1.00, hp: -0.10, inf: 1.05, order: 0.005, mind: 0.40, call: true,  trade: true,  sac: false },
    "育幼":     { pri: 45, output: 0.50, ration: 1.05, hp: -0.05, inf: 1.00, order: 0.004, mind: 0.15, call: true,  trade: true,  sac: false },
    "训练":     { pri: 40, output: 0.55, ration: 1.10, hp: -0.15, inf: 1.05, order: 0.005, mind: 0.05, call: true,  trade: true,  sac: false },
    "值勤":     { pri: 30, output: 1.00, ration: 1.00, hp: -0.05, inf: 1.00, order: 0.000, mind: -0.10, call: true,  trade: true,  sac: false },
    "休整":     { pri: 20, output: 0.00, ration: 0.95, hp: 0.35, inf: 0.95, order: 0.000, mind: 0.30, call: true,  trade: true,  sac: false },
    "休眠":     { pri: 10, output: 0.00, ration: 0.02, hp: -0.02, inf: 0.00, order: 0.000, mind: -0.05, call: false, trade: true,  sac: false },
    "失踪/叛逃": { pri: 0, output: 0.00, ration: 0.00, hp: -0.30, inf: 1.00, order: -0.020, mind: -0.30, call: false, trade: false, sac: false }
  };
  var ACTION_LIST = Object.keys(ACTIONS);

  function defaultAction(cfg, gid) {
    return gid === (cfg.population && cfg.population.undecidedId) ? "休整" : "值勤";
  }
  function actionOf(p, cfg) {
    if (p.action && ACTIONS[p.action]) return p.action;
    if (p.dormant) return "休眠";
    return defaultAction(cfg || {}, p.g);
  }

  var zoneCache = null;
  var zoneCacheCfg = null;

  function zoneIndex(cfg) {
    if (zoneCacheCfg === cfg.people) return zoneCache;
    var byDept = {};
    (cfg.people.zones || []).forEach(function (z) {
      (z.depts || []).forEach(function (d) {
        (byDept[d] || (byDept[d] = [])).push(z);
      });
    });
    var byId = {};
    (cfg.people.zones || []).forEach(function (z) { byId[z.id] = z; });
    zoneCache = { byDept: byDept, byId: byId };
    zoneCacheCfg = cfg.people;
    return zoneCache;
  }

  function pickLayer(cfg, gid, seq) {
    var mix = (cfg.people.layerMix && cfg.people.layerMix[gid]) || { L4: 1 };
    var keys = Object.keys(mix);
    if (keys.length === 1) return keys[0];
    var r = h01(seq, 17);
    var acc = 0;
    for (var i = 0; i < keys.length; i++) {
      acc += num(mix[keys[i]]);
      if (r < acc - 1e-9) return keys[i];
    }
    return keys[keys.length - 1];
  }

  function implantBaseOf(cfg, layer) {
    var b = (cfg.visibility && cfg.visibility.implantBase) || {};
    return num(b[layer], num(b.L4n, num(b.L4clone, 0.4)));
  }

  function charmOf(cfg, seq) {
    var c = (cfg.people && cfg.people.charm) || {};
    var lo = num(c.min, 22), hi = num(c.max, 88);
    if (hi < lo) { var tmp = lo; lo = hi; hi = tmp; }
    return Math.round(lo + h01(seq, 41) * (hi - lo));
  }

  function mutationOf(cfg, gid, seq) {
    var M = (cfg.people && cfg.people.mutation) || {};
    var base = num((M.byGroup || {})[gid], num(M.base, 34));
    var spread = num(M.spread, 16);
    return clamp(Math.round(base + h01(seq, 43) * spread), 0, 100);
  }

  function makePerson(ppl, cfg, gid) {
    var seq = ppl.seq++;
    var layer = pickLayer(cfg, gid, seq);
    return {
      seq: seq,
      id: "P" + (10000 + seq),
      g: gid,
      layer: layer,
      dept: (cfg.people.groupDept && cfg.people.groupDept[gid]) || "勤务",
      // 魅力：开局一次定值，休眠/唤醒都不改；派系好感与买卖交涉会用到
      charm: charmOf(cfg, seq),
      // 基因变异度：易感性主因（越高越易感染），耐受度另算
      mutation: mutationOf(cfg, gid, seq),
      // 植入是「真值」属性：装没装芯片在建造/入伍时就定了，不随周变化
      implanted: h01(seq, 23) < implantBaseOf(cfg, layer),
      dormant: false,
      action: defaultAction(cfg, gid),
      actionSince: 0,
      // 眷属阶位：0 无 / 1 低语者 / 2 变形者 / 3 眷属贵族
      cultStage: 0,
      cultSince: 0,
      cultC: 0,
      mania: Math.round(num(cfg.people.mania.min, 18) +
        h01(seq, 29) * (num(cfg.people.mania.max, 62) - num(cfg.people.mania.min, 18)))
    };
  }

  function create(cfg) {
    var ppl = { seq: 0, groups: {}, cache: null };
    (cfg.population.groups || []).forEach(function (g) {
      var arr = (ppl.groups[g.id] = []);
      var n = Math.max(0, Math.round(num(g.awake) + num(g.dormant)));
      for (var i = 0; i < n; i++) arr.push(makePerson(ppl, cfg, g.id));
      var dorm = Math.max(0, Math.min(n, Math.round(num(g.dormant))));
      for (var k = 0; k < n; k++) {
        arr[k].dormant = k >= n - dorm;
        if (arr[k].dormant) arr[k].action = "休眠";
      }
    });
    return ppl;
  }

  /** 每周同步名册规模：人数变了只在尾部增删，休眠只翻标志。 */
  function sync(state, cfg) {
    if (!cfg.people || cfg.people.enabled === false) return;
    if (!state.people || !state.people.groups) {
      state.people = create(cfg);
      // 老存档（v2.0）没有 people 层：先建名册，再按当前人口修正规模
      if (!state.groups) return;
    }
    var ppl = state.people;
    // v6.58 贵族生命周期：每周推进一次，休眠/清醒切换与生物年龄死亡都在这里
    var wk = Math.floor(num(state.weeks, 0));
    if (ppl.lifeWeek !== wk) {
      lifeTick(state, cfg);
      ppl.lifeWeek = wk;
    }
    (cfg.population.groups || []).forEach(function (g) {
      var arr = ppl.groups[g.id] || (ppl.groups[g.id] = []);
      var st = state.groups[g.id] || { awake: 0, dormant: 0 };
      var target = Math.max(0, Math.round(num(st.awake) + num(st.dormant)));
      var dormTarget = Math.max(0, Math.min(target, Math.round(num(st.dormant))));
      while (arr.length < target) arr.push(makePerson(ppl, cfg, g.id));
      while (arr.length > target) arr.pop();
      var cut = target - dormTarget;
      var isLife = isLifeGroup(cfg, g.id);
      for (var i = 0; i < arr.length; i++) {
        if (typeof arr[i].charm !== "number") arr[i].charm = charmOf(cfg, arr[i].seq);
        if (typeof arr[i].mutation !== "number") arr[i].mutation = mutationOf(cfg, arr[i].g, arr[i].seq);
        if (typeof arr[i].cultStage !== "number") { arr[i].cultStage = 0; arr[i].cultSince = 0; arr[i].cultC = 0; }
        if (typeof arr[i].mania !== "number") {
          arr[i].mania = Math.round(num(cfg.people.mania.min, 18) +
            h01(arr[i].seq, 29) * (num(cfg.people.mania.max, 62) - num(cfg.people.mania.min, 18)));
        }
        if (isLife) {
          // 生命周期组：休眠与否由 phase 决定，sync 不再按 dormTarget 强行分配
          if (!arr[i].phase) lifeInit(arr[i], cfg, i >= cut);
          continue;
        }
        var want = i >= cut;
        if (arr[i].dormant !== want) arr[i].dormant = want;
        if (want) {
          // 物理休眠优先于其余非强制状态；失踪/叛逃不再改动
          if (arr[i].action !== "失踪/叛逃") arr[i].action = "休眠";
        } else if (arr[i].action === "休眠" || !ACTIONS[arr[i].action]) {
          arr[i].action = defaultAction(cfg, g.id);
        }
      }
    });
    ppl.cache = null;
  }

  /**
   * 手动/事件切换行动状态。按优先级裁决；force=true 时才允许跨优先级强制。
   * 硬互斥：医疗隔离不能被低优先级顶掉；监禁不能与休眠互换而不唤醒。
   */
  function setAction(state, cfg, pid, next, opts) {
    opts = opts || {};
    if (!ACTIONS[next]) return { ok: false, msg: "未知状态：" + next };
    if (!state.people) sync(state, cfg);
    var hit = null;
    Object.keys((state.people && state.people.groups) || {}).forEach(function (gid) {
      if (hit) return;
      var arr = state.people.groups[gid];
      for (var i = 0; i < arr.length; i++) {
        if (arr[i].id === pid) { hit = arr[i]; break; }
      }
    });
    if (!hit) return { ok: false, msg: "找不到该编号" };
    var from = actionOf(hit, cfg);
    if (from === next) return { ok: true, msg: "状态未变", from: from, to: next };
    var cur = ACTIONS[from], tgt = ACTIONS[next];
    if (!opts.force && tgt.pri < cur.pri) {
      return { ok: false, msg: from + " 优先级高于 " + next + "（需强制）", from: from, to: next };
    }
    if (!opts.force && from === "医疗隔离" && next !== "医疗隔离") {
      return { ok: false, msg: "医疗隔离未解除，不能切换到 " + next, from: from, to: next };
    }
    if (next === "休眠" && !opts.force && hit.dormant === false &&
        (from === "监禁" || from === "任务" || from === "训练" || from === "教团仪式" || from === "育幼")) {
      return { ok: false, msg: from + " 与休眠互斥，需先结束该状态", from: from, to: next };
    }
    hit.action = next;
    hit.actionSince = state.weeks | 0;
    if (next === "休眠") hit.dormant = true;
    else if (from === "休眠") hit.dormant = false;
    if (state.people) state.people.cache = null;
    return { ok: true, msg: from + " → " + next, from: from, to: next };
  }

  /** 按人头聚合行动状态：人数、系数合计、加权产出/口粮/健康/感染/秩序/精神。 */
  function actionMix(state, cfg) {
    if (!cfg.people || cfg.people.enabled === false) return null;
    var wk0 = state.weeks | 0;
    if (state.people && state.people.cache && state.people.cache.actWeek === wk0 && state.people.cache.act) {
      return state.people.cache.act;
    }
    // 每周把名册与队列的清醒/休眠数对齐，行动状态跟着物理休眠走
    sync(state, cfg);
    var ppl = state.people;
    if (!ppl) return null;
    var wk = state.weeks | 0;
    var mix = {};
    var t = {
      n: 0, awakeN: 0, dormantN: 0, workingN: 0,
      outputSum: 0, outputDen: 0, rationSum: 0,
      hpSum: 0, infSum: 0, infDen: 0, orderSum: 0, mindSum: 0
    };
    var undecided = cfg.population && cfg.population.undecidedId;
    Object.keys(ppl.groups).forEach(function (gid) {
      ppl.groups[gid].forEach(function (p) {
        var name = actionOf(p, cfg);
        var A = ACTIONS[name];
        var m = mix[name] || (mix[name] = { n: 0 });
        m.n++;
        t.n++;
        if (p.dormant) {
          t.dormantN++;
        } else {
          t.awakeN++;
          if (gid !== undecided) {
            t.workingN++;
            t.outputSum += A.output;
            t.outputDen++;
          }
          t.infSum += A.inf;
          t.infDen++;
        }
        t.rationSum += A.ration;
        t.hpSum += A.hp;
        t.orderSum += A.order;
        t.mindSum += A.mind;
      });
    });
    var out = {
      week: wk,
      mix: {},
      totals: {
        n: t.n,
        awakeN: t.awakeN,
        dormantN: t.dormantN,
        workingN: t.workingN,
        outputAvg: t.outputDen ? Math.round(t.outputSum / t.outputDen * 1000) / 1000 : 1,
        rationSum: Math.round(t.rationSum * 100) / 100,
        hpAvg: t.n ? Math.round(t.hpSum / t.n * 1000) / 1000 : 0,
        infMul: t.infDen ? Math.round(t.infSum / t.infDen * 1000) / 1000 : 1,
        orderAvg: t.n ? Math.round(t.orderSum / t.n * 10000) / 10000 : 0,
        mindAvg: t.n ? Math.round(t.mindSum / t.n * 1000) / 1000 : 0
      }
    };
    Object.keys(mix).forEach(function (k) {
      var A = ACTIONS[k];
      out.mix[k] = {
        n: mix[k].n,
        output: A.output, ration: A.ration, hp: A.hp,
        inf: A.inf, order: A.order, mind: A.mind,
        call: A.call, trade: A.trade, sac: A.sac
      };
    });
    ppl.cache = ppl.cache || {};
    ppl.cache.act = out;
    ppl.cache.actWeek = wk;
    return out;
  }

  /** 真值位置：分区稳定、房间与岗位按 rotateWeeks 轮换。 */
  function posOf(p, cfg, week) {
    var P = cfg.people;
    var rot = Math.floor(week / Math.max(1, num(P.rotateWeeks, 4)));
    var zi = zoneIndex(cfg);
    if (p.dormant) {
      var hold = zi.byId[P.dormantZone] || { id: P.dormantZone, name: "休眠舱区", rooms: 8 };
      return {
        zone: hold.id, zoneName: hold.name,
        room: "R" + (1 + Math.floor(h01(p.seq, 901 + rot) * num(hold.rooms, 8))),
        post: "休眠"
      };
    }
    var list = zi.byDept[p.dept] || zi.byDept["勤务"] || [];
    if (!list.length) list = [{ id: "Z_hab", name: "居住环", rooms: 24 }];
    var z = list[Math.floor(h01(p.seq, 31) * list.length)];
    var posts = P.posts || ["值班"];
    return {
      zone: z.id,
      zoneName: z.name,
      room: "R" + (1 + Math.floor(h01(p.seq, 101 + rot * 7) * num(z.rooms, 12))),
      post: posts[Math.floor(h01(p.seq, 211 + rot * 13) * posts.length)]
    };
  }

  function emptyZoneStats(cfg) {
    var out = {};
    (cfg.people.zones || []).forEach(function (z) {
      out[z.id] = { id: z.id, name: z.name, total: 0, known: 0, approx: 0, blind: 0, coverage: 0 };
    });
    return out;
  }

  /** 真值：所有人 + 精确位置。 */
  function truth(state, cfg, opts) {
    opts = opts || {};
    if (!state.people) sync(state, cfg);
    if (!state.people) return { view: "truth", total: 0, persons: [], zones: [] };
    var week = state.weeks | 0;
    var persons = [];
    var zoneMap = emptyZoneStats(cfg);
    Object.keys(state.people.groups).forEach(function (gid) {
      state.people.groups[gid].forEach(function (p) {
        var pos = posOf(p, cfg, week);
        var z = zoneMap[pos.zone] || (zoneMap[pos.zone] = {
          id: pos.zone, name: pos.zoneName, total: 0, known: 0, approx: 0, blind: 0, coverage: 0
        });
        z.total++;
        if (opts.detail === false) return;
        var ps = pStats(p, state, cfg);
        persons.push({
          pid: p.id, group: gid, layer: p.layer, dept: p.dept,
          zone: pos.zone, zoneName: pos.zoneName, room: pos.room, post: pos.post,
          dormant: !!p.dormant, implanted: !!p.implanted,
          action: actionOf(p, cfg),
          charm: p.charm,
          mutation: p.mutation,
          existYears: p.existYears, bioYears: p.bioYears, awakeYears: p.awakeYears, phase: p.phase,
          hp: ps.hp, mind: ps.mind, will: ps.will
        });
      });
    });
    var zones = Object.keys(zoneMap).map(function (k) {
      var z = zoneMap[k];
      z.coverage = 1;
      return z;
    }).filter(function (z) { return z.total > 0; });
    return {
      view: "truth", week: week, total: persons.length ? persons.length : zones.reduce(function (a, z) { return a + z.total; }, 0),
      persons: persons, zones: zones, note: "真值：位置精确到房间与岗位，不做任何裁剪"
    };
  }

  /** 当前情报环境：科技、警备、服从、自由意志。 */
  function intelEnv(state, cfg) {
    var soc = state.society;
    var tech = soc && soc.machine ? clamp(num(soc.machine.tech), 0, 1) : 0.35;
    var gar = 0.5;
    if (soc && soc.garrison) {
      var man = clamp(num(soc.garrison.strength) / Math.max(1, num(cfg.society.garrison.initStrength, 60)), 0, 1.2);
      var dur = 0.5 + 0.5 * clamp(num(soc.garrison.durability) / 100, 0, 1);
      gar = clamp(man * dur, 0, 1);
    }
    var compliance = clamp(num(soc && soc.meanO) / 100, 0, 1);
    var will = clamp(num(soc && soc.meanW) / 100, 0, 1);
    return { tech: tech, garrison: gar, compliance: compliance, will: will };
  }

  /**
   * 玩家视图：
   *  - 可见比例由科技、警备、植入覆盖率决定，植入覆盖率又受服从度与自由意志制约；
   *  - 未植入者默认是盲区（high 档位下可由巡逻/报告间接看到，误差更大）；
   *  - 可见者给误差半径与时间延迟，不给「随机撒点」的假位置。
   */
  function playerView(state, cfg, opts) {
    opts = opts || {};
    var V = cfg.visibility || {};
    var lvlId = opts.intel || "mid";
    var lvl = (V.intelLevels && V.intelLevels[lvlId]) || (V.intelLevels && V.intelLevels.mid) || {
      label: "中", roomDetail: false, errorMul: 1, delayMul: 1
    };
    if (!state.people) sync(state, cfg);

    var env = intelEnv(state, cfg);
    var effBase = clamp(
      num(V.baseEff, 0.45) +
      num(V.techWeight, 0.30) * env.tech +
      num(V.garrisonWeight, 0.15) * env.garrison +
      num(V.complianceWeight, 0.20) * (env.compliance - 0.5) -
      num(V.willPenalty, 0.35) * env.will,
      0.05, 1
    );
    var patrolBase = clamp(
      num(V.patrolShare, 0.12) * (0.6 + 0.8 * env.garrison) +
      0.10 * (env.compliance - 0.5),
      0, 0.35
    );
    var blindTh = num(V.blindThreshold, 0.25);
    var week = state.weeks | 0;

    var persons = [];
    var zoneMap = emptyZoneStats(cfg);
    var totals = { known: 0, approx: 0, blind: 0, total: 0, implanted: 0 };

    Object.keys(state.people.groups).forEach(function (gid) {
      state.people.groups[gid].forEach(function (p) {
        var pos = posOf(p, cfg, week);
        var z = zoneMap[pos.zone] || (zoneMap[pos.zone] = {
          id: pos.zone, name: pos.zoneName, total: 0, known: 0, approx: 0, blind: 0, coverage: 0
        });
        z.total++;
        totals.total++;
        if (p.implanted) totals.implanted++;

        var pVis = p.implanted
          ? clamp(effBase + (implantBaseOf(cfg, p.layer) - 0.5) * 0.8, 0, 0.98)
          : (lvl.roomDetail ? patrolBase : 0);

        if (pVis < blindTh || h01(p.seq, 777) >= pVis) {
          z.blind++;
          totals.blind++;
          return;
        }

        var source = p.implanted ? "implant" : "patrol";
        var uncert = clamp(1 - pVis, 0, 1);
        var errM = Math.round(num(V.errorBaseM, 30) + num(V.errorSpreadM, 140) * uncert * num(lvl.errorMul, 1));
        var delay = Math.round(num(V.delayBaseWeeks, 0) + num(V.delaySpreadWeeks, 6) * uncert * num(lvl.delayMul, 1));
        var precise = !!(lvl.roomDetail && p.implanted);

        if (source === "implant") { z.known++; totals.known++; }
        else { z.approx++; totals.approx++; }

        var ps = pStats(p, state, cfg);
        persons.push({
          pid: p.id,
          label: "编号 " + p.id.slice(1),
          group: gid,
          layer: p.layer,
          dept: p.dept,
          zone: pos.zone,
          zoneName: pos.zoneName,
          room: precise ? pos.room : null,
          post: precise ? pos.post : null,
          dormant: !!p.dormant,
          action: actionOf(p, cfg),
          charm: p.charm,
          mutation: p.mutation,
          existYears: p.existYears, bioYears: p.bioYears, awakeYears: p.awakeYears, phase: p.phase,
          hp: ps.hp,
          mind: ps.mind,
          will: ps.will,
          source: source,
          confidence: Math.round(pVis * 100),
          errorRadiusM: precise ? Math.max(10, Math.round(errM * 0.3)) : errM,
          delayWeeks: delay,
          lastSeenWeek: Math.max(0, week - delay)
        });
      });
    });

    var zones = Object.keys(zoneMap).map(function (k) {
      var z = zoneMap[k];
      z.coverage = z.total > 0 ? Math.round((z.known + z.approx) / z.total * 1000) / 1000 : 0;
      return z;
    }).filter(function (z) { return z.total > 0; });

    return {
      view: "player",
      week: week,
      intel: lvlId,
      intelLabel: lvl.label || lvlId,
      coverage: {
        implantedShare: totals.total ? Math.round(totals.implanted / totals.total * 1000) / 1000 : 0,
        effective: Math.round((totals.known + totals.approx) / Math.max(1, totals.total) * 1000) / 1000,
        base: Math.round(effBase * 1000) / 1000,
        patrol: Math.round(patrolBase * 1000) / 1000,
        tech: Math.round(env.tech * 1000) / 1000,
        garrison: Math.round(env.garrison * 1000) / 1000,
        compliance: Math.round(env.compliance * 1000) / 1000,
        will: Math.round(env.will * 1000) / 1000
      },
      totals: totals,
      zones: zones,
      persons: persons,
      blindNote: "盲区只上报人数与分区，不生成任何虚假位置点",
      fieldMap: {
        "persons[].zone": "真值（分区正确，裁剪不伪造）",
        "persons[].room": "玩家视图：仅 high 档位对植入者精确；否则 null，用 errorRadiusM 表达不确定范围",
        "persons[].post": "玩家视图：同上",
        "persons[].confidence / errorRadiusM / delayWeeks": "玩家视图：由情报覆盖率推导",
        "persons[].lastSeenWeek": "玩家视图：真值 − delayWeeks",
        "zones[].blind": "玩家视图：未植入且未被巡逻覆盖的人数，只有总量",
        "totals / coverage": "玩家视图汇总；真值人口合计见 snapshot()"
      }
    };
  }

  /** 个体健康 / 理智 / 意志：由群体状态 + 个体稳定噪声推导，不落盘，按需重算。 */
  function pStats(p, state, cfg) {
    var soc = state.society || {};
    var inf = soc.infection || {};
    var s = clamp(num(inf.share), 0, 1);
    var med = clamp(num(state.last && state.last.medCoverage, 0.5), 0, 1);
    var order = clamp(num(state.order, 0.5), 0, 1);
    var meanW = clamp(num(soc.meanW, 60), 0, 100);
    var corr = clamp(num(inf.meanC) / 100, 0, 1);
    var infected = h01(p.seq, 41) < s;
    var ration = clamp(num(state.last && state.last.rationActual, 1), 0, 1);
    var act = ACTIONS[actionOf(p, cfg)] || ACTIONS["值勤"];
    var hp, mind, will;
    if (p.dormant) {
      // 休眠：低代谢，健康随感染与医疗走；意识压低，古神感染（meanC）直接啃理智
      hp = 48 + 16 * (1 - s) + 10 * med + 8 * ration - 8 * corr + (h01(p.seq, 43) - 0.5) * 8;
      mind = 34 - 14 * corr - 8 * s + (h01(p.seq, 47) - 0.5) * 10;
      will = 28 + (h01(p.seq, 53) - 0.5) * 10;
    } else {
      hp = 38 + 16 * (1 - s) + 14 * med + 12 * ration - (infected ? 16 : 0) + (h01(p.seq, 43) - 0.5) * 8;
      mind = 30 + 0.40 * meanW + 12 * order - (infected ? 12 : 0) - 10 * s + (h01(p.seq, 47) - 0.5) * 12;
      will = meanW + (h01(p.seq, 53) - 0.5) * 18;
    }
    return {
      hp: Math.round(clamp(hp + act.hp * 6, 5, 100) * 10) / 10,
      mind: Math.round(clamp(mind + act.mind * 6, 0, 100) * 10) / 10,
      will: Math.round(clamp(will, 0, 100) * 10) / 10,
      infected: infected
    };
  }

  /** 加权权重：层级越高权重越大；休眠者按 0.15 计（低代谢，但不计 0）。 */
  function weightOf(p) {
    var LW = { L1: 1.30, L2: 1.20, L3: 1.10, L4n: 1.00, L4clone: 0.90 };
    var lw = num(LW[p.layer], 1);
    return (p.dormant ? 0.15 : 1) * lw;
  }

  function aggRows(rows, key) {
    if (!rows.length) return null;
    var sw = 0, sv = 0, vals = [];
    rows.forEach(function (r) {
      sw += r.w;
      sv += r.w * r[key];
      vals.push(r[key]);
    });
    vals.sort(function (a, b) { return a - b; });
    function pick(q) { return vals[Math.min(vals.length - 1, Math.max(0, Math.round((vals.length - 1) * q)))]; }
    var r1 = function (v) { return Math.round(v * 10) / 10; };
    return {
      mean: r1(sv / Math.max(0.0001, sw)),
      p25: r1(pick(0.25)), p50: r1(pick(0.5)), p75: r1(pick(0.75))
    };
  }

  /**
   * 群体指标：清醒 / 休眠两套独立聚合，互不混算。
   * 加权平均按「层级权重 × 醒/休眠系数」；分位数按个体值未加权，仅作分布参考。
   */
  function wellbeing(state, cfg) {
    if (!cfg.people || cfg.people.enabled === false) return null;
    if (!state.people) sync(state, cfg);
    if (!state.people) return null;
    var wk = state.weeks | 0;
    if (state.people.cache && state.people.cache.wbWeek === wk && state.people.cache.wb) {
      return state.people.cache.wb;
    }
    var awake = [], dorm = [];
    Object.keys(state.people.groups).forEach(function (gid) {
      state.people.groups[gid].forEach(function (p) {
        var st = pStats(p, state, cfg);
        var row = { w: weightOf(p), hp: st.hp, mind: st.mind, will: st.will };
        (p.dormant ? dorm : awake).push(row);
      });
    });
    var pack = function (rows) {
      return {
        n: rows.length,
        hp: aggRows(rows, "hp"),
        mind: aggRows(rows, "mind"),
        will: aggRows(rows, "will")
      };
    };
    var out = {
      week: wk,
      awake: pack(awake),
      dormant: pack(dorm),
      weights: {
        awake: "层级 L1 1.30 / L2 1.20 / L3 1.10 / L4 1.00 / 克隆 0.90",
        dormant: "同上 × 0.15（低代谢，不计 0）",
        mean: "加权平均；p25/p50/p75 为个体值未加权分位"
      }
    };
    state.people.cache = state.people.cache || { week: -1, brief: null };
    state.people.cache.wb = out;
    state.people.cache.wbWeek = wk;
    return out;
  }


  /** 快照里的真值聚合（不含 4,000 条明细，避免每步序列化）。 */
  function brief(state, cfg) {
    if (!cfg.people || cfg.people.enabled === false) return null;
    if (!state.people) sync(state, cfg);
    var ppl = state.people;
    if (!ppl) return null;
    if (ppl.cache && ppl.cache.week === state.weeks) return ppl.cache.brief;
    var week = state.weeks | 0;
    var map = emptyZoneStats(cfg);
    var total = 0, implanted = 0;
    Object.keys(ppl.groups).forEach(function (gid) {
      ppl.groups[gid].forEach(function (p) {
        var pos = posOf(p, cfg, week);
        var z = map[pos.zone] || (map[pos.zone] = {
          id: pos.zone, name: pos.zoneName, total: 0, known: 0, approx: 0, blind: 0, coverage: 0
        });
        z.total++;
        total++;
        if (p.implanted) implanted++;
      });
    });
    var zones = Object.keys(map).map(function (k) { return map[k]; })
      .filter(function (z) { return z.total > 0; });
    var act = actionMix(state, cfg);
    var b = {
      view: "truth",
      total: total,
      implantedShare: total ? Math.round(implanted / total * 1000) / 1000 : 0,
      zones: zones,
      wellbeing: wellbeing(state, cfg),
      stateMix: act ? act.mix : null,
      stateEffects: act ? act.totals : null,
      note: "真值聚合；个人明细用 snapshot({view:'truth'})，玩家视图用 snapshot({view:'player',intel})"
    };
    ppl.cache = { week: week, brief: b, wb: b.wellbeing, wbWeek: week, act: act, actWeek: week };
    return b;
  }

  // ---------------- v6.58 贵族生命周期 ----------------
  var WEEKS_PER_YEAR = 52.14;
  var GENE_REPAIR_BONUS = 8;   // 「细胞修复」路线的生物寿命加成

  function isLifeGroup(cfg, gid) {
    return !!(cfg.nobleLife && (cfg.nobleLife.groups || []).indexOf(gid) >= 0);
  }

  function lifeTierOf(cfg, tech) {
    var tiers = (cfg.nobleLife && cfg.nobleLife.tiers) || [];
    var idx = 0;
    for (var i = 0; i < tiers.length; i++) {
      if (tech + 1e-9 >= num(tiers[i].tech, 0)) idx = i;
    }
    return { idx: idx, tier: tiers[idx] || { mult: 0.3, tech: 0, name: "密封低温" } };
  }

  function lifeReliefOf(state, cfg) {
    var g = cfg.nobleLife && cfg.nobleLife.gene;
    if (!g) return 0;
    var got = (state.nobleLife && state.nobleLife.genes) || {};
    var sum = 0;
    Object.keys(g.paths || {}).forEach(function (k) { if (got[k]) sum += num(g.paths[k].sleepRelief, 0); });
    return sum;
  }

  function lifeMultOf(state, cfg, tech) {
    var g = cfg.nobleLife && cfg.nobleLife.gene;
    var floor = num(g && g.floor, 0.004);
    return Math.max(floor, lifeTierOf(cfg, tech).tier.mult - lifeReliefOf(state, cfg));
  }

  function lifeInit(p, cfg, asleep) {
    var L = cfg.nobleLife || {};
    var awakeY = num((L.awakeYears || {})[p.layer], 20);
    var sleepY = num((L.sleepYears || {})[p.layer], 20);
    var bio0 = 26 + h01(p.seq, 51) * 54;         // 开局生物年龄 26–80
    p.existYears = bio0;
    p.bioYears = bio0;
    p.awakeYears = bio0 * 0.5;                    // 清醒资历不会等于生物年龄
    p.phase = asleep ? "asleep" : "awake";
    p.phaseYears = h01(p.seq, 53) * (asleep ? sleepY : awakeY);
    p.dormant = !!asleep;
    if (asleep) p.action = "休眠";
  }

  function lifeTick(state, cfg) {
    var L = cfg.nobleLife;
    if (!L) return;
    var dt = 1 / WEEKS_PER_YEAR;
    var tech = clamp(num(state.society && state.society.machine && state.society.machine.tech, 0), 0, 1);
    var mult = lifeMultOf(state, cfg, tech);
    var genes = (state.nobleLife && state.nobleLife.genes) || {};
    var lim = num(L.lifespanBio, 120) + (genes.repair ? GENE_REPAIR_BONUS : 0);
    (L.groups || []).forEach(function (gid) {
      var arr = (state.people && state.people.groups && state.people.groups[gid]) || null;
      if (!arr) return;
      for (var i = arr.length - 1; i >= 0; i--) {
        var p = arr[i];
        if (!p.phase) lifeInit(p, cfg, !!p.dormant);
        var awakeLimit = num((L.awakeYears || {})[p.layer], 20);
        var sleepLimit = num((L.sleepYears || {})[p.layer], 20);
        p.existYears += dt;
        if (p.phase === "asleep") {
          p.bioYears += dt * mult;
          p.phaseYears += dt;
          if (p.phaseYears >= sleepLimit) {
            p.phase = "awake"; p.phaseYears = 0; p.dormant = false;
            if (p.action === "休眠" || !ACTIONS[p.action]) p.action = defaultAction(cfg, p.g);
          }
        } else {
          p.bioYears += dt;
          p.awakeYears += dt;
          p.phaseYears += dt;
          if (p.phaseYears >= awakeLimit) {
            p.phase = "asleep"; p.phaseYears = 0; p.dormant = true; p.action = "休眠";
          }
        }
        if (p.bioYears >= lim) {
          arr.splice(i, 1);
          var st = state.groups && state.groups[gid];
          if (st) {
            if (p.phase === "asleep") st.dormant = Math.max(0, num(st.dormant) - 1);
            else st.awake = Math.max(0, num(st.awake) - 1);
          }
          if (!state.nobleLife) state.nobleLife = { genes: {}, deaths: 0 };
          state.nobleLife.deaths = num(state.nobleLife.deaths, 0) + 1;
        }
      }
      var aw = 0, dm = 0;
      arr.forEach(function (p) { if (p.dormant) dm++; else aw++; });
      var st2 = state.groups && state.groups[gid];
      if (st2) { st2.awake = aw; st2.dormant = dm; }
    });
    state.nobleLife = state.nobleLife || { genes: {}, deaths: 0 };
    state.nobleLife.lastTech = tech;
    state.nobleLife.lastMult = mult;
  }

  function nobleSummary(state, cfg) {
    var L = cfg.nobleLife || {};
    var tech = clamp(num(state.society && state.society.machine && state.society.machine.tech, 0), 0, 1);
    var t = lifeTierOf(cfg, tech);
    var mult = lifeMultOf(state, cfg, tech);
    var n = 0, bio = 0, exist = 0, awkyr = 0, awake = 0, asleep = 0, oldest = 0;
    (L.groups || []).forEach(function (gid) {
      ((state.people && state.people.groups && state.people.groups[gid]) || []).forEach(function (p) {
        if (!p.phase) lifeInit(p, cfg, !!p.dormant);
        n++; bio += p.bioYears; exist += p.existYears; awkyr += p.awakeYears;
        if (p.dormant) asleep++; else awake++;
        if (p.bioYears > oldest) oldest = p.bioYears;
      });
    });
    var g = state.nobleLife || {};
    return {
      techTier: t.idx + 1, tierName: t.tier.name, tierTech: t.tier.tech,
      baseMultPct: t.tier.mult * 100, multPct: mult * 100,
      genes: Object.keys(g.genes || {}).filter(function (k) { return g.genes[k]; }),
      paths: Object.keys((L.gene && L.gene.paths) || {}).map(function (k) {
        var d = L.gene.paths[k];
        return { id: k, name: d.name, text: d.text, tech: d.tech, drug: d.drug, dna: d.dna,
                 got: !!(g.genes && g.genes[k]) };
      }),
      floorPct: num(L.gene && L.gene.floor, 0.004) * 100,
      lifespan: num(L.lifespanBio, 120) + ((g.genes && g.genes.repair) ? GENE_REPAIR_BONUS : 0),
      count: n, awake: awake, asleep: asleep, deaths: num(g.deaths, 0),
      avgBio: n ? bio / n : 0, avgExist: n ? exist / n : 0, avgAwake: n ? awkyr / n : 0,
      oldest: oldest
    };
  }

  function nobleGene(state, cfg, path) {
    var d = cfg.nobleLife && cfg.nobleLife.gene && cfg.nobleLife.gene.paths[path];
    if (!d) return { ok: false, msg: "没有这条基因强化路线" };
    state.nobleLife = state.nobleLife || { genes: {}, deaths: 0 };
    if (!state.nobleLife.genes) state.nobleLife.genes = {};
    if (state.nobleLife.genes[path]) return { ok: false, msg: "「" + d.name + "」已经做过" };
    var tech = num(state.society && state.society.machine && state.society.machine.tech, 0);
    if (tech + 1e-9 < num(d.tech, 0)) {
      return { ok: false, msg: "需要 " + Math.round(num(d.tech) * 100) + " 科技点，当前 " + Math.round(tech * 100) };
    }
    if (num(state.stocks && state.stocks.drug, 0) < num(d.drug, 0)) return { ok: false, msg: "药剂不足（需 " + d.drug + " 份）" };
    if (num(state.stocks && state.stocks.dna, 0) < num(d.dna, 0)) return { ok: false, msg: "DNA 不足（需 " + d.dna + " 单位）" };
    state.stocks.drug -= num(d.drug, 0);
    state.stocks.dna -= num(d.dna, 0);
    state.nobleLife.genes[path] = true;
    return { ok: true, msg: "已完成「" + d.name + "」：" + d.text, noble: nobleSummary(state, cfg) };
  }

  /** 某层贵族的平均清醒年限（资历口径，不含休眠那些年）。 */
  function avgAwake(state, cfg, layer) {
    var n = 0, sum = 0;
    ((cfg.nobleLife && cfg.nobleLife.groups) || []).forEach(function (gid) {
      (((state.people || {}).groups || {})[gid] || []).forEach(function (p) {
        if (layer && p.layer !== layer) return;
        sum += num(p.awakeYears, 0); n++;
      });
    });
    return n > 0 ? sum / n : null;
  }

  // ---------------- v6.59 眷属：逐人转化 ----------------
  // 旧版是「队列 × 转化比例 + bonus 池」，现在是具体的人：
  // 每周按个人感染度、三要素抵抗、接触网络暴露度判一次；阶位只升不降。
  var CULT_LABEL = { 1: "低语者", 2: "变形者", 3: "眷属贵族" };

  function cultCfg(cfg) {
    return (cfg.society && cfg.society.cult) || null;
  }

  /** 人所属的队列：layer + dept；克隆人队列挂在 L4 下、用 kind 区分。 */
  function queueMapOf(soc) {
    var qm = {};
    (soc.queues || []).forEach(function (q) {
      var k = q.layer + "|" + q.dept + "|" + q.kind;
      (qm[k] || (qm[k] = [])).push(q);
    });
    return qm;
  }
  function queueOfPerson(p, qm) {
    var a = qm[p.layer + "|" + p.dept + "|" + p.layer];
    if (a && a.length) return a[0];
    if (p.layer === "L4clone") {
      var b = qm["L4|" + p.dept + "|L4clone"];
      if (b && b.length) return b[0];
    }
    var c = qm["L4|" + p.dept + "|L4"];
    return (c && c.length) ? c[0] : null;
  }

  /** 舱段归属：只由 seq 决定，与轮换无关，可缓存。 */
  function zoneOf(p, cfg) {
    if (p._z) return p._z;
    p._z = posOf(p, cfg, 0).zone;
    return p._z;
  }

  /**
   * 接触网络暴露度：从自己常接触的人里抽 contactK 个，
   * 看其中眷属占多少。同舱段为主，其余取同部门 / 同班次。
   * 隔离执行度越高，眷属越抽不到——隔离同时压低接触面与扩散速度。
   */
  function exposureOf(p, pools, iso, wk, C) {
    var zp = pools[p._z] || [];
    var dp = pools["D:" + p.dept] || [];
    var K = Math.max(2, Math.round(num(C.contactK, 6)));
    var zw = clamp(num(C.zoneW, 0.55), 0, 1);
    var hit = 0, n = 0;
    for (var i = 0; i < K; i++) {
      var useZone = h01(p.seq * 31 + i, 1901 + wk) < zw;
      var arr = useZone ? zp : dp;
      if (!arr || arr.length < 2) arr = useZone ? dp : zp;
      if (!arr || arr.length < 2) continue;
      var o = arr[Math.floor(h01(p.seq * 37 + i, 1913 + wk) * arr.length)];
      if (!o || o === p) continue;
      if (o.cultStage >= 1 && h01(o.seq * 41 + i, 1927 + wk) < iso * num(C.isolationK, 0.8)) continue;
      n++;
      if (o.cultStage >= 1) hit++;
    }
    return n ? hit / n : 0;
  }

  /**
   * 情报可见度：科技 / 警备 / 机器人 / 统治力 / 服从度加权成 intel，
   * 再减去反对教派的遮蔽，加上主角本人是眷属时的 +0.25。
   */
  function cultVisibility(state, cfg, stageCount) {
    var C = cultCfg(cfg) || {};
    var V = C.visibility || {};
    var soc = state.society || {};
    var tech = clamp(num(soc.machine && soc.machine.tech, 0), 0, 1);
    // 警备 / 机器人按「覆盖率」算：60 人守 3000 人不是 100% 覆盖
    var awakeAll = 0;
    Object.keys(state.people.groups || {}).forEach(function (gid) {
      state.people.groups[gid].forEach(function (p) { if (!p.dormant) awakeAll++; });
    });
    var police = clamp(num(soc.garrison && soc.garrison.strength, 0) / Math.max(1, awakeAll * 0.15), 0, 1);
    var robots = clamp(num(soc.garrison && soc.garrison.infiltrators, 0) / Math.max(1, awakeAll * 0.01), 0, 1);
    var dominion = 0, opp = 0, tot = 0;
    (soc.queues || []).forEach(function (q) {
      if (q.layer === "L1" || q.layer === "L2") dominion = Math.max(dominion, num(q.D, 0) / 100);
      tot += num(q.n, 0);
      if (num(q.O, 60) < 35) opp += num(q.n, 0);
    });
    var compliance = clamp(num(soc.meanO, 60) / 100, 0, 1);
    // 科技与统治力是主要来源；警备 / 机器人 / 服从度补余
    var intel = 0.45 * tech + 0.15 * police + 0.10 * robots + 0.20 * dominion + 0.10 * compliance;
    var oppShare = tot > 0 ? opp / tot : 0;
    var oppPen = Math.min(num(V.oppCap, 0.5), oppShare * num(V.oppK, 0.5));
    var playerBonus = (num(state.player && state.player.cultStage, 0) >= 1 ||
      num(state.player && state.player.pc && state.player.pc.stage, 0) >= 3)
      ? num(V.playerBonus, 0.25) : 0;
    var rate = clamp(num(V.base, 0.15) + intel * num(V.intelK, 0.85) - oppPen + playerBonus, 0, 1);
    var total = num(stageCount[1], 0) + num(stageCount[2], 0) + num(stageCount[3], 0);
    var reported;
    if (rate < 0.5) {
      var lo = Math.max(0, Math.round(total * Math.max(0, rate - 0.15)));
      var hi = Math.round(total * Math.min(1, rate + 0.15));
      reported = { mode: "range", lo: lo, hi: hi,
        label: total ? "约 " + lo + "–" + hi + " 人" : "没有发现迹象" };
    } else if (rate < 0.85) {
      var approx = Math.round(total * rate / 5) * 5;
      reported = { mode: "approx", value: approx, label: "约 " + approx + " 人" };
    } else {
      reported = { mode: "exact", value: total, label: total + " 人（已核实）" };
    }
    return {
      rate: rate, reported: reported,
      intel: { tech: tech, police: police, robots: robots, dominion: dominion,
               compliance: compliance, opposition: oppShare }
    };
  }

  /** 按需把 N 个具体的人转成眷属（神直接收人、召唤新增都走这里）。 */
  function convertN(state, cfg, n) {
    if (!state.people || !state.people.groups) return 0;
    var want = Math.max(0, Math.round(num(n, 0)));
    if (!want) return 0;
    var pool = [];
    Object.keys(state.people.groups).forEach(function (gid) {
      state.people.groups[gid].forEach(function (p) {
        if (p.dormant || num(p.cultStage, 0) >= 1) return;
        if (actionOf(p, cfg) === "医疗隔离" || actionOf(p, cfg) === "失踪/叛逃") return;
        pool.push(p);
      });
    });
    if (!pool.length) return 0;
    var wk = state.weeks | 0, done = 0;
    for (var i = 0; i < want && pool.length; i++) {
      var idx = Math.floor(h01(wk * 19 + i, 2003) * pool.length);
      var p = pool.splice(idx, 1)[0];
      p.cultStage = 1; p.cultSince = wk; p.cultC = 30;
      done++;
    }
    return done;
  }

  /** 反向：从眷属里放回 N 个人（治疗 / 交易赎回），只挑低阶位。 */
  function releaseN(state, cfg, n) {
    if (!state.people || !state.people.groups) return 0;
    var want = Math.max(0, Math.round(num(n, 0))), done = 0;
    Object.keys(state.people.groups).forEach(function (gid) {
      if (done >= want) return;
      state.people.groups[gid].forEach(function (p) {
        if (done >= want) return;
        if (num(p.cultStage, 0) !== 1) return;
        p.cultStage = 0; p.cultC = 0; p.cultSince = 0; done++;
      });
    });
    return done;
  }

  /**
   * 每周眷属结算：逐人转化 → 阶位晋升 → 耐受淘汰 → 聚合与可见度。
   * 旧档（没有 state.cult）第一次进入时按队列 thrallFrac 落成具体的人，只做一次。
   */
  function cultTick(state, cfg) {
    var C = cultCfg(cfg);
    if (!C) return null;
    if (!state.people) sync(state, cfg);
    var ppl = state.people;
    if (!ppl || !ppl.groups) return null;
    var wk = state.weeks | 0;
    if (ppl.cultWeek === wk && state.cult) return state.cult;
    ppl.cultWeek = wk;

    var soc = state.society || {};
    var qm = queueMapOf(soc);

    // 旧档迁移：把队列比例落成具体的人（一次）
    if (!state.cult || !state.cult.seeded) {
      (soc.queues || []).forEach(function (q) {
        var frac = num(q.thrallFrac, 0);
        if (frac <= 0) return;
        var want = Math.round(num(q.n, 0) * frac);
        if (want <= 0) return;
        var cand = [];
        Object.keys(ppl.groups).forEach(function (gid) {
          ppl.groups[gid].forEach(function (p) {
            if (num(p.cultStage, 0) >= 1) return;
            if (queueOfPerson(p, qm) !== q) return;
            cand.push(p);
          });
        });
        for (var i = 0; i < want && cand.length; i++) {
          var p = cand[Math.floor(h01(p.seq, 2005) * cand.length)];
          p.cultStage = num(q.stage, 0) >= 3 ? 3 : (num(q.stage, 0) === 2 ? 2 : 1);
          p.cultC = p.cultStage === 3 ? 90 : (p.cultStage === 2 ? 68 : 38);
          p.cultSince = wk - num(q.highWeeks, 0);
          cand.splice(cand.indexOf(p), 1);
        }
      });
      state.cult = state.cult || {};
      state.cult.seeded = true;
    }

    var iso = clamp(num(soc.env && soc.env.iso, 0), 0, 1);
    var med = clamp(num(state.last && state.last.medCoverage, 0.5), 0, 1);
    var all = [], pools = {}, thrallN = 0, awakeN = 0;
    var stageCount = { 1: 0, 2: 0, 3: 0 };
    var qCount = {}, qTotal = {};

    Object.keys(ppl.groups).forEach(function (gid) {
      var arr = ppl.groups[gid];
      for (var i = 0; i < arr.length; i++) {
        var p = arr[i];
        var q = queueOfPerson(p, qm);
        if (q) {
          qTotal[q.id] = num(qTotal[q.id], 0) + 1;
          if (num(p.cultStage, 0) >= 1) qCount[q.id] = num(qCount[q.id], 0) + 1;
        }
        if (num(p.cultStage, 0) >= 1) {
          thrallN++;
          stageCount[p.cultStage] = num(stageCount[p.cultStage], 0) + 1;
        }
        var act = actionOf(p, cfg);
        if (p.dormant || act === "休眠" || act === "医疗隔离" || act === "失踪/叛逃") continue;
        awakeN++;
        all.push(p);
        var z = zoneOf(p, cfg);
        (pools[z] || (pools[z] = [])).push(p);
        (pools["D:" + p.dept] || (pools["D:" + p.dept] = [])).push(p);
      }
    });

    if (!awakeN) {
      state.cult = state.cult || {};
      state.cult.trueCounts = { 1: 0, 2: 0, 3: 0, total: 0 };
      state.cult.lastWeek = wk;
      return state.cult;
    }

    var shipDensity = thrallN / awakeN;
    var cap2 = Math.max(1, Math.floor(awakeN * num(C.stage2Cap, 0.08)));
    var cap3 = Math.max(1, Math.floor(awakeN * num(C.stage3Cap, 0.008)));
    var W = C.resistW || { hp: 0.55, mut: 0.45 };
    var news = 0, promoted = 0;
    var dead = [];

    all.forEach(function (p) {
      var stage = num(p.cultStage, 0);
      var q = queueOfPerson(p, qm);
      var isNoble = p.layer === "L1" || p.layer === "L2" || p.layer === "L3";

      if (stage >= 1) {
        // 第二条线：进展速度 ← 意志。意志高则涨得慢；克隆人意志低，涨满就是彻底变异
        var ps1 = pStats(p, state, cfg);
        var grow = num(C.growBase, 0.55) * (1 - (ps1.will / 100) * num(C.willK, 0.75)) *
          (1 + Math.min(1, shipDensity) * num(C.growInduce, 0.6));
        p.cultC = clamp(num(p.cultC, 30) + Math.max(0, grow), 0, 100);
        if (stage === 1 && p.cultC >= num(C.stage2At, 60) && stageCount[2] < cap2) {
          p.cultStage = 2; p.cultSince = wk;
          stageCount[1]--; stageCount[2]++; promoted++;
        } else if (stage === 2 && p.cultC >= num(C.stage3At, 85) && stageCount[3] < cap3 && isNoble) {
          p.cultStage = 3; p.cultSince = wk;
          stageCount[2]--; stageCount[3]++; promoted++;
        }
        // 第三条线：死不死 ← 医疗条件与体质。贵族医疗好、体格稳，感染后活得久
        var careF = clamp(med + (isNoble ? num(C.nobleMed, 0.25) : 0), 0, 1);
        var leth = Math.pow(p.cultC / 100, 2) *
          (1 - careF * num(C.medK, 0.35)) * (1 - (ps1.hp / 100) * num(C.hpK, 0.25));
        if (h01(p.seq, 1801 + wk * 11) < num(C.deathBase, 0.0048) * leth) dead.push(p);
        return;
      }

      if (!q) return;
      // 逐人感染度：队列 C 加个人偏移
      var cp = clamp(num(q.C, 0) + (h01(p.seq, 1607) - 0.5) * 16, 0, 100);
      if (cp < num(C.cFloor, 30)) return;
      // 队列必须先过「高感染持续」那道判定（q.cultOpenUntil）
      if (wk >= num(q.cultOpenUntil, -1)) return;
      var drive = Math.min(0.98, Math.pow((cp - num(C.cFloor, 30)) / num(C.infSpan, 55), 2));
      var ps = pStats(p, state, cfg);
      // 第一条线：会不会被转化 ← 健康、低变异度、高癫狂、接触暴露。
      // 意志不在这里（它只管转化后进展有多快）。
      var resist = (ps.hp / 100) * W.hp + ((100 - num(p.mutation, 40)) / 100) * W.mut;
      var rf = clamp(1 - resist * num(C.resistCap, 0.85), 0.05, 1);
      var maniaF = 1 + (num(p.mania, 40) / 100) * num(C.maniaK, 1.2);
      var expo = exposureOf(p, pools, iso, wk, C);
      var density = Math.min(expo, shipDensity);   // 全船密度只封顶
      var induce = 1 + Math.min(num(C.densityCap, 1), density) * num(C.induceK, 1.5);
      var chance = num(C.base, 0.0004) * drive * rf * maniaF * induce * (1 - med * 0.25);
      if (h01(p.seq, 1709 + wk * 7) < chance) {
        p.cultStage = 1; p.cultSince = wk; p.cultC = 30;
        stageCount[1]++; news++;
      }
    });

    // 神 / 事件遗留的 bonus：折成具体的人，不再留在池里滚雪球
    var bonus = num(soc.infection && soc.infection.bonus, 0);
    if (bonus >= 1) {
      var addN = Math.floor(bonus);
      var done = convertN(state, cfg, addN);
      soc.infection.bonus = bonus - addN;
      news += done; stageCount[1] += done; thrallN += done;
    }

    // 淘汰：从名册移除并同步人口计数
    if (dead.length) {
      state.cult.deathsByGroup = state.cult.deathsByGroup || {};
      var deadSet = {};
      dead.forEach(function (p) { deadSet[p.seq] = true; });
      Object.keys(ppl.groups).forEach(function (gid) {
        var arr = ppl.groups[gid];
        for (var i = arr.length - 1; i >= 0; i--) {
          if (!deadSet[arr[i].seq]) continue;
          var p = arr.splice(i, 1)[0];
          var st = state.groups && state.groups[gid];
          if (st) {
            if (p.dormant) st.dormant = Math.max(0, num(st.dormant) - 1);
            else st.awake = Math.max(0, num(st.awake) - 1);
          }
          state.cult.deaths = num(state.cult.deaths, 0) + 1;
          state.cult.deathsByGroup[gid] = num(state.cult.deathsByGroup[gid], 0) + 1;
        }
      });
    }

    var total = num(stageCount[1], 0) + num(stageCount[2], 0) + num(stageCount[3], 0);
    state.cult.trueCounts = { 1: stageCount[1], 2: stageCount[2], 3: stageCount[3], total: total };
    state.cult.lastWeek = wk;
    state.cult.news = news;
    var vis = cultVisibility(state, cfg, stageCount);
    state.cult.visibleRate = vis.rate;
    state.cult.reported = vis.reported;
    state.cult.intel = vis.intel;
    state.cult.density = shipDensity;
    state.cult.labels = CULT_LABEL;

    // 队列聚合只读：thrallFrac 由人身上的真实人数回填
    (soc.queues || []).forEach(function (q) {
      var n = Math.max(0, num(q.n, 0));
      var cnt = num(qCount[q.id], 0);
      q.thrallCount = cnt;
      q.thrallFrac = n > 0 ? clamp(cnt / n, 0, 1) : 0;
    });
    if (soc.infection) soc.infection.thralls = total;
    ppl.cache = null;
    return state.cult;
  }

  function cultSummary(state, cfg) {
    if (!state.cult) return null;
    return {
      reported: state.cult.reported || null,
      visibleRate: num(state.cult.visibleRate, 0),
      stages: state.cult.trueCounts || null,
      density: num(state.cult.density, 0),
      deaths: num(state.cult.deaths, 0),
      deathsByGroup: state.cult.deathsByGroup || {},
      news: num(state.cult.news, 0),
      labels: state.cult.labels || CULT_LABEL
    };
  }

  /** 某层（可按部门再筛）的人均魅力；休眠者也算在内，因为魅力是固有属性。 */
  function charmAvg(ppl, layer, dept) {
    if (!ppl || !ppl.groups) return null;
    var n = 0, sum = 0;
    Object.keys(ppl.groups).forEach(function (gid) {
      (ppl.groups[gid] || []).forEach(function (p) {
        if (layer && p.layer !== layer) return;
        if (dept && p.dept !== dept) return;
        sum += num(p.charm, 55); n++;
      });
    });
    return n > 0 ? sum / n : null;
  }

  global.XuanShuPeople = {
    version: "1.4.0",
    create: create,
    sync: sync,
    truth: truth,
    playerView: playerView,
    brief: brief,
    wellbeing: wellbeing,
    actionMix: actionMix,
    setAction: setAction,
    actionOf: actionOf,
    charmAvg: charmAvg,
    nobleSummary: nobleSummary,
    nobleGene: nobleGene,
    avgAwake: avgAwake,
    cultTick: cultTick,
    cultSummary: cultSummary,
    convertN: convertN,
    releaseN: releaseN,
    ACTIONS: ACTIONS,
    ACTION_LIST: ACTION_LIST,
    posOf: posOf
  };

  if (typeof module !== "undefined" && module.exports) module.exports = global.XuanShuPeople;
})(typeof globalThis !== "undefined" ? globalThis : this);
