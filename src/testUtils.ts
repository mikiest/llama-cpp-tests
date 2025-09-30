export function countTests(ts: string): number {
  const re = /\bit\s*\(|\btest\s*\(/g;
  let c = 0;
  while (re.exec(ts)) c++;
  return c;
}

export function detectHints(ts: string): string[] {
  const hints: string[] = [];
  if (ts.includes('@testing-library/react-native')) hints.push('RTL native');
  else if (ts.includes('@testing-library/react')) hints.push('RTL web');
  if (/msw\b|\bsetupServer\b/.test(ts)) hints.push('MSW');
  if (/jest\.|vi\./.test(ts)) hints.push('mocks');
  return hints;
}
