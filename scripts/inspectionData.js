/**
 * 机车检查作业步骤体系
 * ---------------------------------------------------------------------------
 * 车型：HXD3D 型交流传动六轴干线客运电力机车
 * 组织方式：按"检查路线 → 检查部位（环节）→ 检查项"三级组织
 *
 * 三维定位约定（focus）：
 *   type: 'node'   绑定模型中真实存在的独立节点（受电弓、车钩），可精确高亮
 *   type: 'region' 用归一化空间分区定位。u=车长方向(0尾端→1前端)
 *                  v=车高方向(0轨面→1车顶) w=车宽方向(0右侧→1左侧)
 *                  运行时按模型实际包围盒换算，不依赖硬编码坐标
 *   type: 'none'   司机室内/试验类作业，不做三维定位
 *
 * 部件裁剪与故障标记（partInspection 输入）：
 *   每个检查项可定义 fault 字段，包含：
 *     region   归一化裁剪区域（同 focus.regions 但更小，精确到部件级别）
 *     partType 'structural' | 'electrical' | 'brake'
 *     faults   期望的故障标记配置数组，每项含 colorType / keywords / count
 *
 * 说明：检查要点与合格标准按通用机车检查作业规范整理，用于教学演练；
 *      现场作业须以本局段现行《机车操作规程》《机车检查作业标准》为准。
 */

export const INSPECTION_META = {
  locomotive: 'HXD3D型电力机车',
  shortName: 'HXD3D',
  spec: '交流传动 · 六轴 · 干线客运',
  title: '机车检查作业',
  subtitle: 'LOCOMOTIVE INSPECTION OPERATION',
  version: 'V1.0',
  keyFacts: [
    { label: '额定功率', value: '7,200 kW' },
    { label: '最高运营速度', value: '160 km/h' },
  ],
  disclaimer:
    '本系统为教学演练环境。检查项、要点与合格标准整理自通用机车检查作业规范，' +
    '实际作业请严格执行本局段现行规程与调度命令。',
}

/** 检查方式枚举，用于界面徽标 */
export const METHOD_LABELS = {
  visual: '目视',
  touch: '手触',
  tap: '锤击',
  measure: '测量',
  test: '试验',
  listen: '听音',
}

/** 风险等级：A=关键项（不合格禁止出库） B=重要项 C=一般项 */
export const LEVEL_LABELS = {
  A: { text: '关键项', hint: '不合格禁止出库' },
  B: { text: '重要项', hint: '需记录并处置' },
  C: { text: '一般项', hint: '可临修处理' },
}

export const INSPECTION_ROUTES = [
  // ─────────────────────────── 01 车顶高压设备 ───────────────────────────
  {
    id: 'roof',
    order: 1,
    name: '车顶高压设备检查',
    shortName: '受电弓 / 车顶',
    zone: '车顶高压设备区',
    side: '车顶',
    methodText: '目视 · 手触 · 测量',
    stdTime: '8 min',
    cardImage: 'assets/cards/pantograph.png',
    cardAlt: 'HXD3D型电力机车受电弓及车顶高压设备',
    summary:
      '确认受电弓、主断路器、避雷器及车顶绝缘子状态良好，无破损、放电痕迹与异物，' +
      '升弓压力与接触压力符合规定。',
    safety: [
      '必须确认接触网已停电、验电并挂好接地线后方可登顶',
      '登顶须系安全带、穿防滑鞋，严禁踩踏绝缘子与瓷裙',
      '雷雨、大风等恶劣天气禁止登顶作业',
    ],
    focus: {
      type: 'node',
      nodes: ['Pantograph_Controllable', 'Pantograph_SourceLowered'],
      regions: [{ u: [0.3, 0.78], v: [0.82, 1.0], w: [0, 1] }],
      camera: { dir: [0.45, 0.85, 0.95], distance: 0.62 },
    },
    items: [
      {
        id: 'roof-1',
        name: '受电弓滑板与弓头',
        level: 'A',
        methods: ['visual', 'measure'],
        points: [
          '检查碳滑板有无裂纹、掉块、偏磨，磨耗是否到限',
          '检查弓头有无变形、松动，滑板托架是否平整',
          '测量滑板剩余厚度，两滑板厚度差不得超过规定值',
        ],
        standard: '滑板无裂纹掉块，剩余厚度不小于规定限度；弓头无变形松动，两滑板厚度一致',
        risk: '滑板磨耗到限或裂纹会导致断弓、刮网，属严重行车隐患',
        fault: {
          region: { u: [0.36, 0.46], v: [0.84, 0.92], w: [0.42, 0.58] },
          partType: 'structural',
          faults: [
            { colorType: 'white', keywords: ['裂纹', '裂痕', '破损'], count: 1 },
          ],
        },
      },
      {
        id: 'roof-2',
        name: '受电弓框架与升弓装置',
        level: 'A',
        methods: ['visual', 'touch'],
        points: [
          '检查上下框架、连杆、铰链有无变形裂纹，连接销是否齐全',
          '检查升弓弹簧、气囊（风缸）有无破损漏气',
          '检查升弓钢丝绳有无断股、锈蚀',
        ],
        standard: '框架无变形裂纹，连接紧固无松旷；升弓装置无漏气，钢丝绳无断股',
        risk: '升弓装置失效将造成无法受流，运行中掉弓会引发弓网事故',
        fault: {
          region: { u: [0.34, 0.48], v: [0.78, 0.86], w: [0.42, 0.58] },
          partType: 'structural',
          faults: [
            { colorType: 'white', keywords: ['裂纹', '变形', '裂损'], count: 1 },
          ],
        },
      },
      {
        id: 'roof-3',
        name: '车顶绝缘子与支持瓷瓶',
        level: 'A',
        methods: ['visual'],
        points: [
          '检查支持绝缘子表面有无裂纹、破损、闪络痕迹',
          '检查瓷裙有无放电烧伤、污秽积聚',
          '检查绝缘子与车体、受电弓连接螺栓有无松动',
        ],
        standard: '瓷件无裂纹破损、无放电痕迹，表面清洁，连接螺栓紧固无松动',
        risk: '绝缘子破损会造成车顶高压接地，导致跳闸甚至设备烧损',
        // 出勤检查时车顶电器设备实际看不见（需登顶且停电），不做三维检视交互
      },
      {
        id: 'roof-4',
        name: '主断路器与避雷器',
        level: 'A',
        methods: ['visual'],
        points: [
          '检查主断路器外观有无破损、漏气漏油',
          '检查避雷器瓷套有无裂纹、破损、放电痕迹',
          '检查高压隔离开关、接地开关位置是否正确',
        ],
        standard: '外观完好无损伤，各部无放电痕迹；开关位置与运行要求一致',
        risk: '主断路器或避雷器损坏会造成高压故障，影响供电与行车安全',
        // 同上：车顶设备在出勤整备中不做三维检视交互
      },
      {
        id: 'roof-5',
        name: '车顶母线与车顶设备紧固',
        level: 'B',
        methods: ['visual', 'touch'],
        points: [
          '检查车顶高压母线、软连接有无断股、过热变色',
          '检查车顶各设备安装螺栓、防松标记是否错位',
          '检查车顶有无遗留工具、异物',
        ],
        standard: '母线连接紧固无过热变色，防松标记无错位，车顶无遗留异物',
        risk: '遗留异物或螺栓松动可能在运行中脱落，造成设备损坏或侵限',
      },
    ],
  },

  // ─────────────────────────── 02 司机室 ───────────────────────────
  {
    id: 'cab',
    order: 2,
    name: '司机室设备检查',
    shortName: '司机室',
    zone: '司机室操纵区',
    side: '车内',
    methodText: '目视 · 操作试验',
    stdTime: '10 min',
    cardImage: 'assets/cards/front-end.png',
    cardAlt: 'HXD3D型电力机车端部与司机室',
    summary:
      '确认操纵台各控制器、仪表显示、监控装置、通信设备、制动控制器及安全装备齐全完好，' +
      '各开关位置正确，灭火器有效。',
    safety: [
      '操作试验前须确认机车已采取防溜措施',
      '进行制动机试验前须确认车下无人作业',
      '试验鸣笛、刮雨器前应确认前方无人员',
    ],
    focus: {
      type: 'region',
      regions: [
        { u: [0.04, 0.26], v: [0.42, 0.88], w: [0, 1] },
        { u: [0.74, 0.96], v: [0.42, 0.88], w: [0, 1] },
      ],
      camera: { dir: [-0.95, 0.42, 0.85], distance: 0.5 },
    },
    items: [
      {
        id: 'cab-1',
        name: '司控器（牵引/制动手柄）',
        level: 'A',
        methods: ['visual', 'test'],
        points: [
          '检查牵引手柄、换向手柄外观完好，无卡滞',
          '各档位动作灵活，定位清晰，无松旷',
          '手柄机械联锁、钥匙联锁作用良好',
        ],
        standard: '手柄动作灵活无卡滞，档位定位准确，联锁作用可靠',
        risk: '司控器卡滞或档位错乱会造成牵引/制动失控',
      },
      {
        id: 'cab-2',
        name: '制动控制器与压力表',
        level: 'A',
        methods: ['visual', 'test'],
        points: [
          '检查制动控制器手柄位置正确，动作灵活',
          '检查均衡风缸、列车管、制动缸压力表指示正常且在校验有效期内',
          '检查压力表玻璃完好，指针无卡滞',
        ],
        standard: '手柄动作灵活，各压力表指示正确、校验有效，玻璃完好',
        risk: '压力表失准会导致制动判断错误，直接威胁行车安全',
      },
      {
        id: 'cab-3',
        name: '监控装置 LKJ 与信号显示',
        level: 'A',
        methods: ['visual', 'test'],
        points: [
          '检查 LKJ 主机、显示器外观完好，接线牢固',
          '开机自检正常，显示内容与机车型号、车次一致',
          '检查机车信号机显示正常，上下行开关位置正确',
        ],
        standard: '装置自检通过，显示正确；机车信号显示与地面信号一致',
        risk: '监控或信号显示异常会造成超速、冒进等严重事故',
      },
      {
        id: 'cab-4',
        name: '通信设备与列尾装置',
        level: 'B',
        methods: ['visual', 'test'],
        points: [
          '检查 CIR 电台、手持终端外观完好，天线无损坏',
          '进行通话试验，话音清晰，呼叫应答正常',
          '检查列尾装置主机连接正常，风压查询正常',
        ],
        standard: '设备安装牢固，通话清晰，列尾风压查询与确认功能正常',
        risk: '通信中断会造成调度指令无法下达，列尾失效将失去尾部风压监控',
      },
      {
        id: 'cab-5',
        name: '仪表、开关与指示灯',
        level: 'B',
        methods: ['visual', 'test'],
        points: [
          '检查各仪表、指示灯外观完好，通电后显示正常',
          '检查各琴键开关、扳钮开关位置正确、动作可靠',
          '进行故障指示灯自检，确认无异常常亮',
        ],
        standard: '仪表指示正常，开关位置正确动作可靠，自检无异常告警',
        risk: '仪表或指示灯失效会掩盖设备真实故障状态',
      },
      {
        id: 'cab-6',
        name: '安全装备与消防设施',
        level: 'A',
        methods: ['visual'],
        points: [
          '检查灭火器数量、型号符合要求，压力表在绿区，铅封完好',
          '检查紧急制动阀、放风阀铅封完好',
          '检查安全防护用品、随车备品齐全',
        ],
        standard: '灭火器在有效期内压力正常，紧急设备铅封完好，备品齐全',
        risk: '消防与紧急设备缺失会在突发情况下造成严重后果',
      },
      {
        id: 'cab-7',
        name: '门窗、刮雨器与照明',
        level: 'C',
        methods: ['visual', 'test'],
        points: [
          '检查前窗玻璃无破损、视线良好',
          '试验刮雨器动作灵活，刮片贴合良好',
          '检查司机室照明、风扇、取暖装置工作正常',
        ],
        standard: '玻璃完好视线清晰，刮雨器动作正常，照明与司乘环境设施完好',
        risk: '视线受阻会直接影响瞭望，危及行车安全',
        fault: {
          region: { u: [0.04, 0.1], v: [0.5, 0.72], w: [0.4, 0.6] },
          partType: 'structural',
          faults: [
            { colorType: 'white', keywords: ['裂纹', '破损', '裂痕'], count: 1 },
          ],
        },
      },
    ],
  },

  // ─────────────────────────── 03 机械间 / 设备舱 ───────────────────────────
  {
    id: 'machine',
    order: 3,
    name: '机械间与设备舱检查',
    shortName: '机械间',
    zone: '车内设备舱区',
    side: '车内',
    methodText: '目视 · 听音 · 手触',
    stdTime: '10 min',
    cardImage: 'assets/cards/left-side.png',
    cardAlt: 'HXD3D型电力机车左侧车体与设备舱',
    summary:
      '确认主变流、辅助变流、牵引通风、空气压缩机组及制动柜等设备安装牢固、接线良好、' +
      '无过热烧损与泄漏，滤尘器清洁。',
    safety: [
      '设备舱内作业须在断电降弓、放电完成后进行',
      '严禁触摸高压带电部位，柜门开启后防止挤伤',
      '旋转部件附近作业须防止衣物、工具卷入',
    ],
    focus: {
      type: 'region',
      regions: [{ u: [0.32, 0.7], v: [0.3, 0.88], w: [0, 1] }],
      camera: { dir: [0.15, 0.55, 1.25], distance: 0.48 },
    },
    items: [
      {
        id: 'machine-1',
        name: '主变流器柜与牵引电机',
        level: 'A',
        methods: ['visual', 'listen'],
        points: [
          '检查变流器柜体外观完好，柜门锁闭到位',
          '检查功率模块、母排连接无过热变色、无放电痕迹',
          '检查冷却管路无渗漏，冷却液位正常',
        ],
        standard: '柜体完好锁闭，母排连接无过热变色，冷却系统无渗漏、液位正常',
        risk: '变流器故障会造成牵引丢失，运行中停车',
        fault: {
          region: { u: [0.38, 0.5], v: [0.4, 0.62], w: [0.3, 0.7] },
          partType: 'electrical',
          faults: [
            { colorType: 'red', keywords: ['烧损', '烧蚀', '过热', '变色'], count: 1 },
            { colorType: 'red', keywords: ['烧损', '过热'], count: 1 },
          ],
        },
      },
      {
        id: 'machine-2',
        name: '牵引通风机与冷却系统',
        level: 'B',
        methods: ['visual', 'listen', 'touch'],
        points: [
          '检查通风机外观完好，防护网无破损',
          '通电试验运转平稳无异音，转向正确',
          '检查风道无堵塞，滤尘器清洁无积尘',
        ],
        standard: '通风机运转平稳无异音，风道畅通，滤尘器清洁',
        risk: '通风不良会导致牵引电机与变流器过热保护，造成牵引封锁',
      },
      {
        id: 'machine-3',
        name: '空气压缩机组与干燥器',
        level: 'A',
        methods: ['visual', 'listen', 'test'],
        points: [
          '检查压缩机外观完好，油位在规定刻线内',
          '检查空气干燥器工作正常，排污阀作用良好',
          '试验压缩机启停压力符合规定，运转无异音',
        ],
        standard: '油位正常，干燥器与排污良好，启停压力符合规定，运转无异音',
        risk: '风源故障会造成全列车制动失效，属重大安全隐患',
      },
      {
        id: 'machine-4',
        name: '制动柜与管路',
        level: 'A',
        methods: ['visual', 'touch'],
        points: [
          '检查制动柜各阀件、模块安装牢固，无松动',
          '检查管路、接头无漏泄，管卡齐全无磨碰',
          '检查各塞门位置正确，铅封完好',
        ],
        standard: '制动柜阀件紧固，管路无漏泄，塞门位置正确铅封完好',
        risk: '管路漏泄会造成制动减压异常，直接影响制动能力',
        fault: {
          region: { u: [0.5, 0.62], v: [0.34, 0.58], w: [0.32, 0.65] },
          partType: 'electrical',
          faults: [
            { colorType: 'red', keywords: ['漏泄', '渗油', '漏油', '漏气'], count: 1 },
          ],
        },
      },
      {
        id: 'machine-5',
        name: '辅助变流与控制电源',
        level: 'B',
        methods: ['visual', 'measure'],
        points: [
          '检查辅助变流器、充电机外观完好，接线牢固',
          '检查控制电源柜熔断器、开关位置正确',
          '测量蓄电池电压符合规定，接线柱无松动腐蚀',
        ],
        standard: '设备外观完好接线牢固，蓄电池电压符合规定，接线无腐蚀',
        risk: '控制电源失效会导致机车无法升弓、无法操纵',
      },
      {
        id: 'machine-6',
        name: '设备舱防火与整洁',
        level: 'B',
        methods: ['visual'],
        points: [
          '检查设备舱内无油污、无杂物、无遗留工具',
          '检查火灾报警探测器外观完好',
          '检查电缆穿墙孔封堵完好',
        ],
        standard: '舱内清洁无杂物无油污，火灾报警装置完好，封堵严密',
        risk: '油污杂物是机械间火灾的主要诱因',
      },
    ],
  },

  // ─────────────────────────── 04 走行部 ───────────────────────────
  {
    id: 'bogie',
    order: 4,
    name: '走行部与转向架检查',
    shortName: '走行部',
    zone: '机车走行部',
    side: '车下',
    methodText: '目视 · 锤击 · 手触 · 测量',
    stdTime: '15 min',
    cardImage: 'assets/cards/running-gear.png',
    cardAlt: 'HXD3D型电力机车走行部与转向架',
    summary:
      '确认轮对、轴箱、悬挂装置、牵引电机与齿轮箱、基础制动装置状态良好，' +
      '各紧固螺栓无松动，无裂纹渗漏。',
    safety: [
      '车下作业须设置防护信号，机车两端挂禁动牌',
      '锤击检查注意力度与方向，防止伤及自身与他人',
      '检查闸片、轮对时严禁用手触摸踏面与制动盘',
    ],
    focus: {
      type: 'region',
      regions: [
        { u: [0.08, 0.4], v: [0, 0.34], w: [0, 1] },
        { u: [0.6, 0.92], v: [0, 0.34], w: [0, 1] },
      ],
      camera: { dir: [0.55, 0.32, 1.0], distance: 0.45 },
    },
    items: [
      {
        id: 'bogie-1',
        name: '轮对踏面与轮缘',
        level: 'A',
        methods: ['visual', 'measure', 'tap'],
        points: [
          '检查踏面有无擦伤、剥离、裂纹，磨耗是否到限',
          '测量轮缘厚度与高度、轮径差是否符合规定',
          '锤击检查轮箍（整体轮）有无松动，声音清脆为良',
        ],
        standard: '踏面无剥离裂纹，磨耗不超限；轮缘厚度与同轮对轮径差符合限度规定',
        risk: '踏面擦伤或轮缘到限会造成脱轨，属最严重走行部隐患',
        fault: {
          region: { u: [0.12, 0.2], v: [0.04, 0.14], w: [0.14, 0.32] },
          partType: 'structural',
          faults: [
            { colorType: 'white', keywords: ['裂纹', '剥离', '擦伤'], count: 1 },
          ],
        },
      },
      {
        id: 'bogie-2',
        name: '轴箱与一系弹簧',
        level: 'A',
        methods: ['visual', 'touch', 'measure'],
        points: [
          '检查轴箱端盖螺栓紧固，无漏油',
          '检查轴箱体无裂纹，防松标记无错位',
          '检查一系螺旋弹簧、橡胶垫无裂纹、折断、压溃',
          '手触检查轴箱温度，与相邻轴箱对比无明显异常',
        ],
        standard: '轴箱无漏油无裂纹，一系弹簧无裂折，螺栓紧固，温度与相邻位无明显差异',
        risk: '轴箱过热会发展为燃轴、切轴；一系弹簧断裂危及行车安全',
        fault: {
          region: { u: [0.12, 0.24], v: [0.14, 0.3], w: [0.16, 0.36] },
          partType: 'structural',
          faults: [
            { colorType: 'white', keywords: ['裂纹', '裂痕', '破损'], count: 1 },
            { colorType: 'white', keywords: ['裂纹', '折断', '裂损'], count: 1 },
          ],
        },
      },
      {
        id: 'bogie-3',
        name: '油压减震器与横向拉杆',
        level: 'B',
        methods: ['visual', 'tap'],
        points: [
          '检查垂向、横向油压减振器无漏油，连接销紧固',
          '检查轴箱拉杆、牵引拉杆无变形裂纹，橡胶节点无开裂',
          '检查减振器与拉杆安装座无裂纹、松动',
        ],
        standard: '减振器无漏油，各拉杆连接紧固无变形，橡胶节点完好',
        risk: '减振器或拉杆失效会加剧轮轨冲击，恶化运行品质',
        fault: {
          region: { u: [0.22, 0.36], v: [0.1, 0.26], w: [0.58, 0.84] },
          partType: 'structural',
          faults: [
            { colorType: 'white', keywords: ['裂纹', '变形', '裂损'], count: 1 },
            { colorType: 'red', keywords: ['漏油', '渗油', '漏泄'], count: 1 },
          ],
        },
      },
      {
        id: 'bogie-4',
        name: '二系悬挂弹簧',
        level: 'B',
        methods: ['visual', 'tap'],
        points: [
          '检查二系螺旋弹簧、橡胶垫无裂纹、折断、老化脱落',
          '检查弹簧上、下支座无裂纹，紧固件无松动',
          '检查高度调整装置作用良好，车体无异常倾斜',
        ],
        standard: '二系弹簧无裂折老化，支座无裂纹，紧固无松动',
        risk: '二系悬挂失效会造成车体侧倾、晃动，危及运行平稳',
        fault: {
          region: { u: [0.14, 0.32], v: [0.26, 0.36], w: [0.16, 0.4] },
          partType: 'structural',
          faults: [
            { colorType: 'white', keywords: ['裂纹', '折断', '裂损'], count: 1 },
          ],
        },
      },
      {
        id: 'bogie-5',
        name: '牵引电机与齿轮箱',
        level: 'A',
        methods: ['visual', 'touch'],
        points: [
          '检查牵引电机外观完好，接线盒密封良好，引线无破损',
          '检查齿轮箱无漏油，油位在规定刻线',
          '检查电机悬挂装置螺栓紧固，防松件齐全',
        ],
        standard: '电机外观完好接线牢固，齿轮箱无漏油油位正常，悬挂紧固',
        risk: '电机脱落或齿轮箱漏油会造成走行部重大故障',
        fault: {
          region: { u: [0.64, 0.8], v: [0.08, 0.24], w: [0.36, 0.64] },
          partType: 'electrical',
          faults: [
            { colorType: 'red', keywords: ['漏油', '渗油', '过热', '烧损'], count: 1 },
          ],
        },
      },
      {
        id: 'bogie-6',
        name: '基础制动装置与自动夹钳',
        level: 'A',
        methods: ['visual', 'measure'],
        points: [
          '检查制动缸、杠杆、拉杆无变形裂纹，连接销齐全',
          '检查自动夹钳（制动钳）无裂纹，闸片托无变形',
          '检查闸片（闸瓦）磨耗是否到限，厚度符合规定',
          '检查制动缸行程符合规定，缓解后闸片能正常回位',
        ],
        standard: '制动装置与自动夹钳无裂损，闸片厚度与制动缸行程符合规定，缓解良好',
        risk: '基础制动失效将直接导致制动距离延长甚至制动失灵',
        fault: {
          region: { u: [0.64, 0.8], v: [0.18, 0.3], w: [0.1, 0.34] },
          partType: 'brake',
          faults: [
            { colorType: 'white', keywords: ['裂纹', '裂痕', '变形'], count: 1 },
          ],
        },
      },
      {
        id: 'bogie-7',
        name: '撒砂装置与侧面沙箱',
        level: 'B',
        methods: ['visual', 'test'],
        points: [
          '检查砂箱砂量充足，砂质干燥无结块',
          '检查侧面沙箱安装牢固，箱体无裂纹变形',
          '检查撒砂器、管路畅通，撒砂作用良好',
        ],
        standard: '砂量充足砂质干燥，沙箱牢固无裂纹，撒砂畅通有效',
        risk: '撒砂失效会降低粘着利用，易造成空转与坡停',
        fault: {
          region: { u: [0.82, 0.92], v: [0.16, 0.3], w: [0.3, 0.7] },
          partType: 'structural',
          faults: [
            { colorType: 'white', keywords: ['裂纹', '变形', '裂损'], count: 1 },
          ],
        },
      },
      {
        id: 'bogie-8',
        name: '排障器与脚踏端部',
        level: 'B',
        methods: ['visual', 'tap'],
        points: [
          '检查排障器安装牢固，高度符合规定，无变形裂纹',
          '检查端部脚踏板、扶手安装牢固，无松动变形',
          '检查排障器与车体连接螺栓防松标记无错位',
        ],
        standard: '排障器牢固、高度符合规定无变形，扶手脚踏安装牢固',
        risk: '排障器或脚踏松动会造成异物卷入、司乘登乘坠落受伤',
        fault: {
          region: { u: [0.94, 1.0], v: [0.03, 0.16], w: [0.32, 0.68] },
          partType: 'structural',
          faults: [
            { colorType: 'white', keywords: ['裂纹', '变形', '裂损'], count: 1 },
          ],
        },
      },
    ],
  },

  // ─────────────────────────── 05 制动系统 ───────────────────────────
  {
    id: 'brake',
    order: 5,
    name: '制动系统检查',
    shortName: '制动系统',
    zone: '制动与风源系统',
    side: '车下 / 车内',
    methodText: '目视 · 试验 · 测量',
    stdTime: '12 min',
    cardImage: 'assets/cards/right-side.png',
    cardAlt: 'HXD3D型电力机车右侧车体',
    summary:
      '确认风源系统、总风缸、安全阀与基础制动装置状态良好，管路无漏泄，' +
      '制动与缓解作用正常，停放制动功能可靠。',
    safety: [
      '试验前确认车下、车顶无人作业，机车已防溜',
      '排风、排水时不得将风口对人',
      '处理漏泄时必须先排尽压力空气',
    ],
    focus: {
      type: 'region',
      regions: [{ u: [0.25, 0.75], v: [0.05, 0.4], w: [0, 1] }],
      camera: { dir: [-0.35, 0.35, 1.15], distance: 0.46 },
    },
    items: [
      {
        id: 'brake-1',
        name: '总风缸与安全阀',
        level: 'A',
        methods: ['visual', 'test'],
        points: [
          '检查总风缸安装牢固，无变形腐蚀',
          '检查安全阀铅封完好，校验在有效期内',
          '试验排水阀作用良好，排出积水与油污',
        ],
        standard: '风缸安装牢固无腐蚀，安全阀铅封完好校验有效，排水阀作用良好',
        risk: '安全阀失效会造成风压超高，导致管路爆裂',
      },
      {
        id: 'brake-2',
        name: '管路漏泄检查',
        level: 'A',
        methods: ['listen', 'test'],
        points: [
          '充风至规定压力后监听管路、接头有无漏泄声',
          '用检漏液检查各接头、阀件密封处',
          '按规定进行列车管漏泄试验，减压量符合标准',
        ],
        standard: '管路无漏泄，列车管每分钟漏泄量不超过规定值',
        risk: '漏泄超标会造成制动能力衰减、缓解不良',
      },
      {
        id: 'brake-3',
        name: '制动与缓解作用',
        level: 'A',
        methods: ['test', 'visual'],
        points: [
          '进行制动与缓解试验，制动缸活塞行程符合规定',
          '检查各制动单元动作同步，无卡滞',
          '缓解后确认闸片完全脱离，无拖磨现象',
        ],
        standard: '制动作用迅速、行程符合规定，缓解彻底无拖磨',
        risk: '制动不缓解会造成轮箍弛缓、踏面擦伤',
      },
      {
        id: 'brake-4',
        name: '停放制动装置',
        level: 'A',
        methods: ['visual', 'test'],
        points: [
          '检查停放制动缸及拉环、指示器完好',
          '试验停放制动施加与缓解作用可靠',
          '确认停放制动施加时机车不能移动',
        ],
        standard: '停放制动施加与缓解作用可靠，指示器显示正确',
        risk: '停放制动失效会造成机车溜逸',
      },
      {
        id: 'brake-5',
        name: '紧急制动与撒砂联锁',
        level: 'A',
        methods: ['test'],
        points: [
          '试验紧急制动阀作用，紧急制动时能迅速排风',
          '确认紧急制动时自动切断牵引并投入撒砂',
          '试验后按规定复位并重新充风',
        ],
        standard: '紧急制动作用迅速可靠，联锁撒砂与牵引切断功能正常',
        risk: '紧急制动失效是最危险的制动故障，直接危及生命安全',
      },
    ],
  },

  // ─────────────────────────── 06 车钩缓冲装置 ───────────────────────────
  {
    id: 'coupler',
    order: 6,
    name: '车钩缓冲装置检查',
    shortName: '车钩',
    zone: '前后端连接区',
    side: '端部',
    methodText: '目视 · 锤击 · 测量',
    stdTime: '8 min',
    cardImage: 'assets/cards/rear-end.png',
    cardAlt: 'HXD3D型电力机车后端部与车钩',
    summary:
      '确认前后车钩、钩舌、钩锁销、缓冲器及风管、电气连接线状态良好，' +
      '钩高符合规定，连接可靠。',
    safety: [
      '检查车钩时严禁将手伸入钩口与钩舌之间',
      '试验提钩时注意身体位置，防止碰伤',
      '机车不得在车钩检查期间移动',
    ],
    focus: {
      type: 'node',
      nodes: ['Coupler_PositiveX', 'Coupler_NegativeX'],
      regions: [
        { u: [0, 0.06], v: [0.15, 0.55], w: [0, 1] },
        { u: [0.94, 1], v: [0.15, 0.55], w: [0, 1] },
      ],
      camera: { dir: [-1.05, 0.45, 0.72], distance: 0.38 },
    },
    items: [
      {
        id: 'coupler-1',
        name: '车钩钩体与钩舌',
        level: 'A',
        methods: ['visual', 'tap'],
        points: [
          '检查钩体、钩舌有无裂纹，重点检查钩舌内侧与钩颈',
          '锤击检查钩体与钩尾框，声音清脆无哑音',
          '检查钩舌销、开口销齐全完好',
        ],
        standard: '钩体钩舌无裂纹，销件齐全完好，锤击声音清脆',
        risk: '车钩裂纹会导致列车分离，属最严重后果的故障之一',
        fault: {
          region: { u: [0.96, 1.0], v: [0.14, 0.22], w: [0.42, 0.58] },
          exterior: 'i-end',
          partType: 'structural',
          faults: [
            { faultType: 'crack', count: 1 },
          ],
        },
      },
      {
        id: 'coupler-2',
        name: '钩锁销与提钩装置',
        level: 'A',
        methods: ['visual', 'test'],
        points: [
          '检查钩锁销、锁铁作用灵活，无卡滞',
          '试验提钩杆动作，开锁、闭锁位置正确',
          '检查锁销防跳装置完好',
        ],
        standard: '钩锁作用灵活到位，提钩装置动作可靠，防跳装置完好',
        risk: '钩锁不到位会造成车钩自动分离',
        fault: {
          // 钩提销位于车钩上部中心，旧区间高度偏高，会误落到端部车体螺栓。
          region: { u: [0.965, 0.995], v: [0.145, 0.195], w: [0.465, 0.535] },
          reportPartName: '钩提销与提钩装置',
          exterior: 'i-end',
          partType: 'structural',
          faults: [{ faultType: 'loose-bolt', count: 1 }],
        },
      },
      {
        id: 'coupler-3',
        name: '缓冲器与从板座',
        level: 'B',
        methods: ['visual', 'tap'],
        points: [
          '检查缓冲器箱体无裂纹，无漏油',
          '检查从板、从板座、钩尾框无裂纹',
          '检查缓冲器与车体连接螺栓紧固',
        ],
        standard: '缓冲器与从板座无裂纹漏油，连接螺栓紧固',
        risk: '缓冲器失效会加剧纵向冲击，损坏车体与货物',
        fault: {
          region: { u: [0.91, 0.955], v: [0.13, 0.22], w: [0.40, 0.60] },
          reportPartName: '缓冲器与从板座',
          exterior: 'i-end',
          partType: 'structural',
          faults: [{ faultType: 'crack', count: 1 }, { faultType: 'loose-bolt', count: 1 }],
        },
      },
      {
        id: 'coupler-4',
        name: '车钩高度测量',
        level: 'B',
        methods: ['measure'],
        points: [
          '测量车钩中心线距轨面高度',
          '两端车钩高度及与车辆车钩高度差符合规定',
          '检查车钩中心线左右偏移量不超限',
        ],
        standard: '车钩高度在规定范围内，相连车钩高度差不超过规定值',
        risk: '钩高超限会造成连接困难或运行中脱钩',
        fault: {
          region: { u: [0.965, 1.0], v: [0.12, 0.18], w: [0.46, 0.54] },
          exterior: 'i-end',
          partType: 'structural',
          faults: [{ faultType: 'crack', count: 1 }],
        },
      },
      {
        id: 'coupler-5',
        name: '风管、塞门与电气连接线',
        level: 'A',
        methods: ['visual', 'test'],
        points: [
          '检查制动软管无老化裂纹，连接器完好，压力试验合格标记有效',
          '检查折角塞门作用灵活，位置正确，防尘堵齐全',
          '检查电气连接线、重联线座无破损，插针无变形',
        ],
        standard: '软管完好无裂纹，塞门作用灵活位置正确，电气连接线无破损',
        risk: '风管爆裂会造成列车紧急制动，电气连接不良会导致控制失效',
        fault: {
          region: { u: [0.965, 0.995], v: [0.18, 0.32], w: [0.26, 0.42] },
          reportPartName: '制动软管与折角塞门',
          exterior: 'i-end',
          partType: 'brake',
          faults: [
            { faultType: 'leak', count: 1 },
          ],
        },
      },
      {
        id: 'coupler-6',
        name: '电源插座与重联连接器',
        level: 'A',
        methods: ['visual', 'test'],
        points: [
          '检查电源插座、重联插座外壳无破损、烧蚀和进水痕迹',
          '检查插针无弯曲、松动、缺失，防尘盖齐全并能可靠闭合',
          '检查连接器固定牢固，线缆护套无破损、无异常发热变色',
        ],
        standard: '插座壳体、插针和防尘盖完好，连接牢固，无烧损、进水和松动',
        risk: '插座烧损或接触不良会造成重联、控制和照明电路异常',
        fault: {
          region: { u: [0.965, 0.995], v: [0.20, 0.36], w: [0.60, 0.76] },
          reportPartName: '电源插座与重联连接器',
          exterior: 'i-end',
          partType: 'electrical',
          faults: [{ faultType: 'burn', count: 1 }],
        },
      },
    ],
  },

  // ─────────────────────────── 07 端部与信号装置 ───────────────────────────
  {
    id: 'signal',
    order: 7,
    name: '端部与信号装置检查',
    shortName: '端部 / 信号',
    zone: '前后端部区',
    side: '端部',
    methodText: '目视 · 试验',
    stdTime: '6 min',
    cardImage: 'assets/cards/front-end.png',
    cardAlt: 'HXD3D型电力机车前端部结构',
    summary:
      '确认前照灯、标志灯、鸣笛装置、刮雨器、车号与扶手、脚踏等齐全完好，' +
      '端部无变形损伤。',
    safety: ['试验鸣笛前确认前方及两侧无人员', '更换灯泡须断电后进行'],
    focus: {
      type: 'region',
      regions: [
        { u: [0, 0.1], v: [0.35, 0.85], w: [0, 1] },
        { u: [0.9, 1], v: [0.35, 0.85], w: [0, 1] },
      ],
      camera: { dir: [-1.15, 0.5, 0.6], distance: 0.4 },
    },
    items: [
      {
        id: 'signal-1',
        name: '前照灯与标志灯',
        level: 'A',
        methods: ['visual', 'test'],
        points: [
          '检查前照灯玻璃完好，灯罩固定牢固',
          '试验远光、近光及标志灯（白、红）显示正常',
          '检查灯光照射方向适当，无倾斜',
        ],
        standard: '灯具完好固定牢固，远近光与标志灯显示正常，照射方向正确',
        risk: '夜间照明与标志灯失效会造成行车冲突风险',
        fault: {
          // II端前照灯位于端部下半区；端面为斜面，区域需覆盖其真实外表面。
          region: { u: [0.0, 0.10], v: [0.25, 0.38], w: [0.34, 0.66] },
          exterior: 'ii-end',
          partType: 'structural',
          faults: [
            { faultType: 'crack', count: 1 },
          ],
        },
      },
      {
        id: 'signal-5',
        name: '前挡风玻璃与密封胶条',
        level: 'A',
        methods: ['visual'],
        points: [
          '检查前挡风玻璃有无裂纹、破损、明显划伤和影响瞭望的污渍',
          '检查玻璃压条、密封胶条贴合牢固，无老化、脱落或渗水痕迹',
          '确认雨刷扫掠区域无遮挡，驾驶瞭望视野清晰',
        ],
        standard: '前挡风玻璃完整清晰，无裂纹破损；压条、密封胶条完好牢固，无渗水；瞭望视野满足要求',
        risk: '挡风玻璃裂损或密封失效会影响瞭望，并可能在运行中扩大破损',
        fault: {
          // I端挡风玻璃在倾斜前端面，不能按整车包围盒最前端的窄区取点。
          region: { u: [0.88, 1.0], v: [0.50, 0.72], w: [0.18, 0.82] },
          exterior: 'i-end',
          partType: 'structural',
          faults: [
            { faultType: 'crack', count: 1 },
          ],
        },
      },
      {
        id: 'signal-2',
        name: '鸣笛装置与刮雨器',
        level: 'B',
        methods: ['test'],
        points: [
          '试验风笛、电笛声音洪亮，无漏气',
          '试验刮雨器动作灵活，刮刷效果良好',
          '检查洗涤器喷水正常、水量充足',
        ],
        standard: '鸣笛响亮无漏气，刮雨器动作灵活，洗涤器喷水正常',
        risk: '鸣笛失效会影响警示联络，刮雨器失效影响雨雾天气瞭望',
      },
      {
        id: 'signal-3',
        name: '端部结构与附属件',
        level: 'B',
        methods: ['visual', 'tap'],
        points: [
          '检查端部车体、排障器、脚踏板无变形裂纹',
          '检查扶手、脚踏安装牢固，无松动',
          '检查车号、标志标记清晰完整',
        ],
        standard: '端部结构无变形裂纹，扶手脚踏安装牢固，车号标志清晰',
        risk: '扶手脚踏松动会造成司乘人员登乘时坠落受伤',
      },
      {
        id: 'signal-4',
        name: '自动过分相与感应装置',
        level: 'B',
        methods: ['visual'],
        points: [
          '检查感应器安装牢固，位置正确，无碰伤',
          '检查感应器接线完好，插头紧固',
          '检查车体下部的设备限界无侵限',
        ],
        standard: '感应器安装牢固位置正确，接线完好，无侵限',
        risk: '过分相装置失效会造成带电过分相，烧损设备',
      },
      {
        id: 'signal-6',
        name: '端部刷箱与随车清洁用品',
        level: 'C',
        methods: ['visual'],
        points: [
          '打开并检查刷箱，确认箱体、铰链和锁扣完好，盖板闭合可靠',
          '确认刷箱内无抹布、包装袋等遗留异物，不占用或遮挡应急备品',
          '检查刷箱安装螺栓紧固，箱体无裂纹、无明显变形',
        ],
        standard: '刷箱清洁、无遗留异物，箱体及锁扣完好，安装牢固',
        risk: '遗留抹布等异物会影响备品取用，并可能形成消防隐患',
        fault: {
          region: { u: [0.95, 0.99], v: [0.30, 0.50], w: [0.70, 0.88] },
          reportPartName: '端部刷箱',
          exterior: 'i-end',
          partType: 'structural',
          faults: [{ faultType: 'crack', count: 1 }],
        },
      },
      {
        id: 'signal-7',
        name: '“和谐”标志与车号清晰度',
        level: 'B',
        methods: ['visual'],
        points: [
          '检查前端“和谐”标志、车号和警示标记是否齐全、清晰、无脱落',
          '确认文字、图形无大面积褪色、污损或模糊不清',
          '检查标志牌固定牢固，无翘边、开裂或缺失',
        ],
        standard: '标志和车号完整、清晰、固定牢固，满足识别要求',
        risk: '车号或警示标志模糊、缺失会影响识别和现场安全确认',
        fault: {
          region: { u: [0.95, 0.995], v: [0.42, 0.56], w: [0.40, 0.60] },
          reportPartName: '“和谐”标志与车号',
          exterior: 'i-end',
          partType: 'structural',
          faults: [{ faultType: 'marking', count: 1 }],
        },
      },
    ],
  },

  // ─────────────────────────── 08 制动机性能试验 ───────────────────────────
  {
    id: 'braketest',
    order: 8,
    name: '制动机性能试验',
    shortName: '制动试验',
    zone: '司机室 · 全列制动系统',
    side: '司机室',
    methodText: '试验 · 记录',
    stdTime: '15 min',
    cardImage: 'assets/cards/left-side.png',
    cardAlt: 'HXD3D型电力机车左侧车体',
    summary:
      '按规定进行制动机全部试验（含漏泄试验、制动缓解试验与紧急制动试验），' +
      '确认制动性能符合规定并填写试验记录。',
    safety: [
      '试验前确认机车防溜、车下无人、车顶无人',
      '试验须在有列检或机车乘务员配合下进行',
      '紧急制动试验后须确认全列缓解到位',
    ],
    focus: {
      type: 'none',
      hint: '本环节在司机室内完成，配合走行部与制动系统部位同步观察',
      regions: [],
      camera: { dir: [-0.9, 0.45, 0.8], distance: 0.52 },
    },
    items: [
      {
        id: 'braketest-1',
        name: '充风与漏泄试验',
        level: 'A',
        methods: ['test', 'measure'],
        points: [
          '列车管充至规定压力，检查总风压力正常',
          '按规定减压后保压，检查列车管漏泄量',
          '检查制动管压力下降量每分钟不超过规定值',
        ],
        standard: '充风时间符合要求，列车管漏泄量每分钟不超过规定值',
        risk: '漏泄超标说明管路或阀件存在故障，必须查明原因',
      },
      {
        id: 'braketest-2',
        name: '常用制动与缓解试验',
        level: 'A',
        methods: ['test', 'visual'],
        points: [
          '按规定进行减压试验，确认制动缸压力上升正常',
          '检查全列制动作用一致，制动缸行程符合规定',
          '缓解后确认全列制动缸压力降至零，闸片回位',
        ],
        standard: '制动缸压力与行程符合规定，全列制动一致，缓解彻底',
        risk: '制动不一致会造成冲动与纵向力过大，缓解不良导致拖磨',
      },
      {
        id: 'braketest-3',
        name: '紧急制动试验',
        level: 'A',
        methods: ['test'],
        points: [
          '施行紧急制动，确认列车管压力迅速降至零',
          '确认制动缸压力达到规定值且上升时间符合要求',
          '确认紧急制动时牵引被切断、撒砂投入',
        ],
        standard: '紧急制动排风迅速，制动缸压力与上升时间符合规定，联锁动作正确',
        risk: '紧急制动不作用是最严重制动故障，严禁带故障出库',
      },
      {
        id: 'braketest-4',
        name: '备用制动与试验记录',
        level: 'B',
        methods: ['test'],
        points: [
          '试验备用制动（空气备份）作用良好',
          '核对各压力表与监测显示一致',
          '填写制动机试验记录，试验人签认',
        ],
        standard: '备用制动作用良好，仪表显示一致，试验记录填写完整并签认',
        risk: '记录缺失会造成责任无法追溯，备用制动失效时无应急手段',
      },
    ],
  },
]

/** 统计：总检查项数 */
export const TOTAL_ITEM_COUNT = INSPECTION_ROUTES.reduce(
  (sum, route) => sum + route.items.length,
  0,
)

/** 取某个检查项的全局序号（用于步骤编号） */
export function buildItemIndex() {
  const map = new Map()
  let serial = 0
  INSPECTION_ROUTES.forEach((route) => {
    route.items.forEach((item) => {
      serial += 1
      map.set(item.id, { serial, route })
    })
  })
  return map
}
