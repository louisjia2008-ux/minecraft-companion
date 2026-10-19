import { describe, expect, it } from 'vitest';

import { rankMotionGroups } from './semantic-action';

describe('rankMotionGroups', () => {
  it('selects semantic motion groups deterministically without mapping model metadata to commands', () => {
    expect(rankMotionGroups('greet', ['Idle', 'WaveHello', 'TapBody'])[0]).toMatchObject({ group: 'WaveHello' });
    expect(rankMotionGroups('unknown-action', ['Idle', 'TapBody'])).toEqual([]);
  });
});
