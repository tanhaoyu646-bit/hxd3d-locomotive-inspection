/**
 * 本轮训练的假设性故障布置。
 * 每个 id 对应一个可从车外直接观察的独立零部件；未列出的部件只进行正常确认。
 */
export const SCENARIO_FAULT_POINT_IDS = new Set([
  'coupler-1', 'coupler-5', 'coupler-6',
  'signal-1', 'signal-5', 'signal-6', 'signal-7',
  'rg-axle-1-left-wheelset', 'rg-axle-2-right-axlebox',
  'rg-axle-3-left-primarySpring', 'rg-front-right-damper',
  'rg-front-left-pipeFastener', 'rg-rear-right-sandBox',
  'rg-front-left-motorGearbox', 'rg-axle-5-right-brakeUnit',
  'rg-end-i-pilot', 'rg-undercar-pipeline',
])
