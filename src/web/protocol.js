/**
 * WebUI WebSocket 协议常量
 *
 * 客户端 → 服务端 (Client → Server)
 *   - message   发送一条 prompt，启动一次 agent run
 *   - cancel    取消当前 tabId 的 in-flight 任务
 *   - set_role  切换 tabId 的角色（重建 session）
 *   - ping      心跳
 *
 * 服务端 → 客户端 (Server → Client)
 *   - text         LLM 流式文本片段
 *   - tool_use     工具调用（informational，前端可显示 chip）
 *   - role_loaded  角色已加载/切换完成
 *   - done         run() resolve（成功完成）
 *   - error        run() reject 或 PersengError
 *   - cancelled    cancel ack
 *   - pong         心跳响应
 */

export const WS_TYPE = Object.freeze({
  // C → S
  MESSAGE: 'message',
  CANCEL: 'cancel',
  SET_ROLE: 'set_role',
  PING: 'ping',
  // S → C
  TEXT: 'text',
  TOOL_USE: 'tool_use',
  ROLE_LOADED: 'role_loaded',
  DONE: 'done',
  ERROR: 'error',
  CANCELLED: 'cancelled',
  PONG: 'pong',
});

/** WebSocket 子协议标识，用于在浏览器中传 token */
export const WS_SUBPROTOCOL = 'perseng-token';
