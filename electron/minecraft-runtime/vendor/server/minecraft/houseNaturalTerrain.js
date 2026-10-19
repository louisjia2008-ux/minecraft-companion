/* global module */
'use strict';
// Shared natural clearing recognition only. Callers retain separate fresh
// hazard, ownership, floor/scaffold, leaf support and loaded-world guards.
const TERRAIN = /^(?:dirt|grass_block|coarse_dirt|rooted_dirt|podzol|mycelium|stone|deepslate|tuff|granite|diorite|andesite|sand|red_sand|gravel|snow|snow_block|short_grass|tall_grass|fern|large_fern|dead_bush|leaf_litter|vine|(?:oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak)_leaves)$/;
const isNaturalHouseTerrain = name => TERRAIN.test(name);
module.exports = { isNaturalHouseTerrain };
