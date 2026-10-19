/* global module, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask */
'use strict';

const cancelScopes = new WeakMap();
const frames = new WeakMap();
const sessions = new WeakMap();
const same = (a, b) => Boolean(a && b && ['x', 'y', 'z'].every(key => a[key] === b[key]));
const failure = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });

// Outer native source guards must delegate their status=1 exception to this
// proof. It exists only during one synchronous call of the captured native
// stopDigging, and never permits start/finish or another block/connection.
function isOwnedHouseNativeDigCancel(bot, name, data) {
  const session = cancelScopes.get(bot?._client);
  return Boolean(name === 'block_dig' && data?.status === 1 && session?.cancelling === true
    && session.bot === bot && session.client === bot._client
    && bot.targetDigBlock === session.block && bot.stopDigging === session.stopFunction
    && same(data.location, session.block.position));
}

function unwrap(previous) {
  while (frames.get(previous)?.active === false) previous = frames.get(previous).previous;
  return previous;
}

function wrap(target, key, build) {
  const frame = { previous: target[key], active: true };
  const own = build(frame);
  frames.set(own, frame);
  target[key] = own;
  return () => {
    frame.active = false;
    if (target[key] === own) target[key] = unwrap(frame.previous);
  };
}

function createHouseNativeDigSession(deps) {
  for (const name of ['getBot', 'captureOwner', 'assertOwner', 'isOwnerCurrent', 'isOwnerContext', 'abortOwner', 'runPhysicalAction']) {
    if (typeof deps?.[name] !== 'function') throw failure('house_native_dig_dependency', `原生挖掘会话缺少 ${name}`);
  }

  async function dig(block, options) {
    if (!block?.position || typeof options?.assertActive !== 'function' || typeof options?.beforeSend !== 'function') {
      throw failure('house_native_dig_invalid', '原生挖掘需要实际方块、执行守卫和最终发包守卫');
    }
    const timeoutMs = options.timeoutMs ?? 12000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
      throw failure('house_native_dig_invalid', '原生挖掘时限必须为 1 至 300000 毫秒');
    }
    const owner = deps.captureOwner(), bot = deps.getBot(), client = bot?._client;
    if (!client?.write || typeof bot.dig !== 'function' || typeof bot.lookAt !== 'function') {
      throw failure('house_native_dig_invalid', '原生挖掘需要已连接的 Mineflayer 实例');
    }
    let session;
    const assert = () => {
      if (session?.error) throw session.error;
      deps.assertOwner(owner);
      if (deps.getBot() !== bot || bot._client !== client) throw failure('house_native_dig_owner_changed', '原生挖掘连接已更换');
      options.assertActive();
    };
    assert(); options.beforeSend();
    if (sessions.has(client) || bot.targetDigBlock) throw failure('house_native_dig_busy', '不能抢占其它尚未结束的原生挖掘');

    session = { bot, client, block, owner, initialStop: bot.stopDigging,
      started: false, settled: false, cancelling: false, cancelAttempted: false,
      stopFunction: null, error: null, cleanupError: null, lastSwing: 0 };
    sessions.set(client, session);
    let monitor, nativePromise, rejectOperation;
    let disposeWrite = () => {}, disposeLook = () => {}, disposed = false;

    function dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(monitor);
      disposeLook(); disposeWrite();
      if (sessions.get(client) === session) sessions.delete(client);
    }
    function captureStop() {
      if (session.started && bot.targetDigBlock === block && !session.stopFunction
        && bot.stopDigging !== session.initialStop) session.stopFunction = bot.stopDigging;
    }
    function stopOwn() {
      captureStop();
      if (session.cancelAttempted || deps.getBot() !== bot || bot._client !== client
        || bot.targetDigBlock !== block || !session.stopFunction || bot.stopDigging !== session.stopFunction) return false;
      session.cancelAttempted = true;
      session.cancelling = true;
      cancelScopes.set(client, session);
      try { session.stopFunction.call(bot); return true; }
      catch (error) { session.cleanupError = { code: error.code || null, message: error.message }; return false; }
      finally {
        session.cancelling = false;
        if (cancelScopes.get(client) === session) cancelScopes.delete(client);
      }
    }
    function rejectOwner(error) {
      session.error ||= error;
      stopOwn();
      rejectOperation?.(session.error);
    }

    async function actualNativeDig(signal) {
      const revoked = new Promise((_resolve, reject) => { rejectOperation = reject; });
      disposeLook = wrap(bot, 'lookAt', frame => function (...args) {
        if (!frame.active || !deps.isOwnerContext(owner)) return frame.previous.apply(this, args);
        assert();
        return Promise.resolve(frame.previous.apply(this, args)).then(value => {
          assert();
          // The installed plugin would otherwise stop a dig that started while
          // this look was pending. Such a dig belongs to another invocation.
          if (!session.started && bot.targetDigBlock) throw failure('house_native_dig_busy', '转向期间已有其它原生挖掘开始');
          return value;
        });
      });
      disposeWrite = wrap(client, 'write', frame => function (name, data, ...rest) {
        if (!frame.active || !deps.isOwnerContext(owner)) return frame.previous.call(this, name, data, ...rest);
        if (name === 'block_dig' && same(data?.location, block.position)) {
          if (isOwnedHouseNativeDigCancel(bot, name, data)) return frame.previous.call(this, name, data, ...rest);
          try { assert(); options.beforeSend(); }
          catch (error) {
            session.error ||= error;
            // A throw from the installed finishDigging timer would escape its
            // Promise. Deny finish and reject via the exact native cancel.
            if (data.status === 2) { rejectOwner(error); return; }
            throw error;
          }
          let result;
          try { result = frame.previous.call(this, name, data, ...rest); }
          catch (error) {
            session.error ||= error;
            if (data.status === 2) { rejectOwner(error); return; }
            throw error;
          }
          if (data.status === 0) {
            session.started = true;
            signal('native_dig_started');
            queueMicrotask(() => {
              captureStop();
              try { assert(); } catch (error) { rejectOwner(error); }
            });
          }
          if (data.status === 2) signal('native_dig_finish_packet');
          return result;
        }
        if (name === 'arm_animation' && session.started && bot.targetDigBlock === block && Date.now() - session.lastSwing >= 5000) {
          try { assert(); }
          catch (error) {
            // First swing precedes the plugin's stopDigging assignment. The
            // queued start check will cancel after that assignment completes.
            rejectOwner(error); return;
          }
          session.lastSwing = Date.now(); signal('native_dig_swing');
        }
        return frame.previous.call(this, name, data, ...rest);
      });
      nativePromise = Promise.resolve().then(() => {
        assert(); options.beforeSend();
        return bot.dig(block, options.forceLook ?? false, options.digFace || 'auto');
      });
      nativePromise.then(() => { session.settled = true; }, () => { session.settled = true; });
      monitor = setInterval(() => {
        try { assert(); captureStop(); } catch (error) { rejectOwner(error); }
      }, 20);
      try { await Promise.race([nativePromise, revoked]); }
      catch (error) { throw session.error || error; }
      if (session.error) throw session.error;
      assert();
    }

    try {
      return await deps.runPhysicalAction('act', 'bot.dig', actualNativeDig, {
        timeoutMs, requireStartupSignal: false, startupGraceMs: timeoutMs,
        stallMs: timeoutMs, allowCompleteAsSignal: false, stageKind: 'gather',
        isOwnerCurrent: () => deps.isOwnerCurrent(owner),
      });
    } catch (error) {
      session.error ||= error;
      stopOwn();
      if (nativePromise && !session.settled) {
        let timer;
        const settled = await Promise.race([
          nativePromise.then(() => true, () => true),
          new Promise(resolve => { timer = setTimeout(() => resolve(false), 5000); }),
        ]);
        clearTimeout(timer);
        if (!settled) {
          const pending = failure('house_native_dig_cleanup_pending', '原生挖掘尚未确认结束，暂停并保留旧会话守卫', {
            nativeSettlement: 'UNKNOWN', cause: session.error, cleanupError: session.cleanupError,
          });
          try { deps.abortOwner(pending, owner); }
          catch (abortError) { pending.abortOwnerFailure = { code: abortError.code || null, message: abortError.message }; }
          clearInterval(monitor);
          nativePromise.then(dispose, dispose);
          throw pending;
        }
      }
      if (session.cleanupError) session.error.nativeCleanupError = session.cleanupError;
      throw session.error;
    } finally {
      if (!nativePromise || session.settled) dispose();
    }
  }
  return { dig };
}

module.exports = { createHouseNativeDigSession, isOwnedHouseNativeDigCancel };
