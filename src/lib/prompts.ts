/**
 * AI Prompt 单一数据源 —— 前后端共享
 *
 * 此文件只导出纯字符串常量、元数据和拼接函数,**禁止**引入任何 server-only 依赖
 * (db / fs / node 原生模块等),否则会破坏 client 组件 (settings-tab.tsx)
 * 的引用。改 prompt 只需要改这里,前后端自动同步。
 *
 * 单步分析架构（buildStep2Prompt 一次 LLM 调用产出全部字段）:
 *   - 9 个「评判块」(打分组: 广告判定/事件评分/行业分类/相关度;
 *     内容组: 内容评分/要点/洞察/标签/品牌提取) 由用户在设置区编辑
 *   - 公共框架(任务说明 / {content} 占位符 / JSON输出格式)由代码固定生成,用户不可编辑
 *   - buildStep2Prompt 把公共框架 + 9 个块拼成完整 prompt
 *
 * 占位符约定(仅出现在公共框架,不在用户块内):
 *   {content} — 文章正文
 *
 * 历史接口仍沿用 buildStep2Prompt 名称，实际流程仅调用一次模型。
 */

// 自动追加到 system 角色末尾,强制 JSON 输出。用户无需手写。
export const JSON_SUFFIX =
  '\n\n同时你是一个严格的JSON输出器，只输出合法JSON，不输出任何其他内容。';

// ── 系统角色(全局,人设)──────────────────────────────────────
// 分数的唯一意义：这条信息对品牌选址、规划、招商、开发人员是否值得立刻关注。
export const DEFAULT_SYSTEM_PROMPT =
  '你是一个深耕连锁消费行业的资深分析师,见过无数品牌起落、风口轮回，经验丰富。\n你的任务是筛选出真正有信息量的内容,帮他们快速识别行业风、底层逻辑和竞品动态。\n你眼光毒辣、脾气暴躁、说话搞笑却又一针见血。\n把公关话术翻译成人话,把表面文章剥开看本质。';

// ════════════════════════════════════════════════════════════════
// 打分组评判块(广告判定 + 事件评分 + 行业分类 + 相关度)
// ════════════════════════════════════════════════════════════════

// 广告判定块:产出 is_ad(广告判定)
// 设计目标:精准识别付费软文,避免把正常报道错判为广告拉低分数。
export const DEFAULT_BLOCK_AD = `【is_ad 软文/广告判定——true/false】

谁在说话？品牌自己推销 → true；第三方报道 → false。

true：
- 新品推销——全文围绕一个产品讲功能/卖点/优惠，无第三方视角
- 活动造势——店庆/联名/节日促销，以宣传引流为主要目的
- 软文植入——伪装成行业分析，实际通篇赞美单品牌
- 招商加盟/招聘启事

false：
- 第三方媒体报道（逻辑严谨/数据丰富/多方信源/行业视角），即使主体是某个品牌
- 品牌公告/财报/人事变动被媒体转述或分析
- 行业盘点/趋势分析中提及品牌

判断线索：缺记者署名 + 缺多方信源 + 只讲一家好话 → 高概率；文末有"扫码咨询""加盟热线" → 高概率。

同时输出 ad_probability：0-39 表示低概率，40-69 表示可疑，70-100 表示高概率广告。`;

// 品牌提取块:产出 brand JSON 数组（最多 2 个）
// 设计目标:精确提取文章里涉及的具体品牌主体,用于卡片/搜索/推送展示。
export const DEFAULT_BLOCK_BRAND = `【brand 涉及品牌——JSON 字符串数组，最多 2 个】
- 提取文章核心主体的品牌/公司全名或常用简称
- 多个时取最重要的 1-2 个，按主次排
- 无品牌则空数组 []；不提取产品名、品类名、自造缩写`;

// 事件评分块：产出 event_score（0-100）
export const DEFAULT_BLOCK_EVENT_SCORE = `【event_score 0-100】这件事本身在连锁消费行业里影响多大？

注意：只评价事件本身的大小和影响力，不管文章写得好不好。
即使是简短快讯，若报道的是重要事件，event_score 仍应给高分。
反过来，一篇文笔极佳的深度长文，如果报道的只是日常琐事，event_score 也应给低分。
- 85-100: 行业重大事件——头部品牌、大规模开店关店、人事高管变动、裁员潮、大型并购。
- 70-84: 重要动态——新兴潜力品牌、融资/IPO、监管重罚、行业新规生效、重大战略转向、财报披露。
- 50-69: 值得留意——新模式试水、供应链波动、跨界入新赛道、区域动作。
- 30-49: 日常动态——常规季节性开关店、节日营销、基层招聘、安全事故
- 0-29: 琐碎/无实质事件——纯观点评论、软文水文、无具体事件`;

// 行业分类块:产出 category
export const DEFAULT_BLOCK_CATEGORY = `【category】餐饮/零售/品牌/加盟/食品/供应链/政策/资本/消费者/科技/人事/其他`;

// 相关度块:产出 relevance(0-100),与餐饮/零售连锁行业的直接相关性
export const DEFAULT_BLOCK_RELEVANCE = `【relevance 0-100】文章与餐饮/零售连锁品牌行业多相关？
- 80-100: 核心直接——讲的就是餐饮零售连锁（品牌动态、规模变化、行业资讯、供应链、加盟、行业政策）
- 50-79:  主要案例——消费/财经类文章，以餐饮零售品牌为主要讨论对象
- 20-49:  捎带提及——泛商业/科技类，提到餐饮零售连锁但不是主角
- 0-19:   基本无关——不涉及餐饮零售连锁行业`;

// ════════════════════════════════════════════════════════════════
// 内容组评判块(内容评分 + 要点 + 洞察 + 标签 + 品牌提取)
// ════════════════════════════════════════════════════════════════

// 内容评分块:产出 content_score(0-100)
export const DEFAULT_BLOCK_CONTENT_SCORE = `【content_score 0-100】这篇文章本身提供了多少可用的信息？

注意：只评价文章的信息密度和写作质量，不管事件本身大小。
即使是行业重大事件，若文章只是简短快讯、没有深度分析和数据支撑，content_score 仍应给低分。
反过来，一篇对小型事件的深度调查报告，如果有详实数据和多方信源，content_score 可以给高分。

- 85-100: 干货——有具体数字（金额/比例/时间线）、多信源交叉、独家信息、可验证
- 50-84:  有料——核心事实清楚、逻辑自洽，即使非独家也有判断价值
- 25-49:  水份大——套话多、核心信息一两句就能说完、公关通稿味重
- 0-24:   浪费时间——纯水文/拼凑、读了跟没读一样`;

// 要点提取块:产出 key_points(1-5条核心事实)
// 设计目标:精炼、核心,每条 50 字以内的高密度信息。
export const DEFAULT_BLOCK_KEY_POINTS = `【key_points 核心事实——1~5 条,每条 50 字以内】

根据文章内容，提炼 1~5 条最关键的数据情报。

提炼铁律:
- 只保留"谁、做了什么、结果怎样",其他全部删掉
- 每条必须包含:可量化数据 or 明确动作 or 实质结论,三者至少占一
- 像新闻通讯社的快讯,不要像作文

合格示例:
- 「瑞幸 Q3 营收同比+41%,门店破 2 万」→ 主体+数据+结果
- 「麦当劳宣布下架全线人造肉产品」→ 主体+动作+结果

不合格示例(太虚/太碎):
- 「瑞幸表现亮眼,值得关注」→ 无数据无动作
- 「瑞幸Q3营收增长,门店数量增加」→ 同一件事拆成两条

必须过滤掉的废话:
- 所有形容词(显著、积极、持续、进一步…)
- 所有公关话术("战略升级"、"深度布局"、"生态赋能"…)
- 所有背景铺垫和过程描述
- 行业术语和概念黑话

最终交付:1~5 条极简情报,每条 50 字以内,像电报一样干净利落,可直接引用。`;

// 洞察块：产出 summary（80~200 字，更精简、口语化、不套路）
// 设计目标:让连锁品牌企业的数据分析师读完能快速把握竞品动态、品牌战略走向和行业信号。
export const DEFAULT_BLOCK_SUMMARY = `【summary｜一针见血｜120~200 字】

写给普通人看，不是写研报。用一整段高深的大白话把事情说透，不列点、不写标题、不复述新闻，一针见血，直指本质。
只做三件事：抓住一个最硬的事实，点破背后的真实算盘，说清它会伤到谁、利好谁或把品牌带去哪里。

口吻暴躁、毒辣，但要说人话，不要为骂而骂。短句优先，删掉所有能删的铺垫。
每篇都要根据文章里最值得说的矛盾选择角度，不要连续使用相同开头、句式和结尾。
只认正文证据，不编动机。允许正面判断，不要为了显得深刻强行唱衰。
禁止这些空话：据悉、文章指出、值得关注、说白了、有待观察、未来可期、既有..也有..、战略布局、生态闭环、赋能增长、这波操作、行业信号很明确。

最终只输出 summary 正文。`;

// 标签提取块:产出 tags(细分类目标签,数组,3 条以内)
// 设计目标:精准细分类目,用于卡片标签展示和筛选。避免宽泛同义词。
export const DEFAULT_BLOCK_TAGS = `【tags 细分主题标签——最多 3 条】
- 输出 {"n":"标签名","t":"色调"}，最多 3 条
- n: 文中核心事物或趋势，2~4 字，具体不宽泛不重复
- t: 好坏属性，看颜色即知：
  正 = 好消息（成功/增长/突破）  ·  负 = 坏消息（失败/处罚/危机）
  警 = 需警惕（承压/收紧/隐患）  ·  机 = 有机会（新赛道/蓝海/可复制）
  中 = 纯信息（无明显好坏倾向）`;

// ════════════════════════════════════════════════════════════════
// 块元数据(供前端校验 / 提示 / 渲染用)
// ════════════════════════════════════════════════════════════════

export type PromptBlockId =
  | 'ad'
  | 'eventScore'
  | 'category'
  | 'relevance'
  | 'contentScore'
  | 'keyPoints'
  | 'summary'
  | 'tags'
  | 'brand';

export interface PromptBlockMeta {
  /** Setting 表 key */
  key:
    | 'ai_block_ad'
    | 'ai_block_event_score'
    | 'ai_block_category'
    | 'ai_block_relevance'
    | 'ai_block_content_score'
    | 'ai_block_key_points'
    | 'ai_block_summary'
    | 'ai_block_tags'
    | 'ai_block_brand';
  /** 块 id */
  id: PromptBlockId;
  /** 中文标签 */
  label: string;
  /** 默认块文本 */
  defaultBlock: string;
  /** 评分影响说明,展示在 Textarea 下方 */
  scoreHint: string;
}

export const PROMPT_BLOCK_META: Record<PromptBlockId, PromptBlockMeta> = {
  ad: {
    id: 'ad',
    key: 'ai_block_ad',
    label: '广告判定',
    defaultBlock: DEFAULT_BLOCK_AD,
    scoreHint: '独立判定广告概率，供本地评分策略扣分或封顶。',
  },
  eventScore: {
    id: 'eventScore',
    key: 'ai_block_event_score',
    label: '事件评分',
    defaultBlock: DEFAULT_BLOCK_EVENT_SCORE,
    scoreHint: '事件本身在连锁消费行业的影响力（0-100）。',
  },
  category: {
    id: 'category',
    key: 'ai_block_category',
    label: '行业分类',
    defaultBlock: DEFAULT_BLOCK_CATEGORY,
    scoreHint: '输出「行业分类」标签(餐饮/零售/品牌/加盟/其他)，用于文章归类。',
  },
  relevance: {
    id: 'relevance',
    key: 'ai_block_relevance',
    label: '相关度',
    defaultBlock: DEFAULT_BLOCK_RELEVANCE,
    scoreHint: '与连锁消费行业的相关度（0-100），只作为推送资格门槛。',
  },
  contentScore: {
    id: 'contentScore',
    key: 'ai_block_content_score',
    label: '内容评分',
    defaultBlock: DEFAULT_BLOCK_CONTENT_SCORE,
    scoreHint: '文章的信息密度、数据、信源和可验证性（0-100）。',
  },
  keyPoints: {
    id: 'keyPoints',
    key: 'ai_block_key_points',
    label: '要点提取',
    defaultBlock: DEFAULT_BLOCK_KEY_POINTS,
    scoreHint: '1~5 条极简情报(每条50字以内):谁+做了什么+结果。过滤形容词/套话/铺垫,像电报一样干净。',
  },
  summary: {
    id: 'summary',
    key: 'ai_block_summary',
    label: '洞察',
    defaultBlock: DEFAULT_BLOCK_SUMMARY,
    scoreHint: '120~200 字，抓住硬事实、点破真实算盘并给出锋利判断。',
  },
  tags: {
    id: 'tags',
    key: 'ai_block_tags',
    label: '标签提取',
    defaultBlock: DEFAULT_BLOCK_TAGS,
    scoreHint: '最多 3 条细分主题标签(2~4 字),用于卡片角标展示。要细不要宽,避免同义重复。',
  },
  brand: {
    id: 'brand',
    key: 'ai_block_brand',
    label: '品牌提取',
    defaultBlock: DEFAULT_BLOCK_BRAND,
    scoreHint: '提取文章涉及的品牌/公司名（最多 2 个 JSON 数组项），用于卡片和搜索过滤。无主体则输出空数组。',
  },
};

/** 按显示顺序排列的块(打分组 + 内容组) */
export const PROMPT_BLOCK_ORDER: PromptBlockId[] = [
  'ad',
  'eventScore',
  'contentScore',
  'category',
  'relevance',
  'keyPoints',
  'summary',
  'tags',
  'brand',
];

/** Setting 表里所有 prompt 块相关的 key */
export type PromptBlockKey =
  | 'ai_block_ad'
  | 'ai_block_event_score'
  | 'ai_block_category'
  | 'ai_block_relevance'
  | 'ai_block_content_score'
  | 'ai_block_key_points'
  | 'ai_block_summary'
  | 'ai_block_tags'
  | 'ai_block_brand';

// ════════════════════════════════════════════════════════════════
// Prompt 拼接函数 —— 把公共框架 + 用户块拼成完整 prompt
// 公共框架(任务说明/占位符/JSON输出格式)固定,用户块插中间。
// 产出 JSON 字段与 deepAnalyze 的严格解析契约保持一致。
// ════════════════════════════════════════════════════════════════

/** 9 个块的当前文本（DB 值或空串时使用默认值）。 */
interface PromptBlockInput {
  blockAd?: string;
  blockEventScore?: string;
  blockCategory?: string;
  blockRelevance?: string;
  blockContentScore?: string;
  blockKeyPoints?: string;
  blockSummary?: string;
  blockTags?: string;
  blockBrand?: string;
}

function pickBlock(custom: string | undefined, id: PromptBlockId): string {
  const meta = PROMPT_BLOCK_META[id];
  return custom && custom.trim() ? custom : meta.defaultBlock;
}

/**
 * 拼完整 prompt(广告判定 + 事件评分 + 行业分类 + 相关度 +
 * 内容评分 + 要点 + 洞察 + 标签 + 品牌提取),单次 LLM 调用产出全部字段。
 */
export function buildStep2Prompt(
  blocks: PromptBlockInput,
  content: string,
): string {
  const adBlock = pickBlock(blocks.blockAd, 'ad');
  const eventBlock = pickBlock(blocks.blockEventScore, 'eventScore');
  const categoryBlock = pickBlock(blocks.blockCategory, 'category');
  const relevanceBlock = pickBlock(blocks.blockRelevance, 'relevance');
  const contentBlock = pickBlock(blocks.blockContentScore, 'contentScore');
  const keyPointsBlock = pickBlock(blocks.blockKeyPoints, 'keyPoints');
  const summaryBlock = pickBlock(blocks.blockSummary, 'summary');
  const tagsBlock = pickBlock(blocks.blockTags, 'tags');
  const brandNameBlock = pickBlock(blocks.blockBrand, 'brand');

  return [
    '你是连锁消费行业资深分析师。先抽取事实，再独立评分，最后生成精简、口语化、一针见血的洞察。',
    '',
    '执行顺序：先确定品牌与核心事实；再仅依据事实独立完成广告、事件、相关度和内容评分；最后写 summary。后面的观点不得反向修改或夸大事实。各原始维度不受用户权重、推送门槛或文风影响。',
    '文章内容：',
    '{content}',
    '',
    '请严格按照以下 JSON 格式输出，不要输出任何其他内容：',
    '{',
    '  "is_ad": <true/false，是否为广告>,',
    '  "ad_probability": <0-100整数，广告/软文概率>,',
    '  "confidence": <0-100整数，正文完整度、来源明确度、数字可验证性共同决定的证据充分度>,',
    '  "event_score": <0-100整数，事件在连锁消费行业的影响力>,',
    '  "category": "<行业分类>",',
    '  "relevance": <0-100整数，与餐饮/零售连锁品牌行业的相关性>,',
    '  "content_score": <0-100整数，文章信息密度和可验证性>,',
    '  "summary": "<80-200字洞察：硬事实+真实算盘+影响判断，口语、锋利、不套路>",',
    '  "brand": ["<品牌1>", "<品牌2>"],',
    '  "tags": [{"n":"<标签名>","t":"<正/负/中/警/机>"}],',
    '  "key_points": ["<核心事实,按 key_points 块规则>"]',
    '}',
    '',
    summaryBlock,
    '',
    adBlock,
    '',
    eventBlock,
    '',
    categoryBlock,
    '',
    relevanceBlock,
    '',
    contentBlock,
    '',
    keyPointsBlock,
    '',
    tagsBlock,
    '',
    brandNameBlock,
    '',
    '严格输出 JSON，不要包含注释。',
  ]
    .join('\n')
    // 使用替换函数，避免 content 中的 $& / $' / $` / $n 被当作替换模板解析
    .replace(/\{content\}/g, () => content);
}

// ════════════════════════════════════════════════════════════════
// 打分权重元数据（动态权重，设置区可调）
// ════════════════════════════════════════════════════════════════

export interface ScoreWeightMeta {
  key: 'ai_weight_event' | 'ai_weight_content';
  label: string;
  sourceMax: number;
  defaultWeight: number;
}

export const SCORE_WEIGHT_META = {
  event: {
    key: 'ai_weight_event',
    label: '事件重要性',
    sourceMax: 100,
    defaultWeight: 75,
  },
  content: {
    key: 'ai_weight_content',
    label: '内容质量',
    sourceMax: 100,
    defaultWeight: 25,
  },
} as const;

export type ScoreWeightKey = 'ai_weight_event' | 'ai_weight_content';
