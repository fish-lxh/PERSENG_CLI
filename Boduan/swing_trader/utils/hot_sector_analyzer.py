"""
热门板块分析器
=============
功能:
  1. 获取同花顺所有概念板块列表
  2. 并行获取板块指数数据，计算每日涨跌幅
  3. 识别热门板块（10天内至少3次排名前5）
  4. 获取个股所属概念板块
"""
import logging
from typing import List, Dict, Optional, Tuple
from datetime import datetime, timedelta
from concurrent.futures import ThreadPoolExecutor, as_completed
import re
import os
import json
import pickle

import akshare as ak
import pandas as pd
import numpy as np
import requests

logger = logging.getLogger(__name__)

# 全局抑制 tqdm 进度条（AKShare 内部使用）
os.environ["TQDM_DISABLE"] = "1"

# ── 请求头 ──
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )
}

# ── 重点监控板块（晓胜策略核心方向+市场常热板块） ──
KEY_SECTORS = [
    "机器人概念", "人工智能", "算力租赁", "芯片概念", "第三代半导体",
    "新能源汽车", "光伏概念", "储能", "电力物联网", "军工",
    "低空经济", "消费电子概念", "数据中心", "人形机器人",
    "DeepSeek概念", "东数西算(算力)", "液冷服务器", "存储芯片",
    "多模态AI", "AI应用",
]


class HotSectorAnalyzer:
    """热门板块分析器"""

    def __init__(self, max_workers: int = 30):
        self.max_workers = max_workers
        self._board_names: List[str] = []
        self._board_index_cache: Dict[str, pd.DataFrame] = {}

    # ────────────────────────────────────────
    # 1. 获取所有概念板块名称
    # ────────────────────────────────────────

    def get_all_board_names(self) -> List[str]:
        """获取同花顺所有概念板块名称"""
        if self._board_names:
            return self._board_names
        try:
            df = ak.stock_board_concept_name_ths()
            if df is not None and not df.empty and "name" in df.columns:
                self._board_names = df["name"].tolist()
                logger.info(f"获取到 {len(self._board_names)} 个概念板块")
                return self._board_names
        except Exception as e:
            logger.warning(f"获取概念板块列表失败: {e}")
        return []

    # ────────────────────────────────────────
    # 2. 获取单板块指数数据
    # ────────────────────────────────────────

    def get_board_index(self, board_name: str,
                        start_date: str, end_date: str) -> Optional[pd.DataFrame]:
        """获取单个概念板块的指数日线数据"""
        try:
            df = ak.stock_board_concept_index_ths(
                symbol=board_name,
                start_date=start_date,
                end_date=end_date,
            )
            if df is not None and not df.empty and "日期" in df.columns:
                df = df.sort_values("日期").reset_index(drop=True)
                # 计算每日涨跌幅
                if "收盘价" in df.columns and len(df) > 1:
                    df["涨跌幅"] = df["收盘价"].pct_change() * 100
                return df
        except Exception as e:
            logger.debug(f"获取板块[{board_name}]指数失败: {e}")
        return None

    # ────────────────────────────────────────
    # 3. 获取所有板块指数数据（顺序执行 + 缓存）
    # ────────────────────────────────────────

    @staticmethod
    def _cache_path() -> str:
        """缓存文件路径"""
        date_str = datetime.now().strftime("%Y%m%d")
        cache_dir = os.path.join(os.path.dirname(__file__), "..", "..", "cache")
        os.makedirs(cache_dir, exist_ok=True)
        return os.path.join(cache_dir, f"board_index_{date_str}.pkl")

    @staticmethod
    def _load_cache() -> Optional[Dict[str, pd.DataFrame]]:
        """从缓存加载今日板块数据"""
        path = HotSectorAnalyzer._cache_path()
        if os.path.exists(path):
            try:
                with open(path, "rb") as f:
                    data = pickle.load(f)
                logger.info(f"从缓存加载 {len(data)} 个板块数据")
                return data
            except Exception as e:
                logger.debug(f"缓存加载失败: {e}")
        return None

    @staticmethod
    def _save_cache(data: Dict[str, pd.DataFrame]):
        """保存板块数据到缓存"""
        path = HotSectorAnalyzer._cache_path()
        try:
            with open(path, "wb") as f:
                pickle.dump(data, f)
            logger.info(f"板块数据已缓存: {path}")
        except Exception as e:
            logger.debug(f"缓存保存失败: {e}")

    def get_all_boards_index_sequential(self, board_names: List[str],
                                         start_date: str, end_date: str,
                                         progress_callback=None) -> Dict[str, pd.DataFrame]:
        """
        顺序获取所有板块的指数数据。

        注意：由于 AKShare 内部使用 py_mini_racer（V8 JS引擎），
        不能在多线程中并行调用，必须顺序执行以避免崩溃。
        """
        # 尝试从缓存加载
        cached = self._load_cache()
        if cached is not None:
            self._board_index_cache = cached
            return cached

        results = {}
        total = len(board_names)

        for idx, board_name in enumerate(board_names):
            df = self.get_board_index(board_name, start_date, end_date)
            if df is not None:
                results[board_name] = df

            # 进度回调
            if progress_callback:
                progress_callback(idx + 1, total)
            elif (idx + 1) % 50 == 0:
                logger.info(f"  板块数据获取: {idx+1}/{total}")

        self._board_index_cache = results
        logger.info(f"成功获取 {len(results)}/{total} 个板块指数数据")

        # 保存缓存
        self._save_cache(results)
        return results

    # ────────────────────────────────────────
    # 4. 计算热门板块排名
    # ────────────────────────────────────────

    def compute_hot_sectors(self, top_n: int = 5,
                             min_appearances: int = 3,
                             window_days: int = 10) -> List[Dict]:
        """
        识别热门板块：window_days 天内至少 min_appearances 次排名 top_n。

        返回:
            [{"name": "板块名", "rank_times": 3, "avg_pct": 2.5,
              "rank_dates": ["2026-05-07", ...], "latest_pct": 3.2}, ...]
        """
        if not self._board_index_cache:
            logger.warning("无板块数据，请先调用 get_all_boards_index_parallel")
            return []

        # 收集所有日期
        all_dates = set()
        for df in self._board_index_cache.values():
            if "日期" in df.columns:
                for d in df["日期"].dropna().tolist():
                    all_dates.add(str(d)[:10])
        all_dates = sorted(all_dates)

        if len(all_dates) < 2:
            logger.warning("板块数据日期不足")
            return []

        # 只取最近 window_days 天
        recent_dates = all_dates[-window_days:] if len(all_dates) > window_days else all_dates

        # 对每个日期，计算所有板块的涨跌幅排名
        date_rankings: Dict[str, List[str]] = {}  # date → top N board names
        for date in recent_dates:
            board_pct = {}
            for board_name, df in self._board_index_cache.items():
                if "日期" not in df.columns:
                    continue
                row = df[df["日期"].astype(str).str.startswith(date)]
                if row.empty:
                    continue
                pct = row.iloc[0].get("涨跌幅")
                if pct is not None and not pd.isna(pct):
                    board_pct[board_name] = pct

            if board_pct:
                sorted_boards = sorted(board_pct.items(), key=lambda x: x[1], reverse=True)
                date_rankings[date] = [b[0] for b in sorted_boards[:top_n]]

        # 统计每个板块进入前N名的次数
        board_count: Dict[str, int] = {}
        board_dates: Dict[str, List[str]] = {}
        board_latest_pct: Dict[str, float] = {}
        board_avg_pct: Dict[str, float] = {}

        for date, top_boards in date_rankings.items():
            for board_name in top_boards:
                board_count[board_name] = board_count.get(board_name, 0) + 1
                if board_name not in board_dates:
                    board_dates[board_name] = []
                board_dates[board_name].append(date)

                # 记录最新涨跌幅
                if board_name in self._board_index_cache:
                    df = self._board_index_cache[board_name]
                    if "涨跌幅" in df.columns:
                        pcts = df["涨跌幅"].dropna()
                        if not pcts.empty:
                            board_latest_pct[board_name] = float(pcts.iloc[-1])
                            board_avg_pct[board_name] = float(pcts.mean())

        # 筛选出热点板块
        hot_sectors = []
        for board_name, count in board_count.items():
            if count >= min_appearances:
                hot_sectors.append({
                    "name": board_name,
                    "rank_times": count,
                    "rank_dates": board_dates.get(board_name, []),
                    "latest_pct": board_latest_pct.get(board_name, 0),
                    "avg_pct": board_avg_pct.get(board_name, 0),
                })

        # 按排名次数降序
        hot_sectors.sort(key=lambda x: (x["rank_times"], abs(x["avg_pct"])), reverse=True)
        return hot_sectors

    # ────────────────────────────────────────
    # 5. 获取个股所属概念板块
    # ────────────────────────────────────────

    @staticmethod
    def get_stock_concepts(code: str) -> List[str]:
        """
        获取个股所属的所有概念板块。

        通过爬取同花顺个股页面提取概念标签。
        每个请求约1-3秒。
        """
        url = f"http://basic.10jqka.com.cn/{code}/"
        try:
            r = requests.get(url, headers=HEADERS, timeout=15)
            # 同花顺页面使用 gbk 编码
            html = r.content.decode("gbk", errors="replace")
            # 提取概念名称 (jumpToUrl 调用的第4个参数)
            concepts = re.findall(
                r"concept\.html',\s*'concept',\s*'[^']*',\s*'([^']+)'",
                html,
            )
            # 去重并保留顺序
            seen = set()
            result = []
            for c in concepts:
                if c not in seen:
                    seen.add(c)
                    result.append(c)
            return result
        except Exception as e:
            logger.debug(f"获取{code}概念板块失败: {e}")
            return []

    @staticmethod
    def get_stocks_concepts_batch(codes: List[str]) -> Dict[str, List[str]]:
        """批量获取多只股票的概念板块（并行）"""
        results = {}

        def fetch(code):
            return code, HotSectorAnalyzer.get_stock_concepts(code)

        with ThreadPoolExecutor(max_workers=10) as executor:
            futures = {executor.submit(fetch, c): c for c in codes}
            for future in as_completed(futures):
                code = futures[future]
                try:
                    _, concepts = future.result()
                    results[code] = concepts
                except Exception:
                    results[code] = []

        return results

    # ────────────────────────────────────────
    # 6. 综合流程：一次调用完成全部热门板块分析
    # ────────────────────────────────────────

    def analyze(self, window_days: int = 10, top_n: int = 5,
                min_appearances: int = 3,
                progress_callback=None) -> Dict:
        """
        一站式热门板块分析。

        返回:
            {
                "hot_sectors": [...],  # 热门板块列表
                "date_rankings": {...},  # 每天的排名
                "total_boards": 375,    # 总板块数
                "analyzed_dates": [...], # 分析日期范围
            }
        """
        # Step 1: 获取所有板块名称
        board_names = self.get_all_board_names()
        if not board_names:
            return {"hot_sectors": [], "date_rankings": {}, "total_boards": 0, "analyzed_dates": []}

        # Step 2: 计算日期范围
        today = datetime.now()
        end_date = today.strftime("%Y%m%d")
        start = today - timedelta(days=window_days + 5)  # 多取几天覆盖周末
        start_date = start.strftime("%Y%m%d")

        # Step 3: 顺序获取所有板块数据（避免 py_mini_racer 多线程崩溃）
        logger.info(f"开始顺序获取 {len(board_names)} 个板块数据...")
        self.get_all_boards_index_sequential(board_names, start_date, end_date, progress_callback)

        # Step 4: 计算热门板块
        hot_sectors = self.compute_hot_sectors(
            top_n=top_n, min_appearances=min_appearances, window_days=window_days
        )

        # 获取分析日期
        all_dates = set()
        for df in self._board_index_cache.values():
            if "日期" in df.columns:
                for d in df["日期"].dropna().tolist():
                    all_dates.add(str(d)[:10])

        return {
            "hot_sectors": hot_sectors,
            "total_boards": len(board_names),
            "analyzed_dates": sorted(all_dates),
        }
