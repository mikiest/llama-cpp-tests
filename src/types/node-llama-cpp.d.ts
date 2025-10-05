declare module 'node-llama-cpp' {
  export type LoadedModel = {
    createContext(options: { contextSize?: number }): Promise<{
      contextSize: number;
      dispose(): Promise<void>;
      getSequence(): unknown;
    }>;
    dispose(): Promise<void>;
  };

  export function resolveModelFile(spec: string): Promise<string>;
  export function getLlama(): Promise<{
    loadModel(options: { modelPath: string }): Promise<LoadedModel>;
  }>;

  export class LlamaChatSession {
    constructor(options: { contextSequence: unknown });
    prompt(prompt: string, options?: Record<string, unknown>): Promise<string>;
  }

  export function defineChatSessionFunction(options: {
    name: string;
    description?: string;
    parameters?: any;
    handler: (payload: { args: any }) => Promise<string> | string;
  }): unknown;
}
