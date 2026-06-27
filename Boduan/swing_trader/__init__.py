"""
Swing-Trader — A股右侧波段交易辅助系统
=========================================
基于周线定方向、日线找形态、分时找买点的右侧波段交易辅助系统。

数据源架构：
  - AKShare  → 实时行情、板块排行、龙虎榜、大宗交易
  - BaoStock → 历史K线、财务数据、业绩预告、ST状态
  - 特特股   → 牛散持仓变动、股东人数变化

七步流程：
  1. 周线定势  →  market_phase.py
  2. 板块扫描  →  sector_hot.py
  3. 形态识别  →  pattern_scan.py
  4. 排雷引擎  →  risk_check.py
  5. 热点匹配  →  hot_match.py
  6. 走势跟踪  →  tracker.py
  7. 计划书    →  plan_generator.py
"""

__version__ = "1.0.0"
__author__ = "Swing-Trader Team"
