"""
赛道轮动评分引擎（rotation Python 实现）
====================================================
基于 rotation（赛道轮动捕手）的五维评分体系，
使用 AKShare 概念板块指数数据，动态输出推荐赛道列表。

五维评分 (0-15):
  1. 价格趋势信号 0-3: 板块指数近期涨幅与趋势强度
  2. 热度持续性   0-3: 板块在热门排名中的持续天数与频率
  3. 量价配合度   0-3: 量能是否支持价格上涨
  4. 动量加速度   0-3: 近期动量是否在加速
  5. 关注度趋势   0-3: 排名趋势上升/下降

评级:
  ≥12: ⭐⭐⭐ 核心赛道 — 重点扫描
  8-11: ⭐⭐  观察赛道 — 正常扫描
  4-7:  ⭐   备选赛道 — 低优先级
  <4:         暂不关注 — 不扫描

输出:
  - 推荐赛道列表（概念板块名称）
  - 保存为 JSON 文件供 daily_scan.py 读取
"""
import logging
import os
import json
from datetime import datetime, timedelta
from typing import List, Dict, Optional, Tuple
import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


# ── 评分权重与阈值 ──
SCORE_WEIGHTS = {
    "price_trend": 3,     # 价格趋势信号 0-3
    "heat_persistence": 3,  # 热度持续性 0-3
    "volume_confirm": 3,   # 量价配合度 0-3
    "momentum_accel": 3,   # 动量加速度 0-3
    "attention_trend": 3,  # 关注度趋势 0-3
}

RATING_THRESHOLDS = {
    "core": 12,     # >=12: 核心赛道
    "watch": 8,     # >=8: 观察赛道
    "candidate": 4, # >=4: 备选赛道
}

# 推荐扫描数量
DEFAULT_TOP_N = 20


class SectorRotationScorer:
    """
    赛道轮动评分引擎

    对概念板块进行五维评分，输出推荐扫描列表。
    依赖 HotSectorAnalyzer 已获取的板块指数数据。
    """

    def __init__(self, board_index_cache: Dict[str, pd.DataFrame] = None):
        self.board_index_cache = board_index_cache or {}
        self._scores: Dict[str, Dict] = {}

    # ────────────────────────────────────────
    # 维度1: 价格趋势信号 (0-3)
    # ────────────────────────────────────────

    def _score_price_trend(self, board_name: str) -> int:
        """
        评分维度1: 价格趋势信号 (0-3)

        3分: 近5日涨幅 > 8% 且 近10日涨幅 > 12%（加速上涨）
        2分: 近5日涨幅 > 5% 且 近10日涨幅 > 8%（稳定上涨）
        1分: 近5日涨幅 > 2% 或 近10日涨幅 > 5%（企稳回升）
        0分: 无明显上涨趋势
        """
        df = self.board_index_cache.get(board_name)
        if df is None or df.empty or "涨跌幅" not in df.columns:
            return 0

        pcts = df["涨跌幅"].dropna()
        if len(pcts) < 5:
            return 0

        recent_5 = pcts.tail(5).sum()
        recent_10 = pcts.tail(min(10, len(pcts))).sum()

        if recent_5 > 8 and recent_10 > 12:
            return 3
        elif recent_5 > 5 and recent_10 > 8:
            return 2
        elif recent_5 > 2 or recent_10 > 5:
            return 1
        return 0

    # ────────────────────────────────────────
    # 维度2: 热度持续性 (0-3)
    # ────────────────────────────────────────

    def _score_heat_persistence(self, board_name: str,
                                 date_rankings: Dict[str, List[str]],
                                 top_n: int = 10) -> int:
        """
        评分维度2: 热度持续性 (0-3)

        考察板块在 daily rankings 中的出现频率。

        3分: 在 >=60% 的交易日中进入 top10
        2分: 在 >=40% 的交易日中进入 top10
        1分: 在 >=20% 的交易日中进入 top10
        0分: 偶尔上榜或无上榜
        """
        if not date_rankings:
            return 0

        total_days = len(date_rankings)
        if total_days == 0:
            return 0

        appeared_days = 0
        for date, top_boards in date_rankings.items():
            if board_name in top_boards[:top_n]:
                appeared_days += 1

        ratio = appeared_days / total_days
        if ratio >= 0.60:
            return 3
        elif ratio >= 0.40:
            return 2
        elif ratio >= 0.20:
            return 1
        return 0

    # ────────────────────────────────────────
    # 维度3: 量价配合度 (0-3)
    # ────────────────────────────────────────

    def _score_volume_confirm(self, board_name: str) -> int:
        """
        评分维度3: 量价配合度 (0-3)

        考察放量是否伴随上涨。

        3分: 近3日放量(>前5日均量120%) 且 近5日涨幅>5%
        2分: 近3日放量(>前5日均量110%) 且 近5日涨幅>3%
        1分: 近3日放量(>前5日均量105%) 或 近5日涨幅>3%
        0分: 无明显量价配合
        """
        df = self.board_index_cache.get(board_name)
        if df is None or df.empty:
            return 0

        # 尝试获取成交量数据
        vol_col = None
        for col in ["成交量", "成交额", "volume", "amount"]:
            if col in df.columns:
                vol_col = col
                break

        if vol_col is None:
            return 0

        volumes = df[vol_col].dropna()
        pcts = df["涨跌幅"].dropna()

        if len(volumes) < 8 or len(pcts) < 5:
            return 0

        recent_vol = volumes.tail(3).mean()
        prev_vol = volumes.iloc[-8:-3].mean()
        vol_ratio = recent_vol / prev_vol if prev_vol > 0 else 1.0
        recent_5_sum = pcts.tail(5).sum()

        if vol_ratio > 1.20 and recent_5_sum > 5:
            return 3
        elif vol_ratio > 1.10 and recent_5_sum > 3:
            return 2
        elif vol_ratio > 1.05 or recent_5_sum > 3:
            return 1
        return 0

    # ────────────────────────────────────────
    # 维度4: 动量加速度 (0-3)
    # ────────────────────────────────────────

    def _score_momentum_accel(self, board_name: str) -> int:
        """
        评分维度4: 动量加速度 (0-3)

        考察近期涨幅是否在加速。

        3分: 近3日涨幅 > 近5日涨幅的70%（加速明显）
        2分: 近3日涨幅 > 近5日涨幅的50%（温和加速）
        1分: 近3日涨幅 > 0（仍在上涨）
        0分: 无加速或下跌
        """
        df = self.board_index_cache.get(board_name)
        if df is None or df.empty or "涨跌幅" not in df.columns:
            return 0

        pcts = df["涨跌幅"].dropna()
        if len(pcts) < 5:
            return 0

        recent_3 = pcts.tail(3).sum()
        recent_5 = pcts.tail(5).sum()

        if recent_5 > 0 and recent_3 > recent_5 * 0.7:
            return 3
        elif recent_5 > 0 and recent_3 > recent_5 * 0.5:
            return 2
        elif recent_3 > 0:
            return 1
        return 0

    # ────────────────────────────────────────
    # 维度5: 关注度趋势 (0-3)
    # ────────────────────────────────────────

    def _score_attention_trend(self, board_name: str,
                                date_rankings: Dict[str, List[str]],
                                top_n: int = 10) -> int:
        """
        评分维度5: 关注度趋势 (0-3)

        考察板块在排名中的位置变化趋势。
        近年关注度在上升还是下降。

        3分: 近3日排名持续上升（每天排名都比前一天好）
        2分: 近3日排名总体上升
        1分: 排名稳定在 top10 但无明显趋势
        0分: 排名下降或不在 top 中
        """
        if not date_rankings:
            return 0

        # 按日期排序
        sorted_dates = sorted(date_rankings.keys())
        if len(sorted_dates) < 3:
            return 0

        # 取最近3-5天
        recent_dates = sorted_dates[-5:]
        positions = []
        for date in recent_dates:
            top_boards = date_rankings.get(date, [])
            if board_name in top_boards[:top_n]:
                pos = top_boards.index(board_name)
                positions.append(pos)
            else:
                positions.append(top_n + 5)  # 不在top中，给一个差排名

        if len(positions) < 2:
            return 0

        # 检查趋势：最近位置是否在变好（数字变小）
        recent_positions = positions[-3:] if len(positions) >= 3 else positions[-2:]
        if len(recent_positions) >= 3:
            if recent_positions[-1] < recent_positions[-2] < recent_positions[-3]:
                return 3  # 持续上升

        if recent_positions[-1] < recent_positions[0]:
            return 2  # 总体上升

        if board_name in date_rankings.get(sorted_dates[-1], [])[:top_n]:
            return 1  # 稳定在top中

        return 0

    # ────────────────────────────────────────
    # 综合评分
    # ────────────────────────────────────────

    def score_all(self, date_rankings: Dict[str, List[str]] = None,
                  top_n_rank: int = 10) -> Dict[str, Dict]:
        """
        对所有板块进行五维综合评分。

        参数:
            date_rankings: {date: [board_names]} 每日板块涨幅排名
                           （来自 HotSectorAnalyzer.compute_hot_sectors 的内部数据）
            top_n_rank: 排名考察深度

        返回:
            {
                "板块名": {
                    "total_score": 0-15,
                    "rating": "core/watch/candidate/ignore",
                    "rating_label": "⭐⭐⭐核心赛道/⭐⭐观察/⭐备选/暂不关注",
                    "factors": {
                        "price_trend": 0-3,
                        "heat_persistence": 0-3,
                        "volume_confirm": 0-3,
                        "momentum_accel": 0-3,
                        "attention_trend": 0-3,
                    },
                    "latest_pct": float,  # 最新涨跌幅
                }
            }
        """
        results = {}
        date_rankings = date_rankings or {}

        for board_name in self.board_index_cache:
            score_price = self._score_price_trend(board_name)
            score_heat = self._score_heat_persistence(board_name, date_rankings, top_n_rank)
            score_volume = self._score_volume_confirm(board_name)
            score_momentum = self._score_momentum_accel(board_name)
            score_attention = self._score_attention_trend(board_name, date_rankings, top_n_rank)

            total = score_price + score_heat + score_volume + score_momentum + score_attention

            # 评级
            core_threshold = (SCORE_WEIGHTS["price_trend"] + SCORE_WEIGHTS["heat_persistence"]
                              + SCORE_WEIGHTS["volume_confirm"])  # >= 9 的核心维度
            if total >= core_threshold:
                if total >= 12:
                    rating = "core"
                    rating_label = "⭐⭐⭐核心赛道"
                elif total >= 8:
                    rating = "watch"
                    rating_label = "⭐⭐观察赛道"
                elif total >= 4:
                    rating = "candidate"
                    rating_label = "⭐备选赛道"
                else:
                    rating = "ignore"
                    rating_label = "暂不关注"
            else:
                if total >= 8:
                    rating = "watch"
                    rating_label = "⭐⭐观察赛道"
                elif total >= 4:
                    rating = "candidate"
                    rating_label = "⭐备选赛道"
                else:
                    rating = "ignore"
                    rating_label = "暂不关注"

            # 最新涨跌幅
            df = self.board_index_cache.get(board_name)
            latest_pct = 0.0
            if df is not None and "涨跌幅" in df.columns:
                pcts = df["涨跌幅"].dropna()
                if not pcts.empty:
                    latest_pct = float(pcts.iloc[-1])

            results[board_name] = {
                "total_score": total,
                "rating": rating,
                "rating_label": rating_label,
                "factors": {
                    "price_trend": score_price,
                    "heat_persistence": score_heat,
                    "volume_confirm": score_volume,
                    "momentum_accel": score_momentum,
                    "attention_trend": score_attention,
                },
                "latest_pct": latest_pct,
            }

        self._scores = results
        return results

    # ────────────────────────────────────────
    # 获取推荐扫描赛道
    # ────────────────────────────────────────

    def get_recommended_sectors(self, top_n: int = DEFAULT_TOP_N,
                                 min_score: int = 4) -> List[Dict]:
        """
        获取推荐扫描赛道列表。

        参数:
            top_n: 返回前 N 个赛道
            min_score: 最低评分（低于此分不推荐）

        返回:
            [
                {
                    "name": "板块名",
                    "score": int,
                    "rating": str,
                    "rating_label": str,
                    "latest_pct": float,
                },
                ...
            ]
        """
        if not self._scores:
            return []

        # 按评分降序排列
        sorted_sectors = sorted(
            self._scores.items(),
            key=lambda x: (x[1]["total_score"], x[1]["latest_pct"]),
            reverse=True,
        )

        results = []
        for name, score_data in sorted_sectors:
            if score_data["total_score"] >= min_score:
                results.append({
                    "name": name,
                    "score": score_data["total_score"],
                    "rating": score_data["rating"],
                    "rating_label": score_data["rating_label"],
                    "latest_pct": score_data["latest_pct"],
                })
            if len(results) >= top_n:
                break

        return results


# ────────────────────────────────────────
# 一站式接口：从 HotSectorAnalyzer 结果中评分并推荐
# ────────────────────────────────────────

def analyze_and_recommend(
    board_index_cache: Dict[str, pd.DataFrame],
    date_rankings: Dict[str, List[str]] = None,
    top_n: int = DEFAULT_TOP_N,
) -> Dict:
    """
    一站式赛道评分推荐。

    参数:
        board_index_cache: {板块名: DataFrame} 板块指数数据
        date_rankings: {日期: [板块名]} 每日板块排名（可选）
        top_n: 返回前 N 个推荐赛道

    返回:
        {
            "timestamp": "2026-05-27 14:00:00",
            "total_sectors_scored": 375,
            "recommendations": [
                {"name": "...", "score": 14, "rating": "core", ...},
                ...
            ],
            "scan_sectors": ["板块名1", "板块名2", ...],  # 直接用于扫描的列表
        }
    """
    scorer = SectorRotationScorer(board_index_cache)
    scorer.score_all(date_rankings=date_rankings)
    recommendations = scorer.get_recommended_sectors(top_n=top_n)

    # 提取扫描用的板块名列表（只取 core + watch 级别）
    scan_sectors_full = [r["name"] for r in recommendations]

    # 如果推荐不足 top_n，改用 watch 级别以上优先
    scan_sectors_priority = [
        r["name"] for r in recommendations
        if r["rating"] in ("core", "watch")
    ]
    # 补足到 top_n（加入备选赛道）
    if len(scan_sectors_priority) < top_n:
        for r in recommendations:
            if r["name"] not in scan_sectors_priority:
                scan_sectors_priority.append(r["name"])
            if len(scan_sectors_priority) >= top_n:
                break

    result = {
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "total_sectors_scored": len(board_index_cache),
        "recommendations": recommendations,
        "scan_sectors": scan_sectors_priority,
    }
    return result


# ────────────────────────────────────────
# 缓存管理（与 HotSectorAnalyzer 共用缓存目录）
# ────────────────────────────────────────

def get_cache_path() -> str:
    """赛道推荐缓存路径"""
    date_str = datetime.now().strftime("%Y%m%d")
    cache_dir = os.path.join(os.path.dirname(__file__), "..", "..", "cache")
    os.makedirs(cache_dir, exist_ok=True)
    return os.path.join(cache_dir, f"sector_recommend_{date_str}.json")


def save_recommendations(result: Dict):
    """保存赛道推荐结果到缓存文件"""
    path = get_cache_path()
    try:
        # 将不可序列化的内容移除
        save_data = {
            "timestamp": result["timestamp"],
            "total_sectors_scored": result["total_sectors_scored"],
            "recommendations": result["recommendations"],
            "scan_sectors": result["scan_sectors"],
        }
        # 保存同花顺板块映射（加载层已转换好）
        if result.get("ths_scan_sectors"):
            save_data["ths_scan_sectors"] = result["ths_scan_sectors"]
        with open(path, "w", encoding="utf-8") as f:
            json.dump(save_data, f, ensure_ascii=False, indent=2)
        logger.info(f"赛道推荐已缓存: {path} ({len(result['scan_sectors'])} 个赛道)")
    except Exception as e:
        logger.warning(f"赛道推荐缓存失败: {e}")


def load_recommendations() -> Optional[Dict]:
    """
    从缓存加载今日赛道推荐。

    加载后立即确保 ths_scan_sectors（同花顺概念板块名）可用，
    消费端（get_scan_sectors、Step 5 匹配）直接使用无需再转换。
    """
    path = get_cache_path()
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            logger.info(f"赛道推荐已加载: {path}")
            # 确保 THS 映射在数据返回前就绪
            if data.get("scan_sectors") and not data.get("ths_scan_sectors"):
                try:
                    from swing_trader.utils.sector_report_reader import (
                        resolve_to_ths_names,
                    )
                    ths = resolve_to_ths_names(data["scan_sectors"])
                    if ths:
                        data["ths_scan_sectors"] = ths
                        # 回写缓存补上映射
                        try:
                            save_recommendations(data)
                        except Exception:
                            pass
                except ImportError:
                    pass
            return data
        except Exception as e:
            logger.warning(f"赛道推荐加载失败: {e}")

    # ── 后备数据源: rotation 本地文件夹 ──
    try:
        from swing_trader.utils.sector_report_reader import (
            load_from_folder, convert_to_cache_format, is_folder_available,
        )
        if is_folder_available():
            folder_data = load_from_folder()
            if folder_data:
                converted = convert_to_cache_format(folder_data)
                # convert_to_cache_format 已自动包含 ths_scan_sectors
                logger.info(
                    f"赛道推荐已从本地文件夹加载: "
                    f"{folder_data.get('source_file', '')}"
                )
                return converted
    except ImportError:
        logger.debug("sector_report_reader 模块不可用")
    except Exception as e:
        logger.warning(f"从文件夹加载赛道推荐失败: {e}")

    return None


def is_cache_fresh() -> bool:
    """检查今日缓存是否有效"""
    path = get_cache_path()
    if not os.path.exists(path):
        return False
    try:
        mod_time = datetime.fromtimestamp(os.path.getmtime(path))
        today = datetime.now()
        # 缓存是今日生成的则有效
        return mod_time.date() == today.date()
    except Exception:
        return False
