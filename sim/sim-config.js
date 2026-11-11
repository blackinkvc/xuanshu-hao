/* =========================================================================
   玄枢号 · 舰务模拟参数总表（v0.1）
   -------------------------------------------------------------------------
   所有系数集中在这里。改这里就能改模型，不需要动 sim-core.js。
   标注【档案】= 来自 10_飞船设计 / 08_文档与对账 的既有资料
   标注【推定】= 档案没有，按量级或稳定性反推，供一起校准
   ========================================================================= */
(function (global) {
  "use strict";

  var CONFIG = {
    version: "0.1.0",
    meta: {
      title: "玄枢号 · 舰务运行机制",
      subtitle: "简化模型 v0.1 · 系数待校准",
      note: "本版为简化模型，系数待校准。档案值已标注，推定值可改。"
    },

    /* ---------------- 时间与循环 ---------------- */
    time: {
      loopYears: 1000,      // 【档案】每 1000 年回滚一次
      maxLoops: 100,        // 【档案】10 万年 = 100 轮
      rollback: true,       // 【档案】full 回滚
      seriesCap: 2200
    },

    /* ---------------- 人口 ---------------- */
    population: {
      // awake/dormant 初值合计：醒态 2400，休眠 1600，在册 4000（【档案】）
      groups: [
        { id: "original",  name: "原初体",     short: "原初", awake: 12,  dormant: 14,  mortality: 0.0040, color: "#d8dde5" },
        { id: "combat",    name: "战斗编制",   short: "战斗", awake: 260, dormant: 340, mortality: 0.0120, color: "#b0605a" },
        { id: "tech",      name: "技术·情报",  short: "技术", awake: 360, dormant: 580, mortality: 0.0110, color: "#6f8fa6" },
        { id: "service",   name: "勤务·礼仪",  short: "勤务", awake: 400, dormant: 340, mortality: 0.0120, color: "#8a9a7b" },
        { id: "medical",   name: "服务·医疗",  short: "服务", awake: 212, dormant: 276, mortality: 0.0130, color: "#a68b6f" },
        { id: "noble",     name: "贵族",       short: "贵族", awake: 36,  dormant: 50,  mortality: 0.0030, color: "#c9b37a" },
        { id: "clone",     name: "变异克隆",   short: "克隆", awake: 440, dormant: 0,   mortality: 0.0833, color: "#7d728f", clone: true },
        { id: "undecided", name: "未定·未成年", short: "未定", awake: 680, dormant: 0,   mortality: 0.0220, color: "#5d6675" }
      ],
      undecidedId: "undecided",
      laborFull: 1720,          // 【档案】醒态在岗 1,720
      minAwake: 1500,           // 【推定】航行与生保最低编制
      maturationRate: 0.03,     // 【推定】360 名未成年 / 18 年
      maturationShares: { combat: 0.18, tech: 0.28, service: 0.30, medical: 0.14, undecided: 0.10 },
      birthQuota: 40            // 【推定】见文档 §11.1
    },

    /* ---------------- 粮食 ---------------- */
    food: {
      perCapitaTpy: 0.2263,     // 【档案】0.62 kg/人·日 × 365
      dormantFactor: 0.05,      // 【推定】休眠低耗
      unitYieldTpy: 2.52,       // 【推定】1 单元 = 1000 m² 等效栽培面
      hydroInit: 191,           // 【档案】191,388 m² 等效
      hydroMax: 600,
      agriMWFull: 30,           // 【档案】农环 30 MW
      planetTpy: 84,            // 【推定】补足 86% 自给之外
      waterBuffer: 600,         // 【推定】水储备低于 600 t 开始限产
      stockInit: 240,           // 【推定】约 156 天
      cap: 400                  // 【推定】粮食储备上限，约 260 天，避免无限囤积
    },

    /* ---------------- 水 ---------------- */
    water: {
      perCapitaAwake: 10.40,    // 【档案】28.5 kg/人·日
      perCapitaDormant: 0.73,   // 【推定】休眠低耗
      recycle: 0.992,           // 【档案】水闭环 99.2%
      supplyTpy: 220,           // 【推定】抵损耗
      stockInit: 2500,
      cap: 6000
    },

    /* ---------------- 休眠 ---------------- */
    hibernation: {
      podsInit: 1600,           // 【档案】1,520 + 80
      drugInit: 1800,           // 【推定】
      drugCap: 3000,
      drugPerEntry: 1,          // 【推定】
      drugPerDormantYear: 0.02, // 【推定】
      drugProdTpy: 96,          // 【推定】8 份/月
      entryPerMonth: 40,        // 【推定】速率限制
      wakePerMonth: 40,         // 【推定】速率限制
      reviveFail: 0.008,        // 【档案】复温失败率 0.8%
      dormantMortality: 0.002,  // 【推定】维护失败
      podMetal: 5,              // 【推定】t/位
      podLeadMonths: 9,         // 【推定】
      maxPodStartPerMonth: 12
    },

    /* ---------------- 克隆 ---------------- */
    clone: {
      podsInit: 96,             // 【档案】工业级 96 筒
      outputPerPodYear: 0.40,   // 【推定】96 筒 ≈ 38 具/年
      capShare: 0.18,           // 【档案】克隆人口上限 18%
      nobleShare: 0.008,        // 【推定】贵族靠克隆延续
      podMetal: 18,             // 【推定】
      podLeadMonths: 12,        // 【推定】
      maxPods: 140
    },

    /* ---------------- 金属 ---------------- */
    metal: {
      stockInit: 6000,          // 【推定】
      cap: 12000,
      supplyTpy: 750,           // 【推定】结构件原料侧保守值
      maintNeedTpy: 450,        // 【推定】默认分配 60% 正好覆盖
      hydroMetal: 24,           // 【推定】t/单元
      hydroLeadMonths: 6,       // 【推定】
      podMetal: 5,              // 【推定】t/位
      podLeadMonths: 9,         // 【推定】
      clonePodMetal: 18,        // 【推定】t/筒
      clonePodLeadMonths: 12    // 【推定】
    },

    /* ---------------- 能源 ---------------- */
    energy: {
      baseMW: 68,               // 【档案】平均 68 MW
      lifeMW: 16,               // 【档案】人居 16 MW，永远优先
      agriFullMW: 30,           // 【档案】农环 30 MW
      industryFullMW: 22        // 【档案】工业 22 MW
    },

    /* ---------------- 医疗 ---------------- */
    medical: {
      coverageBase: 0.35,
      coverageGain: 0.65
    },

    /* ---------------- 死亡 ---------------- */
    death: {
      malK: 0.30,               // 【推定】配给 0.5 → 额外 7.5%/年
      diseaseK: 0.02,           // 【推定】
      conflictK: 0.15,          // 【推定】
      accidentBase: 0.0005,     // 【推定】
      accidentWear: 0.002       // 【推定】
    },

    /* ---------------- 秩序 ---------------- */
    order: {
      init: 0.78,
      eqBase: 0.80,
      relax: 0.15,              // 约 6 年收敛
      rationK: 1.10,
      wearK: 0.10,
      extremeK: 0.08,
      deathK: 0.15,
      atrocityK: 0.05
    },

    /* ---------------- 阶段 ---------------- */
    phase: {
      // 进入阈值；退出阈值写在 sim-core 里，比进入高 15 日 / 0.03
      names: ["正常", "紧张", "短缺", "危机", "崩溃"],
      foodDays: [90, 90, 60, 30, 10],
      ration: [1.00, 0.95, 0.85, 0.70, 0.50]
    },

    /* ---------------- 事件 ---------------- */
    events: {
      cooldownMonths: 24,
      bingeMonths: 3,
      atrocityMonths: 2
    },

    /* ---------------- 输入默认值 ---------------- */
    inputs: {
      ration: 1.00,
      birthQuota: 40,
      cloneBatch: 1.00,
      dormancyTarget: 0.40,
      hydroTarget: 0,
      metalHydro: 15,
      metalPods: 20,
      metalClone: 5,
      metalMaint: 60,
      agriShare: 0.577,
      medical: 0.80,
      extreme: false,
      planetCut: false
    },

    /* ---------------- 社会层：权力、服从、哗变、感染 ---------------- */
    society: {
      enabled: true,
      awakeBase: 2400,
      // 【档案】层级比例 1 / 12 / 254 / 3,733（合计 4,000 在册）
      // 原型只模拟醒态，按 2,400 / 4,000 等比缩放到 1 / 12 / 152 / 2,235
      layersTotal: { L1: 1, L2: 12, L3: 254, L4: 3733 },
      layerNames: {
        L1: "L1 最高贵族", L2: "L2 中层贵族",
        L3: "L3 精英·技术管理", L4: "L4 奴隶与机器"
      },
      depts: ["指挥", "战斗", "技术", "勤务", "医疗", "农环"],
      baseO: { L1: 72, L2: 64, L3: 58, L4clone: 56, L4: 50 },   // 【推定】
      baseW: { slave: 20, elite: 52 },                            // 【推定】

      // 舒适度 c：配给 0.40 / 磨损 0.25 / 医疗 0.20 / 拥挤 0.15【用户定】
      // 倒 U 中心 0.82 按基线（配给 1.0、磨损 0、医疗 0.8）反推，宽度 0.20【推定】
      comfort: { wRation: 0.40, wWear: 0.25, wMed: 0.20, wCrowd: 0.15,
                 center: 0.82, width: 0.20, maxPenalty: 25 },
      will: { expK: 5.5, comfortStart: 0.75, comfortSpan: 0.35, comfortGain: 18 },
      trauma: { oK: 3.0, oCap: 18, wK: 2.5, wCap: 15, decay: 0.08 },

      // 教育迁移：40–50 年量级完成 1%【用户定】
      // 经历 3 时 p=0.0019/月 ≈ 44 年；经历 6 时 ≈ 30 年
      eduMigration: { rate: 0.0010, expK: 0.30, wGain: 12, oLoss: 6, months: 36 },

      dominion: { base: 38, ageK: 0.30, netK: 10, execK: 10, spanBase: 8, spanK: 0.42 },
      stress: { oK: 0.55, wK: 0.30, structK: 0.15, infK: 0.10,
                breakAt: 0.55, breakMonths: 2, spread: 0.20 },

      // 五级阶梯：每级进入/退出/持续
      ladder: {
        l1At: 0.45, l1Months: 2,
        l2At: 0.55, l2Months: 3, l2QueueShare: 0.15, l2Exit: 0.45, l2ExitMonths: 2,
        l3Depts: 2, l3Months: 2, l3K: 0.50, l3Exit: 3,
        l4Coverage: 0.40, l4Months: 2, l4D: 50,
        l5D: 30, l5Coverage: 0.50, l5Months: 3, l5Hold: 6,
        prodMul: [1, 0.98, 0.65, 0.40, 0.20, 0.10],
        deathPerMonth: [0, 0, 0.0015, 0.004, 0.010, 0.020],
        orderPerLevel: 0.06
      },

      // 扑灭手段：全部有成本；镇压消耗警备耐久与金属，不动战斗编制
      actions: {
        suppress: { label: "武力镇压", o: 12, oDecay: 6, w: 1.2, wMonths: 6,
                    dur: 8, metal: 6, wear: 0.05, death: 0.004, order: -0.02,
                    cd: 6, uses: [1, 0.60, 0.35], fanatic: 1,
                    note: "消耗警备耐久 8、金属 6 t，镇压机磨损；长期镇压抬高自由意志" },
        concede:  { label: "让步加配额", o: 8, w: -2, foodShare: 0.04, foodMonths: 6,
                    order: 0.02, cd: 12, uses: [1, 0.50, 0.30],
                    note: "补发 4% 口粮配额 6 个月，直接吃粮食储备" },
        execute:  { label: "处决领头", o: 18, oDecay: 3, w: 3, death: 0.002, d: -5,
                    cd: 9, uses: [1, 0.55, 0.30],
                    note: "短期服从 +18（恐惧），自由意志永久 +3，统御力 −5" },
        replace:  { label: "换掉中层", o: 5, d: -8, spread: 0.12, cd: 12, uses: [1, 0.70, 0.45],
                    note: "损失统御力积累，其他节点应力 +0.12，可能开新裂口" },
        interrogate: { label: "潜伏机审讯", o: 6, w: 2, metal: 4, dur: 2,
                    cd: 4, uses: [1, 0.80, 0.60], needInfiltrator: true,
                    note: "潜伏机混入人群审讯，不需编队出动；消耗金属 4 t 与耐久 2" },
        lockdown: { label: "封锁隔离", w: 1, dur: 2, metal: 3, prodMul: 0.85, prodMonths: 3,
                    iso: 0.25, isoMonths: 3, infSpread: 0.60, cd: 3, uses: [1, 0.80, 0.65],
                    note: "产出 −15%，感染扩散 −40%，隔离执行度 +0.25，持续 3 个月" },
        ritual:   { label: "仪式宣传", o: 6, w: -1, foodShare: 0.01, foodMonths: 1,
                    needL1: true, cd: 3, uses: [1, 0.75, 0.50],
                    note: "消耗 1% 口粮；L1 死亡后失效" }
      },

      // 机器哗变：连锁数由科技等级决定
      machine: {
        techHydro: 0.55, techClone: 0.25, techMed: 0.20,
        at: 0.65, months: 2, oLow: 45,
        secondAt: 0.72, secondMaint: 0.55, secondEnergy: 0.12,
        thirdAt: 0.80,
        maxChainBase: 1, maxChainTech: 3,   // 科技 0→1 个，满级→3 个
        firstDept: "农环",
        prodLoss: 0.15, procMonths: 3, procMul: 0.60,
        overrideMW: 5, overrideMetal: 30
      },

      // 感染：全人群累积；贵族抵抗系数低（不易感染），转化时间更长
      infection: {
        base: 0.006, ageK: 0.0018, ageCap: 25,
        lifeK: 0.0001, lifeFloor: 40,
        mutK: 0.030, isoK: 0.040, densityK: 0.020,
        medK: 0.030, execK: 0.100, cap: 0.80,
        resist: { L1: 0.35, L2: 0.45, L3: 0.70, L4n: 0.90, L4c: 1.00 },
        hearing: 30, deform: 60, thrall: 85,
        thrallMonths: { L1: 24, L2: 24, L3: 18, L4: 12 },
        convertRate: 0.0025,
        convertRateNoble: 0.0008
      },

      // 召唤：12 名 / 均值 55 / 峰值 90，连续 6 个月【用户定】
      // 产能惩罚是机械化程度的函数：机械越多，影响越小
      summon: {
        n: 12, meanC: 55, maxC: 90, months: 6, lockYears: 120,
        popLoss: 0.25, popMonths: 24, orderLoss: 0.35,
        prodMonths: 12,            // 产能惩罚持续 12 个月（此前缺失，导致 NaN 与永久惩罚）
        mechHydro: 0.40, mechClone: 0.25, mechWear: 0.20, mechMed: 0.15,
        prodBase: 0.45, prodMech: 0.55,
        laborBase: 0.70, laborExtra: 0.30,
        stressAdd: 0.25, permBase: 0.008,
        newThralls: 5, newThrallK: 0.4
      },

      // 警备：独立存量。人员自战斗编制借调（仍计入人口），另有二型机器人
      garrison: {
        initStrength: 60,          // 常备警备 60 人（约战斗编制的 23%，按舱段值守下限推定）
        initDurability: 100,
        initMetal: 180,
        secondedFromCombat: 60,    // 说明用：自战斗编制划出，指挥链独立
        suppressors: 4,            // 重型镇压机：可见、威慑
        infiltrators: 6,           // 潜伏侦察/审讯机：不直接抓捕
        robotMetalTpy: 24,         // 两型机器人维修金属（约 2 t/月）
        recoverStrength: 0.5,      // 每月补员 0.5 人（从未定抽调）
        recoverDur: 1.2,
        recoverMetal: 3,
        suppressDur: 8, suppressMetal: 6, suppressWear: 0.05,
        exposeMonths: 18,          // 潜伏机暴露的检查周期
        effectMin: 0.40
      },

      lifespan: { L1: 600, L2: 300, L3: 120, L4: 65, clone: 30 },  // 【推定】长生种
      // 手动触发参数：mutinyMonths 为余震月数，期间持续压制 O / 抬高 W
      trigger: { mutinyS: 0.62, mutinyO: 16, mutinyW: 76, mutinyMonths: 18,
                 infectC: 92, infectSpreadC: 68, infectSpreadC2: 62 }
    },

    /* ---------------- 页面滑块定义 ---------------- */
    ui: {
      sliders: [
        { key: "ration",         group: "人口与消费", label: "粮食配给比例",   min: 0.60, max: 1.20, step: 0.01, unit: "×",   digits: 2, path: "ration",   note: "直接乘口粮需求；压低能省粮，但营养与秩序会掉" },
        { key: "birthQuota",     group: "人口与消费", label: "生育配额",       min: 0,    max: 90,   step: 1,    unit: "人/年", digits: 0, path: "birth",    note: "自然出生上限，受营养、医疗、秩序折损" },
        { key: "cloneBatch",     group: "人口与消费", label: "克隆批次频率",   min: 0,    max: 2,    step: 0.05, unit: "×",   digits: 2, path: "clone",    note: "1.0 = 96 筒约 38 具/年；>1.05 会触发克隆槽扩建" },
        { key: "dormancyTarget", group: "人口与消费", label: "休眠推进力度",   min: 0,    max: 0.60, step: 0.01, unit: "占比", digits: 0, percent: true, path: "dormancy", note: "目标休眠人数占在册总数；受舱位、药剂、最低醒态限制" },

        { key: "hydroTarget",    group: "生产与资源", label: "水培扩建投入",   min: 0,    max: 30,   step: 1,    unit: "单元/年", digits: 0, path: "hydro", note: "1 单元 = 1000 m² 等效栽培面；建设有 6 个月滞后" },
        { key: "metalHydro",     group: "生产与资源", label: "金属分配 · 水培", min: 0,   max: 100,  step: 1,    unit: "%",  digits: 0, path: "metal",    note: "四份金属配额自动归一化；给水培多，维修就少" },
        { key: "metalPods",      group: "生产与资源", label: "金属分配 · 休眠舱", min: 0, max: 100,  step: 1,    unit: "%",  digits: 0, path: "metal",    note: "目标休眠超过舱位时自动开工" },
        { key: "metalClone",     group: "生产与资源", label: "金属分配 · 克隆槽", min: 0, max: 100,  step: 1,    unit: "%",  digits: 0, path: "metal",    note: "克隆批次 > 1.05 且筒数不足时自动开工" },
        { key: "metalMaint",     group: "生产与资源", label: "金属分配 · 维修", min: 0,   max: 100,  step: 1,    unit: "%",  digits: 0, path: "metal",    note: "低于 450 t/年刚需会累积磨损，压低供电与产量" },
        { key: "agriShare",      group: "生产与资源", label: "能源分配 · 农业", min: 0.30, max: 0.85, step: 0.01, unit: "占比", digits: 0, percent: true, path: "energy", note: "生保 16 MW 先扣；剩余在农业与工业之间分" },

        { key: "medical",        group: "保障与底线", label: "医疗投入",       min: 0,    max: 1,    step: 0.01, unit: "占比", digits: 0, percent: true, path: "medical", note: "影响疾病死亡、生育、克隆质量、复温失败率" },
        { key: "extreme",        group: "保障与底线", label: "允许极端措施",   min: 0,    max: 1,    step: 1,    unit: "", toggle: true, path: "extreme", note: "危机时压低死亡，但秩序长期受损；是底线事件的前提" },
        { key: "planetCut",      group: "保障与底线", label: "行星补给中断",   min: 0,    max: 1,    step: 1,    unit: "", toggle: true, path: "food", note: "情景开关：用来复现「食物减少」的起点" }
      ]
    }
  };

  global.XUANSHU_CONFIG = CONFIG;
  if (typeof module !== "undefined" && module.exports) module.exports = CONFIG;
})(typeof globalThis !== "undefined" ? globalThis : this);
