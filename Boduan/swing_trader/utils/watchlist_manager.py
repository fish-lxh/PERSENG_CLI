"""
重点跟踪股票（自选股）管理器
================================
支持添加/删除/查看自选股，持久化到配置文件。

用法:
    python -m swing_trader.utils.watchlist_manager add 301022 海泰科
    python -m swing_trader.utils.watchlist_manager add 600770 综艺股份
    python -m swing_trader.utils.watchlist_manager list
    python -m swing_trader.utils.watchlist_manager remove 301022
"""
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "../.."))

from typing import List, Tuple
from swing_trader.utils.config import CONFIG, WatchlistConfig


def get_watchlist() -> List[Tuple[str, str]]:
    """获取重点跟踪股票列表"""
    return list(CONFIG.watchlist.stocks)


def add_stock(code: str, name: str) -> bool:
    """添加一只股票到重点跟踪列表"""
    # 检查是否已存在
    for c, n in CONFIG.watchlist.stocks:
        if c == code:
            return False  # 已存在
    CONFIG.watchlist.stocks.append((code, name))
    _save_to_file()
    return True


def remove_stock(code: str) -> bool:
    """从重点跟踪列表删除一只股票"""
    original_len = len(CONFIG.watchlist.stocks)
    CONFIG.watchlist.stocks = [
        (c, n) for c, n in CONFIG.watchlist.stocks if c != code
    ]
    if len(CONFIG.watchlist.stocks) < original_len:
        _save_to_file()
        return True
    return False


def list_stocks() -> List[Tuple[str, str]]:
    """列出所有重点跟踪股票"""
    return get_watchlist()


def _save_to_file() -> None:
    """
    将当前 watchlist 持久化到 config.py 文件。
    通过行级替换：找到 lambda: [ 和下一行 ]) 之间的内容进行替换。
    """
    fp = os.path.join(os.path.dirname(__file__), "config.py")
    with open(fp, "r", encoding="utf-8") as f:
        lines = f.readlines()

    # 构建新的 stocks 列表文本行
    new_items = [f'        ("{code}", "{name}"),\n' for code, name in CONFIG.watchlist.stocks]

    # 找到 lambda: [ 所在行和下一个 ]) 所在行
    start_idx = -1
    end_idx = -1
    for i, line in enumerate(lines):
        if "lambda: [" in line:
            start_idx = i
        if start_idx >= 0 and line.strip() == "])":
            end_idx = i
            break

    if start_idx == -1 or end_idx == -1:
        print("  !! 错误: 未在 config.py 中找到 stocks 列表边界")
        return

    # 替换 start_idx+1 到 end_idx 之间的内容
    new_lines = lines[:start_idx + 1] + new_items + lines[end_idx:]
    # 如果新列表为空，保留一个空行占位
    if not new_items:
        new_lines = lines[:start_idx + 1] + ["\n"] + lines[end_idx:]

    with open(fp, "w", encoding="utf-8") as f:
        f.writelines(new_lines)

    print(f"  OK 已保存 {len(CONFIG.watchlist.stocks)} 只自选股到 config.py")


def setup_watchlist():
    """CLI入口"""
    if len(sys.argv) < 2:
        print("用法:")
        print("  python -m swing_trader.utils.watchlist_manager add <代码> <名称>")
        print("  python -m swing_trader.utils.watchlist_manager remove <代码>")
        print("  python -m swing_trader.utils.watchlist_manager list")
        return

    cmd = sys.argv[1]

    if cmd == "add":
        if len(sys.argv) < 4:
            print("用法: python -m swing_trader.utils.watchlist_manager add <代码> <名称>")
            return
        code, name = sys.argv[2], sys.argv[3]
        if add_stock(code, name):
            print(f"  OK 已添加 {code} {name} 到重点跟踪列表")
        else:
            print(f"  !! {code} {name} 已在重点跟踪列表中")

    elif cmd == "remove":
        if len(sys.argv) < 3:
            print("用法: python -m swing_trader.utils.watchlist_manager remove <代码>")
            return
        code = sys.argv[2]
        if remove_stock(code):
            print(f"  OK 已从重点跟踪列表移除 {code}")
        else:
            print(f"  !! {code} 不在重点跟踪列表中")

    elif cmd == "list":
        stocks = list_stocks()
        if stocks:
            print(f"\n== 重点跟踪股票列表（共 {len(stocks)} 只）:")
            print(f"  代码      名称")
            print(f"  " + "-"*20)
            for code, name in stocks:
                print(f"  {code:<8} {name}")
        else:
            print("  重点跟踪列表为空")
        print()

    else:
        print(f"未知命令: {cmd}")
        print("可用命令: add, remove, list")


if __name__ == "__main__":
    setup_watchlist()
