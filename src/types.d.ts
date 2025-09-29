declare module 'p-limit' {
  export default function pLimit(concurrency: number): <T>(fn: () => Promise<T>) => Promise<T>;
}
