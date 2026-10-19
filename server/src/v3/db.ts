import { mkdirSync } from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { migrate } from './migrations.js'

/**
 * SQLite 连接
 * ----------------------------------------------------------------------------
 * 选择 better-sqlite3 的原因：
 * - 单文件、零外部服务，不改变现有 `node dist/src/index.js` 启动方式；
 * - 同步 API 天然适合“单事务内读版本 → 写实体 → 写幂等记录”；
 * - 支持 WAL、唯一约束、部分唯一索引和 BEGIN IMMEDIATE 事务；
 * - 开发/测试/生产通过 SCP_DB_PATH 指向不同文件，测试不写生产目录。
 */

export interface OpenDatabaseOptions {
  /** 文件路径；测试用 ':memory:' 或临时目录文件 */
  filePath: string
  /** 打开时执行迁移，默认 true */
  runMigrations?: boolean
}

export function openV3Database(options: OpenDatabaseOptions): Database.Database {
  const { filePath } = options
  if (filePath !== ':memory:') {
    mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true })
  }

  const db = new Database(filePath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  db.pragma('synchronous = NORMAL')

  if (options.runMigrations !== false) migrate(db)
  return db
}

/** 默认数据库位置：server/data/course-platform.sqlite（server/.gitignore 已排除 data/） */
export function defaultDatabasePath(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.SCP_DB_PATH?.trim()
  if (configured !== undefined && configured !== '') return configured
  return path.resolve(process.cwd(), 'data', 'course-platform.sqlite')
}

/** 所有领域写操作必须走这个函数：BEGIN IMMEDIATE + 失败回滚 */
export function transaction<T>(db: Database.Database, run: () => T): T {
  return db.transaction(run).immediate()
}

export function nowIso(now: Date = new Date()): string {
  return now.toISOString()
}

export function addMilliseconds(iso: string, milliseconds: number): string {
  return new Date(new Date(iso).getTime() + milliseconds).toISOString()
}

export type V3Database = Database.Database
