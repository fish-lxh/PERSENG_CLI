/**
 * LLM 客户端
 *
 * 双 Provider 架构：
 *   - AnthropicProvider (extends BaseProvider)
 *   - OpenAIProvider    (extends BaseProvider — 兼容 DeepSeek / OpenRouter / Moonshot 等)
 *
 * 自动检测 API Key 选择 Provider：
 *   ANTHROPIC_API_KEY → Anthropic  (优先)
 *   OPENAI_API_KEY    → OpenAI 兼容
 *   PERSENG_API_BASE  → 自定义 API 地址（仅 OpenAI 模式）
 *
 * 环境变量:
 *   ANTHROPIC_API_KEY / OPENAI_API_KEY / PERSENG_API_BASE / PERSENG_MODEL
 */

import { BaseProvider } from './llm-providers/BaseProvider.js';
import { withRetry } from './llm-retry.js';
import { getConfig } from './config.js';

// ============================================================
//  辅助: 动态 import SDK（ESM 兼容）
// ============================================================
async function loadSdk(name) {
  try {
    const mod = await import(name);
    return mod.default || mod;
  } catch {
    throw new Error(
      `缺少依赖 "${name}"，请运行: npm install ${name}`
    );
  }
}

// ============================================================
//  Provider: Anthropic
// ============================================================
export class AnthropicProvider extends BaseProvider {
  constructor(options) {
    super(options);
    if (!this.model) this.model = 'claude-sonnet-4-20250514';
  }

  get name() { return 'anthropic'; }

  get capabilities() {
    return {
      ...super.capabilities,
      toolUse: true,
      vision: true,
      thinking: true,
    };
  }

  async _initClient() {
    const Anthropic = await loadSdk('@anthropic-ai/sdk');
    return new Anthropic({
      apiKey: this.apiKey,
      timeout: this.timeout,
    });
  }

  async streamMessages({ system, messages, tools, onText, onThinking, onToolUse, signal }) {
    const client = await this._getClient();
    const anthropicMessages = messages.map((m) => this._convertToNativeMessage(m));

    // M4.3: Prompt caching
    // Anthropic 支持给 system 块和 tools 块加 cache_control: { type: 'ephemeral' }
    // 命中缓存的部分按 ~10% 计费，未命中按全价。
    // 最佳实践：
    //   - system 用 array 形式，第一个 block 加 ephemeral
    //   - tools 数组的最后一个 tool 加 ephemeral（让整个 tools 列表作为 cache boundary）
    const cachedSystem = wrapSystemForCaching(system);
    const cachedTools = wrapToolsForCaching(tools);

    const requestBody = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: cachedSystem,
      messages: anthropicMessages,
      stream: true,
    };
    if (cachedTools && cachedTools.length > 0) requestBody.tools = cachedTools;

    let fullResponse = '';
    const toolCalls = [];

    try {
      const opts = signal ? { signal } : {};
      const stream = await client.messages.create(requestBody, opts);
      for await (const event of stream) {
        switch (event.type) {
          case 'content_block_delta':
            if (event.delta.type === 'text_delta') {
              fullResponse += event.delta.text;
              if (onText) onText(event.delta.text);
            } else if (event.delta.type === 'thinking_delta') {
              if (onThinking) onThinking(event.delta.thinking);
            }
            break;
          case 'content_block_start':
            if (event.content_block?.type === 'tool_use') {
              toolCalls.push({
                id: event.content_block.id,
                name: event.content_block.name,
                input: event.content_block.input,
                type: 'tool_use',
              });
            }
            break;
          // M4.3: 捕获 cache 命中指标
          case 'message_start':
            if (event.message?.usage) {
              this._lastUsage = {
                input_tokens: event.message.usage.input_tokens || 0,
                cache_creation_input_tokens: event.message.usage.cache_creation_input_tokens || 0,
                cache_read_input_tokens: event.message.usage.cache_read_input_tokens || 0,
                output_tokens: 0,
              };
            }
            break;
          case 'message_delta':
            if (event.usage) {
              this._lastUsage = {
                ...(this._lastUsage || {}),
                output_tokens: event.usage.output_tokens || 0,
              };
            }
            break;
        }
      }

      if (toolCalls.length > 0 && onToolUse) {
        for (const tc of toolCalls) onToolUse(tc.name, tc.id, tc.input);
      }
      return { text: fullResponse, toolCalls, usage: this._lastUsage };
    } catch (err) {
      throw this.translateError(err);
    }
  }

  /**
   * M4.3: 获取上一次调用的 token usage（含 cache 命中）
   */
  getLastUsage() {
    return this._lastUsage || null;
  }

  /**
   * 转换单条消息到 Anthropic 多模态格式
   */
  _convertToNativeMessage(msg) {
    if (!Array.isArray(msg.content)) return msg;
    const converted = msg.content.map((part) => {
      if (part.type === 'image') {
        return {
          type: 'image',
          source: {
            type: 'base64',
            media_type: part.mediaType || 'image/png',
            data: part.base64,
          },
        };
      }
      return part;
    });
    return { ...msg, content: converted };
  }
}

// ============================================================
//  M4.3: Prompt caching 工具函数
// ============================================================

/**
 * 把 system prompt 包装成 Anthropic 支持的 cache 格式。
 *  - 原本是 string：转成 [{ type: 'text', text, cache_control: { type: 'ephemeral' } }]
 *  - 原本是 array：给第一个 block 加 cache_control（其余原样）
 *  - 空值返回空数组
 */
function wrapSystemForCaching(system) {
  if (!system) return undefined;
  if (typeof system === 'string') {
    return [{
      type: 'text',
      text: system,
      cache_control: { type: 'ephemeral' },
    }];
  }
  if (Array.isArray(system) && system.length > 0) {
    // 已经是 array 形式，给第一个加 cache_control
    const copy = system.map((b) => ({ ...b }));
    copy[0] = { ...copy[0], cache_control: { type: 'ephemeral' } };
    return copy;
  }
  return undefined;
}

/**
 * 给 tools 列表的最后一个 tool 加 cache_control。
 * Anthropic 的 cache 是 prefix-based：标记的 block 之前的内容都会被缓存。
 * 把 cache 标在最后一个 tool 让整个 tools 列表成为 cache boundary。
 */
function wrapToolsForCaching(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return tools;
  const copy = tools.map((t) => ({ ...t }));
  copy[copy.length - 1] = {
    ...copy[copy.length - 1],
    cache_control: { type: 'ephemeral' },
  };
  return copy;
}

// ============================================================
//  Provider: OpenAI (兼容 DeepSeek / OpenRouter / Moonshot 等)
// ============================================================
export class OpenAIProvider extends BaseProvider {
  constructor(options) {
    super(options);
    this.apiBase = options.apiBase || '';
    if (!this.model) this.model = 'gpt-4o';
  }

  get name() { return 'openai'; }

  get capabilities() {
    return {
      ...super.capabilities,
      toolUse: true,
      vision: true,
    };
  }

  async _initClient() {
    const OpenAI = await loadSdk('openai');
    const clientOptions = {
      apiKey: this.apiKey,
      timeout: this.timeout,
      maxRetries: 2,
    };
    if (this.apiBase) clientOptions.baseURL = this.apiBase;
    return new OpenAI(clientOptions);
  }

  async streamMessages({ system, messages, tools, onText, onThinking, onToolUse, signal }) {
    const client = await this._getClient();
    const openaiMessages = this._convertMessages(system, messages);

    const requestBody = {
      model: this.model,
      max_tokens: this.maxTokens,
      messages: openaiMessages,
      stream: true,
    };

    if (tools && tools.length > 0) {
      requestBody.tools = tools.map((t) => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.input_schema || t.schema || { type: 'object', properties: {} },
        },
      }));
    }

    let fullResponse = '';
    const toolCalls = [];
    const pendingToolCalls = {};

    try {
      const opts = signal ? { signal } : {};
      const stream = await client.chat.completions.create(requestBody, { ...opts });
      for await (const chunk of stream) {
        const delta = chunk.choices?.[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          fullResponse += delta.content;
          if (onText) onText(delta.content);
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!pendingToolCalls[idx]) {
              pendingToolCalls[idx] = { id: '', name: '', arguments: '', type: 'tool_use' };
            }
            if (tc.id) pendingToolCalls[idx].id = tc.id;
            if (tc.function?.name) pendingToolCalls[idx].name = tc.function.name;
            if (tc.function?.arguments) pendingToolCalls[idx].arguments += tc.function.arguments;
          }
        }
      }

      for (const idx of Object.keys(pendingToolCalls).sort()) {
        const tc = pendingToolCalls[idx];
        try { tc.input = JSON.parse(tc.arguments); }
        catch { tc.input = { raw: tc.arguments }; }
        delete tc.arguments;
        toolCalls.push(tc);
      }

      if (toolCalls.length > 0 && onToolUse) {
        for (const tc of toolCalls) onToolUse(tc.name, tc.id, tc.input);
      }
      return { text: fullResponse, toolCalls };
    } catch (err) {
      throw this.translateError(err);
    }
  }

  /**
   * OpenAI 协议要求 tool 消息用 role='tool' + tool_call_id 单独成条
   */
  async sendToolResults({ system, messages, tools, toolResults, onText, signal }) {
    for (const result of toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: result.id,
        content: typeof result.output === 'string' ? result.output : JSON.stringify(result.output),
      });
    }
    return this.streamMessages({ system, messages, tools, onText, signal });
  }

  /**
   * 将内部统一消息格式转换为 OpenAI Chat Completions 格式
   */
  _convertMessages(system, messages) {
    const result = [];
    if (system) result.push({ role: 'system', content: system });

    for (const msg of messages) {
      if (msg.role === 'user') {
        if (Array.isArray(msg.content)) {
          const textParts = msg.content.filter(p => p.type !== 'tool_result');
          const toolResults = msg.content.filter(p => p.type === 'tool_result');
          for (const tr of toolResults) {
            const tcId = tr.tool_use_id || '';
            const content = typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content || '');
            if (tcId) {
              result.push({ role: 'tool', tool_call_id: tcId, content });
            }
          }
          if (textParts.length > 0) {
            result.push({
              role: 'user',
              content: textParts.map(p => {
                if (p.type === 'text') return { type: 'text', text: p.text };
                if (p.type === 'image') {
                  const mediaType = p.mediaType || 'image/png';
                  return {
                    type: 'image_url',
                    image_url: { url: `data:${mediaType};base64,${p.base64}` },
                  };
                }
                return { type: 'text', text: JSON.stringify(p) };
              }),
            });
          }
        } else {
          result.push({ role: 'user', content: msg.content });
        }
      } else if (msg.role === 'assistant') {
        if (Array.isArray(msg.content)) {
          const textParts = msg.content.filter(p => p.type === 'text').map(p => p.text);
          const tcParts = msg.content.filter(p => p.type === 'tool_use');
          const entry = { role: 'assistant', content: textParts.join('') || null };
          if (tcParts.length > 0) {
            entry.tool_calls = tcParts.map(tc => ({
              id: tc.id,
              type: 'function',
              function: { name: tc.name, arguments: JSON.stringify(tc.input) },
            }));
          }
          result.push(entry);
        } else {
          result.push({ role: 'assistant', content: msg.content });
        }
      } else if (msg.role === 'tool' || msg.role === 'tool_result') {
        const tcId = msg.tool_call_id
          || (Array.isArray(msg.content) ? msg.content[0]?.tool_use_id : null);
        const content = typeof msg.content === 'string'
          ? msg.content
          : (Array.isArray(msg.content)
              ? msg.content.map(p => p.content || '').join('\n')
              : JSON.stringify(msg.content));
        if (tcId) {
          result.push({ role: 'tool', tool_call_id: tcId, content });
        }
      }
    }
    return result;
  }
}

// ============================================================
//  向后兼容：导出旧名 AnthropicProviderImpl / OpenAIProviderImpl
//  （已有单元测试和外部代码可能引用）
// ============================================================
export { AnthropicProvider as AnthropicProviderImpl, OpenAIProvider as OpenAIProviderImpl };

// ============================================================
//  主类: LlmClient（工厂 + Provider 管理）
// ============================================================
export class LlmClient {
  /**
   * @param {object} options
   * @param {string} [options.apiKey]
   * @param {string} [options.anthropicApiKey]
   * @param {string} [options.openaiApiKey]
   * @param {string} [options.apiBase]
   * @param {string} [options.model]
   * @param {number} [options.maxTokens]
   * @param {number} [options.timeout]
   */
  constructor(options = {}) {
    this.anthropicApiKey = options.anthropicApiKey || options.apiKey || '';
    this.openaiApiKey = options.openaiApiKey || '';
    this.apiBase = options.apiBase || '';
    this.model = options.model || 'claude-sonnet-4-20250514';
    this.maxTokens = options.maxTokens || 8192;
    this.timeout = options.timeout || 300000;

    if (this.anthropicApiKey) {
      this.providerType = 'anthropic';
    } else if (this.openaiApiKey) {
      this.providerType = 'openai';
      if (!options.model) this.model = 'gpt-4o';
    } else {
      throw new Error(
        '需要设置 API Key。请设置 ANTHROPIC_API_KEY 或 OPENAI_API_KEY 环境变量。\n' +
        '  ANTHROPIC_API_KEY=sk-ant-...   (Anthropic Claude)\n' +
        '  OPENAI_API_KEY=sk-...          (OpenAI / DeepSeek / OpenRouter 等)'
      );
    }

    this._provider = null;
  }

  /** 延迟初始化 provider */
  async _getProvider() {
    if (this._provider) return this._provider;

    if (this.providerType === 'anthropic') {
      this._provider = new AnthropicProvider({
        apiKey: this.anthropicApiKey,
        model: this.model,
        maxTokens: this.maxTokens,
        timeout: this.timeout,
      });
    } else {
      this._provider = new OpenAIProvider({
        apiKey: this.openaiApiKey,
        apiBase: this.apiBase,
        model: this.model,
        maxTokens: this.maxTokens,
        timeout: this.timeout,
      });
    }

    return this._provider;
  }

  async streamMessages(params) {
    const provider = await this._getProvider();
    // M4.7: retry 包一层（可通过 PERSENG_LLM_RETRY=0 关闭）
    const config = getConfig();
    if (!config.llmRetryEnabled) {
      return provider.streamMessages(params);
    }
    const maxRetries = config.llmMaxRetries;
    const baseDelayMs = config.llmBaseDelayMs;
    return withRetry(
      () => provider.streamMessages(params),
      {
        maxRetries,
        baseDelayMs,
        model: this.model,
        kind: 'stream',
        signal: params?.signal,
      }
    );
  }

  async sendToolResults(params) {
    const provider = await this._getProvider();
    const config = getConfig();
    if (!config.llmRetryEnabled) {
      return provider.sendToolResults(params);
    }
    const maxRetries = config.llmMaxRetries;
    const baseDelayMs = config.llmBaseDelayMs;
    return withRetry(
      () => provider.sendToolResults(params),
      {
        maxRetries,
        baseDelayMs,
        model: this.model,
        kind: 'tool_results',
        signal: params?.signal,
      }
    );
  }

  /** 暴露当前 provider 的能力位（用于动态工具启用） */
  async capabilities() {
    const provider = await this._getProvider();
    return provider.capabilities;
  }
}
