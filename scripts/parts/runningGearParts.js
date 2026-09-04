/**
 * 走行部零部件配置表（独立数据源）
 * ---------------------------------------------------------------------------
 * 设计原则
 *   1. 本文件是走行部「零部件」的唯一权威配置，位置信息不再写死在
 *      inspectionData.js 里。inspectionData.js 只保留检查项（教学文本），
 *      两者通过 itemId 关联。
 *
 *   2. 原 HXD3D 模型（hxd3d-integration-spatial.glb）是**合并网格**：
 *      Static_Main_Body 一个节点就含 42.8 万三角形，没有 wheel / axlebox /
 *      bogieFrame 这类独立节点。因此本配置不为每个部件假设独立 mesh，
 *      而是为每个部件声明「低复杂度交互代理 + 碰撞代理」，
 *      显示仍然使用原高精模型。
 *
 *   3. 所有几何常量来自对 GLB 的实测解析（tools/inspect-glb.mjs），
 *      不是经验估算。实测方法：
 *        · 整车包围盒 —— 遍历全部 primitive 的 POSITION accessor
 *        · 轮对纵向位置 —— 取最低高度带（轨面上方 0~0.165m）的顶点
 *          沿车长 X 做直方图，只有车轮踏面触及该高度，峰值即轴位
 *        · 横向位置 —— 走行部高度带的顶点沿车宽 Z 做直方图，
 *          峰值对应轮对中心平面与构架侧梁
 *      复核命令：
 *        node tools/inspect-glb.mjs \
 *          "../机车数字孪生/01-系统程序（V1至V2.3）/hxd3d-digital-twin/\
 * public/models/hxd3d/hxd3d-integration-spatial.glb" --probe
 *
 * 坐标约定（与 inspectionData.js 的 region 一致）
 *   归一化 (u, v, w)，取值允许越界（<0 或 >1），因为检查站位在车体外侧
 *     u：沿车长 0=II端车钩端 → 1=I端车钩端      （世界 X）
 *     v：沿车高 0=轨面（车轮踏面最低点）→ 1=受电弓顶（世界 Y）
 *     w：沿车宽 0=左侧最外 → 0.5=轨道中心 → 1=右侧最外（世界 Z）
 *   左右判定：面向 I 端（+X）站立时，+Z 为右侧，−Z 为左侧
 * ---------------------------------------------------------------------------
 */

// ───────────────────────── 实测几何常量 ─────────────────────────
/**
 * 单位：米，模型世界坐标（GLB 加载后未缩放）
 * 来源：tools/inspect-glb.mjs 对 hxd3d-integration-spatial.glb 的解析结果
 */
export const MEASURED = Object.freeze({
  boundsMin: [-7.254, 0.135, -7.541],
  boundsMax: [15.748, 6.550, -3.941],
  size: [23.002, 6.415, 3.601],
  /** 轨面高度 = 车轮踏面最低点 = 整车包围盒下沿 */
  railY: 0.135,
  /** 轨道中心（车宽方向中线），实测顶点分布左右对称，中心即轨道中心 */
  trackCenterZ: -5.741,
  /** 标准轨距 1435mm 的一半 */
  gaugeHalf: 0.7175,
  /** 车轮半径（HXD3D 新轮 1250mm） */
  wheelRadius: 0.625,
  /** 车体底架下沿（实测走行部高度带上方首个密集面，轨面上方约 1.55m） */
  carbodyBottomY: 1.685,
  /** 车顶（车体本体最高点，不含受电弓） */
  carbodyTopY: 5.104,
  /** 两台转向架中心纵向坐标（实测轮对轴位反算，两中心距 12.13m） */
  bogieCenters: { rear: -1.78, front: 10.35 },
  /** 同一转向架内相邻轴距（实测：轮对轴位呈等距分布） */
  axleSpacing: 2.15,
  /** 转向架构架侧梁横向中心（实测 Z 向直方图峰值 ±1.30m） */
  bogieFrameHalfZ: 1.3,
  /** 车体最大半宽（含扶手脚踏） */
  carbodyHalfZ: 1.8,
  /** 车体主体半宽（侧墙） */
  carbodyBodyHalfZ: 1.55,
})

/** 归一化：世界坐标 → (u,v,w) */
export function toNormalized(x, y, z) {
  const [mnX, mnY, mnZ] = MEASURED.boundsMin
  const [sX, sY, sZ] = MEASURED.size
  return { u: (x - mnX) / sX, v: (y - mnY) / sY, w: (z - mnZ) / sZ }
}

/** 反归一化：(u,v,w) → 世界坐标（允许越界，用于车体外侧的检查站位） */
export function toWorld(norm) {
  const [mnX, mnY, mnZ] = MEASURED.boundsMin
  const [sX, sY, sZ] = MEASURED.size
  return {
    x: mnX + sX * norm.u,
    y: mnY + sY * norm.v,
    z: mnZ + sZ * norm.w,
  }
}

/** 归一化区域 → 世界包围盒（允许越界） */
export function normalizedRegionToBox(region) {
  const a = toWorld({ u: region.u[0], v: region.v[0], w: region.w[0] })
  const b = toWorld({ u: region.u[1], v: region.v[1], w: region.w[1] })
  return {
    min: [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)],
    max: [Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)],
  }
}

// ───────────────────────── 站位分区常量 ─────────────────────────
/**
 * 学生可站立的检查站位带（横向，相对轨道中心）
 * 内侧边界 = 车体半宽(1.62) + 玩家半径(0.42) + 余量 ≈ 2.23m
 * 外侧边界 = 3.03m（再远就看不清部件细节）
 */
const STAND_ZONE = Object.freeze({
  left: { w: [-0.42, -0.08] },   // 放宽外侧站位带，避免已在车侧仍被判“未到位”
  right: { w: [1.08, 1.42] },
})

/** 站位纵向半宽（±0.055 ≈ ±1.27m），允许学生沿车体前后微调站姿 */
const STAND_U_HALF = 0.09
/** 站位垂向范围：地面（玩家脚底 y=0，即 v≈-0.021）到轻微起伏 */
const STAND_V = [-0.15, 0.35]

/**
 * 车下检查通道（蹲下后允许进入）
 * 位于两台转向架之间、车体底架下方：
 *   纵向 x ∈ [1.5, 7.1]（后转向架第3轴 0.37 与 前转向架第1轴 8.20 之间）
 *   横向 |Δz| ≤ 1.40（车体底架下方）
 */
export const UNDERCAR_ZONE = Object.freeze({
  u: [0.381, 0.624],
  v: [-0.15, 0.30],
  w: [0.11, 0.89],
})

// ───────────────────────── 部件类型定义 ─────────────────────────
/**
 * 每个类型字段说明
 *   type          类型标识
 *   label         部件名称
 *   itemId        对应检查项（inspectionData.js 的 item.id）
 *   dx            相对所属转向架中心的纵向偏移（m，+X 为 I 端方向）
 *   dy            部件中心绝对高度（m，轨面=0.135）
 *   dz            相对轨道中心的横向距离（m，符号由 side 决定）
 *   partType      故障标记配色：structural 白(裂纹) / electrical 红(烧损) / brake 白+渗漏
 *   view          推荐检查视角：dist 观察距离(m)、pitch 俯仰(弧度，负=俯视)
 *   approach      maxDistance 触发交互的最大水平距离(m)、facing 朝向阈值(点积)
 *   allowCrouch   是否允许蹲下检查
 *   requireCrouch 是否必须蹲下才可检（车下部件）
 *   proxy         低复杂度代理尺寸 [纵向, 垂向, 横向]（m）——同时用于碰撞与交互代理
 *   occluders     可能遮挡视线的对象（用于提示，实际遮挡用射线检测原模型）
 *   judge         合格/异常判定内容
 */
export const PART_TYPE_DEFS = Object.freeze({
  frame: {
    label: '转向架构架（侧梁/横梁/焊缝）',
    shortLabel: '转向架构架',
    itemId: 'bogie-4',
    dx: 0, dy: 1.15, dz: MEASURED.bogieFrameHalfZ,
    partType: 'structural',
    view: { dist: 2.1, pitch: -0.05 },
    approach: { maxDistance: 3.0, facing: 0.5 },
    allowCrouch: true, requireCrouch: false,
    proxy: [3.9, 0.55, 0.30],
    occluders: ['wheelset', 'brakeUnit'],
    judge: {
      pass: '构架侧梁、横梁及各部焊缝无裂纹，无变形，母材与焊缝过渡良好',
      faults: [{ faultType: 'crack', count: 1 }],
      abnormal: ['构架焊缝开裂', '侧梁变形', '母材裂纹'],
    },
  },
  wheelset: {
    label: '轮对与车轮踏面、轮缘',
    shortLabel: '轮对踏面',
    itemId: 'bogie-1',
    dx: 0, dy: 0.135 + MEASURED.wheelRadius, dz: MEASURED.gaugeHalf + 0.07,
    partType: 'structural',
    view: { dist: 1.9, pitch: -0.22 },
    approach: { maxDistance: 2.7, facing: 0.55 },
    allowCrouch: true, requireCrouch: false,
    proxy: [0.30, 2 * MEASURED.wheelRadius, 0.16],
    occluders: ['brakeUnit', 'axlebox'],
    judge: {
      pass: '踏面无擦伤、剥离、裂纹，磨耗不超限；轮缘厚度与高度符合限度',
      faults: [
        { faultType: 'tread-scratch', surface: 'tread', count: 1 },
        { faultType: 'tread-peel', surface: 'tread', count: 1 },
      ],
      abnormal: ['踏面擦伤', '踏面剥离', '轮缘磨耗到限', '轮辋裂纹'],
    },
  },
  axlebox: {
    label: '轴箱与轴承端盖',
    shortLabel: '轴箱端盖',
    itemId: 'bogie-2',
    dx: 0, dy: 0.86, dz: MEASURED.gaugeHalf + 0.24,
    partType: 'structural',
    view: { dist: 1.9, pitch: -0.12 },
    approach: { maxDistance: 2.7, facing: 0.55 },
    allowCrouch: true, requireCrouch: false,
    proxy: [0.62, 0.46, 0.34],
    occluders: ['wheelset', 'primarySpring'],
    judge: {
      pass: '轴箱体无裂纹、无漏油，端盖螺栓紧固，防松标记无错位，温度正常',
      faults: [
        { faultType: 'crack', count: 1 },
        { faultType: 'loose-bolt', count: 1 },
        { faultType: 'leak', count: 1 },
      ],
      abnormal: ['轴箱漏油', '轴箱过热', '端盖螺栓松动', '防松标记错位'],
    },
  },
  primarySpring: {
    label: '一系悬挂（轴箱弹簧与橡胶垫）',
    shortLabel: '一系悬挂',
    itemId: 'bogie-2',
    dx: 0, dy: 1.24, dz: MEASURED.gaugeHalf + 0.26,
    partType: 'structural',
    view: { dist: 2.0, pitch: -0.02 },
    approach: { maxDistance: 2.8, facing: 0.5 },
    allowCrouch: true, requireCrouch: false,
    proxy: [0.52, 0.44, 0.30],
    occluders: ['wheelset', 'frame'],
    judge: {
      pass: '螺旋弹簧无裂纹、折断、压溃，橡胶垫无老化开裂，上下支座无松动',
      faults: [{ faultType: 'crack', count: 1 }],
      abnormal: ['一系弹簧折断', '橡胶垫老化开裂', '弹簧支座松动'],
    },
  },
  damper: {
    label: '油压减振器（垂向/横向）',
    shortLabel: '油压减振器',
    itemId: 'bogie-3',
    dx: 1.05, dy: 1.18, dz: MEASURED.bogieFrameHalfZ - 0.10,
    partType: 'structural',
    view: { dist: 2.1, pitch: -0.02 },
    approach: { maxDistance: 2.9, facing: 0.5 },
    allowCrouch: true, requireCrouch: false,
    proxy: [0.20, 0.78, 0.20],
    occluders: ['frame', 'wheelset'],
    judge: {
      pass: '减振器无漏油，连接销与安装座紧固，橡胶节点无开裂',
      faults: [
        { faultType: 'crack', count: 1 },
        { faultType: 'leak', count: 1 },
        { faultType: 'loose-bolt', count: 1 },
      ],
      abnormal: ['减振器漏油', '连接销松动', '橡胶节点开裂'],
    },
  },
  tractionRod: {
    label: '牵引拉杆与横向拉杆',
    shortLabel: '牵引拉杆',
    itemId: 'bogie-3',
    dx: -0.55, dy: 0.95, dz: MEASURED.gaugeHalf + 0.05,
    partType: 'structural',
    view: { dist: 2.3, pitch: -0.18 },
    approach: { maxDistance: 3.1, facing: 0.5 },
    allowCrouch: true, requireCrouch: false,
    proxy: [1.10, 0.22, 0.22],
    occluders: ['wheelset', 'axlebox'],
    judge: {
      pass: '牵引拉杆、横向拉杆无变形裂纹，橡胶节点无开裂，连接紧固无松旷',
      faults: [{ faultType: 'crack', count: 1 }, { faultType: 'loose-bolt', count: 1 }],
      abnormal: ['牵引拉杆变形', '拉杆裂纹', '橡胶节点开裂', '连接松旷'],
    },
  },
  secondarySpring: {
    label: '二系悬挂弹簧与支座',
    shortLabel: '二系悬挂',
    itemId: 'bogie-4',
    dx: 0, dy: 1.48, dz: MEASURED.bogieFrameHalfZ - 0.22,
    partType: 'structural',
    view: { dist: 2.2, pitch: 0.04 },
    approach: { maxDistance: 3.0, facing: 0.5 },
    allowCrouch: false, requireCrouch: false,
    proxy: [0.56, 0.42, 0.32],
    occluders: ['frame'],
    judge: {
      pass: '二系螺旋弹簧无裂纹折断老化，上下支座无裂纹，紧固件无松动，车体无异常倾斜',
      faults: [{ faultType: 'crack', count: 1 }],
      abnormal: ['二系弹簧折断', '支座裂纹', '高度调整装置失效'],
    },
  },
  motorGearbox: {
    label: '牵引电机与齿轮箱（外露连接部位）',
    shortLabel: '牵引电机齿轮箱',
    itemId: 'bogie-5',
    dx: 0, dy: 0.82, dz: 0.36,
    partType: 'electrical',
    view: { dist: 2.6, pitch: -0.16 },
    approach: { maxDistance: 3.4, facing: 0.45 },
    allowCrouch: true, requireCrouch: false,
    proxy: [1.30, 0.86, 0.86],
    occluders: ['wheelset', 'brakeUnit'],
    judge: {
      pass: '电机外观完好，接线盒密封良好、引线无破损；齿轮箱无漏油、油位正常；悬挂螺栓紧固',
      faults: [
        { faultType: 'burn', count: 1 },
        { faultType: 'leak', count: 1 },
        { faultType: 'loose-bolt', count: 1 },
      ],
      abnormal: ['齿轮箱漏油', '电机接线盒进水', '引线破损', '悬挂螺栓松动'],
    },
  },
  brakeUnit: {
    label: '基础制动装置（制动夹钳/闸片/制动缸）',
    shortLabel: '基础制动装置',
    itemId: 'bogie-6',
    dx: 0.30, dy: 1.02, dz: MEASURED.gaugeHalf + 0.02,
    partType: 'brake',
    view: { dist: 2.0, pitch: -0.14 },
    approach: { maxDistance: 2.8, facing: 0.55 },
    allowCrouch: true, requireCrouch: false,
    proxy: [0.66, 0.52, 0.40],
    occluders: ['wheelset'],
    judge: {
      pass: '制动缸、杠杆、拉杆无变形裂纹，连接销齐全；夹钳无裂纹，闸片厚度与制动缸行程符合规定',
      faults: [
        { faultType: 'crack', count: 1 },
        { faultType: 'leak', count: 1 },
        { faultType: 'loose-bolt', count: 1 },
      ],
      abnormal: ['闸片磨耗到限', '制动缸行程超限', '夹钳裂纹', '风管漏泄'],
    },
  },
  pipeFastener: {
    label: '管路、紧固件与防松状态',
    shortLabel: '管路与防松件',
    itemId: 'bogie-6',
    dx: 0, dy: 1.30, dz: MEASURED.bogieFrameHalfZ - 0.05,
    partType: 'structural',
    view: { dist: 2.2, pitch: 0.0 },
    approach: { maxDistance: 3.0, facing: 0.5 },
    allowCrouch: true, requireCrouch: false,
    proxy: [3.6, 0.26, 0.22],
    occluders: ['frame', 'wheelset'],
    judge: {
      pass: '各管路无碰磨、无漏泄，管卡齐全紧固；各部紧固螺栓无松动，防松标记无错位',
      faults: [
        { faultType: 'leak', count: 1 },
        { faultType: 'loose-bolt', count: 1 },
      ],
      abnormal: ['风管漏泄', '管卡松脱', '防松标记错位', '螺栓松动缺失'],
    },
  },
  sandBox: {
    label: '撒砂装置与侧面砂箱',
    shortLabel: '撒砂装置',
    itemId: 'bogie-7',
    dx: 1.28, dy: 1.52, dz: MEASURED.carbodyBodyHalfZ - 0.12,
    partType: 'structural',
    view: { dist: 2.3, pitch: 0.06 },
    approach: { maxDistance: 3.1, facing: 0.5 },
    allowCrouch: false, requireCrouch: false,
    proxy: [0.56, 0.62, 0.30],
    occluders: ['frame'],
    judge: {
      pass: '砂箱砂量充足、砂质干燥无结块；箱体安装牢固无裂纹变形；撒砂器与管路畅通',
      faults: [{ faultType: 'crack', count: 1 }, { faultType: 'loose-bolt', count: 1 }],
      abnormal: ['砂箱裂纹', '砂量不足', '砂质结块', '撒砂管堵塞'],
    },
  },
})

/** 端部部件（不隶属转向架，按 I/II 端实例化） */
export const END_PART_DEFS = Object.freeze({
  pilot: {
    label: '排障器与脚踏端部',
    shortLabel: '排障器',
    itemId: 'bogie-8',
    /** du：相对车体端部（0=II端，1=I端）的纵向内缩（m） */
    du: 0.62, dy: 0.42, dz: 0,
    partType: 'structural',
    view: { dist: 2.2, pitch: -0.10 },
    approach: { maxDistance: 3.0, facing: 0.5 },
    allowCrouch: true, requireCrouch: false,
    proxy: [0.34, 0.66, 2.9],
    occluders: [],
    judge: {
      pass: '排障器安装牢固、高度符合规定、无变形裂纹；端部脚踏板与扶手牢固无松动',
      faults: [{ faultType: 'crack', count: 1 }, { faultType: 'loose-bolt', count: 1 }],
      abnormal: ['排障器变形', '安装螺栓松动', '脚踏板松动', '高度超限'],
    },
  },
})

/** 车下检查点：蹲下进入车下通道后检查底架管路与紧固件 */
export const UNDERCAR_PART_DEF = Object.freeze({
  label: '车下管路与底架紧固件（车下通道检查）',
  shortLabel: '车下管路',
  itemId: 'bogie-6',
  u: 0.5, dy: 1.30, dz: 0,
  partType: 'structural',
  view: { dist: 2.0, pitch: 0.34 },
  approach: { maxDistance: 2.8, facing: 0.35 },
  allowCrouch: true, requireCrouch: true,
  proxy: [4.4, 0.30, 2.4],
  occluders: [],
  judge: {
    pass: '车下各管路无漏泄、无碰磨，管卡齐全；底架紧固件无松动，防松标记无错位',
    faults: [
      { faultType: 'leak', count: 1 },
      { faultType: 'loose-bolt', count: 1 },
    ],
    abnormal: ['车下风管漏泄', '管卡松脱', '底架螺栓松动', '防松标记错位'],
  },
})

// ───────────────────────── 实例生成 ─────────────────────────
const BOGIES = [
  { key: 'rear', label: 'II端转向架', centerX: MEASURED.bogieCenters.rear },
  { key: 'front', label: 'I端转向架', centerX: MEASURED.bogieCenters.front },
]
const SIDES = [
  { key: 'left', label: '左侧', sign: -1 },
  { key: 'right', label: '右侧', sign: +1 },
]

function makeZones(partU, sideKey) {
  const zone = STAND_ZONE[sideKey]
  return [{
    id: `stand-${sideKey}`,
    label: sideKey === 'left' ? '车体左侧站位' : '车体右侧站位',
    region: {
      u: [partU - STAND_U_HALF, partU + STAND_U_HALF],
      v: [...STAND_V],
      w: [...zone.w],
    },
    requireCrouch: false,
  }]
}

/**
 * 生成全部走行部零部件实例
 * @returns {Array} 每个实例含 partId / 名称 / 检查项 / 归属 / 归一化中心 / 站位 / 视角 / 判定
 */
export function buildRunningGearParts() {
  const parts = []

  // 轮对、轴箱、一系悬挂和基础制动均按六根轴独立建交互锚点。
  // 旧版每台转向架只建一个中心点，导致三根轴都被吸附到转向架中心。
  const perAxleTypes = new Set(['wheelset', 'axlebox', 'primarySpring', 'brakeUnit'])
  const axleOffsets = [MEASURED.axleSpacing, 0, -MEASURED.axleSpacing]

  // 1) 转向架 × 左右侧 的常规部件
  for (const bogie of BOGIES) {
    for (const side of SIDES) {
      for (const [type, def] of Object.entries(PART_TYPE_DEFS)) {
        const offsets = perAxleTypes.has(type) ? axleOffsets : [def.dx]
        offsets.forEach((offset, localIndex) => {
          const axleNo = perAxleTypes.has(type)
            ? (bogie.key === 'front' ? localIndex + 1 : localIndex + 4)
            : null
          const x = bogie.centerX + offset
          const y = def.dy
          const z = MEASURED.trackCenterZ + side.sign * def.dz
          const n = toNormalized(x, y, z)
          const partId = axleNo
            ? `rg-axle-${axleNo}-${side.key}-${type}`
            : `rg-${bogie.key}-${side.key}-${type}`
          parts.push({
          partId,
          name: axleNo ? `${axleNo}轴${def.label}` : def.label,
          shortName: axleNo ? `${axleNo}轴${def.shortLabel}` : def.shortLabel,
          itemId: def.itemId,
          type,
          /** 左/右侧归属 */
          side: side.key,
          sideLabel: side.label,
          /** 前/后转向架归属 */
          bogie: bogie.key,
          bogieLabel: bogie.label,
          endLabel: bogie.key === 'front' ? 'I端' : 'II端',
          axleNo,
          positionLabel: axleNo ? (localIndex === 0 ? '前位' : localIndex === 2 ? '后位' : '中位') : '',
          innerOuter: side.key === 'left' ? '左侧外侧' : '右侧外侧',
          /** 三维交互中心点（归一化） */
          center: n,
          centerWorld: { x, y, z },
          /** 推荐检查站位（允许的检查区域） */
          zones: makeZones(n.u, side.key),
          /** 推荐检查视角 */
          view: {
            distance: def.view.dist,
            pitch: def.view.pitch,
            /** 观察方向：由站位指向部件（外侧看向内侧） */
            facing: side.sign > 0 ? 'inward-right' : 'inward-left',
          },
          /** 接近距离与朝向阈值 */
          approach: { ...def.approach },
          /** 是否允许 / 必须蹲下检查 */
          allowCrouch: def.allowCrouch,
          requireCrouch: def.requireCrouch,
          /** 低复杂度代理尺寸（同时用于碰撞与交互代理） [纵向, 垂向, 横向] m */
          proxySize: [...def.proxy],
          proxyCenter: n,
          /** 可能遮挡视线的对象 */
          occluders: [...def.occluders],
          /** 故障标记配色 */
          partType: def.partType,
          /** 合格/异常判定内容 */
          judge: def.judge,
          })
        })
      }
    }
  }

  // 2) 端部排障器与脚踏（I / II 端各一）
  for (const end of [{ key: 'ii', label: 'II端', u: 0 }, { key: 'i', label: 'I端', u: 1 }]) {
    const def = END_PART_DEFS.pilot
    const x = end.u === 0
      ? MEASURED.boundsMin[0] + def.du
      : MEASURED.boundsMax[0] - def.du
    const y = def.dy
    const z = MEASURED.trackCenterZ
    const n = toNormalized(x, y, z)
    parts.push({
      partId: `rg-end-${end.key}-pilot`,
      name: def.label,
      shortName: def.shortLabel,
      itemId: def.itemId,
      type: 'pilot',
      side: 'both',
      sideLabel: '端部',
      bogie: end.key === 'i' ? 'front' : 'rear',
      bogieLabel: `${end.label}端部`,
      center: n,
      centerWorld: { x, y, z },
      zones: [
        {
          id: 'stand-i-end',
          label: `${end.label}前方站位`,
          region: {
            u: [n.u - 0.075, n.u + 0.075],
            v: [...STAND_V],
            w: [0.24, 0.76],
          },
          requireCrouch: false,
        },
        // 端部部件横跨车宽，左右两侧都要能检（左右侧站位）
        {
          id: 'stand-left',
          label: `${end.label}左侧站位`,
          region: {
            u: [n.u - 0.075, n.u + 0.075],
            v: [...STAND_V],
            w: [...STAND_ZONE.left.w],
          },
          requireCrouch: false,
        },
        {
          id: 'stand-right',
          label: `${end.label}右侧站位`,
          region: {
            u: [n.u - 0.075, n.u + 0.075],
            v: [...STAND_V],
            w: [...STAND_ZONE.right.w],
          },
          requireCrouch: false,
        },
      ],
      view: { distance: def.view.dist, pitch: def.view.pitch, facing: 'end-on' },
      approach: { ...def.approach },
      allowCrouch: def.allowCrouch,
      requireCrouch: def.requireCrouch,
      proxySize: [...def.proxy],
      proxyCenter: n,
      occluders: [...def.occluders],
      partType: def.partType,
      judge: def.judge,
    })
  }

  // 3) 车下通道检查点（必须蹲下）
  {
    const def = UNDERCAR_PART_DEF
    const x = MEASURED.boundsMin[0] + MEASURED.size[0] * def.u
    const y = def.dy
    const z = MEASURED.trackCenterZ + def.dz
    const n = toNormalized(x, y, z)
    parts.push({
      partId: 'rg-undercar-pipeline',
      name: def.label,
      shortName: def.shortLabel,
      itemId: def.itemId,
      type: 'undercar',
      side: 'both',
      sideLabel: '车下',
      bogie: 'middle',
      bogieLabel: '车体中部车下',
      center: n,
      centerWorld: { x, y, z },
      zones: [{ id: 'undercar', label: '车下检查通道（需蹲下）', region: { ...UNDERCAR_ZONE }, requireCrouch: true }],
      view: { distance: def.view.dist, pitch: def.view.pitch, facing: 'up-inward' },
      approach: { ...def.approach },
      allowCrouch: def.allowCrouch,
      requireCrouch: def.requireCrouch,
      proxySize: [...def.proxy],
      proxyCenter: n,
      occluders: [...def.occluders],
      partType: def.partType,
      judge: def.judge,
    })
  }

  return parts
}

// ───────────────────────── 查询辅助 ─────────────────────────
let cached = null
export function getRunningGearParts() {
  if (!cached) cached = buildRunningGearParts()
  return cached
}
export function getPartById(partId) {
  return getRunningGearParts().find((p) => p.partId === partId) ?? null
}
/** 某检查项对应的全部零部件（一个检查项可对应多个部件实例） */
export function getPartsByItem(itemId) {
  return getRunningGearParts().filter((p) => p.itemId === itemId)
}
/** 走行部涉及的检查项 id 集合 */
export function getRunningGearItemIds() {
  return [...new Set(getRunningGearParts().map((p) => p.itemId))]
}
