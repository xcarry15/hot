export type WorkflowStage = 'collect' | 'process' | 'ai' | 'cluster' | 'push';
export type WorkflowAction = WorkflowStage | 'all';

export const WORKFLOW_STAGES: readonly WorkflowStage[] = ['collect', 'process', 'ai', 'cluster', 'push'];
export const WORKFLOW_STAGE_LABELS: Record<WorkflowStage, string> = {
  collect: '采集',
  process: '处理',
  ai: 'AI',
  cluster: '聚类',
  push: '推送',
};
export const WORKFLOW_SINGLE_STAGES: Record<WorkflowStage, WorkflowStage[]> = {
  collect: ['collect'],
  process: ['process', 'ai', 'cluster'],
  cluster: ['cluster'],
  ai: ['ai', 'cluster'],
  push: ['push'],
};

export const WORKBENCH_STEP_BUTTON_CLASS = 'h-6 w-full px-0 text-[11px] sm:h-7 sm:w-[52px] sm:px-2 sm:text-xs';
export const WORKBENCH_TOGGLE_CLASS = 'flex h-6 items-center justify-center gap-0.5 border border-border/70 bg-background/60 px-0.5 text-[10px] text-muted-foreground select-none cursor-pointer sm:h-auto sm:gap-1 sm:border-0 sm:bg-transparent sm:px-0 sm:text-xs';
export const WORKBENCH_SWITCH_CLASS = 'scale-75';
export const WORKBENCH_ACTION_CLASS = 'h-6 w-full gap-0.5 px-1 text-[11px] sm:h-7 sm:w-auto sm:gap-1 sm:px-2 sm:text-xs';
export const WORKBENCH_PRIMARY_ACTION_CLASS = `${WORKBENCH_ACTION_CLASS} whitespace-nowrap sm:px-2.5`;
