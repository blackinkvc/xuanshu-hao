/* =========================================================================
   玄枢号 · 遗传层（sim-genetics.js）
   -------------------------------------------------------------------------
   0–25 变异尺度。三个隐藏基因并列：
     耐受 tol          只决定同样变异值下健康掉多少（health.mutK）
     抗辐射 radMul      压低每年太空辐射增量
     寿命 lifespanGene  自然寿限
   遗传走「多基因座加性 + 孟德尔分离 + 位点突变」，不取父母平均。
   旧 0–100 口径（克隆 62、变异 85、修复 −6）不在这里出现，也不做兜底。
   ========================================================================= */
(function (global) {
  "use strict";

  var VERSION = "1.0.0";

  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function num(v, d) { return typeof v === "number" && isFinite(v) ? v : (d || 0); }

  function h32(a, b) {
    var h = (0x811c9dc5 ^ (a | 0)) | 0;
    h = Math.imul(h ^ ((b | 0) + 0x9e3779b9), 0x01000193);
    h ^= h >>> 15;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    return h >>> 0;
  }
  function h01(a, b) { return h32(a, b) / 4294967296; }

  // Box–Muller：由「个人 + 用途」得到确定性标准正态
  function normal01(seq, salt) {
    var u1 = Math.max(1e-9, h01(seq, salt));
    var u2 = h01(seq, salt + 1);
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  function gcfg(cfg) { return cfg && cfg.genetics; }
  function enabled(cfg) { var g = gcfg(cfg); return !!(g && g.enabled); }

  /* -----------------------------------------------------------------------
     基因型
     每个位点存两条等位的「索引」，索引通过 alleleValue 映射到表现型分值。
     这样突变只需要在索引上 ±1，且天然夹在合法范围内。
     ----------------------------------------------------------------------- */
  function pickIndex(freqs, r) {
    var acc = 0;
    for (var i = 0; i < freqs.length; i++) {
      acc += num(freqs[i], 0);
      if (r < acc) return i;
    }
    return freqs.length - 1;
  }

  function randomLoci(loci, freqs, seq, salt) {
    var out = [];
    for (var i = 0; i < loci; i++) {
      out.push([
        pickIndex(freqs, h01(seq, salt + i * 2)),
        pickIndex(freqs, h01(seq, salt + i * 2 + 1))
      ]);
    }
    return out;
  }

  function randomGenome(cfg, seq) {
    var g = gcfg(cfg);
    seq = seq | 0;
    return {
      seq: seq,
      tol: randomLoci(g.tolerance.loci, g.tolerance.alleleFreq, seq, 1101),
      tolArch: [
        pickIndex(g.tolerance.archaic.alleleFreq, h01(seq, 1201)),
        pickIndex(g.tolerance.archaic.alleleFreq, h01(seq, 1202))
      ],
      rad: randomLoci(g.radResist.loci, g.radResist.alleleFreq, seq, 1301),
      life: randomLoci(g.lifespan.loci, g.lifespan.alleleFreq, seq, 1401)
    };
  }

  function locusRaw(pair, values) {
    return num(values[pair[0]], 0) + num(values[pair[1]], 0);
  }

  function rawOf(pairs, values) {
    var s = 0;
    for (var i = 0; i < pairs.length; i++) s += locusRaw(pairs[i], values);
    return s;
  }

  /* 基因型 → 表现型。噪声在出生时由 seq 固定，不会每周抖动。 */
  function phenotype(cfg, genome) {
    var g = gcfg(cfg);
    var seq = num(genome.seq, 0) | 0;

    var rawT = rawOf(genome.tol, g.tolerance.alleleValue);
    var arch = (genome.tolArch[0] === 1 && genome.tolArch[1] === 1) ? g.tolerance.archaic.bonus : 0;
    var tol = clamp(
      g.tolerance.base + g.tolerance.perPoint * rawT + normal01(seq, 1501) * g.tolerance.noise + arch,
      g.tolerance.min, g.tolerance.max
    );

    var rawR = rawOf(genome.rad, g.radResist.alleleValue);
    var radMul = clamp(
      g.radResist.baseMul + g.radResist.perRaw * rawR,
      g.radResist.minMul, g.radResist.maxMul
    );

    var rawL = rawOf(genome.life, g.lifespan.alleleValue);
    var lifespanGene = clamp(
      g.lifespan.base + g.lifespan.perPoint * rawL + normal01(seq, 1601) * g.lifespan.noise,
      g.lifespan.min, g.lifespan.max
    );

    return {
      tol: tol, rawT: rawT,
      radMul: radMul, rawR: rawR,
      lifespanGene: lifespanGene, rawL: rawL,
      mutK: mutKOf(cfg, tol)
    };
  }

  /* -----------------------------------------------------------------------
     遗传：每个位点从父母各取一条；每代每位点 0.4% 概率突变一条等位。
     突变方向 ±1，夹在 [0, len-1]。不做父母平均。
     ----------------------------------------------------------------------- */
  function take(pair, r) { return pair[r < 0.5 ? 0 : 1]; }

  function mutateIndex(idx, len, seq, salt) {
    var dir = h01(seq, salt) < 0.5 ? -1 : 1;
    return clamp(idx + dir, 0, len - 1);
  }

  function inheritLoci(fLoci, mLoci, freqs, seq, salt, rate) {
    var out = [];
    for (var i = 0; i < fLoci.length; i++) {
      var a = take(fLoci[i], h01(seq, salt + i * 4));
      var b = take(mLoci[i], h01(seq, salt + i * 4 + 1));
      // 每位点/代一次突变判定，只改其中一条等位
      if (h01(seq, salt + i * 4 + 2) < num(rate, 0)) {
        if (h01(seq, salt + i * 4 + 3) < 0.5) a = mutateIndex(a, freqs.length, seq, salt + 2000 + i);
        else b = mutateIndex(b, freqs.length, seq, salt + 2100 + i);
      }
      out.push([a, b]);
    }
    return out;
  }

  function inherit(cfg, father, mother, seq) {
    var g = gcfg(cfg);
    seq = seq | 0;
    if (!father) father = randomGenome(cfg, seq ^ 0x5f5f);
    if (!mother) mother = randomGenome(cfg, seq ^ 0x7a7a);
    var rate = num(g.mutRate, 0);

    var child = {
      seq: seq,
      tol: inheritLoci(father.tol, mother.tol, g.tolerance.alleleFreq, seq, 3101, rate),
      tolArch: inheritLoci([father.tolArch], [mother.tolArch], g.tolerance.archaic.alleleFreq, seq, 3201, rate)[0],
      rad: inheritLoci(father.rad, mother.rad, g.radResist.alleleFreq, seq, 3301, rate),
      life: inheritLoci(father.life, mother.life, g.lifespan.alleleFreq, seq, 3401, rate)
    };
    return child;
  }

  /* -----------------------------------------------------------------------
     每年辐射增量：独立随机，不是定值
       Δ = radMul × max(floor, N(mean, sd)) × (1 − mutMul × painR)
     ----------------------------------------------------------------------- */
  function annualDelta(cfg, seq, year, radMul, painR) {
    var g = gcfg(cfg);
    seq = seq | 0;
    year = year | 0;
    var z = normal01(seq, 4101 + year * 131);
    var base = num(g.radiation.mean, 0) + num(g.radiation.sd, 0) * z;
    base = Math.max(num(g.radiation.floor, 0), base);
    var d = num(radMul, 1) * base;
    if (painR > 0) d *= (1 - num(g.drugs.painkiller.mutMul, 0) * painR);
    return d;
  }

  /* -----------------------------------------------------------------------
     健康 / 痛苦
     ----------------------------------------------------------------------- */
  function mutKOf(cfg, tol) {
    var h = gcfg(cfg).health;
    return clamp(h.mutKBase + h.mutKPerTol * num(tol, 0), h.mutKMin, h.mutKMax);
  }

  function healthAt(cfg, mut, tol, age, healthAgeMul) {
    var h = gcfg(cfg).health;
    var mk = mutKOf(cfg, tol);
    var lossMut = h.mutK * mk * Math.max(0, num(mut, 0) - h.mutOnset);
    var am = (typeof healthAgeMul === "number" && isFinite(healthAgeMul)) ? healthAgeMul : 1;
    var lossAge = h.ageK * Math.max(0, num(age, 0) - h.ageOnset) * am;
    return clamp(h.base - lossMut - lossAge, 0, 100);
  }

  function painAt(cfg, mut, health) {
    var p = gcfg(cfg).pain;
    var v = p.mutK * Math.max(0, num(mut, 0) - p.mutOnset)
          + p.hpK * Math.max(0, p.hpOnset - num(health, 0));
    return clamp(v, p.min, p.max);
  }

  /* -----------------------------------------------------------------------
     止痛药周期：起效—持续—衰减
     返回 0–1 的效果系数；多剂重叠取最大值，不相加。
     ----------------------------------------------------------------------- */
  // DNA 修复剂：即时压变异，健康代价在 people 层挂 26 周
  function repairMutation(cfg, mut) {
    var d = gcfg(cfg).drugs.dnaRepair;
    return Math.max(0, num(mut, 0) - num(d.mutRelief, 0));
  }

  function painkillerEffect(cfg, weekSinceDose) {
    var d = gcfg(cfg).drugs.painkiller;
    var t = Math.floor(num(weekSinceDose, -1));
    if (t < 0) return 0;
    if (t < d.onset) return 0.5;
    if (t < d.onset + d.full) return 1;
    if (t < d.onset + d.full + d.decay) {
      var k = t - (d.onset + d.full);
      return k === 0 ? 0.66 : 0.33;
    }
    return 0;
  }

  function painkillerAvg(cfg) {
    var d = gcfg(cfg).drugs.painkiller;
    var sum = 0.5 * d.onset + 1 * d.full;
    for (var k = 0; k < d.decay; k++) sum += (k === 0 ? 0.66 : 0.33);
    return sum / Math.max(1, d.weeks);
  }

  function painWithDrug(cfg, pain, r) {
    var d = gcfg(cfg).drugs.painkiller;
    return Math.max(0, num(pain, 0) - d.painRelief * num(r, 0));
  }
  function mutFactorWithDrug(cfg, r) {
    var d = gcfg(cfg).drugs.painkiller;
    return 1 - d.mutMul * num(r, 0);
  }
  function healthFactorWithDrug(cfg, r) {
    var d = gcfg(cfg).drugs.painkiller;
    return 1 - d.healthMul * num(r, 0);
  }

  /* -----------------------------------------------------------------------
     30 岁判定 / 回收 / 分类
     ----------------------------------------------------------------------- */
  function screen30(cfg, health) {
    var s = gcfg(cfg).screen;
    return num(health, 0) >= s.healthMin;
  }

  function recycleOf(cfg, kind) {
    var s = gcfg(cfg).screen;
    var src = kind === "fetus" ? s.fetusRecycle : s.recycle;
    return { metal: num(src.metal, 0), drug: num(src.drug, 0), food: num(src.food, 0) };
  }

  // 统计标签：抗辐射 / 高耐受 / 两者 / 普通
  function classOf(cfg, pheno) {
    var g = gcfg(cfg);
    var rad = pheno.rawR >= g.radResist.highRaw;
    var tol = pheno.tol >= g.screen.highTol;
    if (rad && tol) return "both";
    if (rad) return "rad";
    if (tol) return "tol";
    return "ordinary";
  }

  /* -----------------------------------------------------------------------
     样例/冒烟复算：给定固定档案，算 15/30/45/60 与死亡点
     profile = { mut0, radMul, tol, lifespanGene }
     mode = "none" | "half" | "full"
     ----------------------------------------------------------------------- */
  function project(cfg, profile, mode, ages) {
    var g = gcfg(cfg);
    var r = 0;
    if (mode === "full") r = painkillerAvg(cfg);
    else if (mode === "half") r = painkillerAvg(cfg) / 2;
    var mutFac = mutFactorWithDrug(cfg, r);
    var ageFac = healthFactorWithDrug(cfg, r);
    var relief = g.drugs.painkiller.painRelief * r;
    var rate = num(g.radiation.mean, 0) * num(profile.radMul, 1) * mutFac;

    function at(age) {
      var mut = num(profile.mut0, 0) + rate * age;
      var hp = healthAt(cfg, mut, profile.tol, age, ageFac);
      var pain = Math.max(0, painAt(cfg, mut, hp) - relief);
      return { age: age, mut: mut, health: hp, pain: pain };
    }

    var rows = [];
    (ages || [15, 30, 45, 60]).forEach(function (a) { rows.push(at(a)); });

    var death = null;
    var life = num(profile.lifespanGene, 300);
    for (var a = 0; a <= life; a += 0.1) {
      var mut = num(profile.mut0, 0) + rate * a;
      var hp = healthAt(cfg, mut, profile.tol, a, ageFac);
      var cause = null;
      if (mut >= g.mutation.deathAt) cause = "mutation";
      else if (hp < g.health.deathBelow) cause = "health";
      else if (a >= life) cause = "lifespan";
      if (cause) {
        death = {
          age: a, mut: mut, health: hp,
          pain: Math.max(0, painAt(cfg, mut, hp) - relief),
          cause: cause
        };
        break;
      }
    }
    return { rows: rows, death: death, avgR: r, mutFac: mutFac, ageFac: ageFac };
  }

  global.XuanShuGenetics = {
    VERSION: VERSION,
    enabled: enabled,
    h01: h01,
    normal01: normal01,
    randomGenome: randomGenome,
    phenotype: phenotype,
    inherit: inherit,
    annualDelta: annualDelta,
    mutKOf: mutKOf,
    healthAt: healthAt,
    painAt: painAt,
    repairMutation: repairMutation,
    painkillerEffect: painkillerEffect,
    painkillerAvg: painkillerAvg,
    painWithDrug: painWithDrug,
    mutFactorWithDrug: mutFactorWithDrug,
    healthFactorWithDrug: healthFactorWithDrug,
    screen30: screen30,
    recycleOf: recycleOf,
    classOf: classOf,
    project: project
  };
})(typeof window !== "undefined" ? window : globalThis);
