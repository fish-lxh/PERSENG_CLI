"""
晓胜波段王 · 盘前简报
=====================
每日 09:00 自动生成，基于隔夜外盘+早盘亚太市场预判A股方向。

数据源:
  - 布伦特原油（24h交易）→ 通胀预期
  - 韩股KOSPI、日经225（早1h开盘）→ 亚太情绪
  - 美股S&P500、Nasdaq（隔夜收盘）→ 全球风向
  - A50期指（24h交易）→ 外资对A股态度
  - 离岸汇率 → 资金流向
  - 融资余额 → 市场热度
  - 大盘周线阶段 → 中期趋势

用法: python morning_brief.py
"""
import sys, os, io

if sys.platform == "win32":
    try:
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
        sys.stderr = io.TextIOWrapper(sys.stderr.buffer, encoding="utf-8", errors="replace")
    except Exception:
        pass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import logging
logging.basicConfig(level=logging.WARNING, format="%(message)s")

from datetime import datetime
from typing import Dict, Optional
import numpy as np

# 周末跳过
if datetime.now().weekday() >= 5:  # Saturday(5) or Sunday(6)
    print("周末休市，跳过执行")
    sys.exit(0)


# ──────────────────────────────────────────────
# 1. 市场阶段（基于昨日收盘数据）
# ──────────────────────────────────────────────

def get_market_phase() -> Dict:
    """判断当前市场阶段（基于昨日收盘）"""
    import baostock as bs
    lg = bs.login()
    if lg.error_code != "0":
        return {"phase": "未知", "confidence": 0, "position": "0%"}
    try:
        rs = bs.query_history_k_data_plus(
            "sh.000001", "date,close,pctChg",
            frequency="w", adjustflag="2",
            start_date="2024-01-01",
            end_date=datetime.now().strftime("%Y-%m-%d"),
        )
        dates, closes, pcts = [], [], []
        if rs.error_code == "0":
            df = rs.get_data()
            if df is not None and not df.empty:
                for _, row in df.iterrows():
                    close_val = row.get("close", 0)
                    if close_val and float(close_val) > 0:
                        dates.append(str(row["date"]))
                        closes.append(float(close_val))
                        pcts.append(float(row.get("pctChg", 0)) if row.get("pctChg") else 0)

        if len(closes) < 8:
            return {"phase": "春(默认)", "confidence": 2, "position": "30%"}

        recent = closes[-10:]
        recent_pcts = pcts[-10:]
        ma5 = np.mean(recent[-5:])
        ma10 = np.mean(recent)
        macd_bull = ma5 > ma10
        positive_weeks = sum(1 for p in recent_pcts if p > 0)

        if macd_bull and positive_weeks >= 4:
            confidence = min(3 + sum(1 for p in recent_pcts[-4:] if p > 0), 5)
            return {"phase": "春", "confidence": confidence,
                    "position": f"{min(50 + confidence*5, 70)}%"}
        elif positive_weeks >= 3:
            return {"phase": "冬末春初", "confidence": 3, "position": "30%"}
        else:
            return {"phase": "冬", "confidence": 1, "position": "0%"}
    finally:
        bs.logout()


# ──────────────────────────────────────────────
# 2. 融资余额
# ──────────────────────────────────────────────

def get_margin_balance() -> Optional[Dict]:
    """获取两市融资余额（沪+深）"""
    try:
        import akshare as ak
        # 使用可用API：macro_china_market_margin_sh + macro_china_market_margin_sz
        sh_df = ak.macro_china_market_margin_sh()
        sz_df = ak.macro_china_market_margin_sz()
        if sh_df is not None and not sh_df.empty and sz_df is not None and not sz_df.empty:
            sh_latest = sh_df.iloc[-1]
            sz_latest = sz_df.iloc[-1]
            # 找融资余额列
            sh_balance_col = None
            for c in sh_df.columns:
                if "融资余额" in str(c):
                    sh_balance_col = c; break
            sz_balance_col = None
            for c in sz_df.columns:
                if "融资余额" in str(c):
                    sz_balance_col = c; break
            if sh_balance_col and sz_balance_col:
                sh_balance = float(sh_latest[sh_balance_col]) / 1e8  # 元→亿元
                sz_balance = float(sz_latest[sz_balance_col]) / 1e8
                total_balance = sh_balance + sz_balance
                from swing_trader.utils.config import CONFIG
                warn = total_balance > CONFIG.xiaosheng.margin_balance_warning
                return {"balance": total_balance, "warning": warn,
                        "status": "过热⚠️" if warn else "正常"}
    except Exception as e:
        pass
    return None


# ──────────────────────────────────────────────
# 3. 盘前简报
# ──────────────────────────────────────────────

def generate_brief() -> str:
    """生成盘前简报"""
    lines = []
    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    today = datetime.now().strftime("%Y-%m-%d")

    lines.append("=" * 54)
    lines.append("  晓胜波段王 · 盘前预判简报")
    lines.append(f"  {now}")
    lines.append("=" * 54)
    lines.append("")

    # ── 市场阶段 ──
    phase = get_market_phase()
    lines.append(f"【市场阶段】{phase['phase']}（信号{phase['confidence']}/5）")
    lines.append(f"  建议仓位: {phase['position']}")
    lines.append("")

    # ── 知更鸟信号 ──
    from swing_trader.utils.robin_signal import RobinSignal
    robin = RobinSignal()
    result = robin.analyze(extended=True)

    lines.append(f"【知更鸟信号】{result['direction']}（置信度{result['confidence']}/5）")
    signals = result.get("signals", {})
    for source_key, label in [
        ("brent_oil", "WTI原油"),
        ("us_sp500", "美股S&P500"),
        ("us_nasdaq", "美股Nasdaq"),
        ("a50_futures", "A50期指"),
        ("korean_kospi", "韩股KOSPI"),
        ("japan_nikkei", "日经225"),
        ("usd_cny", "离岸汇率"),
    ]:
        s = signals.get(source_key, {})
        sig = s.get("signal", "无数据")
        pct = s.get("pct")
        interp = s.get("interpretation", "")
        if pct is not None:
            pct_str = f"{pct:+.2f}%"
            arrow = "↑" if sig == "偏多" else ("↓" if sig == "偏空" else "→")
            lines.append(f"  {label}: {pct_str} {arrow}  {interp}")
        else:
            lines.append(f"  {label}: 无数据")
    lines.append("")

    # ── 融资余额 ──
    margin = get_margin_balance()
    if margin:
        lines.append(f"【融资余额】{margin['balance']:.0f}亿（{margin['status']}）")
    else:
        lines.append(f"【融资余额】获取失败")
    lines.append("")

    # ── 综合研判 ──
    phase_score = phase["confidence"]
    robin_score = result["confidence"]
    robin_dir = result["direction"]

    if robin_dir == "偏多" and phase_score >= 3:
        verdict = "偏多 ✓ 外盘与A股中期趋势共振，关注今日盘中机会"
    elif robin_dir == "偏空" and phase_score >= 3:
        verdict = "谨慎 ⚠️ 外盘走弱但A股中期趋势尚可，等盘中企稳再出手"
    elif robin_dir == "偏空" and phase_score < 3:
        verdict = "观望 ✋ 外盘走弱+A股中期趋势不佳，多看少动"
    elif robin_dir == "偏多" and phase_score < 3:
        verdict = "中性 → 外盘偏好但A股中期偏弱，等右侧确认"
    else:
        verdict = "中性 → 信号不明确，等待开盘后观察"

    lines.append(f"【综合研判】{verdict}")
    lines.append("")
    lines.append("-" * 54)

    return "\n".join(lines)


# ──────────────────────────────────────────────
# 主入口
# ──────────────────────────────────────────────

def main():
    today_str = datetime.now().strftime("%Y%m%d")
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M")
    output_dir = "scan_results"
    os.makedirs(output_dir, exist_ok=True)

    # ── 盘前简报 ──
    brief = generate_brief()
    print(brief)

    # ── 四维仓位报告 ──
    try:
        from swing_trader.utils.position_sizer import generate_position_report
        pos_report = generate_position_report()
        # 追加到简报
        full_output = f"# 盘前简报\n\n{brief}\n\n{pos_report}\n"

        # 单独保存仓位报告
        pos_path = os.path.join(output_dir, f"position_report_{today_str}.md")
        with open(pos_path, "w", encoding="utf-8") as f:
            f.write(f"# 四维仓位报告\n**生成时间**: {now_str}\n\n{pos_report}\n")
        print(f"\n✅ 仓位报告已保存: {pos_path}")
    except Exception as e:
        full_output = f"# 盘前简报\n\n{brief}\n"
        print(f"\n⚠️ 仓位报告生成失败: {e}")

    # 保存简报
    brief_path = os.path.join(output_dir, f"morning_brief_{today_str}.md")
    with open(brief_path, "w", encoding="utf-8") as f:
        f.write(full_output)
    print(f"✅ 简报已保存: {brief_path}")


if __name__ == "__main__":
    main()
