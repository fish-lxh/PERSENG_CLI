// WebSocket 协议类型（与 src/web/protocol.js 镜像）

export const WS_TYPE = {
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
  HELLO: 'hello',
} as const;

export type WsType = (typeof WS_TYPE)[keyof typeof WS_TYPE];

// ---- Client → Server ----

export interface ClientMessage {
  type: 'message' | 'cancel' | 'set_role' | 'ping';
  tabId?: string;
  prompt?: string;
  roleId?: string;
}

// ---- Server → Client ----

export interface ServerTextMsg {
  type: 'text';
  tabId: string;
  chunk: string;
}

export interface ServerToolUseMsg {
  type: 'tool_use';
  tabId: string;
  tool: string;
  input: unknown;
}

export interface ServerRoleLoadedMsg {
  type: 'role_loaded';
  tabId: string;
  roleId: string;
}

export interface ServerDoneMsg {
  type: 'done';
  tabId: string;
}

export interface ServerErrorMsg {
  type: 'error';
  tabId: string | null;
  message: string;
}

export interface ServerCancelledMsg {
  type: 'cancelled';
  tabId: string;
}

export interface ServerPongMsg {
  type: 'pong';
  ts: number;
}

export interface ServerHelloMsg {
  type: 'hello';
  ts: number;
}

export type ServerMsg =
  | ServerTextMsg
  | ServerToolUseMsg
  | ServerRoleLoadedMsg
  | ServerDoneMsg
  | ServerErrorMsg
  | ServerCancelledMsg
  | ServerPongMsg
  | ServerHelloMsg;

// ---- HTTP API 类型 ----

export interface StatusInfo {
  name: string;
  version: string;
  pid: number;
  uptimeSeconds: number;
  activeRole: string | null;
  dataDir: string;
  timestamp: string;
}

export interface RoleListResponse {
  rolesDir: string;
  active: string | null;
  count: number;
  roles: Array<{ id: string; name?: string; [k: string]: unknown }>;
}

export interface MemoryEngram {
  id: string;
  content?: string;
  type?: string;
  strength?: string;
  createdAt?: string;
  [k: string]: unknown;
}

export interface MemoryListResponse {
  roleId: string;
  count: number;
  engrams: MemoryEngram[];
}

export interface SessionInfo {
  tabId: string;
  roleId: string;
  lastActiveAt: string;
  startedAt: string;
  historyCount: number;
}

export interface SessionListResponse {
  count: number;
  maxSessions: number;
  sessions: SessionInfo[];
}
