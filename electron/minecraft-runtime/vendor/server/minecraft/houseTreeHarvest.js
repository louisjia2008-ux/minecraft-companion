'use strict';
// A bounded snapshot of loaded, connected logs. This is ordering information,
// never permission to dig: reach, support, ownership and inventory are checked
// by the normal gatherer for every block. Do not flood-fill an entire forest.
function observeHouseTree(bot, root, excluded = () => false) {
  if (!root?.position || !root.name?.endsWith('_log')) return null;
  const origin = root.position, queue = [origin], seen = new Set(), pending = [];
  while (queue.length && pending.length < 64 && seen.size < 2048) {
    const p = queue.shift(), key = `${p.x},${p.y},${p.z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (Math.abs(p.x-origin.x)>4 || Math.abs(p.z-origin.z)>4 || Math.abs(p.y-origin.y)>24 || excluded(p)) continue;
    const block = bot.blockAt(p);
    if (block?.name !== root.name) continue;
    pending.push({x:p.x,y:p.y,z:p.z});
    for (let x=-1;x<=1;x++) for (let y=-1;y<=1;y++) for (let z=-1;z<=1;z++)
      if (x||y||z) queue.push(p.offset(x,y,z));
  }
  return {name:root.name,root:{x:origin.x,y:origin.y,z:origin.z},pending};
}
module.exports={observeHouseTree};
