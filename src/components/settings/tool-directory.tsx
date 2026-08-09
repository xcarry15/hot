'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  TOOL_CATEGORY_DEFINITIONS,
  TOOL_DIRECTORY_ICON_NAMES,
  TOOL_DIRECTORY_STATUSES,
  TOOL_DIRECTORY_TAG_DEFINITIONS,
  isToolDirectoryLinkableStatus,
  type ToolDirectoryItemDto,
  type ToolDirectoryTag,
} from '@/contracts/tool-directory';
import {
  archiveToolDirectoryItem,
  createToolDirectoryItem,
  fetchToolDirectory,
  moveToolDirectoryItem,
  restoreToolDirectoryItem,
  updateToolDirectoryItem,
  type ToolDirectoryInput,
} from '@/features/tool-directory-api.client';
import { isRequestAborted } from '@/lib/request-json.client';
import PublicToolIcon from '@/components/public-tools/tool-icons';
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';

type ToolFormState = Omit<ToolDirectoryInput, 'href'> & { href: string };

const EMPTY_FORM: ToolFormState = {
  name: '',
  description: '',
  category: TOOL_CATEGORY_DEFINITIONS[0].id,
  href: '',
  icon: TOOL_DIRECTORY_ICON_NAMES[0],
  status: 'active',
  tags: [],
};

const STATUS_LABELS: Record<(typeof TOOL_DIRECTORY_STATUSES)[number], string> = {
  active: '正常',
  beta: '内测中',
  maintenance: '维护中',
  coming_soon: '即将上线',
  disabled: '停用',
};

function toFormState(tool: ToolDirectoryItemDto): ToolFormState {
  return {
    name: tool.name,
    description: tool.description,
    category: tool.category,
    href: tool.href ?? '',
    icon: tool.icon,
    status: tool.status,
    tags: [...tool.tags],
  };
}

function statusClass(status: ToolDirectoryItemDto['status']): string {
  if (status === 'beta') return 'text-amber-700';
  if (status === 'maintenance') return 'text-orange-700';
  if (status === 'coming_soon') return 'text-sky-700';
  if (status === 'disabled') return 'text-muted-foreground';
  return 'text-emerald-700';
}

export default function ToolDirectoryManagement() {
  const [tools, setTools] = useState<ToolDirectoryItemDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<ToolFormState>(EMPTY_FORM);
  const [archiveTarget, setArchiveTarget] = useState<ToolDirectoryItemDto | null>(null);

  const loadTools = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setLoadError(false);
    try {
      setTools(await fetchToolDirectory(true, signal));
    } catch (error) {
      // StrictMode 首次挂载会取消第一轮请求；取消不应覆盖随后成功的重读结果。
      if (isRequestAborted(error)) return;
      setLoadError(true);
      toast.error('获取工具目录失败');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadTools(controller.signal);
    return () => controller.abort();
  }, [loadTools]);

  const visibleTools = useMemo(
    () => tools.filter((tool) => showArchived || !tool.archivedAt),
    [showArchived, tools],
  );

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM, tags: [] });
    setIconPickerOpen(false);
    setDialogOpen(true);
  };

  const openEdit = (tool: ToolDirectoryItemDto) => {
    setEditingId(tool.id);
    setForm(toFormState(tool));
    setIconPickerOpen(false);
    setDialogOpen(true);
  };

  const setFormValue = <K extends keyof ToolFormState>(key: K, value: ToolFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const toggleTag = (tag: ToolDirectoryTag) => {
    setForm((current) => ({
      ...current,
      tags: current.tags.includes(tag)
        ? current.tags.filter((value) => value !== tag)
        : [...current.tags, tag],
    }));
  };

  const handleSave = async () => {
    if (!form.name.trim() || !form.description.trim()) {
      toast.error('名称和简介为必填项');
      return;
    }
    if (isToolDirectoryLinkableStatus(form.status) && !form.href.trim()) {
      toast.error('正常或内测工具必须填写 HTTPS 链接');
      return;
    }
    setSaving(true);
    try {
      const input: ToolDirectoryInput = { ...form, href: form.href.trim() || null, tags: [...form.tags] };
      if (editingId) {
        await updateToolDirectoryItem(editingId, input);
        toast.success('工具已更新');
      } else {
        await createToolDirectoryItem(input);
        toast.success('工具已添加');
      }
      setDialogOpen(false);
      await loadTools();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '保存工具失败');
    } finally {
      setSaving(false);
    }
  };

  const handleArchive = async () => {
    if (!archiveTarget) return;
    setBusyId(archiveTarget.id);
    try {
      await archiveToolDirectoryItem(archiveTarget.id);
      toast.success('工具已下架');
      setArchiveTarget(null);
      await loadTools();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '下架工具失败');
    } finally {
      setBusyId(null);
    }
  };

  const handleRestore = async (tool: ToolDirectoryItemDto) => {
    setBusyId(tool.id);
    try {
      await restoreToolDirectoryItem(tool.id);
      toast.success('工具已恢复');
      await loadTools();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '恢复工具失败');
    } finally {
      setBusyId(null);
    }
  };

  const handleMove = async (tool: ToolDirectoryItemDto, direction: 'up' | 'down') => {
    setBusyId(`${tool.id}:${direction}`);
    try {
      await moveToolDirectoryItem(tool.id, direction);
      await loadTools();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '调整排序失败');
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return <div className="space-y-2 p-3"><div className="h-8 animate-pulse bg-muted" /><div className="h-24 animate-pulse bg-muted" /><div className="h-24 animate-pulse bg-muted" /></div>;
  }

  if (loadError) {
    return (
      <div className="flex min-h-60 flex-col items-center justify-center gap-3 p-6 text-center">
        <p className="text-sm font-medium">工具目录读取失败</p>
        <Button type="button" variant="outline" size="sm" onClick={() => void loadTools()}>重新读取</Button>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col gap-3 p-2 text-xs">
      <div className="flex flex-wrap items-center gap-2 border-b pb-2">
        <div className="mr-auto">
          <p className="font-medium">工具中心目录</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">管理公开工具入口、分类、状态和标签</p>
        </div>
        <Button type="button" size="sm" variant="outline" className="h-7 gap-1 px-2 text-xs" onClick={() => setShowArchived((value) => !value)}>
          {showArchived ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          {showArchived ? '隐藏已下架' : '查看已下架'}
        </Button>
        <Button type="button" size="sm" className="h-7 gap-1 px-2.5 text-xs" onClick={openCreate}>
          <Plus className="h-3.5 w-3.5" />
          新增工具
        </Button>
      </div>

      <div className="space-y-4">
        {TOOL_CATEGORY_DEFINITIONS.map((category) => {
          const categoryTools = visibleTools.filter((tool) => tool.category === category.id);
          if (categoryTools.length === 0 && !(showArchived && tools.some((tool) => tool.category === category.id))) return null;
          const activeCategoryTools = categoryTools.filter((tool) => !tool.archivedAt);
          return (
            <section key={category.id} className="space-y-1.5">
              <div className="flex items-center gap-2 border-b px-1 pb-1.5">
                <h2 className="font-medium">{category.label}</h2>
                <span className="text-[11px] text-muted-foreground">{activeCategoryTools.length} 项</span>
              </div>
              <div className="space-y-px">
                {categoryTools.map((tool) => {
                  const activeIndex = activeCategoryTools.findIndex((activeTool) => activeTool.id === tool.id);
                  return (
                  <div key={tool.id} className={`flex flex-wrap items-center gap-2 border px-2 py-2 ${tool.archivedAt ? 'bg-muted/30 opacity-70' : 'bg-background'}`}>
                    <span className="flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground">
                      <PublicToolIcon name={tool.icon} />
                    </span>
                    <div className="min-w-0 flex-1 basis-44">
                      <div className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate font-medium">{tool.name}</span>
                        <span className={`shrink-0 ${statusClass(tool.status)}`}>{STATUS_LABELS[tool.status]}</span>
                        {tool.href && (
                          <a href={tool.href} target="_blank" rel="noopener noreferrer" className="inline-flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-[10px] text-muted-foreground hover:text-foreground" title={tool.href}>
                            <ExternalLink className="h-3 w-3 shrink-0" />
                            <span className="truncate">{tool.href}</span>
                          </a>
                        )}
                      </div>
                      <p className="mt-0.5 line-clamp-1 text-[11px] text-muted-foreground">{tool.description}</p>
                    </div>
                    <div className="flex max-w-full flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                      {tool.tags.map((tag) => (
                        <Badge key={tag} variant="outline" className="h-5 rounded-none px-1.5 text-[10px]">
                          {TOOL_DIRECTORY_TAG_DEFINITIONS.find((definition) => definition.id === tag)?.label ?? tag}
                        </Badge>
                      ))}
                    </div>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {!tool.archivedAt && (
                        <>
                          <Button type="button" size="sm" variant="ghost" className="h-6 w-6 p-0" disabled={busyId !== null || activeIndex === 0} onClick={() => void handleMove(tool, 'up')} title="上移">
                            {busyId === `${tool.id}:up` ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowUp className="h-3 w-3" />}
                          </Button>
                          <Button type="button" size="sm" variant="ghost" className="h-6 w-6 p-0" disabled={busyId !== null || activeIndex === activeCategoryTools.length - 1} onClick={() => void handleMove(tool, 'down')} title="下移">
                            {busyId === `${tool.id}:down` ? <Loader2 className="h-3 w-3 animate-spin" /> : <ArrowDown className="h-3 w-3" />}
                          </Button>
                        </>
                      )}
                      <Button type="button" size="sm" variant="ghost" className="h-6 w-6 p-0" disabled={busyId !== null} onClick={() => openEdit(tool)} title="编辑">
                        <Pencil className="h-3 w-3" />
                      </Button>
                      {tool.archivedAt ? (
                        <Button type="button" size="sm" variant="ghost" className="h-6 w-6 p-0" disabled={busyId !== null} onClick={() => void handleRestore(tool)} title="恢复">
                          {busyId === tool.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <RotateCcw className="h-3 w-3" />}
                        </Button>
                      ) : (
                        <Button type="button" size="sm" variant="ghost" className="h-6 w-6 p-0 text-destructive hover:text-destructive" disabled={busyId !== null} onClick={() => setArchiveTarget(tool)} title="下架">
                          <Archive className="h-3 w-3" />
                        </Button>
                      )}
                    </div>
                  </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto rounded-none sm:max-w-2xl [&_[data-slot=dialog-close]]:rounded-none">
          <DialogHeader>
            <DialogTitle className="text-base">{editingId ? '编辑工具' : '新增工具'}</DialogTitle>
            <DialogDescription className="text-xs">保存后会立即更新公开工具中心。</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="tool-name" className="text-xs">名称 *</Label>
                <Input id="tool-name" value={form.name} onChange={(event) => setFormValue('name', event.target.value)} className="h-8 rounded-none text-xs" placeholder="工具名称" />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">分类 *</Label>
                <Select value={form.category} onValueChange={(value) => setFormValue('category', value as ToolFormState['category'])}>
                  <SelectTrigger className="h-8 rounded-none text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent className="rounded-none shadow-sm">
                    {TOOL_CATEGORY_DEFINITIONS.map((category) => <SelectItem key={category.id} value={category.id} className="rounded-none">{category.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tool-description" className="text-xs">简介 *</Label>
              <Textarea id="tool-description" value={form.description} onChange={(event) => setFormValue('description', event.target.value)} className="min-h-20 rounded-none text-xs" placeholder="简要说明工具用途" />
            </div>
            <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
              <div className="space-y-1.5">
                <Label className="text-xs">状态 *</Label>
                <Select value={form.status} onValueChange={(value) => setFormValue('status', value as ToolFormState['status'])}>
                  <SelectTrigger className="h-8 w-full rounded-none text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent className="rounded-none shadow-sm">
                    {TOOL_DIRECTORY_STATUSES.map((status) => <SelectItem key={status} value={status} className="rounded-none">{STATUS_LABELS[status]}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">HTTPS 链接</Label>
                <Input value={form.href} onChange={(event) => setFormValue('href', event.target.value)} className="h-8 rounded-none text-xs" placeholder="https://..." />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">标签</Label>
              <div className="flex flex-wrap gap-1.5">
                {TOOL_DIRECTORY_TAG_DEFINITIONS.map((tag) => {
                  const selected = form.tags.includes(tag.id);
                  return <Button key={tag.id} type="button" variant={selected ? 'default' : 'outline'} className="h-7 rounded-none px-2 text-xs" onClick={() => toggleTag(tag.id)}>{tag.label}</Button>;
                })}
              </div>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">图标</Label>
              <Button
                type="button"
                variant="outline"
                className="h-8 w-full justify-between rounded-none px-2 text-xs font-normal"
                aria-controls="tool-icon-picker"
                aria-expanded={iconPickerOpen}
                onClick={() => setIconPickerOpen((value) => !value)}
              >
                <span className="flex items-center gap-2">
                  <PublicToolIcon name={form.icon} />
                  <span>{form.icon}</span>
                </span>
                {iconPickerOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
              </Button>
              {iconPickerOpen && (
                <div id="tool-icon-picker" className="grid grid-cols-7 gap-1.5 border p-2 sm:grid-cols-10">
                  {TOOL_DIRECTORY_ICON_NAMES.map((icon) => (
                    <Button key={icon} type="button" variant={form.icon === icon ? 'default' : 'outline'} className="h-8 w-full rounded-none p-0" title={icon} onClick={() => setFormValue('icon', icon)}>
                      <PublicToolIcon name={icon} />
                    </Button>
                  ))}
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" className="rounded-none" onClick={() => setDialogOpen(false)}>取消</Button>
            <Button type="button" size="sm" className="rounded-none" disabled={saving} onClick={() => void handleSave()}>
              {saving && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              {saving ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={archiveTarget !== null} onOpenChange={(open) => { if (!open) setArchiveTarget(null); }}>
        <AlertDialogContent className="rounded-none">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-base">确认下架工具</AlertDialogTitle>
            <AlertDialogDescription className="text-sm">下架后工具会从公开工具中心隐藏，但可以在“已下架”列表中恢复。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="rounded-none text-xs">取消</AlertDialogCancel>
            <AlertDialogAction className="rounded-none bg-destructive text-xs hover:bg-destructive/90" onClick={() => void handleArchive()}>确认下架</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
