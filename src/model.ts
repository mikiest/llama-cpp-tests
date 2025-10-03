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

export async function ensureModel(
  modelSpec: string,
  opts: { debug?: boolean; contextSize?: number } = {},
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
              .map(part => {
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
