export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool' | 'function' | string;
  content: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: any[];
  function_call?: any;
}

export interface LlmCompletionRequest {
  model: string;
  messages: LlmMessage[];
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface LlmCompletionResponse {
  content: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  finishReason: string;
}

export interface ILlmProvider {
  readonly providerName: string;
  generateCompletion(request: LlmCompletionRequest): Promise<LlmCompletionResponse>;
  streamCompletion(
    request: LlmCompletionRequest,
    onChunk: (chunk: string) => void,
    signal?: AbortSignal,
  ): Promise<LlmCompletionResponse>;
}
