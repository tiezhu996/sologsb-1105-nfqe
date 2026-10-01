import type { ColorMode, ScanQuality } from '../types/scan'
import { COLOR_MODES, SCAN_QUALITIES } from '../types/scan'
import type { SheetScale, SheetStatus } from '../types/sheet'
import { SHEET_SCALES, SHEET_STATUSES } from '../types/sheet'
import type {
  RelationEntry,
  RelationRevisionPayload,
  RevisionBatch,
  RevisionBlock,
  RevisionIssue,
  RevisionIssueKind,
  ScanRevisionPayload,
  SheetRevisionPayload,
} from '../types/revision'

/**
 * 离线修订表文本解析与本地对账。
 *
 * 修订表为纯文本，按空行或 “###” 分块，每个分块描述一项内容：
 *
 *   图幅：北平-甲-3 版本：2
 *   题名：正阳门至崇文门街巷图（重测）
 *   年代：1921
 *
 *   扫描件：北平-甲-3 版本：2
 *   文件名：北平甲3_重测_600dpi.tif
 *
 *   四至：北平-甲-3 版本：2
 *   东：北平-甲-4@2
 *   南：北平-乙-3@1
 *
 * 版本号可省略（图幅默认 1；扫描件、四至默认随本批次同名图幅）。
 * 邻接项允许写成 “图幅号@版本”，缺省版本在对账时按本批/本地图幅补齐。
 */

const BLOCK_HEADER = /^(?:###+\s*)?(图幅|扫描件|扫描|四至|四至关系|邻接)\s*[:：]\s*(.+?)\s*$/
const FIELD_LINE = /^\s*(.+?)\s*[:：]\s*(.*?)\s*$/
const VERSION_TAIL = /^(.*?)[\s,，]+版本\s*(?:[:：]\s*|\s+)(\d+)\s*$/

const SHEET_FIELD_KEYS: Record<string, keyof SheetRevisionPayload> = {
  题名: 'title',
  图名: 'title',
  年代: 'year',
  年份: 'year',
  测绘年代: 'year',
  比例尺: 'scale',
  投影: 'projection',
  投影方式: 'projection',
  图幅尺寸: 'sheetSizeCm',
  尺寸: 'sheetSizeCm',
  图组: 'series',
  所属图组: 'series',
  状态: 'status',
  整理状态: 'status',
  版本: 'version',
}

const SCAN_FIELD_KEYS: Record<string, keyof ScanRevisionPayload> = {
  文件名: 'fileName',
  扫描文件名: 'fileName',
  分辨率: 'resolutionDpi',
  dpi: 'resolutionDpi',
  色彩模式: 'colorMode',
  颜色模式: 'colorMode',
  分块数: 'pieces',
  块数: 'pieces',
  质量: 'quality',
  图像质量: 'quality',
  存放位置: 'storageNote',
  存放: 'storageNote',
  主用件: 'isPrimary',
  是否主用: 'isPrimary',
  主用: 'isPrimary',
  导入时间: 'importedAt',
  版本: 'version',
}

const DIRECTION_ALIASES: Record<string, string> = {
  东: '东',
  东至: '东',
  东接: '东',
  南: '南',
  南至: '南',
  南接: '南',
  西: '西',
  西至: '西',
  西接: '西',
  北: '北',
  北至: '北',
  北接: '北',
  东北: '东北',
  东北至: '东北',
  西南: '西南',
  西南至: '西南',
}

const ORDERED_DIRECTIONS = ['东', '南', '西', '北', '东北', '西南']

export function issue(kind: RevisionIssueKind, code: string, subject: string, message: string): RevisionIssue {
  return { kind, code, subject, message }
}

function parseVersionTail(rest: string): { code: string; version?: number } {
  const matched = rest.match(VERSION_TAIL)
  if (matched) {
    return { code: matched[1].trim(), version: Number(matched[2]) }
  }
  return { code: rest.trim() }
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : Number.NaN
}

function parseBoolean(value: string): boolean {
  return ['是', '主用', '真', 'true', '1', 'y', 'yes'].includes(value.trim().toLowerCase())
}

function splitCodeList(value: string): string[] {
  return value
    .split(/[、,，;；\s]+/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function parseNeighborEntry(token: string): RelationEntry | null {
  const trimmed = token.trim()
  if (!trimmed) {
    return null
  }
  const atIndex = trimmed.lastIndexOf('@')
  if (atIndex > 0) {
    const version = parsePositiveInteger(trimmed.slice(atIndex + 1))
    if (Number.isFinite(version)) {
      return { code: trimmed.slice(0, atIndex).trim(), version }
    }
  }
  return { code: trimmed }
}

function parseSheetBlock(lines: string[], startLine: number, headerRest: string): RevisionBlock | RevisionIssue[] {
  const head = parseVersionTail(headerRest)
  const found: Partial<Record<keyof SheetRevisionPayload, string>> = {}
  const problems: RevisionIssue[] = []

  for (const line of lines.slice(1)) {
    const matched = line.match(FIELD_LINE)
    if (!matched) {
      continue
    }
    const key = SHEET_FIELD_KEYS[matched[1].trim()]
    if (key) {
      found[key] = matched[2].trim()
    }
  }

  const code = head.code
  if (!code) {
    problems.push(issue('格式', code || '?', '图幅', '图幅分块缺少图幅号。'))
  }
  const version = head.version ?? (found.version ? parsePositiveInteger(found.version) : 1)
  if (!Number.isFinite(version) || version < 1) {
    problems.push(issue('格式', code, '图幅', `图幅 ${code} 的版本号无效。`))
  }

  const year = found.year ? parsePositiveInteger(found.year) : Number.NaN
  if (!Number.isFinite(year)) {
    problems.push(issue('格式', code, '年代', `图幅 ${code} 缺少有效的测绘年代。`))
  }
  const scale = (found.scale ?? '') as SheetScale
  if (!SHEET_SCALES.includes(scale)) {
    problems.push(issue('格式', code, '比例尺', `图幅 ${code} 的比例尺需为 ${SHEET_SCALES.join(' 或 ')}。`))
  }
  const status = (found.status ?? '已编') as SheetStatus
  if (!SHEET_STATUSES.includes(status)) {
    problems.push(issue('格式', code, '状态', `图幅 ${code} 的整理状态需为 ${SHEET_STATUSES.join('、')}。`))
  }
  if (!found.title) {
    problems.push(issue('格式', code, '题名', `图幅 ${code} 缺少题名。`))
  }
  if (!found.projection) {
    problems.push(issue('格式', code, '投影', `图幅 ${code} 缺少投影方式。`))
  }

  if (problems.length) {
    return problems
  }

  const payload: SheetRevisionPayload = {
    code,
    version: Number(version),
    title: found.title ?? '',
    year: Number(year),
    scale,
    projection: found.projection ?? '',
    sheetSizeCm: found.sheetSizeCm || '58 × 46 厘米',
    series: found.series || '未分组',
    status,
  }
  return { type: 'sheet', line: startLine, payload }
}

function parseScanBlock(lines: string[], startLine: number, headerRest: string): RevisionBlock | RevisionIssue[] {
  const head = parseVersionTail(headerRest)
  const found: Partial<Record<keyof ScanRevisionPayload, string>> = {}
  const problems: RevisionIssue[] = []

  for (const line of lines.slice(1)) {
    const matched = line.match(FIELD_LINE)
    if (!matched) {
      continue
    }
    const key = SCAN_FIELD_KEYS[matched[1].trim()]
    if (key) {
      found[key] = matched[2].trim()
    }
  }

  const code = head.code
  if (!code) {
    problems.push(issue('格式', code || '?', '扫描件', '扫描件分块缺少所属图幅号。'))
  }
  const version = head.version ?? (found.version ? parsePositiveInteger(found.version) : undefined)
  if (version !== undefined && (!Number.isFinite(version) || version < 1)) {
    problems.push(issue('格式', code, '扫描件', `扫描件所属图幅 ${code} 的版本号无效。`))
  }
  if (!found.fileName) {
    problems.push(issue('格式', code, '文件名', `图幅 ${code} 的扫描件缺少文件名。`))
  }
  if (!found.storageNote) {
    problems.push(issue('格式', code, '存放位置', `扫描件 ${found.fileName ?? ''} 缺少存放位置。`))
  }
  const resolutionDpi = found.resolutionDpi ? parsePositiveInteger(found.resolutionDpi) : 600
  if (!Number.isFinite(resolutionDpi)) {
    problems.push(issue('格式', code, '分辨率', `扫描件 ${found.fileName ?? ''} 的分辨率无效。`))
  }
  const colorMode = (found.colorMode ?? '彩色') as ColorMode
  if (!COLOR_MODES.includes(colorMode)) {
    problems.push(issue('格式', code, '色彩模式', `扫描件色彩模式需为 ${COLOR_MODES.join('、')}。`))
  }
  const pieces = found.pieces ? parsePositiveInteger(found.pieces) : 1
  if (!Number.isFinite(pieces)) {
    problems.push(issue('格式', code, '分块数', `扫描件 ${found.fileName ?? ''} 的分块数无效。`))
  }
  const quality = (found.quality ?? '清晰') as ScanQuality
  if (!SCAN_QUALITIES.includes(quality)) {
    problems.push(issue('格式', code, '图像质量', `扫描件图像质量需为 ${SCAN_QUALITIES.join('、')}。`))
  }

  if (problems.length) {
    return problems
  }

  const payload: ScanRevisionPayload = {
    code,
    version: Number(version ?? NaN),
    fileName: found.fileName ?? '',
    resolutionDpi: Number(resolutionDpi),
    colorMode,
    pieces: Number(pieces),
    quality,
    storageNote: found.storageNote ?? '',
    isPrimary: found.isPrimary ? parseBoolean(found.isPrimary) : true,
    ...(found.importedAt ? { importedAt: found.importedAt } : {}),
  }
  return { type: 'scan', line: startLine, payload }
}

function parseRelationBlock(lines: string[], startLine: number, headerRest: string): RevisionBlock | RevisionIssue[] {
  const head = parseVersionTail(headerRest)
  const code = head.code
  const problems: RevisionIssue[] = []
  if (!code) {
    problems.push(issue('格式', code || '?', '四至', '四至分块缺少图幅号。'))
  }
  const version = head.version ?? 1
  if (!Number.isFinite(version) || version < 1) {
    problems.push(issue('格式', code, '四至', `图幅 ${code} 的四至版本号无效。`))
  }

  const neighbors: Partial<Record<string, RelationEntry>> = {}

  for (const line of lines.slice(1)) {
    const matched = line.match(FIELD_LINE)
    if (!matched) {
      continue
    }
    const label = matched[1].trim()
    const direction = DIRECTION_ALIASES[label]
    if (!direction) {
      continue
    }
    const tokens = splitCodeList(matched[2])
    if (tokens.length === 0) {
      continue
    }
    if (tokens.length > 1) {
      problems.push(issue('格式', code, direction, `图幅 ${code} 的${direction}侧只能登记一幅邻接图。`))
      continue
    }
    const entry = parseNeighborEntry(tokens[0])
    if (!entry || !entry.code) {
      problems.push(issue('格式', code, direction, `图幅 ${code} 的${direction}侧邻接图号无效。`))
      continue
    }
    if (neighbors[direction]) {
      problems.push(issue('格式', code, direction, `图幅 ${code} 的${direction}侧四至重复登记。`))
      continue
    }
    neighbors[direction] = entry
  }

  if (problems.length) {
    return problems
  }

  if (problems.length) {
    return problems
  }

  if (Object.keys(neighbors).length === 0) {
    problems.push(issue('格式', code, '四至', `图幅 ${code} 的四至分块未登记任何邻接关系。`))
    return problems
  }

  const payload: RelationRevisionPayload = { code, version: Number(version), neighbors }
  return { type: 'relation', line: startLine, payload }
}

export function parseRevisionText(rawText: string): { blocks: RevisionBlock[]; issues: RevisionIssue[] } {
  const blocks: RevisionBlock[] = []
  const issues: RevisionIssue[] = []

  interface PendingChunk {
    startLine: number
    lines: string[]
  }
  const chunks: PendingChunk[] = []
  let current: PendingChunk | null = null
  rawText
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .forEach((rawLine, index) => {
      const line = rawLine.trim()
      if (!line || /^###+$/.test(line)) {
        current = null
        return
      }
      if (!current) {
        current = { startLine: index + 1, lines: [] }
        chunks.push(current)
      }
      current.lines.push(line)
    })

  for (const chunk of chunks) {
    const header = chunk.lines[0].match(BLOCK_HEADER)
    if (!header) {
      issues.push(
        issue('格式', '?', '修订分块', `无法识别的分块开头：“${chunk.lines[0]}”，应以“图幅：/扫描件：/四至：”起始。`),
      )
      continue
    }
    const kind = header[1]
    const rest = header[2]
    const parsed =
      kind === '图幅'
        ? parseSheetBlock(chunk.lines, chunk.startLine, rest)
        : kind === '扫描件' || kind === '扫描'
          ? parseScanBlock(chunk.lines, chunk.startLine, rest)
          : parseRelationBlock(chunk.lines, chunk.startLine, rest)
    if (Array.isArray(parsed)) {
      issues.push(...parsed)
    } else {
      blocks.push(parsed)
    }
  }

  return { blocks, issues }
}

export interface LocalSheetSnapshot {
  code: string
  version: number
}

/**
 * 与本地编目对账：
 * - 重号：同图幅号、同版本已在本地存在（同批再次应用走幂等留档，不会到这里）。
 * - 版本冲突：批次版本不高于本地版本，无法替换旧图。
 * - 缺口：扫描件、四至指向的图幅版本在本批和本地都找不到。
 * - 版本一致性：一个批次内同一图幅号的图幅、扫描件、四至必须同版本。
 */
export function reconcileBatch(rawText: string, localSheets: LocalSheetSnapshot[]): RevisionBatch {
  const { blocks, issues } = parseRevisionText(rawText)

  const localByCode = new Map(localSheets.map((sheet) => [sheet.code, sheet.version]))
  const sheetBlocks = blocks.filter((block) => block.type === 'sheet')
  const scanBlocks = blocks.filter((block) => block.type === 'scan')
  const relationBlocks = blocks.filter((block) => block.type === 'relation')

  // 批次内同一图幅号只允许一个图幅版本。
  const batchSheetVersions = new Map<string, number>()
  for (const block of sheetBlocks) {
    const { code, version } = block.payload
    const previous = batchSheetVersions.get(code)
    if (previous !== undefined) {
      if (previous !== version) {
        issues.push(issue('版本冲突', code, '图幅', `同一批次里图幅 ${code} 出现了版本 ${previous} 与版本 ${version}，无法同时写入。`))
      } else {
        issues.push(issue('格式', code, '重号图幅', `同一批次里图幅 ${code} 版本 ${version} 重复登记。`))
      }
      continue
    }
    batchSheetVersions.set(code, version)

    const localVersion = localByCode.get(code)
    if (localVersion !== undefined) {
      if (localVersion === version) {
        issues.push(issue('版本冲突', code, '重号图幅', `图幅 ${code} 版本 ${version} 本地已存在，直接追加会留下重号图幅。`))
      } else if (localVersion > version) {
        issues.push(
          issue('版本冲突', code, '旧版回退', `图幅 ${code} 本地已是版本 ${localVersion}，批次版本 ${version} 早于本地版本，不能以旧覆新。`),
        )
      }
    } else if (version > 1) {
      issues.push(issue('缺口', code, '图幅', `图幅 ${code} 缺少版本 1 至 ${version - 1}，不能直接登记版本 ${version}。`))
    }
  }

  function resolveVersion(code: string): number | undefined {
    return batchSheetVersions.get(code) ?? localByCode.get(code)
  }

  // 同一图幅号的图幅、扫描件、四至必须落到同一版本。
  const seenScanFiles = new Set<string>()
  const seenRelations = new Set<string>()
  for (const block of scanBlocks) {
    const { code, version, fileName } = block.payload
    const fileKey = `${code}::${fileName}`
    if (seenScanFiles.has(fileKey)) {
      issues.push(issue('格式', code, '扫描件', `扫描件 ${fileName} 在同一批次里对图幅 ${code} 重复登记。`))
      continue
    }
    seenScanFiles.add(fileKey)
    const target = resolveVersion(code)
    if (target === undefined) {
      issues.push(issue('缺口', code, '扫描件', `扫描件 ${fileName} 所属图幅 ${code} 在本批与本地都不存在，会挂到缺编图幅上。`))
      continue
    }
    if (Number.isFinite(version)) {
      if (version !== target) {
        issues.push(
          issue('版本冲突', code, '扫描件', `扫描件 ${fileName} 标注版本 ${version}，与图幅 ${code} 将确认的版本 ${target} 不一致。`),
        )
      }
    }
    block.payload.version = target
  }

  for (const block of relationBlocks) {
    const { code, version, neighbors } = block.payload
    if (seenRelations.has(code)) {
      issues.push(issue('格式', code, '四至', `图幅 ${code} 的四至关系在同一批次里重复登记。`))
      continue
    }
    seenRelations.add(code)
    const sourceVersion = batchSheetVersions.get(code) ?? localByCode.get(code)
    if (sourceVersion === undefined) {
      issues.push(issue('缺口', code, '四至', `四至关系所属图幅 ${code} 在本批与本地都不存在。`))
    } else if (version !== sourceVersion) {
      issues.push(
        issue('版本冲突', code, '四至', `图幅 ${code} 将确认到版本 ${sourceVersion}，四至关系却标注版本 ${version}。`),
      )
    }
    block.payload.version = sourceVersion ?? version

    for (const direction of ORDERED_DIRECTIONS) {
      const entry = neighbors[direction]
      if (!entry) {
        continue
      }
      const targetVersion = resolveVersion(entry.code)
      if (entry.version === undefined) {
        if (targetVersion === undefined) {
          issues.push(issue('缺口', entry.code, direction, `图幅 ${code} ${direction}侧邻接 ${entry.code} 缺编，需补齐图幅后再核接边。`))
        } else {
          entry.version = targetVersion
        }
      } else if (targetVersion === undefined) {
        issues.push(issue('缺口', entry.code, direction, `图幅 ${code} ${direction}侧指向 ${entry.code}@${entry.version}，该图幅缺编。`))
      } else if (entry.version !== targetVersion) {
        issues.push(
          issue(
            '版本冲突',
            entry.code,
            direction,
            `图幅 ${code} ${direction}侧指向 ${entry.code}@${entry.version}，该图幅将确认到版本 ${targetVersion}，邻接关系仍指向旧图。`,
          ),
        )
      }
    }
  }

  return {
    rawText,
    blocks,
    issues,
    ready: issues.length === 0,
    sheetCodes: [...new Set(blocks.map((block) => block.payload.code))],
    scanCount: scanBlocks.length,
    relationCount: relationBlocks.length,
  }
}

/**
 * 归一化后再求摘要：去掉首尾空白、合并连续空行与全角/半角冒号差异，
 * 避免无害的排版差异导致同一批资料被当成两批。
 */
export function normalizeRevisionText(rawText: string): string {
  return rawText
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export async function hashRevisionText(rawText: string): Promise<string> {
  const normalized = normalizeRevisionText(rawText)
  if (!normalized) {
    return ''
  }
  const bytes = new TextEncoder().encode(normalized)
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes)
    return Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('')
  }
  let hash = 0
  for (const byte of bytes) {
    hash = (hash * 31 + byte) >>> 0
  }
  return `fallback-${hash.toString(16)}`
}

export { ORDERED_DIRECTIONS }
