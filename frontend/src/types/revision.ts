import type { ColorMode, ScanQuality } from './scan'
import type { SheetScale, SheetStatus } from './sheet'

/**
 * 离线修订表（兄弟馆带回本机的编目修订文本）相关数据模型。
 * 修订以“批次”为单位：一个批次里的图幅、扫描件与四至关系必须
 * 能同时落到同一图幅版本，整批一起对账、一起写入。
 */

export type RevisionIssueKind = '格式' | '缺口' | '版本冲突'

export interface RevisionIssue {
  kind: RevisionIssueKind
  code: string
  subject: string
  message: string
}

export type RevisionBlockType = 'sheet' | 'scan' | 'relation'

export interface SheetRevisionPayload {
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

export interface ScanRevisionPayload {
  code: string
  version: number
  fileName: string
  resolutionDpi: number
  colorMode: ColorMode
  pieces: number
  quality: ScanQuality
  storageNote: string
  isPrimary: boolean
  importedAt?: string
}

export interface RelationEntry {
  code: string
  version?: number
}

export interface RelationRevisionPayload {
  code: string
  version: number
  /** 四至邻接，按本台方向顺序排列；方向缺失时表示该方向仍待编。 */
  neighbors: Partial<Record<string, RelationEntry>>
}

export type RevisionBlock =
  | { type: 'sheet'; line: number; payload: SheetRevisionPayload }
  | { type: 'scan'; line: number; payload: ScanRevisionPayload }
  | { type: 'relation'; line: number; payload: RelationRevisionPayload }

export interface RevisionBatch {
  rawText: string
  blocks: RevisionBlock[]
  issues: RevisionIssue[]
  /** 全部缺口、版本冲突、格式问题解决后为 true，方可整批写入。 */
  ready: boolean
  sheetCodes: string[]
  scanCount: number
  relationCount: number
}

export interface AppliedRevisionSummary {
  id: string
  hash: string
  appliedAt: string
  status: '已应用'
  sheetCodes: string[]
  scanCount: number
  relationCount: number
  sheetCount: number
}

/**
 * 已应用批次的留档。同一批资料再次导入时按归一化文本的摘要命中，
 * 直接沿用首次结果，不重复写入。
 */
export interface RevisionRecord extends AppliedRevisionSummary {
  rawText: string
}

/**
 * 待确认区暂存。写入失败后可以重试，贴入的修订表文本仍保留，
 * 因此暂存与已应用记录分开存放。
 */
export interface RevisionStaging {
  id: string
  rawText: string
  updatedAt: string
}
