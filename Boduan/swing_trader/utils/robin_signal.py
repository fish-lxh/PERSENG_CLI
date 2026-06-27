"""
晓胜"知更鸟"信号
==================
晓胜波段王核心分析工具之一。
观察聪明资金动向: 布伦特原油、韩股、日股比A股早开盘，
从外围市场开盘表现提前预判A股当日方向。

使用方式:
    robin = RobinSignal()
    result = robin.analyze()
    print(result["summary"])
"""
import logging
from datetime import datetime
from typing import Dict, Optional

import requests

from ..utils.config import CONFIG

logger = logging.getLogger(__name__)


class RobinSignal:
    """
    知更鸟信号分析器

    每日开盘前分析隔夜外盘和早盘亚太市场表现，
    给出A股当日方向预判（偏多/偏空/中性）。
    置信度 0-5，数值越高信号越强。
    """

    def __init__(self):
        self._headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/120.0.0.0 Safari/537.36"
            ),
            "Referer": "https://finance.sina.com.cn",
        }
        self._cfg = CONFIG.xiaosheng

    def analyze(self, extended: bool = False) -> Dict:
        """
        综合分析知更鸟信号

        参数:
            extended: 是否获取完整隔夜数据（美股+汇率+A50），默认False只获取核心3项

        返回:
        {
            "direction": "偏多" / "偏空" / "中性",
            "confidence": 0-5,
            "signals": {
                "brent_oil": {...},
                "korean_kospi": {...},
                "japan_nikkei": {...},
                "us_sp500": {...},      # extended only
                "us_nasdaq": {...},     # extended only
                "us_dollar": {...},     # extended only
                "a50_futures": {...},   # extended only
            },
            "details": [str, ...],
            "summary": str,
        }
        """
        signals: Dict[str, Dict] = {}

        # 1. 布伦特原油 (24小时交易)
        try:
            brent = self._get_brent_oil()
            signals["brent_oil"] = brent
        except Exception as e:
            logger.warning(f"布伦特原油获取失败: {e}")
            signals["brent_oil"] = {"signal": "unknown"}

        # 2. 韩股 KOSPI (比A股早1小时开盘)
        try:
            kospi = self._get_kospi()
            signals["korean_kospi"] = kospi
        except Exception as e:
            logger.warning(f"韩股获取失败: {e}")
            signals["korean_kospi"] = {"signal": "unknown"}

        # 3. 日经225 (比A股早1小时开盘)
        try:
            nikkei = self._get_nikkei()
            signals["japan_nikkei"] = nikkei
        except Exception as e:
            logger.warning(f"日经获取失败: {e}")
            signals["japan_nikkei"] = {"signal": "unknown"}

        # 4. 扩展数据（仅早盘调用）
        if extended:
            # 美股隔夜 (S&P 500)
            try:
                sp500 = self._get_sp500()
                signals["us_sp500"] = sp500
            except Exception as e:
                logger.warning(f"美股S&P500获取失败: {e}")
                signals["us_sp500"] = {"signal": "unknown"}

            # 美股隔夜 (Nasdaq)
            try:
                nasdaq = self._get_nasdaq()
                signals["us_nasdaq"] = nasdaq
            except Exception as e:
                logger.warning(f"美股Nasdaq获取失败: {e}")
                signals["us_nasdaq"] = {"signal": "unknown"}

            # A50期指 (24小时交易，反映外资对A股态度)
            try:
                a50 = self._get_a50_futures()
                signals["a50_futures"] = a50
            except Exception as e:
                logger.warning(f"A50期指获取失败: {e}")
                signals["a50_futures"] = {"signal": "unknown"}

            # 美元/人民币汇率
            try:
                usdcny = self._get_usd_cny()
                signals["usd_cny"] = usdcny
            except Exception as e:
                logger.warning(f"美元/人民币汇率获取失败: {e}")
                signals["usd_cny"] = {"signal": "unknown"}

        # 综合研判
        return self._synthesize(signals, extended=extended)

    def _get_brent_oil(self) -> Dict:
        """获取WTI原油期货最新价格和涨跌幅（替代布伦特原油，新浪hf_SC不可用）"""
        try:
            resp = requests.get(
                "https://hq.sinajs.cn/list=hf_CL",
                headers=self._headers, timeout=10
            )
            if resp.status_code == 200:
                text = resp.text
                if "=" in text:
                    data = text.split("=", 1)[1].strip('"').strip(";\n").split(",")
                    if len(data) > 9:
                        try:
                            # hf_CL格式: data[3]=最新价, data[7]=昨收, data[6]=时间
                            current = float(data[3])
                            pre_close = float(data[7])
                            pct = round((current / pre_close - 1) * 100, 2)
                        except (ValueError, IndexError):
                            return {"signal": "unknown"}

                        sig = "中性"
                        interp = "原油波动不大，对A股影响中性"
                        if pct > self._cfg.robin_brent_up:
                            sig = "偏空"
                            interp = "原油大涨=>输入性通胀担忧=>A股偏空"
                        elif pct < self._cfg.robin_brent_down:
                            sig = "偏多"
                            interp = "原油大跌=>输入性通胀缓解=>A股偏多"

                        return {
                            "price": current,
                            "pct": pct,
                            "signal": sig,
                            "interpretation": interp,
                        }
        except Exception as e:
            logger.debug(f"WTI原油异常: {e}")
        return {"signal": "unknown"}

    def _get_kospi(self) -> Dict:
        """获取韩国KOSPI — 当前环境不支持，返回unknown"""
        # 新浪 gb_kospi 在当前环境下不可用
        return {"signal": "unknown"}

    def _get_nikkei(self) -> Dict:
        """获取日经225指数（通过sh513000日经225ETF代理）"""
        try:
            resp = requests.get(
                "https://hq.sinajs.cn/list=sh513000",
                headers=self._headers, timeout=10
            )
            if resp.status_code == 200:
                text = resp.text
                if "=" in text:
                    data = text.split("=", 1)[1].strip('"').strip(";\n").split(",")
                    if len(data) > 5:
                        try:
                            # ETF标准格式: data[2]=昨收, data[3]=最新价
                            price = float(data[3])
                            pre_close = float(data[2])
                            pct = round((price / pre_close - 1) * 100, 2)
                        except (ValueError, IndexError):
                            return {"signal": "unknown"}

                        sig = "中性"
                        if pct > self._cfg.robin_korea_threshold:
                            sig = "偏多"
                        elif pct < -self._cfg.robin_korea_threshold:
                            sig = "偏空"

                        return {"price": price, "pct": pct, "signal": sig,
                                "interpretation": f"日经225ETF{'涨' if pct>0 else '跌'}{abs(pct):.1f}%"}
        except Exception as e:
            logger.debug(f"日经ETF异常: {e}")
        return {"signal": "unknown"}

    # ──────────────────────────────────────────────
    # 扩展数据源（早盘隔夜数据）
    # ──────────────────────────────────────────────

    def _get_sp500(self) -> Dict:
        """获取标普500指数隔夜收盘数据"""
        try:
            resp = requests.get(
                "https://hq.sinajs.cn/list=gb_inx",
                headers=self._headers, timeout=10
            )
            if resp.status_code == 200 and "=" in resp.text:
                data = resp.text.split("=", 1)[1].strip('"').strip(";\n").split(",")
                if len(data) > 3:
                    price = float(data[1]); pct = float(data[2])
                    sig = "偏多" if pct > 0.5 else ("偏空" if pct < -0.5 else "中性")
                    return {"price": price, "pct": pct, "signal": sig,
                            "interpretation": f"标普500隔夜{'涨' if pct>0 else '跌'}{abs(pct):.1f}%"}
        except: pass
        return {"signal": "unknown"}

    def _get_nasdaq(self) -> Dict:
        """获取纳斯达克指数隔夜收盘数据"""
        try:
            resp = requests.get(
                "https://hq.sinajs.cn/list=gb_ixic",
                headers=self._headers, timeout=10
            )
            if resp.status_code == 200 and "=" in resp.text:
                data = resp.text.split("=", 1)[1].strip('"').strip(";\n").split(",")
                if len(data) > 3:
                    price = float(data[1]); pct = float(data[2])
                    sig = "偏多" if pct > 0.5 else ("偏空" if pct < -0.5 else "中性")
                    interp = "科技股走强=>A股科技情绪偏多" if pct > 0.5 else \
                             ("科技股走弱=>A股科技情绪偏空" if pct < -0.5 else "美股科技震荡")
                    return {"price": price, "pct": pct, "signal": sig,
                            "interpretation": interp}
        except: pass
        return {"signal": "unknown"}

    def _get_a50_futures(self) -> Dict:
        """获取富时A50期指 — 当前环境不支持，返回unknown"""
        # 新浪 hf_XIN9 在当前环境下不可用
        # 可使用 sh560880 中国A50ETF作为替代（需测试）
        return {"signal": "unknown"}

    def _get_usd_cny(self) -> Dict:
        """获取美元/人民币离岸汇率"""
        try:
            resp = requests.get(
                "https://hq.sinajs.cn/list=fx_susdcny",
                headers=self._headers, timeout=10
            )
            if resp.status_code == 200 and "=" in resp.text:
                data = resp.text.split("=", 1)[1].strip('"').strip(";\n").split(",")
                if len(data) > 3:
                    price = float(data[1]); pre = float(data[3]) if len(data) > 3 and data[3] else price
                    pct = round((price / pre - 1) * 100, 4) if pre else 0
                    sig = "偏空" if pct > 0.1 else ("偏多" if pct < -0.1 else "中性")
                    return {"price": price, "pct": pct, "signal": sig,
                            "interpretation": f"离岸汇率{'贬' if pct>0 else '升'}{abs(pct):.2f}%"}
        except: pass
        return {"signal": "unknown"}

    def _synthesize(self, signals: Dict, extended: bool = False) -> Dict:
        """综合各子信号判断A股当日方向"""
        bullish = 0
        bearish = 0
        details = []

        label_map = {
            "brent_oil": "WTI原油", "korean_kospi": "韩股KOSPI",
            "japan_nikkei": "日经225", "us_sp500": "美股S&P500",
            "us_nasdaq": "美股Nasdaq", "a50_futures": "A50期指",
            "usd_cny": "离岸汇率",
        }
        # 权重：原油最重要(通胀信号)，日经为唯一亚太先行指标
        weight_map = {
            "brent_oil": 2, "a50_futures": 2, "us_sp500": 2,
            "us_nasdaq": 1, "korean_kospi": 1, "japan_nikkei": 2,
            "usd_cny": 1,
        }

        for source, data in signals.items():
            sig = data.get("signal", "unknown")
            label = label_map.get(source, source)
            weight = weight_map.get(source, 1)

            if sig == "偏多":
                bullish += weight
                details.append(f"{label}: {sig} ↑")
            elif sig == "偏空":
                bearish += weight
                details.append(f"{label}: {sig} ↓")
            elif sig != "unknown":
                details.append(f"{label}: {sig} →")

        if bullish > bearish:
            direction = "偏多"
            confidence = min(int(bullish * 1.5), 5)
        elif bearish > bullish:
            direction = "偏空"
            confidence = min(int(bearish * 1.5), 5)
        else:
            direction = "中性"
            confidence = 0

        return {
            "direction": direction,
            "confidence": confidence,
            "signals": signals,
            "details": details,
            "summary": (
                f"知更鸟信号: {direction}(置信度{confidence}/5)"
                + (" | " + " | ".join(details) if details else "")
            ),
        }
