'use client'

import { useRef, useState } from 'react'
import { Download, FileSpreadsheet, FileUp, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { downloadBlob, dateStamp } from '@/lib/browser-utils'
import { exportKeywordsXlsxBlob, importKeywordsXlsx } from '@/features/keywords-api.client'

export default function KeywordExportCard() {
  const [keywordBusy, setKeywordBusy] = useState<'export' | 'import' | null>(null)
  const keywordInputRef = useRef<HTMLInputElement>(null)

  const handleKeywordExport = async () => {
    setKeywordBusy('export')
    try {
      downloadBlob(await exportKeywordsXlsxBlob(), `关键词表格-${dateStamp()}.xlsx`)
      toast.success('关键词表格已导出')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导出关键词表格失败')
    } finally {
      setKeywordBusy(null)
    }
  }

  const handleKeywordImport = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    setKeywordBusy('import')
    try {
      const result = await importKeywordsXlsx(file)
      toast.success(`已导入 ${result.imported} 个关键词，候选词状态已同步`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : '导入失败，请检查 XLSX 工作簿格式')
    } finally {
      setKeywordBusy(null)
    }
  }

  return (
    <Card className="py-0">
      <CardContent className="flex flex-wrap items-start gap-3 p-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
            关键词表格
          </div>
          <p className="mt-1 text-xs text-muted-foreground">批量编辑关键词和候选词，状态由工作表名称表达。</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-xs" disabled={keywordBusy !== null} onClick={() => void handleKeywordExport()}>
            {keywordBusy === 'export' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            导出 XLSX
          </Button>
          <Button type="button" size="sm" variant="outline" className="h-7 gap-1.5 px-2.5 text-xs" disabled={keywordBusy !== null} onClick={() => keywordInputRef.current?.click()}>
            {keywordBusy === 'import' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileUp className="h-3.5 w-3.5" />}
            导入 XLSX
          </Button>
          <input ref={keywordInputRef} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="hidden" onChange={(event) => void handleKeywordImport(event)} />
        </div>
      </CardContent>
    </Card>
  )
}