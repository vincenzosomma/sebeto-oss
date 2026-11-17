import { describe, expect, it } from 'vitest';
import { agentBudgetReached, budgetReached } from './BudgetCard';

describe('budget card limits', () => {
  it('ticket cap reached', () => {
    expect(budgetReached({ costUsd: 6.06, costCapUsd: 6.06 })).toBe(true);
    expect(budgetReached({ costUsd: 3.1, costCapUsd: 6.06 })).toBe(false);
  });
  it('agent monthly budget reached even when the ticket cap is not (second raise case)', () => {
    const b = { agentId: 'a', name: 'Sysadmin', monthlyBudgetUsd: 20, spentUsd: 21.17 };
    expect(budgetReached({ costUsd: 21.17, costCapUsd: 21.24 })).toBe(false);
    expect(agentBudgetReached(b)).toBe(true);
    expect(agentBudgetReached({ ...b, spentUsd: 5 })).toBe(false);
    expect(agentBudgetReached(undefined)).toBe(false);
  });
});
