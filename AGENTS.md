# Repository Guidelines

## Project Structure & Module Organization

Hot2 is a Next.js 16 App Router application with React 19, TypeScript, Prisma, and SQLite. Keep changes within these boundaries:

- `src/app/`: pages and API route handlers.
- `src/components/`: UI; `src/features/` and `src/contracts/`: client helpers and shared contracts.
- `src/lib/`: server services and pipeline code. Collection, processing, analysis, and push stages live in `src/lib/pipeline/` and `src/lib/push/`.
- `prisma/`: schema, seed data, and ordered migrations; `tests/`: Vitest tests.
- `scripts/`: maintenance/migration utilities; `bat/`: Windows deployment and operations files; `public/`: static assets.

Use the architecture and database sections in `README.md` as the repository reference; keep them synchronized with the source code and migrations.

## Build, Test, and Development Commands

Install dependencies and copy `.env.example` to `.env` for local setup. Use:

- `npm run dev` — start the development server at `http://localhost:3011`.
- `npm run lint` — run ESLint.
- `npx tsc --noEmit` — type-check without emitting files.
- `npm test` — run the default Vitest suite (excluding the database baseline test).
- `npm run test:critical` or `npm run test:all` — run the critical suite or every test.
- `npm run build` — create the production build; `npm run start` — serve it.
- `npm run db:migrate` / `npm run db:generate` — apply local migrations and regenerate Prisma Client.

Use `npm run db:migrate:deploy` for production migrations. Do not use `db:push` or `db:reset` for routine production work.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, single quotes, semicolons, and the `@/*` import alias. Prefer small typed functions and existing service boundaries. Name components and types in PascalCase, functions and variables in camelCase, and tests as `*.test.ts`. Run ESLint before submitting.

## Testing Guidelines

Vitest discovers tests under `tests/`. Add or update regression tests for pipeline, deduplication, API, database, cancellation, or push-delivery changes. Run the relevant file first, then `npm test`; run `npm run test:db-baseline` separately for migration changes. No coverage threshold is configured.

## Commit & Pull Request Guidelines

Follow the existing Conventional Commit style, such as `feat: add source retry` or `fix: preserve partial push results`. PRs should explain the change, list validation commands, link an issue, and include screenshots for UI changes. Call out schema/migration, environment, or deployment impacts.

## Security & Configuration

Never commit `.env`, API keys, Webhook URLs, SQLite data, or deployment archives. Production requires `API_TOKEN`; back up the database before migrations, and never reset a user database to resolve drift.
