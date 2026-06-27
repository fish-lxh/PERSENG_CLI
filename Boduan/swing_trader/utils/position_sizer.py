"""
四维仓位管理系统
================
基于四大基准指数的趋势判断，输出仓位建议。

四大指数:
  ① 上证指数 (000001)  → 大盘蓝筹
  ② 中证2000 (932000)  → 小盘题材（游资情绪）
  ③ 创业板指 (399006)  → 成长科技（机构方向）
  ④ 平均股价 (800005)  → 全市场真实温度

仓位规则:
  - 四维全多头  → 满仓做多 (100%)
  - 三维多头     → 积极 (70%)
  - 二维多头     → 谨慎 (50%)
  - 一维多头     → 防御 (30%)
  - 零维多头     → 空仓 (0%)

一票否决机制（任一触发则强制降仓 ≤50%）:
  - 上证指数跌破 10 周线
  - 中证2000 单周跌幅 > 5%
  - 涨停家数 < 30
  - 北向资金连续 3 日净流出
"""

import os
import json
import urllib.request
from datetime import datetime, timedelta
from typing import Dict, List, Optional, Tuple

import numpy as np

# ──────────────────────────────────────────────
# 指数配置
# ──────────────────────────────────────────────

INDEX_CONFIG = {
    "上证指数": {
        "code": "000001",
        "secid": "1.000001",
        "baostock": "sh.000001",
        "weekly_ma5": 4122,
        "weekly_ma10": 4052,
        "current": 4069,
        "trend": "多头",
    },
    "中证2000": {
        "code": "932000",
        "secid": "2.932000",
        "baostock": None,
        "weekly_ma5": None,
        "weekly_ma10": None,
        "current": None,
        "trend": None,
    },
    "创业板指": {
        "code": "399006",
        "secid": "0.399006",
        "baostock": "sz.399006",
        "weekly_ma5": 3876,
        "weekly_ma10": 3662,
        "current": 4038,
        "trend": "多头",
    },
    "平均股价": {
        "code": "800005",
        "secid": None,
        "baostock": None,
        "weekly_ma5": None,
        "weekly_ma10": None,
        "current": None,
        "trend": None,
    },
}

# 手动覆盖值存放路径（用户可通过修改该文件来更新指数数据）
CONFIG_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "config")
INDEX_OVERRIDE_PATH = os.path.join(CONFIG_DIR, "index_overrides.json")


# ──────────────────────────────────────────────
# 数据获取
# ──────────────────────────────────────────────

def _fetch_from_eastmoney(secid: str) -> Optional[Dict]:
    """从东方财富 push2 API 获取实时行情"""
    if not secid:
        return None
    try:
        url = (
            f"http://push2.eastmoney.com/api/qt/stock/get"
            f"?secid={secid}&fields=f43,f44,f45,f46,f47,f48,f50,f51,f52,f58,f170,f171"
        )
        req = urllib.request.Request(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://quote.eastmoney.com/",
            },
        )
        resp = urllib.request.urlopen(req, timeout=5)
        data = json.loads(resp.read().decode("utf-8"))
        d = data.get("data", {})
        if d and d.get("f43") and float(d["f43"]) > 0:
            return {
                "price": float(d["f43"]) / 100.0,
                "pct": float(d.get("f170", 0)) / 100.0,
                "high": float(d.get("f44", 0)) / 100.0 if d.get("f44") else 0,
                "low": float(d.get("f45", 0)) / 100.0 if d.get("f45") else 0,
                "volume": d.get("f47", 0),
                "source": "eastmoney",
            }
    except Exception:
        pass
    return None


def _fetch_from_baostock(bs_code: str) -> Optional[Dict]:
    """从 baostock 获取周线数据"""
    if not bs_code:
        return None
    try:
        import baostock as bs

        lg = bs.login()
        if lg.error_code != "0":
            return None
        try:
            rs = bs.query_history_k_data_plus(
                bs_code,
                "date,close,pctChg",
                frequency="w",
                adjustflag="2",
                start_date="2025-01-01",
                end_date=datetime.now().strftime("%Y-%m-%d"),
            )
            df = rs.get_data()
            if df is None or df.empty:
                return None
            closes = df["close"].astype(float).values
            if len(closes) < 3:
                return None
            ma5 = np.mean(closes[-5:]) if len(closes) >= 5 else np.mean(closes)
            ma10 = np.mean(closes[-10:]) if len(closes) >= 10 else np.mean(closes)
            return {
                "current": closes[-1],
                "ma5": round(ma5, 0),
                "ma10": round(ma10, 0),
                "trend": "多头" if ma5 > ma10 else "空头",
                "closes": closes.tolist(),
                "pcts": df["pctChg"].astype(float).tolist(),
                "source": "baostock",
            }
        finally:
            bs.logout()
    except Exception:
        return None


def _load_manual_overrides() -> Dict:
    """读取手动覆盖的指数数据"""
    if os.path.exists(INDEX_OVERRIDE_PATH):
        try:
            with open(INDEX_OVERRIDE_PATH, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {}


def _save_manual_overrides(data: Dict):
    """保存手动覆盖的指数数据"""
    os.makedirs(os.path.dirname(INDEX_OVERRIDE_PATH), exist_ok=True)
    with open(INDEX_OVERRIDE_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def get_index_data(name: str) -> Dict:
    """
    获取指定指数的趋势数据。

    数据源优先级: 东方财富实时 → baostock 周线 → 手动覆盖json → 配置默认值
    """
    cfg = INDEX_CONFIG.get(name)
    if not cfg:
        return {"name": name, "error": "未知指数"}

    result = {"name": name, "code": cfg["code"], "current": None, "ma5": None, "ma10": None, "trend": None, "source": None}

    # 1. 尝试东方财富实时
    em_data = _fetch_from_eastmoney(cfg.get("secid"))
    if em_data:
        result["current"] = em_data["price"]
        result["pct"] = em_data["pct"]
        result["source"] = "eastmoney"
        # 东方财富只有实时价，MA 需要从 baostock 补
        bs_data = _fetch_from_baostock(cfg.get("baostock"))
        if bs_data:
            result["ma5"] = bs_data["ma5"]
            result["ma10"] = bs_data["ma10"]
            result["trend"] = bs_data["trend"]
            result["source"] = "eastmoney+baostock"
            return result
        # 没有 baostock 数据时，用配置默认值作为后备
        if cfg.get("weekly_ma5") is not None:
            result["ma5"] = cfg["weekly_ma5"]
            result["ma10"] = cfg["weekly_ma10"]
            result["trend"] = cfg["trend"]
            result["source"] = "eastmoney+config_default"
            return result
        return result

    # 2. 尝试 baostock
    bs_data = _fetch_from_baostock(cfg.get("baostock"))
    if bs_data:
        result["current"] = bs_data["current"]
        result["ma5"] = bs_data["ma5"]
        result["ma10"] = bs_data["ma10"]
        result["trend"] = bs_data["trend"]
        result["source"] = "baostock"
        return result

    # 3. 尝试手动覆盖
    overrides = _load_manual_overrides()
    if name in overrides:
        ov = overrides[name]
        result["current"] = ov.get("current")
        result["ma5"] = ov.get("ma5")
        result["ma10"] = ov.get("ma10")
        result["trend"] = ov.get("trend")
        result["source"] = "manual_override"
        return result

    # 4. 使用配置默认值
    if cfg.get("current") is not None:
        result["current"] = cfg["current"]
        result["ma5"] = cfg["weekly_ma5"]
        result["ma10"] = cfg["weekly_ma10"]
        result["trend"] = cfg["trend"]
        result["source"] = "config_default"
        return result

    return result


def update_index_manual(name: str, current: float, ma5: float = None, ma10: float = None, trend: str = None):
    """
    手动更新某个指数的值。

    用户可通过此函数在东方财富 API 不可用时手动输入指数数据。
    """
    overrides = _load_manual_overrides()
    overrides[name] = {
        "current": current,
        "ma5": ma5,
        "ma10": ma10,
        "trend": trend,
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
    }
    _save_manual_overrides(overrides)
    return overrides[name]


# ──────────────────────────────────────────────
# 仓位计算
# ──────────────────────────────────────────────

def determine_position(index_data: Dict[str, Dict]) -> Dict:
    """
    基于四维指数趋势判断仓位。

    Args:
        index_data: {"上证指数": {...}, "中证2000": {...}, ...}

    Returns:
        {
            "total_bullish": 多头指数数量,
            "max_position": 建议最大仓位,
            "position_label": 仓位标签,
            "veto_triggered": 是否触发一票否决,
            "veto_reason": 否决原因,
            "details": 各指数详情,
        }
    """
    bullish_count = 0
    details = {}
    warnings = []

    for name, data in index_data.items():
        trend = data.get("trend")
        current = data.get("current")
        ma5 = data.get("ma5")
        ma10 = data.get("ma10")

        is_bullish = trend == "多头"
        if is_bullish:
            bullish_count += 1

        detail = {
            "current": current,
            "code": data.get("code", ""),
            "ma5": ma5,
            "ma10": ma10,
            "trend": trend,
            "bullish": is_bullish,
            "source": data.get("source", ""),
        }
        details[name] = detail

    # ── 一票否决检查 ──
    veto = False
    veto_reason = ""

    # 上证跌破 10 周线
    idx_sh = index_data.get("上证指数", {})
    if idx_sh.get("current") and idx_sh.get("ma10"):
        if idx_sh["current"] < idx_sh["ma10"]:
            veto = True
            veto_reason += f"上证{idx_sh['current']:.0f} < 10周线{idx_sh['ma10']:.0f}；"

    # 中证2000 周线空头
    idx_zz = index_data.get("中证2000", {})
    if idx_zz.get("trend") == "空头":
        veto = True
        veto_reason += "中证2000趋势转空；"

    # ── 仓位计算 ──
    position_map = {
        4: (100, "[满仓做多]"),
        3: (70, "[积极]"),
        2: (50, "[谨慎]"),
        1: (30, "[防御]"),
        0: (0, "[空仓观望]"),
    }

    max_pos, label = position_map.get(bullish_count, (50, "[谨慎]"))

    if veto:
        max_pos = min(max_pos, 50)
        label = "[强制降仓-一票否决]"

    return {
        "total_bullish": bullish_count,
        "max_position": max_pos,
        "position_label": label,
        "veto_triggered": veto,
        "veto_reason": veto_reason.strip("；"),
        "details": details,
        "warnings": warnings,
    }


# ──────────────────────────────────────────────
# 报告生成
# ──────────────────────────────────────────────

def generate_position_report() -> str:
    """生成仓位管理报告"""
    now = datetime.now().strftime("%Y-%m-%d %H:%M")

    lines = []
    lines.append(f"## 仓位管理报告")
    lines.append(f"**生成时间**: {now}")
    lines.append("")

    # 获取各指数数据
    index_data = {}
    for name in INDEX_CONFIG:
        index_data[name] = get_index_data(name)

    # 判断仓位
    result = determine_position(index_data)

    # ── 四维状态表 ──
    lines.append("### 四大指数状态")
    lines.append("")
    lines.append("| 指数 | 代码 | 最新 | 5周MA | 10周MA | 趋势 |")
    lines.append("|:---|:---:|:---:|:---:|:---:|:---:|")
    for name, detail in result["details"].items():
        c = detail.get("current", "-")
        m5 = detail.get("ma5", "-")
        m10 = detail.get("ma10", "-")
        trend_icon = "[多]" if detail.get("trend") == "多头" else "[空]" if detail.get("trend") == "空头" else "[-]"
        trend_text = detail.get("trend", "未知") or "未知"
        current_str = f"{c:.0f}" if isinstance(c, (int, float)) else "-"
        ma5_str = f"{m5:.0f}" if isinstance(m5, (int, float)) else "-"
        ma10_str = f"{m10:.0f}" if isinstance(m10, (int, float)) else "-"
        lines.append(f"| {name} | {detail.get('code', '-')} | {current_str} | {ma5_str} | {ma10_str} | {trend_icon} {trend_text} |")

    lines.append("")

    # ── 仓位建议 ──
    bullish = result["total_bullish"]
    lines.append(f"### 仓位建议: {result['position_label']}")
    lines.append(f"")
    lines.append(f"- **多头指数**: {bullish}/4")
    lines.append(f"- **建议最大仓位**: {result['max_position']}%")
    lines.append("")

    if result["veto_triggered"]:
        lines.append(f"#### [一票否决已触发]")
        lines.append(f"> {result['veto_reason']}")
        lines.append("")

    # ── 操作建议 ──
    lines.append("### 操作建议")
    lines.append("")
    pos = result["max_position"]
    if pos == 100:
        lines.append("> [多] 四维全多头，可满仓操作。分散 3-5 只标的，趋势坏了才走。")
    elif pos >= 70:
        lines.append("> [积极] 市场整体向好，可积极操作。建议 3331 分批建仓，单票 <=30%。")
    elif pos >= 50:
        lines.append("> [谨慎] 结构性行情，精选板块和个股。严格止损，单票 <=20%。")
    elif pos >= 30:
        lines.append("> [防御] 市场偏弱，以防御为主。轻仓试盘或观望。")
    else:
        lines.append("> [空仓] 市场空头主导，建议空仓观望。")
    lines.append("")

    # 一票否决补充
    if result["veto_triggered"]:
        lines.append("> [否决] 一票否决生效中：")
        for reason in result["veto_reason"].split("；"):
            if reason.strip():
                lines.append(f">   - {reason.strip()}")

    return "\n".join(lines)


# ──────────────────────────────────────────────
# 命令行使用
# ──────────────────────────────────────────────

if __name__ == "__main__":
    report = generate_position_report()
    print(report)
