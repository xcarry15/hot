# Repository Guidelines

## Project Structure & Module Organization

Hot2 is a Next.js 16 App Router application with React 19, TypeScript, Prisma, and SQLite. Keep changes within these boundaries:

- `src/app/`: public pages, the token-protected `/admin` shell, and API route handlers. Public article pages are under `src/app/news/`; `robots.ts` and `sitemap.ts` define indexing boundaries.
- `src/components/`: UI; `intelligence-inbox.tsx` is the default admin workbench, while `src/features/` and `src/contracts/` contain client helpers and shared contracts.
- `src/lib/`: server services and pipeline code. Collection, processing, event clustering, analysis, push, review, and public visibility rules live here; keep business rules in services rather than components or Route Handlers. Article remains the AI/manual-calibration record; Event is the only public/push deduplication gate and `Event.publicStatus` is the public truth. Article publication fields are only the current representative projection; non-representative members stay unpublished. Representative selection must require `clustered`, AI done, and a non-deleted source; source public enablement remains an independent publication gate. Manual representative changes must satisfy the same base eligibility.
- `prisma/`: schema, seed data, and ordered migrations; `tests/`: Vitest tests.
- `scripts/`: maintenance/migration utilities; `bat/`: Windows deployment and operations files; `public/`: static assets.

The admin navigation is intentionally limited to `任务中心`, `内容管理`, and `设置`. The public `工具` and `数据` links are placeholders until their routes are implemented.

Keep interaction performance proportional to the project scale: top-level admin pages and heavy settings sections are lazy-loaded, article detail requests may use a short-lived client cache with explicit invalidation after writes, and crawl-log polling is adaptive (fast only while a Job is running, slow while idle, paused while hidden). Crawl-log source groups include only enabled, non-deleted sources; disabled-source history and stale Job source results stay hidden from this operational view. The crawl-log keeps its bounded recent Article window but must additionally merge every current manual/auto-retry technical work item by Article id, so actionable failures never disappear outside the recent window. Technical failures use finite automatic retries, then become manual work or may be ignored without deleting the Article. Do not replace these lightweight measures with Redis, a message queue, or broad compatibility layers without measured need.

Admin responsibility boundaries are fixed: `任务中心` owns Job monitoring and technical recovery; `内容管理` owns Article content calibration, human review, Event correction, publication decisions, and Event-level manual push. Single-article retries/regeneration must use `POST /api/articles/[id]/workflow`: `retry` is restricted to a recoverable failed stage, while `regenerate` resets and recomputes from the requested stage and cannot be used for full repush. Push delivery modes are fixed as `normal`, `retry_failed`, and `repush_all`; latest enabled-target PushLog state is the shared truth, and push failures belong only to the Event representative Article. Crawl-log DTOs may expose the final effective score after AI completion plus lightweight `ad`/`duplicate` display labels; they must not expose score breakdowns, ad probability, confidence, or content-category fields. Do not recreate browser-memory queues or removed routes. `needs_review` may continue AI analysis but must never become the representative article, be public, or be pushed. Batch process/cluster/AI stages must drain all currently eligible backlog before a Job is marked completed; fixed query sizes are chunk sizes, not completion boundaries.

Use the architecture and database sections in `README.md` as the repository reference and keep them synchronized with source code and migrations. `DESIGN.md` is visual reference only and must not be treated as product or architecture truth.

## Build, Test, and Development Commands

Install dependencies and copy `.env.example` to `.env` for local setup. Use:

- `npm run dev` — start the development server at `http://localhost:3011`.
- `npm run lint` — run ESLint.
- `npx tsc --noEmit` — type-check without emitting files.
- `npm test` — run the default Vitest suite (excluding the database baseline test).
- `npm run test:critical` or `npm run test:all` — run the critical suite or every test.
- `npm run build` — create the production build; `npm run start` — serve it.
- `npm run db:migrate` — create/apply a local development migration; `npm run db:generate` — regenerate Prisma Client.
- `npm run db:migrate:status` — verify migration state before delivery.
- `npm run db:optimize` — enable/verify SQLite WAL runtime settings and run `PRAGMA optimize` after migrations.

Use `npm run db:migrate:deploy` for production migrations. Do not use `db:push` or `db:reset` for routine production work.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, single quotes, semicolons, and the `@/*` import alias. Prefer small typed functions and existing service boundaries. Name components and types in PascalCase, functions and variables in camelCase, and tests as `*.test.ts`. Keep public visibility rules in `src/lib/public-article-service.ts`, setting definitions in `src/lib/settings-catalog.ts`, and review workflows in `src/lib/review-service.ts`. Run ESLint before submitting.

## Testing Guidelines

Vitest discovers tests under `tests/`. Add or update regression tests for pipeline, deduplication, API, database, cancellation, or push-delivery changes. Run the relevant file first, then `npm test`; run `npm run test:db-baseline` separately for migration changes. No coverage threshold is configured.

## Commit & Pull Request Guidelines

Follow the existing Conventional Commit style, such as `feat: add source retry` or `fix: preserve partial push results`. PRs should explain the change, list validation commands, link an issue, and include screenshots for UI changes. Call out schema/migration, environment, or deployment impacts.

## Security & Configuration

Never commit `.env`, API keys, Webhook URLs, SQLite data, or deployment archives. Production requires `API_TOKEN`; set `NEXT_PUBLIC_SITE_URL` for canonical URLs and sitemap generation. Back up the database before migrations, and never reset a user database to resolve drift.
