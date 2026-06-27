/**
 * LLM Provider 抽象基类 (M3.3)
 *
 * 用法：
 *   - 子类继承 BaseProvider，实现 _initClient() 和 streamMessages() / sendToolResults()
 *   - 子类必须定义 `name`（如 'anthropic' / 'openai'）
 *   - 子类必须实现 _convertMessages(messages, system) 把内部统一格式转成 Provider 原生格式
 *   - 子类必须实现 _convertToNativeMessage(msg) 把单条消息转成 Provider 原生格式
 *
 * 内部统一消息格式（所有 Provider 共用）：
 *   {
 *     role: 'user' | 'assistant' | 'tool',
 *     content: string | Array<{
 *       type: 'text' | 'image' | 'tool_use' | 'tool_result',
 *       text?: string,
 *       base64?: string,    // image
 *       mediaType?: string, // image
 *       id?: string,        // tool_use / tool_result
 *       name?: string,      // tool_use
 *       input?: object,     // tool_use
 *       tool_use_id?: string, // tool_result
 *       content?: string | Array,  // tool_result
 *     }>
 *   }
 */

export class BaseProvider {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} options.model
   * @param {number} [options.maxTokens=8192]
   * @param {number} [options.timeout=300000]
   */
  constructor(options = {}) {
    this.apiKey = options.apiKey || '';
    this.model = options.model || '';
    this.maxTokens = options.maxTokens || 8192;
    this.timeout = options.timeout || 300000;
    this._client = null;
  }

  /** Provider 名称（子类覆盖） */
  get name() { return 'base'; }

  /** Provider 能力位（子类按需覆盖） */
  get capabilities() {
    return {
      toolUse: false,        // function/tool calling
      vision: false,         // image input
      streaming: true,       // 流式输出
      systemPrompt: true,    // 独立 system 字段
      thinking: false,       // extended thinking
    };
  }

  /** 初始化 SDK 客户端（子类必须实现） */
  async _initClient() {
    throw new Error(`_initClient must be implemented by ${this.constructor.name}`);
  }

  async _getClient() {
    if (!this._client) {
      this._client = await this._initClient();
    }
    return this._client;
  }

  /**
   * 流式发送消息（子类必须实现）
   *
   * @param {object} params
   * @param {string} params.system
   * @param {Array<object>} params.messages
   * @param {Array<object>} [params.tools]
   * @param {function(string)} [params.onText]
   * @param {function(string)} [params.onThinking]
   * @param {function(string, string, object)} [params.onToolUse]  (name, callId, input)
   * @param {AbortSignal} [params.signal]
   * @returns {Promise<{text: string, toolCalls: Array<{id, name, input}>}>}
   */
  async streamMessages(params) {
    throw new Error(`streamMessages must be implemented by ${this.constructor.name}`);
  }

  /**
   * 发送工具结果（默认实现：把 tool results 作为 user 消息追加再 stream）
   * 子类可在协议要求不同（如 OpenAI role=tool）时覆盖。
   */
  async sendToolResults({ system, messages, tools, toolResults, onText, signal }) {
    for (const result of toolResults) {
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: result.id, content: result.output }],
      });
    }
    return this.streamMessages({ system, messages, tools, onText, signal });
  }

  /**
   * 友好的错误转换（子类可覆盖以定制错误信息）
   * @param {Error} err
   * @returns {Error} 转译后的错误
   */
  translateError(err) {
    if (err?.status === 429) {
      return new Error('API rate limit exceeded.');
    }
    if (err?.status === 401) {
      return new Error('Authentication failed. Check your API key configuration.');
    }
    return err;
  }
}