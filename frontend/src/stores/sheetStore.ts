import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { AppliedRevision, RevisionReport } from '../types/revision'
import type { ScanItem } from '../types/scan'
import type { Sheet } from '../types/sheet'
import { createId, db, plain } from '../utils/db'
import { neighborCodesForBatch } from '../utils/revision'
import { sortByYear } from '../utils/scale'

export type NewSheet = Omit<Sheet, 'id' | 'neighborCodes' | 'version'> & {
  neighborCodes?: string[]
  version?: number
}
export type NewScanItem = Omit<ScanItem, 'id'>

export const useSheetStore = defineStore('sheet', () => {
  const sheets = ref<Sheet[]>([])
  const allScans = ref<ScanItem[]>([])
  const currentSheet = ref<Sheet | null>(null)
  const loading = ref(false)
  const initialized = ref(false)
  let initialization: Promise<void> | null = null

  const currentScans = computed(() =>
    currentSheet.value
      ? allScans.value.filter((scan) => scan.sheetId === currentSheet.value?.id)
      : [],
  )

  async function init(): Promise<void> {
    if (initialized.value) {
      return
    }
    if (!initialization) {
      loading.value = true
      initialization = Promise.all([db.sheets.toArray(), db.scans.toArray()])
        .then(([sheetRows, scanRows]) => {
          sheets.value = sortByYear(sheetRows).reverse()
          allScans.value = scanRows
          initialized.value = true
        })
        .finally(() => {
          loading.value = false
        })
    }
    await initialization
  }

  async function addSheet(input: NewSheet): Promise<Sheet> {
    await init()
    const sheet: Sheet = {
      ...input,
      id: createId('sheet'),
      version: input.version ?? 1,
      neighborCodes: input.neighborCodes ?? [],
    }
    await db.sheets.add(plain(sheet))
    sheets.value = sortByYear([...sheets.value, sheet]).reverse()
    currentSheet.value = sheet
    return sheet
  }

  /** 从 IndexedDB 重新读取图幅与扫描件，供修订批次落位后刷新各页面 */
  async function reload(): Promise<void> {
    const [sheetRows, scanRows] = await Promise.all([db.sheets.toArray(), db.scans.toArray()])
    sheets.value = sortByYear(sheetRows).reverse()
    allScans.value = scanRows
    if (currentSheet.value) {
      currentSheet.value = sheets.value.find((sheet) => sheet.id === currentSheet.value?.id) ?? null
    }
  }

  async function loadSheet(id: string): Promise<void> {
    await init()
    currentSheet.value = sheets.value.find((sheet) => sheet.id === id) ?? (await db.sheets.get(id)) ?? null
  }

  async function addScan(input: NewScanItem): Promise<ScanItem> {
    await init()
    const scan: ScanItem = { ...input, id: createId('scan') }
    if (scan.isPrimary) {
      await db.scans.where('sheetId').equals(scan.sheetId).modify({ isPrimary: false })
      allScans.value = allScans.value.map((item) =>
        item.sheetId === scan.sheetId ? { ...item, isPrimary: false } : item,
      )
    }
    await db.scans.add(plain(scan))
    allScans.value = [...allScans.value, scan]
    return scan
  }

  async function setPrimaryScan(scanId: string): Promise<void> {
    const target = allScans.value.find((scan) => scan.id === scanId)
    if (!target) {
      return
    }
    await db.scans.where('sheetId').equals(target.sheetId).modify({ isPrimary: false })
    await db.scans.update(scanId, { isPrimary: true })
    allScans.value = allScans.value.map((scan) => {
      if (scan.sheetId !== target.sheetId) {
        return scan
      }
      return { ...scan, isPrimary: scan.id === scanId }
    })
  }

  function getSheetById(id: string): Sheet | undefined {
    return sheets.value.find((sheet) => sheet.id === id)
  }

  function getSheetByCode(code: string): Sheet | undefined {
    return sheets.value.find((sheet) => sheet.code === code)
  }

  function getScansForSheet(sheetId: string): ScanItem[] {
    return allScans.value
      .filter((scan) => scan.sheetId === sheetId)
      .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary))
  }

  /**
   * 把对账通过的修订批次原子写入：图幅升版替换、扫描件整组替换、
   * 四至按批次重新落位，并登记已应用批次。任何一步失败整批回滚，可安全重试。
   */
  async function applyRevision(report: RevisionReport): Promise<AppliedRevision> {
    await init()
    const now = new Date().toISOString()
    const codeToNeighborCodes = neighborCodesForBatch(report)

    const record: AppliedRevision = {
      id: createId('applied'),
      batchId: report.batchId,
      fingerprint: report.fingerprint,
      appliedAt: now,
      sheetCount: report.sheetPreviews.length,
      scanCount: report.scanPreviews.length,
      edgeCount: report.edgePreviews.length,
    }

    await db.transaction(
      'rw',
      [db.sheets, db.scans, db.appliedRevisions],
      async () => {
        const duplicate = await db.appliedRevisions
          .where('fingerprint')
          .equals(report.fingerprint)
          .first()
        if (duplicate) {
          // 同批资料再次导入沿用首次结果，不重复写入
          return
        }
        const duplicateBatch = await db.appliedRevisions
          .where('batchId')
          .equals(report.batchId)
          .first()
        if (duplicateBatch) {
          throw new Error(`批次号 ${report.batchId} 已经应用过，请换用新批次号。`)
        }

        for (const input of report.parsed.sheets) {
          const existing = await db.sheets.where('code').equals(input.code).first()
          if (existing) {
            // 升版沿用原 id：地名对照、沿革继续挂在同一图幅上
            await db.sheets.put(
              plain({
                ...existing,
                version: input.version,
                title: input.title,
                year: input.year,
                scale: input.scale,
                projection: input.projection,
                sheetSizeCm: input.sheetSizeCm,
                series: input.series,
                status: input.status,
                neighborCodes: codeToNeighborCodes[input.code] ?? [],
              }),
            )
            // 旧图扫描件整组撤下，扫描件只能挂到已确认的新版本图幅
            await db.scans.where('sheetId').equals(existing.id).delete()
          } else {
            const newSheet: Sheet = {
              id: createId('sheet'),
              code: input.code,
              version: input.version,
              title: input.title,
              year: input.year,
              scale: input.scale,
              projection: input.projection,
              sheetSizeCm: input.sheetSizeCm,
              series: input.series,
              status: input.status,
              neighborCodes: codeToNeighborCodes[input.code] ?? [],
            }
            await db.sheets.add(plain(newSheet))
          }
        }

        const codeToId = new Map(
          (await db.sheets.where('code').anyOf(report.parsed.sheets.map((s) => s.code)).toArray()).map(
            (sheet) => [sheet.code, sheet.id],
          ),
        )
        const primaryMarked = new Set<string>()
        for (const input of report.parsed.scans) {
          const sheetId = codeToId.get(input.sheetCode)
          if (!sheetId) {
            throw new Error(`扫描件 ${input.fileName} 找不到落位图幅 ${input.sheetCode}`)
          }
          const isPrimary = input.isPrimary && !primaryMarked.has(input.sheetCode)
          if (isPrimary) {
            primaryMarked.add(input.sheetCode)
          }
          const scan: ScanItem = {
            id: createId('scan'),
            sheetId,
            fileName: input.fileName,
            resolutionDpi: input.resolutionDpi,
            colorMode: input.colorMode,
            pieces: input.pieces,
            quality: input.quality,
            storageNote: input.storageNote,
            importedAt: now,
            isPrimary,
          }
          await db.scans.add(plain(scan))
        }

        await db.appliedRevisions.add(plain(record))
      },
    )

    await reload()
    return record
  }

  async function listAppliedRevisions(): Promise<AppliedRevision[]> {
    return db.appliedRevisions.orderBy('appliedAt').reverse().toArray()
  }

  return {
    sheets,
    allScans,
    currentSheet,
    currentScans,
    loading,
    initialized,
    init,
    addSheet,
    reload,
    loadSheet,
    addScan,
    setPrimaryScan,
    getSheetById,
    getSheetByCode,
    getScansForSheet,
    applyRevision,
    listAppliedRevisions,
  }
})
