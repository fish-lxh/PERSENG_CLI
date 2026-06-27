"""
AKShare 数据源封装
====================
职责: A股实时行情、板块排行、龙虎榜、大宗交易

接口清单:
  - stock_zh_index_daily       → 指数日线
  - stock_board_industry_name_em → 行业板块涨跌幅排行
  - stock_board_concept_name_em  → 概念板块涨跌幅排行
  - stock_zh_a_hist            → 个股日/周K线
  - stock_lhb_detail_em        → 龙虎榜明细
  - stock_dzjy_mrtj            → 大宗交易每日统计
  - stock_board_industry_hist_em → 板块历史日线
"""
import logging
from typing import Optional, List
from datetime import datetime, timedelta

import pandas as pd

logger = logging.getLogger(__name__)


class AKShareSource:
    """
    AKShare 数据源封装
    注意: AKShare 接口可能随版本更新而变化，定期执行 pip install akshare --upgrade
    """

    def __init__(self):
        self._name = "AKShare"
        self._available = False

    # ──────────────────────────────────────────────
    # 基础方法
    # ──────────────────────────────────────────────

    @property
    def name(self) -> str:
        return self._name

    def health_check(self) -> bool:
        """检查 AKShare 是否可用"""
        try:
            import akshare as ak
            # 尝试获取上证指数日线以验证连通性
            df = ak.stock_zh_index_daily(symbol="sh000001")
            self._available = df is not None and len(df) > 0
        except Exception as e:
            logger.warning(f"AKShare 连通性检查失败: {e}")
            self._available = False
        return self._available

    # ──────────────────────────────────────────────
    # Step 1: 市场温度 — 指数数据
    # ──────────────────────────────────────────────

    def get_index_daily(self, index_code: str = "sh000001",
                        start_date: Optional[str] = None,
                        end_date: Optional[str] = None) -> pd.DataFrame:
        """
        获取指数日线数据

        参数:
            index_code: 指数代码 (sh000001=上证, sz399001=深证, sz399006=创业板)
            start_date: 开始日期 YYYYMMDD，默认一年前
            end_date: 结束日期 YYYYMMDD，默认今天

        返回列:
            date, open, close, high, low, volume, amount
        """
        import akshare as ak

        df = ak.stock_zh_index_daily(symbol=index_code)

        # 统一列名
        df.rename(columns={
            "date": "date",
            "open": "open",
            "close": "close",
            "high": "high",
            "low": "low",
            "volume": "volume",
            "amount": "amount",
        }, inplace=True)

        df["date"] = pd.to_datetime(df["date"])

        # 按日期过滤
        if start_date:
            df = df[df["date"] >= pd.Timestamp(start_date)]
        if end_date:
            df = df[df["date"] <= pd.Timestamp(end_date)]

        df.sort_values("date", inplace=True)
        df.reset_index(drop=True, inplace=True)
        return df

    def get_index_weekly(self, index_code: str = "sh000001",
                         start_date: Optional[str] = None,
                         end_date: Optional[str] = None) -> pd.DataFrame:
        """
        获取指数周线数据（通过日线重采样）
        """
        df = self.get_index_daily(index_code, start_date, end_date)
        if df.empty:
            return df

        # 周线重采样: 以周五为周线基准
        weekly = df.resample("W-FRI", on="date").agg({
            "open": "first",
            "close": "last",
            "high": "max",
            "low": "min",
            "volume": "sum",
            "amount": "sum",
        }).dropna()

        weekly.reset_index(inplace=True)
        return weekly

    # ──────────────────────────────────────────────
    # Step 2: 板块扫描
    # ──────────────────────────────────────────────

    def get_sector_ranking(self, top_n: int = 10) -> pd.DataFrame:
        """
        获取行业板块涨跌幅排行

        返回列:
            排名, 板块名称, 板块代码, 涨跌幅, 上涨家数, 下跌家数, 领涨股票

        数据源优先级:
            1. 东方财富 (stock_board_industry_name_em)
            2. 同花顺行业一览 (stock_sector_spot) — 当 EM 不可用时
        """
        import akshare as ak

        # 尝试东方财富接口
        try:
            df = ak.stock_board_industry_name_em()
            if not df.empty:
                df.sort_values("涨跌幅", ascending=False, inplace=True)
                df.reset_index(drop=True, inplace=True)
                top = df.head(top_n).copy()
                return top[[
                    "排名", "板块名称", "板块代码", "最新价",
                    "涨跌幅", "涨跌额", "总市值",
                    "上涨家数", "下跌家数", "领涨股票", "领涨股票-涨跌幅"
                ]]
        except Exception:
            logger.warning("东方财富行业板块接口不可用，切换到同花顺备选")

        # 备选: 同花顺行业板块实时行情 (stock_sector_spot)
        try:
            df = ak.stock_sector_spot()
            if df.empty:
                return pd.DataFrame()

            # 列名: label, 板块, 公司家数, 平均价格, 涨跌额, 涨跌幅,
            #       总成交量, 总成交额, 股票代码, 个股-涨跌幅, 个股-当前价, 个股-涨跌额, 股票名称
            rename_map = {
                "板块": "板块名称",
                "涨跌幅": "涨跌幅",
                "股票名称": "领涨股票",
                "股票代码": "板块代码",
            }
            df.rename(columns={k: v for k, v in rename_map.items() if k in df.columns},
                      inplace=True)

            # 涨跌幅转为百分比数值
            df["涨跌幅"] = pd.to_numeric(df["涨跌幅"], errors="coerce")
            df.sort_values("涨跌幅", ascending=False, inplace=True)
            df.reset_index(drop=True, inplace=True)
            top = df.head(top_n).copy()
            top["排名"] = range(1, len(top) + 1)

            result_cols = ["板块名称", "涨跌幅", "领涨股票", "板块代码"]
            return top[[c for c in result_cols if c in top.columns]]
        except Exception as e:
            logger.error(f"同花顺行业板块接口也失败: {e}")
            return pd.DataFrame()

    def get_concept_sector_ranking(self, top_n: int = 10) -> pd.DataFrame:
        """
        获取概念板块涨跌幅排行

        数据源优先级:
            1. 东方财富 (stock_board_concept_name_em)
            2. 概念板块资金流向排行 (stock_fund_flow_concept) — 当 EM 不可用时
               含300+概念板块，按涨跌幅排序
        """
        import akshare as ak

        # 尝试东方财富接口
        try:
            df = ak.stock_board_concept_name_em()
            if not df.empty:
                df.sort_values("涨跌幅", ascending=False, inplace=True)
                df.reset_index(drop=True, inplace=True)
                top = df.head(top_n).copy()
                return top[[
                    "排名", "板块名称", "板块代码", "最新价",
                    "涨跌幅", "涨跌额", "总市值",
                    "上涨家数", "下跌家数", "领涨股票", "领涨股票-涨跌幅"
                ]]
        except Exception:
            logger.warning("东方财富概念板块接口不可用，切换到概念资金流向备选")

        # 备选: 概念板块资金流向排行（含涨跌幅、领涨股）
        try:
            df = ak.stock_fund_flow_concept()
            if df.empty:
                return pd.DataFrame()

            # 列名: 序号, 行业, 行业指数, 行业-涨跌幅, 流入资金,
            #       流出资金, 净额, 公司家数, 领涨股, 领涨股-涨跌幅, 当前价
            rename_map = {
                "行业": "板块名称",
                "行业-涨跌幅": "涨跌幅",
                "领涨股": "领涨股票",
            }
            df.rename(columns={k: v for k, v in rename_map.items() if k in df.columns},
                      inplace=True)

            # 涨跌幅转数值并排序
            df["涨跌幅"] = pd.to_numeric(df["涨跌幅"], errors="coerce")
            df.sort_values("涨跌幅", ascending=False, inplace=True)
            df.reset_index(drop=True, inplace=True)
            top = df.head(top_n).copy()
            top["排名"] = range(1, len(top) + 1)

            result_cols = ["板块名称", "涨跌幅", "领涨股票"]
            return top[[c for c in result_cols if c in top.columns]]
        except Exception as e:
            logger.error(f"概念板块资金流向排行接口也失败: {e}")
            return pd.DataFrame()

    def get_sector_hist(self, sector_code: str,
                        start_date: Optional[str] = None,
                        end_date: Optional[str] = None) -> pd.DataFrame:
        """
        获取行业板块历史日线数据
        用于板块持续性分析
        """
        import akshare as ak

        df = ak.stock_board_industry_hist_em(symbol=sector_code)
        df["date"] = pd.to_datetime(df["date"])

        if start_date:
            df = df[df["date"] >= pd.Timestamp(start_date)]
        if end_date:
            df = df[df["date"] <= pd.Timestamp(end_date)]

        df.sort_values("date", inplace=True)
        df.reset_index(drop=True, inplace=True)
        return df

    def get_sector_concept_hist(self, sector_code: str,
                                start_date: Optional[str] = None,
                                end_date: Optional[str] = None) -> pd.DataFrame:
        """
        获取概念板块历史日线数据
        用于板块持续性验证（10日内多次热门）

        AKShare 返回中文列名，此处统一转为英文:
          date, open, close, high, low, volume, amount, pctChg

        数据源优先级:
            1. 东方财富 (stock_board_concept_hist_em)
            2. 同花顺概念指数 (stock_board_concept_index_ths) — 当 EM 不可用时
               THS 返回的是单只概念的历史日线，需要按 sector_code 名称过滤
        """
        import akshare as ak

        # 尝试东方财富接口
        try:
            df = ak.stock_board_concept_hist_em(symbol=sector_code)
            if not df.empty:
                return self._normalize_concept_hist(df, start_date, end_date)
        except Exception:
            logger.warning(f"东方财富概念板块历史接口不可用 ({sector_code})，切换到同花顺备选")

        # 备选: 使用行业板块历史数据（THS 行业接口，用代码查询）
        try:
            df = ak.stock_board_industry_hist_em(symbol=sector_code)
            if not df.empty:
                return self._normalize_concept_hist(df, start_date, end_date)
        except Exception:
            logger.warning(f"行业板块历史接口也失败 ({sector_code})")

        # 返回空 DataFrame 让上层降级处理
        logger.info(f"概念板块历史数据不可用 ({sector_code})，跳过持续性验证")
        return pd.DataFrame()

    def _normalize_concept_hist(self, df: pd.DataFrame,
                                start_date: Optional[str] = None,
                                end_date: Optional[str] = None) -> pd.DataFrame:
        """
        统一处理概念/行业板块历史数据列名
        """
        # 统一列名为英文
        rename_map = {
            "日期": "date", "开盘": "open", "收盘": "close",
            "最高": "high", "最低": "low",
            "成交量": "volume", "成交额": "amount",
            "涨跌幅": "pctChg", "涨跌额": "change",
            "振幅": "amplitude", "换手率": "turn",
        }
        df.rename(columns={k: v for k, v in rename_map.items() if k in df.columns},
                  inplace=True)

        if "date" in df.columns:
            df["date"] = pd.to_datetime(df["date"])

        if start_date and "date" in df.columns:
            df = df[df["date"] >= pd.Timestamp(start_date)]
        if end_date and "date" in df.columns:
            df = df[df["date"] <= pd.Timestamp(end_date)]

        if "date" in df.columns:
            df.sort_values("date", inplace=True)
        df.reset_index(drop=True, inplace=True)
        return df

    # ──────────────────────────────────────────────
    # Step 3: 个股K线
    # ──────────────────────────────────────────────

    def get_stock_daily(self, symbol: str,
                        start_date: Optional[str] = None,
                        end_date: Optional[str] = None,
                        adjust: str = "qfq") -> pd.DataFrame:
        """
        获取个股日K线数据

        参数:
            symbol: 股票代码 (如 "000001")
            start_date: 开始日期 YYYYMMDD
            end_date: 结束日期 YYYYMMDD
            adjust: 复权类型 ("qfq"=前复权, "hfq"=后复权, ""=不复权)

        返回列:
            日期, 开盘, 收盘, 最高, 最低, 成交量, 成交额, 振幅, 涨跌幅, 涨跌额, 换手率
        """
        import akshare as ak

        start = start_date or (datetime.now() - timedelta(days=365)).strftime("%Y%m%d")
        end = end_date or datetime.now().strftime("%Y%m%d")

        df = ak.stock_zh_a_hist(
            symbol=symbol,
            period="daily",
            start_date=start,
            end_date=end,
            adjust=adjust,
        )
        if df.empty:
            return df

        df["日期"] = pd.to_datetime(df["日期"])
        df.sort_values("日期", inplace=True)
        df.reset_index(drop=True, inplace=True)
        return df

    def get_stock_weekly(self, symbol: str,
                         start_date: Optional[str] = None,
                         end_date: Optional[str] = None,
                         adjust: str = "qfq") -> pd.DataFrame:
        """
        获取个股周K线数据
        直接使用 AKShare 的 period="weekly" 参数
        """
        import akshare as ak

        start = start_date or (datetime.now() - timedelta(days=365)).strftime("%Y%m%d")
        end = end_date or datetime.now().strftime("%Y%m%d")

        df = ak.stock_zh_a_hist(
            symbol=symbol,
            period="weekly",
            start_date=start,
            end_date=end,
            adjust=adjust,
        )
        if df.empty:
            return df

        df["日期"] = pd.to_datetime(df["日期"])
        df.sort_values("日期", inplace=True)
        df.reset_index(drop=True, inplace=True)
        return df

    # ──────────────────────────────────────────────
    # Step 4: 排雷 — 龙虎榜 + 大宗交易
    # ──────────────────────────────────────────────

    def get_longhu_detail(self, trade_date: str) -> pd.DataFrame:
        """
        获取龙虎榜明细

        参数:
            trade_date: 交易日期 YYYYMMDD

        返回列:
            股票代码, 股票名称, 买入额, 卖出额, 净额, 机构专用等
        """
        import akshare as ak

        try:
            df = ak.stock_lhb_detail_em(symbol=trade_date)
            return df
        except Exception as e:
            logger.warning(f"获取龙虎榜数据失败 ({trade_date}): {e}")
            return pd.DataFrame()

    def get_block_trade(self, start_date: str, end_date: str) -> pd.DataFrame:
        """
        获取大宗交易每日统计

        注意: AKShare 接口名为 stock_dzjy_mrtj（非 stock_block_trade_em）

        返回列:
            股票代码, 股票名称, 成交价, 成交量, 成交额, 折溢率, 收盘价, 涨跌幅等
        """
        import akshare as ak

        try:
            df = ak.stock_dzjy_mrtj(start_date=start_date, end_date=end_date)
            return df
        except Exception as e:
            logger.warning(f"获取大宗交易数据失败 ({start_date}~{end_date}): {e}")
            return pd.DataFrame()

    # ──────────────────────────────────────────────
    # 工具方法
    # ──────────────────────────────────────────────

    @staticmethod
    def get_all_stock_codes() -> pd.DataFrame:
        """
        获取沪深京 A 股所有股票代码和名称
        用于全市场扫描
        """
        import akshare as ak

        df = ak.stock_zh_a_spot_em()
        return df[["代码", "名称", "最新价", "涨跌幅", "换手率"]]
