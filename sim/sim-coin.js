/* ==========================================================================
   星币：船内货币系统（v1，见《星币_住宅仓库_洁净度_生育激励_合成设计_v1》§1）

   账户口径
   - 个人余额记在 society.queues[].coin，队列 n 是该层醒态人头（连续值）。
   - state.coins 仍是船方账户（拆解回收建仓在用）；消费税/站务费进这里，
     未定补贴从这里出，差额才是净销毁。
   - 星币只在船内结算：本模块不接 trade/encounter 的对外交易。

   每月结算（52 周切成 12 个结算点）
   工资 → 基本篮子（副食/娱乐/清洁/零星）→ 10% 消费税 → 2% 站务费
   → L4 持有上限 500 + 超限收缴 20% → 未定补贴。

   读数与后果
   - brief() 给余额分位、加权 Gini、买不起各项人数。
   - foodPoor → 下调 nutrition.protein/vit/micro，并重算 imm/fit；
   - drugPoor → medMul，由 sim-core 乘到 medCoverage；
   - funPoor  → 由 sim-core 扣 orderEq。
   ========================================================================== */
(function (global) {
  "use strict";

  // 52 周按 12 个月切：第 4/9/13/17/22/26/30/35/39/43/48/52 周结算
  var SETTLE_WEEKS = { 4: 1, 9: 1, 13: 1, 17: 1, 22: 1, 26: 1, 30: 1, 35: 1, 39: 1, 43: 1, 48: 1, 52: 1 };

  function num(v, d) {
    v = Number(v);
    return isFinite(v) ? v : (d || 0);
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function round(v, d) {
    var k = Math.pow(10, d || 0);
    return Math.round(v * k) / k;
  }
  function cfgOf(cfg) { return (cfg && cfg.coin) || {}; }
  function initPer(cfg) { return num(cfgOf(cfg).initPerAwake, 60); }
  function taxTiers(C) { return (C && C.tax) || {}; }
  function tierRate(list, idx, fallback) {
    if (!Array.isArray(list) || !list.length) return num(fallback, 0);
    return num(list[clamp(Math.round(num(idx, 0)), 0, list.length - 1)], fallback);
  }
  /** 当前档位（索引）：缺字段按配置默认值补齐，索引越界夹回范围。 */
  function taxState(state, cfg) {
    var C = cfgOf(cfg), T = taxTiers(C);
    var c = state && state.coin;
    if (!c) return { consume: 0, service: 0 };
    if (!c.tax || typeof c.tax !== "object") c.tax = {};
    var cl = Array.isArray(T.consumeRates) ? T.consumeRates : [];
    var sl = Array.isArray(T.serviceRates) ? T.serviceRates : [];
    var ci = c.tax.consume, si = c.tax.service;
    if (typeof ci !== "number" || !isFinite(ci)) ci = num(T.defaultConsume, Math.max(0, cl.length - 2));
    if (typeof si !== "number" || !isFinite(si)) si = num(T.defaultService, Math.max(0, sl.length - 2));
    c.tax.consume = clamp(Math.round(ci), 0, Math.max(0, cl.length - 1));
    c.tax.service = clamp(Math.round(si), 0, Math.max(0, sl.length - 1));
    return c.tax;
  }

  function blankEffects() {
    return {
      week: -1, totalN: 0,
      foodPoorN: 0, funPoorN: 0, cleanPoorN: 0, drugPoorN: 0,
      foodPoor: 0, funPoor: 0, cleanPoor: 0, drugPoor: 0, medMul: 1
    };
  }
  function blankFlow() {
    return {
      week: 0, wage: 0, consume: 0, tax: 0, wealthTax: 0,
      subsidy: 0, subsidyUnpaid: 0, confiscate: 0, destroyed: 0, net: 0
    };
  }
  function copyFlow(f) {
    return {
      week: num(f.week, 0), wage: round(num(f.wage, 0), 0), consume: round(num(f.consume, 0), 0),
      tax: round(num(f.tax, 0), 0), wealthTax: round(num(f.wealthTax, 0), 0),
      subsidy: round(num(f.subsidy, 0), 0), subsidyUnpaid: round(num(f.subsidyUnpaid, 0), 0),
      confiscate: round(num(f.confiscate, 0), 0), destroyed: round(num(f.destroyed, 0), 0),
      net: round(num(f.net, 0), 0)
    };
  }

  /** 身份分档：决定开局余额与报告口径。 */
  function tierOf(q) {
    if (q.kind === "L1") return "L1";
    if (q.kind === "L2") return "L2";
    if (q.id === "L4_und") return "undecided";
    if (q.kind === "L4clone" || q.id === "L4_clone") return "clone";
    if (q.layer === "L3") {
      return (q.dept === "技术" || q.dept === "医疗" || q.dept === "指挥" || q.dept === "农环") ? "L3" : "L3low";
    }
    if (q.layer === "L4") {
      return (q.dept === "技术" || q.dept === "医疗") ? "L4" : "L4low";
    }
    return "other";
  }

  /** 开局余额 = 该档月收入 × 折算月数；未定按补贴月数折算。 */
  function initialPerByTier(tier, C) {
    var W = C.wages || {}, M = C.initialMonths || {};
    var base = {
      L1: num(W.L1, 300), L2: num(W.L2, 180),
      L3: num(W.L3, 110), L3low: num(W.L3low, 100),
      L4: num(W.L4, 55), L4low: num(W.L4low, 50),
      clone: num(W.clone, 25), undecided: num(C.undecidedSubsidy, 10)
    };
    var months = {
      L1: num(M.L1, 6), L2: num(M.L2, 6),
      L3: num(M.L3, 4), L3low: num(M.L3low, 3),
      L4: num(M.L4, 2), L4low: num(M.L4low, 2),
      clone: num(M.clone, 2), undecided: num(M.undecided, 4)
    };
    if (tier === "other") return num(C.initPerAwake, 60);
    return num(base[tier], 0) * num(months[tier], 0);
  }

  function dormantNobleAccount(state, cfg, C) {
    var g = state.groups && state.groups.noble;
    var n = g ? Math.max(0, num(g.dormant, 0)) : 0;
    var months = num((C.initialMonths || {}).dormantNoble, 1);
    var per = num((C.wages || {}).L2, 180) * months;
    return { n: n, per: per, coin: n * per };
  }

  /** 旧档/回滚后补字段；缺 q.coin 的队列按分档余额补发一次。 */
  function ensure(state, cfg) {
    if (!state) return null;
    if (!state.coin) {
      state.coin = {
        flow: blankFlow(), effects: blankEffects(), last: null,
        purchases: { side: 0, fun: 0, drug: 0 }, settlements: 0, issued: 0, taxPool: 0
      };
    }
    var c = state.coin;
    if (!c.flow) c.flow = blankFlow();
    if (!c.effects) c.effects = blankEffects();
    if (!c.purchases) c.purchases = { side: 0, fun: 0, drug: 0 };
    if (typeof c.settlements !== "number") c.settlements = 0;
    if (typeof c.issued !== "number") c.issued = 0;
    if (typeof c.taxPool !== "number" || !isFinite(c.taxPool)) c.taxPool = 0;

    var C = cfgOf(cfg);
    taxState(state, cfg);
    var qs = state.society && state.society.queues;
    if (!qs || !qs.length) return c;
    var missing = false;
    qs.forEach(function (q) {
      if (typeof q.coin !== "number" || !isFinite(q.coin)) missing = true;
    });
    if (missing) {
      qs.forEach(function (q) {
        if (typeof q.coin !== "number" || !isFinite(q.coin)) {
          var tier = q.coinTier || tierOf(q);
          q.coinTier = tier;
          q.coin = Math.max(0, num(q.n, 0)) * initialPerByTier(tier, C);
          c.issued += q.coin;
        }
      });
    }
    if (!c.dormantNoble) {
      c.dormantNoble = dormantNobleAccount(state, cfg, C);
      c.issued += c.dormantNoble.coin;
    }
    return c;
  }

  /** 新一轮/新局：按身份分档重新发行，个人余额归零重来。 */
  function create(state, cfg) {
    var C = cfgOf(cfg);
    var c = ensure(state, cfg);
    var qs = state.society && state.society.queues;
    c.issued = 0;
    if (qs && qs.length) {
      qs.forEach(function (q) {
        var n = Math.max(0, num(q.n, 0));
        var tier = tierOf(q);
        q.coinTier = tier;
        q.coin = n * initialPerByTier(tier, C);
        c.issued += q.coin;
        q.coinStats = null;
        q.drugBoughtMonth = 0;
        q.funBoughtMonth = 0;
        q.sideBoughtMonth = 0;
        q.hoardShares = 0;
      });
    }
    c.dormantNoble = dormantNobleAccount(state, cfg, C);
    c.issued += c.dormantNoble.coin;
    c.flow = blankFlow();
    c.effects = blankEffects();
    c.last = null;
    c.settlements = 0;
    c.purchases = { side: 0, fun: 0, drug: 0 };
    c.taxPool = 0;
    return c;
  }

  /** 月薪基准（⭐/月）。L1/L2 为定额；L3/L4 还要乘出勤与秩序。 */
  function wageOf(q, C) {
    var W = C.wages || {};
    if (q.kind === "L1") return num(W.L1, 300);
    if (q.kind === "L2") return num(W.L2, 180);
    if (q.id === "L4_und") return 0;               // 未定走补贴，不走工资
    if (q.kind === "L4clone" || q.id === "L4_clone") return num(W.clone, 25);
    if (q.layer === "L3") {
      var hi3 = (q.dept === "技术" || q.dept === "医疗" || q.dept === "指挥" || q.dept === "农环");
      return hi3 ? num(W.L3, 110) : num(W.L3low, 100);
    }
    if (q.layer === "L4") {
      var hi4 = (q.dept === "技术" || q.dept === "医疗");
      return hi4 ? num(W.L4, 55) : num(W.L4low, 50);
    }
    return 0;
  }

  /** 出勤系数：按 state.last.action 的醒态人头加权（休眠不计）。
      未定人口不领工资、也不该拉低在职者的出勤均值，先从“休整”里扣掉。 */
  function attendanceOf(act, C, undN) {
    var A = C.attendance || {};
    if (!act || !act.mix) return 1;
    var sum = 0, den = 0, remUnd = Math.max(0, num(undN, 0));
    Object.keys(act.mix).forEach(function (k) {
      if (k === "休眠") return;
      var n = num(act.mix[k] && act.mix[k].n, 0);
      if (k === "休整" && remUnd > 0) {
        var cut = Math.min(n, remUnd);
        n -= cut;
        remUnd -= cut;
      }
      var f = (typeof A[k] === "number") ? A[k] : 1;
      sum += n * f;
      den += n;
    });
    return den > 0 ? sum / den : 1;
  }

  /** 每周：把上次月结的缺口反映到既有状态量（营养三维 + 免疫/体能）。 */
  function applyWeekly(state, cfg, c) {
    var e = c && c.effects;
    if (!e) return;
    var nu = state.nutrition;
    if (!nu) return;
    var fp = clamp(num(e.foodPoor, 0), 0, 1);
    if (fp <= 0) return;
    var K = num(cfgOf(cfg).foodPoorK, 0.25);
    nu.protein = clamp(num(nu.protein, 1) - K * fp, 0, 1.2);
    nu.vit = clamp(num(nu.vit, 1) - K * 0.8 * fp, 0, 1.2);
    nu.micro = clamp(num(nu.micro, 1) - K * 0.6 * fp, 0, 1.2);
    nu.imm = clamp(0.50 + 0.50 * Math.min(nu.vit, nu.micro) -
      0.40 * Math.max(0, 0.80 - nu.protein), 0, 1.6);
    nu.fit = clamp(0.70 + 0.30 * nu.protein - 0.20 * (1 - nu.micro), 0.5, 1);
  }

  function settle(state, cfg, ctx) {
    var C = cfgOf(cfg);
    var c = ensure(state, cfg);
    var qs = state.society && state.society.queues;
    if (!qs || !qs.length) return;

    var tx = taxState(state, cfg);
    var T = taxTiers(C);
    var consumeRate = tierRate(T.consumeRates, tx.consume, 0.10);
    var serviceRate = tierRate(T.serviceRates, tx.service, 0.02);

    var orderF = clamp(0.5 + 0.5 * clamp(num(state.order, 0.5), 0, 1), num(C.orderFloor, 0.5), 1);
    var undN = 0;
    (state.society.queues || []).forEach(function (q) { if (q.id === "L4_und") undN += Math.max(0, num(q.n, 0)); });
    var attend = attendanceOf(ctx && ctx.act, C, undN);
    var prices = C.prices || {};
    var basket = C.basket || {};
    var sideCost = num(basket.sideShares, 10) * num(prices.side, 2);
    var funCost = num(basket.funSessions, 1) * num(prices.fun, 8);
    var cleanCost = num(basket.clean, 4);
    var miscCost = num(basket.misc, 6);
    var drugPrice = num(prices.drug, 30);

    var flow = blankFlow();
    flow.week = state.weeks | 0;
    // 税池独立于 state.coins（拆解回收建仓的船方账户），避免星币税收淹没既有拆解经济
    var taxPool = Math.max(0, num(c.taxPool, 0));
    var agg = { totalN: 0, foodPoorN: 0, funPoorN: 0, cleanPoorN: 0, drugPoorN: 0 };

    qs.forEach(function (q) {
      var n = Math.max(0, num(q.n, 0));
      q.coin = Math.max(0, num(q.coin, 0));
      if (n <= 0) {
        q.coinStats = {
          n: 0, coin: q.coin, per: 0, wage: 0, basket: 0, tax: 0,
          poorFood: 0, poorFun: 0, poorClean: 0, poorDrug: 0
        };
        return;
      }

      var wagePer = wageOf(q, C);
      if (q.layer !== "L1" && q.layer !== "L2") wagePer *= attend * orderF;
      var wage = wagePer * n;
      q.coin += wage;
      flow.wage += wage;

      // 基本篮子：按优先级逐项买，买不起的项记缺口，后面各项一并归零
      var per = q.coin / n;
      var spend = 0, sideSpend = 0, funSpend = 0;
      var poor = { side: 0, fun: 0, clean: 0, misc: 0 };
      var items = [
        { key: "side", cost: sideCost },
        { key: "fun", cost: funCost },
        { key: "clean", cost: cleanCost },
        { key: "misc", cost: miscCost }
      ];
      items.forEach(function (it) {
        if (per >= it.cost) {
          var s = n * it.cost;
          q.coin -= s;
          per -= it.cost;
          spend += s;
          if (it.key === "side") sideSpend += s;
          if (it.key === "fun") funSpend += s;
        } else {
          poor[it.key] = clamp(n * (1 - per / Math.max(0.0001, it.cost)), 0, n);
          var s2 = n * Math.max(0, per);
          q.coin -= s2;
          spend += s2;
          if (it.key === "side") sideSpend += s2;
          if (it.key === "fun") funSpend += s2;
          per = 0;
        }
      });
      flow.consume += spend;

      // 消费税（只对副食+娱乐）与站务费（按余额），都进船方账户
      var ct = clamp((sideSpend + funSpend) * consumeRate, 0, q.coin);
      q.coin -= ct;
      taxPool += ct;
      flow.tax += ct;
      var wt = clamp(q.coin * serviceRate, 0, q.coin);
      q.coin -= wt;
      taxPool += wt;
      flow.wealthTax += wt;

      // L4 持有上限：超限部分每月收缴，防止奴隶层无界攒钱
      if (q.layer === "L4" && num(C.l4HoldCap, 500) > 0) {
        var capT = num(C.l4HoldCap, 500) * n;
        if (q.coin > capT) {
          var take = (q.coin - capT) * clamp(num(C.l4ExcessTake, 0.20), 0, 1);
          q.coin -= take;
          taxPool += take;
          flow.confiscate += take;
        }
      }

      // 未定补贴：船方出钱；不够就按比例少发
      if (q.id === "L4_und") {
        var sub = n * num(C.undecidedSubsidy, 10);
        var pay = Math.min(sub, Math.max(0, taxPool));
        taxPool -= pay;
        q.coin += pay;
        flow.subsidy += pay;
        flow.subsidyUnpaid += Math.max(0, sub - pay);
      }

      // 玩家/API 额外买的药与娱乐，抵扣本月缺口
      var drugCov = Math.min(n, num(q.drugBoughtMonth, 0) * num(C.drugCover, 1));
      var funCov = Math.min(n, num(q.funBoughtMonth, 0));
      var pf = poor.side;
      var pfun = Math.max(0, poor.fun - funCov);
      var pcl = poor.clean;
      var pd = (q.coin / n < drugPrice) ? Math.max(0, n - drugCov) : 0;

      q.coinStats = {
        n: n, coin: q.coin, per: q.coin / n, wage: wage, wagePer: wagePer, basket: spend,
        tax: ct + wt, poorFood: pf, poorFun: pfun, poorClean: pcl, poorDrug: pd
      };
      agg.totalN += n;
      agg.foodPoorN += pf;
      agg.funPoorN += pfun;
      agg.cleanPoorN += pcl;
      agg.drugPoorN += pd;

      q.drugBoughtMonth = 0;
      q.funBoughtMonth = 0;
      q.sideBoughtMonth = 0;
    });

    // 税池只留一个月补贴的缓冲，超出部分销毁（设计里税本来就是货币回笼）
    var poolCap = Math.max(0, num(C.taxPoolCap, 20000));
    if (taxPool > poolCap) {
      flow.destroyed = taxPool - poolCap;
      taxPool = poolCap;
    }
    c.taxPool = taxPool;
    flow.net = flow.wage + flow.subsidy - flow.consume - flow.tax - flow.wealthTax - flow.confiscate;
    c.flow = flow;
    c.effects = {
      week: state.weeks | 0,
      totalN: agg.totalN,
      foodPoorN: agg.foodPoorN,
      funPoorN: agg.funPoorN,
      cleanPoorN: agg.cleanPoorN,
      drugPoorN: agg.drugPoorN,
      foodPoor: agg.totalN > 0 ? agg.foodPoorN / agg.totalN : 0,
      funPoor: agg.totalN > 0 ? agg.funPoorN / agg.totalN : 0,
      cleanPoor: agg.totalN > 0 ? agg.cleanPoorN / agg.totalN : 0,
      drugPoor: agg.totalN > 0 ? agg.drugPoorN / agg.totalN : 0
    };
    c.effects.medMul = clamp(1 - num(C.medPoorK, 0.15) * c.effects.drugPoor, 0.85, 1);
    c.last = { week: state.weeks | 0, flow: copyFlow(flow), effects: c.effects };
    c.settlements++;
  }

  /** 每周入口：先施加既有缺口，再判断是否跨月结算。 */
  function tick(state, cfg, ctx) {
    if (!cfg || !cfg.coin || cfg.coin.enabled === false) return;
    var c = ensure(state, cfg);
    applyWeekly(state, cfg, c);
    var wk = (state.weeks | 0) + 1;
    var w = wk % 52;
    if (w === 0) w = 52;
    if (SETTLE_WEEKS[w]) settle(state, cfg, ctx);
  }

  /** 额外购买：副食/娱乐/药剂。药剂按设计 1:1 从 stocks.drug 扣。 */
  function buy(state, cfg, payload) {
    if (!cfg || !cfg.coin || cfg.coin.enabled === false) return { ok: false, msg: "星币系统已关闭" };
    var C = cfgOf(cfg);
    var c = ensure(state, cfg);
    var p = payload || {};
    var item = String(p.item || "");
    var qty = num(p.qty, 1);
    if (!p.qid || !item || qty <= 0) return { ok: false, msg: "参数不完整" };
    var qs = (state.society && state.society.queues) || [];
    var q = null;
    for (var i = 0; i < qs.length; i++) if (qs[i].id === p.qid) { q = qs[i]; break; }
    if (!q) return { ok: false, msg: "没有这个队列：" + p.qid };
    var prices = C.prices || {};
    if (typeof prices[item] !== "number") return { ok: false, msg: "未定价商品：" + item };
    var unit = prices[item];
    var cost = qty * unit;
    q.coin = Math.max(0, num(q.coin, 0));
    if (q.coin < cost) return { ok: false, msg: "星币不足", need: cost, balance: q.coin };

    var n = Math.max(0, num(q.n, 0));
    if (item === "side") {
      var noble = q.layer === "L1" || q.layer === "L2";
      if (!noble) {
        var cap = num(C.sideCapSlave, 30) * n;
        var got = num(q.sideBoughtMonth, 0);
        if (got + qty > cap + 1e-6) {
          return { ok: false, msg: "配给副食超过每人 " + num(C.sideCapSlave, 30) + " 份/月上限", cap: cap, used: got };
        }
        q.sideBoughtMonth = got + qty;
      } else {
        q.hoardShares = num(q.hoardShares, 0) + qty;
      }
    }
    if (item === "drug") {
      var stock = num(state.stocks && state.stocks.drug, 0);
      if (stock < qty) return { ok: false, msg: "药剂库存不足", stock: stock, need: qty };
      state.stocks.drug = stock - qty;
      q.drugBoughtMonth = num(q.drugBoughtMonth, 0) + qty;
    }
    if (item === "fun") q.funBoughtMonth = num(q.funBoughtMonth, 0) + qty;

    q.coin -= cost;
    c.purchases[item] = num(c.purchases[item], 0) + cost;
    return { ok: true, msg: "已购买", qid: q.id, item: item, qty: qty, unit: unit, cost: cost, balance: q.coin };
  }

  /** 加权分位与 Gini（w = 人头，x = 人均余额）。 */
  function distOf(rows) {
    var list = rows.slice().sort(function (a, b) { return a.per - b.per; });
    var totalN = 0, totalCoin = 0;
    list.forEach(function (r) { totalN += r.n; totalCoin += r.coin; });
    var mean = totalN > 0 ? totalCoin / totalN : 0;
    function pct(p) {
      if (!list.length || totalN <= 0) return 0;
      var target = clamp(p, 0, 1) * totalN, cum = 0;
      for (var i = 0; i < list.length; i++) {
        cum += list[i].n;
        if (cum >= target) return round(list[i].per, 2);
      }
      return round(list[list.length - 1].per, 2);
    }
    var gini = 0;
    if (totalN > 0 && mean > 0) {
      var sum = 0;
      for (var i = 0; i < list.length; i++) {
        for (var j = 0; j < list.length; j++) {
          sum += list[i].n * list[j].n * Math.abs(list[i].per - list[j].per);
        }
      }
      gini = sum / (2 * totalN * totalN * mean);
    }
    return {
      totalN: round(totalN, 1), totalCoin: round(totalCoin, 0), mean: round(mean, 2),
      median: pct(0.5), p10: pct(0.1), p25: pct(0.25), p75: pct(0.75), p90: pct(0.9),
      min: list.length ? round(list[0].per, 2) : 0,
      max: list.length ? round(list[list.length - 1].per, 2) : 0,
      gini: round(gini, 3), rows: list
    };
  }

  /** 粗略贫困率估计：按人均工资（未定含补贴）扣掉该档税率后的可支配额，
      对 38⭐ 基本篮子的覆盖程度做线性折算——只用于界面显示方向，不参与结算。 */
  function povertyEstimate(state, cfg, choice) {
    var C = cfgOf(cfg), T = taxTiers(C);
    var t = taxState(state, cfg);
    var qs = (state.society && state.society.queues) || [];
    var basket = C.basket || {}, prices = C.prices || {};
    var sideCost = num(basket.sideShares, 10) * num(prices.side, 2);
    var funCost = num(basket.funSessions, 1) * num(prices.fun, 8);
    var basketCost = sideCost + funCost + num(basket.clean, 4) + num(basket.misc, 6);
    var cRate = tierRate(T.consumeRates, (choice && choice.consume != null) ? choice.consume : t.consume, 0.10);
    var sRate = tierRate(T.serviceRates, (choice && choice.service != null) ? choice.service : t.service, 0.02);
    var totalN = 0, poorN = 0;
    qs.forEach(function (q) {
      var n = Math.max(0, num(q.n, 0));
      if (n <= 0) return;
      var wage = num(wageOf(q, C), 0);
      if (q.id === "L4_und") wage += num(C.undecidedSubsidy, 10);
      // 可用额 = 月工资/补贴 + 上期结余人均（与实际结算口径一致，结余会被站务费削掉）
      var per = q.coinStats ? Math.max(0, num(q.coinStats.per, 0)) : Math.max(0, num(q.coin, 0) / n);
      var avail = wage + per;
      var consumeBase = Math.min(sideCost + funCost, Math.max(0, avail));
      var net = avail - consumeBase * cRate - Math.max(0, avail - basketCost) * sRate;
      var share = clamp((basketCost - net) / basketCost, 0, 1);
      poorN += n * share;
      totalN += n;
    });
    return totalN > 0 ? round(poorN / totalN * 100, 1) : 0;
  }

  /** 税率面板数据：当前档位 + 每档对应的粗略贫困率，供右栏/设置面板。 */
  function taxView(state, cfg) {
    var C = cfgOf(cfg), T = taxTiers(C);
    var c = ensure(state, cfg);
    var t = taxState(state, cfg);
    var cl = (Array.isArray(T.consumeRates) && T.consumeRates.length) ? T.consumeRates : [0.10];
    var sl = (Array.isArray(T.serviceRates) && T.serviceRates.length) ? T.serviceRates : [0.02];
    function label(r) { return Math.round(num(r) * 100) + "%"; }
    var consumeOpts = cl.map(function (r, i) {
      return {
        level: i, rate: num(r), label: label(r),
        povertyPct: povertyEstimate(state, cfg, { consume: i, service: t.service })
      };
    });
    var serviceOpts = sl.map(function (r, i) {
      return {
        level: i, rate: num(r), label: label(r),
        povertyPct: povertyEstimate(state, cfg, { consume: t.consume, service: i })
      };
    });
    var e = c.effects || blankEffects();
    var basket = C.basket || {}, prices = C.prices || {};
    var basketCost = num(basket.sideShares, 10) * num(prices.side, 2)
      + num(basket.funSessions, 1) * num(prices.fun, 8)
      + num(basket.clean, 4) + num(basket.misc, 6);
    return {
      consume: {
        level: t.consume, rate: num(cl[t.consume]), label: label(cl[t.consume]),
        options: consumeOpts
      },
      service: {
        level: t.service, rate: num(sl[t.service]), label: label(sl[t.service]),
        options: serviceOpts
      },
      povertyNowPct: consumeOpts[t.consume] ? consumeOpts[t.consume].povertyPct : null,
      poorFoodPct: round(num(e.foodPoor, 0) * 100, 1),
      poorFunPct: round(num(e.funPoor, 0) * 100, 1),
      basketCost: round(basketCost, 1),
      note: "povertyPct 为按人均工资/补贴的线性近似，仅作方向参考"
    };
  }

  /** 玩家调税：只接受档位索引，越界拒绝；下一次月结按新税率结算。 */
  function setTax(state, cfg, payload) {
    if (!cfg || !cfg.coin || cfg.coin.enabled === false) return { ok: false, msg: "星币系统已关闭" };
    var C = cfgOf(cfg), T = taxTiers(C);
    var c = ensure(state, cfg);
    var t = taxState(state, cfg);
    var cl = Array.isArray(T.consumeRates) ? T.consumeRates : [];
    var sl = Array.isArray(T.serviceRates) ? T.serviceRates : [];
    var p = payload || {};
    var ci = (p.consume === undefined || p.consume === null) ? t.consume : Math.round(num(p.consume, -1));
    var si = (p.service === undefined || p.service === null) ? t.service : Math.round(num(p.service, -1));
    if (!cl.length || !(ci >= 0 && ci < cl.length)) {
      return { ok: false, msg: "消费税档位越界（0-" + Math.max(0, cl.length - 1) + "）" };
    }
    if (!sl.length || !(si >= 0 && si < sl.length)) {
      return { ok: false, msg: "站务费档位越界（0-" + Math.max(0, sl.length - 1) + "）" };
    }
    var before = { consume: t.consume, service: t.service };
    t.consume = ci;
    t.service = si;
    c.tax = t;
    return {
      ok: true,
      msg: "税率档位已调整（下次月结生效）",
      before: before,
      after: { consume: ci, service: si },
      tax: taxView(state, cfg)
    };
  }

  /** 读数：总量、分位、加权 Gini、分档、买不起各项人数、最近月流水。 */
  function brief(state, cfg) {
    if (!state) return null;
    var C = cfgOf(cfg);
    var c = ensure(state, cfg);
    var qs = (state.society && state.society.queues) || [];
    var rows = [], awakeRows = [];
    qs.forEach(function (q) {
      var n = Math.max(0, num(q.n, 0));
      if (n <= 0) return;
      var coin = Math.max(0, num(q.coin, 0));
      var tier = q.coinTier || tierOf(q);
      var row = { qid: q.id, name: q.name, layer: q.layer, dept: q.dept, tier: tier, n: n, coin: coin, per: coin / n, dormant: false };
      rows.push(row);
      awakeRows.push(row);
    });
    // 贵族休眠是独立冻结账户：不进消费/工资，但算进初始发行与全人口分布
    var dn = c.dormantNoble || { n: 0, per: 0, coin: 0 };
    if (num(dn.n, 0) > 0) {
      rows.push({
        qid: "noble_dormant", name: "贵族休眠", layer: "L2", dept: "休眠",
        tier: "dormantNoble", n: num(dn.n, 0), coin: num(dn.coin, 0), per: num(dn.per, 0), dormant: true
      });
    }
    var all = distOf(rows);
    var awake = distOf(awakeRows);

    var layerAcc = {};
    rows.forEach(function (r) {
      var a = layerAcc[r.layer] || (layerAcc[r.layer] = { n: 0, coin: 0 });
      a.n += r.n;
      a.coin += r.coin;
    });
    var layers = {};
    Object.keys(layerAcc).forEach(function (k) {
      layers[k] = {
        n: round(layerAcc[k].n, 1),
        coin: round(layerAcc[k].coin, 0),
        per: round(layerAcc[k].coin / Math.max(1, layerAcc[k].n), 2)
      };
    });
    var tierAcc = {};
    rows.forEach(function (r) {
      var a = tierAcc[r.tier] || (tierAcc[r.tier] = { n: 0, coin: 0 });
      a.n += r.n;
      a.coin += r.coin;
    });
    var tiers = {};
    Object.keys(tierAcc).forEach(function (k) {
      tiers[k] = {
        n: round(tierAcc[k].n, 1),
        coin: round(tierAcc[k].coin, 0),
        per: round(tierAcc[k].coin / Math.max(1, tierAcc[k].n), 2),
        months: round(k === "dormantNoble" ? num((C.initialMonths || {}).dormantNoble, 1) : num((C.initialMonths || {})[k], 0), 1),
        initialPer: round(k === "dormantNoble"
          ? num((C.wages || {}).L2, 180) * num((C.initialMonths || {}).dormantNoble, 1)
          : initialPerByTier(k, C), 2)
      };
    });
    var e = c.effects || blankEffects();
    return {
      enabled: !(cfg && cfg.coin && cfg.coin.enabled === false),
      totalCoin: all.totalCoin,
      totalN: all.totalN,
      mean: all.mean,
      median: all.median, p10: all.p10, p25: all.p25, p75: all.p75, p90: all.p90,
      min: all.min, max: all.max,
      gini: all.gini,
      awake: {
        totalCoin: awake.totalCoin, totalN: awake.totalN, mean: awake.mean,
        median: awake.median, p10: awake.p10, p25: awake.p25, p75: awake.p75, p90: awake.p90,
        min: awake.min, max: awake.max, gini: awake.gini
      },
      dormantNoble: { n: round(num(dn.n, 0), 1), per: round(num(dn.per, 0), 2), coin: round(num(dn.coin, 0), 0) },
      tiers: tiers,
      issued: round(num(c.issued, 0), 0),
      treasury: round(num(c.taxPool, 0), 0),
      shipCoins: round(num(state.coins, 0), 0),
      settlements: num(c.settlements, 0),
      poor: {
        foodN: round(num(e.foodPoorN, 0), 0), foodShare: round(num(e.foodPoor, 0), 4),
        funN: round(num(e.funPoorN, 0), 0), funShare: round(num(e.funPoor, 0), 4),
        cleanN: round(num(e.cleanPoorN, 0), 0), cleanShare: round(num(e.cleanPoor, 0), 4),
        drugN: round(num(e.drugPoorN, 0), 0), drugShare: round(num(e.drugPoor, 0), 4)
      },
      medMul: round(num(e.medMul, 1), 3),
      flow: copyFlow(c.flow || blankFlow()),
      last: c.last ? { week: c.last.week, flow: copyFlow(c.last.flow), effects: c.last.effects } : null,
      purchases: { side: round(num(c.purchases.side, 0), 0), fun: round(num(c.purchases.fun, 0), 0), drug: round(num(c.purchases.drug, 0), 0) },
      layers: layers,
      tax: taxView(state, cfg),
      top: all.rows.length ? all.rows[all.rows.length - 1].qid : null,
      bottom: all.rows.length ? all.rows[0].qid : null
    };
  }

  var api = {
    create: create, ensure: ensure, tick: tick, buy: buy, brief: brief,
    setTax: setTax, taxView: taxView, _settle: settle
  };
  global.XuanShuCoin = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
