import { describe, expect, it } from 'vitest';
import { splitCommandLine } from './Connectors';

describe('splitCommandLine', () => {
  it('splits on spaces and honours quotes', () => {
    expect(splitCommandLine('npx -y @scope/server@1.2.3 --root "D:\\My Shares\\Runbooks" \'a b\' ""')).toEqual(
      ['npx', '-y', '@scope/server@1.2.3', '--root', 'D:\\My Shares\\Runbooks', 'a b', '']);
    expect(splitCommandLine('   ')).toEqual([]);
  });
});
