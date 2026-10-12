import { createServer, type Server } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, modelConfig, type ServerConfig } from './config.js'
import { createRuleFallback } from './advisor/fallback.js'
import { createMockProvider, type MockProviderMode } from './advisor/mockProvider.js'
import { createOpenAiCompatibleProvider } from './advisor/openaiCompatibleProvider.js'
import { createAdvisorService, type AdvisorService } from './advisor/service.js'
import { createConsoleLogger, type AdvisorLogger, type AdvisorProvider } from './advisor/types.js'
import { createAdvisorHandler } from './routes/advisor.js'
import { createAdvisorChatHandler } from './routes/advisorChat.js'
import { handleHealth, sendJson } from './routes/health.js'
import { handleApiCors } from './routes/cors.js'
import {
  MATERIALS_PATH,
  MATERIALS_UNDERSTANDING_PATH,
  createMaterialsHandler,
  createMaterialsUnderstandingHandler,
} from './routes/materials.js'
import { createMaterialsService, type MaterialsService } from './materials/understanding.js'

/**
 * HTTP 服务入口
 * ----------------------------------------------------------------------------
 * 只负责装配：创建 provider 与服务、注册路由、兜底 404。
 *
 * 当前路由：GET /health、POST /api/advisor/recommendations、POST /api/advisor/chat、
 * POST /api/materials（材料登记与解析，v2 / M2-A）、POST /api/materials/understanding（材料理解草稿）。
 * 运行时**默认使用真实模型 provider**（OpenAI 兼容）；
 * mock provider 只在 ADVISOR_PROVIDER=mock（本地联调）或测试注入时使用。
 */

/**
 * 服务层的安全网超时：比 provider 自身的超时多留一点。
 * provider 会在 MODEL_TIMEOUT_MS 处中断并给出精确原因（MODEL_TIMEOUT），
 * 这一层只兜住"provider 没有遵守超时"的异常情况，不是主超时机制。
 */
const SERVICE_TIMEOUT_MARGIN_MS = 5_000

export interface AppDependencies {
  /** 覆盖建议服务，测试用它注入 provider（离线、不发真实请求） */
  advisorService?: AdvisorService
  /** 覆盖材料服务（v2 / M2-A），测试同理 */
  materialsService?: MaterialsService
  logger?: AdvisorLogger
}

const MOCK_PROVIDER_MODES: readonly string[] = ['ok', 'empty', 'invalid', 'throw', 'not-configured', 'slow']

/**
 * 仅在 ADVISOR_PROVIDER=mock 时生效：让 mock provider 按指定方式失败，
 * 便于前端在本地验证 fallback 与错误状态。例：MOCK_PROVIDER_MODE=throw npm start
 */
function readMockProviderMode(env: NodeJS.ProcessEnv = process.env): MockProviderMode {
  const raw = env.MOCK_PROVIDER_MODE?.trim()
  if (raw === undefined || raw === '') return 'ok'
  if (!MOCK_PROVIDER_MODES.includes(raw)) {
    console.warn(`[server] MOCK_PROVIDER_MODE 取值不被识别（${MOCK_PROVIDER_MODES.join(' / ')}），已按 ok 处理`)
    return 'ok'
  }
  return raw as MockProviderMode
}

/** 只取主机名用于日志：不打印完整 URL（可能带查询串或内网路径） */
function safeHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return 'invalid-url'
  }
}

/** 启动时打印当前 provider 摘要：不含密钥，也不含完整 URL */
function describeAdvisorProvider(): string {
  if (modelConfig.provider === 'mock') {
    return `mock-provider (mode=${readMockProviderMode()}) —— 仅限本地联调，不要用于部署`
  }
  if (modelConfig.endpoint === null) {
    return `openai-compatible（未配置：${modelConfig.missing.join(' / ')}）`
  }
  return `openai-compatible (model=${modelConfig.endpoint.model}, host=${safeHost(modelConfig.endpoint.url)}, timeout=${modelConfig.endpoint.timeoutMs}ms)`
}

/** 依赖装配的唯一位置：换成别的 provider 只改这里 */
function createAdvisorProvider(logger: AdvisorLogger): AdvisorProvider {
  if (modelConfig.provider === 'mock') {
    return createMockProvider({ mode: readMockProviderMode() })
  }

  return createOpenAiCompatibleProvider({
    // endpoint 为 null（配置缺失）时，provider 会以 MODEL_NOT_CONFIGURED 失败，由规则兜底接手
    endpoint: modelConfig.endpoint,
    missingEnvNames: modelConfig.missing,
    logger,
  })
}

/** 创建服务实例但不监听端口。参数可注入，便于测试用随机端口启动 */
export function createApp(serverConfig: ServerConfig = config, deps: AppDependencies = {}): Server {
  const logger = deps.logger ?? createConsoleLogger('server')

  // 同一个 provider 实例同时供建议 / 聊天 / 材料理解使用（替换 provider 只改 createAdvisorProvider）
  const provider = createAdvisorProvider(logger)

  const advisorService =
    deps.advisorService ??
    createAdvisorService({
      provider,
      fallback: createRuleFallback(),
      timeoutMs: modelConfig.timeoutMs + SERVICE_TIMEOUT_MARGIN_MS,
      logger,
    })

  const materialsService =
    deps.materialsService ??
    createMaterialsService({
      provider,
      timeoutMs: modelConfig.timeoutMs + SERVICE_TIMEOUT_MARGIN_MS,
      logger,
    })

  const handleAdvisor = createAdvisorHandler({ service: advisorService, logger })
  const handleAdvisorChat = createAdvisorChatHandler({ service: advisorService, logger })
  const handleMaterials = createMaterialsHandler({ service: materialsService, logger })
  const handleMaterialsUnderstanding = createMaterialsUnderstandingHandler({ service: materialsService, logger })

  return createServer((req, res) => {
    if (handleApiCors(req, res)) return

    // 同步路由
    if (handleHealth(req, res, serverConfig)) return

    // 异步路由
    void handleAdvisor(req, res)
      .then(async (handled) => {
        if (handled) return
        if (await handleAdvisorChat(req, res)) return
        if (await handleMaterials(req, res)) return
        if (await handleMaterialsUnderstanding(req, res)) return
        sendJson(res, 404, { status: 'error', message: '接口不存在' })
      })
      .catch((error: unknown) => {
        logger.warn('请求处理出现未捕获异常', {
          detail: error instanceof Error ? error.message : 'unknown',
        })
        if (!res.headersSent) {
          sendJson(res, 500, { status: 'error', message: '服务内部错误' })
        } else {
          res.end()
        }
      })
  })
}

function start(): void {
  const server = createApp(config)

  server.on('error', (error: Error) => {
    // 只打印错误信息，不打印环境变量，避免把密钥带进日志
    console.error(`[${config.serviceName}] 启动失败：${error.message}`)
    process.exitCode = 1
  })

  server.listen(config.port, config.host, () => {
    console.log(`[${config.serviceName}] listening on http://${config.host}:${config.port}`)
    console.log(`[${config.serviceName}] health: http://${config.host}:${config.port}/health`)
    console.log(`[${config.serviceName}] advisor provider: ${describeAdvisorProvider()}`)
    console.log(
      `[${config.serviceName}] advisor route: POST http://${config.host}:${config.port}/api/advisor/recommendations`,
    )
    console.log(
      `[${config.serviceName}] chat route: POST http://${config.host}:${config.port}/api/advisor/chat`,
    )
    console.log(
      `[${config.serviceName}] materials route: POST http://${config.host}:${config.port}${MATERIALS_PATH}`,
    )
    console.log(
      `[${config.serviceName}] materials understanding route: POST http://${config.host}:${config.port}${MATERIALS_UNDERSTANDING_PATH}`,
    )

    if (modelConfig.provider !== 'mock' && modelConfig.endpoint === null) {
      console.warn(
        `[${config.serviceName}] 模型配置不完整，建议接口将改用规则兜底（fallbackReason=MODEL_NOT_CONFIGURED）。缺失：${modelConfig.missing.join(' / ')}`,
      )
    }
  })

  // 收到终止信号时关闭监听，避免端口残留占用
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      server.close(() => process.exit(0))
    })
  }
}

/** 只有直接运行本文件才监听端口；被 import（例如测试）时保持安静 */
function isDirectRun(): boolean {
  const entry = process.argv[1]
  if (entry === undefined) return false
  // Windows 路径大小写不敏感，比较时统一小写
  return path.resolve(entry).toLowerCase() === path.resolve(fileURLToPath(import.meta.url)).toLowerCase()
}

if (isDirectRun()) start()
