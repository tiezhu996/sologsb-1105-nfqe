import type { ScanItem } from '../types/scan'
import type { Sheet } from '../types/sheet'
import {
  COLOR_MODES,
  SCAN_QUALITIES,
  type ColorMode,
  type ScanQuality,
} from '../types/scan'
import { SHEET_SCALES, SHEET_STATUSES, type SheetScale, type SheetStatus } from '../types/sheet'
import type {
  EdgePreview,
  RevisionDirection,
  RevisionEdgeInput,
  RevisionIssue,
  RevisionParseResult,
  RevisionReport,
  RevisionScanInput,
  RevisionSheetInput,
  ScanPreview,
  SheetPreview,
} from '../types/revision'

/** 四至规范排列次序，与邻接拼合预览页一致 */
export const REVISION_DIRECTIONS: RevisionDirection[] = ['东', '南', '西', '北', '东北', '西南']

const REVERSE_DIRECTION: Record<RevisionDirection, RevisionDirection> = {
  东: '西',
  南: '北',
  西: '东',
  北: '南',
  东北: '西南',
  西南: '东北',
}

type SectionKind = 'sheet' | 'scan' | 'edge' | null

interface SheetFields {
  code?: string
  version?: number
  title?: string
  year?: number
  scale?: SheetScale
  projection?: string
  sheetSizeCm?: string
  series?: string
  status?: SheetStatus
}

interface ScanFields {
  sheetCode?: string
  sheetVersion?: number
  fileName?: string
  resolutionDpi?: number
  colorMode?: ColorMode
  pieces?: number
  quality?: ScanQuality
  storageNote?: string
  isPrimary?: boolean
}

function normalizeLine(line: string): string {
  return line
    .replace(/[：]/g, ':')
    .replace(/[，、]/g, '|')
    .replace(/[＝]/g, '=')
    .trim()
}

function splitFields(line: string): Array<[string, string]> {
  return line
    .split(/[|｜]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const separator = part.indexOf(':')
      if (separator < 0) {
        return ['', part]
      }
      return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()]
    })
}

function parseInteger(value: string): number | null {
  const matched = value.match(/\d+/)
  if (!matched) {
    return null
  }
  return Number(matched[0])
}

function parseScale(value: string): SheetScale | null {
  const normalized = value.replace(/[：]/g, ':').replace(/\s+/g, '')
  return (SHEET_SCALES as readonly string[]).includes(normalized) ? (normalized as SheetScale) : null
}

function parseBooleanFlag(value: string): boolean {
  return ['是', 'true', '1', '主用', 'y', 'yes'].includes(value.trim().toLowerCase())
}

function issue(
  level: RevisionIssue['level'],
  kind: RevisionIssue['kind'],
  message: string,
  lineNo?: number,
): RevisionIssue {
  return { level, kind, message, ...(lineNo ? { lineNo } : {}) }
}

/**
 * 解析兄弟馆带回的离线编目修订表文本。
 * 三段结构：【图幅】【扫描件】【四至】，以「批次号: …」标明批次。
 */
export function parseRevisionText(text: string): {
  parsed: RevisionParseResult | null
  issues: RevisionIssue[]
} {
  const issues: RevisionIssue[] = []
  let batchId = ''
  const sheetInputs: RevisionSheetInput[] = []
  const scanInputs: RevisionScanInput[] = []
  const edgeInputs: RevisionEdgeInput[] = []
  let section: SectionKind = null
  const sheetCodeSeen = new Set<string>()
  const scanKeySeen = new Set<string>()
  const edgeSlotSeen = new Set<string>()

  const lines = text.split(/\r?\n/)
  lines.forEach((rawLine, index) => {
    const lineNo = index + 1
    const line = normalizeLine(rawLine)
    if (!line || line.startsWith('#') || line.startsWith('//')) {
      return
    }

    const header = line.match(/^【(.+)】$/)
    if (header) {
      const title = header[1]
      if (title.includes('图幅')) {
        section = 'sheet'
      } else if (title.includes('扫描')) {
        section = 'scan'
      } else if (title.includes('四至') || title.includes('邻接')) {
        section = 'edge'
      } else {
        section = null
      }
      return
    }

    const batchMatch = line.match(/批次(?:号)?\s*:\s*(\S+)/)
    if (batchMatch) {
      batchId = batchMatch[1]
      return
    }

    if (section === 'sheet') {
      parseSheetLine(line, lineNo, issues, sheetInputs, sheetCodeSeen)
    } else if (section === 'scan') {
      parseScanLine(line, lineNo, issues, scanInputs, scanKeySeen)
    } else if (section === 'edge') {
      parseEdgeLine(line, lineNo, issues, edgeInputs, edgeSlotSeen)
    }
  })

  if (!batchId) {
    issues.push(issue('error', 'parse', '修订表缺少「批次号」，无法建立批次对账。'))
  }
  if (sheetInputs.length === 0) {
    issues.push(issue('error', 'parse', '【图幅】段为空或不存在，批次至少要声明一幅图幅。'))
  }

  return {
    parsed: batchId
      ? { batchId, sheets: sheetInputs, scans: scanInputs, edges: edgeInputs }
      : null,
    issues,
  }
}

function parseSheetLine(
  line: string,
  lineNo: number,
  issues: RevisionIssue[],
  sink: RevisionSheetInput[],
  codeSeen: Set<string>,
): void {
  const fields: SheetFields = {}
  for (const [rawKey, value] of splitFields(line)) {
    const key = rawKey.trim()
    switch (key) {
      case '图幅号':
      case '图号':
        fields.code = value
        break
      case '版本':
      case '图幅版本':
        fields.version = parseInteger(value) ?? undefined
        break
      case '题名':
      case '图名':
        fields.title = value
        break
      case '年代':
      case '年份':
      case '测绘年代':
        fields.year = parseInteger(value) ?? undefined
        break
      case '比例尺':
        fields.scale = parseScale(value) ?? undefined
        break
      case '投影':
      case '投影方式':
        fields.projection = value
        break
      case '尺寸':
      case '图幅尺寸':
        fields.sheetSizeCm = value
        break
      case '图组':
      case '系列':
      case '所属图组':
        fields.series = value
        break
      case '状态':
      case '整理状态':
        fields.status = (SHEET_STATUSES as readonly string[]).includes(value)
          ? (value as SheetStatus)
          : undefined
        break
      default:
        break
    }
  }

  if (!fields.code) {
    issues.push(issue('error', 'parse', `第 ${lineNo} 行无法识别为图幅记录（缺少图幅号）。`, lineNo))
    return
  }
  if (codeSeen.has(fields.code)) {
    issues.push(issue('error', 'duplicate', `图幅号 ${fields.code} 在批次内重复声明。`, lineNo))
    return
  }
  codeSeen.add(fields.code)

  const missing: string[] = []
  for (const [label, value] of [
    ['版本', fields.version],
    ['题名', fields.title],
    ['年代', fields.year],
    ['比例尺', fields.scale],
    ['投影', fields.projection],
    ['状态', fields.status],
  ] as const) {
    if (value === undefined || value === '') {
      missing.push(label)
    }
  }
  if (missing.length) {
    issues.push(
      issue('error', 'parse', `图幅 ${fields.code} 缺少或无法识别字段：${missing.join('、')}。`, lineNo),
    )
  }
  if (fields.scale === undefined && line.includes('比例尺')) {
    issues.push(
      issue('error', 'enum', `图幅 ${fields.code} 的比例尺不在允许范围（1:5000 / 1:50000）。`, lineNo),
    )
  }
  if (fields.status === undefined && line.includes('状态')) {
    issues.push(issue('error', 'enum', `图幅 ${fields.code} 的整理状态无法识别。`, lineNo))
  }

  sink.push({
    lineNo,
    code: fields.code,
    version: fields.version ?? 0,
    title: fields.title ?? '',
    year: fields.year ?? 0,
    scale: fields.scale ?? '1:5000',
    projection: fields.projection ?? '',
    sheetSizeCm: fields.sheetSizeCm ?? '未登记',
    series: fields.series ?? '修订批次',
    status: fields.status ?? '待核',
  })
}

function parseScanLine(
  line: string,
  lineNo: number,
  issues: RevisionIssue[],
  sink: RevisionScanInput[],
  keySeen: Set<string>,
): void {
  const fields: ScanFields = {}
  const pairs = splitFields(line)
  for (const [rawKey, value] of pairs) {
    const key = rawKey.trim()
    switch (key) {
      case '图幅号':
      case '图号':
        fields.sheetCode = value
        break
      case '版本':
      case '图幅版本':
        fields.sheetVersion = parseInteger(value) ?? undefined
        break
      case '文件名':
      case '扫描文件名':
        fields.fileName = value
        break
      case '分辨率':
      case 'dpi':
      case 'DPI':
        fields.resolutionDpi = parseInteger(value) ?? undefined
        break
      case '色彩':
      case '色彩模式':
        fields.colorMode = (COLOR_MODES as readonly string[]).includes(value)
          ? (value as ColorMode)
          : undefined
        break
      case '分块':
      case '分块数':
        fields.pieces = parseInteger(value) ?? undefined
        break
      case '质量':
      case '图像质量':
        fields.quality = (SCAN_QUALITIES as readonly string[]).includes(value)
          ? (value as ScanQuality)
          : undefined
        break
      case '存放':
      case '存放位置':
      case '存储位置':
        fields.storageNote = value
        break
      case '主用':
      case '主用件':
        fields.isPrimary = parseBooleanFlag(value)
        break
      default:
        break
    }
  }

  if (!fields.sheetCode || !fields.fileName) {
    issues.push(
      issue('error', 'parse', `第 ${lineNo} 行无法识别为扫描件记录（缺少图幅号或文件名）。`, lineNo),
    )
    return
  }
  const dedupeKey = `${fields.sheetCode}@${fields.sheetVersion ?? '?'}:${fields.fileName}`
  if (keySeen.has(dedupeKey)) {
    issues.push(
      issue('error', 'duplicate', `扫描件 ${fields.fileName} 在 ${fields.sheetCode} 下重复登记。`, lineNo),
    )
    return
  }
  keySeen.add(dedupeKey)

  if (fields.sheetVersion === undefined) {
    issues.push(issue('error', 'parse', `扫描件 ${fields.fileName} 缺少图幅版本，无法对账落位。`, lineNo))
  }
  if (fields.colorMode === undefined) {
    issues.push(issue('error', 'enum', `扫描件 ${fields.fileName} 的色彩模式无法识别。`, lineNo))
  }
  if (fields.quality === undefined) {
    issues.push(issue('error', 'enum', `扫描件 ${fields.fileName} 的图像质量无法识别。`, lineNo))
  }

  sink.push({
    lineNo,
    sheetCode: fields.sheetCode,
    sheetVersion: fields.sheetVersion ?? 0,
    fileName: fields.fileName,
    resolutionDpi: fields.resolutionDpi ?? 0,
    colorMode: fields.colorMode ?? '彩色',
    pieces: fields.pieces ?? 1,
    quality: fields.quality ?? '清晰',
    storageNote: fields.storageNote ?? '',
    isPrimary: fields.isPrimary ?? false,
  })
}

function parseEdgeLine(
  line: string,
  lineNo: number,
  issues: RevisionIssue[],
  sink: RevisionEdgeInput[],
  slotSeen: Set<string>,
): void {
  // 表单式：图幅号:X|版本:v|方向:东|邻接图号:Y|邻接版本:w
  if (line.includes('方向') || line.includes('邻接图号')) {
    let fromCode: string | undefined
    let fromVersion: number | undefined
    let direction: RevisionDirection | undefined
    let toCode: string | undefined
    let toVersion: number | null = null
    for (const [rawKey, rawValue] of splitFields(line)) {
      const key = rawKey.trim()
      const value = rawValue.replace(/[（(].*?[)）]/g, '').trim()
      switch (key) {
        case '图幅号':
        case '图号':
        case '本图号':
          fromCode = value
          break
        case '版本':
        case '本图版本':
          fromVersion = parseInteger(value) ?? undefined
          break
        case '方向':
        case '四至':
          direction = (REVISION_DIRECTIONS as readonly string[]).includes(value)
            ? (value as RevisionDirection)
            : undefined
          break
        case '邻接图号':
        case '邻图号':
        case '对图号':
          toCode = value
          break
        case '邻接版本':
        case '邻图版本':
          toVersion = parseInteger(value)
          break
        default:
          break
      }
    }

    if (!fromCode || !toCode) {
      issues.push(issue('error', 'parse', `第 ${lineNo} 行四至记录缺少本图号或邻接图号。`, lineNo))
      return
    }
    if (!direction) {
      issues.push(issue('error', 'enum', `四至记录 ${fromCode} → ${toCode} 的方向无法识别。`, lineNo))
      return
    }
    if (fromVersion === undefined) {
      issues.push(issue('error', 'parse', `四至记录 ${fromCode} ${direction} 缺少本图版本。`, lineNo))
    }
    const slotKey = `${fromCode}:${direction}`
    if (slotSeen.has(slotKey)) {
      issues.push(issue('error', 'duplicate', `${fromCode} 的「${direction}」向邻接关系重复声明。`, lineNo))
      return
    }
    slotSeen.add(slotKey)
    sink.push({
      lineNo,
      fromCode,
      fromVersion: fromVersion ?? 0,
      direction,
      toCode,
      toVersion,
    })
    return
  }

  // 简式：四至 X[v] 东 Y@w
  const compact = line.replace(/^四至\s*/, '').trim()
  const tokens = compact.split(/\s+/).filter(Boolean)
  const fromMatch = tokens[0]?.match(/^(.+?)(?:\[(\d+)\])?$/)
  const directionToken = tokens[1]
  const toMatch = tokens[2]?.match(/^(.+?)(?:@(\d+))?$/)
  if (!fromMatch?.[1] || !directionToken || !toMatch?.[1]) {
    issues.push(
      issue('error', 'parse', `第 ${lineNo} 行四至记录格式无法识别（参考：四至 图号[版本] 东 邻号@版本）。`, lineNo),
    )
    return
  }
  const fromCode = fromMatch[1]
  const fromVersionText = fromMatch[2]
  const direction = directionToken.replace(/[（(].*?[)）]/g, '').trim() as RevisionDirection
  const toCode = toMatch[1]
  const toVersion = toMatch[2] ? Number(toMatch[2]) : null
  if (!(REVISION_DIRECTIONS as readonly string[]).includes(direction)) {
    issues.push(issue('error', 'enum', `四至记录 ${fromCode} 的方向「${directionToken}」无法识别。`, lineNo))
    return
  }
  if (!fromVersionText) {
    issues.push(issue('error', 'parse', `四至记录 ${fromCode} ${direction} 缺少本图版本（图号[版本]）。`, lineNo))
  }
  const slotKey = `${fromCode}:${direction}`
  if (slotSeen.has(slotKey)) {
    issues.push(issue('error', 'duplicate', `${fromCode} 的「${direction}」向邻接关系重复声明。`, lineNo))
    return
  }
  slotSeen.add(slotKey)
  sink.push({
    lineNo,
    fromCode,
    fromVersion: fromVersionText ? Number(fromVersionText) : 0,
    direction,
    toCode,
    toVersion,
  })
}

/** FNV-1a 指纹，规范化后同一份修订表再次导入沿用首次结果 */
function fingerprintOf(text: string): string {
  const normalized = text
    .split(/\r?\n/)
    .map((line) => normalizeLine(line))
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('//'))
    .join('\n')
  let hash = 0x811c9dc5
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

/**
 * 按图幅号 + 图幅版本与本地编目对账。
 * 图幅、扫描件、四至三类条目必须各自落到同一版本，任何错误都会阻止整批写入。
 */
export function reconcileRevision(
  text: string,
  localSheets: Sheet[],
  localScans: ScanItem[],
  appliedRevisions: Array<{ fingerprint: string; appliedAt: string }>,
): RevisionReport | null {
  const { parsed, issues } = parseRevisionText(text)
  if (!parsed) {
    return null
  }

  const localByCode = new Map(localSheets.map((sheet) => [sheet.code, sheet]))
  const batchSheetByCode = new Map(parsed.sheets.map((sheet) => [sheet.code, sheet]))
  const primaryPerSheet = new Map<string, number>()

  // —— 图幅对账：重号图幅必须以更新版本替换 ——
  const sheetPreviews: SheetPreview[] = parsed.sheets.map((input) => {
    const local = localByCode.get(input.code)
    let action: SheetPreview['action'] = 'add'
    let localVersion: number | undefined
    if (local) {
      action = 'replace'
      localVersion = local.version
      if (local.version === input.version) {
        issues.push(
          issue(
            'error',
            'version',
            `图幅 ${input.code} 本地已是版本 ${input.version}，修订表未提供更新版本，直接追加重号。`,
            input.lineNo,
          ),
        )
      } else if (local.version > input.version) {
        issues.push(
          issue(
            'error',
            'version',
            `图幅 ${input.code} 本地为版本 ${local.version}，修订表反而是更旧的版本 ${input.version}。`,
            input.lineNo,
          ),
        )
      }
    }
    return {
      code: input.code,
      version: input.version,
      action,
      ...(localVersion !== undefined ? { localVersion } : {}),
      title: input.title,
      year: input.year,
      scale: input.scale,
      status: input.status,
      scanCount: 0,
      neighborDirections: [],
    } satisfies SheetPreview
  })

  // —— 扫描件对账：只能挂到本批次同版本图幅上 ——
  const scanPreviews: ScanPreview[] = []
  parsed.scans.forEach((input) => {
    const batchSheet = batchSheetByCode.get(input.sheetCode)
    if (!batchSheet) {
      const local = localByCode.get(input.sheetCode)
      issues.push(
        issue(
          'error',
          'version',
          local
            ? `扫描件 ${input.fileName} 指向图幅 ${input.sheetCode}，但该图幅不在本批次；扫描件必须随同批次图幅一起落位。`
            : `扫描件 ${input.fileName} 指向批次内不存在的图幅 ${input.sheetCode}。`,
          input.lineNo,
        ),
      )
    } else if (batchSheet.version !== input.sheetVersion) {
      issues.push(
        issue(
          'error',
          'version',
          `扫描件 ${input.fileName} 标注 ${input.sheetCode}@${input.sheetVersion}，批次图幅是版本 ${batchSheet.version}，会挂到旧图上。`,
          input.lineNo,
        ),
      )
    }
    if (!input.storageNote) {
      issues.push(issue('error', 'parse', `扫描件 ${input.fileName} 缺少存放位置。`, input.lineNo))
    }
    if (!input.resolutionDpi) {
      issues.push(issue('error', 'parse', `扫描件 ${input.fileName} 缺少分辨率。`, input.lineNo))
    }
    if (input.isPrimary) {
      primaryPerSheet.set(input.sheetCode, (primaryPerSheet.get(input.sheetCode) ?? 0) + 1)
    }
    scanPreviews.push({
      fileName: input.fileName,
      sheetCode: input.sheetCode,
      sheetVersion: input.sheetVersion,
      isPrimary: input.isPrimary,
    })
  })
  for (const [code, count] of primaryPerSheet) {
    if (count > 1) {
      issues.push(issue('warning', 'duplicate', `图幅 ${code} 声明了 ${count} 件主用件，写入时以首件为主。`))
    }
  }

  // —— 四至对账：本图必须是批次同版本图幅，邻图要么同批次、要么本地同版本 ——
  type Slots = Map<RevisionDirection, { code: string; lineNo: number }>
  const slotsByCode = new Map<string, Slots>()
  const edgePreviews: EdgePreview[] = []

  for (const input of parsed.edges) {
    const fromBatch = batchSheetByCode.get(input.fromCode)
    if (!fromBatch) {
      issues.push(
        issue(
          'error',
          'version',
          `四至关系的本图 ${input.fromCode} 不在批次图幅清单内，不能随本批改写邻接关系。`,
          input.lineNo,
        ),
      )
      continue
    }
    if (fromBatch.version !== input.fromVersion) {
      issues.push(
        issue(
          'error',
          'version',
          `四至记录标注 ${input.fromCode}@${input.fromVersion}，批次图幅是版本 ${fromBatch.version}，邻接关系会指向旧图。`,
          input.lineNo,
        ),
      )
      continue
    }

    const targetBatch = batchSheetByCode.get(input.toCode)
    let targetVersion: number | null = null
    let targetAction: 'batch' | 'local' | null = null
    if (targetBatch) {
      targetVersion = targetBatch.version
      targetAction = 'batch'
      if (input.toVersion !== null && input.toVersion !== targetBatch.version) {
        issues.push(
          issue(
            'error',
            'version',
            `四至 ${input.fromCode} ${input.direction} → ${input.toCode}@${input.toVersion} 与批次声明版本 ${targetBatch.version} 不一致。`,
            input.lineNo,
          ),
        )
      }
    } else {
      const targetLocal = localByCode.get(input.toCode)
      if (targetLocal) {
        if (input.toVersion === null) {
          issues.push(
            issue(
              'error',
              'gap',
              `邻接图 ${input.toCode} 不在本批次，须用「${input.toCode}@${targetLocal.version}」标明对账版本。`,
              input.lineNo,
            ),
          )
        } else if (input.toVersion !== targetLocal.version) {
          issues.push(
            issue(
              'error',
              'version',
              `邻接图 ${input.toCode} 本地为版本 ${targetLocal.version}，四至记录仍指向版本 ${input.toVersion}（旧图）。`,
              input.lineNo,
            ),
          )
        } else {
          targetVersion = targetLocal.version
          targetAction = 'local'
        }
      } else {
        issues.push(
          issue(
            'error',
            'gap',
            `四至 ${input.fromCode} ${input.direction} 的邻接图 ${input.toCode}${
              input.toVersion !== null ? `@${input.toVersion}` : ''
            } 在本地与批次内都不存在，属馆藏缺口。`,
            input.lineNo,
          ),
        )
      }
    }

    const slots = slotsByCode.get(input.fromCode) ?? new Map<RevisionDirection, { code: string; lineNo: number }>()
    slots.set(input.direction, { code: input.toCode, lineNo: input.lineNo })
    slotsByCode.set(input.fromCode, slots)

    // 反向镜像：仅在批次图幅之间落位；本地未入批图幅不代其改写，只给提示
    let mirrored = false
    let mirroredNote: string | undefined
    const reverse = REVERSE_DIRECTION[input.direction]
    if (targetAction === 'batch') {
      const reverseSlots =
        slotsByCode.get(input.toCode) ??
        new Map<RevisionDirection, { code: string; lineNo: number }>()
      const occupied = reverseSlots.get(reverse)
      if (!occupied) {
        reverseSlots.set(reverse, { code: input.fromCode, lineNo: input.lineNo })
        slotsByCode.set(input.toCode, reverseSlots)
        mirrored = true
      } else if (occupied.code !== input.fromCode) {
        mirroredNote = `对向「${reverse}」已声明邻接 ${occupied.code}，镜像 ${input.fromCode} 与批次声明冲突，保留批次声明。`
        issues.push(issue('warning', 'version', mirroredNote, input.lineNo))
      }
    } else if (targetAction === 'local') {
      const localSlots = (localByCode.get(input.toCode)?.neighborCodes ?? [])
      const localAt = localSlots[REVISION_DIRECTIONS.indexOf(reverse)]
      if (localAt && localAt !== input.fromCode) {
        mirroredNote = `本地图幅 ${input.toCode} 的「${reverse}」向现为 ${localAt}，与修订镜像不一致；该图幅未入批，本次不代改，请后续补齐。`
        issues.push(issue('warning', 'gap', mirroredNote, input.lineNo))
      }
    }

    edgePreviews.push({
      fromCode: input.fromCode,
      fromVersion: input.fromVersion,
      direction: input.direction,
      toCode: input.toCode,
      toVersion: targetVersion ?? input.toVersion ?? 0,
      targetAction: targetAction ?? 'local',
      mirrored,
      ...(mirroredNote ? { mirroredNote } : {}),
    })
  }

  // 回填图幅预览上的扫描件数与四至方向
  const localScanCountBySheetId = new Map<string, number>()
  for (const scan of localScans) {
    localScanCountBySheetId.set(scan.sheetId, (localScanCountBySheetId.get(scan.sheetId) ?? 0) + 1)
  }
  for (const preview of sheetPreviews) {
    preview.scanCount = parsed.scans.filter(
      (scan) => scan.sheetCode === preview.code && scan.sheetVersion === preview.version,
    ).length
    preview.neighborDirections = [
      ...(slotsByCode.get(preview.code)?.keys() ?? new Set<RevisionDirection>()),
    ]
    if (preview.action === 'replace' && preview.scanCount === 0) {
      const existing = localByCode.get(preview.code)
      const existingScanCount = existing ? localScanCountBySheetId.get(existing.id) ?? 0 : 0
      if (existingScanCount > 0) {
        issues.push(
          issue(
            'warning',
            'version',
            `图幅 ${preview.code} 升版但未附任何扫描件，本地原 ${existingScanCount} 件旧扫描件将一并撤下。`,
          ),
        )
      }
    }
  }

  // 入批替换的图幅，旧邻接里若存在批次未重新声明的图号，提示这些旧关系会被移除
  for (const preview of sheetPreviews) {
    if (preview.action !== 'replace') {
      continue
    }
    const local = localByCode.get(preview.code)
    const nextSlots = slotsByCode.get(preview.code)
    const stale: string[] = []
    ;(local?.neighborCodes ?? []).forEach((code, index) => {
      const direction = REVISION_DIRECTIONS[index]
      if (direction && nextSlots?.get(direction)?.code !== code && !nextSlots?.has(direction)) {
        stale.push(`${code}（${direction}）`)
      }
    })
    if (stale.length) {
      issues.push(
        issue(
          'warning',
          'version',
          `图幅 ${preview.code} 升版后，修订表未重新声明的旧邻接 ${stale.join('、')} 将一并清除。`,
        ),
      )
    }
  }

  const errors = issues.filter((item) => item.level === 'error')
  const warnings = issues.filter((item) => item.level === 'warning')
  const previous = appliedRevisions.find((item) => item.fingerprint === fingerprintOf(text))
  const fingerprint = fingerprintOf(text)

  return {
    batchId: parsed.batchId,
    fingerprint,
    parsed,
    sheetPreviews,
    scanPreviews,
    edgePreviews,
    issues,
    errors,
    warnings,
    alreadyApplied: Boolean(previous),
    ...(previous ? { appliedAt: previous.appliedAt } : {}),
  }
}

/** 计算一批图幅落位后的邻接图号序列（仅入批图幅参与改写） */
export function neighborCodesForBatch(report: RevisionReport): Record<string, string[]> {
  const result: Record<string, string[]> = {}
  const batchCodes = new Set(report.sheetPreviews.map((preview) => preview.code))
  const slotsByCode = new Map<string, Map<RevisionDirection, string>>()

  for (const edge of report.parsed.edges) {
    if (!batchCodes.has(edge.fromCode)) {
      continue
    }
    const slots = slotsByCode.get(edge.fromCode) ?? new Map<RevisionDirection, string>()
    slots.set(edge.direction, edge.toCode)
    slotsByCode.set(edge.fromCode, slots)
  }
  // 批次内部镜像补对向
  for (const edge of report.edgePreviews) {
    if (edge.mirrored && batchCodes.has(edge.toCode)) {
      const slots = slotsByCode.get(edge.toCode) ?? new Map<RevisionDirection, string>()
      if (!slots.has(REVERSE_DIRECTION[edge.direction])) {
        slots.set(REVERSE_DIRECTION[edge.direction], edge.fromCode)
        slotsByCode.set(edge.toCode, slots)
      }
    }
  }

  for (const code of batchCodes) {
    const slots = slotsByCode.get(code)
    result[code] = REVISION_DIRECTIONS.filter((direction) => slots?.has(direction)).map(
      (direction) => slots!.get(direction)!,
    )
  }
  return result
}
