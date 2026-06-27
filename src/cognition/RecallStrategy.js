const RECALL_MODE_PARAMS = {
  creative: {
    firingThreshold: 0.05,
    synapticDecay: 0.95,
    inhibitionFactor: 0.05,
    maxCycles: 12,
    cycleDecay: 0.95,
    frequencyBoost: 0.05,
    maxActivations: 150,
    totalLimit: 80,
  },
  balanced: {
    firingThreshold: 0.1,
    synapticDecay: 0.9,
    inhibitionFactor: 0.1,
    maxCycles: 8,
    cycleDecay: 0.9,
    frequencyBoost: 0.1,
    maxActivations: 100,
    totalLimit: 50,
  },
  focused: {
    firingThreshold: 0.2,
    synapticDecay: 0.75,
    inhibitionFactor: 0.15,
    maxCycles: 4,
    cycleDecay: 0.85,
    frequencyBoost: 0.2,
    maxActivations: 50,
    totalLimit: 20,
  },
};

const DEFAULT_FINE_RANKING = {
  typeWeights: {
    PATTERN: 2.0,
    LINK: 1.5,
    ATOMIC: 1.0,
  },
  weightFactors: {
    type: 0.3,
    relevance: 0.4,
    strength: 0.2,
    temporal: 0.1,
  },
  typeQuotas: {
    PATTERN: 10,
    LINK: 15,
    ATOMIC: 25,
  },
  temporalDecay: 30,
};

export function getRecallModeParams(mode = 'balanced') {
  return RECALL_MODE_PARAMS[mode] || RECALL_MODE_PARAMS.balanced;
}

export function calculateConnectionWeight({ timestamp, position, strength, cooccurrence = 1 }) {
  // M4.1: 边权重 = 共现频次 × 时间衰减 × 强度因子
  // - 共现频次：同一 schema 数组里相邻词对被一起记住的次数
  // - 时间衰减：越近的共现权重越高（半衰期 ~7 天）
  // - 强度因子：engram 自身 strength 越高，连接越可信
  const positionFactor = Math.pow(0.9, position ?? 0);
  const strengthFactor = Math.min(1, Math.max(0, strength ?? 0.8));
  const ageInDays = (Date.now() - (timestamp ?? Date.now())) / (1000 * 60 * 60 * 24);
  const timeDecay = Math.exp(-ageInDays / 7); // 7 天半衰期
  return Math.max(0.0001, cooccurrence * timeDecay * strengthFactor * positionFactor);
}

function calculateRelevance(engram, { depths, queryWordsLower }) {
  const activatedBy = engram.activatedBy || '';
  if (depths?.has(activatedBy)) {
    const depth = depths.get(activatedBy);
    return 1.0 / (1 + depth * 0.2);
  }

  const schemaWords = (engram.schema || []).map((w) => String(w).toLowerCase());
  const overlap = schemaWords.filter((w) => queryWordsLower.some((q) => w.includes(q))).length;
  return Math.min(1.0, overlap / Math.max(1, queryWordsLower.length));
}

function calculateCompositeWeight(engram, rankingContext) {
  const { typeWeights, weightFactors, temporalDecay } = rankingContext;
  const typeScore = typeWeights[engram.type] || 1.0;
  const relevanceScore = calculateRelevance(engram, rankingContext);
  const strengthScore = engram.strength || 0.5;
  const ageInDays = (Date.now() - (engram.timestamp || 0)) / (1000 * 60 * 60 * 24);
  const temporalScore = Math.exp(-ageInDays / temporalDecay);
  const weight =
    weightFactors.type * typeScore +
    weightFactors.relevance * relevanceScore +
    weightFactors.strength * strengthScore +
    weightFactors.temporal * temporalScore;

  return {
    engram,
    weight,
    scores: { typeScore, relevanceScore, strengthScore, temporalScore },
  };
}

export function fineRankEngrams(engrams, options = {}) {
  if (!engrams?.length) return [];

  const config = {
    ...DEFAULT_FINE_RANKING,
    ...options,
  };
  const rankingContext = {
    queryWordsLower: options.queryWordsLower || [],
    depths: options.depths || new Map(),
    typeWeights: config.typeWeights,
    weightFactors: config.weightFactors,
    typeQuotas: config.typeQuotas,
    temporalDecay: config.temporalDecay,
  };

  const weighted = engrams
    .map((engram) => calculateCompositeWeight(engram, rankingContext))
    .sort((a, b) => b.weight - a.weight);

  const counts = { PATTERN: 0, LINK: 0, ATOMIC: 0 };
  const filtered = [];
  const totalLimit = Math.min(options.totalLimit || 50, 200);

  for (const item of weighted) {
    const type = item.engram.type || 'ATOMIC';
    const quota = rankingContext.typeQuotas[type] || 0;
    if (counts[type] < quota) {
      filtered.push(item);
      counts[type]++;
      if (filtered.length >= totalLimit) break;
    }
  }

  if (filtered.length < totalLimit) {
    for (const item of weighted) {
      if (filtered.includes(item)) continue;
      filtered.push(item);
      if (filtered.length >= totalLimit) break;
    }
  }

  return filtered.map((item) => ({
    ...item.engram,
    _weight: item.weight,
    _scores: item.scores,
  }));
}

