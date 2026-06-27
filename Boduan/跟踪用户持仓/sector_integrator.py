"""
赛道/板块数据整合器
===================
与 WorkBuddy 的 style-rotation / sector-comparison 技能联动，
为持仓跟踪提供赛道/板块维度的上下文。

工作方式:
  1. 自动模式 - 通过 WorkBuddy MCP 工具查询赛道数据（需在 WorkBuddy 环境中运行）
  2. 离线模式 - 使用内置的行业映射表提供基础板块信息
  3. 缓存模式 - 读取最近一次赛道扫描的结果文件

使用方法:
    integrator = SectorIntegrator()
    sector_map = integrator.get_sector_map(["600905", "002579"])
    # sector_map = {"600905": {"sector_name": "电力", ...}, ...}
"""

import os
import json
from datetime import datetime

PROJECT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# ── 股票 -> 板块映射表（可扩展） ──
# 格式: {"股票代码": {"sector_name": "板块名", "tag": "标签", "note": "备注"}}
#
# 修改方法: 直接添加或修改下方字典条目
STOCK_SECTOR_MAP = {
    # ── 当前持仓 ──
    "600905": {
        "sector_name": "电力/新能源",
        "tag": "绿电",
        "note": "三峡集团旗下，风光新能源运营龙头",
    },
    "002579": {
        "sector_name": "电子/PCB",
        "tag": "PCB",
        "note": "PCB制造，FPC/HDI产品线",
    },
    # ── 候选池 ──
    "300666": {
        "sector_name": "电子/半导体",
        "tag": "半导体材料",
        "note": "高纯溅射靶材龙头",
    },
    "300811": {
        "sector_name": "电子/磁性材料",
        "tag": "金属软磁",
        "note": "金属磁粉芯龙头，新能源+AI双驱动",
    },
    "300408": {
        "sector_name": "电子/陶瓷",
        "tag": "MLCC",
        "note": "MLCC龙头，国产替代",
    },
    "600378": {
        "sector_name": "化工/新材料",
        "tag": "电子特气",
        "note": "电子特气+清洁能源",
    },
}


class SectorIntegrator:
    """赛道/板块数据整合器"""

    def __init__(self):
        self.cache = {}

    def get_sector_map(self, stock_symbols: list) -> dict:
        """获取指定股票的赛道/板块信息

        Args:
            stock_symbols: 股票代码列表，如 ["600905", "002579"]

        Returns:
            字典: {股票代码: {sector_name, tag, rotation_status, score, ...}}
        """
        result = {}

        for symbol in stock_symbols:
            info = self._get_stock_sector_info(symbol)
            if info:
                result[symbol] = info
            else:
                result[symbol] = {
                    "sector_name": "未知",
                    "tag": "",
                    "note": "未匹配到板块信息",
                }

        return result

    def _get_stock_sector_info(self, symbol: str) -> dict:
        """获取单只股票的赛道信息

        查找优先级:
          1. 缓存
          2. WorkBuddy skill 查询（如果可用）
          3. 内置映射表
          4. 未知
        """
        # 1. 检查缓存
        if symbol in self.cache:
            return self.cache[symbol]

        # 2. 尝试从 WorkBuddy 获取（占位 - 需要 WorkBuddy MCP 环境）
        #    实际使用时，可在此处调用 WorkBuddy 的 sector-comparison skill
        wb_info = self._try_workbuddy_lookup(symbol)
        if wb_info:
            self.cache[symbol] = wb_info
            return wb_info

        # 3. 使用内置映射表
        if symbol in STOCK_SECTOR_MAP:
            base = dict(STOCK_SECTOR_MAP[symbol])
            base["score"] = ""
            base["rank"] = ""
            base["strength"] = ""
            base["rotation_status"] = ""
            self.cache[symbol] = base
            return base

        return None

    def _try_workbuddy_lookup(self, symbol: str) -> dict:
        """尝试通过 WorkBuddy 获取赛道数据

        WorkBuddy 提供了两个相关技能:
          - style-rotation:    风格轮动分析（大小盘、成长价值切换）
          - sector-comparison: 板块比较（行业强度、资金偏好）

        集成方式:
          方法1（推荐）: 在 WorkBuddy 对话中手动调取技能后，
                        将结果通过 update_from_workbuddy() 传入缓存
          方法2: 直接阅读 WorkBuddy 技能输出的 markdown 报告，
                通过 parse_workbuddy_report() 解析

        返回:
            包含赛道信息的字典，或 None（如果不可用）
        """
        # 检查是否已有通过 update_from_workbuddy() 注入的数据
        if symbol in self.cache:
            return self.cache[symbol]
        return None

    def update_from_workbuddy(self, symbol: str, sector_data: dict):
        """从 WorkBuddy 技能输出更新赛道数据

        在 WorkBuddy 环境中手动调用 style-rotation 或 sector-comparison 技能后，
        将结果通过此方法注入缓存，供后续的跟踪简报使用。

        Args:
            symbol: 股票代码
            sector_data: 包含赛道信息的字典，支持以下字段:
                - sector_name:      板块名称
                - tag:              简短标签
                - rotation_status:  轮动状态 (启动/主升/高位拥挤/退潮等)
                - score:            评分
                - rank:             板块排名
                - strength:         强度描述
                - note:             备注
        """
        self.cache[symbol] = sector_data
        print(f"  [sector] WorkBuddy 数据已更新: {symbol} -> {sector_data.get('sector_name', '?')}")

    def parse_workbuddy_report(self, report_text: str, symbol: str) -> dict:
        """解析 WorkBuddy 技能输出的 Markdown 报告

        从 style-rotation 或 sector-comparison 的结构化输出中
        提取与指定股票相关的赛道信息。

        Args:
            report_text: WorkBuddy 技能的 markdown 输出
            symbol:      目标股票代码

        Returns:
            解析后的赛道信息字典
        """
        import re

        info = {}

        # 尝试提取板块名称
        sector_match = re.search(r'【1.当前主导风格】\s*(.+?)(?:\n|$)', report_text)
        if sector_match:
            info["rotation_status"] = sector_match.group(1).strip()

        # 尝试提取配置建议
        config_match = re.search(r'【6.配置建议】\s*(.+?)(?:\n\n|\Z)', report_text, re.DOTALL)
        if config_match:
            info["note"] = config_match.group(1).strip()[:200]

        # 尝试从板块比较中提取
        for line in report_text.split("\n"):
            if symbol in line and any(kw in line for kw in ["板块", "行业", "赛道"]):
                info["note"] = line.strip()[:200]
                break

        return info if info else None

    def get_sector_summary(self, sector_map: dict) -> str:
        """生成赛道概况文本（用于简报中的赛道背景部分）"""
        if not sector_map:
            return ""

        sectors = set()
        for symbol, info in sector_map.items():
            if info and info.get("sector_name"):
                sectors.add(info["sector_name"])

        if sectors:
            return " | ".join(sorted(sectors))
        return ""

    def refresh_cache(self):
        """清空缓存，强制重新获取"""
        self.cache = {}
