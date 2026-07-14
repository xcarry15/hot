'use client';

import { ReactNode } from 'react';
import { FileX, Inbox } from 'lucide-react';

interface EmptyStateProps {
  /** 主标题（必填） */
  title: string;
  /** 副标题/引导文案 */
  description?: string;
  /** 主图标（默认 Inbox） */
  icon?: ReactNode;
  /** CTA 按钮或链接（可选） */
  action?: ReactNode;
  /** 自定义 className */
  className?: string;
}

/**
 * 统一空状态组件
 *
 * 设计原则：图标 + 主文案 + 副文案 + 可选 CTA，与 crawl-log-tab 实时视图空状态对齐
 */
export function EmptyState({
  title,
  description,
  icon,
  action,
  className = 'py-12',
}: EmptyStateProps) {
  return (
    <div className={`text-center ${className}`}>
      <div className="text-muted-foreground/30 mx-auto mb-3 flex justify-center">
        {icon ?? <Inbox className="h-8 w-8" aria-hidden="true" />}
      </div>
      <p className="text-sm font-medium text-muted-foreground">{title}</p>
      {description && (
        <p className="text-xs text-muted-foreground/70 mt-1.5 max-w-xs mx-auto">{description}</p>
      )}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** 常用：无数据的紧凑空状态 */
export function EmptyData({ message = '暂无数据' }: { message?: string }) {
  return <EmptyState title={message} icon={<FileX className="h-8 w-8" aria-hidden="true" />} />;
}
