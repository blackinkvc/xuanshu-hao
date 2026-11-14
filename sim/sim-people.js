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

  function makePerson(ppl, cfg, gid) {
    var seq = ppl.seq++;
    var layer = pickLayer(cfg, gid, seq);
    return {
      seq: seq,
      id: "P" + (10000 + seq),
      g: gid,
      layer: layer,
      dept: (cfg.people.groupDept && cfg.people.groupDept[gid]) || "勤务",
      // 植入是「真值」属性：装没装芯片在建造/入伍时就定了，不随周变化
      implanted: h01(seq, 23) < implantBaseOf(cfg, layer),
      dormant: false
    };
  }

  function create(cfg) {
    var ppl = { seq: 0, groups: {}, cache: null };
    (cfg.population.groups || []).forEach(function (g) {
      var arr = (ppl.groups[g.id] = []);
      var n = Math.max(0, Math.round(num(g.awake) + num(g.dormant)));
      for (var i = 0; i < n; i++) arr.push(makePerson(ppl, cfg, g.id));
      var dorm = Math.max(0, Math.min(n, Math.round(num(g.dormant))));
      for (var k = 0; k < n; k++) arr[k].dormant = k >= n - dorm;
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
    (cfg.population.groups || []).forEach(function (g) {
      var arr = ppl.groups[g.id] || (ppl.groups[g.id] = []);
      var st = state.groups[g.id] || { awake: 0, dormant: 0 };
      var target = Math.max(0, Math.round(num(st.awake) + num(st.dormant)));
      var dormTarget = Math.max(0, Math.min(target, Math.round(num(st.dormant))));
      while (arr.length < target) arr.push(makePerson(ppl, cfg, g.id));
      while (arr.length > target) arr.pop();
      var cut = target - dormTarget;
      for (var i = 0; i < arr.length; i++) {
        var want = i >= cut;
        if (arr[i].dormant !== want) arr[i].dormant = want;
      }
    });
    ppl.cache = null;
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
      hp: Math.round(clamp(hp, 5, 100) * 10) / 10,
      mind: Math.round(clamp(mind, 0, 100) * 10) / 10,
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
    var b = {
      view: "truth",
      total: total,
      implantedShare: total ? Math.round(implanted / total * 1000) / 1000 : 0,
      zones: zones,
      wellbeing: wellbeing(state, cfg),
      note: "真值聚合；个人明细用 snapshot({view:'truth'})，玩家视图用 snapshot({view:'player',intel})"
    };
    ppl.cache = { week: week, brief: b, wb: b.wellbeing, wbWeek: week };
    return b;
  }

  global.XuanShuPeople = {
    version: "1.0.0",
    create: create,
    sync: sync,
    truth: truth,
    playerView: playerView,
    brief: brief,
    wellbeing: wellbeing,
    posOf: posOf
  };

  if (typeof module !== "undefined" && module.exports) module.exports = global.XuanShuPeople;
})(typeof globalThis !== "undefined" ? globalThis : this);
