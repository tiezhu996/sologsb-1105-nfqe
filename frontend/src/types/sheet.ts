export type SheetScale = '1:5000' | '1:50000'
export type SheetStatus = '待编' | '已编' | '待核'

export interface Sheet {
  id: string
  code: string
  /** 图幅版本号，兄弟馆离线修订以版本对账，避免重号图幅并存 */
  version: number
  title: string
  year: number
  scale: SheetScale
  projection: string
  sheetSizeCm: string
  series: string
  neighborCodes: string[]
  status: SheetStatus
}

export const SHEET_SCALES: SheetScale[] = ['1:5000', '1:50000']
export const SHEET_STATUSES: SheetStatus[] = ['待编', '已编', '待核']
