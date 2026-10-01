import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { AppliedRevision, RevisionReport } from '../types/revision'
import { reconcileRevision } from '../utils/revision'
import { useSheetStore } from './sheetStore'

const DRAFT_STORAGE_KEY = 'gboldmap-revision-draft'

function readDraft(): string {
  try {
    const raw = globalThis.localStorage?.getItem(DRAFT_STORAGE_KEY)
    return raw ?? ''
  } catch {
    return ''
  }
}

function writeDraft(text: string): void {
  try {
    if (text) {
      globalThis.localStorage?.setItem(DRAFT_STORAGE_KEY, text)
    } else {
      globalThis.localStorage?.removeItem(DRAFT_STORAGE_KEY)
    }
  } catch {
    // 隐私模式等场景下暂存不可用，仅在内存中保留本次待确认内容
  }
}

export const useRevisionStore = defineStore('revision', () => {
  const sheetStore = useSheetStore()
  /** 待确认区文本：应用失败或刷新后仍保留 */
  const draftText = ref<string>(readDraft())
  const report = ref<RevisionReport | null>(null)
  const applying = ref(false)
  const applyError = ref('')
  const appliedRevisions = ref<AppliedRevision[]>([])
  const lastApplied = ref<AppliedRevision | null>(null)

  const canCommit = computed(
    () =>
      Boolean(report.value) &&
      report.value!.errors.length === 0 &&
      !report.value!.alreadyApplied &&
      !applying.value,
  )

  function saveDraft(text: string): void {
    draftText.value = text
    writeDraft(text)
  }

  function clearDraft(): void {
    draftText.value = ''
    report.value = null
    applyError.value = ''
    writeDraft('')
  }

  /** 按图幅号 + 版本与本地编目对账，只生成报告，不写入 */
  async function analyze(): Promise<RevisionReport | null> {
    await sheetStore.init()
    applyError.value = ''
    const next = reconcileRevision(
      draftText.value,
      sheetStore.sheets,
      sheetStore.allScans,
      appliedRevisions.value,
    )
    report.value = next
    return next
  }

  /** 缺口或版本冲突处理后重试提交；失败时暂存文本原样保留 */
  async function commit(): Promise<boolean> {
    if (!report.value || report.value.errors.length || report.value.alreadyApplied) {
      return false
    }
    applying.value = true
    applyError.value = ''
    try {
      const record = await sheetStore.applyRevision(report.value)
      appliedRevisions.value = await sheetStore.listAppliedRevisions()
      lastApplied.value = record
      clearDraft()
      return true
    } catch (error) {
      applyError.value =
        error instanceof Error ? error.message : '修订批次写入失败，暂存内容已保留，可修改后重试。'
      return false
    } finally {
      applying.value = false
    }
  }

  async function loadAppliedRevisions(): Promise<void> {
    appliedRevisions.value = await sheetStore.listAppliedRevisions()
  }

  return {
    draftText,
    report,
    applying,
    applyError,
    appliedRevisions,
    lastApplied,
    canCommit,
    saveDraft,
    clearDraft,
    analyze,
    commit,
    loadAppliedRevisions,
  }
})
