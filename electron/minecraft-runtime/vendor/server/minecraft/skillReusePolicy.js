// Direct dispatch is for one recognized operation. Compound or conditional
// language must still go through structured planning instead of dropping clauses.
function canDirectDispatch(command, plan) {
  if (plan?.mode !== 'task' || !plan.steps?.length) return false;
  if (/然后|再去|接着|之后|并且|同时|如果|除非|不要|别|\b(?:then|and|if|unless|without|don't|not)\b/i.test(command)) return false;
  return new Set(['gather_wood', 'mine_resource',
    'mine_diamond_resource', 'craft_item', 'follow_player', 'escort_player',
    'go_to_position', 'withdraw_items', 'deposit_items']).has(plan.intent);
}

module.exports = { canDirectDispatch };
