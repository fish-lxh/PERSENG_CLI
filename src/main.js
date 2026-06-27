/**
 * perseng-cli 主入口
 * 处理 CLI 参数解析，分发到 run / serve 模式
 */

import { Command } from 'commander';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadProjectEnv } from '../env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---- 包信息 ----
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, '..', 'package.json'), 'utf-8')
);

// ---- 自动加载项目级环境变量 ----
// 统一从项目根 .env 加载；兼容 .evn 作为别名回退。
loadProjectEnv();

// ---- 延迟加载子命令（按需加载模块） ----
async function runTask(task, options) {
  const { runCommand } = await import('./commands/run.js');
  await runCommand(task, options);
}

async function serveMode(options) {
  const { serveCommand } = await import('./commands/serve.js');
  await serveCommand(options);
}

async function actionMode(options) {
  const { actionCommand } = await import('./commands/action.js');
  await actionCommand(options);
}

async function lifecycleMode(options) {
  const { lifecycleCommand } = await import('./commands/lifecycle.js');
  await lifecycleCommand(options);
}

async function organizationMode(options) {
  const { organizationCommand } = await import('./commands/organization.js');
  await organizationCommand(options);
}

async function policyMode(options) {
  const { policyCommand } = await import('./commands/policy.js');
  await policyCommand(options);
}

async function toolxMode(options) {
  const { toolxCommand } = await import('./commands/toolx.js');
  await toolxCommand(options);
}

async function memorySubcommand(subcommand, args, options) {
  const { memoryCommand } = await import('./commands/memory.js');
  await memoryCommand(options, subcommand, args);
}

async function roleSubcommand(subcommand, args, options) {
  const { roleCommand } = await import('./commands/role.js');
  await roleCommand(options, subcommand, args);
}

async function metricsMode(options) {
  const { metricsCommand } = await import('./commands/metrics.js');
  await metricsCommand(options);
}

async function serveHttpMode(options) {
  const { serveHttpCommand } = await import('./commands/serve-http.js');
  await serveHttpCommand(options);
}

async function doctorMode(options) {
  const { doctorCommand } = await import('./commands/doctor.js');
  await doctorCommand(options);
}

async function feishuMode(options) {
  const { feishuCommand } = await import('./commands/feishu.js');
  await feishuCommand(options);
}

async function feishuPushMode(options) {
  const { feishuPushCommand } = await import('./commands/feishu-push.js');
  await feishuPushCommand(options);
}

async function feishuMultiMode(options) {
  const { feishuMultiCommand } = await import('./commands/feishu-multi.js');
  await feishuMultiCommand(options);
}

async function feishuRegisterMode(options) {
  const { feishuRegisterCommand } = await import('./commands/feishu-register.js');
  await feishuRegisterCommand(options);
}

// ---- 从 argv 中提取选项值的辅助函数 ----
function getArgValue(args, ...flags) {
  for (const flag of flags) {
    const idx = args.indexOf(flag);
    if (idx !== -1 && idx + 1 < args.length) {
      return args[idx + 1];
    }
  }
  return undefined;
}

function hasFlag(args, ...flags) {
  return flags.some((f) => args.includes(f));
}

// ---- CLI 定义 ----
export async function main() {
  if (hasFlag(process.argv, '--no-v2')) {
    process.env.PERSENG_ENABLE_V2 = '0';
  } else if (process.env.PERSENG_ENABLE_V2 === undefined) {
    process.env.PERSENG_ENABLE_V2 = '1';
  }

  // ── Multica 兼容模式检测（优先于 commander） ──
  // Multica daemon 以 Claude Code 风格调用 agent:
  //   perseng -p "prompt" --output-format json --allow-all --no-ask-user
  // 在 commander 解析之前检查 -p，避免因"无子命令"而报错
  const hasPrompt =
    process.argv.includes('-p') || process.argv.includes('--prompt');

  if (hasPrompt) {
    const promptText =
      getArgValue(process.argv, '-p', '--prompt') || '';
    const role =
      getArgValue(process.argv, '-r', '--role') || 'jiangziya';
    const model = getArgValue(process.argv, '-m', '--model') || undefined;
    // 检查 Multica 要求的输出格式
    const outputFormat = getArgValue(process.argv, '--output-format') || '';
    // 忽略 --input-format / --verbose / --allow-all / --no-ask-user 等兼容 flag
    await runTask(promptText, { role, model, outputFormat });
    return;
  }

  const program = new Command();

  program
    .name('perseng')
    .description('PersEng CLI Agent — 带角色生态的智能代理')
    .version(pkg.version, '--version', '显示版本号')
    .option('--no-v2', '禁用 V2/RoleX（PERSENG_ENABLE_V2=0）');

  // run 命令
  program
    .command('run')
    .description('直接运行一个任务')
    .argument('<task>', '任务描述文本')
    .option('-r, --role <name>', '指定角色 (默认: jiangziya)', 'jiangziya')
    .option('-m, --model <model>', '指定模型（最高优先级，会覆盖生命周期阶段模型策略）')
    .option('-w, --cwd <path>', '工作目录 (默认: 当前目录)')
    .action(async (task, options) => {
      await runTask(task, options);
    });

  // serve 命令
  program
    .command('serve')
    .description('启动 Multica 兼容守护模式 (NDJSON over stdio)')
    .option('-r, --role <name>', '默认角色 (默认: jiangziya)', 'jiangziya')
    .option('-m, --model <model>', '默认模型（最高优先级，会覆盖生命周期阶段模型策略）')
    .action(async (options) => {
      await serveMode(options);
    });

  program
    .command('action')
    .description('V2/RoleX 操作入口（activate/born/identity 等）')
    .requiredOption('-o, --operation <op>', '操作类型（activate/born/identity/...）')
    .requiredOption('-r, --role <role>', '角色 ID（"_" 表示当前激活角色）', '_')
    .option('--name <name>', 'born 等操作的 name')
    .option('--source <text>', 'born 等操作的 source；支持纯文本，CLI 会自动包装为最小 Gherkin')
    .option('--json', 'JSON 输出')
    .action(async (options) => {
      await actionMode(options);
    });

  program
    .command('lifecycle')
    .description('V2/RoleX 目标与任务生命周期（want/plan/todo/finish/achieve/abandon/focus）')
    .requiredOption('-o, --operation <op>', '操作类型')
    .requiredOption('-r, --role <role>', '角色 ID（"_" 表示当前激活角色）', '_')
    .option('--name <name>', 'want/todo/finish/focus 的 name')
    .option('--source <text>', 'want/plan/todo 的 source；支持纯文本，CLI 会自动包装为最小 Gherkin')
    .option('--id <id>', 'plan 的 id（强烈建议提供）')
    .option('--testable', 'want/todo 是否可测试')
    .option('--experience <text>', 'achieve/abandon 的 experience')
    .option('--encounter <text>', 'finish 的 encounter')
    .option('--json', 'JSON 输出')
    .action(async (options) => {
      await lifecycleMode(options);
    });

  program
    .command('organization')
    .description('V2/RoleX 组织/职位/个体管理（found/hire/establish/appoint/...）')
    .requiredOption('-o, --operation <op>', '操作类型')
    .requiredOption('-r, --role <role>', '角色 ID（"_" 表示当前激活角色）', '_')
    .option('--name <name>', '组织/职位/个体的 name')
    .option('--source <text>', 'found/establish 的 source；支持纯文本，CLI 会自动包装为最小 Gherkin')
    .option('--org <org>', '目标组织')
    .option('--parent <parent>', 'found 的 parent')
    .option('--position <position>', '职位名称')
    .option('--individual <individual>', '个体 ID（retire/die/rehire/train）')
    .option('--skillId <skillId>', 'train 的 skillId')
    .option('--skill <skill>', 'require 的 skill')
    .option('--content <text>', 'charter/charge/train 的 content')
    .option('--json', 'JSON 输出')
    .action(async (options) => {
      await organizationMode(options);
    });

  program
    .command('policy')
    .description('查看或设置“生命周期阶段 -> 模型策略”')
    .option('-a, --action <action>', '操作类型：show/set/clear', 'show')
    .option('-s, --stage <stage>', '生命周期阶段：idle/goal/planning/execution/reflection')
    .option('-m, --model <model>', '要设置的模型名（set 时必填）')
    .option('-r, --role <role>', '角色级策略；不传则操作全局 config')
    .option('--json', 'JSON 输出')
    .action(async (options) => {
      await policyMode(options);
    });

  // toolx 命令
  const toolxCmd = program
    .command('toolx')
    .description('ToolX 协议 — 统一工具接口层')
    .option('--json', 'JSON 输出')
    .option('-w, --cwd <path>', '工作目录');

  toolxCmd
    .command('discover')
    .description('发现所有可用工具')
    .action(async (_, cmd) => {
      const opts = { ...cmd.parent.opts(), ...cmd.opts(), _mode: 'discover', json: cmd.parent.opts().json };
      await toolxMode(opts);
    });

  toolxCmd
    .command('manual')
    .description('查看工具文档')
    .requiredOption('-t, --tool <uri>', '工具 URI（如 tool://filesystem）')
    .action(async (_, cmd) => {
      const opts = { ...cmd.parent.opts(), ...cmd.opts(), _mode: 'manual' };
      await toolxMode(opts);
    });

  toolxCmd
    .command('exec')
    .description('执行工具操作')
    .requiredOption('-t, --tool <uri>', '工具 URI（如 tool://filesystem）')
    .requiredOption('-a, --action <action>', '操作名称（如 read/write）')
    .option('--param <entry...>', '额外参数，格式 key=value，可传多个')
    .option('--params-json <json>', '额外参数 JSON 对象')
    .option('--path <path>', '文件路径')
    .option('--content <text>', '文件内容')
    .option('--query <query>', '查询字符串')
    .option('--question <question>', '问题文本')
    .option('--brainArea <brainArea>', '脑区名称')
    .option('--slug <slug>', '内容标识')
    .option('--pattern <pattern>', '搜索模式')
    .option('--glob <glob>', '文件过滤')
    .option('--name <name>', '名称')
    .option('--id <id>', 'ID')
    .option('--source <text>', '源码/描述')
    .option('--sheet <sheet>', '工作表名称')
    .option('--uri <uri>', '工具 URI（创建工具时使用）')
    .option('--description <desc>', '描述')
    .action(async (_, cmd) => {
      const opts = { ...cmd.parent.opts(), ...cmd.opts(), _mode: 'exec' };
      await toolxMode(opts);
    });

  toolxCmd
    .command('dryrun')
    .description('预览工具执行效果（不真正执行）')
    .requiredOption('-t, --tool <uri>', '工具 URI（如 tool://filesystem）')
    .requiredOption('-a, --action <action>', '操作名称')
    .option('--param <entry...>', '额外参数，格式 key=value，可传多个')
    .option('--params-json <json>', '额外参数 JSON 对象')
    .option('--path <path>', '文件路径')
    .option('--content <text>', '文件内容')
    .option('--query <query>', '查询字符串')
    .option('--question <question>', '问题文本')
    .option('--brainArea <brainArea>', '脑区名称')
    .option('--slug <slug>', '内容标识')
    .option('--pattern <pattern>', '搜索模式')
    .action(async (_, cmd) => {
      const opts = { ...cmd.parent.opts(), ...cmd.opts(), _mode: 'dryrun' };
      await toolxMode(opts);
    });

  toolxCmd
    .command('configure')
    .description('配置工具参数')
    .requiredOption('-t, --tool <uri>', '工具 URI（如 tool://filesystem）')
    .requiredOption('-k, --key <key>', '配置项名称')
    .requiredOption('-v, --value <value>', '配置项值')
    .action(async (_, cmd) => {
      const opts = { ...cmd.parent.opts(), ...cmd.opts(), _mode: 'configure' };
      await toolxMode(opts);
    });

  toolxCmd
    .command('log')
    .description('查看工具执行历史')
    .requiredOption('-t, --tool <uri>', '工具 URI（如 tool://filesystem）')
    .action(async (_, cmd) => {
      const opts = { ...cmd.parent.opts(), ...cmd.opts(), _mode: 'log' };
      await toolxMode(opts);
    });

  toolxCmd
    .command('run')
    .description('直接执行 YAML/JSON 格式的 ToolX 票据')
    .requiredOption('-y, --yaml <json>', 'JSON 格式的 ToolX 请求，如 \'{"tool":"tool://filesystem","mode":"execute","parameters":{"action":"read","path":"test.txt"}}\'')
    .action(async (_, cmd) => {
      const opts = { ...cmd.parent.opts(), ...cmd.opts(), _mode: 'run' };
      await toolxMode(opts);
    });

  // feishu 命令（飞书机器人模式）
  program
    .command('feishu')
    .description('启动飞书机器人模式 (WebSocket 长连接)')
    .option('-r, --role <name>', '默认角色 (默认: jiangziya)', 'jiangziya')
    .option('-m, --model <model>', '默认模型（覆盖 PERSENG_MODEL）')
    .option('--app-id <id>', '飞书 App ID（覆盖 FEISHU_APP_ID）')
    .option('--app-secret <secret>', '飞书 App Secret（覆盖 FEISHU_APP_SECRET）')
    .option('--timeout <ms>', '单任务超时（毫秒，默认 600000 = 10 分钟）')
    .action(async (options) => {
      await feishuMode(options);
    });

  // feishu push（主动推送，Phase 4.2）
  program
    .command('feishu-push')
    .description('启动飞书主动推送调度器 (cron-based)')
    .option('-c, --config <path>', 'push jobs 配置文件 (JSON 数组)')
    .option('--cron <expr>', 'cron 表达式（单 job 模式，与 --chat/--prompt 配合）')
    .option('--chat <chatId>', '目标 chat_id（单 job 模式）')
    .option('--prompt <text>', '定时发送的 prompt（单 job 模式）')
    .option('--name <name>', 'job 名称（单 job 模式）')
    .option('-r, --role <name>', '默认角色', 'jiangziya')
    .option('-m, --model <model>', '默认模型')
    .option('--app-id <id>', '飞书 App ID')
    .option('--app-secret <secret>', '飞书 App Secret')
    .option('--dry-run', '立即触发所有 job 一次，不进入调度循环', false)
    .action(async (options) => {
      await feishuPushMode(options);
    });

  // feishu multi（多租户，Phase 4.3）
  program
    .command('feishu-multi')
    .description('启动多飞书 bot (多租户，错误隔离)')
    .option('-c, --config <path>', 'tenants 配置文件 (JSON 数组)')
    .action(async (options) => {
      await feishuMultiMode(options);
    });

  program
    .command('feishu-register')
    .description('扫码一键创建/授权飞书应用，获取 appId/appSecret')
    .option('--addons <jsonOrPath>', 'addons JSON（或文件路径），用于增量申请权限/事件/回调')
    .option('--create-only', '仅允许创建新应用（隐藏选择已有应用入口）', false)
    .option('--app-id <cli_xxx>', '更新已有应用的 App ID（cli_ 开头）')
    .option('--source <id>', '来源标识（写入二维码 URL 的 from 参数）', 'perseng-cli')
    .option('--app-name <name>', '预设应用名称（支持 {user} 占位符）')
    .option('--app-desc <desc>', '预设应用描述（支持 {user} 占位符）')
    .option('--app-avatar <urls>', '预设应用头像 URL（逗号分隔）')
    .option('--save-config', '写入 ~/.perseng-cli/config.json（feishuAppId/feishuAppSecret）', false)
    .option('--quiet', '减少状态输出', false)
    .option('--json', 'JSON 输出', false)
    .action(async (options) => {
      await feishuRegisterMode(options);
    });

  // memory 子命令组（M3.1）
  const memoryCmd = program
    .command('memory')
    .description('记忆管理 (list/show/forget/stats)');

  memoryCmd
    .command('list')
    .alias('ls')
    .description('列出当前角色的所有 engram')
    .option('-r, --role <role>', '角色 ID (默认: 当前激活角色)')
    .option('--type <type>', '按类型过滤 (ATOMIC/PATTERN)')
    .option('--limit <n>', '最多显示条数', '50')
    .option('--offset <n>', '跳过前 N 条', '0')
    .option('--json', 'JSON 输出')
    .action(async (options, cmd) => {
      const args = cmd.args;
      const opts = { ...cmd.parent.opts(), ...cmd.opts(), _subcommand: 'list' };
      opts.limit = parseInt(opts.limit, 10);
      opts.offset = parseInt(opts.offset, 10);
      await memorySubcommand('list', args, opts);
    });

  memoryCmd
    .command('show <id>')
    .description('查看单条记忆详情')
    .option('-r, --role <role>', '角色 ID')
    .option('--json', 'JSON 输出')
    .action(async (id, options, cmd) => {
      const args = cmd.args;
      const opts = { ...cmd.parent.opts(), ...cmd.opts(), _subcommand: 'show', id };
      await memorySubcommand('show', args, opts);
    });

  memoryCmd
    .command('forget [id]')
    .alias('rm')
    .description('删除一条记忆（或 --all 清空）')
    .option('-r, --role <role>', '角色 ID')
    .option('--all', '清空该角色所有记忆')
    .option('--json', 'JSON 输出')
    .action(async (id, options, cmd) => {
      const args = cmd.args;
      const opts = { ...cmd.parent.opts(), ...cmd.opts(), _subcommand: 'forget', id };
      await memorySubcommand('forget', args, opts);
    });

  memoryCmd
    .command('stats')
    .description('记忆统计概览')
    .option('-r, --role <role>', '角色 ID')
    .option('--json', 'JSON 输出')
    .action(async (options, cmd) => {
      const args = cmd.args;
      const opts = { ...cmd.parent.opts(), ...cmd.opts(), _subcommand: 'stats' };
      await memorySubcommand('stats', args, opts);
    });

  // role 子命令组（M3.2）
  const roleCmd = program
    .command('role')
    .description('角色管理 (list/show/activate/edit/reload)');

  roleCmd
    .command('list')
    .alias('ls')
    .description('列出所有可用角色')
    .option('--json', 'JSON 输出')
    .action(async (options, cmd) => {
      const args = cmd.args;
      const opts = { ...cmd.parent.opts(), ...cmd.opts(), _subcommand: 'list' };
      await roleSubcommand('list', args, opts);
    });

  roleCmd
    .command('show [id]')
    .description('查看角色详情（默认显示当前激活角色）')
    .option('--json', 'JSON 输出')
    .action(async (id, options, cmd) => {
      const args = cmd.args;
      const opts = { ...cmd.parent.opts(), ...cmd.opts(), _subcommand: 'show', id };
      await roleSubcommand('show', args, opts);
    });

  roleCmd
    .command('activate <id>')
    .description('激活指定角色')
    .action(async (id, options, cmd) => {
      const args = cmd.args;
      const opts = { ...cmd.parent.opts(), ...cmd.opts(), _subcommand: 'activate', id };
      await roleSubcommand('activate', args, opts);
    });

  roleCmd
    .command('reload')
    .description('清空角色缓存（强制下次重新加载磁盘文件）')
    .action(async (options, cmd) => {
      const args = cmd.args;
      const opts = { ...cmd.parent.opts(), ...cmd.opts(), _subcommand: 'reload' };
      await roleSubcommand('reload', args, opts);
    });

  program
    .command('doctor')
    .description('一键自检（配置/模型/systemd）')
    .option('--mode <mode>', '检查模式: all | feishu | llm | systemd', 'all')
    .option('--systemd', '启用 systemd 检查', false)
    .option('--service <name>', 'systemd service 名称', 'perseng-feishu')
    .option('--skip-llm-ping', '跳过 LLM 可用性探测', false)
    .option('--show-config-sources', '显示关键配置项来源（process.env/.env/config.json/default）', false)
    .option('--json', 'JSON 输出', false)
    .action(async (options) => {
      await doctorMode(options);
    });

  // metrics 子命令（M3.4 — Prometheus 文本格式）
  program
    .command('metrics')
    .description('输出 Prometheus 格式的指标（默认 stderr）')
    .option('--format <format>', '输出格式: prometheus | json', 'prometheus')
    .option('--include <names>', '只包含指定指标（逗号分隔）')
    .action(async (options) => {
      await metricsMode(options);
    });

  // serve-http 子命令（M3.5 — Web 管理面板）
  program
    .command('serve-http')
    .description('启动 HTTP 管理接口 (GET /status, /metrics, /roles, /memory)')
    .option('-p, --port <port>', '监听端口', '7717')
    .option('-H, --host <host>', '监听地址', '127.0.0.1')
    .action(async (options) => {
      await serveHttpMode(options);
    });

  await program.parseAsync(process.argv);
}
