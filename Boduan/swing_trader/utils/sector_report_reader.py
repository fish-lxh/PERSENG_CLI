"""
赛道轮动捕手 本地报告读取器
============================
从 C 盘 A股赛道轮动捕手 文件夹读取 rotation
预先生成的周报/深度研判，转换为标准赛道推荐格式。

当 PromptX 无法获取 rotation 信息时，
fallback 到此模块从本地文件提取数据。

数据流:
  rotation (PromptX 角色)
    -> 输出周报到本地周报文件夹
    → sector_report_reader 解析 Markdown
    → 转换为标准 JSON 缓存格式（与 sector_rotation.py 兼容）
    → daily_scan.py 使用

用法:
    from swing_trader.utils.sector_report_reader import (
        load_from_folder, parse_weekly_report,
    )
    result = load_from_folder()  # 返回标准推荐字典或 None
"""
import logging
import os
import re
from datetime import datetime
from typing import List, Dict, Optional, Tuple

logger = logging.getLogger(__name__)

# ── rotation 文件夹路径 ──
SECTOR_CATCHER_DIR = r"C:\A股赛道轮动捕手"
WEEKLY_REPORT_DIR = os.path.join(SECTOR_CATCHER_DIR, "周报")
MONTHLY_DIR = os.path.join(SECTOR_CATCHER_DIR, "月度深度研判")
SIGNAL_RADAR_DIR = os.path.join(SECTOR_CATCHER_DIR, "信号雷达")
SMART_MONEY_DIR = os.path.join(SECTOR_CATCHER_DIR, "聪明钱季度报告")
SCORING_FRAMEWORK_DIR = os.path.join(SECTOR_CATCHER_DIR, "评分框架")


# ── rotation-catcher 报告名 → 同花顺概念板块名 映射 ──
# 周报中的赛道名称是专业描述（如"半导体/存储芯片"），
# 但同花顺概念板块名是标准名称（如"存储芯片"），需要转换。
# 每个赛道可映射到多个同花顺板块。按重要性排序。
REPORT_TO_THS_MAP: Dict[str, List[str]] = {
    # 半导体/存储芯片
    "半导体/存储芯片": ["存储芯片", "芯片概念", "第三代半导体"],
    # AI算力/光模块/CPO
    "AI算力/光模块/CPO": ["东数西算(算力)", "算力租赁", "共封装光学(CPO)", "光纤概念"],
    # 创新药/医药生物
    "创新药/医药生物": ["创新药", "生物疫苗", "医疗器械概念"],
    # 基础化工
    "基础化工": ["氟化工概念", "磷化工", "煤化工概念"],
    # 有色金属（含工业金属）
    "有色金属": ["工业金属", "黄金概念", "稀土永磁", "金属铅", "金属锌"],
}

# 晓胜核心方向关键词 → 同花顺概念板块名（后备补充）
CORE_KEYWORD_THS_MAP: Dict[str, List[str]] = {
    "算力": ["东数西算(算力)", "算力租赁", "数据中心"],
    "机器人": ["机器人概念", "人形机器人"],
    "人工智能": ["人工智能", "多模态AI"],
    "芯片": ["芯片概念", "存储芯片", "MCU芯片"],
    "半导体": ["第三代半导体", "芯片概念"],
    "低空经济": ["低空经济"],
    "新能源汽车": ["新能源汽车"],
    "军工": ["军工"],
    "储能": ["储能"],
    "消费电子": ["消费电子概念"],
    "AI应用": ["多模态AI", "AI语料"],
    "DeepSeek": ["DeepSeek概念"],
}


def resolve_to_ths_names(report_names: List[str]) -> List[str]:
    """
    将 rotation-catcher 报告中的赛道名转换为同花顺概念板块名。

    参数:
        report_names: rotation-catcher 赛道名列表

    返回:
        同花顺概念板块名列表（去重，保持顺序）
    """
    resolved = []
    seen = set()
    for name in report_names:
        if name in REPORT_TO_THS_MAP:
            for ths_name in REPORT_TO_THS_MAP[name]:
                if ths_name not in seen:
                    resolved.append(ths_name)
                    seen.add(ths_name)
        else:
            # 无法映射的名称也保持原样（可能刚好匹配）
            if name not in seen:
                resolved.append(name)
                seen.add(name)
    return resolved


# ────────────────────────────────────────
# 解析单份周报 Markdown
# ────────────────────────────────────────

def parse_weekly_report(filepath: str) -> Optional[Dict]:
    """
    解析赛道评分周报 Markdown 文件。

    参数:
        filepath: 周报 .md 文件路径

    返回:
        {
            "timestamp": "2026-05-27",
            "scan_range": "60+申万细分行业 × 200+概念板块",
            "market_context": "上证4152点...",
            "recommendations": [
                {
                    "name": "半导体/存储芯片",
                    "score": 12,
                    "rating": "core",
                    "rating_label": "⭐⭐⭐核心赛道",
                    "latest_pct": "...",
                    "factors": {
                        "policy": 3,
                        "price": 3,
                        "narrative": 3,
                        "capital": 2,
                        "valuation": 0,
                        "smart_money": 1,
                    },
                    "max_score": 17,
                    "risk": "...",
                },
                ...
            ],
            "signals": [...],
            "scan_sectors": [...],
        }
        解析失败返回 None
    """
    if not os.path.exists(filepath):
        logger.warning(f"周报文件不存在: {filepath}")
        return None

    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception as e:
        logger.warning(f"读取周报失败: {e}")
        return None

    # ── 提取全局信息 ──
    result = {
        "source": os.path.basename(filepath),
        "source_type": "weekly_report",
        "recommendations": [],
        "signals": [],
        "scan_sectors": [],
    }

    # 提取扫描日期
    date_match = re.search(r"\*\*扫描日期\*\*：(\d{4})年(\d{1,2})月(\d{1,2})日", content)
    if date_match:
        y, m, d = date_match.group(1), date_match.group(2), date_match.group(3)
        result["timestamp"] = f"{y}-{m.zfill(2)}-{d.zfill(2)}"

    # 提取大盘背景
    bg_match = re.search(r"\*\*大盘背景\*\*：(.+)", content)
    if bg_match:
        result["market_context"] = bg_match.group(1).strip()

    # ── 逐个提取赛道评分 ──
    # 匹配模式: ## 🥇/🥈/🥉/⭐ 赛道名（可选行业）
    # 接着 **评分：N/17 ...**
    # 接着 | 维度 | 得分 | 依据 | 表格

    # 按赛道块分割：以 ## 开头的内容
    sector_blocks = re.split(r'\n(?=##\s)', content)

    for block in sector_blocks:
        if not block.strip():
            continue

        # 判断是否是赛道条目（含 🥇🥈🥉⭐）
        header_match = re.match(r'##\s[🥇🥈🥉⭐]\s+(.+)', block)
        if not header_match:
            continue

        sector_name_full = header_match.group(1).strip()
        # 去除可能的 "（行业标注）"
        sector_name = re.sub(r'[（(].+[）)]$', '', sector_name_full).strip()

        # 提取评分: **评分：12/17 ⭐⭐⭐ 核心赛道**
        score_match = re.search(r'\*\*评分[：:]\s*(\d+)/(\d+)', block)
        if not score_match:
            continue
        score = int(score_match.group(1))
        max_score = int(score_match.group(2))

        # 提取交叉评级
        cross_match = re.search(r'\*\*交叉评级\*\*[：:]\s*(.+)', block)
        cross_rating = cross_match.group(1).strip() if cross_match else ""

        # 提取风险提示
        risk_match = re.search(r'\*\*风险提示\*\*[：:]\s*(.+)', block)
        risk = risk_match.group(1).strip() if risk_match else ""

        # 提取维度评分表格
        factors = {}
        # 表格行: | 📜 政策 | 3分 | ...
        dim_patterns = {
            "policy": r'\|\s*[📜]+\s*政策\s*\|\s*([-\d]+)分',
            "price": r'\|\s*[📈]+\s*价格趋势\s*\|\s*([-\d]+)分',
            "price_alt": r'\|\s*[📈]+\s*价格\s*\|\s*([-\d]+)分',
            "narrative": r'\|\s*[🗣️]+\s*叙事\s*\|\s*([-\d]+)分',
            "capital": r'\|\s*[💰]+\s*资金\s*\|\s*([-\d]+)分',
            "valuation": r'\|\s*[🛡️]+\s*估值\s*\|\s*([-\d]+)分',
            "smart_money": r'\|\s*[🧠]+\s*聪明钱\s*\|\s*([-\d]+)分',
        }

        for key, pattern in dim_patterns.items():
            m = re.search(pattern, block)
            if m:
                val = int(m.group(1))
                # 如果 price 匹配到了 price_alt，处理
                if key == "price_alt" and "price" not in factors:
                    factors["price"] = val
                elif key != "price_alt":
                    factors[key] = val

        # 映射评分等级
        if score >= 11:
            rating = "core"
            rating_label = "⭐⭐⭐核心赛道"
        elif score >= 7:
            rating = "watch"
            rating_label = "⭐⭐观察赛道"
        elif score >= 4:
            rating = "candidate"
            rating_label = "⭐备选赛道"
        else:
            rating = "ignore"
            rating_label = "暂不关注"

        # 计算最新涨跌幅（从价格趋势维度描述中提取）
        # 不强制要求百分比，默认为 "-"

        rec = {
            "name": sector_name,
            "score": score,
            "rating": rating,
            "rating_label": rating_label,
            "cross_rating": cross_rating,
            "risk": risk,
            "factors": factors,
            "max_score": max_score,
        }
        result["recommendations"].append(rec)
        result["scan_sectors"].append(sector_name)

    # ── 提取关键信号 ──
    signal_section = re.search(r'## 📌 关键信号\n\n(.+?)(?=\n---|\Z)', content, re.DOTALL)
    if signal_section:
        signals_text = signal_section.group(1).strip()
        signal_lines = re.findall(r'[-–—]\s*(.+)', signals_text)
        result["signals"] = [s.strip() for s in signal_lines if s.strip()]
        # 也按行提取
        if not result["signals"]:
            result["signals"] = [s.strip() for s in signals_text.split('\n') if s.strip()]

    return result


def get_latest_weekly_report() -> Optional[str]:
    """获取最新的周报文件路径"""
    if not os.path.isdir(WEEKLY_REPORT_DIR):
        logger.warning(f"周报目录不存在: {WEEKLY_REPORT_DIR}")
        return None

    files = [f for f in os.listdir(WEEKLY_REPORT_DIR)
             if f.endswith(".md") and "赛道评分周榜" in f]
    if not files:
        logger.warning("周报目录中没有找到赛道评分周榜文件")
        return None

    # 按文件名排序取最新（文件名格式: 2026W22_赛道评分周榜.md）
    files.sort(reverse=True)
    latest = os.path.join(WEEKLY_REPORT_DIR, files[0])
    logger.info(f"最新周报: {files[0]}")
    return latest


# ────────────────────────────────────────
# 一站式加载：从文件夹读取赛道推荐
# ────────────────────────────────────────

def load_from_folder() -> Optional[Dict]:
    """
    从 rotation 文件夹加载最新赛道推荐。

    优先级:
      1. 最新周报（周报目录）
      2. 月度深度研判（月度目录）

    返回:
        与 sector_rotation.analyze_and_recommend 兼容的字典格式
        {
            "timestamp": "...",
            "total_sectors_scored": N,
            "recommendations": [...],
            "scan_sectors": [...],
            "source": "sector_report_reader",
            "source_file": "2026W22_赛道评分周榜.md",
        }
        无可用数据返回 None
    """
    # 尝试解析最新周报
    latest_report = get_latest_weekly_report()
    if latest_report:
        parsed = parse_weekly_report(latest_report)
        if parsed and parsed.get("recommendations"):
            result = {
                "timestamp": parsed.get("timestamp", datetime.now().strftime("%Y-%m-%d")),
                "total_sectors_scored": len(parsed["recommendations"]),
                "recommendations": parsed["recommendations"],
                "scan_sectors": parsed["scan_sectors"],
                "signals": parsed.get("signals", []),
                "source": "sector_report_reader",
                "source_file": os.path.basename(latest_report),
            }
            logger.info(
                f"从周报读取 {len(parsed['recommendations'])} 个赛道推荐: "
                f"{os.path.basename(latest_report)}"
            )
            return result

    logger.warning("rotation 文件夹无可用周报数据")
    return None


def is_folder_available() -> bool:
    """检查 rotation 文件夹是否可访问"""
    return os.path.isdir(SECTOR_CATCHER_DIR)


# ────────────────────────────────────────
# 转换为标准缓存格式（兼容 sector_rotation.py）
# ────────────────────────────────────────

def convert_to_cache_format(folder_data: Dict) -> Dict:
    """
    将文件夹读取的数据转换为 sector_rotation.py 缓存的格式。

    自动将 rotation-catcher 原始赛道名 → 同花顺概念板块名，
    添加 ths_scan_sectors 字段，各消费端直接使用。
    """
    recommendations = []
    for rec in folder_data.get("recommendations", []):
        recommendations.append({
            "name": rec["name"],
            "score": rec["score"],
            "rating": rec.get("rating", "watch"),
            "rating_label": rec.get("rating_label", ""),
            "latest_pct": rec.get("latest_pct", 0),
        })

    # 数据加载层立即完成 THS 名称映射
    scan_sectors = folder_data.get("scan_sectors", [])
    ths_scan_sectors = resolve_to_ths_names(scan_sectors)

    return {
        "timestamp": folder_data.get("timestamp", datetime.now().strftime("%Y-%m-%d")),
        "total_sectors_scored": len(recommendations),
        "recommendations": recommendations,
        "scan_sectors": scan_sectors,          # 保留原始赛道名（用于显示）
        "ths_scan_sectors": ths_scan_sectors,  # 同花顺板块名（用于实际扫描/匹配）
        "source": folder_data.get("source", "sector_report_reader"),
    }


if __name__ == "__main__":
    # 测试读取
    logging.basicConfig(level=logging.INFO)
    result = load_from_folder()
    if result:
        print(f"成功读取 {len(result['recommendations'])} 个赛道推荐:")
        for r in result["recommendations"]:
            print(f"  {r['name']}: {r['score']}/{r.get('max_score', 17)} {r.get('rating_label', '')}")
        print(f"\n扫描赛道列表 ({len(result['scan_sectors'])} 个):")
        for s in result["scan_sectors"]:
            print(f"  - {s}")
        if result.get("signals"):
            print(f"\n关键信号:")
            for s in result["signals"]:
                print(f"  📌 {s}")
    else:
        print("读取失败")
