"""
回测执行引擎
============
点回溯（Point-in-Time）滑动窗口回测。

工作流程:
  1. 获取股票池（按市值分层抽样）
  2. 对每只股票预加载全量日线数据
  3. 逐日滑动窗口：取到当日为止的数据切片 → 传入检测函数
  4. 命中 → 记录信号 + 追踪N日后收益
  5. 统计各模式胜率/收益率
"""
import json
import os
import logging
from typing import List, Dict, Optional, Tuple
from datetime import datetime, timedelta
from concurrent.futures import ProcessPoolExecutor, as_completed

import pandas as pd
import numpy as np

from .backtest_config import BacktestConfig
from .detectors import detect_all

logger = logging.getLogger(__name__)


class BacktestEngine:
    """回测执行引擎"""

    def __init__(self, config: BacktestConfig):
        self.config = config
        self.results: List[Dict] = []
        self._daily_phases: Dict[str, str] = {}  # date -> phase

    # ──────────────────────────────────────────────
    # 公开入口
    # ──────────────────────────────────────────────

    def run(self) -> List[Dict]:
        """执行完整回测"""
        logger.info("=" * 50)
        logger.info("回测引擎启动")
        logger.info(f"  期间: {self.config.start_date} ~ {self.config.end_date}")
        logger.info(f"  股票池: {self.config.max_stocks} 只")
        logger.info(f"  模式: {', '.join(self.config.patterns_to_test)}")
        logger.info("=" * 50)

        # 1. 获取股票池
        stocks = self._get_stock_universe()
        logger.info(f"获取到 {len(stocks)} 只候选股票")

        # 2. 预加载市场阶段数据（只一次，避免反复login/logout）
        self._preload_phase_data()

        # 2. 如有存档则恢复
        existing_results, processed_codes = self._try_resume()
        self.results = existing_results

        # 3. 遍历每只股票
        total = len(stocks)
        for idx, (code, name) in enumerate(stocks):
            if code in processed_codes:
                continue

            try:
                self._process_stock(code, name)
            except Exception as e:
                logger.warning(f"回测异常 {code} {name}: {e}")

            if (idx + 1) % 50 == 0:
                logger.info(f"进度: {idx+1}/{total} ({((idx+1)/total*100):.0f}%)")
                self._save_intermediate()

        # 4. 最终保存
        self._save_final()
        logger.info(f"回测完成！共产生 {len(self.results)} 个信号")
        return self.results

    def run_parallel(self, workers: int = 4) -> List[Dict]:
        """多进程并行回测"""
        logger.info("=" * 50)
        logger.info("回测引擎启动 (并行模式)")
        logger.info(f"  进程数: {workers}")
        logger.info(f"  期间: {self.config.start_date} ~ {self.config.end_date}")
        logger.info(f"  股票池: {self.config.max_stocks} 只")
        logger.info("=" * 50)

        stocks = self._get_stock_universe()
        logger.info(f"获取到 {len(stocks)} 只候选股票")

        # 单进程模式小规模就用单进程
        if len(stocks) <= 100:
            return self.run()

        # 分批
        chunk_size = max(1, len(stocks) // workers)
        chunks = [stocks[i:i + chunk_size] for i in range(0, len(stocks), chunk_size)]
        all_results = []

        with ProcessPoolExecutor(max_workers=workers) as executor:
            futures = {
                executor.submit(self._process_batch, chunk): i
                for i, chunk in enumerate(chunks)
            }
            for future in as_completed(futures):
                try:
                    batch_results = future.result()
                    all_results.extend(batch_results)
                    logger.info(f"批次 {futures[future]} 完成: {len(batch_results)} 信号")
                except Exception as e:
                    logger.warning(f"批次执行异常: {e}")

        self.results = all_results
        self._save_final()
        logger.info(f"回测完成！共产生 {len(self.results)} 个信号")
        return self.results

    # ──────────────────────────────────────────────
    # 单只股票处理
    # ──────────────────────────────────────────────

    def _process_stock(self, code: str, name: str):
        """处理单只股票"""
        df = self._load_stock_data(code)
        if df is None or len(df) < 250:
            return

        closes = df["close"].tolist()
        volumes = df["volume"].tolist() if "volume" in df.columns else None
        highs = df["high"].tolist() if "high" in df.columns else None
        lows = df["low"].tolist() if "low" in df.columns else None
        opens = df["open"].tolist() if "open" in df.columns else None
        pct_chg = df["pctChg"].tolist() if "pctChg" in df.columns else None
        dates = df["date"].tolist() if "date" in df.columns else None

        # 滑动窗口检测（从第250天开始，确保有足够数据）
        for i in range(250, len(closes)):
            if dates and not self._is_in_date_range(str(dates[i])):
                continue

            # 春阶段过滤
            if self.config.only_spring:
                date_str = str(dates[i]) if dates else ""
                phase = self._get_market_phase(date_str)
                if phase not in ("冬末春初", "春"):
                    continue

            # 股价过滤
            if closes[i] < self.config.min_price:
                continue

            # 取到i为止的数据切片
            slice_closes = closes[:i + 1]
            slice_volumes = volumes[:i + 1] if volumes else None
            slice_highs = highs[:i + 1] if highs else None
            slice_lows = lows[:i + 1] if lows else None
            slice_opens = opens[:i + 1] if opens else None
            slice_pct = pct_chg[:i + 1] if pct_chg else None

            # 检测所有模式（按优先级）
            match = detect_all(
                slice_closes, slice_volumes,
                slice_highs, slice_lows, slice_opens, slice_pct,
                patterns=self.config.patterns_to_test,
            )
            if match:
                record = self._record_signal(
                    code, name, dates[i] if dates else "",
                    df, i, match
                )
                self.results.append(record)
                break  # 同实盘：每只股票只取第一个信号

    @staticmethod
    def _process_batch(stocks: List[Tuple[str, str]]) -> List[Dict]:
        """批量处理（用于多进程）"""
        # 每个进程独立初始化 BaoStock
        import baostock as bs
        lg = bs.login()
        if lg.error_code != "0":
            return []

        results = []
        cfg = BacktestConfig()
        try:
            for code, name in stocks:
                try:
                    df = BacktestEngine._load_stock_data(code)
                    if df is None or len(df) < 250:
                        continue

                    closes = df["close"].tolist()
                    volumes = df["volume"].tolist() if "volume" in df.columns else None
                    highs = df["high"].tolist() if "high" in df.columns else None
                    lows = df["low"].tolist() if "low" in df.columns else None
                    opens = df["open"].tolist() if "open" in df.columns else None
                    pct_chg = df["pctChg"].tolist() if "pctChg" in df.columns else None
                    dates = df["date"].tolist() if "date" in df.columns else None

                    for i in range(250, len(closes)):
                        if dates:
                            date_str = str(dates[i])
                            if date_str < cfg.start_date or date_str > cfg.end_date:
                                continue
                        if closes[i] < cfg.min_price:
                            continue

                        match = detect_all(
                            closes[:i + 1],
                            volumes[:i + 1] if volumes else None,
                            highs[:i + 1] if highs else None,
                            lows[:i + 1] if lows else None,
                            opens[:i + 1] if opens else None,
                            pct_chg[:i + 1] if pct_chg else None,
                            patterns=cfg.patterns_to_test,
                        )
                        if match:
                            record = BacktestEngine._record_signal(
                                code, name, str(dates[i]) if dates else "",
                                df, i, match
                            )
                            results.append(record)
                            break
                except Exception:
                    continue
        finally:
            bs.logout()
        return results

    # ──────────────────────────────────────────────
    # 信号记录
    # ──────────────────────────────────────────────

    @staticmethod
    def _record_signal(
        code: str, name: str, date_str: str,
        df: pd.DataFrame, idx: int, match: Dict
    ) -> Dict:
        """记录信号及后续N日收益"""
        record = {
            "date": date_str,
            "code": code,
            "name": name,
            "pattern": match.get("pattern_type", ""),
            "confidence": match.get("confidence", ""),
            "price": float(df.iloc[idx]["close"]),
            "description": match.get("description", ""),
        }

        # 计算后续N日收益
        closes = df["close"].values
        for period in (3, 5, 10, 20):
            future_idx = idx + period
            if future_idx < len(closes):
                future_return = (float(closes[future_idx]) / float(closes[idx]) - 1) * 100
            else:
                future_return = None
            record[f"forward_{period}d"] = future_return

        # 市场阶段（使用当天日期判断）
        # 在并行模式下这是一个简化版本
        record["market_phase"] = ""

        return record

    # ──────────────────────────────────────────────
    # 数据加载
    # ──────────────────────────────────────────────

    def _get_stock_universe(self) -> List[Tuple[str, str]]:
        """获取股票池（支持按板块筛选或按市值分层抽样）"""
        # ── 模式1：指定概念板块 ──
        if self.config.sector_name:
            return self._get_sector_stocks(self.config.sector_name, board_type="concept")
        # ── 模式2：指定行业板块 ──
        if self.config.industry_name:
            return self._get_sector_stocks(self.config.industry_name, board_type="industry")

        # ── 模式3：全市场分层抽样（默认） ──
        all_stocks = self._get_all_stocks()
        if not all_stocks:
            logger.warning("无法获取股票列表")
            return []

        # 过滤 ST、北交所、退市
        valid = []
        for c, n in all_stocks:
            if c.startswith("8") or c.startswith("4"):
                continue
            if "ST" in n or "*ST" in n or "退" in n:
                continue
            valid.append((c, n))

        max_n = min(self.config.max_stocks, len(valid))
        try:
            import akshare as ak
            hs300 = ak.index_stock_cons(symbol="000300")
            zz500 = ak.index_stock_cons(symbol="000905")
            priority_codes = set()
            for code_list in [hs300, zz500]:
                if "成分券代码" in code_list.columns:
                    priority_codes.update(code_list["成分券代码"].tolist())
                elif "品种代码" in code_list.columns:
                    priority_codes.update(code_list["品种代码"].tolist())
            priority_stocks = [(c, n) for c, n in valid if c in priority_codes]
            remaining = [(c, n) for c, n in valid if c not in priority_codes]
            result = priority_stocks[:max_n]
            if len(result) < max_n:
                need = max_n - len(result)
                result.extend(remaining[:need])
            return result[:max_n]
        except Exception:
            return valid[:max_n]

    @staticmethod
    def _get_all_stocks() -> List[Tuple[str, str]]:
        """获取全市场A股列表（BaoStock + AKShare双重备份）"""
        import baostock as bs

        # ── 方案1: BaoStock ──
        try:
            lg = bs.login()
            if lg.error_code == "0":
                try:
                    # BaoStock 要求具体交易日，不能用 None 或空字符串
                    # 试试2026-05-15(周五)或2024-01-02等已知交易日
                    for test_date in ["2026-05-15", "2026-05-14", "2026-05-13",
                                      "2026-05-08", "2026-04-30",
                                      "2025-12-31", "2025-06-30",
                                      "2024-12-31", "2024-06-28",
                                      "2024-01-02"]:
                        rs = bs.query_all_stock(day=test_date)
                        rows = []
                        while (rs.error_code == "0") and rs.next():
                            rows.append(rs.get_row_data())
                        if rows:
                            break

                    if not rows:
                        logger.warning("BaoStock query_all_stock 在所有日期均返回空")
                        return []

                    stocks = []
                    for row in rows:
                        raw_code = str(row[0])  # "sh.600519" or "sz.000001"
                        name = str(row[2])
                        trade_status = str(row[1]) if len(row) > 1 else "1"

                        # 跳过指数
                        if raw_code.startswith("sh.000") or raw_code.startswith("sz.39"):
                            continue
                        # 跳过非正常交易
                        if trade_status != "1":
                            continue
                        # 提取纯数字代码
                        code = raw_code.split(".")[-1]
                        stocks.append((code, name))

                    if stocks:
                        logger.info(f"BaoStock获取到 {len(stocks)} 只A股")
                        return stocks
                finally:
                    bs.logout()
        except Exception as e:
            logger.debug(f"BaoStock获取股票列表失败: {e}")
            try:
                bs.logout()
            except Exception:
                pass

        # ── 方案2: AKShare 东方财富实时行情（可能被屏蔽） ──
        try:
            import akshare as ak
            spot = ak.stock_zh_a_spot_em()
            if not spot.empty and "代码" in spot.columns and "名称" in spot.columns:
                stocks = []
                for _, row in spot.iterrows():
                    code = str(row["代码"])
                    name = str(row["名称"])
                    stocks.append((code, name))
                if stocks:
                    return stocks
        except Exception:
            pass

        logger.warning("所有数据源均无法获取股票列表")
        return []

    def _get_sector_stocks(self, sector_name: str, board_type: str = "concept") -> List[Tuple[str, str]]:
        """获取指定板块的全部成分股

        数据源优先级: 东方财富EM → 同花顺THS(网页抓取)
        """
        import time

        # ── 方案1: 东方财富 API (速度快，但部分环境不可用) ──
        stocks = self._get_sector_stocks_em(sector_name, board_type)
        if stocks:
            return stocks

        # ── 方案2: 同花顺 THS 网页抓取 (备选，需要 bs4) ──
        logger.info("东方财富API不可用，切换到同花顺THS网页抓取")
        return self._get_sector_stocks_ths(sector_name, board_type)

    def _get_sector_stocks_em(self, sector_name: str, board_type: str) -> List[Tuple[str, str]]:
        """通过东方财富API获取板块成分股"""
        import akshare as ak
        import time

        for attempt in range(3):
            try:
                if board_type == "concept":
                    board_df = ak.stock_board_concept_name_em()
                else:
                    board_df = ak.stock_board_industry_name_em()
                break
            except Exception as e:
                logger.warning(f"EM板块列表失败 (第{attempt+1}次): {e}")
                if attempt < 2:
                    time.sleep(2)
                else:
                    return []

        if board_df.empty:
            return []

        match = board_df[board_df["板块名称"].str.contains(sector_name, na=False)]
        if match.empty:
            return []
        board_code = match.iloc[0]["板块代码"]
        board_name = match.iloc[0]["板块名称"]
        logger.info(f"EM匹配到板块: {board_name} ({board_code})")

        for attempt in range(3):
            try:
                if board_type == "concept":
                    cons = ak.stock_board_concept_cons_em(symbol=board_code)
                else:
                    cons = ak.stock_board_industry_cons_em(symbol=board_code)
                break
            except Exception as e:
                logger.warning(f"EM成分股失败 (第{attempt+1}次): {e}")
                if attempt < 2:
                    time.sleep(2)
                else:
                    return []

        if cons.empty:
            return []
        return self._filter_stocks(cons)

    def _get_sector_stocks_ths(self, sector_name: str, board_type: str) -> List[Tuple[str, str]]:
        """通过同花顺 THS 网页抓取获取板块成分股"""
        import akshare as ak
        import requests
        from bs4 import BeautifulSoup

        try:
            # 1. 获取板块名称 → THS代码映射
            if board_type == "concept":
                board_df = ak.stock_board_concept_name_ths()
            else:
                board_df = ak.stock_board_industry_name_ths()

            if board_df.empty:
                logger.warning("THS无法获取板块列表")
                return []

            # THS概念表: columns=['name', 'code']
            match = board_df[board_df["name"].str.contains(sector_name, na=False)]
            if match.empty:
                logger.warning(f"THS未找到板块 '{sector_name}'，请检查名称")
                return []

            board_code = str(match.iloc[0]["code"])
            board_name = str(match.iloc[0]["name"])
            logger.info(f"THS匹配到板块: {board_name} (代码={board_code})")

            # 2. 翻页抓取成分股
            headers = {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            }
            all_stocks = []

            for page in range(1, 200):  # 最多200页(2000只)
                url = f"http://q.10jqka.com.cn/gn/detail/code/{board_code}/page/{page}/"
                if board_type == "industry":
                    url = f"http://q.10jqka.com.cn/hy/detail/code/{board_code}/page/{page}/"

                try:
                    r = requests.get(url, headers=headers, timeout=10)
                    soup = BeautifulSoup(r.text, "html.parser")
                    tables = soup.find_all("table")
                    if len(tables) < 2:
                        break
                    rows = tables[1].find_all("tr")
                    if len(rows) <= 1:
                        break

                    page_stocks = []
                    for row in rows[1:]:
                        cells = row.find_all("td")
                        if len(cells) >= 4:
                            code = cells[1].get_text(strip=True)
                            name = cells[2].get_text(strip=True)
                            if code and name:
                                if code.startswith("8") or code.startswith("4"):
                                    continue
                                if "ST" in name or "*ST" in name or "退" in name:
                                    continue
                                page_stocks.append((code, name))

                    if not page_stocks:
                        break

                    all_stocks.extend(page_stocks)
                    logger.debug(f"THS第{page}页: {len(page_stocks)} 只")

                    # 如果不足10只说明是最后一页
                    if len(rows) < 11:
                        break

                except Exception as e:
                    logger.warning(f"THS第{page}页抓取失败: {e}")
                    break

            # 3. 去重（按code去重）
            seen = set()
            unique_stocks = []
            for code, name in all_stocks:
                if code not in seen:
                    seen.add(code)
                    unique_stocks.append((code, name))

            max_n = min(self.config.max_stocks, len(unique_stocks))
            stocks = unique_stocks[:max_n]
            logger.info(f"THS板块 '{board_name}' 共 {len(all_stocks)} 只(去重{len(unique_stocks)}只)，"
                        f"过滤后 {len(stocks)} 只可用")
            return stocks

        except Exception as e:
            logger.error(f"THS抓取板块成分股失败 '{sector_name}': {e}")
            return []

    @staticmethod
    def _filter_stocks(df) -> List[Tuple[str, str]]:
        """从DataFrame中提取并过滤股票代码/名称"""
        stocks = []
        code_col = "代码" if "代码" in df.columns else "code"
        name_col = "名称" if "名称" in df.columns else "name"
        for _, row in df.iterrows():
            code = str(row.get(code_col, ""))
            name = str(row.get(name_col, ""))
            if code and name:
                if code.startswith("8") or code.startswith("4"):
                    continue
                if "ST" in name or "*ST" in name or "退" in name:
                    continue
                stocks.append((code, name))
        return stocks

    @staticmethod
    def _load_stock_data(code: str) -> Optional[pd.DataFrame]:
        """预加载个股日线数据"""
        import baostock as bs
        try:
            lg = bs.login()
            if lg.error_code != "0":
                logger.debug(f"BaoStock登录失败 {code}: {lg.error_msg}")
                return None

            start = "2018-01-01"
            if code.startswith("6"):
                bs_code = f"sh.{code}"
            else:
                bs_code = f"sz.{code}"

            rs = bs.query_history_k_data_plus(
                bs_code,
                "date,open,close,high,low,volume,amount,pctChg",
                frequency="d", adjustflag="2",
                start_date=start, end_date=datetime.now().strftime("%Y-%m-%d"),
            )
            rows = []
            while (rs.error_code == "0") and rs.next():
                row = rs.get_row_data()
                if row[2] and float(row[2]) > 0:
                    rows.append(row)

            if not rows:
                return None

            df = pd.DataFrame(rows, columns=[
                "date", "open", "close", "high", "low",
                "volume", "amount", "pctChg",
            ])
            for col in ["open", "close", "high", "low", "volume", "amount", "pctChg"]:
                df[col] = pd.to_numeric(df[col], errors="coerce")
            df = df.sort_values("date").reset_index(drop=True)
            return df
        except Exception as e:
            logger.debug(f"加载数据失败 {code}: {e}")
            return None
        finally:
            bs.logout()

    # ──────────────────────────────────────────────
    # 市场阶段（预加载指数数据，一次性判定）
    # ──────────────────────────────────────────────

    def _preload_phase_data(self):
        """预加载指数周线数据（只调用一次）"""
        import baostock as bs
        try:
            lg = bs.login()
            if lg.error_code != "0":
                return
            try:
                rs = bs.query_history_k_data_plus(
                    "sh.000001",
                    "date,close,pctChg",
                    frequency="w", adjustflag="2",
                    start_date="2018-01-01",
                    end_date=self.config.end_date,
                )
                closes = []
                pcts = []
                dates = []
                while (rs.error_code == "0") and rs.next():
                    row = rs.get_row_data()
                    if row[0] and row[1] and float(row[1]) > 0:
                        dates.append(row[0])
                        closes.append(float(row[1]))
                        pcts.append(float(row[2]) if row[2] else 0)

                self._index_weekly = {
                    "dates": dates,
                    "closes": closes,
                    "pcts": pcts,
                }
                logger.debug(f"预加载指数周线: {len(dates)} 条")
            finally:
                bs.logout()
        except Exception as e:
            logger.debug(f"预加载指数数据失败: {e}")

    def _is_in_date_range(self, date_str: str) -> bool:
        """检查日期是否在回测范围内"""
        if not date_str:
            return False
        return self.config.start_date <= date_str <= self.config.end_date

    def _get_market_phase(self, date_str: str) -> str:
        """获取某个日期的市场阶段（基于预加载的指数数据）"""
        if not date_str:
            return ""
        if date_str in self._daily_phases:
            return self._daily_phases[date_str]

        phase = self._estimate_phase(date_str)
        self._daily_phases[date_str] = phase
        return phase

    def _estimate_phase(self, date_str: str) -> str:
        """基于预加载的指数周线估算市场阶段"""
        try:
            wk = getattr(self, "_index_weekly", None)
            if not wk or not wk["dates"]:
                return "春"

            end_date = date_str[:10] if len(date_str) > 10 else date_str

            # 找到截止日期的最近10周数据
            closes = []
            pcts = []
            for d, c, p in zip(wk["dates"], wk["closes"], wk["pcts"]):
                if d <= end_date:
                    closes.append(c)
                    pcts.append(p)
                if len(closes) >= 10:
                    break
            closes = closes[-10:]  # 最多取最近10周
            pcts = pcts[-10:]

            if len(closes) < 8:
                return "春"

            ma5 = np.mean(closes[-5:])
            ma10 = np.mean(closes)
            above_ma5 = closes[-1] > ma5
            macd_bull = ma5 > ma10
            positive_weeks = sum(1 for p in pcts if p > 0)

            # 春阶段：均线多头 + 过半周涨幅为正
            if macd_bull and above_ma5 and positive_weeks >= 4:
                return "春"
            # 冬末春初：均线接近金叉 + 近几周有反弹
            if above_ma5 and positive_weeks >= 3:
                return "冬末春初"
            return "冬"
        except Exception:
            return "春"

    # ──────────────────────────────────────────────
    # 持久化
    # ──────────────────────────────────────────────

    def _save_intermediate(self):
        """保存中间结果"""
        os.makedirs(self.config.output_dir, exist_ok=True)
        path = os.path.join(self.config.output_dir, "signals_intermediate.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(self.results, f, ensure_ascii=False, indent=2)

    def _save_final(self):
        """保存最终结果（JSON + CSV）"""
        os.makedirs(self.config.output_dir, exist_ok=True)

        # JSON
        json_path = os.path.join(self.config.output_dir, "signals_all.json")
        with open(json_path, "w", encoding="utf-8") as f:
            json.dump(self.results, f, ensure_ascii=False, indent=2)
        logger.info(f"信号数据已保存: {json_path} ({len(self.results)} 条)")

        # CSV
        if self.results:
            csv_path = os.path.join(self.config.output_dir, "signals_all.csv")
            df = pd.DataFrame(self.results)
            df.to_csv(csv_path, index=False, encoding="utf-8-sig")
            logger.info(f"CSV 已保存: {csv_path}")

    def _try_resume(self) -> Tuple[List[Dict], set]:
        """尝试从中间结果恢复"""
        path = os.path.join(self.config.output_dir, "signals_intermediate.json")
        if not self.config.resume or not os.path.exists(path):
            return [], set()

        try:
            with open(path, "r", encoding="utf-8") as f:
                results = json.load(f)
            processed = set(r["code"] for r in results)
            logger.info(f"从中间结果恢复: {len(results)} 条已有信号, {len(processed)} 只已处理")
            return results, processed
        except Exception as e:
            logger.warning(f"恢复失败: {e}")
            return [], set()
