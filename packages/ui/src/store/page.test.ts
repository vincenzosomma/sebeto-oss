import { describe, expect, it } from 'vitest';
import { initialState, reducer } from './reducer';

describe('page navigation', () => {
  it('starts on the board and switches to the Agents & skills page, closing the ticket panel', () => {
    const s0 = initialState({ selectedId: 't1' });
    expect(s0.page).toBe('board');
    const s1 = reducer(s0, { type: 'setPage', page: 'agents' });
    expect(s1.page).toBe('agents');
    expect(s1.selectedId).toBeNull();
    expect(reducer(s1, { type: 'setPage', page: 'agents' })).toBe(s1);
    expect(reducer(s1, { type: 'setPage', page: 'board' }).page).toBe('board');
  });
});
