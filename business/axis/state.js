// 轴（七天历/历法）视图与生成状态 —— Phase 2 数据层归位：从 index.js 模块级 let 搬入。
// 可变状态容器对象：index.js 通过 axisState.X 读写，纯机械引用替换（almanacMode -> axisState.almanacMode），
// 未改任何业务逻辑（读写点/顺序/控制流完全一致），仅规避 ES 模块导入绑定不可重赋值的限制。
export const axisState = {
    almanacMode: false,              // 历（日历）视图是否激活
    isGeneratingAlmanac: false,
    almanacAbortController: null,
    _almGenLabel: '正在编排历法',     // 历生成中 loading 文案：整历生成 vs 增量补录纪念日 共用同一把锁，仅文案区分
    _almanacSheet: 'upcoming',       // 历子视图：'upcoming'（即将到来清单）| 'calendar'（月历网格）
    _almanacCalMonth: null,          // 月历当前月份（0-11）；null -> 首次渲染取真实今天所在月。历不挂年，只按月/日
    _almanacCalDay: null,            // 月历里选中的某天（1-31）；null -> 详情区显示整月
    _almanacEditor: null,            // 内联添加/编辑态：{ id, prefill } 或 null
    _almanacManager: null,           // 历法管理子页：编辑草稿与局部错误状态
    _almTodayEditing: false,         // 历面板「今天」栏的内联改日期态
    _almSyncingPoint: false,         // 历面板「同步到点」进行态
    timeTravelState: null,
};
