// 轴（日历/历法/刻度）的共享可变视图与生成状态；使用对象属性供宿主读写，避免重赋 ESM 导入绑定。
export const axisState = {
    almanacMode: false,              // 历（日历）视图是否激活
    isGeneratingAlmanac: false,
    almanacAbortController: null,
    _almGenLabel: '正在编排历法',     // 历生成中 loading 文案：整历生成 vs 增量补录纪念日 共用同一把锁，仅文案区分
    _almanacSheet: 'upcoming',       // 轴子视图：'upcoming'（即将到来清单）| 'calendar'（月历网格）| 'ledger'（刻度）
    _almanacCalMonth: null,          // 月历当前月份（0-11）；null -> 首次渲染取真实今天所在月。历不挂年，只按月/日
    _almanacCalDay: null,            // 月历里选中的某天（1-31）；null -> 详情区显示整月
    _almanacEditor: null,            // 内联添加/编辑态：{ id, prefill } 或 null
    _almanacManager: null,           // 历法管理子页：编辑草稿与局部错误状态
    _almTodayEditing: false,         // 历面板「今天」栏的内联改日期态
    _almSyncingPoint: false,         // 点后台同步今天忙碌态
    timeTravelState: null,
};
