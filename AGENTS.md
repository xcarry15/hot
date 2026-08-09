# Repository Guidelines

## Truth Sources

- Treat current code, configuration, Prisma schema, ordered migrations, and workflow files as runtime truth.
- Use `README.md` for the current product, architecture, commands, and deployment entry points.
- Use `CONTEXT.md` only for domain language. Use `docs/design/DESIGN.md` only for the public visual profile.
- Update the relevant document in the same change when behavior, commands, migrations, deployment, or canonical terminology changes. Remove completed implementation plans instead of maintaining duplicate specifications.

## Project Boundaries

开发选址助手 is a Next.js 16 App Router application with React 19, TypeScript, Prisma 6, SQLite, and Vitest.

- `src/app/`: public pages, `/admin`, Route Handlers, `robots.ts`, and `sitemap.ts`.
- `src/components/`: UI. `public-tools/` is the public tool-directory module; `intelligence-inbox.tsx` and the article workspace own the unified admin workbench.
- `src/features/`: browser API clients. Components must not recreate request logic already available here.
- `src/contracts/`: shared DTOs and state contracts.
- `src/lib/`: services, pipeline, scheduling, publication, push, export, and maintenance rules. Keep business rules here rather than in components or Route Handlers.
- `prisma/`: schema, seed, and the only supported ordered migration chain.
- `tests/`: Vitest coverage; `scripts/`: production and maintenance scripts; `bat/`: Windows initialization, packaging, and operations.

## Domain Invariants

- `Article` is the source-content, AI-result, and manual-calibration record.
- `Event` is the only public and push deduplication boundary. `Event.publicStatus` is public truth; Article publication fields are the current representative projection.
- AI extracts `subjects / action / object`; the application deterministically builds `eventKey`. Clustering must not call AI again for identity.
- Every active Event has at most one representative Article. Non-representatives remain unpublished and are not pushed.
- Representative eligibility requires `clustered`, AI `done`, and a non-deleted source. Manual representative changes use the same eligibility. Source public enablement remains an independent publication gate.
- `needs_review` is created only after AI analysis and cannot be representative, public, or pushed until the Event is confirmed.
- Latest enabled-target `PushDelivery` state is current delivery truth. `PushLog` is historical audit only; push failures belong to the representative Article.

## Admin and Public Surfaces

- Top-level admin navigation stays limited to `工作台` and `设置`.
- `工作台` owns Job monitoring, operational source/job state, technical recovery, server-side article search, and opening the shared Article/Event drawer.
- The Article drawer owns content calibration, human review, Event correction, publication decisions, and Event-level manual push. Do not merge these service responsibilities into the task surface.
- Settings sections are lazy-loaded. Sensitive AI keys and Webhooks are revealed only through their protected path and must not be overwritten by ordinary saves before reveal succeeds.
- `/tools` reads non-archived `ToolDirectoryItem` rows. The seed snapshot runs only when the table is empty and is not a runtime fallback.
- Tool statuses are `active`, `beta`, `maintenance`, `coming_soon`, and `disabled`; only `active` or `beta` entries with a valid public HTTPS URL are clickable. Tags are `free`, `paid`, `popular`, `updated`, and `latest`.
- Public pages share `PublicPageShell`, the public header/footer, and `src/lib/public-brand.ts`. Keep public styling flat, square, low-decoration, and scoped away from admin UI.

## Workflow and Performance Rules

- Single-article recovery uses `POST /api/articles/[id]/workflow`: `retry` handles the current recoverable failure; `regenerate` resets and recomputes from the requested stage. Neither is a full repush shortcut.
- Push delivery modes stay `normal`, `retry_failed`, `manual_force`, and `repush_all`. `manual_force` may bypass score, relevance, and the automatic switch, but still requires an active Event, eligible representative, completed AI, and completed clustering.
- Batch process, AI, and cluster stages drain all currently eligible backlog before a Job completes. Query limits are chunk sizes, not completion boundaries.
- Technical failures use finite automatic retries, then become manual work or may be ignored without deleting the Article.
- Crawl-log source groups include enabled, non-deleted sources only. Merge every current manual/auto-retry technical item by Article ID so actionable failures cannot disappear outside the bounded recent window.
- Keep crawl polling adaptive: fast while a Job runs, slow while idle, paused while hidden. Keep article-detail cache short-lived and invalidate it after writes.
- Crawl-log DTOs may expose the final effective score after AI completion plus lightweight ad/duplicate labels. Do not expose score breakdowns, ad probability, confidence, or content-category fields there.
- Prefer these lightweight database-backed mechanisms. Do not add Redis, a message queue, browser-memory work queues, or compatibility layers without measured need.

## Database and Deployment

- `prisma/migrations/` is the complete supported migration set. Production with an unexpected or incomplete history must be backed up and rebuilt; there is no historical compatibility bridge.
- Routine production migration uses `npm run db:migrate:deploy`. Never use `db:push` or `db:danger:reset` in production.
- Deployment archives are unpacked outside the app directory, then synchronized with `rsync --delete` while preserving `.env*`, `db/`, and `node_modules/`.
- Stop PM2 and create a consistent SQLite `.backup` before normal production migrations. PM2 runs one `h2-hot2` instance.
- `reset_production=yes` deletes production SQLite without backup. Use it only after explicit approval to lose production data.
- Routine application releases do not clear the server-wide Nginx cache or reload Nginx.

## Commands

- `npm run dev` — development server at `http://localhost:3011`.
- `npm run lint` — ESLint; `npm run typecheck` — TypeScript without emit.
- `npm test` — default Vitest suite; `npm run test:critical` — critical business suite.
- `npm run test:migrations` — clean SQLite migration path; `npm run test:all` — default plus migration smoke.
- `npm run verify` — lint, typecheck, all tests, and production build.
- `npm run build` / `npm run start` — production build and port `3011` service.
- `npm run db:migrate:status`, `npm run db:migrate:deploy`, `npm run db:generate`, and `npm run db:optimize` — routine database operations.

## Code and Delivery Style

- Use strict TypeScript, two-space indentation, single quotes, semicolons, and the `@/*` alias.
- Prefer small typed functions and existing service boundaries. Components and Route Handlers should orchestrate, not own business policy.
- Name components and types in PascalCase, functions and variables in camelCase, and tests `*.test.ts`.
- Keep setting definitions in `src/lib/settings-catalog.ts`, publication policy in the public/event services, feedback in `src/lib/feedback-service.ts`, and Excel export in `src/lib/export/`.
- Add or update regression tests for pipeline, deduplication, API, database, cancellation, push-delivery, schema, or migration changes. Run the relevant test first, then the proportional suite.
- Follow Conventional Commits. PRs explain scope, validation, schema/deployment impact, and include screenshots for UI changes.
- Never commit `.env`, credentials, Webhooks, SQLite data, export files, or deployment archives.
