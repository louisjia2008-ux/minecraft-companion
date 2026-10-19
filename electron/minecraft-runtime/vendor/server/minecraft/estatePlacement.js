/* global require, module, setTimeout */
'use strict';
const { Vec3 } = require('vec3');
const { matchesFurnishedHouseBlock } = require('./furnishedHouseBuilder');
const taps = new WeakMap();
const faces = [[0,-1,0],[0,1,0],[0,0,-1],[0,0,1],[-1,0,0],[1,0,0]];
const fail = (message, details = {}) => Object.assign(new Error(message), { code: 'estate_placement_debit_unconfirmed', ...details });
const samePosition = (a, b) => a && b && ['x','y','z'].every(axis => a[axis] === b[axis]);

function createEstatePlacement(deps) {
  async function place(spec, onConfirmed) {
    deps.assertActive();
    const bot = deps.getBot(), client = bot?._client;
    if (!client || typeof client.write !== 'function' || typeof deps.placeNative !== 'function'
      || typeof deps.isOwnerContext !== 'function') throw fail('庄园原生放置或归属检查尚未接入');
    const expected = [spec, ...(spec.derivedBlocks || [])];
    const matches = entry => matchesFurnishedHouseBlock(bot.blockAt(new Vec3(entry.position.x, entry.position.y, entry.position.z)), entry);
    const complete = () => expected.every(matches);
    if (complete()) return { alreadyComplete: true, consumed: false };
    const primaryAlreadyPresent = matches(spec);
    const Item = require('prismarine-item')(bot.registry);
    let sent, debit, foreignTargetWrite = false;
    const acknowledgements = [];
    const frame = { previous: client.write, active: true };
    const targetPacket = (name, packet) => {
      const direction = faces[packet?.direction], reference = packet?.location;
      return name === 'block_place' && direction && reference && samePosition({
        x: reference.x + direction[0], y: reference.y + direction[1], z: reference.z + direction[2],
      }, spec.position);
    };
    function tappedWrite(...args) {
      if (frame.active && targetPacket(args[0], args[1])) {
        if (deps.isOwnerContext() === true) {
          deps.assertActive();
          if (sent) throw fail('同一庄园方块出现重复原生放置请求，已拒绝重发');
          const quickBar = bot.quickBarSlot;
          const slot = 36 + quickBar;
          const selected = bot.inventory?.slots?.[slot], held = bot.heldItem;
          if (!Number.isInteger(quickBar) || quickBar < 0 || quickBar > 8 || !selected || !held
            || selected.name !== spec.item || held.name !== spec.item || selected.count !== held.count
            || !Number.isInteger(selected.count) || selected.count <= 0) {
            throw fail(`放置 ${spec.item} 前没有确认真实手持槽与材料数量`);
          }
          sent = { slot, item: spec.item, count: selected.count, latestCount: selected.count, sentAt: Date.now() };
        } else foreignTargetWrite = true;
      }
      return frame.previous.apply(this, args);
    }
    function onSlot(packet) {
      if (!sent || debit || packet.windowId !== 0 || packet.slot !== sent.slot) return;
      let item;
      try { item = Item.fromNotch(packet.item); }
      catch { acknowledgements.push({ malformed: true }); return; }
      const afterCount = item?.count || 0;
      const sameItem = !item || item.name === sent.item;
      acknowledgements.push({ at: Date.now(), slot: packet.slot, stateId: packet.stateId,
        item: item?.name || null, beforeCount: sent.latestCount, afterCount });
      if (!sameItem) return;
      if (afterCount === sent.latestCount - 1) {
        debit = { slot: sent.slot, item: sent.item, beforeCount: sent.latestCount, afterCount, stateId: packet.stateId };
      } else if (afterCount > sent.latestCount) {
        // A native pickup can add to the selected stack before consumption.
        // Observe that server ACK, then require its own one-item debit.
        sent.latestCount = afterCount;
      }
    }
    function restoreTap() {
      frame.active = false;
      if (client.write === tappedWrite) {
        let previous = frame.previous;
        while (taps.get(previous)?.active === false) previous = taps.get(previous).previous;
        client.write = previous;
      }
    }
    taps.set(tappedWrite, frame);
    client.on('set_slot', onSlot);
    client.write = tappedWrite;
    try {
      let result;
      try { result = await deps.placeNative(spec, onConfirmed); }
      finally { restoreTap(); }
      deps.assertActive();
      if (!complete()) throw fail(`放置 ${spec.item} 后本体或派生方块未完整确认`, { sent, acknowledgements });
      // A restored primary can finish awaiting its previous derived response
      // without sending a new placement; it must not consume another item.
      if (!sent && primaryAlreadyPresent && !foreignTargetWrite) return result;
      if (!sent) throw fail(`放置 ${spec.item} 没有捕获本任务的原生目标包`, { acknowledgements });
      const deadline = Date.now() + (deps.timeoutMs ?? 2500);
      while (!debit) {
        deps.assertActive();
        if (deps.getBot() !== bot || bot._client !== client) throw fail('等待放置材料回包时机器人连接已改变', { sent, acknowledgements });
        if (Date.now() >= deadline) throw fail(`放置 ${spec.item} 后未确认源槽 ${sent.slot} 的一次真实消耗`, { sent, acknowledgements });
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      deps.assertActive();
      return result;
    } finally {
      restoreTap();
      client.removeListener('set_slot', onSlot);
    }
  }
  return { place };
}

module.exports = { createEstatePlacement };
