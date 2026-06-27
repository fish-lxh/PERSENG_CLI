"""
daily_scan.py 安全执行包装器 v2
==============================
修复: 使用后台线程读取 stdout，主线程用 wait(timeout=) 做超时控制。
之前的版本用 for line in p.stdout 会阻塞在主线程，导致超时失效。

功能:
  - 超时保护（默认25分钟，防止 akshare API 挂起）
  - 自动重试（失败后最多重试2次）
  - 完整日志记录
  - 周末自动跳过
"""
import subprocess
import sys
import time
import os
import threading
from datetime import datetime

TIMEOUT_SECONDS = 1500   # 25 分钟
MAX_RETRIES = 2          # 最多重试 2 次
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SCRIPT_PATH = os.path.join(SCRIPT_DIR, "daily_scan.py")
LOG_DIR = os.path.join(SCRIPT_DIR, "logs")
today_str = datetime.now().strftime("%Y%m%d")
LOG_FILE = os.path.join(LOG_DIR, f"daily_scan_{today_str}.log")


def log(msg: str) -> None:
    """追加写日志（UTF-8）"""
    os.makedirs(LOG_DIR, exist_ok=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(msg + "\n")


def write_header() -> None:
    """写出日志头部"""
    log("=" * 40)
    log(f"Swing-Trader Daily Scan (with timeout/retry)")
    log(f"Started: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    log("=" * 40)


def write_footer(ok: bool) -> None:
    """写出日志尾部"""
    status = "✅ 扫描完成" if ok else "❌ 扫描失败"
    log(status)
    log(f"Finished: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    log("=" * 40)
    log("")


def run_scan() -> int:
    """
    执行一次扫描，返回退出码。

    用后台线程读取 stdout 防止阻塞，主线程负责超时控制。

    Returns:
        0 成功, 1 Python错误, -1 超时
    """
    log(f"[启动] python daily_scan.py")
    log("")

    p = None
    read_complete = threading.Event()
    stdout_lines: list[str] = []

    def reader_thread(proc: subprocess.Popen) -> None:
        """后台线程：读取子进程 stdout，直到 pipe 关闭"""
        try:
            for raw_line in proc.stdout:
                line = raw_line.decode("utf-8", errors="replace") if isinstance(raw_line, bytes) else raw_line
                stdout_lines.append(line)
                print(line, end="", flush=True)
        except (ValueError, OSError, AttributeError):
            # pipe 被关闭后的正常退出
            pass
        finally:
            read_complete.set()

    try:
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        p = subprocess.Popen(
            [sys.executable, SCRIPT_PATH],
            cwd=SCRIPT_DIR,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=env,
        )

        t = threading.Thread(target=reader_thread, args=(p,), daemon=True)
        t.start()

        # 主线程：带超时的等待
        p.wait(timeout=TIMEOUT_SECONDS)

        # 子进程正常退出，等 reader 线程消化完缓冲区
        read_complete.wait(timeout=5)

        output_text = "".join(stdout_lines)
        log("")

        if p.returncode == 0:
            log("[结果] 进程正常退出")
            log(output_text)
            return 0
        else:
            log(f"[结果] 进程异常退出，退出码: {p.returncode}")
            log(output_text)
            return 1

    except subprocess.TimeoutExpired:
        # 超时 — 强制终止子进程
        try:
            p.kill()
            p.wait(timeout=10)
            p.stdout.close()  # 关闭 pipe 让 reader 线程退出
        except Exception:
            pass

        read_complete.wait(timeout=5)
        output_text = "".join(stdout_lines) if stdout_lines else ""
        if output_text:
            log(output_text)
        log(f"[结果] ⛔ 扫描超时（超过 {TIMEOUT_SECONDS} 秒），进程已强制终止")
        return -1

    except Exception as e:
        log(f"[结果] ❌ 执行异常: {e}")
        # 确保子进程被清理
        if p is not None:
            try:
                p.kill()
                p.wait(timeout=5)
                p.stdout.close()
            except Exception:
                pass
        return 1


def is_weekend() -> bool:
    """周末跳过执行"""
    return datetime.now().weekday() >= 5


def main():
    # ── 周末跳过 ──
    if is_weekend():
        write_header()
        log("周末休市，跳过执行")
        write_footer(True)
        print("周末休市，跳过执行")
        return

    # ── 带重试的执行 ──
    write_header()

    last_code = -1
    for attempt in range(MAX_RETRIES + 1):
        if attempt > 0:
            log(f"")
            log(f"[重试 {attempt}/{MAX_RETRIES}] 30 秒后重试...")
            print(f"\n[重试 {attempt}/{MAX_RETRIES}] 30 秒后重试...")
            time.sleep(30)

        last_code = run_scan()

        if last_code == 0:
            write_footer(True)
            sys.exit(0)

        # 超时或错误 — 继续重试
        log("")

    # 所有重试都失败
    log(f"[最终] 已达最大重试次数 ({MAX_RETRIES})，扫描失败")
    write_footer(False)
    print(f"\n❌ 已达最大重试次数 ({MAX_RETRIES})，扫描失败")
    sys.exit(1)


if __name__ == "__main__":
    main()
