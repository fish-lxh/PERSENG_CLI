"""
半月总结报告
============
每半个月（1日/15日）生成一次总结报告。

功能:
  - 汇总过去两周的扫描结果和候选池跟踪记录
  - 统计各形态命中率
  - 统计候选池股票表现
  - 生成持仓回顾
"""
import os
import re
import sys
import glob
from datetime import datetime, timedelta

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

PROJECT_DIR = os.path.dirname(os.path.abspath(__file__))
SCAN_RESULTS_DIR = os.path.join(PROJECT_DIR, "scan_results")
LOGS_DIR = os.path.join(PROJECT_DIR, "logs")
today_str = datetime.now().strftime("%Y%m%d")


def log(msg: str) -> None:
    os.makedirs(LOGS_DIR, exist_ok=True)
    log_file = os.path.join(LOGS_DIR, f"summary_{today_str}.log")
    with open(log_file, "a", encoding="utf-8") as f:
        f.write(msg + "\n")
    print(msg)


def get_trade_plans_in_range(days_back: int = 16) -> list:
    """获取最近 N 天的 trade_plan 文件"""
    files = glob.glob(os.path.join(SCAN_RESULTS_DIR, "trade_plan_*.md"))
    result = []
    cutoff = (datetime.now() - timedelta(days=days_back)).strftime("%Y%m%d")

    for f in files:
        match = re.search(r"trade_plan_(\d{8})\.md$", f)
        if match and match.group(1) >= cutoff:
            result.append(f)

    result.sort(reverse=True)
    return result


def get_track_reports_in_range(days_back: int = 16) -> list:
    """获取最近 N 天的跟踪简报"""
    files = glob.glob(os.path.join(SCAN_RESULTS_DIR, "candidate_track_*.md"))
    result = []
    cutoff = (datetime.now() - timedelta(days=days_back)).strftime("%Y%m%d")

    for f in files:
        match = re.search(r"candidate_track_(\d{8})\.md$", f)
        if match and match.group(1) >= cutoff:
            result.append(f)

    result.sort(reverse=True)
    return result


def parse_plan_summary(md_path: str) -> dict:
    """解析 trade_plan 的摘要信息"""
    result = {
        "path": md_path,
        "date": "未知",
        "candidates": 0,
        "patterns": {},
        "market_phase": "未知",
        "position": "未知",
    }

    date_match = re.search(r"(\d{4}-\d{2}-\d{2})", os.path.basename(md_path))
    if date_match:
        date_str = date_match.group(1)
        result["date"] = date_str.replace("-", "")

    try:
        with open(md_path, "r", encoding="utf-8") as f:
            content = f.read()

        # 市场阶段
        m = re.search(r"\*\*阶段\*\*:\s*(\S+)", content)
        if m:
            result["market_phase"] = m.group(1)

        # 建议仓位
        m = re.search(r"\*\*建议仓位\*\*:\s*(\S+)", content)
        if m:
            result["position"] = m.group(1)

        # 候选池数量
        m = re.search(r"\*\*共 (\d+) 只候选标的\*\*", content)
        if m:
            result["candidates"] = int(m.group(1))

        # 各形态数量
        for p in ["D", "A", "B", "C", "E", "F"]:
            pattern_count = content.count(f"| {p} |")
            if pattern_count > 0:
                result["patterns"][p] = pattern_count

        # 热点板块
        hot_sectors = re.findall(r"\| (\d+) \| ([^|]+) \| (\d+) \|", content)
        result["hot_sectors"] = [(s[1].strip(), s[2].strip(), s[0].strip()) for s in hot_sectors[:5]]

    except Exception as e:
        result["error"] = str(e)

    return result


def generate_summary(trade_plans: list, track_reports: list) -> str:
    """生成总结报告"""
    lines = []

    period_start = (datetime.now() - timedelta(days=14)).strftime("%m/%d")
    period_end = datetime.now().strftime("%m/%d")

    lines.append(f"# 半月总结报告")
    lines.append(f"**期间**: {period_start} - {period_end}")
    lines.append(f"**生成时间**: {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    lines.append("")
    lines.append("---")
    lines.append("")

    # 1. 扫描统计
    lines.append("## 一、扫描统计")
    lines.append("")
    lines.append(f"期间共进行 **{len(trade_plans)}** 次扫描")

    total_candidates = 0
    pattern_counts = {"D": 0, "A": 0, "B": 0, "C": 0, "E": 0, "F": 0}

    for plan_file in trade_plans:
        summary = parse_plan_summary(plan_file)
        total_candidates += summary["candidates"]
        for p, cnt in summary["patterns"].items():
            pattern_counts[p] = pattern_counts.get(p, 0) + cnt
        lines.append(f"- {summary['date']}: {summary['candidates']}只候选 {summary['market_phase']}阶段 {summary['position']}仓位")

    lines.append("")
    lines.append("### 形态分布")
    lines.append("")
    for p in ["D", "A", "B", "C", "E", "F"]:
        if pattern_counts.get(p, 0) > 0:
            # 形态名称映射
            names = {"D": "新高模式", "A": "首板250", "B": "上影线试盘", "C": "小阳爬升", "E": "反包博弈", "F": "上升三法"}
            lines.append(f"- **形态{p}** ({names[p]}): {pattern_counts[p]}次")

    lines.append("")

    # 2. 市场回顾
    lines.append("## 二、市场回顾")
    lines.append("")
    if trade_plans:
        latest = parse_plan_summary(trade_plans[0])
        lines.append(f"- 当前市场阶段: {latest['market_phase']}")
        lines.append(f"- 建议仓位: {latest['position']}")
    lines.append("")

    # 3. 候选池跟踪
    lines.append("## 三、候选池概览")
    lines.append("")
    lines.append(f"期间共生成 **{len(track_reports)}** 次跟踪简报")
    lines.append("")

    # 4. 回顾与反思
    lines.append("## 四、回顾与反思")
    lines.append("")
    lines.append("> 请结合自身交易记录补充以下内容")
    lines.append("")
    lines.append("| 标的 | 形态 | 介入日期 | 介入价格 | 当前状态 | 盈亏 |")
    lines.append("|:---:|:---:|:---:|:---:|:---:|:---:|")
    lines.append("| （手动填写） | | | | | |")
    lines.append("")
    lines.append("### 经验总结")
    lines.append("- ")
    lines.append("")
    lines.append("### 改进方向")
    lines.append("- ")

    lines.append("")
    lines.append("---")
    lines.append("*Swing-Trader 半月总结 | 数据仅供参考，不构成投资建议*")

    return "\n".join(lines)


def save_report(report: str):
    os.makedirs(SCAN_RESULTS_DIR, exist_ok=True)
    path = os.path.join(SCAN_RESULTS_DIR, f"summary_{today_str}.md")
    with open(path, "w", encoding="utf-8") as f:
        f.write(report)
    log(f"总结报告已保存: {path}")


def main():
    log("=" * 40)
    log(f"半月总结 | {datetime.now().strftime('%Y-%m-%d %H:%M')}")
    log("=" * 40)

    trade_plans = get_trade_plans_in_range()
    track_reports = get_track_reports_in_range()

    log(f"找到 {len(trade_plans)} 份交易计划, {len(track_reports)} 份跟踪简报")

    report = generate_summary(trade_plans, track_reports)
    save_report(report)

    log("总结完成")


if __name__ == "__main__":
    main()
