export interface MotionCandidate {
  group: string;
  index: number;
  score: number;
}

const SEMANTIC_TOKENS: Record<string, readonly string[]> = {
  greet: ['greet', 'hello', 'wave', 'hi'],
  celebrate: ['celebrate', 'happy', 'joy', 'win'],
  think: ['think', 'idle', 'ponder'],
  agree: ['agree', 'yes', 'nod'],
  disagree: ['disagree', 'no', 'shake'],
  comfort: ['comfort', 'gentle', 'calm'],
};

export const rankMotionGroups = (action: string, groups: readonly string[]): MotionCandidate[] => {
  const tokens = SEMANTIC_TOKENS[action] ?? [action];
  return groups
    .map((group, index) => {
      const lower = group.toLowerCase();
      const tokenScore = tokens.reduce((score, token) => score + (lower.includes(token) ? 10 : 0), 0);
      const idleScore = action === 'think' && lower.includes('idle') ? 2 : 0;
      return { group, index, score: tokenScore + idleScore };
    })
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => right.score - left.score || left.index - right.index);
};
