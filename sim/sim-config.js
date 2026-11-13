/* =========================================================================
   玄枢号 · 舰务模拟参数总表（v0.2 · 周为单位）
   -------------------------------------------------------------------------
   所有系数集中在这里。改这里就能改模型，不需要动 sim-core.js。
   标注【档案】= 来自 10_飞船设计 / 08_文档与对账 的既有资料
   标注【推定】= 档案没有，按量级或稳定性反推，供一起校准

   v0.2 起内部时间轴统一为「周」：
     1 年 = 52 周，1 季 = 13 周（四季等长），1 月 = 52/12 ≈ 4.3333 周
   原 v0.1 的系数都是「每月多少」，本文件逐项换算为「每周多少」，
   换算依据写在每个字段行尾；对应的对照表见《时间粒度_周换算与接口v2.md》。
     线性速率 / 流量：每周 = 每月 × 12/52
     乘性衰减（每 tick 乘一个系数）：每周 = 每月^(12/52)
     离散连续计数（连续 N 个月）：周 = round(N × 52/12)
   ========================================================================= */
(function (global) {
  "use strict";

  /* ---------------- 时间换算工具（唯一实现，避免各处各算一套） ---------------- */
  var WEEKS_PER_YEAR = 52;
  var WEEKS_PER_QUARTER = 13;
  var WEEKS_PER_MONTH = WEEKS_PER_YEAR / 12;      // 4.3333

  // 线性速率 / 流量：每月 → 每周（时间占比恒定，可直接按 12/52 缩）
  function perWeek(m) { return m * 12 / WEEKS_PER_YEAR; }
  // 乘性衰减：每 tick 乘系数 p（如 0.90/月）→ 每周 p^(12/52)
  function powWeek(p) { return Math.pow(p, 12 / WEEKS_PER_YEAR); }
  // 离散连续计数：连续 N 个月 → 整数周
  function monthsToWeeks(m) { return Math.round(m * WEEKS_PER_YEAR / 12); }

  var CONFIG = {
    version: "0.2.0",
    meta: {
      title: "玄枢号 · 舰务运行机制",
      subtitle: "简化模型 v0.2 · 周为单位 · 系数待校准",
      note: "本版为简化模型，系数待校准。档案值已标注，推定值可改。"
    },

    /* ---------------- 时间与循环 ---------------- */
    time: {
      unit: "week",              // 内部最小时间单位
      weeksPerYear: WEEKS_PER_YEAR,
      weeksPerQuarter: WEEKS_PER_QUARTER,
      weeksPerMonth: WEEKS_PER_MONTH,   // 4.3333；1 月不是整数周
      monthsPerYear: 12,
      loopYears: 1000,           // 【档案】每 1000 年回滚一次
      maxLoops: 100,             // 【档案】10 万年 = 100 轮
      rollback: true,            // 【档案】full 回滚
      seriesCap: 2200,           // 序列点上限（每年 1 点）
      eventCap: 600
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
      maturationRate: 0.03,     // 【推定】年速率，按 tick 折算
      maturationShares: { combat: 0.18, tech: 0.28, service: 0.30, medical: 0.14, undecided: 0.10 },
      birthQuota: 40            // 【推定】人/年，见文档 §11.1
    },

    /* ---------------- 粮食 ---------------- */
    food: {
      perCapitaTpy: 0.2263,     // 【档案】0.62 kg/人·日 × 365（年量，未换周）
      dormantFactor: 0.05,      // 【推定】休眠低耗
      unitYieldTpy: 2.52,       // 【推定】1 单元 = 1000 m² 等效栽培面（年量）
      hydroInit: 191,           // 【档案】191,388 m² 等效
      hydroMax: 600,
      agriMWFull: 30,           // 【档案】农环 30 MW
      planetTpy: 84,            // 【推定】补足 86% 自给之外（年量）
      waterBuffer: 600,         // 【推定】水储备低于 600 t 开始限产
      stockInit: 240,           // 【推定】约 156 天
      cap: 0,                   // v1.2：0 = 不设上限（原 400 t 天花板已拆）
      spoilagePerYear: 0.25,    // v1.2：储备年损耗（仓储霉变/虫害/品质衰减），原 0
      // v1.2：产出冗余随年份与船况衰减，在既有能源/水/人力/社会反馈系数之上
      // 再叠一层长期折损。年份+农环受 maxLoss 封顶，磨损/人口结构按当期实际值另算。
      decay: {
        yearRate: 0.000042,     // 年份线性衰减：每年折掉 0.0042% 基础产能
        ringK: 0.074,           // 农环老化：到 ringYears 时累计折损 7.4%
        ringYears: 1500,
        structK: 0.18,          // 人口结构：在岗不足 laborFull 的部分 × 0.18
        wearK: 0.35,            // 船况磨损：wear=1 时折损 35%
        maxLoss: 0.12           // 年份+农环的基础折损上限；磨损/人口结构另行叠加
      }
    },

    /* ---------------- 水 ---------------- */
    water: {
      perCapitaAwake: 10.40,    // 【档案】28.5 kg/人·日（日量，未换周）
      perCapitaDormant: 0.73,   // 【推定】休眠低耗（日量）
      recycle: 0.992,           // 【档案】水闭环 99.2%
      supplyTpy: 220,           // 【推定】抵损耗（年量）
      stockInit: 2500,
      cap: 6000
    },

    /* ---------------- 休眠 ---------------- */
    hibernation: {
      podsInit: 1600,           // 【档案】1,520 + 80
      drugInit: 1800,           // 【推定】
      drugCap: 3000,
      drugPerEntry: 1,          // 【推定】份/人
      drugPerDormantYear: 0.02, // 【推定】份/人·年（年量）
      drugProdTpy: 96,          // 【推定】8 份/月（年量）
      entryPerWeek: perWeek(40),      // 原 40 人/月 → 9.2308 人/周（×12/52）
      wakePerWeek: perWeek(40),       // 原 40 人/月 → 9.2308 人/周（×12/52）
      reviveFail: 0.008,        // 【档案】复温失败率 0.8%
      dormantMortality: 0.002,  // 【推定】年速率
      podMetal: 5,              // 【推定】t/位
      podLeadWeeks: monthsToWeeks(9),    // 原 9 个月 → 39 周
      maxPodStartPerWeek: perWeek(12)    // 原 12 位/月 → 2.77 位/周
    },

    /* ---------------- 克隆 ---------------- */
    clone: {
      podsInit: 96,             // 【档案】工业级 96 筒
      outputPerPodYear: 0.40,   // 【推定】96 筒 ≈ 38 具/年（年量）
      capShare: 0.18,           // 【档案】克隆人口上限 18%
      nobleShare: 0.008,        // 【推定】贵族靠克隆延续
      podMetal: 18,             // 【推定】
      podLeadWeeks: monthsToWeeks(12),   // 原 12 个月 → 52 周
      capPauseWeeks: monthsToWeeks(24),  // 触及上限后暂停 24 个月 → 104 周
      maxPods: 140
    },

    /* ---------------- 金属 ---------------- */
    metal: {
      stockInit: 6000,          // 【推定】
      cap: 12000,
      supplyTpy: 750,           // 【推定】结构件原料侧保守值（年量）
      maintNeedTpy: 450,        // 【推定】默认分配 60% 正好覆盖（年量）
      hydroMetal: 24,           // 【推定】t/单元
      hydroLeadWeeks: monthsToWeeks(6),      // 原 6 个月 → 26 周
      podMetal: 5,              // 【推定】t/位
      podLeadWeeks: monthsToWeeks(9),        // 原 9 个月 → 39 周
      clonePodMetal: 18,        // 【推定】t/筒
      clonePodLeadWeeks: monthsToWeeks(12)   // 原 12 个月 → 52 周
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
      malK: 0.30,               // 【推定】配给 0.5 → 额外 7.5%/年（年速率）
      diseaseK: 0.02,           // 【推定】年速率
      conflictK: 0.15,          // 【推定】年速率
      accidentBase: 0.0005,     // 【推定】年速率
      accidentWear: 0.002       // 【推定】年速率
    },

    /* ---------------- 秩序 ---------------- */
    order: {
      init: 0.78,
      eqBase: 0.80,
      relax: 0.15,              // 年速率，约 6 年收敛（按 dt 折算）
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
      ration: [1.00, 0.95, 0.85, 0.70, 0.50],
      upWeeks: monthsToWeeks(2),      // 原 连续 2 个月 → 9 周
      downWeeks: monthsToWeeks(3)     // 原 连续 3 个月 → 13 周
    },

    /* ---------------- 事件 ---------------- */
    events: {
      cooldownWeeks: monthsToWeeks(24),   // 原 24 个月 → 104 周
      bingeWeeks: monthsToWeeks(3),       // 原 连续 3 个月 → 13 周
      atrocityWeeks: monthsToWeeks(2),    // 原 连续 2 个月 → 9 周
      strikeWeeks: monthsToWeeks(6)       // 原 停工 6 个月 → 26 周
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

    /* ---------------- 通用随机判定层（judge） ----------------
       所有「达到阈值后再掷一次骰子」的机制都走这一层，不各写一套。
       语义：
         1) 某量达到阈值 → 调用方发出一次判定请求（check）；
         2) 倾向分 T = bias + Σ(因素值 × 系数) + 累计压力 × 压力系数；
         3) 映射：logistic  p = 1/(1+e^(-k·T))；linear p = clamp(0.5 + T/(2w), 0, 1)；
         4) 未成立 → 累计压力 += pressurePerFail，进入冷却；冷却期内不再判；
            冷却结束后压力按 pressureDecayPerWeek 部分衰减（0 = 永不清零）；
         5) lockOnFirst：该项第一次判定后永久锁定，不再判；
            freezeOnFirst：列出的因素在第一次判定时冻结，之后一直用冻结值；
         6) 随机数复用 state.rngA（与 sim-core 同一条流），所以同 seed 同操作逐位可复现。
       参数说明见《sim-engine接口文档.md》的「随机判定层」一节。 */
    judge: {
      enabled: true,
      mapping: "logistic",       // "logistic" | "linear"
      logisticK: 3.2,            // logistic 斜率；越大越像硬阈值
      linearWidth: 0.35,         // linear 窗口半宽：T=+w 必成，T=-w 必败
      pressureCap: 3.0,          // 累计压力上限
      pressureDecayPerWeek: 0,   // 全局默认衰减；单项可覆盖
      cooldownDefault: 8,        // 未写 cooldownWeeks 时的默认冷却
      onFailPressure: 0.30,      // 未写 pressurePerFail 时的默认累积
      logCap: 5000,              // 判定日志保留条数（超出丢最旧的；导出含全部保留条目）
      items: {
        /* 五级哗变阶梯：阈值/连续周数由 sim-society 预筛，这里只决定「这一次成不成立」 */
        mutiny_l1: {
          label: "有人不服从", cooldownWeeks: 6, bias: -0.55,
          factors: { stress: 1.9, coverage: 1.2, will: 1.4, garrison: -1.1, pressure: 1.0 },
          pressurePerFail: 0.30, pressureDecayPerWeek: 0.02,
          failEffect: { stressAdd: 0.03, note: "失利 → 最高应力队列 S +0.03（下次更易越线）" }
        },
        mutiny_l2: {
          label: "部门哗变", cooldownWeeks: 8, bias: -0.75,
          factors: { index: 2.0, over: 1.2, will: 1.2, garrison: -0.9, pressure: 1.0 },
          pressurePerFail: 0.28, pressureDecayPerWeek: 0.02,
          failEffect: { stressAdd: 0.02, note: "失利 → 该部门队列 S +0.02" }
        },
        mutiny_l3: {
          label: "多部门串联", cooldownWeeks: 10, bias: -1.20,
          factors: { depts: 1.4, k: 1.8, will: 0.8, pressure: 1.0 },
          pressurePerFail: 0.22, pressureDecayPerWeek: 0.015,
          failEffect: { note: "失利只累积压力，不改结构" }
        },
        mutiny_l4: {
          label: "全船暴动", cooldownWeeks: 12, bias: -1.40,
          factors: { coverage: 3.0, weak: 1.6, pressure: 1.0 },
          pressurePerFail: 0.18, pressureDecayPerWeek: 0.01,
          failEffect: { note: "失利只累积压力" }
        },
        mutiny_l5: {
          label: "权力重构", cooldownWeeks: 16, bias: -1.80,
          factors: { coverage: 2.4, weak: 1.8, dead: 2.0, pressure: 1.0 },
          pressurePerFail: 0.14, pressureDecayPerWeek: 0.01,
          failEffect: { note: "最高贵族已死时，几乎必成" }
        },

        /* 感染转化：每个队列一个独立槽位（slot = infection_thrall:<队列id>） */
        infection_thrall: {
          label: "感染转化 · 眷属", cooldownWeeks: 4, bias: -1.35,
          factors: { c: 3.0, iso: -1.1, stage: 0.6, pressure: 1.0 },
          pressurePerFail: 0.35, pressureDecayPerWeek: 0.03,
          failEffect: { cAdd: 2, note: "失利 → 该队列感染度 +2（压力继续累积）" }
        },

        /* 召唤：连续周数达标后判定；峰值/均值在首次判定时冻结 */
        summon: {
          label: "召唤 · 低语汇聚", cooldownWeeks: 12, bias: -0.95,
          factors: { thralls: 2.2, meanC: 1.6, maxC: 1.2, pressure: 1.0 },
          pressurePerFail: 0.20, pressureDecayPerWeek: 0.01,
          freezeOnFirst: ["meanC", "maxC"],
          failEffect: { thrallsAdd: 0.6, cAdd: 1, note: "失利 → 眷属登记 +0.6、各队列 C +1" }
        },

        /* 机器哗变：科技等级在首次夺权判定时冻结 */
        machine_takeover: {
          label: "机器哗变 · 夺权", cooldownWeeks: 10, bias: -1.90,
          factors: { autonomy: 3.0, tech: 0.8, weakO: 1.6, pressure: 1.0 },
          pressurePerFail: 0.20, pressureDecayPerWeek: 0.02,
          freezeOnFirst: ["tech"],
          failEffect: { note: "失利只累积压力；tech 已冻结" }
        },

        /* 设备故障：故障间隔已由磨损/缺口确定，这里只决定本次是否真的坏 */
        maint_fault: {
          label: "设备故障", cooldownWeeks: 3, bias: -2.20,
          factors: { wear: 1.6, gap: 1.4, age: 1.5, pressure: 1.0 },
          pressurePerFail: 0.35, pressureDecayPerWeek: 0.05,
          failEffect: { note: "失利 → 设备继续带病运行，压力累积到下一窗口" }
        },

        /* 补给窗口：每 26 周开一次；被切断时靠压力累积仍有小概率到货 */
        supply_window: {
          label: "补给窗口", cooldownWeeks: 0, bias: -0.35,
          factors: { route: 2.4, pressure: 0.8 },
          pressurePerFail: 0.40, pressureDecayPerWeek: 0,
          successEffect: { foodT: 18, metalT: 12, note: "到货 → 粮食 +18 吨、金属 +12 吨" },
          failEffect: { note: "未到货 → 压力累积，下个窗口更易到货" }
        },

        /* 年度奇遇：每年显式调用；log=false 不写判定日志（另存 encounter.history） */
        encounter_year: {
          label: "年度奇遇", log: false, cooldownWeeks: 0,
          bias: -0.76, factors: { luck: 0.55, gap: 0.035 },
          pressurePerFail: 0, pressureDecayPerWeek: 0
        },

        /* 玩家行动风险：fired = 动作成功；未成立 = 失败后果 */
        player_risk: {
          label: "你的行动风险", cooldownWeeks: 0, bias: 1.40,
          factors: { skill: 1.0, guard: 0.8, risk: -1.8, will: 0.5, pressure: 1.0 },
          pressurePerFail: 0.0, pressureDecayPerWeek: 0.0,
          successEffect: { note: "动作成功" },
          failEffect: { note: "动作失败 → 受伤 / 禁闭 / 资源损失" }
        },
        player_kill: {
          label: "你遇刺", cooldownWeeks: 8, bias: -2.20,
          factors: { mutiny: 2.0, guard: -1.0, will: 0.8, pressure: 1.0 },
          pressurePerFail: 0.15, pressureDecayPerWeek: 0.02,
          successEffect: { note: "袭击成立 → 你会死" },
          failEffect: { note: "袭击未遂 → 压力累积" }
        }
      }
    },

    /* ---------------- 个体层：真实位置 ----------------
       引擎始终保存每个人的真实位置（分区/房间/岗位），玩家看到的只是裁剪视图。
       详见 visibility 与 sim-people.js；字段归属见接口文档「真值 / 玩家视图」。 */
    people: {
      enabled: true,
      rotateWeeks: 4,            // 岗位轮换周期：房间/岗位每 4 周换一次
      dormantZone: "Z_hold",     // 休眠人员固定位置
      groupDept: {
        original: "指挥", noble: "指挥", combat: "战斗", tech: "技术",
        service: "勤务", medical: "医疗", clone: "农环", undecided: "勤务"
      },
      // 群体 → 层级构成（按人数比例，用确定性哈希分配）
      layerMix: {
        original: { L1: 1 },
        noble: { L2: 0.40, L3: 0.60 },
        combat: { L3: 0.10, L4: 0.90 },
        tech: { L3: 0.12, L4: 0.88 },
        service: { L3: 0.06, L4: 0.94 },
        medical: { L3: 0.08, L4: 0.92 },
        clone: { L4clone: 1 },
        undecided: { L4: 1 }
      },
      zones: [
        { id: "Z_cmd",  name: "指挥环",   depts: ["指挥"],          rooms: 12 },
        { id: "Z_cmb",  name: "战斗甲板", depts: ["战斗"],          rooms: 18 },
        { id: "Z_tec",  name: "技术环",   depts: ["技术"],          rooms: 22 },
        { id: "Z_srv",  name: "勤务区",   depts: ["勤务"],          rooms: 20 },
        { id: "Z_med",  name: "医疗区",   depts: ["医疗"],          rooms: 10 },
        { id: "Z_agr",  name: "农环",     depts: ["农环"],          rooms: 16 },
        { id: "Z_hab",  name: "居住环",   depts: ["勤务", "医疗"],  rooms: 24 },
        { id: "Z_hold", name: "休眠舱区", depts: [],                rooms: 8 }
      ],
      posts: ["值班", "检修", "运输", "守卫", "教学", "休整"]
    },

    /* ---------------- 情报与可见性 ----------------
       可见比例 = 植入覆盖率 × 科技/警备增益 × 服从度增益 − 自由意志折损；
       未植入者只可能被巡逻/报告间接看到，其余为盲区（只给人数，不撒点）。
       可见视图带误差半径与时间延迟，空间精度由情报档位决定。 */
    visibility: {
      enabled: true,
      intelLevels: {
        low:  { label: "低 · 民用终端", techMin: 0.00, roomDetail: false, errorMul: 2.2, delayMul: 2.0 },
        mid:  { label: "中 · 舰务终端", techMin: 0.35, roomDetail: false, errorMul: 1.0, delayMul: 1.0 },
        high: { label: "高 · 警备共视", techMin: 0.65, roomDetail: true,  errorMul: 0.5, delayMul: 0.4 }
      },
      implantBase: { L1: 0.98, L2: 0.92, L3: 0.72, L4n: 0.40, L4c: 0.85, L4clone: 0.85 },
      techWeight: 0.30,          // 科技等级对监控覆盖的增益
      garrisonWeight: 0.15,      // 警备可用度对巡逻覆盖的增益
      complianceWeight: 0.20,    // 服从度对信号回传的增益
      willPenalty: 0.35,         // 自由意志对覆盖的折损
      patrolShare: 0.12,         // 未植入者被巡逻/举报间接看到的基准比例
      baseEff: 0.45,             // 覆盖率基准
      blindThreshold: 0.10,      // 单人可见概率低于此值计入盲区
      errorBaseM: 30,            // 基础误差半径
      errorSpreadM: 140,         // 随不确定度增加的误差
      delayBaseWeeks: 0,
      delaySpreadWeeks: 6,       // 最大时间延迟（周）
      trueViewKey: "玄枢真值",    // 真值视图口令（本地混淆用，不是安全边界）
      showPersonsInSnapshot: false  // 默认快照不内联 4,000 条个人明细
    },

    /* ---------------- 玩家身份层（player） ----------------
       玩家是名册中某个真实个体的「身份壳」，不新增人口。
       动作门禁统一走 sim-player.gate()：个人情况 → 实时情况 → 舱段/权限 → 冷却。
       禁用必须返回人话原因，模板见《玩家身份与奇遇机制方案》§3.3。 */
    player: {
      enabled: true,
      modes: ["ruler", "mid", "slave", "creator"],
      creatorEntry: true,
      startingHealth: 82,
      healthRegress: 0.010,
      // v1.3 感染慢性侵蚀：按「感染-年」累积（每周 C/100/52），超过免疫容忍度后
      // 才开始按周扣健康；阈值以下不产生影响，避免动摇被动侧千年内的死亡分布。
      // 定稿值经 12 种子复测：被动侧累计感染-年 < 300，慢性项恒为 0（基准分布不动）；
      // 轻度经营约 3,900 感染-年时被拖到崩盘边缘，强经营（医疗 1.0）仍可走满 41,000 年。
      infectionChronicK: 0.00006,    // 超出容忍度后，每 1 感染-年每周扣 0.00006 健康
      infectionFreeYears: 800,       // 免疫容忍度：累计 800 感染-年以内不侵蚀
      pregnancyBase: 0.08,
      pregnancyWeeks: 39,
      titleDominion: { ruler: 15, mid: 5, slave: 0, creator: 0 },
      authority: { ruler: 100, mid: 45, slave: 0, creator: 100 },
      intel: { ruler: "high", mid: "mid", slave: "low", creator: "truth" },
      modeCompliance: { ruler: 8, mid: 3, slave: -5, creator: 0 },
      modeWill: { ruler: -5, mid: 0, slave: 5, creator: 0 },
      // 玩家风险判定：fired = 动作成功；未成立 = 失败后果
      risk: {
        player_risk: {
          bias: 1.40, cooldownWeeks: 0,
          factors: { skill: 1.0, guard: 0.8, risk: -1.8, will: 0.5, pressure: 1.0 },
          pressurePerFail: 0.0, pressureDecayPerWeek: 0.0
        },
        player_kill: {
          bias: -2.20, cooldownWeeks: 8,
          factors: { mutiny: 2.0, guard: -1.0, will: 0.8, pressure: 1.0 },
          pressurePerFail: 0.15, pressureDecayPerWeek: 0.02
        }
      },
      actions: {
        /* ---------- 统治者 / 中层共用治理 ---------- */
        decree_ration: {
          label: "调整配给", cat: "治理", mode: ["ruler", "mid"], cdWeeks: 8,
          gate: { dominionMin: 45, healthMin: 30, orderMin: 0.35, authorityMin: 80, confined: false, interrogated: false },
          gateMid: { orderMin: 0.30, authorityMin: 40, deptOnly: true },
          effect: { type: "input", key: "ration", min: 0.60, max: 1.20 },
          desc: "调整全船配给比例"
        },
        decree_production: {
          label: "调度生产", cat: "治理", mode: ["ruler", "mid"], cdWeeks: 8,
          gate: { dominionMin: 45, healthMin: 30, orderMin: 0.30, authorityMin: 80, confined: false, interrogated: false },
          gateMid: { orderMin: 0.30, authorityMin: 40, deptOnly: true },
          effect: { type: "input", key: "agriShare", min: 0.30, max: 0.85 },
          desc: "调整农业/工业能源分配"
        },
        replace_mid: {
          label: "任免中层贵族", cat: "治理", mode: ["ruler"], cdWeeks: 52,
          gate: { dominionMin: 55, orderMin: 0.25, authorityMin: 80, confined: false },
          society: "replace",
          desc: "换掉涉事的中层贵族，统御 −8，其他人的压力 +0.12"
        },
        suppress: {
          label: "武力镇压", cat: "治理", mode: ["ruler", "mid"], cdWeeks: 26,
          gate: { dominionMin: 40, healthMin: 35, orderMin: 0.25, garrisonMin: 0.40, confined: false },
          gateMid: { orderMin: 0.30, garrisonMin: 0.50, authorityMin: 45, deptOnly: true },
          society: "suppress",
          desc: "消耗警备耐久与金属，短期抬高服从"
        },
        concede: {
          label: "让步加配额", cat: "治理", mode: ["ruler", "mid"], cdWeeks: 52,
          gate: { complianceMin: 30, orderMin: 0.20, confined: false },
          gateMid: { authorityMin: 35, deptOnly: true },
          society: "concede",
          desc: "补发口粮配额，直接吃粮食储备"
        },
        execute: {
          label: "处决领头", cat: "治理", mode: ["ruler", "mid"], cdWeeks: 39,
          gate: { dominionMin: 50, healthMin: 30, orderMin: 0.20, confined: false },
          gateMid: { orderMin: 0.25, authorityMin: 50, deptOnly: true },
          society: "execute",
          desc: "短期服从 +18，不服永久 +3，统御 −5"
        },
        interrogate: {
          label: "审讯", cat: "治理", mode: ["ruler", "mid"], cdWeeks: 17,
          gate: { dominionMin: 45, orderMin: 0.30, garrisonMin: 0.01, confined: false },
          gateMid: { authorityMin: 45, deptOnly: true },
          society: "interrogate",
          desc: "潜伏机审讯，需要至少 1 台潜伏机"
        },
        lockdown: {
          label: "封锁隔离", cat: "治理", mode: ["ruler", "mid"], cdWeeks: 13,
          gate: { dominionMin: 40, orderMin: 0.30, confined: false },
          gateMid: { authorityMin: 50, deptOnly: true },
          society: "lockdown",
          desc: "产出 −15%，感染扩散 −40%"
        },
        ritual: {
          label: "仪式宣传", cat: "治理", mode: ["ruler", "mid"], cdWeeks: 13,
          gate: { dominionMin: 40, stageMax: 2, orderMin: 0.20, confined: false },
          gateMid: { authorityMin: 40, deptOnly: true },
          society: "ritual",
          desc: "消耗少量口粮，抬高服从"
        },
        audience: {
          label: "巡视 / 召见", cat: "治理", mode: ["ruler", "mid"], cdWeeks: 13,
          gate: { healthMin: 30, orderMin: 0.25, confined: false, interrogated: false },
          gateMid: { orderMin: 0.20, deptOnly: true },
          effect: { type: "audience" },
          desc: "秩序 +2%、服从 +2、情报 +1 档 8 周"
        },
        purge_tech: {
          label: "清洗技术环", cat: "治理", mode: ["ruler"], cdWeeks: 104,
          gate: { dominionMin: 60, orderMin: 0.40, authorityMin: 90, confined: false },
          effect: { type: "purge_tech" },
          desc: "科技 −0.03、技术部门失序 −0.15、不服 +4"
        },

        /* ---------- 中层 ---------- */
        petition: {
          label: "上奏请求", cat: "中层贵族", mode: ["mid"], cdWeeks: 26,
          gate: { orderMin: 0.15, confined: false, interrogated: false },
          effect: { type: "petition" },
          desc: "50% 获批，按最缺项补给；失败秩序 −1%"
        },
        inform_peer: {
          label: "举报同僚", cat: "中层贵族", mode: ["mid"], cdWeeks: 26,
          gate: { willMin: 30, orderMin: 0.25, interrogated: false },
          effect: { type: "inform_peer" },
          desc: "自身权限 +5，同僚压力 +0.05，不服 +2"
        },
        embezzle: {
          label: "截留物资", cat: "中层贵族", mode: ["mid"], cdWeeks: 26,
          gate: { authorityMin: 40, orderMin: 0.20, interrogated: false },
          effect: { type: "embezzle" }, risk: 0.30,
          desc: "金属 +20 吨或粮食 +15 吨；秩序 −2%；有风险"
        },
        inspect: {
          label: "巡查部门", cat: "中层贵族", mode: ["mid"], cdWeeks: 13,
          gate: { healthMin: 30, orderMin: 0.25, confined: false },
          effect: { type: "inspect" },
          desc: "本部门情报 +1 档 26 周，部门失序 −5%"
        },

        /* ---------- 奴隶 ---------- */
        overtime: {
          label: "加班", cat: "奴隶", mode: ["slave"], cdWeeks: 4,
          gate: { healthMin: 40, confined: false },
          effect: { type: "overtime" },
          desc: "服从 +2、不服 −2、健康 −4，产出略升"
        },
        steal_food: {
          label: "偷配给", cat: "奴隶", mode: ["slave"], cdWeeks: 8,
          gate: { healthMin: 30, orderMin: 0.15, confined: false },
          effect: { type: "steal_food" }, risk: 0.35,
          desc: "粮食 +8 吨；失败健康 −6、禁闭 4 周"
        },
        hide: {
          label: "躲藏", cat: "奴隶", mode: ["slave"], cdWeeks: 8,
          gate: { willMin: 20, confined: false, lockdown: "no" },
          effect: { type: "hide" },
          desc: "4 周内被侦测概率 −50%，期间不能行动"
        },
        black_market: {
          label: "黑市交易", cat: "奴隶", mode: ["slave"], cdWeeks: 13,
          gate: { healthMin: 30, willMin: 25, lockdown: "no", zones: ["Z_srv", "Z_hab"] },
          effect: { type: "black_market" }, risk: 0.30,
          desc: "金属换粮或粮换金属；有风险"
        },
        inform: {
          label: "告密", cat: "奴隶", mode: ["slave"], cdWeeks: 26,
          gate: { willMax: 70, orderMin: 0.20, confined: false },
          effect: { type: "inform" }, risk: 0.20,
          desc: "服从 +4、同僚压力 +0.05、不服 +2；有被报复风险"
        },
        sabotage: {
          label: "破坏设备", cat: "奴隶", mode: ["slave"], cdWeeks: 26,
          gate: { willMin: 35, healthMin: 35, orderMax: 0.80, lockdown: "no", zones: ["Z_tec", "Z_agr"] },
          effect: { type: "sabotage" }, risk: 0.55,
          desc: "磨损 +3%、部门失序 +0.05；失败健康 −15、禁闭 8–12 周"
        },
        escape: {
          label: "逃往休眠区", cat: "奴隶", mode: ["slave"], cdWeeks: 104,
          gate: { willMin: 45, healthMin: 35, lockdown: "no", garrisonMax: 0.80 },
          effect: { type: "escape" }, risk: 0.65,
          desc: "移动到休眠舱区；失败健康 −20、禁闭 12 周，大失败死亡"
        },
        tend_thralls: {
          label: "照料眷属", cat: "奴隶", mode: ["slave"], cdWeeks: 13,
          gate: { infectionMin: 30, confined: false },
          effect: { type: "tend_thralls" },
          desc: "眷属 +1、全船感染 +1、服从 −1"
        },
        eavesdrop: {
          label: "偷听情报", cat: "奴隶", mode: ["slave"], cdWeeks: 13,
          gate: { healthMin: 25, orderMin: 0.15, confined: false, zones: ["Z_cmd", "Z_tec"] },
          effect: { type: "eavesdrop" }, risk: 0.25,
          desc: "情报 +1 档 13 周；失败禁闭 4 周"
        },

        /* ---------- 创造模式 ---------- */
        force_encounter: {
          label: "强制奇遇", cat: "调试", mode: ["creator"], cdWeeks: 0,
          gate: {}, effect: { type: "debug_force_encounter" },
          desc: "立即排队一次三选一"
        },
        set_state: {
          label: "改状态", cat: "调试", mode: ["creator"], cdWeeks: 0,
          gate: {}, effect: { type: "debug_set_state" },
          desc: "按路径直接写状态，payload = { path, value }"
        },
        jump_time: {
          label: "跳时", cat: "调试", mode: ["creator"], cdWeeks: 0,
          gate: {}, effect: { type: "debug_jump_time" },
          desc: "payload = { weeks } 或 { years }；仍逐周判定"
        },
        grant_card: {
          label: "发放卡牌", cat: "调试", mode: ["creator"], cdWeeks: 0,
          gate: {}, effect: { type: "debug_grant_card" },
          desc: "payload = { cardId }；下一次奇遇优先出现该卡"
        },
        reveal_truth: {
          label: "揭示真值", cat: "调试", mode: ["creator"], cdWeeks: 0,
          gate: {}, effect: { type: "debug_reveal_truth" },
          desc: "返回真值标记，前端切到真值视图"
        }
      }
    },

    /* ---------------- 奇遇与牌库（encounter / deck） ----------------
       年度判定走 judge.items.encounter_year；抽类别 → 抽 3 张 → 立即结算。
       牌库剩余/已抽/洗牌轮次/当前候选/历史全部进 state.encounter。 */
    encounter: {
      enabled: true,
      checkEveryYears: 1,
      baseBias: -0.76,
      luckMin: 0.55,
      luckMax: 1.45,
      luckDraws: 3,
      droughtAfterYears: 12,
      droughtCoef: 0.035,
      maxPerYear: 1,
      historyCap: 200
    },

    /* 古神契约：四位神的索求/赐予/神噬；跨轮保留。
       主约 100%，旁约祝福/诅咒 50%；周期索取始终 100%。 */
    gods: {
      enabled: true,
      favorCap: 100,
      favorRegressPerDecade: 2,
      blessAt: 50,
      curseAt: -50,
      calmAt: 40,
      devourCap: 100,
      mawDevourPerYear: 0.5,
      ids: ["maw", "weaver", "star", "fecund"],
      items: {
        maw: {
          name: "缄默之喉", lean: "索取人口",
          onPact: { dominion: 10, order: 0.05, garrison: { durability: 20 } },
          titheEveryYears: 100,
          tithe: { popShare: 0.008, minPop: 8 },
          bless: { prodMul: 1.03, infectionC: -0.02 },
          curse: { popSharePerDecade: 0.01 }
        },
        weaver: {
          name: "赤织母", lean: "索要献祭",
          onPact: { thralls: 3, infectionC: 3, garrison: { strength: 10 } },
          titheEveryYears: 50,
          tithe: { choice: true, acceptFavor: 10, acceptOrder: 0.03,
            refuseFavor: -30, refuseC: 4, l2: 1, l4: 20 },
          bless: { convertMul: 0.80, garrisonDurabilityPerYear: 26 },
          curse: { deptSPerDecade: 0.10 }
        },
        star: {
          name: "星启者", lean: "给予科技",
          onPact: { tech: 0.08, exploreMul: 1.5 },
          titheEveryYears: 200,
          tithe: { order: -0.05, drug: -40, random: true },
          passive: { techPerYear: 0.002 },
          bless: { techRarity: 1 },
          curse: { machineAutonomyPerYear: 0.02, machineMutinyMul: 1.4 }
        },
        fecund: {
          name: "丰穰之腹", lean: "给予繁衍",
          onPact: { birthMul: 1.25, cloneMul: 1.15 },
          titheEveryYears: 0,
          passive: { foodUseMul: 1.08, infectionCPerYear: 0.5 },
          bless: { pregnancy: 1.5 },
          curse: { cloneMutant: 0.10, cloneDeathMul: 1.20 }
        }
      }
    },

    deck: {
      drawCount: 3,
      refillWhenBelow: 3,
      rarityWeights: { common: 0.58, rare: 0.28, epic: 0.11, legendary: 0.03 },
      categories: ["explore", "tech", "resource", "society", "oldgod", "crisis", "trade"],
      cards: {
        explore: [
          { id: "ex_metal_asteroid", name: "富金属小行星", rarity: "common", need: { techMin: 0.30 }, ops: [{ t: "stock", k: "metal", v: 90 }, { t: "wear", v: 0.03 }], follow: [{ key: "encounter.crisis", v: 0.10, weeks: 520 }], effectText: "金属 +90 吨", costText: "磨损 +0.03，占用 8 周", followText: "10 年内危机权重 +0.10" },
          { id: "ex_ice_asteroid", name: "冰质小行星", rarity: "common", need: { techMin: 0.25 }, ops: [{ t: "stock", k: "water", v: 400 }, { t: "stock", k: "metal", v: -10 }], effectText: "水 +400 吨", costText: "金属 −10 吨，占用 6 周", followText: "—" },
          { id: "ex_derelict", name: "废弃殖民舰", rarity: "rare", need: { techMin: 0.40 }, ops: [{ t: "pop", group: "undecided", v: 18 }, { t: "stock", k: "metal", v: 40 }, { t: "stock", k: "drug", v: -30 }, { t: "infect", v: 3 }], effectText: "人口 +18（未定）、金属 +40 吨", costText: "药剂 −30", followText: "全船感染 +3" },
          { id: "ex_ruins", name: "远古遗迹", rarity: "epic", need: { techMin: 0.55 }, ops: [{ t: "tech", v: 0.06 }, { t: "stock", k: "metal", v: 60 }, { t: "infect", v: 6 }, { t: "thralls", v: 1 }], follow: [{ key: "encounter.oldgod", v: 0.30, weeks: 5200 }], effectText: "科技 +0.06、金属 +60 吨", costText: "感染 +6、眷属 +1", followText: "100 年内古神权重 ×1.3" },
          { id: "ex_ring_sample", name: "行星环采样", rarity: "common", need: { techMin: 0.30 }, ops: [{ t: "tech", v: 0.02 }, { t: "stock", k: "metal", v: 30 }, { t: "wear", v: 0.02 }], effectText: "科技 +0.02、金属 +30 吨", costText: "磨损 +0.02", followText: "—" },
          { id: "ex_beacon", name: "深空信标", rarity: "rare", need: { techMin: 0.45 }, ops: [{ t: "stock", k: "metal", v: -25 }, { t: "intel", level: "high", weeks: 200 }, { t: "mod", key: "encounter.explore", v: 0.20, weeks: 2600 }], effectText: "情报 +1 档 200 周", costText: "金属 −25 吨", followText: "50 年探索权重 +0.20" },
          { id: "ex_pod_drift", name: "漂流休眠舱", rarity: "rare", need: { techMin: 0.35 }, ops: [{ t: "dormant", v: 24 }, { t: "stock", k: "drug", v: 40 }, { t: "stock", k: "metal", v: -15 }, { t: "randomInfect", p: 0.30, v: 5 }], effectText: "舱里 +24 人、药剂 +40", costText: "金属 −15 吨", followText: "30% 概率舱内感染 +5" },
          { id: "ex_debris", name: "陨石残骸", rarity: "common", need: { techMin: 0.20 }, ops: [{ t: "stock", k: "metal", v: 45 }, { t: "wear", v: 0.05 }], effectText: "金属 +45 吨", costText: "磨损 +0.05", followText: "—" },
          { id: "ex_garden_world", name: "宜居行星", rarity: "epic", need: { techMin: 0.50 }, ops: [{ t: "stock", k: "food", v: 120 }, { t: "stock", k: "water", v: 200 }, { t: "pop", group: "undecided", v: 30 }, { t: "mod", key: "encounter.explore", v: 0.40, weeks: 520 }, { t: "mod", key: "encounter.crisis", v: 0.15, weeks: 520 }], effectText: "粮 +120 吨、水 +200 吨、人口 +30", costText: "10 年探索权重 ×1.4", followText: "危机权重 +0.15（10 年）" },
          { id: "ex_signal", name: "未知信号源", rarity: "legendary", need: { techMin: 0.60 }, choices: ["tech", "god", "thralls"], ops: [{ t: "infect", v: 8 }, { t: "machine", k: "autonomy", v: 0.05 }], effectText: "三选一：科技 +0.10 / 随机古神契约 / 眷属 +3", costText: "感染 +8、机器自主 +0.05", followText: "机器哗变风险上升" }
        ],
        tech: [
          { id: "te_hydro_gene", name: "水培基因改良", rarity: "common", need: { techMin: 0.20 }, ops: [{ t: "infra", k: "hydro", v: 12 }, { t: "stock", k: "drug", v: -15 }], effectText: "水培 +12 单元", costText: "药剂 −15", followText: "—" },
          { id: "te_recycle", name: "闭环回收突破", rarity: "rare", need: { techMin: 0.35 }, ops: [{ t: "stock", k: "water", v: 300 }, { t: "wear", v: -0.02 }, { t: "stock", k: "metal", v: -30 }], effectText: "水 +300 吨、磨损 −0.02", costText: "金属 −30 吨", followText: "—" },
          { id: "te_maint_bot", name: "维修机器人", rarity: "common", need: { techMin: 0.25 }, ops: [{ t: "garrison", k: "durability", v: 10 }, { t: "wear", v: -0.04 }, { t: "stock", k: "metal", v: -20 }], effectText: "警备耐久 +10、磨损 −0.04", costText: "金属 −20 吨", followText: "—" },
          { id: "te_clone_stabilizer", name: "克隆稳定剂", rarity: "rare", need: { techMin: 0.40 }, ops: [{ t: "mod", key: "cloneMul", v: 1.10, weeks: 10400 }, { t: "stock", k: "drug", v: -60 }, { t: "stock", k: "food", v: -15 }], effectText: "克隆产量 ×1.10（200 年）", costText: "药剂 −60、粮 −15 吨", followText: "—" },
          { id: "te_neural_suppress", name: "神经抑制协议", rarity: "rare", need: { techMin: 0.45 }, ops: [{ t: "queue", k: "W", v: -4, scope: "all" }, { t: "queue", k: "O", v: 3, scope: "all" }, { t: "stock", k: "drug", v: -40 }, { t: "player", k: "will", v: 2 }], effectText: "全船不服 −4、服从 +3（52 周）", costText: "药剂 −40、不服永久 +2", followText: "—" },
          { id: "te_sensor_array", name: "深潜传感阵列", rarity: "common", need: { techMin: 0.30 }, ops: [{ t: "vision", v: 0.05 }, { t: "intel", level: "high", weeks: 100 }, { t: "stock", k: "metal", v: -35 }], effectText: "视野 +0.05（永久）", costText: "金属 −35 吨", followText: "情报 +1 档 100 周" },
          { id: "te_auto_line", name: "自动化产线", rarity: "epic", need: { techMin: 0.55 }, ops: [{ t: "tech", v: 0.05 }, { t: "mod", key: "prodMul", v: 1.04, weeks: 5200 }, { t: "machine", k: "autonomy", v: 0.03 }, { t: "stock", k: "metal", v: -50 }], effectText: "科技 +0.05、产能 +4%", costText: "机器自主 +0.03、金属 −50 吨", followText: "机器哗变权重 +0.10" },
          { id: "te_hibernation", name: "低温休眠改良", rarity: "rare", need: { techMin: 0.35 }, ops: [{ t: "mod", key: "drugSave", v: 0.10, weeks: 10400 }, { t: "stock", k: "drug", v: -40 }], effectText: "药剂消耗 −10%（200 年）", costText: "药剂 −40", followText: "—" },
          { id: "te_nano_med", name: "医疗纳米群", rarity: "rare", need: { techMin: 0.40 }, ops: [{ t: "vision", v: 0.02 }, { t: "player", k: "health", v: 10 }, { t: "stock", k: "drug", v: -70 }, { t: "stock", k: "metal", v: -20 }], effectText: "视野 +0.02、你的健康 +10", costText: "药剂 −70、金属 −20 吨", followText: "—" },
          { id: "te_singularity", name: "奇点演算核心", rarity: "legendary", need: { techMin: 0.65 }, ops: [{ t: "tech", v: 0.12 }, { t: "machine", k: "maxChain", v: 1 }, { t: "machine", k: "autonomy", v: 0.08 }, { t: "queue", k: "W", v: 5, scope: "all" }], effectText: "科技 +0.12、机器连锁上限 +1", costText: "机器自主 +0.08、全船不服 +5", followText: "机器哗变权重 ×1.3" }
        ],
        resource: [
          { id: "re_emergency_ration", name: "紧急配给", rarity: "common", need: {}, ops: [{ t: "stock", k: "food", v: 40 }, { t: "order", v: -0.02 }, { t: "queue", k: "W", v: 2, scope: "all" }], effectText: "粮 +40 吨", costText: "秩序 −2%、不服 +2", followText: "—" },
          { id: "re_scrap", name: "拆解非关键舱段", rarity: "common", need: {}, ops: [{ t: "stock", k: "metal", v: 60 }, { t: "wear", v: 0.06 }, { t: "stock", k: "water", v: -50 }], effectText: "金属 +60 吨", costText: "磨损 +0.06、水 −50 吨", followText: "—" },
          { id: "re_black_barter", name: "黑市粮换", rarity: "rare", need: { orderMin: 0.30 }, ops: [{ t: "stock", k: "food", v: 70 }, { t: "stock", k: "metal", v: -30 }], effectText: "粮 +70 吨", costText: "金属 −30 吨", followText: "—" },
          { id: "re_water_repair", name: "水循环抢修", rarity: "common", need: { techMin: 0.20 }, ops: [{ t: "stock", k: "water", v: 250 }, { t: "stock", k: "metal", v: -8 }], effectText: "水 +250 吨", costText: "金属 −8 吨", followText: "—" },
          { id: "re_drug_cache", name: "药库启封", rarity: "rare", need: { orderMin: 0.40 }, ops: [{ t: "stock", k: "drug", v: 120 }, { t: "order", v: -0.01 }], effectText: "药剂 +120", costText: "秩序 −1%", followText: "—" },
          { id: "re_harvest", name: "农环抢收", rarity: "common", need: {}, ops: [{ t: "stock", k: "food", v: 55 }, { t: "infra", k: "hydro", v: -3 }, { t: "queue", k: "W", v: 1, scope: "all" }], effectText: "粮 +55 吨", costText: "水培 −3 单元、不服 +1", followText: "—" },
          { id: "re_pod_salvage", name: "休眠舱拆卖", rarity: "rare", need: { dormantMin: 100 }, ops: [{ t: "stock", k: "metal", v: 80 }, { t: "infra", k: "pods", v: -20 }], effectText: "金属 +80 吨", costText: "休眠舱 −20", followText: "休眠容量下降" },
          { id: "re_clone_boost", name: "克隆槽加压", rarity: "rare", need: { techMin: 0.35 }, ops: [{ t: "mod", key: "cloneMul", v: 1.15, weeks: 520 }, { t: "stock", k: "food", v: -25 }, { t: "wear", v: 0.03 }], effectText: "克隆产量 ×1.15（52 周）", costText: "粮 −25 吨、磨损 +0.03", followText: "—" },
          { id: "re_deep_mine", name: "深井采掘", rarity: "epic", need: { techMin: 0.45 }, ops: [{ t: "stock", k: "metal", v: 150 }, { t: "wear", v: 0.08 }, { t: "queue", k: "W", v: 3, scope: "all" }], effectText: "金属 +150 吨（26 周分批）", costText: "磨损 +0.08、不服 +3", followText: "—" },
          { id: "re_stardust", name: "星尘收集", rarity: "legendary", need: { techMin: 0.60 }, ops: [{ t: "mod", key: "metalPerYear", v: 6, weeks: 5200 }, { t: "tech", v: -0.02 }, { t: "mod", key: "encounter.explore", v: 0.20, weeks: 5200 }], effectText: "金属 +6 吨/年 ×100 年", costText: "科技 −0.02", followText: "100 年探索权重 +0.20" }
        ],
        society: [
          { id: "so_public_trial", name: "公开审判", rarity: "common", need: { orderMin: 0.30 }, ops: [{ t: "order", v: 0.05 }, { t: "queue", k: "O", v: 5, scope: "all" }, { t: "queue", k: "W", v: 3, scope: "all" }, { t: "queue", k: "S", v: 0.05, scope: "one" }], effectText: "秩序 +5%、服从 +5", costText: "一个部门的压力 +0.05", followText: "—" },
          { id: "so_ration_concession", name: "配给让步", rarity: "common", need: { orderMin: 0.25 }, ops: [{ t: "order", v: 0.03 }, { t: "queue", k: "W", v: -3, scope: "all" }, { t: "stockPct", k: "food", v: -0.04 }], effectText: "秩序 +3%、不服 −3", costText: "粮 −4% ×6 个月", followText: "—" },
          { id: "so_festival", name: "文化节", rarity: "rare", need: { orderMin: 0.35 }, ops: [{ t: "order", v: 0.04 }, { t: "queue", k: "W", v: -4, scope: "all" }, { t: "stock", k: "food", v: -15 }], effectText: "秩序 +4%、不服 −4", costText: "粮 −15 吨", followText: "—" },
          { id: "so_relocate", name: "强制迁徙", rarity: "common", need: {}, ops: [{ t: "mod", key: "infectSpread", v: -0.10, weeks: 26 }, { t: "queue", k: "O", v: -2, scope: "all" }, { t: "queue", k: "W", v: 2, scope: "all" }], effectText: "感染扩散 −10%（26 周）", costText: "服从 −2、不服 +2", followText: "—" },
          { id: "so_education", name: "教育普及", rarity: "epic", need: { techMin: 0.35, orderMin: 0.40 }, ops: [{ t: "tech", v: 0.02 }, { t: "mod", key: "eduMul", v: 2, weeks: 10400 }, { t: "stock", k: "food", v: -30 }, { t: "stock", k: "drug", v: -20 }], effectText: "教育迁移 ×2（200 年）、科技 +0.02", costText: "粮 −30 吨、药剂 −20", followText: "—" },
          { id: "so_revival", name: "宗教复兴", rarity: "rare", need: { orderMin: 0.25 }, ops: [{ t: "queue", k: "O", v: 6, scope: "all" }, { t: "queue", k: "W", v: -2, scope: "all" }, { t: "infect", v: 2 }, { t: "mod", key: "encounter.oldgod", v: 0.10, weeks: 2600 }], effectText: "服从 +6、不服 −2", costText: "感染 +2", followText: "50 年古神权重 +0.10" },
          { id: "so_inform_net", name: "告密网络", rarity: "rare", need: { orderMin: 0.30 }, ops: [{ t: "intel", level: "high", weeks: 200 }, { t: "queue", k: "O", v: 2, scope: "all" }, { t: "queue", k: "W", v: 2, scope: "all" }, { t: "queue", k: "S", v: 0.03, scope: "one" }], effectText: "情报 +1 档 200 周", costText: "不服 +2、同僚压力 +0.03", followText: "—" },
          { id: "so_birth_incentive", name: "生育激励", rarity: "common", need: { popMin: 2000 }, ops: [{ t: "mod", key: "birthMul", v: 1.5, weeks: 5200 }, { t: "mod", key: "foodUse", v: 1.05, weeks: 5200 }], effectText: "出生率 ×1.5（100 年）", costText: "粮消耗 +5%（100 年）", followText: "—" },
          { id: "so_purge_mid", name: "中层清洗", rarity: "epic", need: { orderMin: 0.45 }, ops: [{ t: "removeL2", v: 2 }, { t: "player", k: "dominion", v: 8 }, { t: "queue", k: "S", v: 0.08, scope: "all" }, { t: "queue", k: "W", v: 4, scope: "all" }], effectText: "移除 2 名中层贵族、统御 +8", costText: "其他人的压力 +0.08", followText: "—" },
          { id: "so_referendum", name: "全民公投", rarity: "legendary", need: { orderMin: 0.50 }, ops: [{ t: "order", v: 0.08 }, { t: "queue", k: "O", v: 5, scope: "all" }, { t: "queue", k: "W", v: 8, scope: "all" }, { t: "flag", k: "noSuppressUntil", weeks: 1352 }], effectText: "秩序 +8%、服从 +5", costText: "不服 +8", followText: "26 周内不能镇压" }
        ],
        oldgod: [
          { id: "og_whisper", name: "低语入梦", rarity: "common", need: { infectionMin: 20 }, ops: [{ t: "thralls", v: 2 }, { t: "infect", v: 3 }, { t: "queue", k: "O", v: -2, scope: "all" }, { t: "mod", key: "encounter.oldgod", v: 0.15, weeks: 2600 }], effectText: "眷属 +2、感染 +3", costText: "服从 −2", followText: "50 年古神权重 +0.15" },
          { id: "og_blood_rite", name: "血祭仪式", rarity: "rare", need: { popMin: 1000 }, ops: [{ t: "godFavor", v: 20 }, { t: "pop", group: "L4", v: -30 }, { t: "order", v: -0.02 }], effectText: "神恩 +20", costText: "人口 −30、秩序 −2%", followText: "—" },
          { id: "og_thrall_crown", name: "眷属加冕", rarity: "epic", need: { thrallsMin: 5 }, ops: [{ t: "thralls", v: 8 }, { t: "infect", v: 3 }, { t: "deptI", v: 0.10 }, { t: "mod", key: "prodMul", v: 0.90, weeks: 5200 }], effectText: "眷属 +8、感染 +3%", costText: "一个部门失序 +10%", followText: "该部门产出 −10%（100 年）" },
          { id: "og_deep_call", name: "深潜召唤", rarity: "rare", need: { thrallsMin: 3 }, ops: [{ t: "summon" }, { t: "thralls", v: 5 }, { t: "order", v: -0.04 }, { t: "infect", v: 4 }], effectText: "立即触发一次召唤、眷属 +5", costText: "秩序 −4%、感染 +4", followText: "—" },
          { id: "og_pact", name: "古神契约", rarity: "legendary", need: { infectionMin: 30 }, choices: ["maw", "weaver", "star", "fecund"], ops: [], effectText: "与一位古神立约（4 选 1）", costText: "依神而定", followText: "永久写入 state.gods" },
          { id: "og_forbidden_lore", name: "禁忌知识", rarity: "rare", need: { infectionMin: 25 }, ops: [{ t: "tech", v: 0.05 }, { t: "queue", k: "W", v: 5, scope: "all" }, { t: "infect", v: 4 }], effectText: "科技 +0.05", costText: "不服 +5、感染 +4", followText: "—" },
          { id: "og_shelter", name: "眷属庇护", rarity: "common", need: { thrallsMin: 1 }, ops: [{ t: "garrison", k: "durability", v: 15 }, { t: "queue", k: "O", v: -3, scope: "all" }, { t: "infect", v: 2 }], effectText: "警备耐久 +15", costText: "服从 −3、感染 +2", followText: "—" },
          { id: "og_sacrifice_prisoner", name: "献祭囚徒", rarity: "common", need: { popMin: 800 }, ops: [{ t: "godFavor", v: 10 }, { t: "order", v: 0.02 }, { t: "pop", group: "L4", v: -12 }], effectText: "神恩 +10、秩序 +2%", costText: "人口 −12", followText: "—" },
          { id: "og_star_whisper", name: "群星低语", rarity: "epic", need: { infectionMin: 40 }, ops: [{ t: "intel", level: "high", weeks: 100 }, { t: "godFavor", v: 8 }, { t: "infect", v: 6 }, { t: "queue", k: "W", v: 3, scope: "all" }], effectText: "情报 +1 档 100 周、神恩 +8", costText: "感染 +6、不服 +3", followText: "—" },
          { id: "og_divine_birth", name: "神性孕育", rarity: "legendary", need: { infectionMin: 35, healthMin: 40 }, ops: [{ t: "birth", v: 40 }, { t: "player", k: "health", v: -15 }, { t: "thralls", v: 4 }, { t: "godFavor", v: 15 }, { t: "infect", v: 2 }], effectText: "怀孕必定成功、出生 +40", costText: "健康 −15、眷属 +4", followText: "新生儿感染 +10" }
        ],
        crisis: [
          { id: "cr_decompression", name: "舱段失压", rarity: "common", need: {}, choices: ["pay", "take"], ops: [], effectText: "支付金属 15 吨无伤", costText: "或人口 −12、秩序 −3%", followText: "—" },
          { id: "cr_outbreak", name: "传染爆发", rarity: "rare", need: {}, ops: [{ t: "infect", v: 8 }, { t: "mod", key: "medCoverage", v: -0.10, weeks: 26 }], effectText: "全船感染 +8", costText: "医疗 −10%（26 周）", followText: "—" },
          { id: "cr_machine_runaway", name: "机器暴走", rarity: "rare", need: {}, ops: [{ t: "wear", v: 0.10 }, { t: "mod", key: "prodMul", v: 0.92, weeks: 26 }, { t: "stock", k: "metal", v: -25 }], effectText: "磨损 +0.10、产能 −8%", costText: "金属 −25 吨修复", followText: "—" },
          { id: "cr_pre_mutiny", name: "哗变前夜", rarity: "common", need: {}, ops: [{ t: "queue", k: "S", v: 0.08, scope: "one" }, { t: "order", v: -0.03 }, { t: "garrison", k: "durability", v: -8 }], effectText: "一个部门的压力 +0.08", costText: "秩序 −3%、警备耐久 −8", followText: "—" },
          { id: "cr_meteor", name: "陨石雨", rarity: "common", need: {}, ops: [{ t: "wear", v: 0.06 }, { t: "stock", k: "metal", v: -15 }], effectText: "磨损 +0.06", costText: "金属 −15 吨", followText: "—" },
          { id: "cr_drought", name: "断水", rarity: "rare", need: {}, ops: [{ t: "stock", k: "water", v: -300 }, { t: "order", v: -0.02 }, { t: "stock", k: "metal", v: -20 }], effectText: "水 −300 吨", costText: "秩序 −2%、金属 −20 吨", followText: "—" },
          { id: "cr_pod_failure", name: "休眠舱故障", rarity: "rare", need: {}, ops: [{ t: "infra", k: "pods", v: -10 }, { t: "dormant", v: -10 }], effectText: "休眠舱 −10", costText: "舱里 −10 人", followText: "—" },
          { id: "cr_blight", name: "农环病害", rarity: "common", need: {}, ops: [{ t: "stock", k: "food", v: -30 }, { t: "infra", k: "hydro", v: -5 }], effectText: "粮 −30 吨", costText: "水培 −5 单元", followText: "—" },
          { id: "cr_god_stir", name: "古神苏醒", rarity: "epic", need: { godPact: true }, ops: [{ t: "devour", v: 15 }, { t: "infect", v: 6 }, { t: "godFavor", v: -10 }], effectText: "神噬进度 +15", costText: "神恩 −10、感染 +6", followText: "—" },
          { id: "cr_blackout", name: "全船停电", rarity: "legendary", need: {}, ops: [{ t: "mod", key: "prodMul", v: 0.75, weeks: 8 }, { t: "order", v: -0.06 }, { t: "machine", k: "autonomy", v: 0.05 }], effectText: "产能 −25%（8 周）", costText: "秩序 −6%、机器自主 +0.05", followText: "—" }
        ],
        trade: [
          { id: "tr_trader", name: "巡回商船", rarity: "common", need: { orderMin: 0.30 }, choices: ["metal", "food"], ops: [], effectText: "金属 +40 t 或 粮 +50 吨", costText: "另一项 −20 吨", followText: "—" },
          { id: "tr_intel_broker", name: "情报贩子", rarity: "rare", need: { orderMin: 0.35 }, ops: [{ t: "intel", level: "high", weeks: 200 }, { t: "stock", k: "metal", v: -20 }], effectText: "情报 +1 档 200 周", costText: "金属 −20 吨", followText: "—" },
          { id: "tr_mercenary", name: "雇佣兵", rarity: "rare", need: { orderMin: 0.30 }, ops: [{ t: "garrison", k: "strength", v: 15 }, { t: "mod", key: "garrison", v: 15, weeks: 5200 }, { t: "stock", k: "food", v: -25 }], effectText: "警备兵力 +15（100 年）", costText: "粮 −25 吨", followText: "—" },
          { id: "tr_tech_grain", name: "技术换粮", rarity: "common", need: { techMin: 0.30 }, ops: [{ t: "stock", k: "food", v: 50 }, { t: "tech", v: -0.01 }], effectText: "粮 +50 吨", costText: "科技 −0.01", followText: "—" },
          { id: "tr_slave_trade", name: "奴隶买卖", rarity: "common", need: { orderMin: 0.25 }, choices: ["sell", "buy"], ops: [], effectText: "卖：金属 +25 吨、人口 −20", costText: "买：人口 +20、金属 −35 吨", followText: "—" },
          { id: "tr_relic_auction", name: "古物拍卖", rarity: "epic", need: { orderMin: 0.40 }, choices: ["tech", "god", "thralls"], ops: [{ t: "stock", k: "metal", v: -60 }], effectText: "随机：科技 +0.04 / 古神契约 / 眷属 +3", costText: "金属 −60 吨", followText: "—" },
          { id: "tr_water_rights", name: "水权交易", rarity: "common", need: { orderMin: 0.25 }, ops: [{ t: "stock", k: "water", v: 200 }, { t: "stock", k: "metal", v: -18 }], effectText: "水 +200 吨", costText: "金属 −18 吨", followText: "—" },
          { id: "tr_drug_market", name: "药品黑市", rarity: "rare", need: { orderMin: 0.30 }, ops: [{ t: "stock", k: "drug", v: 80 }, { t: "order", v: -0.02 }], effectText: "药剂 +80", costText: "秩序 −2%", followText: "—" },
          { id: "tr_supply_contract", name: "长期补给合约", rarity: "epic", need: { orderMin: 0.40 }, ops: [{ t: "mod", key: "foodPerYear", v: 10, weeks: 10400 }, { t: "mod", key: "metalPerYear", v: 6, weeks: 10400 }, { t: "stock", k: "metal", v: -30 }, { t: "order", v: -0.02 }], effectText: "粮 +10 t/年、金属 +6 t/年（200 年）", costText: "金属 −30 t 定金", followText: "—" },
          { id: "tr_star_chart", name: "星图交换", rarity: "legendary", need: { techMin: 0.50 }, ops: [{ t: "peek", v: 3 }, { t: "tech", v: 0.03 }, { t: "stock", k: "metal", v: -40 }, { t: "mod", key: "encounter.oldgod", v: 0.10, weeks: 2600 }], effectText: "预览未来 3 次奇遇类别、科技 +0.03", costText: "金属 −40 吨", followText: "古神权重 +0.10" }
        ]
      }
    },

    /* ---------------- 千年节点 / 自动推演 / 胜负（run） ----------------
       每轮 1000 年一次节点；41 轮（41,000 年）胜利；7 条失败按优先级。
       时间闸门：未选身份、节点挂起、终局时 step() 不再推进。 */
    run: {
      enabled: true,
      targetYear: 41000,
      targetLoops: 41,
      autoChunkYears: 1,
      autoDefault: false,
      nodeYears: 1000,
      fail: {
        minPopulation: 200,
        orderCollapseWeeks: 26,
        famineWeeks: 12,
        machineDepts: 4,
        thrallShare: 0.75,
        thrallCount: 1200,
        l2EmptyWeeks: 26
      }
    },

    /* ---------------- 航速（首页三项操控的引擎钩子） ----------------
       速度只存一个数：state.ship.speedC。能耗、磨损、遭遇权重都从这里换算，
       不在别处再写死系数。speedBaseC 是「1.0 倍」的锚点，旧档没有 ship 时补这个值。 */
    ship: {
      speedC: 0.045,              // 当前巡航速度（光速倍）
      speedBaseC: 0.045,          // 基准速度：倍率 r = speedC / speedBaseC
      speedMin: 0.020,
      speedMax: 0.065,
      energyK: 0.60,              // 能耗乘子 = 1 + energyK × (r − 1)
      wearK: 1.20,                // 磨损恶化乘子 = 1 + wearK × (r − 1)
      // 遭遇权重按类别乘 r^K：危机/探索随速度升，贸易/舒适随速度降
      encounterK: { crisis: 1.5, explore: 0.9, tech: 0.2, trade: -0.8, society: -0.6 }
    },

    /* ---------------- 首页 HUD 三项操控（配给 / 休眠 / 航速） ----------------
       结算单位 = HUD 当前选中的档位；1 周=1、1 月=4、1 季=12、1 年=52、10 年=520。
       幅度随档位放大但有上下限；身份不够长时按身份上限结算并显示。 */
    hud: {
      enabled: true,
      spanRefWeeks: 12,           // 幅度基准：一季 12 周
      spanScaleMin: 0.25,
      spanScaleMax: 4.0,
      orderCostK: 0.025,          // 配给变动对秩序的代价系数（法令是 0.05，HUD 减半）
      minAwake: 1500,             // 休眠硬下限：无论怎么控，船上至少留这么多醒着
      lockExtraPeriod: false,     // false：点一次只走一个档位，下一项立刻可点（默认）；
                                  // true ：再留同长共享窗口，窗口内三项都不能动
      params: {
        ration:   { baseStep: 0.06,  maxStep: 0.10, min: 0.60, max: 1.20, tri: [0.60, 1.00, 1.50] },
        dormancy: { baseStep: 0.05,  maxStep: 0.06, min: 0.00, max: 0.60, tri: [0.50, 1.00, 1.60] },
        speed:    { baseStep: 0.004, maxStep: 0.006, min: 0.020, max: 0.065, tri: [0.70, 1.00, 1.40] }
      },
      roles: {
        creator: { label: "创造模式", w: 1.00, maxWeeks: 520 },
        ruler:   { label: "最高贵族", w: 1.00, maxWeeks: 520,
                   gate: { dominionMin: 45, healthMin: 30, authorityMin: 80, confined: false, interrogated: false } },
        mid:     { label: "中层贵族", w: 0.60, maxWeeks: 52, speedMax: 0.050,
                   gate: { authorityMin: 40 } },
        machine: { label: "机器路线", w: 0.45, maxWeeks: 12,
                   gate: { techMin: 0.55, authorityMax: 0.62, maintGapMax: 0.45 } }
      }
    },

    /* ---------------- 周期事件：设备故障 / 维修 / 轮班 / 补给 / 检疫 ----------------
       这些是周级事件，只有周步长才能表示。
       enabled：只往事件流写检修 / 轮班 / 补给 / 检疫，不改任何数值（默认开）。
       downtime：故障停机模型，开启后故障期间农环产出 ×0.55 并记 MTTR（默认关，
                 因为当前粮食余量≈0，任何停机都会把基线推向短缺）。 */
    maintenance: {
      enabled: true,            // 周期事件（周级）总开关：检修 / 轮班 / 补给 / 检疫
      downtime: false,          // 故障停机模型：开启后故障期间农环降载（会改数值）
      mttrWeeks: 3,             // MTTR 基准（可调 1–6 周）
      mttrMinWeeks: 1,
      mttrMaxWeeks: 6,
      baseIntervalWeeks: 26,    // 无磨损、无缺料时的平均无故障间隔
      wearShorten: 0.55,        // 磨损对故障间隔的缩短比例（最多 −55%）
      gapShorten: 0.30,         // 维修缺口对故障间隔的缩短比例（最多 −30%）
      minIntervalWeeks: 4,      // 故障间隔下限
      downtimeYield: 0.55,      // 停机期间农环产出系数
      cycleWeeks: 12,           // 例行检修窗口：每季一次（一季按 12 周）
      shiftWeeks: 12,           // 轮班周期（每季换班，一季按 12 周）
      supplyWeeks: 26,          // 补给窗口：每半年一次
      supplyFoodT: 18,          // 补给窗口到货：粮食 +18 t（判定成立时）
      supplyMetalT: 12,         // 补给窗口到货：金属 +12 t
      quarantineWeeks: 26,      // 隔离检疫窗口：每半年一次
      quarantineShare: 0.15     // 感染面超过该值时检疫事件升级为「事件」级
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
      comfort: { wRation: 0.40, wWear: 0.25, wMed: 0.20, wCrowd: 0.15,
                 center: 0.82, width: 0.20, maxPenalty: 25 },
      will: { expK: 5.5, comfortStart: 0.75, comfortSpan: 0.35, comfortGain: 18,
              expPerWeek: perWeek(0.005) },   // 原 经验 +0.005/月 → 0.00115/周
      trauma: { oK: 3.0, oCap: 18, wK: 2.5, wCap: 15, decay: 0.08 },

      // 教育迁移：40–50 年量级完成 1%【用户定】
      // 原 0.0010/月 ≈ 44 年；按周等比例折算
      eduMigration: { rate: perWeek(0.0010), expK: 0.30, wGain: 12, oLoss: 6, weeks: monthsToWeeks(36) },

      dominion: { base: 38, ageK: 0.30, netK: 10, execK: 10, spanBase: 8, spanK: 0.42 },
      stress: { oK: 0.55, wK: 0.30, structK: 0.15, infK: 0.10,
                breakAt: 0.55, breakWeeks: monthsToWeeks(2), spread: 0.20 },

      // 五级阶梯：每级进入/退出/持续（连续月数 → 周数）
      ladder: {
        l1At: 0.45, l1Weeks: monthsToWeeks(2),
        l2At: 0.55, l2Weeks: monthsToWeeks(3), l2QueueShare: 0.15, l2Exit: 0.45, l2ExitWeeks: monthsToWeeks(2),
        l3Depts: 2, l3Weeks: monthsToWeeks(2), l3K: 0.50, l3Exit: 3,
        l4Coverage: 0.40, l4Weeks: monthsToWeeks(2), l4D: 50,
        l5D: 30, l5Coverage: 0.50, l5Weeks: monthsToWeeks(3), l5HoldWeeks: monthsToWeeks(6),
        prodMul: [1, 0.98, 0.65, 0.40, 0.20, 0.10],
        deathPerWeek: [0, 0, perWeek(0.0015), perWeek(0.004), perWeek(0.010), perWeek(0.020)],
        orderPerLevel: 0.06
      },

      // 扑灭手段：全部有成本；镇压消耗警备耐久与金属，不动战斗编制
      // 所有时长/冷却由「月」换成「周」；食品成本按周消费量折算
      actions: {
        suppress: { label: "武力镇压", o: 12, oDecay: 6, w: 1.2, wWeeks: monthsToWeeks(6),
                    durCost: 8, metal: 6, wear: 0.05, death: 0.004, order: -0.02,
                    cdWeeks: monthsToWeeks(6), uses: [1, 0.60, 0.35], fanatic: 1,
                    note: "消耗警备耐久 8 点、金属 6 吨，镇压机磨损；长期镇压会让人更不服" },
        concede:  { label: "让步加配额", o: 8, w: -2, foodShare: 0.04, foodWeeks: monthsToWeeks(6),
                    order: 0.02, cdWeeks: monthsToWeeks(12), uses: [1, 0.50, 0.30],
                    note: "补发 4% 口粮配额 6 个月量，直接吃粮食储备" },
        execute:  { label: "处决领头", o: 18, oDecay: 3, w: 3, death: 0.002, d: -5,
                    cdWeeks: monthsToWeeks(9), uses: [1, 0.55, 0.30],
                    note: "短期服从 +18（恐惧），不服永久 +3，统御力 −5" },
        replace:  { label: "换掉中层贵族", o: 5, d: -8, spread: 0.12, cdWeeks: monthsToWeeks(12), uses: [1, 0.70, 0.45],
                    note: "损失统御力积累，其他人的压力 +0.12，可能开新裂口" },
        interrogate: { label: "潜伏机审讯", o: 6, w: 2, metal: 4, durCost: 2,
                    iso: 0.10, isoWeeks: monthsToWeeks(3),
                    cdWeeks: monthsToWeeks(4), uses: [1, 0.80, 0.60], needInfiltrator: true,
                    note: "潜伏机混入人群审讯，不需编队出动；消耗金属 4 吨与耐久 2 点" },
        lockdown: { label: "封锁隔离", w: 1, durCost: 2, metal: 3,
                    prodMul: 0.85, prodWeeks: monthsToWeeks(3),
                    iso: 0.25, isoWeeks: monthsToWeeks(3), infSpread: 0.60,
                    cdWeeks: monthsToWeeks(3), uses: [1, 0.80, 0.65],
                    note: "产出 −15%，感染扩散 −40%，隔离执行度 +0.25，持续 3 个月量" },
        ritual:   { label: "仪式宣传", o: 6, w: -1, foodShare: 0.01, foodWeeks: monthsToWeeks(1),
                    needL1: true, cdWeeks: monthsToWeeks(3), uses: [1, 0.75, 0.50],
                    note: "消耗 1% 口径的口粮；L1 死亡后失效" }
      },

      // 机器哗变：连锁数由科技等级决定
      machine: {
        techHydro: 0.55, techClone: 0.25, techMed: 0.20,
        at: 0.65, weeks: monthsToWeeks(2), oLow: 45,
        secondAt: 0.72, secondMaint: 0.55, secondEnergy: 0.12,
        thirdAt: 0.80,
        maxChainBase: 1, maxChainTech: 3,   // 科技 0→1 个，满级→3 个
        firstDept: "农环",
        prodLoss: 0.15, procWeeks: monthsToWeeks(3), procMul: 0.60,
        overrideMW: 5, overrideMetal: 30,
        energyHistWeeks: 52                 // 原 12 个月窗口 → 52 周
      },

      // 感染：全人群累积；贵族抵抗系数低（不易感染），转化时间更长
      // base/ageK/... 为「每月对感染度 C 的加成」，按 ×12/52 折到周
      infection: {
        // 全船感染累积的整体时间尺度：1 = 原速率；调低即整体放慢感染演化
        // v1.1 平衡：1 → 0.126，被动不动约 980–990 年自然崩坏，轻度经营可过千年
        growthMul: 0.126,
        base: perWeek(0.006), ageK: perWeek(0.0018), ageCap: 25,
        lifeK: perWeek(0.0001), lifeFloor: 40,
        mutK: perWeek(0.030), isoK: perWeek(0.040), densityK: perWeek(0.020),
        medK: perWeek(0.030), execK: perWeek(0.100), cap: perWeek(0.80),   // 原 0.80/月上限 → 0.185/周
        resist: { L1: 0.35, L2: 0.45, L3: 0.70, L4n: 0.90, L4c: 1.00 },
        hearing: 30, deform: 60, thrall: 85,
        thrallWeeks: { L1: monthsToWeeks(24), L2: monthsToWeeks(24),
                       L3: monthsToWeeks(18), L4: monthsToWeeks(12) },
        convertRate: perWeek(0.0025),        // 原 0.25%/月 → 0.0577%/周
        convertRateNoble: perWeek(0.0008)    // 原 0.08%/月 → 0.0185%/周
      },

      // 召唤：12 名 / 均值 55 / 峰值 90，连续 6 个月【用户定】
      // 产能惩罚是机械化程度的函数：机械越多，影响越小
      summon: {
        n: 12, meanC: 55, maxC: 90,
        weeks: monthsToWeeks(6),            // 原 连续 6 个月 → 26 周
        lockYears: 120,
        popLoss: 0.25, popWeeks: monthsToWeeks(24), orderLoss: 0.35,
        prodWeeks: monthsToWeeks(12),       // 产能惩罚 12 个月 → 52 周
        mechHydro: 0.40, mechClone: 0.25, mechWear: 0.20, mechMed: 0.15,
        prodBase: 0.45, prodMech: 0.55,
        laborBase: 0.70, laborExtra: 0.30,
        stressAdd: 0.25, permBase: perWeek(0.008),   // 永久基线：原 +0.008/月 → +0.00185/周
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
        robotMetalTpy: 24,         // 两型机器人维修金属（约 2 t/月，年量）
        recoverStrengthPerWeek: perWeek(0.5),     // 原 0.5 人/月 → 0.115 人/周
        recoverDur: perWeek(1.2),                 // 原 1.2 耐久/月 → 0.277/周
        recoverMetal: perWeek(3),                 // 原 3 t/月 → 1.385 t/周
        lackDurabilityPerWeek: perWeek(1.5),      // 原 缺料时耐久 −1.5/月 → −0.346/周
        suppressMetal: 6,
        suppressWear: 0.05,
        exposeWeeks: monthsToWeeks(18),           // 原 18 个月 → 78 周
        effectMin: 0.40
      },

      lifespan: { L1: 600, L2: 300, L3: 120, L4: 65, clone: 30 },  // 【推定】长生种
      // 手动触发参数：mutinyWeeks 为余震周数，期间持续压制 O / 抬高 W
      trigger: { mutinyS: 0.62, mutinyO: 16, mutinyW: 76, mutinyWeeks: monthsToWeeks(18),
                 infectC: 92, infectSpreadC: 68, infectSpreadC2: 62 }
    },

    /* ---------------- 页面滑块定义 ---------------- */
    ui: {
      sliders: [
        { key: "ration",         group: "人口与消费", label: "粮食配给比例",   min: 0.60, max: 1.20, step: 0.01, unit: "×",   digits: 2, path: "ration",   note: "直接乘口粮需求；压低能省粮，但营养与秩序会掉" },
        { key: "birthQuota",     group: "人口与消费", label: "生育配额",       min: 0,    max: 90,   step: 1,    unit: "人/年", digits: 0, path: "birth",    note: "自然出生上限，受营养、医疗、秩序折损" },
        { key: "cloneBatch",     group: "人口与消费", label: "克隆批次频率",   min: 0,    max: 2,    step: 0.05, unit: "×",   digits: 2, path: "clone",    note: "1.0 = 96 筒约 38 具/年；>1.05 会触发克隆槽扩建" },
        { key: "dormancyTarget", group: "人口与消费", label: "休眠推进力度",   min: 0,    max: 0.60, step: 0.01, unit: "占比", digits: 0, percent: true, path: "dormancy", note: "目标休眠人数占船上总人数；受舱位、药剂、最低醒态限制" },

        { key: "hydroTarget",    group: "生产与资源", label: "水培扩建投入",   min: 0,    max: 30,   step: 1,    unit: "单元/年", digits: 0, path: "hydro", note: "1 单元 = 1000 平方米等效栽培面；建设有 26 周滞后" },
        { key: "metalHydro",     group: "生产与资源", label: "金属分配 · 水培", min: 0,   max: 100,  step: 1,    unit: "%",  digits: 0, path: "metal",    note: "四份金属配额自动归一化；给水培多，维修就少" },
        { key: "metalPods",      group: "生产与资源", label: "金属分配 · 休眠舱", min: 0, max: 100,  step: 1,    unit: "%",  digits: 0, path: "metal",    note: "目标休眠超过舱位时自动开工" },
        { key: "metalClone",     group: "生产与资源", label: "金属分配 · 克隆槽", min: 0, max: 100,  step: 1,    unit: "%",  digits: 0, path: "metal",    note: "克隆批次 > 1.05 且筒数不足时自动开工" },
        { key: "metalMaint",     group: "生产与资源", label: "金属分配 · 维修", min: 0,   max: 100,  step: 1,    unit: "%",  digits: 0, path: "metal",    note: "低于 450 吨/年刚需会累积磨损，压低供电与产量" },
        { key: "agriShare",      group: "生产与资源", label: "能源分配 · 农业", min: 0.30, max: 0.85, step: 0.01, unit: "占比", digits: 0, percent: true, path: "energy", note: "生保 16 MW 先扣；剩余在农业与工业之间分" },

        { key: "medical",        group: "保障与底线", label: "医疗投入",       min: 0,    max: 1,    step: 0.01, unit: "占比", digits: 0, percent: true, path: "medical", note: "影响疾病死亡、生育、克隆质量、复温失败率" },
        { key: "extreme",        group: "保障与底线", label: "允许极端措施",   min: 0,    max: 1,    step: 1,    unit: "", toggle: true, path: "extreme", note: "危机时压低死亡，但秩序长期受损；是底线事件的前提" },
        { key: "planetCut",      group: "保障与底线", label: "行星补给中断",   min: 0,    max: 1,    step: 1,    unit: "", toggle: true, path: "food", note: "情景开关：用来复现「食物减少」的起点" }
      ]
    }
  };

  // 时间工具单独挂出，供引擎 / 主站适配层 / 验收脚本共用（不进 CONFIG，避免 JSON 克隆丢函数）
  global.XuanShuTime = {
    WEEKS_PER_YEAR: WEEKS_PER_YEAR,
    WEEKS_PER_QUARTER: WEEKS_PER_QUARTER,
    WEEKS_PER_MONTH: WEEKS_PER_MONTH,
    perWeek: perWeek,
    powWeek: powWeek,
    monthsToWeeks: monthsToWeeks
  };

  // 全船唯一随机数流：sim-core 的噪声、sim-judge 的判定、sim-people 的分配
  // 都从这里取，保证「同 seed + 同操作序列」整船逐位可复现。
  // 状态只有一个 32 位整数 state.rngA，随 exportState / importState 一起走。
  global.XuanShuRand = {
    next: function (state) {
      state.rngA = (state.rngA | 0) + 0x6D2B79F5 | 0;
      var t = Math.imul(state.rngA ^ (state.rngA >>> 15), 1 | state.rngA);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    },
    stateOf: function (state) { return state.rngA | 0; }
  };

  global.XUANSHU_CONFIG = CONFIG;
  if (typeof module !== "undefined" && module.exports) module.exports = CONFIG;
})(typeof globalThis !== "undefined" ? globalThis : this);
