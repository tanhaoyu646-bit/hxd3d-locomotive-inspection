/**
 * 本轮训练的假设性故障布置。
 * 每个 id 对应一个可从车外直接观察的独立零部件；未列出的部件只进行正常确认。
 */
export const SCENARIO_FAULT_POINT_IDS = new Set([
  'coupler-1', 'coupler-5', 'coupler-6',
  'signal-1', 'signal-5', 'signal-6', 'signal-7',
  // 轮对、轴箱和一系悬挂覆盖六根轴的可见侧，避免学生检视到真实部件却始终没有训练故障。
  'rg-axle-1-left-wheelset', 'rg-axle-2-right-wheelset', 'rg-axle-3-left-wheelset',
  'rg-axle-4-right-wheelset', 'rg-axle-5-left-wheelset', 'rg-axle-6-right-wheelset',
  'rg-axle-1-right-axlebox', 'rg-axle-2-right-axlebox', 'rg-axle-3-left-axlebox',
  'rg-axle-4-left-axlebox', 'rg-axle-5-right-axlebox', 'rg-axle-6-left-axlebox',
  'rg-axle-1-left-primarySpring', 'rg-axle-2-right-primarySpring', 'rg-axle-3-left-primarySpring',
  'rg-axle-4-right-primarySpring', 'rg-axle-5-right-primarySpring', 'rg-axle-6-left-primarySpring',
  'rg-front-right-damper', 'rg-rear-left-damper',
  'rg-axle-1-left-brakeUnit', 'rg-axle-3-right-brakeUnit',
  'rg-front-left-tractionRod', 'rg-rear-right-tractionRod',
  'rg-front-left-pipeFastener', 'rg-rear-right-sandBox', 'rg-front-left-sandBox',
  'rg-front-left-motorGearbox', 'rg-axle-5-right-brakeUnit',
  'rg-end-i-pilot', 'rg-undercar-pipeline',
])
