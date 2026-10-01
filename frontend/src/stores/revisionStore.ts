import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createId, db, plain } from '../utils/db'
import {
  hashRevisionText,
  normalizeRevisionText,
  reconcileBatch,
  ORDERED_DIRECTIONS,
} from '../utils/revision'
import type { AppliedRevisionSummary, RevisionBatch, RevisionRecord } from '../types/revision'
import type { Sheet } from '../types/sheet'
import type { ScanItem } from '../types/scan'
import { useSheetStore } from './sheetStore'

const STAGING_ID = 'pending-revision'

/**
 * 离线修订表（兄弟馆带回的编目修订）工作流：
 *
 * 1. 整理员把修订表文本贴进待确认区（stageDraft），文本即时持久化，
 *    应用失败后重试也不会丢失。
 * 2. 每次文本变化都按图幅号与图幅版本和本地编目对账（reconcile），
 *    标出格式问题、缺编缺口与版本冲突。
 * 3. 只有一个批次里的图幅、扫描件、四至关系都能落到同一版本时才允许
 *    整批写入（applyBatch），写入是单事务，任何一步失败整批回滚。
 * 4. 写入成功后留档；同一批资料再次导入按文本摘要沿用首次结果。
 */
export const useRevisionStore = defineStore('revision', () => {
  const draftText = ref('')
  const batch = ref<RevisionBatch | null>(null)
  const appliedRecords = ref<RevisionRecord[]>([])
  const reusedRecord = ref<RevisionRecord | null>(null)
  const applying = ref(false)
  const applyError = ref('')
  const initialized = ref(false)

  const issues = computed(() => batch.value?.issues ?? [])
  const ready = computed(() => batch.value?.ready ?? false)
  const issueGroups = computed(() => ({
    格式: issues.value.filter((item) => item.kind === '格式'),
    缺口: issues.value.filter((item) => item.kind === '缺口'),
    版本冲突: issues.value.filter((item) => item.kind === '版本冲突'),
  }))

  async function init(): Promise<void> {
    if (initialized.value) {
      return
    }
    const sheetStore = useSheetStore()
    await sheetStore.init()
    const [staging, records] = await Promise.all([
      db.revisionStaging.get(STAGING_ID),
      db.revisions.orderBy('appliedAt').reverse().toArray(),
    ])
    draftText.value = staging?.rawText ?? ''
    appliedRecords.value = records
    if (draftText.value) {
      reconcile()
    }
    initialized.value = true
  }

  async function stageDraft(rawText: string): Promise<void> {
    draftText.value = rawText
    reusedRecord.value = null
    reconcile()
    const normalized = normalizeRevisionText(rawText)
    await db.revisionStaging.put(
      plain({
        id: STAGING_ID,
        rawText,
        updatedAt: new Date().toISOString(),
      }),
    )
    if (!normalized) {
      return
    }
    // 同一批资料再次导入：按归一化文本摘要沿用首次结果，不重复对账写入。
    const digest = await hashRevisionText(rawText)
    const previous = appliedRecords.value.find((record) => record.hash === digest)
    if (previous) {
      reusedRecord.value = previous
    }
  }

  function reconcile(): void {
    const normalized = normalizeRevisionText(draftText.value)
    if (!normalized) {
      batch.value = null
      applyError.value = ''
      return
    }
    const sheetStore = useSheetStore()
    batch.value = reconcileBatch(normalized, sheetStore.sheets)
    applyError.value = ''
  }

  async function applyBatch(): Promise<AppliedRevisionSummary | null> {
    if (!batch.value || !batch.value.ready || applying.value) {
      return null
    }
    const sheetStore = useSheetStore()
    await sheetStore.init()
    applying.value = true
    applyError.value = ''

    const textToApply = batch.value.rawText
    const digest = await hashRevisionText(textToApply)
    const previous = appliedRecords.value.find((record) => record.hash === digest)
    if (previous) {
      applying.value = false
      reusedRecord.value = previous
      return previous
    }

    // 提交前以库内最新数据再对一次账，避免与本机新改动冲突。
    const latestSheets = await db.sheets.toArray()
    const checked = reconcileBatch(textToApply, latestSheets.map((sheet) => ({ code: sheet.code, version: sheet.version })))
    batch.value = checked
    if (!checked.ready) {
      applying.value = false
      applyError.value = '本机编目已有新变化，请处理缺口或版本冲突后再提交。'
      return null
    }

    try {
      await db.transaction('rw', db.sheets, db.scans, db.revisions, db.revisionStaging, async () => {
        const sheetPayloads = checked.blocks.flatMap((block) => (block.type === 'sheet' ? [block.payload] : []))
        const scanPayloads = checked.blocks.flatMap((block) => (block.type === 'scan' ? [block.payload] : []))
        const relationPayloads = checked.blocks.flatMap((block) => (block.type === 'relation' ? [block.payload] : []))

        // 图幅：同图幅号整幅替换为新版本（沿用原 id，地名等关联不致悬空）。
        for (const payload of sheetPayloads) {
          const existing = await db.sheets.where('code').equals(payload.code).first()
          const nextSheet: Sheet = {
            id: existing?.id ?? createId('sheet'),
            code: payload.code,
            version: payload.version,
            title: payload.title,
            year: payload.year,
            scale: payload.scale,
            projection: payload.projection,
            sheetSizeCm: payload.sheetSizeCm,
            series: payload.series,
            neighborCodes: existing?.neighborCodes ?? [],
            status: payload.status,
          }
          await db.sheets.put(plain(nextSheet))
        }

        // 扫描件：批次带了该图幅号的扫描件，就整体替换旧图上的扫描件，
        // 防止扫描件继续挂在已被替换的旧版图幅上。
        const scanCodes = new Set(scanPayloads.map((payload) => payload.code))
        for (const code of scanCodes) {
          const owner = await db.sheets.where('code').equals(code).first()
          if (owner) {
            await db.scans.where('sheetId').equals(owner.id).delete()
          }
        }
        const primaryByCode = new Map<string, number>()
        scanPayloads.forEach((payload, index) => {
          if (payload.isPrimary) {
            primaryByCode.set(payload.code, index)
          }
        })
        const importedScans: ScanItem[] = []
        for (let index = 0; index < scanPayloads.length; index += 1) {
          const payload = scanPayloads[index]
          const owner = await db.sheets.where('code').equals(payload.code).first()
          importedScans.push({
            id: createId('scan'),
            sheetId: owner?.id ?? '',
            fileName: payload.fileName,
            resolutionDpi: payload.resolutionDpi,
            colorMode: payload.colorMode,
            pieces: payload.pieces,
            quality: payload.quality,
            storageNote: payload.storageNote,
            importedAt: payload.importedAt ?? new Date().toISOString(),
            isPrimary: primaryByCode.get(payload.code) === index,
          })
        }
        // 没有任何扫描件标记主用件时，每幅图的第一件默认为主用件。
        const firstByCode = new Map<string, number>()
        scanPayloads.forEach((payload, index) => {
          if (!firstByCode.has(payload.code)) {
            firstByCode.set(payload.code, index)
          }
        })
        for (const [code, firstIndex] of firstByCode) {
          if (!primaryByCode.has(code)) {
            importedScans[firstIndex].isPrimary = true
          }
        }
        await db.scans.bulkAdd(importedScans.map(plain))

        // 四至：按固定方向顺序写回 neighborCodes，引用的都是已确认版本。
        for (const payload of relationPayloads) {
          const owner = await db.sheets.where('code').equals(payload.code).first()
          if (!owner) {
            continue
          }
          const neighborCodes = ORDERED_DIRECTIONS.flatMap((direction) => {
            const entry = payload.neighbors[direction]
            return entry ? [entry.code] : []
          })
          await db.sheets.update(owner.id, { neighborCodes })
        }

        const record: RevisionRecord = {
          id: createId('revision'),
          hash: digest,
          appliedAt: new Date().toISOString(),
          status: '已应用',
          rawText: textToApply,
          sheetCodes: checked.sheetCodes,
          scanCount: checked.scanCount,
          relationCount: checked.relationCount,
          sheetCount: sheetPayloads.length,
        }
        await db.revisions.add(plain(record))
        await db.revisionStaging.delete(STAGING_ID)
      })

      await sheetStore.reload()
      appliedRecords.value = await db.revisions.orderBy('appliedAt').reverse().toArray()
      draftText.value = ''
      batch.value = null
      reusedRecord.value = null
      return appliedRecords.value[0] ?? null
    } catch (error) {
      // 事务失败会整体回滚（IndexedDB 中仍是旧版本）；再以库内数据刷新内存缓存，
      // 暂存文本此前已单独持久化，仍保留，可直接重试。
      await sheetStore.reload()
      reconcile()
      applyError.value = error instanceof Error ? error.message : '修订批次写入失败，请重试。'
      return null
    } finally {
      applying.value = false
    }
  }

  async function clearDraft(): Promise<void> {
    draftText.value = ''
    batch.value = null
    reusedRecord.value = null
    applyError.value = ''
    await db.revisionStaging.delete(STAGING_ID)
  }

  async function removeRecord(id: string): Promise<void> {
    await db.revisions.delete(id)
    appliedRecords.value = appliedRecords.value.filter((record) => record.id !== id)
  }

  return {
    draftText,
    batch,
    appliedRecords,
    reusedRecord,
    applying,
    applyError,
    initialized,
    issues,
    ready,
    issueGroups,
    init,
    stageDraft,
    reconcile,
    applyBatch,
    clearDraft,
    removeRecord,
  }
})
