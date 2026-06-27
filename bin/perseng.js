#!/usr/bin/env node

/**
 * perseng-cli — PersEng CLI Agent
 * 将 PersEng 角色生态打包为独立的 CLI 代理工具
 *
 * 用法:
 *   perseng run <task>            直接运行任务
 *   perseng serve                 启动 Multica 兼容守护模式
 *   perseng --version             查看版本
 *   perseng --help                查看帮助
 */

import { main } from '../src/main.js';
import { PersengError } from '../src/errors.js';

main().catch((err) => {
  if (err instanceof PersengError) {
    console.error(`Error [${err.code}]: ${err.userMessage}`);
    if (process.env.PERSENG_DEBUG === '1') {
      console.error('---');
      console.error(err.stack);
      if (err.cause) console.error('Caused by:', err.cause);
    }
  } else {
    console.error('Fatal error:');
    console.error(err?.stack || err);
    if (err?.cause) console.error('Caused by:', err.cause?.stack || err.cause);
  }
  process.exit(1);
});
