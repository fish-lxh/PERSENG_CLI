"""
特特股 (tetegu.com) 数据源封装
================================
职责: 牛散持仓变动、股东人数变化

数据获取方式: 通过 VIP 账号登录后爬取

功能定位 — Swing-Trader 排雷引擎:
  - 牛散减持信号 → 公告维度 · 高风险预警
  - 股东人数变化 → 筹码集中度辅助分析

注意:
  1. 特特股为网页端数据，页面结构可能随网站更新而变化
  2. 需定期检查 cookie 有效性，失效后重新登录
  3. 请合理控制请求频率，避免对目标服务器造成压力
"""
import logging
import pickle
import os
import time
from typing import Optional, List, Dict
from datetime import datetime, timedelta

import requests
from bs4 import BeautifulSoup

from ..utils.config import CONFIG

logger = logging.getLogger(__name__)


class TeteguSource:
    """
    特特股数据源封装

    使用方式:
        ttg = TeteguSource()
        if ttg.login():
            holdings = ttg.get_niushan_holdings()
            shareholders = ttg.get_shareholder_change("000001")
    """

    def __init__(self):
        self._name = "特特股"
        self._session = requests.Session()
        self._session.headers.update({
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            "Referer": CONFIG.tetegu.base_url,
        })
        # 特特股 SSL 证书与域名不匹配，需要跳过验证
        self._session.verify = False
        import urllib3
        urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
        self._logged_in = False
        self._login_time: Optional[datetime] = None

    # ──────────────────────────────────────────────
    # 基础属性
    # ──────────────────────────────────────────────

    @property
    def name(self) -> str:
        return self._name

    def health_check(self) -> bool:
        """检查特特股是否可用（能否访问首页）"""
        try:
            resp = self._session.get(CONFIG.tetegu.base_url, timeout=10)
            return resp.status_code == 200
        except requests.RequestException as e:
            logger.warning(f"特特股连通性检查失败: {e}")
            return False

    # ──────────────────────────────────────────────
    # 登录管理
    # ──────────────────────────────────────────────

    def login(self, force: bool = False) -> bool:
        """
        登录特特股 VIP 账号

        注意: tetegu.com 当前被 Cloudflare 防护(514)，本数据源暂时不可用。
        排雷引擎将自动跳过公告维度检查。
        """
        logger.warning("特特股: Cloudflare 防护(514)无法绕过，公告维度排雷跳过")
        return False

    def _do_login(self) -> bool:
        """执行登录请求"""
        cfg = CONFIG.tetegu

        # 先获取登录页面，提取必要的 token 或隐藏字段
        try:
            resp = self._session.get(cfg.login_url, timeout=10)
            soup = BeautifulSoup(resp.text, "lxml")

            # 尝试提取 CSRF token（如有）
            token = ""
            token_input = soup.find("input", {"name": lambda n: n and "token" in n.lower()})
            if token_input:
                token = token_input.get("value", "")

            # 构造登录数据
            login_data = {
                "username": cfg.username,
                "password": cfg.password,
                "_token": token,
            }

            # 尝试不同的登录接口路径
            login_actions = [
                f"{cfg.base_url}/login",
                f"{cfg.base_url}/api/login",
                f"{cfg.base_url}/user/login",
            ]

            for action in login_actions:
                login_resp = self._session.post(
                    action,
                    data=login_data,
                    timeout=15,
                    allow_redirects=True,
                )
                if login_resp.status_code == 200:
                    # 检查登录后页面是否包含特定关键词
                    if self._check_login_status():
                        return True

            # 最终检查
            return self._check_login_status()

        except requests.RequestException as e:
            logger.error(f"特特股: 登录请求失败: {e}")
            return False

    def _check_login_status(self) -> bool:
        """检查当前 session 是否已登录"""
        try:
            resp = self._session.get(CONFIG.tetegu.base_url, timeout=10)
            # 如果页面包含登录按钮或登录表单，说明未登录
            # 如果包含"退出"或用户信息，说明已登录
            text = resp.text.lower()
            # 登录后通常会显示用户名或"退出"链接
            login_indicators = [
                CONFIG.tetegu.username[:4],  # 手机号前4位
                "退出", "logout", "会员中心",
                "1862007",  # 手机号部分
            ]
            return any(indicator in text for indicator in login_indicators)
        except Exception:
            return False

    def _save_cookies(self):
        """保存 session cookies 到本地缓存"""
        try:
            cache_file = CONFIG.tetegu.cookie_cache_file
            with open(cache_file, "wb") as f:
                pickle.dump(self._session.cookies, f)
            logger.debug(f"特特股: cookie 已缓存到 {cache_file}")
        except Exception as e:
            logger.warning(f"特特股: cookie 缓存失败: {e}")

    def _load_cookies(self) -> bool:
        """从本地缓存加载 cookies"""
        try:
            cache_file = CONFIG.tetegu.cookie_cache_file
            if not os.path.exists(cache_file):
                return False
            with open(cache_file, "rb") as f:
                self._session.cookies.update(pickle.load(f))
            logger.debug("特特股: cookie 已从缓存加载")
            return True
        except Exception as e:
            logger.warning(f"特特股: cookie 加载失败: {e}")
            return False

    # ──────────────────────────────────────────────
    # 牛散持仓数据
    # ──────────────────────────────────────────────

    def get_niushan_holdings(self, page: int = 1) -> List[Dict]:
        """
        获取牛散持仓列表

        返回: [
            {
                "niushan_name": "赵建平",
                "stock_code": "000001",
                "stock_name": "平安银行",
                "hold_shares": 10000000,    # 持股数
                "hold_ratio": 0.52,          # 持股比例(%)
                "change_type": "增持/减持/新进/退出",
                "quarter": "2024Q1",
            },
            ...
        ]
        """
        if not self._ensure_login():
            return []

        try:
            url = f"{CONFIG.tetegu.base_url}/niushan/holdings?page={page}"
            resp = self._session.get(url, timeout=15)

            if resp.status_code != 200:
                logger.warning(f"获取牛散持仓失败: HTTP {resp.status_code}")
                return []

            return self._parse_niushan_table(resp.text)

        except requests.RequestException as e:
            logger.error(f"特特股: 获取牛散持仓异常: {e}")
            return []

    def get_niushan_detail(self, niushan_name: str) -> List[Dict]:
        """
        获取指定牛散的详细持仓变化
        """
        if not self._ensure_login():
            return []

        try:
            url = f"{CONFIG.tetegu.base_url}/niushan/detail?name={niushan_name}"
            resp = self._session.get(url, timeout=15)

            if resp.status_code != 200:
                return []

            return self._parse_niushan_table(resp.text)

        except requests.RequestException as e:
            logger.error(f"特特股: 获取牛散详情异常: {e}")
            return []

    def get_stock_niushan(self, symbol: str) -> List[Dict]:
        """
        获取某只股票有哪些牛散持仓

        参数:
            symbol: 股票代码 (如 "000001")
        """
        if not self._ensure_login():
            return []

        try:
            url = f"{CONFIG.tetegu.base_url}/stock/niushan?code={symbol}"
            resp = self._session.get(url, timeout=15)

            if resp.status_code != 200:
                return []

            return self._parse_niushan_table(resp.text)

        except requests.RequestException as e:
            logger.error(f"特特股: 获取个股牛散异常: {e}")
            return []

    def _parse_niushan_table(self, html: str) -> List[Dict]:
        """解析牛散持仓表格 HTML"""
        soup = BeautifulSoup(html, "lxml")
        table = soup.find("table")
        if not table:
            logger.warning("特特股: 未找到牛散持仓表格")
            return []

        headers = []
        thead = table.find("thead")
        if thead:
            headers = [th.get_text(strip=True) for th in thead.find_all("th")]

        results = []
        tbody = table.find("tbody")
        if not tbody:
            return results

        for tr in tbody.find_all("tr"):
            cells = tr.find_all("td")
            if not cells:
                continue

            row = {}
            for i, cell in enumerate(cells):
                key = headers[i] if i < len(headers) else f"col_{i}"
                row[key] = cell.get_text(strip=True)
            results.append(row)

        return results

    # ──────────────────────────────────────────────
    # 股东人数变化
    # ──────────────────────────────────────────────

    def get_shareholder_change(self, symbol: str) -> List[Dict]:
        """
        获取股东人数变化数据

        参数:
            symbol: 股票代码

        返回: [
            {
                "date": "2024-12-31",
                "total_holders": 50000,     # 股东总人数
                "change": -1200,             # 变化数量
                "change_pct": -2.34,         # 变化百分比(%)
            },
            ...
        ]

        用途:
            - 股东人数持续减少 → 筹码集中，可能被主力收集
            - 股东人数持续增加 → 筹码分散，需警惕
        """
        if not self._ensure_login():
            return []

        try:
            url = f"{CONFIG.tetegu.base_url}/stock/shareholder?code={symbol}"
            resp = self._session.get(url, timeout=15)

            if resp.status_code != 200:
                return []

            return self._parse_shareholder_table(resp.text)

        except requests.RequestException as e:
            logger.error(f"特特股: 获取股东人数异常: {e}")
            return []

    def _parse_shareholder_table(self, html: str) -> List[Dict]:
        """解析股东人数变化表格"""
        soup = BeautifulSoup(html, "lxml")
        table = soup.find("table")
        if not table:
            return []

        headers = []
        thead = table.find("thead")
        if thead:
            headers = [th.get_text(strip=True) for th in thead.find_all("th")]

        results = []
        tbody = table.find("tbody")
        if not tbody:
            return results

        for tr in tbody.find_all("tr"):
            cells = tr.find_all("td")
            if not cells:
                continue
            row = {}
            for i, cell in enumerate(cells):
                key = headers[i] if i < len(headers) else f"col_{i}"
                row[key] = cell.get_text(strip=True)
            results.append(row)

        return results

    # ──────────────────────────────────────────────
    # 排雷辅助 — 检测减持信号
    # ──────────────────────────────────────────────

    def check_reduction_signal(self, symbol: str) -> dict:
        """
        检测股票是否有减持信号

        返回:
            {
                "has_reduction": True/False,
                "niushan_reduction": [...],   # 减持的牛散
                "total_holder_trend": "集中/分散/平稳",
                "risk_level": "无/警告/高风险",
            }
        """
        result = {
            "has_reduction": False,
            "niushan_reduction": [],
            "total_holder_trend": "平稳",
            "risk_level": "无",
        }

        # 检查牛散减持
        niushan_data = self.get_stock_niushan(symbol)
        for item in niushan_data:
            change = item.get("变动", item.get("change_type", ""))
            if "减" in change or "退出" in change:
                result["has_reduction"] = True
                result["niushan_reduction"].append({
                    "name": item.get("牛散名称", item.get("niushan_name", "")),
                    "change": change,
                })

        # 检查股东人数趋势
        holder_data = self.get_shareholder_change(symbol)
        if len(holder_data) >= 3:
            # 取最近3期的变化
            changes = []
            for item in holder_data[:3]:
                try:
                    pct = float(item.get("change_pct", item.get("change", "0")).replace("%", ""))
                    changes.append(pct)
                except (ValueError, AttributeError):
                    continue

            if len(changes) >= 2:
                avg_change = sum(changes) / len(changes)
                if avg_change < -3:
                    result["total_holder_trend"] = "集中"
                elif avg_change > 3:
                    result["total_holder_trend"] = "分散"

        # 综合评级
        if result["has_reduction"]:
            result["risk_level"] = "高风险"
        elif result["total_holder_trend"] == "分散":
            result["risk_level"] = "警告"

        return result

    # ──────────────────────────────────────────────
    # 内部工具
    # ──────────────────────────────────────────────

    def _ensure_login(self) -> bool:
        """确保已登录，未登录则尝试登录"""
        if not self._logged_in:
            return self.login()
        # 如果登录超过1小时，重新检查
        if self._login_time and (datetime.now() - self._login_time) > timedelta(hours=1):
            if not self._check_login_status():
                return self.login(force=True)
        return True
