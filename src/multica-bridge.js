/**
 * Multica 协议桥 (stub — Step 6 实现)
 * NDJSON over stdin/stdout 协议
 */

export class MulticaBridge {
  constructor(engine, options = {}) {
    this.engine = engine;
    this.roleId = options.roleId || 'jiangziya';
    this.sessionId = options.sessionId || `perseng-${Date.now()}`;
  }

  /**
   * 发送 NDJSON 消息到 stdout
   */
  send(type, payload = {}) {
    const msg = JSON.stringify({ type, ...payload, sessionId: this.sessionId });
    process.stdout.write(msg + '\n');
  }

  /**
   * 发送文本消息
   */
  sendText(content) {
    this.send('text', { content });
  }

  /**
   * 发送思考消息
   */
  sendThinking(content) {
    this.send('thinking', { content });
  }

  /**
   * 发送状态消息
   */
  sendStatus(status, message = '') {
    this.send('status', { status, message });
  }

  /**
   * 发送工具调用消息
   */
  sendToolUse(tool, callId, input) {
    this.send('tool-use', { tool, callId, input });
  }

  /**
   * 发送工具结果消息
   */
  sendToolResult(callId, output) {
    this.send('tool-result', { callId, output });
  }

  /**
   * 发送错误消息
   */
  sendError(content) {
    this.send('error', { content });
  }

  /**
   * 发送日志消息
   */
  sendLog(level, content) {
    this.send('log', { level, content });
  }

  /**
   * 处理来自 Multica 的 NDJSON 输入
   */
  async handleInput(msg) {
    switch (msg.type) {
      case 'task':
        await this.handleTask(msg);
        break;

      case 'cancel':
        this.handleCancel(msg);
        break;

      default:
        this.sendError(`Unknown message type: ${msg.type}`);
    }
  }

  /**
   * 处理任务
   */
  async handleTask(msg) {
    const taskId = msg.id || 'unknown';
    const prompt = msg.prompt || '';
    const context = msg.context || {};

    this.sendStatus('task_received', `Task ${taskId} received`);

    try {
      this.sendStatus('processing', 'Processing task...');

      // 通过任务引擎执行
      const result = await this.engine.run(prompt, {
        roleId: msg.role || this.roleId,
        taskId,
        ...context,
      });

      this.sendStatus('completed', 'Task completed');
      this.sendText(result);

    } catch (err) {
      this.sendStatus('failed', err.message);
      this.sendError(err.message);
    }
  }

  /**
   * 处理取消
   */
  handleCancel(msg) {
    this.sendStatus('cancelled', `Task ${msg.taskId || 'unknown'} cancelled`);
  }
}
