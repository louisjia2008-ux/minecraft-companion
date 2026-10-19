const { clamp } = require("./taskUtils");
const {
  ANY_PLANKS,
  BUILD_MATERIAL_ALIASES,
} = require("./taskCatalog");

function createNetherPortalBlueprint(anchor) {
  const blocks = [];
  for (const x of [1, 2]) {
    blocks.push({ position: { x: anchor.x + x, y: anchor.y, z: anchor.z }, item: "obsidian" });
    blocks.push({ position: { x: anchor.x + x, y: anchor.y + 4, z: anchor.z }, item: "obsidian" });
  }
  for (const y of [1, 2, 3]) {
    blocks.push({ position: { x: anchor.x, y: anchor.y + y, z: anchor.z }, item: "obsidian" });
    blocks.push({ position: { x: anchor.x + 3, y: anchor.y + y, z: anchor.z }, item: "obsidian" });
  }
  return blocks;
}

function finalizeBlueprintBlocks(anchor, blocks = []) {
  const deduped = new Map();
  for (const block of blocks) {
    if (!block || !block.item) {
      continue;
    }
    const x = Number(block.x);
    const y = Number(block.y);
    const z = Number(block.z);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
      continue;
    }
    deduped.set(`${x}:${y}:${z}`, {
      position: {
        x: anchor.x + x,
        y: anchor.y + y,
        z: anchor.z + z,
      },
      item: block.item,
    });
  }
  return [...deduped.values()].sort((a, b) => {
    const yDelta = a.position.y - b.position.y;
    if (yDelta !== 0) {
      return yDelta;
    }
    const zDelta = a.position.z - b.position.z;
    if (zDelta !== 0) {
      return zDelta;
    }
    return a.position.x - b.position.x;
  });
}

function createSmallHouseBlueprint(anchor, material, width = 5, depth = 4, height = 3) {
  const blocks = [];
  const w = clamp(width, 3, 4);
  const d = clamp(depth, 3, 4);
  const h = clamp(height, 2, 2);
  const doorX = Math.floor(w / 2);
  const sideWindowZ = Math.floor(d / 2);

  for (let x = 0; x < w; x += 1) {
    for (let z = 0; z < d; z += 1) {
      blocks.push({ x, y: 0, z, item: material });
    }
  }

  for (let y = 1; y <= h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      for (let z = 0; z < d; z += 1) {
        const isWall = x === 0 || x === w - 1 || z === 0 || z === d - 1;
        if (!isWall) {
          continue;
        }
        const isDoor = z === 0 && x === doorX && y <= 2;
        const isFrontWindow =
          w >= 4 && z === 0 && (x === 1 || x === w - 2) && y === 2;
        const isBackWindow =
          z === d - 1 && x === doorX && y === 2;
        const isSideWindow =
          (x === 0 || x === w - 1) &&
          z === sideWindowZ &&
          y === 2 &&
          d >= 4;
        if (isDoor || isFrontWindow || isBackWindow || isSideWindow) {
          continue;
        }
        blocks.push({ x, y, z, item: material });
      }
    }
  }

  for (let x = 0; x < w; x += 1) {
    for (let z = 0; z < d; z += 1) {
      const isRoofEdge = x === 0 || x === w - 1 || z === 0 || z === d - 1;
      const isSingleCap = w === 3 && d === 3 && x === 1 && z === 1;
      if (!isRoofEdge && !isSingleCap) {
        continue;
      }
      blocks.push({
        x,
        y: h + 1,
        z,
        item: material,
      });
    }
  }

  return finalizeBlueprintBlocks(anchor, blocks);
}

function getBlueprintPhaseGroups(anchor, blueprint = [], height = 3) {
  const floorY = Number(anchor?.y || 0);
  const wallMaxY = floorY + clamp(Number(height) || 3, 2, 5);
  return [
    {
      label: "地板",
      blocks: blueprint.filter((block) => Number(block?.position?.y) === floorY),
    },
    {
      label: "墙体",
      blocks: blueprint.filter((block) => {
        const y = Number(block?.position?.y);
        return y > floorY && y <= wallMaxY;
      }),
    },
    {
      label: "屋顶",
      blocks: blueprint.filter((block) => Number(block?.position?.y) > wallMaxY),
    },
  ].filter((group) => group.blocks.length > 0);
}

function resolveBuildMaterial(rawMaterial) {
  const normalized = String(rawMaterial || "").trim().toLowerCase();
  return BUILD_MATERIAL_ALIASES[normalized] || normalized || "oak_planks";
}

function isAnyPlankMaterial(material = "") {
  return String(material || "").trim() === "any_planks";
}

function getBlueprintExpectedBlockNames(material = "") {
  return isAnyPlankMaterial(material)
    ? [...ANY_PLANKS]
    : [String(material || "").trim()].filter(Boolean);
}

function getSmallHousePlaybookDimensions(step = {}) {
  return {
    width: clamp(Number(step.args?.width) || 3, 3, 3),
    depth: clamp(Number(step.args?.depth) || 3, 3, 3),
    height: clamp(Number(step.args?.height) || 2, 2, 2),
  };
}

function getSmallHousePlaybookMaterial(step = {}) {
  const raw = String(step.args?.material || "any_planks").trim().toLowerCase();
  if (!raw || ["wood", "oak", "plank", "planks", "any_planks"].includes(raw)) {
    return "any_planks";
  }
  const resolved = resolveBuildMaterial(raw);
  return ANY_PLANKS.includes(resolved) ? resolved : "any_planks";
}

function createSmallHousePlaybookBlueprint(anchor, step = {}) {
  const { width, depth, height } = getSmallHousePlaybookDimensions(step);
  const material = getSmallHousePlaybookMaterial(step);
  return createSmallHouseBlueprint(anchor, material, width, depth, height);
}

function getSmallHousePlaybookRequiredBlocks(step = {}) {
  const blueprint = createSmallHousePlaybookBlueprint({ x: 0, y: 0, z: 0 }, step);
  return blueprint.length;
}

module.exports = {
  createNetherPortalBlueprint,
  createSmallHouseBlueprint,
  createSmallHousePlaybookBlueprint,
  finalizeBlueprintBlocks,
  getBlueprintPhaseGroups,
  getBlueprintExpectedBlockNames,
  getSmallHousePlaybookDimensions,
  getSmallHousePlaybookMaterial,
  getSmallHousePlaybookRequiredBlocks,
  isAnyPlankMaterial,
  resolveBuildMaterial,
};
