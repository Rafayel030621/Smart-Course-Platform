import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import {
  MATERIAL_LIMITS,
  decodeBase64Strict,
  decodeMaterialText,
  materialTypeFromName,
  parseMaterialUploadRequest,
  parseMaterialsUnderstandingRequest,
} from '../src/materials/validation.js'

/**
 * 材料接口请求校验的单元测试（契约 15.1 / 15.2）
 * ----------------------------------------------------------------------------
 * 直接调用模块函数，不起 HTTP 服务：验证白名单、大小、编码、内容特征与各类上限。
 * 全部使用离线数据，不发网络请求、不落盘。
 */

const UTF8_TEXT = '# 实验手册\n第一段内容\n第二行\n\n## 数据说明\n字段包括时间与经纬度'

function base64Of(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64')
}

function uploadBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    requestId: 'mat_req_1',
    projectId: 'prj_1',
    projectRevision: 3,
    materialId: 'mat_9b1e7c2f',
    version: 1,
    name: '实验手册.md',
    contentBase64: base64Of(UTF8_TEXT),
    ...overrides,
  }
}

function understandingBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    contractVersion: '1.0',
    promptVersion: 'material-understanding-v1',
    requestId: 'und_req_1',
    projectId: 'prj_1',
    projectRevision: 4,
    projectName: '极端风浪事件智能分析',
    material: {
      materialId: 'mat_9b1e7c2f',
      name: '实验手册.md',
      type: 'md',
      version: 1,
      segments: [
        { segmentId: 'seg_0', startLine: 1, endLine: 4, text: '第一段内容\n第二行' },
        { segmentId: 'seg_1', startLine: 6, endLine: 7, text: '## 数据说明\n字段包括时间与经纬度' },
      ],
    },
    ...overrides,
  }
}

/* --------------------------------------------------------------- 上传接口 */

describe('上传接口校验', () => {
  test('合法 md 通过，类型/编码/大小/分段都来自服务端计算', () => {
    const result = parseMaterialUploadRequest(uploadBody())
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.value.type, 'md')
      assert.equal(result.value.encoding, 'utf-8')
      assert.equal(result.value.size, Buffer.byteLength(UTF8_TEXT, 'utf8'))
      assert.ok(result.value.segments.length >= 1)
      assert.equal(result.value.segments[0].segmentId, 'seg_0')
      assert.equal(result.value.segments[0].index, 0)
    }
  })

  test('合法 txt 通过', () => {
    const result = parseMaterialUploadRequest(uploadBody({ name: '数据说明.TXT', contentBase64: base64Of('第一行\n\n第二行') }))
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value.type, 'txt')
  })

  test('相同输入两次解析得到完全一致的分段', () => {
    const first = parseMaterialUploadRequest(uploadBody())
    const second = parseMaterialUploadRequest(uploadBody())
    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    if (first.ok && second.ok) {
      assert.deepEqual(first.value.segments, second.value.segments)
    }
  })

  test('GBK 文本回退解码，encoding 为 gbk', () => {
    // B2 E2 CA D4 是 “测试” 的 GBK 编码；这些字节不是合法 UTF-8
    const gbkBytes = Buffer.concat([
      Buffer.from([0xb2, 0xe2, 0xca, 0xd4]),
      Buffer.from('\n\n', 'utf8'),
      Buffer.from([0xb2, 0xe2, 0xca, 0xd4]),
    ])
    const result = parseMaterialUploadRequest(uploadBody({ contentBase64: gbkBytes.toString('base64') }))
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.value.encoding, 'gbk')
      assert.match(result.value.segments[0].text, /测试/)
    }
  })

  test('UTF-8 优先：合法 UTF-8 不会被判成 GBK', () => {
    const result = parseMaterialUploadRequest(uploadBody())
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value.encoding, 'utf-8')
  })

  test('无法解码时返回 MATERIAL_ENCODING_UNREADABLE', () => {
    const bytes = Buffer.from([0xff, 0xff, 0xff])
    const result = parseMaterialUploadRequest(uploadBody({ contentBase64: bytes.toString('base64') }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'MATERIAL_ENCODING_UNREADABLE')
  })

  test('非 md/txt 扩展名返回 UNSUPPORTED_MATERIAL_TYPE', () => {
    for (const name of ['数据.csv', '报告.pdf', '脚本.exe', '没有扩展名']) {
      const result = parseMaterialUploadRequest(uploadBody({ name }))
      assert.equal(result.ok, false, `${name} 应当被拒绝`)
      if (!result.ok) {
        assert.equal(result.code, 'UNSUPPORTED_MATERIAL_TYPE')
        assert.match(result.message, /md、txt/)
      }
    }
  })

  test('扩展名与内容不匹配（二进制含 NUL）返回 UNSUPPORTED_MATERIAL_TYPE', () => {
    const bytes = Buffer.from([0x61, 0x00, 0x62, 0x63])
    const result = parseMaterialUploadRequest(uploadBody({ contentBase64: bytes.toString('base64') }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'UNSUPPORTED_MATERIAL_TYPE')
  })

  test('空文件与仅空白内容返回 EMPTY_MATERIAL', () => {
    const empty = parseMaterialUploadRequest(uploadBody({ contentBase64: '' }))
    assert.equal(empty.ok, false)
    if (!empty.ok) assert.equal(empty.code, 'EMPTY_MATERIAL')

    const blank = parseMaterialUploadRequest(uploadBody({ contentBase64: base64Of('   \n\n \t ') }))
    assert.equal(blank.ok, false)
    if (!blank.ok) assert.equal(blank.code, 'EMPTY_MATERIAL')
  })

  test('超过 1 MB 返回 MATERIAL_TOO_LARGE，且按解码后字节数判断', () => {
    const bytes = Buffer.alloc(MATERIAL_LIMITS.maxFileBytes + 1, 0x61)
    const result = parseMaterialUploadRequest(uploadBody({ contentBase64: bytes.toString('base64') }))
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'MATERIAL_TOO_LARGE')
      assert.match(result.message, /1 MB/)
    }
  })

  test('恰好 1 MB 可以通过', () => {
    const bytes = Buffer.alloc(MATERIAL_LIMITS.maxFileBytes, 0x61)
    const result = parseMaterialUploadRequest(uploadBody({ contentBase64: bytes.toString('base64') }))
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value.size, MATERIAL_LIMITS.maxFileBytes)
  })

  test('非法 base64 返回 INVALID_INPUT 且不包含正文', () => {
    const result = parseMaterialUploadRequest(uploadBody({ contentBase64: 'not base64!!!' }))
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'INVALID_INPUT')
      assert.match(result.message, /base64/)
      assert.doesNotMatch(result.message, /not base64/)
    }
  })

  test('缺少必填字段时逐项报错，不补默认值', () => {
    const body = uploadBody()
    delete body.version
    const result = parseMaterialUploadRequest(body)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'INVALID_INPUT')
      assert.match(result.message, /version/)
    }
  })

  test('materialId 前缀不合法时拒绝', () => {
    const result = parseMaterialUploadRequest(uploadBody({ materialId: 'tsk_1' }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /mat_/)
  })

  test('contractVersion 不匹配时拒绝', () => {
    const result = parseMaterialUploadRequest(uploadBody({ contractVersion: '2.0' }))
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.code, 'INVALID_INPUT')
  })
})

/* --------------------------------------------- base64 / 编码 / 类型工具 */

describe('基础工具', () => {
  test('decodeBase64Strict 只接受标准 base64', () => {
    assert.deepEqual(decodeBase64Strict('aGVsbG8='), Buffer.from('hello', 'utf8'))
    assert.equal(decodeBase64Strict(''), null)
    assert.equal(decodeBase64Strict('aGVsbG8'), null)
    assert.equal(decodeBase64Strict('a==='), null)
    assert.equal(decodeBase64Strict('####'), null)
  })

  test('decodeMaterialText 区分 UTF-8 与 GBK', () => {
    const utf8 = decodeMaterialText(Buffer.from('中文', 'utf8'))
    assert.equal(utf8?.encoding, 'utf-8')

    const gbk = decodeMaterialText(Buffer.from([0xb2, 0xe2, 0xca, 0xd4]))
    assert.equal(gbk?.encoding, 'gbk')
    assert.equal(gbk?.text, '测试')

    assert.equal(decodeMaterialText(Buffer.from([0xff, 0xff, 0xff])), null)
    assert.equal(decodeMaterialText(Buffer.from([0x80])), null)
  })

  test('materialTypeFromName 不区分大小写', () => {
    assert.equal(materialTypeFromName('报告.MD'), 'md')
    assert.equal(materialTypeFromName('说明.Txt'), 'txt')
    assert.equal(materialTypeFromName('归档.md.txt'), 'txt')
    assert.equal(materialTypeFromName('数据.csv'), null)
  })
})

/* --------------------------------------------------------------- 理解接口 */

describe('理解接口校验', () => {
  test('合法请求通过', () => {
    const result = parseMaterialsUnderstandingRequest(understandingBody())
    assert.equal(result.ok, true)
    if (result.ok) {
      assert.equal(result.value.promptVersion, 'material-understanding-v1')
      assert.equal(result.value.material.segments.length, 2)
      assert.equal(result.value.projectName, '极端风浪事件智能分析')
    }
  })

  test('projectName 允许为 null', () => {
    const result = parseMaterialsUnderstandingRequest(understandingBody({ projectName: null }))
    assert.equal(result.ok, true)
    if (result.ok) assert.equal(result.value.projectName, null)
  })

  test('promptVersion 不受支持时拒绝', () => {
    const result = parseMaterialsUnderstandingRequest(understandingBody({ promptVersion: 'mvp-prompt-v1' }))
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'INVALID_INPUT')
      assert.match(result.message, /material-understanding-v1/)
    }
  })

  test('片段超过 100 条时拒绝，不做静默截断', () => {
    const segments = Array.from({ length: 101 }, (_, index) => ({
      segmentId: `seg_${index}`,
      startLine: index + 1,
      endLine: index + 1,
      text: `第 ${index} 段`,
    }))
    const body = understandingBody()
    const material = body.material as Record<string, unknown>
    const result = parseMaterialsUnderstandingRequest({ ...body, material: { ...material, segments } })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.code, 'INVALID_INPUT')
      assert.match(result.message, /最多 100 条/)
    }
  })

  test('片段文本合计超过 24,000 字时拒绝', () => {
    const segments = Array.from({ length: 13 }, (_, index) => ({
      segmentId: `seg_${index}`,
      startLine: index * 2 + 1,
      endLine: index * 2 + 2,
      text: '甲'.repeat(2000),
    }))
    const body = understandingBody()
    const material = body.material as Record<string, unknown>
    const result = parseMaterialsUnderstandingRequest({ ...body, material: { ...material, segments } })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /24000/)
  })

  test('type 与扩展名不一致时拒绝', () => {
    const body = understandingBody()
    const material = body.material as Record<string, unknown>
    const result = parseMaterialsUnderstandingRequest({ ...body, material: { ...material, type: 'txt' } })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /扩展名/)
  })

  test('endLine 小于 startLine 时拒绝', () => {
    const body = understandingBody()
    const material = body.material as Record<string, unknown>
    const result = parseMaterialsUnderstandingRequest({
      ...body,
      material: { ...material, segments: [{ segmentId: 'seg_0', startLine: 5, endLine: 3, text: '一段内容' }] },
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /endLine/)
  })

  test('缺少 material 时拒绝', () => {
    const body = understandingBody()
    delete body.material
    const result = parseMaterialsUnderstandingRequest(body)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /material/)
  })

  test('字符串字段超长时拒绝', () => {
    const body = understandingBody()
    const material = body.material as Record<string, unknown>
    const segments = [{ segmentId: 'seg_0', startLine: 1, endLine: 1, text: 'x'.repeat(MATERIAL_LIMITS.segmentTextLength + 1) }]
    const result = parseMaterialsUnderstandingRequest({ ...body, material: { ...material, segments } })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.message, /2000/)
  })
})
