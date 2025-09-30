export type FileSummary = {
  status: 'wrote' | 'exists' | 'skip';
  cases?: number;
  hints?: string;
  reason?: string;
  startedAt?: number;
  tokens?: number;
  durationMs?: number;
};
