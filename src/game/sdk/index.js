// Everything a mission may import: missions depend on this module only, never on engine internals.
// Bump SDK_VERSION when something a plugin relies on changes incompatibly; plugins declare the version they were written for.
export const SDK_VERSION = 1;
export { Mission, FACTION, MODE, ROLE, STAT, ZONE, fmt, rand, pick } from '../mission.js';
export { WATER_RANGE } from '../../sim/world.js';
export { Convoy } from '../convoy.js';
export * from './colors.js';
export * from './draw.js';
export * from './geometry.js';
export * from './spawn.js';
export * from './templates/defend.js';
