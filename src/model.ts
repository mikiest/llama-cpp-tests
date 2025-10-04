import path from 'node:path';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';

export type ContextInfo = { contextSize: number };

export type FunctionTool = {
  name: string;
  description: string;
  parameters: any;
  handler: (args: any) => Promise<any>;
};

export type ModelWrapper = {
  getContextInfo(): Promise<ContextInfo>;
  complete(
    prompt: string,
    opts?: {
      maxTokens?: number;
      temperature?: number;
      stop?: string[];
      functions?: Record<string, FunctionTool>;
    }
  ): Promise<string>;
  dispose(): Promise<void>;
};

export type ModelBackend = 'llama-studio' | 'llama-cpp';

export type EnsureModelOptions = {
  debug?: boolean;
  contextSize?: number;
  backend?: ModelBackend | 'auto';
};

export async function ensureModel(
  modelSpec: string,
  opts: EnsureModelOptions = {},
): Promise<ModelWrapper> {
  const backend = opts.backend ?? 'auto';
  const studioKey = process.env.LLAMA_STUDIO_API_KEY;

  if (backend === 'llama-studio' || (backend === 'auto' && studioKey)) {
    return ensureLlamaStudio(modelSpec, { ...opts, backend: 'llama-studio' });
  }

  if (backend === 'llama-cpp' || backend === 'auto') {
    return ensureLlamaCpp(modelSpec, { ...opts, backend: 'llama-cpp' });
  }

  throw new Error(`Unsupported backend: ${backend}`);
}

async function ensureLlamaStudio(
  modelSpec: string,
  opts: EnsureModelOptions & { backend: 'llama-studio' },
): Promise<ModelWrapper> {
  const apiKey = process.env.LLAMA_STUDIO_API_KEY;
  if (!apiKey) {
    throw new Error('LLAMA_STUDIO_API_KEY environment variable is required to use Llama Studio.');
  }

  const baseURL = process.env.LLAMA_STUDIO_API_BASE ?? 'https://api.llamaindex.ai/v1';
  if (opts.debug) {
    console.log(`Using Llama Studio model "${modelSpec}" via ${baseURL}`);
  }

  const baseConfig = {
    apiKey,
    configuration: { baseURL },
    model: modelSpec,
  } as const;

  const getContextInfo = async (): Promise<ContextInfo> => {
    const contextSize = opts.contextSize ?? 8192;
    return { contextSize };
  };

  const complete = async (
    prompt: string,
    o: {
      maxTokens?: number;
      temperature?: number;
      stop?: string[];
      functions?: Record<string, FunctionTool>;
    } = {},
  ) => {
    const llm = new ChatOpenAI({
      ...baseConfig,
      maxTokens: o.maxTokens,
      temperature: o.temperature,
    });

    const toolMap = new Map<string, FunctionTool>();
    const tools = o.functions
      ? Object.values(o.functions).map(tool => {
          toolMap.set(tool.name, tool);
          return {
            type: 'function' as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          };
        })
      : undefined;

    const buildMessages = (): BaseMessage[] => {
      const match = prompt.match(/([\s\S]*?)\n\nUser task:\n([\s\S]*)/);
      const systemText = match ? match[1].trim() : undefined;
      const userText = match ? match[2] : prompt;
      const msgs: BaseMessage[] = [];
      if (systemText) msgs.push(new SystemMessage(systemText));
      msgs.push(new HumanMessage(userText));
      return msgs;
    };

    const messages: BaseMessage[] = buildMessages();

    while (true) {
      const response = await llm.invoke(messages, { tools, stop: o.stop });
      const toolCalls = response.additional_kwargs?.tool_calls ?? [];

      if (!toolCalls.length) {
        const content = Array.isArray(response.content)
          ? response.content
              .map((part: unknown) => {
                if (typeof part === 'string') return part;
                if (typeof part === 'object' && part !== null && 'text' in part) {
                  return (part as { text?: string }).text ?? '';
                }
                return '';
              })
              .join('')
          : String(response.content ?? '');
        return content.trim();
      }

      messages.push(response);

      for (const call of toolCalls) {
        const fnName = call.function?.name ?? '';
        const tool = toolMap.get(fnName);
        let args: any = {};
        if (call.function?.arguments) {
          try {
            args = JSON.parse(call.function.arguments);
          } catch (err) {
            args = { error: `Failed to parse arguments: ${String(err)}` };
          }
        }

        let result: any;
        if (!tool) {
          result = { ok: false, error: `Unknown tool: ${fnName}` };
        } else {
          result = await tool.handler(args);
        }

        messages.push(
          new ToolMessage({
            tool_call_id: call.id ?? fnName,
            content: typeof result === 'string' ? result : JSON.stringify(result),
          }),
        );
      }
    }
  };

  const dispose = async () => {
    return;
  };

  return { getContextInfo, complete, dispose };
}

async function ensureLlamaCpp(
  modelSpec: string,
  opts: EnsureModelOptions & { backend: 'llama-cpp' },
): Promise<ModelWrapper> {
  let llamaCpp: typeof import('node-llama-cpp');
  try {
    llamaCpp = await import('node-llama-cpp');
  } catch (err) {
    throw new Error(
      'The node-llama-cpp package is required for the llama-cpp backend. Install it or choose the llama-studio backend.',
    );
  }

  const { getLlama, LlamaChatSession, resolveModelFile, defineChatSessionFunction } = llamaCpp;

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
    o: {
      maxTokens?: number;
      temperature?: number;
      stop?: string[];
      functions?: Record<string, FunctionTool>;
    } = {},
  ) => {
    const ctx = await model.createContext({ contextSize: opts.contextSize });
    try {
      const session = new LlamaChatSession({ contextSequence: ctx.getSequence() });
      const promptOptions: Record<string, unknown> = {};
      if (typeof o.maxTokens === 'number') promptOptions.maxTokens = o.maxTokens;
      if (typeof o.temperature === 'number') promptOptions.temperature = o.temperature;
      if (o.stop && o.stop.length) promptOptions.customStopTriggers = o.stop;

      if (o.functions && Object.keys(o.functions).length) {
        promptOptions.functions = Object.values(o.functions).map(tool =>
          defineChatSessionFunction({
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            async handler({ args }) {
              const result = await tool.handler(args);
              return typeof result === 'string' ? result : JSON.stringify(result);
            },
          }),
        );
        promptOptions.documentFunctionParams = false;
      }

      const res = await session.prompt(prompt, promptOptions);
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
