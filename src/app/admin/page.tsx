import AdminShell from '@/components/admin-shell'

type SearchParams = Record<string, string | string[] | undefined>

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? ''
}

export default async function AdminPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams
  const tab = first(params.tab)
  const initialTab = tab === 'crawl-log' || tab === 'settings' ? tab : 'articles'
  return <AdminShell initialTab={initialTab} />
}
