"""
抽象基类 — 所有数据源的统一接口规范
"""
from abc import ABC, abstractmethod
from typing import Optional


class BaseDataSource(ABC):
    """数据源抽象基类"""

    @abstractmethod
    def name(self) -> str:
        """返回数据源名称"""
        ...

    @abstractmethod
    def health_check(self) -> bool:
        """检查数据源是否可用"""
        ...


class BaseKLineSource(BaseDataSource):
    """K线数据源接口"""

    @abstractmethod
    def get_index_daily(self, index_code: str, start_date: str, end_date: str):
        """获取指数日线数据"""
        ...

    @abstractmethod
    def get_index_weekly(self, index_code: str, start_date: str, end_date: str):
        """获取指数周线数据"""
        ...

    @abstractmethod
    def get_stock_daily(self, symbol: str, start_date: str, end_date: str,
                        adjust: Optional[str] = "qfq"):
        """获取个股日线数据"""
        ...

    @abstractmethod
    def get_stock_weekly(self, symbol: str, start_date: str, end_date: str,
                         adjust: Optional[str] = "qfq"):
        """获取个股周线数据"""
        ...


class BaseFinancialDataSource(BaseDataSource):
    """财务数据源接口"""

    @abstractmethod
    def get_profit_growth(self, symbol: str, year: int, quarter: int):
        """获取净利润增长率、营收增长率"""
        ...

    @abstractmethod
    def get_balance_sheet(self, symbol: str, year: int, quarter: int):
        """获取资产负债表（含商誉）"""
        ...

    @abstractmethod
    def get_forecast_report(self, symbol: str, year: int, quarter: int):
        """获取业绩预告"""
        ...

    @abstractmethod
    def get_st_basic_info(self, symbol: str):
        """获取股票基本资料（含ST状态）"""
        ...


class BaseSectorDataSource(BaseDataSource):
    """板块数据源接口"""

    @abstractmethod
    def get_sector_ranking(self):
        """获取板块涨跌幅排行"""
        ...

    @abstractmethod
    def get_concept_sector_ranking(self):
        """获取概念板块涨跌幅排行"""
        ...


class BaseTradeDataSource(BaseDataSource):
    """交易数据源接口"""

    @abstractmethod
    def get_longhu_detail(self, trade_date: str):
        """获取龙虎榜数据"""
        ...

    @abstractmethod
    def get_block_trade(self, start_date: str, end_date: str):
        """获取大宗交易数据"""
        ...
