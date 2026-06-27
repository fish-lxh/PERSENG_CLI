"""
BaoStock 数据源封装
=====================
职责: A股历史K线、财务数据、业绩预告、ST状态、行业分类

核心优势:
  - 直接支持周K线 (frequency="w")
  - 财务数据体系完整（利润表、资产负债表、成长能力）
  - 业绩预告/快报
  - isST 字段直接可用
  - 数据可追溯到 1990 年

使用方式:
  with BaoStockSource() as bs:
      df = bs.get_index_weekly("sh.000001")
"""
import logging
from typing import Optional, Tuple
from datetime import datetime, timedelta

import pandas as pd

logger = logging.getLogger(__name__)

# 常见指数代码映射
INDEX_CODE_MAP = {
    "sh000001": "sh.000001",   # 上证指数
    "sh000300": "sh.000300",   # 沪深300
    "sh000852": "sh.000852",   # 中证1000
    "sh000688": "sh.000688",   # 科创50
    "sz399001": "sz.399001",   # 深证成指
    "sz399006": "sz.399006",   # 创业板指
    "sz399005": "sz.399005",   # 中小板指
}


def _to_baostock_code(symbol: str) -> str:
    """将通用代码转为 BaoStock 格式

    例:
      "000001"  → "sz.000001"
      "600519"  → "sh.600519"
      "sh000001" → "sh.000001"
    """
    if symbol.startswith("sh.") or symbol.startswith("sz."):
        return symbol
    if symbol.startswith("sh") or symbol.startswith("sz"):
        # "sh000001" → "sh.000001"
        return symbol[:2] + "." + symbol[2:]
    # 个股: 60xx → sh, 00xx/30xx → sz
    if symbol.startswith("6"):
        return f"sh.{symbol}"
    return f"sz.{symbol}"


class BaoStockSource:
    """
    BaoStock 数据源封装

    使用 with 语句自动管理连接生命周期:
        with BaoStockSource() as bs:
            data = bs.get_index_weekly("sh.000001")
    """

    def __init__(self):
        self._name = "BaoStock"
        self._connected = False

    # ──────────────────────────────────────────────
    # 生命周期管理
    # ──────────────────────────────────────────────

    @property
    def name(self) -> str:
        return self._name

    def __enter__(self):
        self.login()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        self.logout()

    def login(self) -> bool:
        """登录 BaoStock"""
        import baostock as bs

        if self._connected:
            return True

        # 强制登出清理残存连接
        try:
            bs.logout()
        except Exception:
            pass

        try:
            lg = bs.login()
            self._connected = lg.error_code == "0"
            if not self._connected:
                logger.error(f"BaoStock 登录失败: {lg.error_msg}")
            return self._connected
        except Exception as e:
            logger.error(f"BaoStock 连接异常: {e}")
            self._connected = False
            return False

    def logout(self):
        """登出 BaoStock"""
        import baostock as bs

        if self._connected:
            try:
                bs.logout()
            except Exception:
                pass
            self._connected = False

    def reconnect(self):
        """强制重连（用于长连接断线恢复）"""
        self._connected = False
        return self.login()

    def health_check(self) -> bool:
        """检查 BaoStock 是否可用"""
        if not self._connected:
            self.login()
        return self._connected

    # ──────────────────────────────────────────────
    # K线数据
    # ──────────────────────────────────────────────

    def get_kline(self, symbol: str, frequency: str = "d",
                  start_date: str = "",
                  end_date: str = "",
                  adjust: str = "2") -> pd.DataFrame:
        """
        通用K线查询（带断线自动重连）

        参数:
            symbol:   股票/指数代码 ("sh.000001" 或 "000001" 均可)
            frequency: 周期 ("d"=日, "w"=周, "m"=月, "5"/"15"/"30"/"60"=分钟)
            start_date: 开始日期 YYYY-MM-DD，默认一年前
            end_date:   结束日期 YYYY-MM-DD，默认今天
            adjust: 复权方式 ("1"=后复权, "2"=前复权, "3"=不复权)

        返回列:
            date, code, open, high, low, close, volume, amount,
            adjustflag, turn, pctChg, peTTM, pbMRQ, isST
        """
        import baostock as bs

        code = _to_baostock_code(symbol)

        if not start_date:
            start_date = (datetime.now() - timedelta(days=365)).strftime("%Y-%m-%d")
        if not end_date:
            end_date = datetime.now().strftime("%Y-%m-%d")

        # 指数 vs 个股：指数没有 peTTM/pbMRQ/turn/isST 等字段
        _is_index = code.startswith("sh.000") or code.startswith("sz.39")
        if _is_index:
            fields = "date,code,open,high,low,close,volume,amount,pctChg"
        else:
            fields = "date,code,open,high,low,close,volume,amount,adjustflag,turn,pctChg,peTTM,pbMRQ,isST"

        for attempt in range(2):  # 最多重试1次
            try:
                rs = bs.query_history_k_data_plus(
                    code,
                    fields,
                    start_date=start_date,
                    end_date=end_date,
                    frequency=frequency,
                    adjustflag=adjust,
                )

                rows = []
                while (rs.error_code == "0") and rs.next():
                    rows.append(rs.get_row_data())
                break  # 成功则跳出重试循环
            except OSError as e:
                if attempt == 0 and ("10038" in str(e) or "10053" in str(e) or "10054" in str(e)):
                    logger.debug(f"BaoStock 连接断开({e})，正在重连...")
                    self.reconnect()
                    continue
                logger.debug(f"BaoStock K线查询失败({e})")
                return pd.DataFrame()
            except Exception as e:
                logger.debug(f"BaoStock K线查询异常: {e}")
                return pd.DataFrame()

        if not rows:
            return pd.DataFrame()

        df = pd.DataFrame(rows, columns=rs.fields)

        # 类型转换（仅转换实际存在的列）
        numeric_cols = ["open", "high", "low", "close", "volume", "amount",
                        "turn", "pctChg", "peTTM", "pbMRQ"]
        for col in numeric_cols:
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors="coerce")

        df["date"] = pd.to_datetime(df["date"])
        df.sort_values("date", inplace=True)
        df.reset_index(drop=True, inplace=True)
        return df

    def get_index_weekly(self, index_code: str = "sh000001",
                         start_date: str = "",
                         end_date: str = "") -> pd.DataFrame:
        """
        获取指数周K线（BaoStock 直接支持 frequency="w"）

        这是 Swing-Trader Step 1 的核心数据来源
        """
        return self.get_kline(index_code, frequency="w", start_date=start_date, end_date=end_date)

    def get_index_daily(self, index_code: str = "sh000001",
                        start_date: str = "",
                        end_date: str = "") -> pd.DataFrame:
        """获取指数日K线"""
        return self.get_kline(index_code, frequency="d", start_date=start_date, end_date=end_date)

    def get_stock_daily(self, symbol: str,
                        start_date: str = "",
                        end_date: str = "",
                        adjust: str = "2") -> pd.DataFrame:
        """获取个股日K线"""
        return self.get_kline(symbol, frequency="d", start_date=start_date, end_date=end_date, adjust=adjust)

    def get_stock_weekly(self, symbol: str,
                         start_date: str = "",
                         end_date: str = "",
                         adjust: str = "2") -> pd.DataFrame:
        """获取个股周K线"""
        return self.get_kline(symbol, frequency="w", start_date=start_date, end_date=end_date, adjust=adjust)

    # ──────────────────────────────────────────────
    # Step 4 排雷引擎 — 财务数据
    # ──────────────────────────────────────────────

    def get_profit_data(self, symbol: str, year: int, quarter: int) -> pd.DataFrame:
        """
        获取盈利能力数据

        参数:
            symbol: 股票代码
            year: 年份 (如 2024)
            quarter: 季度 (1, 2, 3, 4)

        返回列:
             code, pubDate, statDate, ROE, 净利率, 毛利率, 净利润, 每股收益
        """
        import baostock as bs

        code = _to_baostock_code(symbol)
        rs = bs.query_profit_data(code=code, year=year, quarter=quarter)

        rows = []
        while (rs.error_code == "0") and rs.next():
            rows.append(rs.get_row_data())
        if not rows:
            return pd.DataFrame()
        return pd.DataFrame(rows, columns=rs.fields)

    def get_growth_data(self, symbol: str, year: int, quarter: int) -> pd.DataFrame:
        """
        获取成长能力数据 — 排雷核心!

        返回列包含:
            YOYEquity, YOYAsset, YOYNI (净利润同比增长率),
            YOYRevenue (营业收入同比增长率), YOYNetProfit

        用途:
            - YOYNI < -50%              → 致命雷（净利润同比下滑超50%）
            - YOYRevenue < -30% 连续2季 → 警告（营收连续下滑）
            - YOYNetProfit < -50%       → 致命雷
        """
        import baostock as bs

        code = _to_baostock_code(symbol)
        rs = bs.query_growth_data(code=code, year=year, quarter=quarter)

        rows = []
        while (rs.error_code == "0") and rs.next():
            rows.append(rs.get_row_data())
        if not rows:
            return pd.DataFrame()
        return pd.DataFrame(rows, columns=rs.fields)

    def get_balance_data(self, symbol: str, year: int, quarter: int) -> pd.DataFrame:
        """
        获取偿债能力数据 — 含商誉占比判断

        返回列包含:
            currentRatio, quickRatio, assetLiabilityRatio,
            goodwillRatio (商誉/净资产), etc.

        用途:
            - goodwillRatio > 30% → 警告（商誉占净资产比超30%）
        """
        import baostock as bs

        code = _to_baostock_code(symbol)
        rs = bs.query_balance_data(code=code, year=year, quarter=quarter)

        rows = []
        while (rs.error_code == "0") and rs.next():
            rows.append(rs.get_row_data())
        if not rows:
            return pd.DataFrame()
        return pd.DataFrame(rows, columns=rs.fields)

    def get_cash_flow_data(self, symbol: str, year: int, quarter: int) -> pd.DataFrame:
        """
        获取现金流量数据 — 晓胜三指标之现金流

        BaoStock 返回列（按年/季汇总）:
            code, pubDate, statDate, category,
            operatingNetCashFlow (经营活动产生的现金流量净额),
            investNetCashFlow, financeNetCashFlow,
            netCashFlow (现金净增加额), etc.

        用途:
            - operatingNetCashFlow / netProfit > 1 → 利润质量高
            - 连续多季经营现金流为正 → 公司造血能力强
        """
        import baostock as bs

        code = _to_baostock_code(symbol)
        rs = bs.query_cash_flow_data(code=code, year=year, quarter=quarter)

        rows = []
        while (rs.error_code == "0") and rs.next():
            rows.append(rs.get_row_data())
        if not rows:
            return pd.DataFrame()
        return pd.DataFrame(rows, columns=rs.fields)

    def get_forecast_report(self, symbol: str, year: int, quarter: int) -> pd.DataFrame:
        """
        获取业绩预告 — 排雷关键!

        用途:
            - 由盈转亏预告 → 致命雷
            - 净利润大幅下滑预告 → 致命雷

        注意: BaoStock 新版 API 使用 start_date/end_date 参数
        """
        import baostock as bs

        code = _to_baostock_code(symbol)
        start = f"{year}-{quarter*3-2:02d}-01"
        end = f"{year}-{quarter*3:02d}-{30 if quarter*3 in (3,6,9) else 31}"
        try:
            rs = bs.query_forecast_report(code=code, start_date=start, end_date=end)
        except Exception:
            # 降级: 尝试旧版 API
            rs = bs.query_forecast_report(code=code, year=year, quarter=quarter)

        rows = []
        while (rs.error_code == "0") and rs.next():
            rows.append(rs.get_row_data())
        if not rows:
            return pd.DataFrame()
        return pd.DataFrame(rows, columns=rs.fields)

    def get_performance_express(self, symbol: str, year: int, quarter: int) -> pd.DataFrame:
        """
        获取业绩快报
        """
        import baostock as bs

        code = _to_baostock_code(symbol)
        rs = bs.query_performance_express_report(code=code, year=year, quarter=quarter)

        rows = []
        while (rs.error_code == "0") and rs.next():
            rows.append(rs.get_row_data())
        if not rows:
            return pd.DataFrame()
        return pd.DataFrame(rows, columns=rs.fields)

    # ──────────────────────────────────────────────
    # 证券元信息
    # ──────────────────────────────────────────────

    def get_stock_basic(self, symbol: str) -> dict:
        """
        获取股票基本资料

        返回:
            {
                "code": "sz.000001",
                "code_name": "平安银行",
                "ipoDate": "1991-04-03",
                "outDate": "",
                "type": "1",      # 1=股票, 2=指数
                "status": "1",    # 1=上市, 0=退市
                "is_st": False    # 是否ST
            }
        """
        import baostock as bs

        code = _to_baostock_code(symbol)
        rs = bs.query_stock_basic(code=code)

        while (rs.error_code == "0") and rs.next():
            row = rs.get_row_data()
            return {
                "code": row[0],
                "code_name": row[1],
                "ipoDate": row[2],
                "outDate": row[3],
                "type": row[4],
                "status": row[5],
            }
        return {}

    def get_stock_industry(self, symbol: str) -> str:
        """
        获取股票所属行业

        返回:
            行业名称，如 "银行", "软件服务" 等
        """
        import baostock as bs

        code = _to_baostock_code(symbol)
        rs = bs.query_stock_industry(code=code)

        while (rs.error_code == "0") and rs.next():
            row = rs.get_row_data()
            return row[2]  # 行业名称
        return ""

    def get_all_stock_codes(self) -> pd.DataFrame:
        """
        获取所有A股代码列表（含股票名称、上市状态）

        用于全市场扫描
        """
        import baostock as bs

        rs = bs.query_all_stock(day=datetime.now().strftime("%Y-%m-%d"))
        rows = []
        while (rs.error_code == "0") and rs.next():
            rows.append(rs.get_row_data())

        if not rows:
            return pd.DataFrame()
        df = pd.DataFrame(rows, columns=rs.fields)
        # 只保留股票 type=1
        df = df[df["type"] == "1"].copy()
        return df

    def get_trade_dates(self, start_date: str = "", end_date: str = "") -> list:
        """
        获取交易日列表
        """
        import baostock as bs

        if not start_date:
            start_date = (datetime.now() - timedelta(days=365)).strftime("%Y-%m-%d")
        if not end_date:
            end_date = datetime.now().strftime("%Y-%m-%d")

        rs = bs.query_trade_dates(start_date=start_date, end_date=end_date)
        dates = []
        while (rs.error_code == "0") and rs.next():
            row = rs.get_row_data()
            if row[1] == "1":  # is_trading_day
                dates.append(row[0])
        return dates
