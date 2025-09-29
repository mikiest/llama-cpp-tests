import * as path from 'node:path';
import { getLlama, LlamaChatSession, resolveModelFile } from 'node-llama-cpp';

export type ContextInfo = { contextSize: number };

export type ModelWrapper = {
  getContextInfo(): Promise<ContextInfo>;
  complete(
    prompt: string,
    opts?: { maxTokens?: number; temperature?: number; stop?: string[] }
  ): Promise<string>;
  dispose(): Promise<void>;
};

export async function ensureModel(
  modelSpec: string,
  opts: { debug?: boolean, contextSize?: number } = {}
): Promise<ModelWrapper> {
  const modelPath = await resolveModelFile(modelSpec).catch(async () => {
    const source = modelSpec.startsWith('http') ? modelSpec : path.resolve(modelSpec);
    return resolveModelFile(source);
  });
  if (opts.debug) console.log(`Model path resolved to: ${modelPath}`);

  const llama = await getLlama();
  const model = await llama.loadModel({ modelPath });

  const getContextInfo = async (): Promise<ContextInfo> => {
    try {
      const ctx = await model.createContext({ contextSize: opts.contextSize });
      const info = { contextSize: ctx.contextSize };
      await ctx.dispose();
      return info;
    } catch (e) {
      if (opts.debug) console.warn('Context probe failed, defaulting to 4096:', e);
      return { contextSize: 4096 };
    }
  };

  const complete = async (
    prompt: string,
    o: { maxTokens?: number; temperature?: number; stop?: string[] } = {}
  ) => {
    const ctx = await model.createContext({ contextSize: opts.contextSize });
    try {
      const session = new LlamaChatSession({ contextSequence: ctx.getSequence() });
      const res = await session.prompt(prompt);
      return res.trim();
    } finally {
      await ctx.dispose();
    }
  };

  const dispose = async () => {
    await model.dispose();
  };

  return { getContextInfo, complete, dispose };
}
