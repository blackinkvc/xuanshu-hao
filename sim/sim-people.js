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

  function geneticsOn(cfg) {
    return !!(global.XuanShuGenetics && global.XuanShuGenetics.enabled(cfg));
  }

  function ensureGenState() {
    return {
      screened: 0, passed: 0, failed: 0, mutationDeaths: 0,
      healthDeaths: 0, lifespanDeaths: 0, screenDeaths: 0, externalDeaths: 0,
      painkiller: "need", drugWant: 0, drugBought: 0, drugFail: 0,
      causes: { mutation: 0, health: 0, lifespan: 0, screen: 0, external: 0 },
      deathAges: []
    };
  }

  // 死亡年龄环形缓冲：只留最近 512 条，避免无限增长
  function pushDeathAge(S, age) {
    if (!S || !isFinite(age)) return;
    var buf = S.deathAges || (S.deathAges = []);
    buf.push(Math.round(age * 10) / 10);
    if (buf.length > 512) buf.shift();
  }

  function pctOf(arr, p) {
    if (!arr || !arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var i = Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)));
    return a[i];
  }

  /**
   * 遗传层初始化：基因型、表现型、出生变异、年龄、初始健康/痛苦。
   * initial=true 时给克隆 0–29 岁的开局年龄，并按年补算历史辐射增量，
   * 这样 30 岁判定时变异分布才是 8–12，而不是全员从 1–5 起跳。
   */
  function initGenetics(p, cfg, initial) {
    var X = global.XuanShuGenetics;
    if (!geneticsOn(cfg) || !X) {
      p.mutation = 0; p.tol = 0; p.radMul = 1; p.lifespanGene = 300;
      p.mutK = 1; p.age = 0; p.health = 80; p.pain = 0;
      p.genome = null; p.screened = false; p.breedPool = false; p.pk = null;
      p.gclass = "ordinary";
      return;
    }
    var G = cfg.genetics;
    p.genome = X.randomGenome(cfg, p.seq);
    var ph = X.phenotype(cfg, p.genome);
    p.tol = ph.tol;
    p.radMul = ph.radMul;
    p.rawR = ph.rawR;
    p.lifespanGene = ph.lifespanGene;
    p.mutK = ph.mutK;
    p.gclass = X.classOf(cfg, ph);

    p.mut0 = G.mutation.birthMin + X.h01(p.seq, 51) * (G.mutation.birthMax - G.mutation.birthMin);
    p.age = 0;
    if (initial && p.g === G.screen.group) p.age = X.h01(p.seq, 61) * 29;
    var yrs = Math.floor(p.age);
    var mut = p.mut0;
    for (var y = 1; y <= yrs; y++) mut += X.annualDelta(cfg, p.seq, y, p.radMul, 0);
    p.mutation = Math.min(G.mutation.deathAt, mut);
    p.mutYear = yrs;
    p.health = X.healthAt(cfg, p.mutation, p.tol, p.age, 1);
    p.pain = X.painAt(cfg, p.mutation, p.health);
    p.screened = false;
    p.breedPool = false;
    p.pk = null;
    p.deathCause = null;
  }

  function makePerson(ppl, cfg, gid, initial) {
    var seq = ppl.seq++;
    var layer = pickLayer(cfg, gid, seq);
    var p = {
      seq: seq,
      id: "P" + (10000 + seq),
      g: gid,
      layer: layer,
      dept: (cfg.people.groupDept && cfg.people.groupDept[gid]) || "勤务",
      // 魅力：开局一次定值，休眠/唤醒都不改；派系好感与买卖交涉会用到
      charm: charmOf(cfg, seq),
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
        h01(seq, 29) * (num(cfg.people.mania.max, 62) - num(cfg.people.mania.min, 18))),
      // 个人经济与就业：工资进钱包，失业即零收入；口粮/止痛药从钱包扣
      wallet: 0,
      employed: false,
      job: "",
      unemployedWeeks: 0,
      foodPaid: false,
      ration: 1,
      maln: 0,
      drugHurt: 0,
      // 按摩服务：masseur 为当月身份，massageMonth 记录最近一次按摩的结算月
      masseur: false,
      massageMonth: -1,
      massageUntil: -1,
      massageRelief: 0
    };
    // 个人钱包：全部阶层统一口径，工资、付费口粮、止痛药都从这里进出
    var wstart = (cfg.coin && cfg.coin.personalWalletStart) || {};
    p.wallet = num(wstart[classOfGroup(cfg, gid)], 0);
    initGenetics(p, cfg, !!initial);
    return p;
  }

  function create(cfg) {
    var ppl = { seq: 0, groups: {}, cache: null };
    (cfg.population.groups || []).forEach(function (g) {
      var arr = (ppl.groups[g.id] = []);
      var n = Math.max(0, Math.round(num(g.awake) + num(g.dormant)));
      for (var i = 0; i < n; i++) arr.push(makePerson(ppl, cfg, g.id, true));
      var dorm = Math.max(0, Math.min(n, Math.round(num(g.dormant))));
      for (var k = 0; k < n; k++) {
        arr[k].dormant = k >= n - dorm;
        if (arr[k].dormant) arr[k].action = "休眠";
      }
    });
    return ppl;
  }

  /* ---------------- 就业分配 ---------------- */

  function classOfGroup(cfg, gid) {
    var und = (cfg.population && cfg.population.undecidedId) || "undecided";
    if (gid === und || gid === "incubator") return "undecided";
    if (gid === "noble") return "noble";
    if (gid === "clone") return "clone";
    return "commoner";
  }

  /**
   * 按岗位表给人上/下岗：在岗者优先保留，岗位收缩时裁最新入职，
   * 空缺优先给失业最久的人。失业时长按周累计。
   */
  function assignJobs(state, cfg, slotsByClass) {
    var out = { byClass: {}, unemployedWeeks: null, avgHealth: 70 };
    var ppl = state.people;
    if (!ppl || !ppl.groups) return out;
    var workAge = num(cfg.labor && cfg.labor.workAge, 16);
    var bucket = { noble: [], commoner: [], clone: [] };
    var hpSum = 0, hpN = 0;

    Object.keys(ppl.groups).forEach(function (gid) {
      var c = classOfGroup(cfg, gid);
      var arr = ppl.groups[gid] || [];
      for (var i = 0; i < arr.length; i++) {
        var p = arr[i];
        // 只有克隆体是按真实年龄建模的个体；其余阶层的人只是名册占位（age 从 0 起），
        // 不拿年龄卡他们的岗位，醒着就算劳动力。
        var eligible = c !== "undecided" && !p.dormant &&
          (c !== "clone" || num(p.age, 0) >= workAge);
        if (!eligible) {
          p.employed = false;
          p.job = "";
          p.unemployedWeeks = 0;
          continue;
        }
        bucket[c].push(p);
        hpSum += num(p.health, 70);
        hpN++;
      }
    });

    var allWeeks = [];
    ["noble", "commoner", "clone"].forEach(function (c) {
      var arr = bucket[c];
      var slots = Math.max(0, Math.round(num(slotsByClass && slotsByClass[c], 0)));
      // 贵族是食利层：编制外的贵族不计失业，只记 surplus，避免把上层算成失业大军
      if (c === "noble" && arr.length > slots) {
        for (var e = slots; e < arr.length; e++) {
          arr[e].employed = false;
          arr[e].job = "";
          arr[e].unemployedWeeks = 0;
        }
        arr = arr.slice(0, slots);
        bucket[c] = arr;
      }
      var employed = [], waiting = [];
      arr.forEach(function (p) {
        if (p.employed) employed.push(p); else waiting.push(p);
      });
      if (employed.length > slots) {
        employed.sort(function (a, b) { return num(a.seq) - num(b.seq); });
        var cut = employed.splice(slots, employed.length - slots);
        cut.forEach(function (p) { p.employed = false; p.job = ""; waiting.push(p); });
      }
      var need = Math.max(0, slots - employed.length);
      if (need > 0) {
        waiting.sort(function (a, b) {
          var d = num(b.unemployedWeeks) - num(a.unemployedWeeks);
          return d !== 0 ? d : num(a.seq) - num(b.seq);
        });
        for (var i = 0; i < waiting.length && need > 0; i++, need--) {
          waiting[i].employed = true;
          waiting[i].job = waiting[i].dept || c;
        }
      }
      var empN = 0, unN = 0;
      arr.forEach(function (p) {
        if (p.employed) { p.unemployedWeeks = 0; p.job = p.job || p.dept || c; empN++; }
        else {
          p.unemployedWeeks = num(p.unemployedWeeks, 0) + 1;
          unN++;
          allWeeks.push(p.unemployedWeeks);
        }
      });
      out.byClass[c] = { labor: arr.length, employed: empN, unemployed: unN };
    });

    allWeeks.sort(function (a, b) { return a - b; });
    function q(p) { return allWeeks.length ? pctOf(allWeeks, p) : 0; }
    var sum = 0, g13 = 0, g26 = 0, g52 = 0;
    allWeeks.forEach(function (w) {
      sum += w;
      if (w > 13) g13++;
      if (w > 26) g26++;
      if (w > 52) g52++;
    });
    out.unemployedWeeks = {
      mean: allWeeks.length ? Math.round(sum / allWeeks.length * 10) / 10 : 0,
      p10: q(0.10), p50: q(0.50), p90: q(0.90),
      gt13: g13, gt26: g26, gt52: g52
    };
    out.avgHealth = hpN > 0 ? hpSum / hpN : 70;
    return out;
  }

  /** 每周口粮双轨：免费份额全船发，付费份额从个人钱包扣；扣不起就是吃不饱。 */
  function rationTick(state, cfg) {
    var ppl = state.people;
    if (!ppl || !ppl.groups) return;
    var wk = Math.floor(num(state.weeks, 0));
    var S = state.genetics || (state.genetics = ensureGenState());
    if (S.rationWeek === wk) return;
    S.rationWeek = wk;
    S.foodWant = 0;
    S.foodFail = 0;
    var price = num(cfg.food && cfg.food.paidPrice, 2);
    var share = clamp(num(cfg.food && cfg.food.paidShare, 0.30), 0, 1);
    var freeShare = clamp(num(cfg.food && cfg.food.freeShare, 0.70), 0, 1);
    var gRatio = clamp(num(state.last && state.last.rationActual, 1), 0, 1);
    var kgW = num(cfg.food && cfg.food.perCapitaTpy, 0.2263) * 1000 / 52.14 * share;
    var cost = kgW * price;
    var gid0 = (cfg.genetics && cfg.genetics.screen && cfg.genetics.screen.group) || "clone";
    Object.keys(ppl.groups).forEach(function (gid) {
      if (gid === "incubator" || gid === "undecided" || gid === "derelict") return; // 未成年/不在册
      // 贵族由船方供养：个人星币是纯可支配收入，不参与付费口粮（否则永远无钱消费）
      if (gid === "noble" || gid === "original") return;
      var realAge = (gid === gid0);
      ((ppl.groups && ppl.groups[gid]) || []).forEach(function (p) {
        if (p.dormant) { p.foodPaid = false; p.ration = 0.02; return; }
        // 未成年吃免费维生口粮，不参与付费购买，也不算“买不起”
        if (realAge && num(p.age, 0) < num(cfg.labor && cfg.labor.workAge, 16)) {
          p.foodPaid = false;
          p.ration = Math.min(freeShare, gRatio);
          return;
        }
        S.foodWant++;
        if (num(p.wallet, 0) >= cost) {
          p.wallet -= cost;
          p.foodPaid = true;
        } else {
          p.foodPaid = false;
          S.foodFail++;
        }
        p.ration = Math.min(freeShare, gRatio) + (p.foodPaid ? (1 - freeShare) : 0);
      });
    });
  }

  /* ---------------- 按摩服务（v7.2） ----------------
     每月结算时跑一次，全部走个人 wallet 真实转账：
     克隆顾客 → 克隆按摩师；平民按摩师 ← 贵族顾客。
     每人每月最多 1 次；克隆按痛苦阈值决定是否消费，贵族按概率购买。
     返回本月统计，写进 state.massage.last 供界面与冒烟读取。 */
  function massageTick(state, cfg) {
    var M = (cfg.coin && cfg.coin.massage) || {};
    if (M.enabled === false) return null;
    var ppl = state.people;
    if (!ppl || !ppl.groups) return null;
    var S = state.massage || (state.massage = {});
    var mkey = num(state.coin && state.coin.settlements, 0);
    if (S.month === mkey) return S.last || null;   // 同一个月只结算一次
    S.month = mkey;
    var wk = Math.floor(num(state.weeks, 0));

    function arrOf(gid) { return ppl.groups[gid] || []; }
    var cloneArr = arrOf("clone");
    var nobleArr = arrOf("original").concat(arrOf("noble"));
    var comArr = arrOf("combat").concat(arrOf("tech"), arrOf("service"), arrOf("medical"));

    // 1) 角色分配：在岗者里按比例指派；先清掉上月身份，避免失业后仍挂按摩师
    function clearRole(arr, fallbackDept) {
      arr.forEach(function (p) {
        if (!p.masseur) return;
        p.masseur = false;
        p.job = p.employed ? (p.dept || fallbackDept) : "";
      });
    }
    clearRole(cloneArr, "农环");
    clearRole(comArr, "勤务");
    var cloneWork = cloneArr.filter(function (p) { return !p.dormant && p.employed; });
    var comWork = comArr.filter(function (p) { return !p.dormant && p.employed; });
    var cloneM = Math.max(0, Math.round(cloneWork.length * num(M.cloneMasseurShare, 0.05)));
    var comM = Math.max(0, Math.round(comWork.length * num(M.commonerMasseurShare, 0.02)));
    var a;
    for (a = 0; a < cloneWork.length && a < cloneM; a++) {
      cloneWork[a].masseur = true;
      cloneWork[a].job = "按摩师";
    }
    for (a = 0; a < comWork.length && a < comM; a++) {
      comWork[a].masseur = true;
      comWork[a].job = "按摩师";
    }
    var masseursC = cloneWork.filter(function (p) { return p.masseur; });
    var masseursN = comWork.filter(function (p) { return p.masseur; });

    // 2) 克隆 → 克隆按摩师：痛苦 ≥ mild 才想按，每人每月最多 1 次
    var priceC = num(M.clonePrice, 5);
    var painMin = num(M.clonePainMin, 20);
    var urge = num(cfg.genetics && cfg.genetics.drugs && cfg.genetics.drugs.painkiller.urgeAt, 30);
    var drugPrice = num(cfg.genetics && cfg.genetics.drugs && cfg.genetics.drugs.painkiller.price, 13);
    var capC = masseursC.length * Math.max(1, num(M.cloneCapacity, 25));
    var sessionsC = 0, paidC = 0;
    cloneWork.forEach(function (c) {
      if (sessionsC >= capC || masseursC.length === 0) return;
      if (c.masseur || num(c.pain, 0) < painMin) return;
      if (num(c.massageMonth, -1) === mkey) return;
      // 痛苦高到想买药、且买得起药时，多数人优先攒钱买药；
      // 但仍有 cloneCrowdOutP 比例的人选择先按摩，挤掉当月的药钱（权衡可见）。
      if (num(c.pain, 0) >= urge && num(c.wallet, 0) >= drugPrice) {
        var crowd = h01((num(c.seq, 0) + 1) * 173 + mkey * 59, 37);
        if (crowd >= num(M.cloneCrowdOutP, 0.25)) return;
      }
      if (num(c.wallet, 0) < priceC) return;
      var prov = masseursC[sessionsC % masseursC.length];
      c.wallet = num(c.wallet, 0) - priceC;
      prov.wallet = num(prov.wallet, 0) + priceC;
      c.massageMonth = mkey;
      c.massageUntil = wk + num(M.cloneWeeks, 2);
      c.massageRelief = num(M.cloneRelief, 12);
      sessionsC++;
      paidC += priceC;
    });

    // 3) 贵族 → 平民按摩师：价格贵得多，按概率购买
    var priceN = num(M.noblePrice, 45);
    var buyP = clamp(num(M.nobleBuyP, 0.35), 0, 1);
    var capN = masseursN.length * Math.max(1, num(M.nobleCapacity, 8));
    var sessionsN = 0, paidN = 0;
    nobleArr.forEach(function (c) {
      if (c.dormant || sessionsN >= capN || masseursN.length === 0) return;
      if (num(c.massageMonth, -1) === mkey) return;
      if (num(c.wallet, 0) < priceN) return;
      if (h01((num(c.seq, 0) + 1) * 131 + mkey * 97, 71) >= buyP) return;
      var prov = masseursN[sessionsN % masseursN.length];
      c.wallet = num(c.wallet, 0) - priceN;
      prov.wallet = num(prov.wallet, 0) + priceN;
      c.massageMonth = mkey;
      c.massageUntil = wk + num(M.nobleWeeks, 2);
      c.massageRelief = num(M.nobleRelief, 8);
      sessionsN++;
      paidN += priceN;
    });

    var workAge = num(cfg.labor && cfg.labor.workAge, 16);
    var awakeC = cloneArr.filter(function (p) { return !p.dormant && num(p.age, 0) >= workAge; }).length;
    var awakeN = nobleArr.filter(function (p) { return !p.dormant; }).length;
    S.last = {
      month: mkey, week: wk,
      clone: {
        labor: cloneWork.length, masseurs: masseursC.length,
        clients: awakeC, served: sessionsC,
        coverage: awakeC > 0 ? sessionsC / awakeC : 0,
        price: priceC, paid: paidC
      },
      noble: {
        clients: awakeN, masseurs: masseursN.length,
        served: sessionsN,
        coverage: awakeN > 0 ? sessionsN / awakeN : 0,
        price: priceN, paid: paidN
      },
      flow: paidC + paidN,
      sessions: sessionsC + sessionsN
    };
    S.oClone = num(M.oClone, 3) * clamp(S.last.clone.coverage, 0, 1);
    S.oNoble = num(M.oNoble, 2) * clamp(S.last.noble.coverage, 0, 1);
    return S.last;
  }

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
      while (arr.length < target) arr.push(makePerson(ppl, cfg, g.id, false));
      if (arr.length > target) {
        // 外部减员（饥荒/事件/回收）：先记死因再删，避免被误算成幼龄自然死亡
        var gone = arr.length - target;
        if (g.id === ((cfg.genetics && cfg.genetics.screen && cfg.genetics.screen.group) || "clone")) {
          var S0 = state.genetics || (state.genetics = ensureGenState());
          for (var gi = 0; gi < gone; gi++) {
            var gp = arr[arr.length - 1 - gi];
            if (!gp) continue;
            gp.deathCause = "external";
            gp.deathAge = num(gp.age, 0);
            pushDeathAge(S0, gp.deathAge);
          }
          S0.externalDeaths = num(S0.externalDeaths, 0) + gone;
          S0.causes = S0.causes || {};
          S0.causes.external = num(S0.causes.external, 0) + gone;
        }
        while (arr.length > target) arr.pop();
      }
      var cut = target - dormTarget;
      var isLife = isLifeGroup(cfg, g.id);
      for (var i = 0; i < arr.length; i++) {
        if (typeof arr[i].charm !== "number") arr[i].charm = charmOf(cfg, arr[i].seq);
        if (geneticsOn(cfg) && !arr[i].genome) initGenetics(arr[i], cfg, false);
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
    if (ppl.genWeek !== wk) {
      geneticsTick(state, cfg);
      ppl.genWeek = wk;
    }
    ppl.cache = null;
  }

  /* -------------------------------------------------------------------------
     遗传层周推进：年龄、每年辐射增量、健康/痛苦、30 岁判定与回收。
     只对克隆组做逐人推进；其余组保留基因型与出生变异，但不判死。
     ------------------------------------------------------------------------- */
  function geneticsTick(state, cfg) {
    if (!geneticsOn(cfg) || !state || !state.people || !state.groups) return;
    var X = global.XuanShuGenetics;
    var G = cfg.genetics;
    var gid = G.screen.group;
    var ppl = state.people;
    var arr = (ppl.groups && ppl.groups[gid]) || [];
    var wk = Math.floor(num(state.weeks, 0));
    var S = state.genetics;
    if (!S) {
      S = state.genetics = ensureGenState();
    } else {
      var baseS = ensureGenState();
      Object.keys(baseS).forEach(function (k) {
        if (typeof S[k] === "undefined") S[k] = baseS[k];
      });
      if (!S.causes) S.causes = baseS.causes;
      if (!S.deathAges) S.deathAges = [];
    }
    S.drugWant = 0;
    S.drugBought = 0;
    S.drugFail = 0;

    var dead = [];
    var RM = global.XuanShuResearch
      ? global.XuanShuResearch.mods(state, cfg)
      : { healthBase: 0, painRelief: 0, screenMin: 0 };
    for (var i = arr.length - 1; i >= 0; i--) {
      var p = arr[i];
      p.age = num(p.age, 0) + 1 / 52.14;

      // 止痛药周期与购买（策略开关；none 为默认）
      geneticsPainkiller(p, state, cfg, wk);

      // 每年一次独立辐射增量
      var yr = Math.floor(p.age);
      if (yr > num(p.mutYear, 0)) {
        var painR = p.pk ? num(p.pk.r, 0) : 0;
        for (var yy = num(p.mutYear, 0) + 1; yy <= yr; yy++) {
          p.mutation += X.annualDelta(cfg, p.seq, yy, p.radMul, painR);
        }
        p.mutation = Math.min(G.mutation.deathAt, p.mutation);
        p.mutYear = yr;
      }

      // 口粮双轨：免费维生份额 + 个人付费补充；只吃免费会缓慢掉健康
      var freeShare = clamp(num(cfg.food && cfg.food.freeShare, 0.70), 0, 1);
      var gRatio = clamp(num(state.last && state.last.rationActual, 1), 0, 1.2);
      var freePart = Math.min(freeShare, gRatio);
      var paidPart = (1 - freeShare) * (p.foodPaid ? 1 : 0);
      p.ration = clamp(freePart + paidPart, 0, 1.2);
      var malnK = num(cfg.food && cfg.food.malnHealthPerYear, 2.5);
      var malnRec = num(cfg.food && cfg.food.malnRecoverPerYear, 0.8);
      var dtw = 1 / 52.14;
      if (p.ration < 1) {
        p.maln = Math.min(60, num(p.maln, 0) + malnK * (1 - p.ration) * dtw);
      } else {
        p.maln = Math.max(0, num(p.maln, 0) - malnRec * dtw);
      }
      // 缺药下行链：全船缺药指数越高，个体健康掉得越快（恢复更慢）
      var dsNow = clamp(num(state.health && state.health.drugShort, 0), 0, 1);
      if (dsNow > 0) {
        p.drugHurt = Math.min(40, num(p.drugHurt, 0) + 0.05 * dsNow);
      } else {
        p.drugHurt = Math.max(0, num(p.drugHurt, 0) - 0.02);
      }

      var hMul = p.pk ? X.healthFactorWithDrug(cfg, p.pk.r) : 1;
      var hurt = (p.repairHurtUntil && wk < p.repairHurtUntil)
        ? num(G.drugs.dnaRepair.healthCost, 0) : 0;
      p.health = clamp(X.healthAt(cfg, p.mutation, p.tol, p.age, hMul)
        - hurt - num(p.maln, 0) - num(p.drugHurt, 0) + num(RM.healthBase, 0), 0, 100);
      var rawPain = X.painAt(cfg, p.mutation, p.health);
      p.pain = p.pk
        ? clamp(X.painWithDrug(cfg, rawPain, p.pk.r) + num(p.pk.withdraw, 0)
          - num(RM.painRelief, 0) * num(p.pk.r, 0), 0, 100)
        : rawPain;
      // 按摩：只压一部分痛苦、持续 2 周，且不能替代止痛药的全效
      if (p.massageUntil && wk < num(p.massageUntil, -1)) {
        p.pain = clamp(num(p.pain, 0) - num(p.massageRelief, 0), 0, 100);
      }

      var cause = null;
      if (p.mutation >= G.mutation.deathAt) cause = "mutation";
      else if (p.health < G.health.deathBelow) cause = "health";
      else if (p.age >= p.lifespanGene) cause = "lifespan";
      if (cause) {
        p.deathCause = cause;
        p.deathAge = p.age;
        pushDeathAge(S, p.age);
        S.causes[cause] = num(S.causes[cause], 0) + 1;
        if (cause === "mutation") S.mutationDeaths++;
        else if (cause === "health") S.healthDeaths++;
        else S.lifespanDeaths++;
        dead.push(p);
        continue;
      }

      // 30 岁一次判定：只看健康；通过后不再有年龄淘汰
      if (!p.screened && p.age >= G.screen.age) {
        p.screened = true;
        S.screened++;
        if (num(p.health, 0) >= num(G.screen.healthMin, 42) + num(RM.screenMin, 0)) {
          p.breedPool = true;
          S.passed++;
        } else {
          S.failed++;
          S.screenDeaths = num(S.screenDeaths, 0) + 1;
          S.causes.screen = num(S.causes.screen, 0) + 1;
          p.deathCause = "screen";
          p.deathAge = p.age;
          pushDeathAge(S, p.age);
          dead.push(p);
        }
      }
    }

    if (dead.length) {
      var deadSet = {};
      dead.forEach(function (p) { deadSet[p.seq] = true; });
      for (var k = arr.length - 1; k >= 0; k--) {
        if (deadSet[arr[k].seq]) arr.splice(k, 1);
      }
      // 回收：成人 / 胎儿两档，直接进库存
      var st = state.groups && state.groups[gid];
      if (st) st.awake = Math.max(0, num(st.awake, 0) - dead.length);
      var rec = X.recycleOf(cfg, "adult");
      if (state.stocks) {
        state.stocks.metal = num(state.stocks.metal, 0) + rec.metal * dead.length;
        state.stocks.drug = num(state.stocks.drug, 0) + rec.drug * dead.length;
        state.stocks.food = num(state.stocks.food, 0) + rec.food * dead.length;
      }
    }

    S.week = wk;
    S.living = arr.length;
    S.breedPool = 0;
    S.classCounts = { ordinary: 0, rad: 0, tol: 0, both: 0 };
    S.poolCounts = { ordinary: 0, rad: 0, tol: 0, both: 0 };
    for (var m = 0; m < arr.length; m++) {
      var q = arr[m];
      var cls = q.gclass || "ordinary";
      S.classCounts[cls] = (S.classCounts[cls] || 0) + 1;
      if (q.breedPool) {
        S.breedPool++;
        S.poolCounts[cls] = (S.poolCounts[cls] || 0) + 1;
      }
    }
    if (S.screened > 0) S.passRate = S.passed / S.screened;
    S.poolShare = S.breedPool > 0 ? {
      ordinary: S.poolCounts.ordinary / S.breedPool,
      rad: S.poolCounts.rad / S.breedPool,
      tol: S.poolCounts.tol / S.breedPool,
      both: S.poolCounts.both / S.breedPool
    } : { ordinary: 0, rad: 0, tol: 0, both: 0 };

    // 克隆子代入口：繁育池配对、孕期、培养仓、15 岁判定
    breedTick(state, cfg, wk);
  }

  function geneticsPainkiller(p, state, cfg, wk) {
    var X = global.XuanShuGenetics;
    var d = cfg.genetics.drugs.painkiller;
    var S = state.genetics || (state.genetics = ensureGenState());
    var mode = S.painkiller || "need";
    if (mode === "none") {
      p.pk = null;
      return;
    }
    var urge = num(d.urgeAt, 30);
    var want = num(p.pain, 0) >= urge;
    var scale = mode === "half" ? 0.5 : 1;
    var price = num(d.price, 15) * scale;
    var needDose = !p.pk || (wk - num(p.pk.doseWeek, -999)) >= num(d.weeks, 5);

    if (want && needDose) {
      S.drugWant = num(S.drugWant, 0) + 1;
      if (num(p.wallet, 0) >= price) {
        p.wallet = num(p.wallet, 0) - price;
        p.pk = {
          doseWeek: wk,
          streak: p.pk ? num(p.pk.streak, 0) + 1 : 1,
          scale: scale,
          r: 0,
          withdraw: 0,
          withdrawUntil: 0
        };
        p.pkMiss = 0;
        S.drugBought = num(S.drugBought, 0) + 1;
      } else {
        // 买不起就是买不起：进戒断，不享受任何阶层特例
        S.drugFail = num(S.drugFail, 0) + 1;
        p.pkMiss = num(p.pkMiss, 0) + 1;
        if (p.pk) {
          p.pk.withdraw = num(d.withdrawPain, 10);
          p.pk.withdrawUntil = wk + num(d.withdrawWeeks, 2);
        }
      }
    }
    if (!p.pk) return;
    var t = wk - p.pk.doseWeek;
    p.pk.r = X.painkillerEffect(cfg, t) * p.pk.scale;
    p.pk.withdraw = (p.pk.withdrawUntil && wk < p.pk.withdrawUntil) ? num(d.withdrawPain, 10) : 0;
  }

  /* -------------------------------------------------------------------------
     克隆子代入口（v7.0）
     30 岁判定通过 → 繁育池 → 配对受孕（39 周）→ 分娩进培养仓 →
     平民身份、普通教材（教育点按 commoner 速率累计）→ 15 岁判定。
     基因走 XuanShuGenetics.inherit()：孟德尔分离 + 位点突变，不取父母平均。
     ------------------------------------------------------------------------- */
  function findPerson(state, seq) {
    var groups = state.people && state.people.groups;
    if (!groups) return null;
    var keys = Object.keys(groups);
    for (var i = 0; i < keys.length; i++) {
      var arr = groups[keys[i]] || [];
      for (var j = 0; j < arr.length; j++) if (arr[j].seq === seq) return arr[j];
    }
    return null;
  }

  function spawnBreedChild(state, cfg, father, mother, wk) {
    var B = cfg.genetics.breed;
    var gid = B.childGroup || "incubator";
    if (!state.people.groups[gid]) state.people.groups[gid] = [];
    if (!state.groups[gid]) state.groups[gid] = { awake: 0, dormant: 0 };
    var ppl = state.people;
    var p = makePerson(ppl, cfg, gid, false);
    p.age = 0;
    p.parents = [father ? father.seq : -1, mother ? mother.seq : -1];
    p.incubator = true;
    p.judged = false;
    p.edu = 0;
    p.eduSettled = 0;
    // 真正调用 inherit()：父亲/母亲的基因组做孟德尔分离 + 突变
    if (global.XuanShuGenetics && father && mother && father.genome && mother.genome) {
      var X = global.XuanShuGenetics;
      p.genome = X.inherit(cfg, father.genome, mother.genome, p.seq);
      var ph = X.phenotype(cfg, p.genome);
      p.tol = ph.tol; p.radMul = ph.radMul; p.rawR = ph.rawR;
      p.lifespanGene = ph.lifespanGene; p.mutK = ph.mutK;
      p.gclass = X.classOf(cfg, ph);
      p.mut0 = num(cfg.genetics.mutation.birthMin, 1) +
        X.h01(p.seq, 51) * (num(cfg.genetics.mutation.birthMax, 5) - num(cfg.genetics.mutation.birthMin, 1));
      p.mutation = p.mut0;
      p.health = X.healthAt(cfg, p.mutation, p.tol, 0, 1);
      p.pain = X.painAt(cfg, p.mutation, p.health);
    }
    ppl.groups[gid].push(p);
    state.groups[gid].awake = num(state.groups[gid].awake, 0) + 1;
    if (!state.bonds) state.bonds = [];
    state.bonds.push({ child: p.seq, parents: p.parents, week: wk });
    var S = state.genetics;
    if (S) S.births = num(S.births, 0) + 1;
    return p;
  }

  function breedTick(state, cfg, wk) {
    var B = cfg.genetics && cfg.genetics.breed;
    if (!B || B.enabled === false || !state.people) return;
    var S = state.genetics;
    if (!S) return;
    if (!S.pregnancies) S.pregnancies = [];
    var cloneGid = cfg.genetics.screen.group;
    var arr = (state.people.groups && state.people.groups[cloneGid]) || [];

    // 1) 孕期推进 → 分娩
    for (var i = S.pregnancies.length - 1; i >= 0; i--) {
      var pr = S.pregnancies[i];
      if (wk < num(pr.dueWeek, 0)) continue;
      S.pregnancies.splice(i, 1);
      var fa = findPerson(state, pr.f);
      var mo = findPerson(state, pr.m);
      if (!fa || !mo) { S.breedAbort = num(S.breedAbort, 0) + 1; continue; }
      var gid = B.childGroup || "incubator";
      var cap = num(B.incubatorCap, 60);
      var occ = ((state.people.groups[gid] || []).length);
      if (occ >= cap) {
        // 培养仓满：保留妊娠，四周后再试；只记一次排队
        if (!pr.queued) { S.breedQueued = num(S.breedQueued, 0) + 1; pr.queued = true; }
        pr.dueWeek = wk + 4;
        S.pregnancies.push(pr);
        continue;
      }
      spawnBreedChild(state, cfg, fa, mo, wk);
    }

    // 2) 年度配对受孕（只在年初做一次）
    if (wk > 0 && wk % Math.round(cfg.time.weeksPerYear) === 0) {
      var pool = arr.filter(function (p) {
        return p.breedPool && !p.dormant && num(p.age, 8) <= 55;
      });
      var pairs = Math.min(num(B.maxPairsPerYear, 12), Math.floor(pool.length / 2));
      var made = 0;
      for (var k = 0; k < pairs; k++) {
        var fi = (k * 2) % pool.length;
        var mi = (k * 2 + 1) % pool.length;
        if (fi === mi) continue;
        var roll = h01(wk + k * 13, 7001 + k * 31);
        if (roll >= num(B.conceptionPerYear, 0.55)) continue;
        S.pregnancies.push({
          f: pool[fi].seq, m: pool[mi].seq,
          startWeek: wk, dueWeek: wk + Math.round(num(B.pregnancyWeeks, 39))
        });
        made++;
      }
      if (made) S.pregnanciesMade = num(S.pregnanciesMade, 0) + made;
    }

    // 3) 培养仓：年龄推进、普通教材教育点、15 岁判定
    var inc = (state.people.groups && state.people.groups[B.childGroup || "incubator"]) || [];
    for (var n = inc.length - 1; n >= 0; n--) {
      var c = inc[n];
      c.age = num(c.age, 0) + 1 / 52.14;
      c.edu = num(c.edu, 0) + num(cfg.research && cfg.research.eduPerYear &&
        cfg.research.eduPerYear.commoner, 1.0) / 52.14;
      if (c.judged || c.age < num(B.screenAge, 15)) continue;
      c.judged = true;
      var RM = global.XuanShuResearch ? global.XuanShuResearch.mods(state, cfg) : null;
      var healthNeed = num(B.screenHealth, 45) + num(RM && RM.screenMin, 0);
      var pass = num(c.edu, 0) >= num(B.eduPass, 10) && num(c.health, 0) >= healthNeed;
      // 通过者按成熟分流进技术/医疗等平民编制；未通过者进勤务平民
      var target = "service";
      if (pass) {
        var shares = cfg.population.maturationShares || {};
        var roll2 = h01(c.seq, 8801);
        var acc = 0, chosen = "tech";
        ["tech", "medical", "combat", "service"].forEach(function (g2) {
          if (chosen !== "tech") return;
          acc += num(shares[g2], 0);
          if (roll2 < acc) chosen = g2;
        });
        target = chosen;
      }
      inc.splice(n, 1);
      var tg = state.people.groups[target] || (state.people.groups[target] = []);
      c.g = target;
      c.incubator = false;
      c.judgedResult = pass ? "pass" : "fail";
      c.dept = (cfg.people.groupDept && cfg.people.groupDept[target]) || c.dept;
      tg.push(c);
      if (state.groups[B.childGroup || "incubator"]) {
        state.groups[B.childGroup || "incubator"].awake =
          Math.max(0, num(state.groups[B.childGroup || "incubator"].awake, 0) - 1);
      }
      if (state.groups[target]) state.groups[target].awake = num(state.groups[target].awake, 0) + 1;
      S.judged = num(S.judged, 0) + 1;
      if (pass) S.judgedPass = num(S.judgedPass, 0) + 1;
      else S.judgedFail = num(S.judgedFail, 0) + 1;
    }
  }

  function breedSummary(state, cfg) {
    var S = state.genetics;
    if (!S) return null;
    var gid = (cfg.genetics && cfg.genetics.breed && cfg.genetics.breed.childGroup) || "incubator";
    var inc = (state.people && state.people.groups && state.people.groups[gid]) || [];
    return {
      pregnant: (S.pregnancies || []).length,
      incubator: inc.length,
      births: num(S.births, 0),
      judged: num(S.judged, 0),
      judgedPass: num(S.judgedPass, 0),
      judgedFail: num(S.judgedFail, 0),
      abort: num(S.breedAbort, 0),
      queued: num(S.breedQueued, 0),
      cap: num(cfg.genetics && cfg.genetics.breed && cfg.genetics.breed.incubatorCap, 60)
    };
  }

  function geneticsSummary(state, cfg) {
    if (!state || !state.genetics) {
      return { enabled: false };
    }
    var S = state.genetics;
    return {
      enabled: true,
      week: num(S.week, 0),
      living: num(S.living, 0),
      breedPool: num(S.breedPool, 0),
      screened: num(S.screened, 0),
      passed: num(S.passed, 0),
      failed: num(S.failed, 0),
      passRate: num(S.passRate, 0),
      mutationDeaths: num(S.mutationDeaths, 0),
      healthDeaths: num(S.healthDeaths, 0),
      lifespanDeaths: num(S.lifespanDeaths, 0),
      classCounts: S.classCounts || { ordinary: 0, rad: 0, tol: 0, both: 0 },
      poolCounts: S.poolCounts || { ordinary: 0, rad: 0, tol: 0, both: 0 },
      poolShare: S.poolShare || { ordinary: 0, rad: 0, tol: 0, both: 0 },
      painkiller: S.painkiller || "need",
      screenDeaths: num(S.screenDeaths, 0),
      externalDeaths: num(S.externalDeaths, 0),
      causes: S.causes || { mutation: 0, health: 0, lifespan: 0, screen: 0, external: 0 },
      deathAge: {
        p10: pctOf(S.deathAges, 0.10),
        p50: pctOf(S.deathAges, 0.50),
        p90: pctOf(S.deathAges, 0.90)
      },
      drugWant: num(S.drugWant, 0),
      drugBought: num(S.drugBought, 0),
      drugFail: num(S.drugFail, 0),
      drugFailShare: num(S.drugWant, 0) > 0 ? num(S.drugFail, 0) / num(S.drugWant, 0) : 0
    };
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
          age: p.age, health: p.health, pain: p.pain,
          tol: p.tol, radMul: p.radMul, lifespanGene: p.lifespanGene,
          gclass: p.gclass, screened: !!p.screened, breedPool: !!p.breedPool,
          employed: !!p.employed, job: p.job || "",
          unemployedWeeks: num(p.unemployedWeeks, 0),
          wallet: num(p.wallet, 0), ration: num(p.ration, 1), maln: num(p.maln, 0),
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
  /**
   * 情报可见率：情报为主、环境为辅，全船只有这一处口径。
   * I = 情报档位分值；E = 科技/驻军/服从/不服的归一环境值。
   * rate = floor + (1 − floor) × (intelWeight×I + envWeight×E)
   */
  function visibleRate(state, cfg, opts) {
    var V = (cfg && cfg.visibility) || {};
    var R = V.rate || {};
    var intelId = (opts && opts.intel) ||
      (state && state.player && state.player.intel) || "mid";
    var scores = R.intelScores || { low: 0.05, mid: 0.45, high: 0.95, truth: 1.0 };
    var I = scores[intelId] != null ? num(scores[intelId]) : num(scores.mid, 0.45);
    var env = intelEnv(state, cfg);
    var E = num(R.envTech, 0.30) * env.tech +
      num(R.envGarrison, 0.25) * env.garrison +
      num(R.envCompliance, 0.25) * env.compliance +
      num(R.envWill, 0.20) * (1 - env.will);
    var floor = num(V.baseEff, 0.05);
    var iw = num(R.intelWeight, 0.70);
    var ew = num(R.envWeight, 0.30);
    return clamp(floor + (1 - floor) * (iw * I + ew * E), 0.02, 0.97);
  }

  function playerView(state, cfg, opts) {
    opts = opts || {};
    var V = cfg.visibility || {};
    var lvlId = opts.intel || "mid";
    var lvl = (V.intelLevels && V.intelLevels[lvlId]) || (V.intelLevels && V.intelLevels.mid) || {
      label: "中", roomDetail: false, errorMul: 1, delayMul: 1
    };
    if (!state.people) sync(state, cfg);

    var env = intelEnv(state, cfg);
    var effBase = visibleRate(state, cfg, { intel: lvlId });
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
          // 隐藏基因（耐受/抗辐射/寿命）不上玩家视图；只给可观察的健康与痛苦
          health: p.health, pain: p.pain,
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
    // v6.66 水：供水故障扣健康（服务不足），回收故障/水质差再扣一档
    var wsvc = clamp(num(state.last && state.last.waterService, 1), 0, 1);
    var wq = clamp(num(state.last && state.last.waterQuality, 1), 0, 1);
    var wHealthPenalty = 12 * (1 - wsvc) + 6 * (1 - wq);
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
      hp: Math.round(clamp(hp + act.hp * 6 + num(p.hpMod, 0) - wHealthPenalty, 5, 100) * 10) / 10,
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
    var rm = global.XuanShuResearch ? global.XuanShuResearch.mods(state, cfg) : null;
    var relief = lifeReliefOf(state, cfg) + num(rm && rm.sleepRelief, 0);
    return Math.max(floor, lifeTierOf(cfg, tech).tier.mult - relief);
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
    // v7.0：醒态贵族硬上限（含原初体）。超出的人强制回舱，仍计入人口，只是不占醒态名额。
    var cap = num(L.awakeCap, 0);
    if (cap > 0) {
      var awake = [];
      (L.groups || []).forEach(function (gid) {
        ((state.people && state.people.groups && state.people.groups[gid]) || []).forEach(function (p) {
          if (!p.dormant) awake.push(p);
        });
      });
      if (awake.length > cap) {
        awake.sort(function (a, b) {
          return num(a.phaseYears, 0) - num(b.phaseYears, 0) || num(a.seq, 0) - num(b.seq, 0);
        });
        for (var k = 0; k < awake.length - cap; k++) {
          var q2 = awake[k];
          q2.phase = "asleep"; q2.phaseYears = 0; q2.dormant = true; q2.action = "休眠";
        }
        (L.groups || []).forEach(function (gid) {
          var a2 = 0, d2 = 0;
          ((state.people && state.people.groups && state.people.groups[gid]) || []).forEach(function (p) {
            if (p.dormant) d2++; else a2++;
          });
          var st3 = state.groups && state.groups[gid];
          if (st3) { st3.awake = a2; st3.dormant = d2; }
        });
      }
    }
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
      // 0–25 尺度：变异越高越易感；25 时抵抗归零
      var mutDeath = num(cfg.genetics && cfg.genetics.mutation.deathAt, 25);
      var resist = (ps.hp / 100) * W.hp + clamp(1 - num(p.mutation, 0) / mutDeath, 0, 1) * W.mut;
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
      // 感染死亡：不报机制，只报「体征衰竭 / 死因不明」，仍然受情报可见率控制
      if (global.XuanShuSim && global.XuanShuSim.pushCovert) {
        var dormN = 0, stageMax = 0;
        dead.forEach(function (p) {
          if (p.dormant) dormN++;
          stageMax = Math.max(stageMax, num(p.cultStage, 0));
        });
        state.cult.deathPend = num(state.cult.deathPend, 0) + dead.length;
        state.cult.deathPendDorm = num(state.cult.deathPendDorm, 0) + dormN;
        state.cult.deathPendStage = Math.max(num(state.cult.deathPendStage, 0), stageMax);
        // 每 26 周合并一次，死亡集中时提前结算，避免逐周刷屏
        if (state.weeks - num(state.cult.deathLogWk, -99) >= 26 || state.cult.deathPend >= 8) {
          var pend = state.cult.deathPend;
          state.cult.deathLogWk = state.weeks;
          global.XuanShuSim.pushCovert(state, cfg, "cultdeath:" + Math.floor(state.weeks / 4), "health", "健康",
            "体征衰竭",
            "这段时间有 " + pend + " 人因体征衰竭死亡，死因不明",
            "医疗条件与体质共同决定",
            null,
            { "人数": pend, "休眠": state.cult.deathPendDorm, "清醒": pend - state.cult.deathPendDorm, "最高阶位": state.cult.deathPendStage },
            "感染后期死亡；不向玩家暴露机制字段");
          state.cult.deathPend = 0;
          state.cult.deathPendDorm = 0;
          state.cult.deathPendStage = 0;
        }
      }
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

  /** 止痛药策略开关：none / half / full。full 为 15⭐/5 周，half 为半价半效。 */
  function setPainkiller(state, cfg, mode) {
    if (!state) return { ok: false, msg: "无状态" };
    if (["none", "half", "full"].indexOf(mode) < 0) {
      return { ok: false, msg: "模式须为 none / half / full" };
    }
    if (!state.genetics) state.genetics = {};
    state.genetics.painkiller = mode;
    return { ok: true, mode: mode, price: num(cfg.genetics.drugs.painkiller.price, 0) * (mode === "half" ? 0.5 : 1) };
  }

  /** 给单个克隆用 DNA 修复剂：640⭐、变异 −2.0、健康代价挂 26 周。 */
  function useDnaRepair(state, cfg, seq) {
    if (!geneticsOn(cfg) || !state || !state.people) return { ok: false, msg: "遗传层未开" };
    var X = global.XuanShuGenetics;
    var d = cfg.genetics.drugs.dnaRepair;
    var arr = (state.people.groups && state.people.groups[cfg.genetics.screen.group]) || [];
    var p = null;
    for (var i = 0; i < arr.length; i++) if (arr[i].seq === seq) { p = arr[i]; break; }
    if (!p) return { ok: false, msg: "没有这个克隆人" };
    if (p.repairWeek != null && num(state.weeks, 0) - p.repairWeek < d.cooldownWeeks) {
      return { ok: false, msg: "冷却中", left: d.cooldownWeeks - (num(state.weeks, 0) - p.repairWeek) };
    }
    if (num(state.coins, 0) < d.price) return { ok: false, msg: "星币不足", need: d.price };
    state.coins -= d.price;
    p.mutation = X.repairMutation(cfg, p.mutation);
    p.repairWeek = num(state.weeks, 0);
    p.repairHurtUntil = p.repairWeek + d.cooldownWeeks;
    return { ok: true, seq: p.seq, mutation: p.mutation, price: d.price };
  }

  global.XuanShuPeople = {
    version: "1.5.0",
    create: create,
    sync: sync,
    geneticsTick: geneticsTick,
    geneticsSummary: geneticsSummary,
    breedTick: breedTick,
    breedSummary: breedSummary,
    assignJobs: assignJobs,
    rationTick: rationTick,
    massageTick: massageTick,
    setPainkiller: setPainkiller,
    useDnaRepair: useDnaRepair,
    truth: truth,
    playerView: playerView,
    visibleRate: visibleRate,
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
