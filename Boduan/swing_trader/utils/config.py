"""
Swing-Trader 全局配置
"""
from dataclasses import dataclass, field
from typing import Optional, List, Tuple


@dataclass
class BaoStockConfig:
    """BaoStock 连接配置（无需注册，直接连接即可）"""
    host: str = "localhost"
    port: int = 10031
    user_id: str = "anonymous"


@dataclass
class TeteguConfig:
    """特特股 VIP 登录配置"""
    login_url: str = "https://www.tetegu.com/login"
    base_url: str = "https://www.tetegu.com"
    username: str = "18620073691"
    password: str = "123321"
    # 登录后的 cookie / token 缓存文件
    cookie_cache_file: str = "tetegu_cookies.pkl"


@dataclass
class SectorConfig:
    """板块热度扫描配置"""
    top_n: int = 10                 # 取前 N 个热门板块
    short_term_days: int = 5        # 短期涨幅统计天数
    mid_term_days: int = 10         # 中期涨幅统计天数
    long_term_days: int = 20        # 长期涨幅统计天数


@dataclass
class PatternConfig:
    """形态识别配置"""
    # 形态A: 日线上穿250年线 + 涨幅>9.9% + 量比>1 + 5日线在年线上方
    pattern_a_pct_threshold: float = 9.9   # 涨幅阈值(%)
    pattern_a_vol_ratio: float = 1.5       # 量比阈值(提高)
    pattern_a_require_ma5_above: bool = False  # 首板当日常MA5未跟上，不要求

    # 形态B: 上影线试盘突破
    pattern_b_pct_threshold: float = 3.8       # 涨幅阈值(%)
    pattern_b_upper_shadow_ratio: float = 0.3  # 上影线/总振幅
    pattern_b_vol_ratio: float = 2.0           # 量比阈值
    pattern_b_platform_days: int = 55          # 平台统计天数（改为55天，约一个季度）

    # 形态C: 连续小阳线上涨9天 + 温和放量 + 年线上方
    pattern_c_days: int = 9                # 连续上涨天数（9天）
    pattern_c_max_daily_pct: float = 7.0   # 单日涨幅上限(从5%放宽到7%)
    pattern_c_min_daily_pct: float = 0.3   # 单日涨幅下限(从0.1%提高到0.3%)

    # 形态D: 新高模式（晓胜核心策略）
    pattern_d_lookback_months: int = 24        # 阶段新高回溯月数
    pattern_d_ma5_deviation_stop: float = 5.0  # 止损在5日线下方5%
    pattern_d_add_position_limit: float = 0.2  # 预备队2成上限
    pattern_d_min_vol_ratio: float = 1.5       # 新高日最低量比
    pattern_d_max_ma5_deviation: float = 8.0   # 距5日线最大偏离%(超过不追)

    # 形态E: 反包博弈K线（晓胜策略）
    pattern_e_engulf_ratio: float = 0.7           # 反包覆盖比例(从50%提高到70%)
    pattern_e_min_vol_ratio: float = 1.5          # 最小量比(新增)
    pattern_e_trend_strength_pct: float = 5.0     # 趋势强化判断：近10日涨幅阈值
    pattern_e_consolidation_swing: float = 15.0   # 横盘判定：近20日振幅上限
    pattern_e_near_ma250_dist: float = 10.0       # 年线附近判定：距年线距离%
    pattern_e_require_ma20_up: bool = True        # 要求20日均线向上(新增)

    # 形态F: 上升三法（晓胜策略 — 经典持续看涨K线组合）
    pattern_f_lookback_days: int = 15             # 上升三法检测回溯天数
    pattern_f_min_first_pct: float = 4.0          # 首根大阳线最低涨幅%(从5放宽到4)
    pattern_f_max_interim_pct: float = 7.0        # 中间小K线最大涨跌幅%(从5放宽到7)
    pattern_f_min_last_pct: float = 3.0           # 末根突破阳线最低涨幅%
    pattern_f_max_interim_days: int = 5           # 中间最多K线数
    pattern_f_min_interim_days: int = 2           # 中间最少K线数
    pattern_f_vol_shrink_ratio: float = 0.9       # 中间K线量能≤首根量90%（从80%放宽）
    pattern_f_last_vol_ratio: float = 1.2         # 末根量比≥1.2（从1.3放宽）


@dataclass
class RiskConfig:
    """排雷引擎配置"""
    # 业绩维度
    profit_decline_threshold: float = -50.0   # 净利润同比下滑>50% → 致命雷
    revenue_decline_threshold: float = -30.0  # 营收连续2季下滑>30% → 警告
    goodwill_ratio_threshold: float = 0.30    # 商誉/净资产>30% → 警告
    revenue_decline_quarters: int = 2         # 营收下滑持续季度数

    # 交易维度
    block_trade_discount_threshold: float = 10.0  # 大宗交易折价>10% → 高风险

    # 公告维度
    unlock_threshold: float = 5.0  # 解禁比例>5% → 高风险


@dataclass
class PositionConfig:
    """仓位管理配置"""
    winter_max: float = 0.0            # 冬: 0%
    spring_early_min: float = 0.30     # 冬末春初: 30-50%
    spring_early_max: float = 0.50
    spring_min: float = 0.50           # 春: 50-70%
    spring_max: float = 0.70
    summer_max: float = 0.50           # 夏: 持有并逐步减仓
    autumn_max: float = 0.0            # 秋: 清仓


@dataclass
class SectorRotationConfig:
    """赛道轮动扫描配置（rotation 评分引擎）"""
    enabled: bool = True                     # 是否启用赛道轮动扫描
    top_n: int = 20                          # 每次推荐扫描的赛道数量
    min_score: int = 4                       # 最低评分（低于此分不扫描）
    cache_enabled: bool = True               # 是否缓存推荐结果
    # 晓胜核心方向强制加入扫描（无论评分如何）
    core_keywords: Tuple[str, ...] = (
        "算力", "机器人", "人工智能", "芯片", "半导体",
        "低空经济", "新能源汽车", "军工", "储能",
        "消费电子", "AI应用", "DeepSeek",
    )


@dataclass
class BullConfig:
    """大牛有形（Big Bull Visible Form）专项配置"""
    enabled: bool = True
    ma_periods: tuple = (5, 10, 20, 55, 89, 144, 250)  # 六线顺上标准周期
    # 均线多头排列
    alignment_min_count: int = 4      # 至少N条均线向上视为多头排列
    # 均线汇聚
    convergence_max_spread: float = 8.0  # 最大发散百分比
    convergence_min_mas: int = 3      # 至少N条均线汇聚


@dataclass
class XiaoShengConfig:
    """晓胜波段王策略专用配置"""
    # 首板250后低吸
    pb_aggressive_pullback: float = 3.0      # 激进：回撤3%关注5日线
    pb_moderate_pullback: float = 5.0         # 稳健：回撤5%关注10日线
    pb_conservative_pullback: float = 8.0     # 保守：回撤8%或至年线
    pb_max_tracking_days: int = 20            # 最长跟踪天数

    # 知更鸟信号阈值
    robin_brent_up: float = 1.0               # 原油涨超1%→偏空
    robin_brent_down: float = -1.0            # 原油跌超1%→偏多
    robin_korea_threshold: float = 0.5        # 韩股涨跌超0.5%需关注

    # 晓胜重点方向关键词
    computing_power_keywords: Tuple[str, ...] = (
        "算力", "电力", "数据中心", "CPU", "GPU", "光纤", "光模块", "算电协同"
    )
    power_semi_keywords: Tuple[str, ...] = (
        "功率半导体", "IGBT", "SiC", "碳化硅", "英飞凌", "三代半"
    )
    ceramic_substrate_keywords: Tuple[str, ...] = (
        "陶瓷基板", "PCB", "散热", "封装", "ABF"
    )
    ai_hardware_keywords: Tuple[str, ...] = (
        "AI服务器", "AI芯片", "HBM", "存储芯片", "先进封装"
    )

    # 晓胜方向评分权重
    computing_power_weight: int = 30           # 算电协同配分
    power_semi_weight: int = 25                # 功率半导体配分
    ceramic_weight: int = 20                   # 陶瓷基板配分
    ai_hardware_weight: int = 15               # AI硬件配分

    # 晓胜风险监测
    margin_balance_warning: float = 22000      # 融资余额>2.2万亿警告(亿)
    tech_volume_ratio_warning: float = 0.40    # 科技成交占比>40%警告

    # 乘胜追击加仓
    follow_up_gain_threshold: float = 10.0     # 涨幅>10%后可考虑加仓
    follow_up_max_add_pct: float = 0.20        # 加仓上限总资金2成
    follow_up_ma5_reentry: float = -3.0        # 加仓时机：回撤至5日线-3%


@dataclass
class WatchlistConfig:
    """重点跟踪股票（自选股）配置"""
    # 格式: [("代码6位", "名称"), ...]
    # 这些股票在每次全市场扫描中会被强制扫描（不论是否在热门板块中）
    # 同时每日盘中/盘后会自动更新走势状态
    stocks: List[Tuple[str, str]] = field(default_factory=lambda: [
        ("301022", "海泰科"),
        ("600770", "综艺股份"),
    ])

    # 是否在盘中简报/交易计划中单独列出
    show_in_report: bool = True


@dataclass
class AppConfig:
    """应用全局配置"""
    # 市场定势默认指数
    default_index_code: str = "sh000001"  # 上证指数

    # 数据路径
    data_dir: str = "./data"
    log_dir: str = "./logs"

    # 子配置
    baostock: BaoStockConfig = field(default_factory=BaoStockConfig)
    tetegu: TeteguConfig = field(default_factory=TeteguConfig)
    sector: SectorConfig = field(default_factory=SectorConfig)
    pattern: PatternConfig = field(default_factory=PatternConfig)
    rotation: SectorRotationConfig = field(default_factory=SectorRotationConfig)
    bull: BullConfig = field(default_factory=BullConfig)
    risk: RiskConfig = field(default_factory=RiskConfig)
    position: PositionConfig = field(default_factory=PositionConfig)
    xiaosheng: XiaoShengConfig = field(default_factory=XiaoShengConfig)
    watchlist: WatchlistConfig = field(default_factory=WatchlistConfig)


# 全局单例
CONFIG = AppConfig()
