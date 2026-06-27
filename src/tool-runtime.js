/**
 * 工具运行时
 * 工具注册、发现、执行机制
 */

/**
 * 工具运行时
 * 工具注册、发现、执行机制
 */

import { PersengError, ErrorCode } from './errors.js';

export class ToolRuntime {
  constructor() {
    this.tools = new Map();
  }

  /**
   * 注册一个工具
   * @param {object} tool
   * @param {string} tool.name - 工具名称
   * @param {string} tool.description - 工具描述
   * @param {object} tool.schema - JSON Schema 参数定义
   * @param {function} tool.execute - 执行函数 (params) => result
   */
  register(tool) {
    if (!tool.name) {
      throw new PersengError({
        code: ErrorCode.INTERNAL,
        message: 'Tool must have a name',
      });
    }
    this.tools.set(tool.name, {
      name: tool.name,
      description: tool.description || '',
      schema: tool.schema || { type: 'object', properties: {} },
      execute: tool.execute,
    });
  }

  /**
   * 批量注册工具
   * @param {Array} tools
   */
  registerAll(tools) {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /**
   * 获取所有工具定义（用于 Anthropic Tool Use API）
   * @returns {Array} 工具定义数组 [{ name, description, input_schema }]
   */
  getToolDefinitions() {
    return Array.from(this.tools.values()).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.schema,
    }));
  }

  /**
   * 根据名称获取工具定义
   * @param {string} name
   * @returns {object|undefined}
   */
  getTool(name) {
    return this.tools.get(name);
  }

  /**
   * 执行工具
   * @param {string} name - 工具名称
   * @param {object} params - 工具参数
   * @returns {Promise<string>} 执行结果
   */
  async execute(name, params) {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new PersengError({
        code: ErrorCode.TOOL_NOT_FOUND,
        message: `Tool "${name}" not found`,
        userMessage: `工具 "${name}" 未找到`,
        context: { toolName: name },
      });
    }
    try {
      const result = await tool.execute(params || {});
      return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
    } catch (err) {
      // 已经被 PersengError 包过的，保留原 code
      if (err instanceof PersengError) {
        throw err;
      }
      throw new PersengError({
        code: ErrorCode.TOOL_EXEC_FAILED,
        message: `Tool "${name}" execution failed: ${err.message}`,
        userMessage: `工具 "${name}" 执行失败: ${err.message}`,
        cause: err,
        context: { toolName: name },
      });
    }
  }

  /**
   * 移除工具
   * @param {string} name
   */
  unregister(name) {
    this.tools.delete(name);
  }

  /**
   * 获取已注册工具数量
   */
  get size() {
    return this.tools.size;
  }

  /**
   * 获取所有工具名称列表
   */
  listToolNames() {
    return Array.from(this.tools.keys());
  }
}
