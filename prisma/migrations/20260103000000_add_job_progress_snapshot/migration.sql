-- 重构 #4：Job 增加进度快照字段，让 Job 表成为任务级状态的唯一事实源。
-- 旧记录保持 currentStage=null、计数为 0、heartbeatAt=null。
-- 故意使用 ADD COLUMN 而非表重建：不删除历史 Job（前端历史视图可继续读取），
-- 避免 SQLite 表重建在迁移期间对其他并发 SELECT 造成锁等待。

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN "currentStage" TEXT;
ALTER TABLE "jobs" ADD COLUMN "progressTotal" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "jobs" ADD COLUMN "progressDone" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "jobs" ADD COLUMN "progressErrors" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "jobs" ADD COLUMN "currentItemLabel" TEXT NOT NULL DEFAULT '';
ALTER TABLE "jobs" ADD COLUMN "heartbeatAt" DATETIME;