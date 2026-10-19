'use strict';

// Mineflayer4.37.1 openBlock starts activateBlock without awaiting its promise.
// Keep native window extension/transactions, but propagate a rejected activation
// to the owning opener instead of leaving an unhandled process-level rejection.
async function withNativeWindowActivation(bot, open) {
  const original=bot.activateBlock,before=new Set(bot.rawListeners?.('windowOpen')||[]);
  let rejectActivation;
  const failed=new Promise((_,reject)=>{rejectActivation=reject;});failed.catch(()=>{});
  const bridge=function(...args){
    const pending=original.apply(this,args);
    // Attach synchronously, before openBlock discards the native promise.
    Promise.resolve(pending).catch(error=>{rejectActivation(error);});
    return pending;
  };
  bot.activateBlock=bridge;
  let opening,ownListeners=[];
  try {
    opening=Promise.resolve(open());
    ownListeners=(bot.rawListeners?.('windowOpen')||[]).filter(listener=>!before.has(listener));
  } finally {
    if(bot.activateBlock===bridge)bot.activateBlock=original;
  }
  try {return await Promise.race([opening,failed]);}
  catch(error){
    // The native waiter retains its original20s timeout, and its rejection is
    // observed by the race. Remove only this opener's listener now so a later
    // unrelated window cannot complete the rejected operation.
    for(const listener of ownListeners)bot.removeListener('windowOpen',listener);
    throw error;
  }
}
module.exports={withNativeWindowActivation};
