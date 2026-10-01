import type { ColorMode, ScanQuality } from './scan'
import type { SheetScale, SheetStatus } from './sheet'

/** 四至方向，修订表四至行可识别的取值 */
export type RevisionDirection = '东' | '南' | '西' | '北' | '东北' | '西南'

/** 修订表「图幅」段解析出的原始记录 */
export interface RevisionSheetInput {
  lineNo: number
  code: string
  version: number
  title: string
  year: number
  scale: SheetScale
  projection: string
  sheetSizeCm: string
  series: string
  status: SheetStatus
}

/** 修订表「扫描件」段解析出的原始记录 */
export interface RevisionScanInput {
  lineNo: number
  sheetCode: string
  sheetVersion: number
  fileName: string
  resolutionDpi: number
  colorMode: ColorMode
  pieces: number
  quality: ScanQuality
  storageNote: string
  isPrimary: boolean
}

/** 修订表「四至」段解析出的原始记录 */
export interface RevisionEdgeInput {
  lineNo: number
  fromCode: string
  fromVersion: number
  direction: RevisionDirection
  toCode: string
  toVersion: number | null
}

export interface RevisionParseResult {
  batchId: string
  sheets: RevisionSheetInput[]
  scans: RevisionScanInput[]
  edges: RevisionEdgeInput[]
}

export type RevisionIssueLevel = 'error' | 'warning'

export interface RevisionIssue {
  level: RevisionIssueLevel
  kind: 'parse' | 'version' | 'gap' | 'duplicate' | 'enum'
  message: string
  lineNo?: number
}

/** 图幅落位后的预览动作 */
export interface SheetPreview {
  code: string
  version: number
  action: 'replace' | 'add'
  localVersion?: number
  title: string
  year: number
  scale: SheetScale
  status: SheetStatus
  scanCount: number
  neighborDirections: RevisionDirection[]
}

/** 扫描件落位后的预览动作 */
export interface ScanPreview {
  fileName: string
  sheetCode: string
  sheetVersion: number
  isPrimary: boolean
}

/** 四至关系落位后的预览动作 */
export interface EdgePreview {
  fromCode: string
  fromVersion: number
  direction: RevisionDirection
  toCode: string
  toVersion: number
  targetAction: 'batch' | 'local'
  mirrored: boolean
  mirroredNote?: string
}

/** 对账报告，整理员确认前只能看到报告，不会写入本地 */
export interface RevisionReport {
  batchId: string
  fingerprint: string
  parsed: RevisionParseResult
  sheetPreviews: SheetPreview[]
  scanPreviews: ScanPreview[]
  edgePreviews: EdgePreview[]
  issues: RevisionIssue[]
  errors: RevisionIssue[]
  warnings: RevisionIssue[]
  /** 同一批次文本之前已经成功应用过，沿用上一次的结果 */
  alreadyApplied: boolean
  appliedAt?: string
}

/** 已成功应用的批次，写入 IndexedDB 供再次导入时沿用首次结果 */
export interface AppliedRevision {
  id: string
  batchId: string
  fingerprint: string
  appliedAt: string
  sheetCount: number
  scanCount: number
  edgeCount: number
}

/** 待确认区暂存（应用失败或刷新后仍保留） */
export interface RevisionDraft {
  text: string
  updatedAt: string
}
