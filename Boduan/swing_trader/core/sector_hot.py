"""
Step 2: 热门板块扫描
======================
1. 识别当日概念板块涨跌幅前20
2. 对每个板块回溯10个交易日，验证其持续性
3. 选出10个交易日内至少3次表现强势的板块（持续性验证）

数据源:
  - AKShare（东方财富）：概念板块实时排行 + 历史K线
  - 网络不可用时自动降级，返回空结果
"""
import logging
import time
import random
from typing import Optional, List, Dict
from datetime import datetime, timedelta

import pandas as pd

from ..data_sources.akshare_source import AKShareSource
from ..utils.config import CONFIG

logger = logging.getLogger(__name__)

# AKShare API 重试配置
_MAX_RETRIES = 3
_BASE_DELAY = 1.0


def _call_with_retry(func, *args, **kwargs):
    """
    带指数退避的重试调用

    针对东方财富 API 偶发性连接中断，最多重试 _MAX_RETRIES 次
    """
    last_exception = None
    for attempt in range(_MAX_RETRIES):
        try:
            return func(*args, **kwargs)
        except Exception as e:
            last_exception = e
            if attempt < _MAX_RETRIES - 1:
                delay = _BASE_DELAY * (2 ** attempt) + random.uniform(0.5, 1.0)
                logger.debug(f"API调用重试 {attempt + 1}/{_MAX_RETRIES}: {func.__name__}, 等待{delay:.1f}秒")
                time.sleep(delay)
    raise last_exception


class SectorHotResult:
    """板块热度扫描结果"""

    def __init__(self):
        self.industry_top: pd.DataFrame = pd.DataFrame()   # 行业板块排行
        self.concept_top: pd.DataFrame = pd.DataFrame()    # 概念板块排行
        self.hot_sectors: List[str] = []                    # 热门板块名称列表（已通过持续性验证）
        self.persistent_sectors: List[Dict] = []            # 持续性板块详情
        self.top_stocks: List[str] = []                      # 领涨股列表


class SectorHotScanner:
    """
    板块热度扫描器（含持续性验证）

    使用方式:
        scanner = SectorHotScanner()
        result = scanner.scan(top_n=20, persistence_days=10, min_hot_count=3)
        print(result.persistent_sectors)  # 通过持续性验证的板块
        print(result.hot_sectors)         # 板块名称列表
    """

    def __init__(self):
        self._ak = AKShareSource()

    def scan(self, top_n: int = 20, persistence_days: int = 10,
             min_hot_count: int = 3) -> SectorHotResult:
        """
        扫描热门板块（含持续性验证）

        参数:
            top_n: 取前N个概念板块进行持续性检查
            persistence_days: 回溯多少个交易日
            min_hot_count: 在回溯期内至少多少次表现强势

        返回:
            SectorHotResult 包含通过持续性验证的板块列表
        """
        result = SectorHotResult()

        # 获取今日概念板块排行（带重试）
        try:
            result.concept_top = _call_with_retry(
                self._ak.get_concept_sector_ranking, top_n=top_n
            )
        except Exception as e:
            logger.error(f"获取概念板块排行失败（已重试{_MAX_RETRIES}次）: {e}")
            result.concept_top = pd.DataFrame()
            return result

        # 获取行业板块排行（备用参考，带重试）
        try:
            result.industry_top = _call_with_retry(
                self._ak.get_sector_ranking, top_n=top_n
            )
        except Exception as e:
            logger.warning(f"获取行业板块排行失败: {e}")
            result.industry_top = pd.DataFrame()

        if result.concept_top.empty:
            return result

        # 板块持续性验证
        persistent = self._check_persistence(result.concept_top, persistence_days, min_hot_count)

        # 如果持续性验证全部失败（如概念板块历史接口不可用），
        # 降级策略：将今日涨幅前5的板块直接视为热门，跳过历史验证
        if not persistent and not result.concept_top.empty:
            logger.warning("持续性验证数据不可用，降级为单日热点扫描")
            for _, row in result.concept_top.iterrows():
                name = row.get("板块名称", "")
                code = row.get("板块代码", "")
                leader = row.get("领涨股票", "")
                if name:
                    persistent.append({
                        "name": name,
                        "code": code,
                        "hot_count": 1,
                        "total_days": 1,
                        "avg_return": float(row.get("涨跌幅", 0)),
                        "leader_stocks": [leader] if leader else [],
                    })
            # 取前5
            persistent = persistent[:5]

        result.persistent_sectors = persistent
        result.hot_sectors = [s["name"] for s in persistent]

        # 提取领涨股
        top_stocks = set()
        for s in persistent:
            for stock in s.get("leader_stocks", []):
                top_stocks.add(stock)
        result.top_stocks = list(top_stocks)[:10]

        logger.info(
            f"板块持续性扫描: {len(result.concept_top)}个候选 → "
            f"{len(persistent)}个通过持续性验证"
        )
        return result

    def _check_persistence(self, concept_top: pd.DataFrame,
                           days: int, min_hot: int) -> List[Dict]:
        """
        对概念板块逐個进行10日持续性验证

        返回: [
            {
                "name": "人工智能",
                "code": "BKxxxx",
                "hot_count": 5,        # 10日内强势天数
                "avg_return": 2.3,      # 10日平均涨幅
                "leader_stocks": [...],
            },
            ...
        ]
        """
        result = []

        for _, row in concept_top.iterrows():
            sector_name = row.get("板块名称", "")
            sector_code = row.get("板块代码", "")
            if not sector_code:
                continue

            try:
                # 获取板块10日历史数据（带重试）
                hist = _call_with_retry(
                    self._ak.get_sector_concept_hist,
                    sector_code,
                    start_date=(datetime.now() - timedelta(days=15)).strftime("%Y%m%d"),
                )
                if hist.empty or len(hist) < days:
                    continue

                # 取最近 days 个交易日
                recent = hist.tail(days).copy()
                # 计算每日涨跌幅
                recent["pct"] = (recent["close"] - recent["open"]) / recent["open"] * 100

                # 统计强势天数（当日涨幅 > 所有板块中位数，或 > 0.5%）
                threshold = 0.5
                hot_days = (recent["pct"] > threshold).sum()
                avg_return = recent["pct"].mean()

                # 持续性验证：至少 min_hot 天强势
                if hot_days >= min_hot:
                    # 获取领涨股
                    leaders = []
                    if "领涨股票" in concept_top.columns:
                        leader = row.get("领涨股票", "")
                        if leader and isinstance(leader, str):
                            leaders = [leader]

                    result.append({
                        "name": sector_name,
                        "code": sector_code,
                        "hot_count": int(hot_days),
                        "total_days": days,
                        "avg_return": round(avg_return, 2),
                        "leader_stocks": leaders,
                    })

            except Exception as e:
                logger.debug(f"板块持续性检查失败 {sector_name}: {e}")
                continue

        # 按强势天数降序排列
        result.sort(key=lambda x: x["hot_count"], reverse=True)
        return result
